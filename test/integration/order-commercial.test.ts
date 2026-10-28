import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowSkipIntegration, call, hasDb, setupIntegration, type Ctx } from './helpers.js'
import { CommercialBody } from '../../src/services/orderCommercial.js'
import { runMigrations } from '../../src/migrate.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('commercial orders v2 PostgreSQL', () => {
 let ctx: Ctx
 beforeEach(async () => { ctx = await setupIntegration() })
 afterEach(async () => { await ctx?.close() })
 const command = () => ({contractVersion:2 as const,commandId:randomUUID(),orderId:randomUUID(),commercial:{
  items:[{lineId:'l1',productId:'p1',unitId:'u-sht',unitFactor:'1',qtyInput:'2',qtyBase:'2',price:'50.00'}],
  customerId:'c1',customerName:'Клиент',no:null,priceTypeId:null,shiftId:null,subtotal:'100.00',
  discount:{kind:'percent' as const,value:'0'},total:'100.00',rounding:'kopeck' as const,onCredit:false,
  creditTerms:null,payment:{method:'unpaid' as const,cashPaid:'0',cardPaid:'0',change:'0'},vatSummary:null,
  address:'Адрес',geo:{lat:55,lng:37},courier:null,assignedTo:null,priority:false,
 }})
 type Body = ReturnType<typeof command> & {expectedRowVersion?:string}
 const send = (body: unknown, method:'POST'|'PUT'='POST', orderId?:string) => ctx.app.inject({method,
  url:method==='POST'?'/v1/orders':`/v1/orders/${orderId}/commercial`,payload:body as never,
  headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':ctx.companyId}})
 const edit = (body:Body, version:string) => ({...structuredClone(body),commandId:randomUUID(),expectedRowVersion:version})
 const waitForLock = async (fragment:string) => {
  const deadline=Date.now()+5000
  while(Date.now()<deadline){
   const waiting=await ctx.pool.query(`select 1 from pg_stat_activity where datname=current_database()
    and wait_event_type='Lock' and query like $1`,[`%${fragment}%`])
   if(waiting.rowCount) return
   await new Promise(resolve=>setTimeout(resolve,10))
  }
  throw new Error(`Expected a real PostgreSQL lock wait: ${fragment}`)
 }
 const count = async () => (await ctx.pool.query(`select
  (select count(*) from docs where company_id=$1) as docs,
  (select count(*) from stock_movements where company_id=$1) as stock,
  (select count(*) from money_movements where company_id=$1) as money,
  (select count(*) from settlement_movements where company_id=$1) as settlement`,[ctx.companyId])).rows[0]
 it('creates multiple stable lines and replaces full composition without movements',async()=>{
  const b=command(); b.commercial.items.push({...b.commercial.items[0]!,lineId:'l2'})
  b.commercial.subtotal=b.commercial.total='200.00'
  const before=await count(), first=await send(b)
  expect(first.statusCode).toBe(201)
  const e=edit(b,first.json().order.rowVersion); e.commercial.address='Новый адрес'
  const next=await send(e,'PUT',b.orderId)
  expect(next.statusCode).toBe(200)
  expect(next.json().order.rowVersion).not.toBe(first.json().order.rowVersion)
  expect(next.json().order.commercial.items.map((l:any)=>l.lineId)).toEqual(['l1','l2'])
  expect(await count()).toEqual(before)
 })
 it('replays a lost response permanently, including an old edit after a newer edit',async()=>{
  const b=command(), first=await send(b)
  expect(first.statusCode).toBe(201)
  const e=edit(b,first.json().order.rowVersion); e.commercial.address='Second'
  const second=await send(e,'PUT',b.orderId)
  const f=edit(b,second.json().order.rowVersion); f.commercial.address='Third'
  const third=await send(f,'PUT',b.orderId)
  await ctx.pool.query('delete from idempotency_keys where company_id=$1',[ctx.companyId])
  expect((await send(b)).json()).toEqual(first.json())
  expect((await send(e,'PUT',b.orderId)).json()).toEqual(second.json())
  expect((await ctx.pool.query('select commercial_snapshot,row_version::text from orders where company_id=$1 and id=$2',[ctx.companyId,b.orderId])).rows[0]).toMatchObject({commercial_snapshot:{address:'Third'},row_version:third.json().order.rowVersion})
 })
 it('replays after a real HTTP connection is lost after commit',async()=>{
  ctx.app.addHook('onSend',async(request,reply,payload)=>{
   if(request.headers['x-test-drop-response']==='1') reply.raw.destroy()
   return payload
  })
  const b=command(), address=await ctx.app.listen({host:'127.0.0.1',port:0})
  const error=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{
   const req=httpRequest(`${address}/v1/orders`,{method:'POST',headers:{authorization:`Bearer ${ctx.token}`,
    'x-company-id':ctx.companyId,'content-type':'application/json','x-test-drop-response':'1'}},res=>{res.resume();reject(new Error('Expected lost response'))})
   req.on('error',resolve);req.end(JSON.stringify(b))
  })
  expect(error.code).toBe('ECONNRESET')
  const saved=(await ctx.pool.query('select response_body from order_commercial_commands where company_id=$1 and command_id=$2',[ctx.companyId,b.commandId])).rows[0].response_body
  expect((await send(b)).json()).toEqual(saved)
  expect(await count()).toEqual({docs:'0',stock:'0',money:'0',settlement:'0'})
 })
 it('conflicts on changed command payload and cross-order reuse',async()=>{
  const b=command(); expect((await send(b)).statusCode).toBe(201)
  expect((await send({...b,commercial:{...b.commercial,address:'changed'}})).statusCode).toBe(409)
  expect((await send({...b,orderId:randomUUID()})).statusCode).toBe(409)
 })
 it('serializes identical and conflicting concurrent creation',async()=>{
  const b=command(), results=await Promise.all([send(b),send(b)])
  expect(results.map(r=>r.statusCode)).toEqual([201,201]); expect(results[0]!.json()).toEqual(results[1]!.json())
  const other=command(), r=await Promise.all([send(other),send({...other,commandId:randomUUID()})])
  expect(r.map(v=>v.statusCode).sort()).toEqual([201,409])
 })
 it('allows one of two concurrent editors and rejects stale version',async()=>{
  const b=command(), first=await send(b), v=first.json().order.rowVersion
  const r=await Promise.all([send(edit(b,v),'PUT',b.orderId),send(edit(b,v),'PUT',b.orderId)])
  expect(r.map(v=>v.statusCode).sort()).toEqual([200,409])
  expect((await send(edit(b,v),'PUT',b.orderId)).json().error.code).toBe('COMMERCIAL_VERSION_CONFLICT')
 })
 it('legacy sync cannot edit or delete a protected order',async()=>{
  const b=command(); await send(b)
  for (const op of ['upsert','delete']) {
   const r=await call(ctx,'POST','/v1/sync/push',{ops:[{table:'orders',op,row:{id:b.orderId,total:1,items:[]}}]})
   expect(r.json().results[0].code).toBe('ORDER_COMMERCIAL_PROTECTED')
  }
 })
 it('concurrent legacy write waits for commercial creation and cannot overwrite it',async()=>{
  const b=command(),client=await ctx.pool.connect()
  const {saveCommercial}=await import('../../src/services/orderCommercial.js')
  try {
   await client.query('begin'); await saveCommercial(client,ctx.companyId,'create',CommercialBody.parse(b))
   const legacy=Promise.resolve(call(ctx,'POST','/v1/sync/push',{ops:[{table:'orders',op:'upsert',row:{id:b.orderId,total:1}}]}))
   await waitForLock('pg_advisory_xact_lock')
   await client.query('commit')
   expect((await legacy).json().results[0].code).toBe('ORDER_COMMERCIAL_PROTECTED')
   expect((await ctx.pool.query('select total::text from orders where company_id=$1 and id=$2',[ctx.companyId,b.orderId])).rows[0].total).toBe('100.00')
  } finally {await client.query('rollback');client.release()}
 })
 it('same command cannot create two orders concurrently',async()=>{
  const b=command(),other={...b,orderId:randomUUID()}
  const r=await Promise.all([send(b),send(other)])
  expect(r.map(v=>v.statusCode).sort()).toEqual([201,409])
 })
 it('rejects actual foreign references, company access and courier writes',async()=>{
  const foreign=await setupIntegration()
  try {
   await foreign.pool.query("insert into products(company_id,id,name) values($1,'foreign-only','Foreign')",[foreign.companyId])
   await foreign.pool.query("insert into customers(company_id,id,name) values($1,'foreign-only','Foreign')",[foreign.companyId])
   const p=command();p.commercial.items[0]!.productId='foreign-only'
   expect((await send(p)).statusCode).toBe(422)
   const c=command();c.commercial.customerId='foreign-only';expect((await send(c)).statusCode).toBe(422)
   expect((await ctx.app.inject({method:'POST',url:'/v1/orders',payload:command(),headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':foreign.companyId}})).statusCode).toBe(403)
   await ctx.pool.query("update memberships set role='courier' where company_id=$1 and user_id=$2",[ctx.companyId,ctx.userId])
   ctx.app.invalidateMembershipCache(ctx.userId)
   expect((await send(command())).statusCode).toBe(403)
  } finally {await foreign.close()}
 })
 it('rounds payable amount only once at half-cent and whole-ruble boundaries',async()=>{
  const b=command();Object.assign(b.commercial.items[0]!,{qtyInput:'1',qtyBase:'1',price:'0.01'})
  b.commercial.subtotal='0.01';b.commercial.discount.value='50';b.commercial.total='0.01'
  expect((await send(b)).statusCode).toBe(201)
  const c=command();Object.assign(c.commercial.items[0]!,{qtyInput:'0.5',qtyBase:'0.5',price:'2.99'})
  c.commercial.subtotal='1.50';c.commercial.rounding='ruble' as 'kopeck';c.commercial.total='1.00'
  expect((await send(c)).statusCode).toBe(201)
 })
 it('records credit intent without creating debt or a payment',async()=>{
  const b:any=command();b.commercial.onCredit=true;b.commercial.payment.method='credit'
  const before=await count();expect((await send(b)).statusCode).toBe(201);expect(await count()).toEqual(before)
 })
 it('never reassigns a stable line ID even after removing that line',async()=>{
  const b=command();b.commercial.items.push({...b.commercial.items[0]!,lineId:'l2'});b.commercial.subtotal=b.commercial.total='200.00'
  const first=await send(b),e=edit(b,first.json().order.rowVersion)
  e.commercial.items.splice(0,1);e.commercial.subtotal=e.commercial.total='100.00'
  const second=await send(e,'PUT',b.orderId);expect(second.statusCode).toBe(200)
  const f=edit(e,second.json().order.rowVersion);f.commercial.items[0]!.lineId='l1';f.commercial.items[0]!.productId='another-product'
  expect((await send(f,'PUT',b.orderId)).json().error.code).toBe('COMMERCIAL_LINE_CONFLICT')
 })
 for (const v2 of [true,false]) it(`sale upsert cannot replace protected order v2=${v2}`,async()=>{
  const b=command(); await send(b); const before=await count()
  const r=await call(ctx,'POST','/v1/sales',{...(v2?{contractVersion:2}:{}),order:{id:b.orderId,warehouseId:'w1',items:[{productId:'p1',qty:2,price:50}]}})
  expect(r.statusCode).toBe(409); expect(await count()).toEqual(before)
 })
 it('legacy shipment cannot bypass the protected commercial snapshot',async()=>{
  const b=command(); await send(b)
  await ctx.pool.query("update orders set status='packed' where company_id=$1 and id=$2",[ctx.companyId,b.orderId])
  const before=await count(),r=await call(ctx,'POST',`/v1/orders/${b.orderId}/status`,{status:'shipped'})
  expect(r.json().error.code).toBe('COMMERCIAL_ORDER_REQUIRES_SHIPMENT_V2'); expect(await count()).toEqual(before)
 })
 for(const state of ['posted','ledger']) it(`blocks actual shipment evidence (${state}) without relying on flags`,async()=>{
  const b=command(); await send(b)
  await ctx.pool.query(`insert into docs(company_id,id,doc_type,warehouse_id,order_id,status,party_kind,party_id) values($1,'evidence','sales_shipment','w1',$2,'draft','customer','c1')`,[ctx.companyId,b.orderId])
  if(state==='posted') await ctx.pool.query("update docs set status='posted' where company_id=$1 and id='evidence'",[ctx.companyId])
  else {
   await ctx.pool.query(`insert into doc_lines(company_id,id,doc_id,line_no,product_id,qty,qty_input,price) values($1,'ev-line','evidence',0,'p1',1,1,50)`,[ctx.companyId])
   await ctx.pool.query('select post_doc($1,$2)',[ctx.companyId,'evidence'])
   await ctx.pool.query("update docs set status='draft' where company_id=$1 and id='evidence'",[ctx.companyId])
  }
  const version=(await ctx.pool.query('select row_version::text from orders where company_id=$1 and id=$2',[ctx.companyId,b.orderId])).rows[0].row_version
  const before=await count(),r=await send(edit(b,version),'PUT',b.orderId)
  expect(r.json().error.code).toBe('ORDER_COMMERCIAL_LOCKED');expect(await count()).toEqual(before)
 })
 it('waits for an in-flight shipment then rejects without extra effects',async()=>{
  const b=command(),first=await send(b),e=edit(b,first.json().order.rowVersion)
  const client=await ctx.pool.connect()
  try {
   await client.query('begin'); await client.query('select id from orders where company_id=$1 and id=$2 for update',[ctx.companyId,b.orderId])
   const pending=send(e,'PUT',b.orderId); const promise=Promise.resolve(pending)
   await waitForLock('select * from orders')
   await client.query(`insert into docs(company_id,id,doc_type,warehouse_id,order_id,party_kind,party_id) values($1,'ship-test','sales_shipment','w1',$2,'customer','c1')`,[ctx.companyId,b.orderId])
   await client.query(`insert into doc_lines(company_id,id,doc_id,line_no,product_id,qty,qty_input,price) values($1,'ship-line','ship-test',0,'p1',1,1,50)`,[ctx.companyId])
   await client.query('select post_doc($1,$2)',[ctx.companyId,'ship-test']); await client.query('commit')
   expect((await promise).statusCode).toBe(409)
   expect(await count()).toMatchObject({stock:'1'})
  } finally {await client.query('rollback');client.release()}
 })
 for(const field of ['product','unit','customer','factor','quantity','sum','card','paid','vat','credit','marking']) it(`rejects ${field} atomically`,async()=>{
  const b:any=command()
  if(field==='product') b.commercial.items[0].productId='foreign'
  if(field==='unit') b.commercial.items[0].unitId='missing'
  if(field==='customer') b.commercial.customerId='foreign'
  if(field==='factor') b.commercial.items[0].unitFactor='12'
  if(field==='quantity') b.commercial.items[0].qtyBase='3'
  if(field==='sum') b.commercial.total='99.99'
  if(field==='card') b.commercial.payment.method='card'
  if(field==='paid') b.commercial.payment.cashPaid='100'
  if(field==='vat') b.commercial.vatSummary={vat:'20'}
  if(field==='credit') b.commercial.onCredit=true
  if(field==='marking') b.commercial.items[0].markCodes=['code']
  const before=await count(); expect((await send(b)).statusCode).toBe(422)
  expect((await ctx.pool.query('select id from orders where company_id=$1 and id=$2',[ctx.companyId,b.orderId])).rowCount).toBe(0)
  expect(await count()).toEqual(before)
 })
 it('calculates exact decimals, percent and absolute discounts and explicit packaging',async()=>{
  for(const kind of ['percent','absolute'] as const){
   const b=command(); Object.assign(b.commercial.items[0]!,{unitId:'u-pack',unitFactor:'12',qtyInput:'0.1',qtyBase:'1.2',price:'0.10'})
   b.commercial.subtotal='0.12';b.commercial.discount={kind:kind as 'percent',value:kind==='percent'?'25':'0.03'};b.commercial.total='0.09'
   const r=await send(b); expect(r.statusCode).toBe(201)
   expect((await ctx.pool.query('select subtotal::text,total::text from orders where company_id=$1 and id=$2',[ctx.companyId,b.orderId])).rows[0]).toEqual({subtotal:'0.12',total:'0.09'})
  }
 })
 it('never adopts empty historical items and leaves history NULL on repeat migration',async()=>{
  const b=command(); await ctx.pool.query('insert into orders(company_id,id) values($1,$2)',[ctx.companyId,b.orderId])
  const v=(await ctx.pool.query('select row_version::text from orders where company_id=$1 and id=$2',[ctx.companyId,b.orderId])).rows[0].row_version
  expect((await send(edit(b,v),'PUT',b.orderId)).json().error.code).toBe('LEGACY_ORDER_UNVERIFIED')
  await runMigrations(ctx.pool,()=>undefined)
  expect((await ctx.pool.query('select commercial_snapshot from orders where company_id=$1 and id=$2',[ctx.companyId,b.orderId])).rows[0].commercial_snapshot).toBeNull()
 })
 it('rolls back order and receipt if receipt insertion fails',async()=>{
  const b=command(); b.commandId='rollback-probe'
  // A transaction-scoped DB failure after the order UPDATE, without persistent schema changes.
  const {saveCommercial}=await import('../../src/services/orderCommercial.js')
  const client=await ctx.pool.connect()
  try {
   await client.query('begin');const original=client.query.bind(client)
   client.query=((...args:any[])=>String(args[0]).includes('insert into order_commercial_commands')?Promise.reject(new Error('receipt failure')):(original as any)(...args)) as typeof client.query
   await expect(saveCommercial(client,ctx.companyId,'create',CommercialBody.parse(b))).rejects.toThrow('receipt failure')
   client.query=original as typeof client.query;await client.query('rollback')
   expect((await ctx.pool.query('select id from orders where company_id=$1 and id=$2',[ctx.companyId,b.orderId])).rowCount).toBe(0)
  } finally {client.release()}
 })
})
