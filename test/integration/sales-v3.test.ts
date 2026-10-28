import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { integrationConfig } from './helpers.js'
import { allowSkipIntegration, call, cash, debt, drift, hasDb, setupIntegration, stockAt, type Ctx } from './helpers.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL is required for sales v3 integration')
describe.skipIf(!hasDb)('sale v3 — exact cash/credit and permanent proof, PostgreSQL', () => {
 let ctx: Ctx
 beforeEach(async () => {ctx = await setupIntegration()})
 afterEach(async () => {await ctx?.close()})
 async function queryHook(hook: (sql: unknown,params: unknown)=>Promise<void> | void) {
  await ctx.app.close()
  const underlying=ctx.pool
  ctx.app=await buildApp({config:integrationConfig(),eventBus:null,fcm:null,metrics:null,pool:{
   query:underlying.query.bind(underlying),end:underlying.end.bind(underlying),
   connect:async()=>{
    const c=await underlying.connect(),query=c.query.bind(c),release=c.release.bind(c)
    c.query=(async(sql:any,params?:any)=>{await hook(sql,params);return query(sql,params)}) as typeof c.query
    c.release=()=>{c.query=query;c.release=release;release()}
    return c
   },
  }})
 }
 const command = () => ({ contractVersion: 3, order: { id: randomUUID(), warehouseId: 'w1', customerId: null as string|null,
  items: [{lineId: randomUUID(), productId:'p1',qtyBase:'2.0000',unitPriceMinor:10000}],discountMinor:0,saleTotalMinor:20000,
  payment:{paymentMode:'cash',moneyAccountId:'cash' as string|null,cashTendered:50000,change:30000}}})
 const send = (body: ReturnType<typeof command>, key = `sale-v3:${body.order.id}`) => call(ctx,'POST','/v1/sales',body,key)
 async function facts() {
  const result: Record<string,unknown> = {}
  for (const table of ['docs','doc_lines','orders','stock_movements','money_movements','settlement_movements','stock_balances','products','customers','audit','idempotency_keys','customer_financial_fences']) {
   result[table]=(await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as value from ${table} t where company_id=$1`,[ctx.companyId])).rows[0].value
  }
  return result
 }
 async function rejected(body: ReturnType<typeof command>, status=422) {
  const before = await facts(), response = await send(body)
  expect(response.statusCode, response.body).toBe(status)
  expect(await facts()).toEqual(before)
 }
 it('cash 200/tendered 500/change 300 posts 200 to the explicit non-default cash account', async () => {
  await ctx.pool.query(`insert into money_accounts(company_id,id,name,kind) values($1,'chosen','Chosen','cash')`,[ctx.companyId])
  const b=command(); b.order.payment.moneyAccountId='chosen'
  const r=await send(b)
  expect(r.statusCode,r.body).toBe(201)
  expect(r.json()).toMatchObject({contractVersion:3,cashReceivedMinor:20000,cashTendered:50000,change:30000,moneyAccountId:'chosen'})
  expect(await stockAt(ctx,'w1','p1')).toBe(-2)
  expect(await cash(ctx,'chosen')).toBe(200); expect(await cash(ctx,'cash')).toBe(0)
  expect(await drift(ctx)).toEqual([])
 })
 for (const mode of ['cash','credit']) it(`${mode} real customer: exact debt and cash`,async () => {
  const b=command(); b.order.customerId='c1'
  if(mode==='credit') b.order.payment={paymentMode:'credit',moneyAccountId:null,cashTendered:0,change:0}
  const r=await send(b); expect(r.statusCode,r.body).toBe(201)
  expect(await debt(ctx,'customer','c1')).toBe(mode==='credit'?200:0)
  expect(await cash(ctx,'cash')).toBe(mode==='cash'?200:0)
  expect(await stockAt(ctx,'w1','p1')).toBe(-2)
  expect(await drift(ctx)).toEqual([])
 })
 for (const kind of ['bank','card']) it(`rejects ${kind} account without any writes`,async () => {
  await ctx.pool.query(`update money_accounts set kind=$2 where company_id=$1 and id='cash'`,[ctx.companyId,kind])
  await rejected(command())
 })
 for (const unavailable of ['archived','missing','foreign']) it(`rejects ${unavailable} account`,async () => {
  const b=command()
  if(unavailable==='archived') await ctx.pool.query(`update money_accounts set deleted_at=now() where company_id=$1`,[ctx.companyId])
  else b.order.payment.moneyAccountId='not-owned'
  if(unavailable==='foreign') {
   const other=await setupIntegration()
   try {
    await other.pool.query(`insert into money_accounts(company_id,id,name,kind) values($1,'not-owned','Other','cash')`,[other.companyId])
    await rejected(b)
   } finally {await other.close()}
  } else await rejected(b)
 })
 const invalids: Array<[string,(b: ReturnType<typeof command>)=>void]> = [
  ['card',b=>{b.order.payment.paymentMode='card'}],['mixed',b=>{b.order.payment.paymentMode='mixed'}],
  ['prepayment',b=>{b.order.payment.paymentMode='prepayment'}],
  ['retail credit',b=>{b.order.customerId='retail';b.order.payment={paymentMode:'credit',moneyAccountId:null,cashTendered:0,change:0}}],
  ['credit without customer',b=>{b.order.payment={paymentMode:'credit',moneyAccountId:null,cashTendered:0,change:0}}],
  ['credit accepted money',b=>{b.order.customerId='c1';b.order.payment.paymentMode='credit'}],
  ['missing cash account',b=>{b.order.payment.moneyAccountId=null}],
  ['short tender',b=>{b.order.payment.cashTendered=100}],['change',b=>{b.order.payment.change=0}],
  ['total',b=>{b.order.saleTotalMinor=19999}],['discount',b=>{b.order.discountMinor=20001}],
  ['fractional cents',b=>{b.order.items[0]!.unitPriceMinor=1.1}],
  ['operation cap',b=>{b.order.saleTotalMinor=100000000001}],
  ['unsafe integer',b=>{b.order.payment.cashTendered=Number.MAX_SAFE_INTEGER+1}],
  ['quantity precision',b=>{b.order.items[0]!.qtyBase='2.00001'}],
  ['non-numeric quantity',b=>{b.order.items[0]!.qtyBase='NaN'}],
  ['zero quantity',b=>{b.order.items[0]!.qtyBase='0.0000'}],
  ['packaging',b=>{Object.assign(b.order.items[0]!,{unitFactor:12})}],
  ['track',b=>{Object.assign(b.order,{track:[]})}],
  ['unknown field',b=>{Object.assign(b,{unexpected:true})}],
  ['duplicate line',b=>{b.order.items.push({...b.order.items[0]!})}],
  ['foreign customer',b=>{b.order.customerId='not-owned'}],['missing product',b=>{b.order.items[0]!.productId='not-owned'}],
  ['missing warehouse',b=>{b.order.warehouseId='not-owned'}],
 ]
 for (const [name,change] of invalids) it(`rejects ${name} with identical documents and ledgers`,async()=>{const b=command();change(b);await rejected(b)})
 it('uses PostgreSQL positive half-up rounding per line, then absolute discount',async()=>{
  const b=command();b.order.items=[{...b.order.items[0]!,qtyBase:'0.5000',unitPriceMinor:1},{...b.order.items[0]!,lineId:randomUUID(),qtyBase:'0.5000',unitPriceMinor:1}]
  b.order.discountMinor=1;b.order.saleTotalMinor=1;b.order.payment.cashTendered=1;b.order.payment.change=0
  const r=await send(b);expect(r.statusCode,r.body).toBe(201)
  expect(r.json()).toMatchObject({subtotalMinor:2,saleTotalMinor:1,items:[{amountMinor:1},{amountMinor:1}]})
  expect(await cash(ctx,'cash')).toBe(0.01)
  const bad=command();bad.order.items=b.order.items;bad.order.discountMinor=1;bad.order.saleTotalMinor=0;bad.order.payment.cashTendered=0;bad.order.payment.change=0
  await rejected(bad)
 })
 it('replays after temporary key deletion and archival without modifying current data',async()=>{
  const b=command(),first=await send(b);expect(first.statusCode,first.body).toBe(201)
  await ctx.pool.query('delete from idempotency_keys where company_id=$1',[ctx.companyId])
  await ctx.pool.query('update money_accounts set deleted_at=now() where company_id=$1',[ctx.companyId])
  const before=await facts(),replay=await send(b)
  expect(replay.statusCode,replay.body).toBe(201);expect(replay.json()).toEqual(first.json())
  expect(replay.headers['idempotency-replayed']).toBe('true')
  const after=await facts();delete before.idempotency_keys;delete after.idempotency_keys;expect(after).toEqual(before)
 })
 it('replays after SQL unpost as historical success, never restoring movements',async()=>{
  const b=command(),first=await send(b);expect(first.statusCode,first.body).toBe(201)
  await ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,`sale-${b.order.id}`])
  const before=await facts();expect((await send(b)).json()).toEqual(first.json());expect(await facts()).toEqual(before)
 })
 it('rejects modified payload, invalid transport key and corrupt permanent proof even with temporary replay',async()=>{
  const b=command();expect((await send(b)).statusCode).toBe(201)
  const changed=structuredClone(b);changed.order.payment.cashTendered+=100;changed.order.payment.change+=100
  await rejected(changed,409)
  const badTotal=structuredClone(b);badTotal.order.saleTotalMinor++
  await rejected(badTotal,409)
  expect((await send(b,'unrelated-key')).statusCode).toBe(422)
  const saved=JSON.parse((await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2',[ctx.companyId,`sale-${b.order.id}`])).rows[0].source_payload)
  const badHash=structuredClone(saved);badHash.fingerprint='0'.repeat(64)
  const badRequest=structuredClone(saved);badRequest.request.body.order.warehouseId='w2'
  const badResult=structuredClone(saved);badResult.result.cashReceivedMinor++
  const badStatus=structuredClone(saved);badStatus.responseStatus=200
  for (const corrupt of ['not json','{}',JSON.stringify(badHash),JSON.stringify(badRequest),JSON.stringify(badResult),JSON.stringify(badStatus)]) {
   await ctx.pool.query('update docs set source_payload=$3 where company_id=$1 and id=$2',[ctx.companyId,`sale-${b.order.id}`,corrupt])
   await rejected(b,409)
  }
 })
 it('serializes identical and conflicting concurrent requests with one posting',async()=>{
  const b=command(),changed=structuredClone(b);changed.order.warehouseId='w2'
  const identical=await Promise.all([send(b),send(b)])
  expect(identical.map(r=>r.statusCode)).toEqual([201,201])
  const rs=await Promise.all([send(b),send(changed)])
  expect(rs.map(r=>r.statusCode).sort()).toEqual([201,409])
  expect(await cash(ctx,'cash')).toBe(200)
  expect((await ctx.pool.query('select count(*) from stock_movements where company_id=$1',[ctx.companyId])).rows[0].count).toBe('1')
  const fresh=command(),other=structuredClone(fresh);other.order.warehouseId='w2'
  const conflicting=await Promise.all([send(fresh),send(other)])
  expect(conflicting.map(r=>r.statusCode).sort()).toEqual([201,409])
  expect(await cash(ctx,'cash')).toBe(400)

 })
 for (const first of ['v2','v3']) it(`cross-version identity is unique (${first} first)`,async()=>{
  const b=command(),v2={contractVersion:2,order:{id:b.order.id,warehouseId:'w1',items:[{productId:'p1',qty:2,price:100}]}}
  const old=()=>call(ctx,'POST','/v1/sales',v2,`sale-${b.order.id}`)
  const responses=first==='v2'?[await old(),await send(b)]:[await send(b),await old()]
  expect(responses.map(r=>r.statusCode)).toEqual([201,409]);expect(await cash(ctx,'cash')).toBe(200)
 })
 it('cross-version concurrent requests and a legacy retry cannot post a second sale',async()=>{
  const b=command(),v2={contractVersion:2,order:{id:b.order.id,warehouseId:'w1',items:[{productId:'p1',qty:2,price:100}]}}
  const rs=await Promise.all([send(b),call(ctx,'POST','/v1/sales',v2,`sale-${b.order.id}`)])
  expect(rs.map(r=>r.statusCode).sort()).toEqual([201,409]);expect(await cash(ctx,'cash')).toBe(200)
  const before=await facts();expect((await call(ctx,'POST','/v1/sales',{order:v2.order},`sale-v3:${b.order.id}`)).statusCode).toBe(409)
  expect(await facts()).toEqual(before)
 })
 it('loses the real HTTP response after commit and replays exactly once',async()=>{
  ctx.app.addHook('onSend',async(req,reply,payload)=>{if(req.headers['x-test-drop-response']==='1')reply.raw.destroy();return payload})
  const b=command(),address=await ctx.app.listen({host:'127.0.0.1',port:0})
  const error=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{
   const req=httpRequest(`${address}/v1/sales`,{method:'POST',headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':ctx.companyId,
    'idempotency-key':`sale-v3:${b.order.id}`,'content-type':'application/json','x-test-drop-response':'1'}},r=>{r.resume();reject(new Error('Response must be lost'))})
   req.on('error',resolve);req.end(JSON.stringify(b))
  })
  expect(error.code).toBe('ECONNRESET');const before=await facts(),r=await send(b)
  expect(r.statusCode,r.body).toBe(201);expect(r.headers['idempotency-replayed']).toBe('true');expect(await facts()).toEqual(before)
 })
 it('rolls back stock posting when an injected later SQL error prevents payment posting',async()=>{
  const b=command();b.order.customerId='c1'
  await queryHook((sql,params)=>{
   if(sql==='select post_doc($1,$2)' && Array.isArray(params) && params[1]===`pay-${b.order.id}`) throw new Error('injected posting failure')
  })
  await rejected(b,500)
 })
 it('unknown versions never use legacy and forbidden roles cannot post',async()=>{
  for(const contractVersion of [0,4,'3',null])expect((await call(ctx,'POST','/v1/sales',{...command(),contractVersion})).statusCode).toBe(422)
  await ctx.pool.query(`update memberships set role='stock' where company_id=$1 and user_id=$2`,[ctx.companyId,ctx.userId])
  await rejected(command(),403)
 })
 it('checks tenant isolation and RBAC for every existing human role',async()=>{
  const foreign=await setupIntegration()
  try {
   const b=command(),r=await ctx.app.inject({method:'POST',url:'/v1/sales',payload:b,headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':foreign.companyId,'idempotency-key':`sale-v3:${b.order.id}`}})
   expect([403,404]).toContain(r.statusCode)
   for(const role of ['stock','courier']) {
    await ctx.pool.query('update memberships set role=$3 where company_id=$1 and user_id=$2',[ctx.companyId,ctx.userId,role])
    await rejected(command(),403)
   }
   for(const role of ['admin','manager','cashier']) {
    await ctx.pool.query('update memberships set role=$3 where company_id=$1 and user_id=$2',[ctx.companyId,ctx.userId,role])
    const response=await send(command());expect(response.statusCode,response.body).toBe(201)
   }
   // Identical sale identity remains independently scoped in another company.
   await ctx.pool.query("update memberships set role='admin' where company_id=$1 and user_id=$2",[ctx.companyId,ctx.userId])
   const shared=command();expect((await send(shared)).statusCode).toBe(201)
   expect((await call(foreign,'POST','/v1/sales',shared,`sale-v3:${shared.order.id}`)).statusCode).toBe(201)
  } finally {await foreign.close()}
 })
 for (const mutation of ['archive','kind']) it(`account ${mutation} first: posting waits and refuses the updated account`,async()=>{
  const writer=await ctx.pool.connect()
  try {
   await writer.query('begin');await writer.query("set local lock_timeout='5s'")
   await writer.query(mutation==='archive'?"update money_accounts set deleted_at=now() where company_id=$1 and id='cash'":"update money_accounts set kind='bank' where company_id=$1 and id='cash'",[ctx.companyId])
   const before=await facts(),b=command(),pending=send(b)
   // Observe a real waiter instead of assuming request timing.
   const end=Date.now()+5000
   let waiting=false
   while(Date.now()<end) {
    const state=await ctx.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select kind, deleted_at from money_accounts%' ")
    if(state.rowCount){waiting=true;break}
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(waiting).toBe(true);await writer.query('commit')
   const response=await pending;expect(response.statusCode,response.body).toBe(422)
   expect(await facts()).toEqual(before)
  } finally {await writer.query('rollback');writer.release()}
 })
 it('sale holds the account lock through commit; concurrent archive cannot invalidate its validation',async()=>{
  const b=command()
  let reached!:()=>void,release!:()=>void
  const atPosting=new Promise<void>(resolve=>{reached=resolve}),go=new Promise<void>(resolve=>{release=resolve})
  await queryHook(async(sql,params)=>{
   if(sql==='select post_doc($1,$2)::text as total' && Array.isArray(params) && params[1]===`sale-${b.order.id}`){reached();await go}
  })
  const pending=send(b)
  const writer=await ctx.pool.connect()
  try {
   await atPosting;await writer.query('begin');await writer.query("set local lock_timeout='5s'")
   const pid=(await writer.query('select pg_backend_pid() as pid')).rows[0].pid
   const updating=writer.query("update money_accounts set deleted_at=now() where company_id=$1 and id='cash'",[ctx.companyId])
   const end=Date.now()+5000;let waiting=false
   while(Date.now()<end){
    if((await ctx.pool.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[pid])).rowCount){waiting=true;break}
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(waiting).toBe(true);release()
   const response=await pending;expect(response.statusCode,response.body).toBe(201)
   await updating;await writer.query('commit')
   expect(await cash(ctx,'cash')).toBe(200)
   expect((await send(b)).json()).toEqual(response.json())
  } finally {release();await writer.query('rollback');writer.release();await pending}
 })

})
