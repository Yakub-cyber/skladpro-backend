import { legacyCustomerFixture } from './legacy-customer-fixture.js'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { afterEach,beforeEach,describe,expect,it } from 'vitest'
import { allowSkipIntegration,call,cash,debt,hasDb,integrationConfig,setupIntegration,type Ctx } from './helpers.js'
import { buildApp } from '../../src/app.js'
import type { DbPool } from '../../src/db.js'
import { CUSTOMER_FINANCE_NAMESPACE,customerFinanceKey,lockCustomerFinances } from '../../src/services/customerFinance.js'

if(!hasDb&&!allowSkipIntegration) throw Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('customer financial barrier — historical native fixtures and supported writers',()=>{
 let ctx:Ctx
 let financePool:DbPool
 beforeEach(async()=>{ctx=await setupIntegration();financePool=ctx.pool})
 afterEach(async()=>{
  if(!ctx)return
  try{
   expect((await ctx.pool.query("select deadlocks from pg_stat_database where datname=current_database()")).rows[0].deadlocks).toBe('0')
   expect((await ctx.pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and (state='idle in transaction' or wait_event_type='Lock')")).rows[0].n).toBe(0)
  }finally{await ctx.close()}
 })
 const payment=(c=ctx,customer='c1',amount=10,key=randomUUID())=>legacyCustomerFixture(c,{amount},key,customer,c===ctx?financePool:c.pool)
 const adjust=()=>legacyCustomerFixture(ctx,{amount:7,kind:'adjustment',direction:'increase'},undefined,'c1',financePool)
 async function credit(){const id=randomUUID();const r=await call(ctx,'POST','/v1/sales',{order:{id,customerId:'c1',onCredit:true,items:[{productId:'p1',qty:3,price:50}]}});expect(r.statusCode,r.body).toBe(201);return id}
 const refund=(id:string,version=2)=>{const returnId=randomUUID();return call(ctx,'POST','/v1/returns',version===2?{contractVersion:2,returnId,orderId:id,items:[{saleLineId:`sale-${id}-0`,qtyBase:'1'}]}:{orderId:id,items:[{productId:'p1',qty:1}]},version===2?`return:${returnId}`:randomUUID())}
  async function prepare() {
    const orderId = randomUUID(), shipmentId = randomUUID()
    const commercial = { items: [{ lineId: 'source', productId: 'p1', unitId: 'u-sht', unitFactor: '1', qtyInput: '2', qtyBase: '2', price: '50.00' }], customerId: 'c1', customerName: 'Customer', no: null, priceTypeId: null, shiftId: null,
      subtotal: '100.00', total: '100.00', discount: { kind: 'percent', value: '0' }, rounding: 'kopeck', onCredit: true, creditTerms: null, vatSummary: null,
      payment: { method: 'credit', cashPaid: '0', cardPaid: '0', change: '0' }, address: null, geo: null, courier: null, assignedTo: null, priority: false }
    expect((await call(ctx, 'POST', '/v1/orders', { contractVersion: 2, commandId: randomUUID(), orderId, commercial })).statusCode).toBe(201)
    expect((await call(ctx, 'POST', `/v1/orders/${orderId}/status`, { status: 'picking' })).statusCode).toBe(200)
    const shipment = { contractVersion: 2, status: 'shipped', shipmentId, warehouseId: 'w1', orderSnapshot: commercial }
    return {orderId,shipment}
  }

 async function usePool(pool:DbPool){financePool=pool;await ctx.app.close();ctx.app=await buildApp({config:integrationConfig(),pool,eventBus:null,fcm:null,metrics:null})}
 function gate(match:(sql:string)=>boolean){
  let release!:()=>void,signal!:()=>void,paused=false
  const released=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{signal=r})
  const log:string[]=[]
  const pool:DbPool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{
   const real=await ctx.pool.connect(),wrapped=Object.create(real);wrapped.release=real.release.bind(real)
   wrapped.query=async(sql:string,params?:unknown[])=>{
    log.push(sql.replace(/\s+/g,' ').toLowerCase())
    if(!paused&&match(sql)){paused=true;signal();await released}
    return real.query(sql,params)
   };return wrapped
  }}
  return {pool,ready,release,log}
 }
 async function waitForFinanceLock(){
  for(let i=0;i<400;i++){
   if((await ctx.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pg_advisory_xact_lock($1::integer%'")).rowCount)return
   await new Promise(r=>setTimeout(r,10))
  }throw Error('Expected real customer-finance advisory contention')
 }
 async function within<T>(promise:PromiseLike<T>){return Promise.race([Promise.resolve(promise),new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(Error('Independent operation blocked')),3000);t.unref()})])}
 async function snapshot(){const out:Record<string,unknown>={};for(const t of ['docs','stock_movements','money_movements','settlement_movements','customers','stock_balances','orders','customer_financial_fences','idempotency_keys','audit'])out[t]=(await ctx.pool.query(`select to_jsonb(t) r from ${t} t where company_id=$1 order by to_jsonb(t)::text`,[ctx.companyId])).rows;return out}
 it('serializes payment/payment with exact before/after balances and one posting per intent',async()=>{
  const g=gate(s=>s==='commit');await usePool(g.pool)
  const a=Promise.resolve(payment());let b:ReturnType<typeof payment>|undefined
  try{await g.ready;b=payment();const pending=Promise.resolve(b);await waitForFinanceLock();g.release()
   expect((await a).json().customer).toMatchObject({balanceBefore:0,balanceAfter:-10})
   expect((await pending).json().customer).toMatchObject({balanceBefore:-10,balanceAfter:-20})
   expect(await cash(ctx,'cash')).toBe(20);expect(await debt(ctx,'customer','c1')).toBe(-20)
  }finally{g.release();await a;await b}
 })
 it.each(['payment-first','shipment-first'])('%s serializes credit shipment with no financial-rule change',async order=>{
  const f=await prepare(),g=gate(s=>s==='commit');await usePool(g.pool)
  const ship=()=>call(ctx,'POST',`/v1/orders/${f.orderId}/status`,f.shipment,`shipment:${f.shipment.shipmentId}`)
  const a=Promise.resolve(order==='payment-first'?payment():ship());let b:Promise<any>|undefined
  try{await g.ready;b=Promise.resolve(order==='payment-first'?ship():payment());await waitForFinanceLock();g.release()
   expect((await a).statusCode).toBe(order==='payment-first'?201:200);expect((await b).statusCode).toBe(order==='payment-first'?200:201)
   expect(await debt(ctx,'customer','c1')).toBe(90);expect(await cash(ctx,'cash')).toBe(10)
  }finally{g.release();await a;await b}
 })
 it.each(['payment-first','return-first'])('%s makes a credit-return decision after the financial predecessor',async order=>{
  const id=await credit(),g=gate(s=>s==='commit');await usePool(g.pool)
  const a=Promise.resolve(order==='payment-first'?payment():refund(id));let b:Promise<any>|undefined
  try{await g.ready;b=Promise.resolve(order==='payment-first'?refund(id):payment());await waitForFinanceLock();g.release()
   expect((await a).statusCode).toBe(201);const r=await b
   expect(r.statusCode,r.body).toBe(order==='payment-first'?422:201)
   if(order==='payment-first')expect(r.json().error.details.reason).toBe('UNALLOCATED_CUSTOMER_PAYMENT')
   expect(await debt(ctx,'customer','c1')).toBe(order==='payment-first'?140:90);expect(await cash(ctx,'cash')).toBe(10)
  }finally{g.release();await a;await b}
 })
 it.each(['payment-first','cancel-first'])('%s preserves legacy cancellation/payment amounts',async order=>{
  const id=await credit(),g=gate(s=>s==='commit');await usePool(g.pool)
  const cancel=()=>call(ctx,'POST',`/v1/orders/${id}/status`,{status:'cancelled'})
  const a=Promise.resolve(order==='payment-first'?payment():cancel());let b:Promise<any>|undefined
  try{await g.ready;b=Promise.resolve(order==='payment-first'?cancel():payment());await waitForFinanceLock();g.release()
   expect((await a).statusCode).toBe(order==='payment-first'?201:200);expect((await b).statusCode).toBe(order==='payment-first'?200:201)
   expect(await debt(ctx,'customer','c1')).toBe(-10);expect(await cash(ctx,'cash')).toBe(10)
  }finally{g.release();await a;await b}
 })
 it('serializes customer adjustments as well as payments',async()=>{
  const g=gate(s=>s==='commit');await usePool(g.pool);const a=Promise.resolve(adjust());let b:Promise<any>|undefined
  try{await g.ready;b=Promise.resolve(payment());await waitForFinanceLock();g.release();expect((await a).statusCode).toBe(201);expect((await b).statusCode).toBe(201)
   expect(await debt(ctx,'customer','c1')).toBe(-3);expect(await cash(ctx,'cash')).toBe(10)
  }finally{g.release();await a;await b}
 })
 it.each(['customer','company'])('does not serialize independent operations by %s',async kind=>{
  const foreign=kind==='company'?await setupIntegration():null
  if(!foreign)await ctx.pool.query("insert into customers(company_id,id,name) values($1,'c2','Other')",[ctx.companyId])
  const g=gate(s=>s.includes('insert into docs'));await usePool(g.pool);const a=Promise.resolve(payment())
  try{await g.ready;const r=await within(payment(foreign||ctx,foreign?'c1':'c2'));expect(r.statusCode).toBe(201);g.release();expect((await a).statusCode).toBe(201)
  }finally{g.release();await a;await foreign?.close()}
 })
 it.each(['repeatable read','serializable'])('%s rejects a stale financial snapshot with 40001',async isolation=>{
  const c=await ctx.pool.connect()
  try{await c.query(`begin isolation level ${isolation}`);await c.query('select id from customers where company_id=$1',[ctx.companyId])
   expect((await payment()).statusCode).toBe(201)
   await expect(lockCustomerFinances(c,ctx.companyId,['c1'])).rejects.toMatchObject({code:'40001'})
   await c.query('rollback');await c.query('begin');await lockCustomerFinances(c,ctx.companyId,['c1']);await c.query('commit')
   expect(await debt(ctx,'customer','c1')).toBe(-10)
  }finally{await c.query('rollback');c.release()}
 })
 it('sorts all keys for multi-party operations and isolates the namespace from old bigint locks',async()=>{
  const a=await ctx.pool.connect(),b=await ctx.pool.connect()
  try{await a.query('begin');await b.query('begin');await a.query('select pg_advisory_xact_lock($1::bigint)',[((BigInt(CUSTOMER_FINANCE_NAMESPACE)<<32n)|BigInt(customerFinanceKey(ctx.companyId,'c1')>>>0)).toString()])
   await within(lockCustomerFinances(b,ctx.companyId,['c2','c1','c2']));await b.query('commit')
   await lockCustomerFinances(a,ctx.companyId,['c1','c2']);await b.query('begin');const waiting=lockCustomerFinances(b,ctx.companyId,['c2','c1'])
   await waitForFinanceLock();await a.query('commit');await waiting;await b.query('commit')
   expect(customerFinanceKey(ctx.companyId,'c1')).not.toBe(customerFinanceKey(ctx.companyId,'c2'))
  }finally{await a.query('rollback');await b.query('rollback');a.release();b.release()}
 })
 it('historical native fixture rolls back fence, posting, audit and receipt on posting failure',async()=>{
  const before=await snapshot();let once=true
  const p:DbPool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{
   const real=await ctx.pool.connect(),w=Object.create(real);w.release=real.release.bind(real)
   w.query=async(sql:string,params?:unknown[])=>{const r=await real.query(sql,params);if(once&&sql.includes('select post_doc')){once=false;throw Error('test after posting')}return r};return w
  }}
  await usePool(p);await expect(payment()).rejects.toThrow('test after posting');expect(await snapshot()).toEqual(before)
  expect((await payment()).statusCode).toBe(201);expect(await cash(ctx,'cash')).toBe(10)
 })
 it('a lost refusal response stays fenced and cannot replay an old payment',async()=>{
  ctx.app.addHook('onSend',async(req,reply,payload)=>{if(req.headers['x-test-drop']==='1')reply.raw.destroy();return payload})
  const address=await ctx.app.listen({host:'127.0.0.1',port:0}),key=randomUUID()
  const error=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{
   const req=httpRequest(`${address}/v1/customers/c1/payments`,{method:'POST',headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':ctx.companyId,'idempotency-key':key,'content-type':'application/json','x-test-drop':'1'}},r=>{r.resume();reject(Error('Expected lost response'))})
   req.on('error',resolve);req.end(JSON.stringify({amount:10,kind:'payment'}))
  });expect(error.code).toBe('ECONNRESET')
  const before=await snapshot(),r=await call(ctx,'POST','/v1/customers/c1/payments',{amount:10,kind:'payment'},key)
  expect(r.statusCode).toBe(422);expect(r.json().error.code).toBe('LEGACY_CUSTOMER_PAYMENT_REQUIRES_RECONCILIATION');expect(await snapshot()).toEqual(before)
 })
 it.each(['payment','sale-v1','sale-v2','legacy-shipment','legacy-cancel','return-v1','return-v2','shipment-v2'])('%s acquires order locks, financial barrier and fence before accounting locks/writes',async kind=>{
  let execute:()=>ReturnType<typeof call>
  if(kind==='payment')execute=()=>payment()
  else if(kind==='legacy-cancel'||kind.startsWith('return')){
   const id=await credit();execute=kind==='legacy-cancel'?()=>call(ctx,'POST',`/v1/orders/${id}/status`,{status:'cancelled'}):()=>refund(id,kind==='return-v1'?1:2)
  }else if(kind==='shipment-v2'){
   const f=await prepare();execute=()=>call(ctx,'POST',`/v1/orders/${f.orderId}/status`,f.shipment,`shipment:${f.shipment.shipmentId}`)
  }else if(kind==='legacy-shipment'){
   const id=randomUUID();await ctx.pool.query("insert into orders(company_id,id,status,customer_id,on_credit,items,total) values($1,$2,'picking','c1',true,$3,100)",[ctx.companyId,id,JSON.stringify([{productId:'p1',qty:2,price:50}])]);execute=()=>call(ctx,'POST',`/v1/orders/${id}/status`,{status:'shipped'})
  }else execute=()=>call(ctx,'POST','/v1/sales',{...(kind==='sale-v2'?{contractVersion:2}:{}),order:{id:randomUUID(),customerId:'c1',onCredit:true,...(kind==='sale-v2'?{warehouseId:'w1'}:{}),items:[{productId:'p1',qty:2,price:50}]}})
  const g=gate(()=>false);await usePool(g.pool);const r=await execute()
  if(kind==='legacy-shipment'){
   expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe('LEGACY_SHIPMENT_REQUIRES_RECONCILIATION')
   expect(g.log.some(s=>s.includes('insert into')||s.includes('post_doc')||s.includes('pg_advisory_xact_lock'))).toBe(false)
   return
  }
  expect([200,201],r.body).toContain(r.statusCode)
  const barrier=g.log.findIndex(s=>s.includes('pg_advisory_xact_lock($1::integer')),fence=g.log.findIndex(s=>s.includes('insert into customer_financial_fences'))
  const accounting=g.log.findIndex(s=>s.includes('insert into docs')||s.includes('update products')||s.includes('select post_doc')||s.includes('select unpost_doc')||(s.includes('from docs')&&(s.includes('for update')||s.includes('for share'))))
  expect(barrier).toBeGreaterThanOrEqual(0);expect(fence).toBeGreaterThan(barrier);expect(accounting).toBeGreaterThan(fence)
  const order=g.log.findIndex(s=>s.includes('from orders')&&s.includes('for update'))
  if(kind!=='payment')expect(order).toBeLessThan(barrier)
 })
 it('fencing alone neither locks nor rewrites public customer metadata, including historical missing identities',async()=>{
  const c=await ctx.pool.connect(),before=(await ctx.pool.query('select * from customers where company_id=$1',[ctx.companyId])).rows
  try{
   await c.query('begin');await lockCustomerFinances(c,ctx.companyId,['c1','historical-missing'])
   expect((await ctx.pool.query('select * from customers where company_id=$1',[ctx.companyId])).rows).toEqual(before)
   await within(ctx.pool.query("update customers set name='Metadata edit' where company_id=$1 and id='c1'",[ctx.companyId]))
   await c.query('commit')
  }finally{await c.query('rollback');c.release()}
 })
 it('does not confuse a real payment customer named retail with the sale walk-in sentinel',async()=>{
  await ctx.pool.query("insert into customers(company_id,id,name) values($1,'retail','Actual payment customer')",[ctx.companyId])
  const g=gate(s=>s==='commit');await usePool(g.pool);const a=Promise.resolve(payment(ctx,'retail'));let b:Promise<any>|undefined
  try{await g.ready;b=Promise.resolve(payment(ctx,'retail'));await waitForFinanceLock();g.release();expect((await a).statusCode).toBe(201);expect((await b).statusCode).toBe(201)
   expect(await debt(ctx,'customer','retail')).toBe(-20)
  }finally{g.release();await a;await b}
 })
 it('keeps SQL posting functions byte-for-byte unchanged',async()=>{
  for(const [name,file] of [['post_doc','0027_guard_sale_returns.sql'],['unpost_doc','0030_guard_delivered_unpost.sql']]){
   const sql=await readFile(`sql/migrations/${file}`,'utf8'),expected=sql.slice(sql.indexOf(`create or replace function ${name}`)).split('as $$')[1].split('$$;')[0].replace(/\r/g,'')
   expect((await ctx.pool.query('select prosrc from pg_proc where oid=$1::regprocedure',[`${name}(uuid,text)`])).rows[0].prosrc.replace(/\r/g,'')).toBe(expected)
  }
 })
})
