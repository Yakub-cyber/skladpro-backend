import { legacyCustomerFixture } from './legacy-customer-fixture.js'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { readFile,readdir } from 'node:fs/promises'
import pg from 'pg'
import { afterEach,beforeEach,describe,expect,it } from 'vitest'
import { allowSkipIntegration,call,cash,debt,drift,hasDb,integrationConfig,setupIntegration,stockAt,type Ctx } from './helpers.js'
import { buildApp } from '../../src/app.js'
import type { DbPool } from '../../src/db.js'
import { saleFingerprint } from '../../src/services/salesV2.js'
import { runMigrations } from '../../src/migrate.js'

if(!hasDb&&!allowSkipIntegration) throw Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('cancelled v2 — real PostgreSQL',()=>{
 let ctx:Ctx
 let financePool:DbPool
 beforeEach(async()=>{ctx=await setupIntegration();financePool=ctx.pool})
 afterEach(async()=>{if(!ctx)return;try{
  expect((await ctx.pool.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks).toBe('0')
  expect((await ctx.pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and (state='idle in transaction' or wait_event_type='Lock')")).rows[0].n).toBe(0)
 }finally{await ctx.close()}})
  async function prepare() {
    for (const [warehouseId,qty] of [['w1',40],['w2',60]] as const) expect((await call(ctx,'POST','/v1/documents/post',{document:{id:randomUUID(),type:'receive',warehouseId,items:[{productId:'p1',qty,cost:7}]}})).statusCode).toBe(201)
    const orderId = randomUUID(), shipmentId = randomUUID()
    const commercial = { items: [{ lineId: 'source', productId: 'p1', unitId: 'u-sht', unitFactor: '1', qtyInput: '2', qtyBase: '2', price: '50.00' }], customerId: 'c1', customerName: 'Customer', no: null, priceTypeId: null, shiftId: null,
      subtotal: '100.00', total: '100.00', discount: { kind: 'percent', value: '0' }, rounding: 'kopeck', onCredit: true, creditTerms: null, vatSummary: null,
      payment: { method: 'credit', cashPaid: '0', cardPaid: '0', change: '0' }, address: null, geo: null, courier: null, assignedTo: null, priority: false }
    expect((await call(ctx, 'POST', '/v1/orders', { contractVersion: 2, commandId: randomUUID(), orderId, commercial })).statusCode).toBe(201)
    expect((await call(ctx, 'POST', `/v1/orders/${orderId}/status`, { status: 'picking' })).statusCode).toBe(200)
    const shipment = { contractVersion: 2, status: 'shipped', shipmentId, warehouseId: 'w1', orderSnapshot: commercial }
    const posted = await call(ctx, 'POST', `/v1/orders/${orderId}/status`, shipment, `shipment:${shipmentId}`)
    expect(posted.statusCode).toBe(200)
    return { orderId, shipment, documentId: posted.json().documentId, body: { contractVersion: 2 as const, status: 'delivered' as const, shipmentId, shipmentFingerprint: posted.json().fingerprint as string } }
  }
  type Fixture = Awaited<ReturnType<typeof prepare>>
  const deliver = (f: Fixture, body: unknown = f.body, key = `delivered:${f.body.shipmentId}`) => call(ctx, 'POST', `/v1/orders/${f.orderId}/status`, body, key)


 const cancellation=(f:Fixture)=>({...f.body,status:'cancelled'})
 const cancel=(f:Fixture,body:unknown=cancellation(f),key=`cancelled:${f.body.shipmentId}`)=>call(ctx,'POST',`/v1/orders/${f.orderId}/status`,body,key)
 const payment=(f?:Fixture,adjustment=false)=>legacyCustomerFixture(ctx,{amount:10,...(adjustment?{kind:'adjustment' as const,direction:'increase' as const}:{})},undefined,'c1',financePool)
 const refund=(f:Fixture,version=2)=>{const returnId=randomUUID();return call(ctx,'POST','/v1/returns',version===2?{contractVersion:2,returnId,orderId:f.orderId,items:[{saleLineId:`${f.documentId}:source`,qtyBase:'1'}]}:{orderId:f.orderId,items:[{productId:'p1',qty:1}]},version===2?`return:${returnId}`:randomUUID())}
 async function facts(){const out:Record<string,unknown>={};for(const t of ['orders','docs','doc_lines','stock_balances','stock_movements','money_movements','settlement_movements','customers','products','audit','idempotency_keys','order_lifecycle_commands','customer_financial_fences'])out[t]=(await ctx.pool.query(`select to_jsonb(t) r from ${t} t where company_id=$1 order by to_jsonb(t)::text`,[ctx.companyId])).rows;return out}
 async function receipts(){return (await ctx.pool.query("select * from order_lifecycle_commands where company_id=$1 and operation='cancelled'",[ctx.companyId])).rows}
 async function denied(f:Fixture,status:number,code?:string){const before=await facts(),r=await cancel(f);expect(r.statusCode,r.body).toBe(status);if(code)expect(r.json().error.code).toBe(code);expect(await facts()).toEqual(before);return r}
 async function usePool(pool:DbPool){financePool=pool;await ctx.app.close();ctx.app=await buildApp({config:integrationConfig(),pool,eventBus:null,fcm:null,metrics:null})}
 function gate(match:(sql:string)=>boolean,after=false,isolation?:string){
  let release!:()=>void,signal!:()=>void,paused=false
  const released=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{signal=r}),log:string[]=[],errors:string[]=[]
  const pool:DbPool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{
   const real=await ctx.pool.connect(),w=Object.create(real);w.release=real.release.bind(real)
   w.query=async(sql:string,params?:unknown[])=>{
    log.push(sql.replace(/\s+/g,' ').toLowerCase())
    const pause=!paused&&match(sql);if(pause){paused=true;if(!after){signal();await released}}
    try{const r=await real.query(isolation&&sql==='set transaction isolation level read committed'?`set transaction isolation level ${isolation}`:sql,params);if(pause&&after){signal();await released}return r}
    catch(e){errors.push((e as any).code);throw e}
   };return w
  }};return {pool,ready,release,log,errors}
 }
 async function waitLock(fragment?:string){for(let i=0;i<400;i++){
  if((await ctx.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like $1",[`%${fragment||''}%`])).rowCount)return
  await new Promise(r=>setTimeout(r,10))
 }throw Error('Expected actual PostgreSQL lock contention')}
 it('restores only the original stock/cost/debt effect, preserving other warehouse, debt, proof, lines and drafts',async()=>{
  const f=await prepare(),source=(await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2',[ctx.companyId,f.documentId])).rows[0].source_payload
  expect(await stockAt(ctx,'w1','p1')).toBe(38);expect(await stockAt(ctx,'w2','p1')).toBe(60)
  const other=randomUUID();expect((await call(ctx,'POST','/v1/sales',{order:{id:other,customerId:'c1',onCredit:true,items:[{productId:'p1',qty:1,price:30}],}})).statusCode).toBe(201)
  await ctx.pool.query("insert into docs(company_id,id,doc_type,order_id) values($1,'unrelated-draft','sales_return',$2)",[ctx.companyId,f.orderId])
  const g=gate(()=>false);await usePool(g.pool);const r=await cancel(f);expect(r.statusCode,r.body).toBe(200)
  const b=r.json();expect(b).toMatchObject({commandId:`cancelled:${f.body.shipmentId}`,documentId:f.documentId,documentStatus:'void',warehouseId:'w1',debtRemovedMinor:'10000',cashRefundedMinor:'0',order:{id:f.orderId,status:'cancelled'}})
  expect(b.restoredItems).toEqual([{sourceLineId:'source',documentLineId:`${f.documentId}:source`,productId:'p1',warehouseId:'w1',qtyBase:'2.0000',costAmount:'14.0000'}])
  expect(b.evidence.manifestHash).toBe(saleFingerprint(b.evidence.manifest));expect(b.evidence.remainingSourceMovements).toBe(0)
  expect(await debt(ctx,'customer','c1')).toBe(30);expect(await cash(ctx,'cash')).toBe(0)
  expect(await stockAt(ctx,'w1','p1')).toBe(39);expect(await stockAt(ctx,'w2','p1')).toBe(60);expect(await drift(ctx)).toEqual([])
  expect((await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2',[ctx.companyId,f.documentId])).rows[0].source_payload).toBe(source)
  expect((await ctx.pool.query("select status from docs where company_id=$1 and id='unrelated-draft'",[ctx.companyId])).rows[0].status).toBe('draft')
  const order=(await ctx.pool.query('select * from orders where company_id=$1 and id=$2',[ctx.companyId,f.orderId])).rows[0];expect(order.shipment_doc_id).toBe(f.documentId);expect(order.stock_consumed).toBe(false)
  const pos=(text:string)=>g.log.findIndex(s=>s.includes(text));expect(pos('from orders')).toBeLessThan(pos('pg_advisory_xact_lock($1::integer'));expect(pos('customer_financial_fences')).toBeLessThan(pos('order by id for update'));expect(pos('select unpost_doc')).toBeGreaterThan(pos('customer_financial_fences'))
  const reconcile=await call(ctx,'POST','/v1/stock/reconcile',{contractVersion:1,requestId:randomUUID(),productIds:['p1'],commands:[{kind:'order_status',commandId:f.orderId,idempotencyKey:`shipment:${f.body.shipmentId}`,payload:f.shipment}]})
  expect(reconcile.json().commands[0].resolution).toBe('reversed') // permanent receipt is verified by the read-only proof reader
 })
 it('permanently replays after temporary cleanup and later status change without a second unpost or old-state restore',async()=>{
  const f=await prepare(),first=await cancel(f);expect(first.statusCode).toBe(200)
  await ctx.pool.query('delete from idempotency_keys where company_id=$1',[ctx.companyId]);await ctx.pool.query("update orders set status='delivered' where company_id=$1 and id=$2",[ctx.companyId,f.orderId])
  const before=await facts(),g=gate(()=>false);await usePool(g.pool);const again=await cancel(f)
  expect(again.statusCode).toBe(200);expect(again.json()).toEqual(first.json());expect(again.headers['idempotency-replayed']).toBe('true');expect(g.log.some(s=>s.includes('unpost_doc'))).toBe(false);expect(await facts()).toEqual(before)
 })
 it('rejects changed payload with the same shipmentId and gates protected legacy cancellation before temporary replay',async()=>{
  const f=await prepare();expect((await cancel(f)).statusCode).toBe(200);const before=await facts()
  expect((await cancel(f,{...cancellation(f),shipmentFingerprint:'0'.repeat(64)})).json().error.code).toBe('CANCELLATION_IDENTITY_CONFLICT');expect(await facts()).toEqual(before)
  expect((await call(ctx,'POST','/v1/orders/missing-order/status',cancellation(f),`cancelled:${f.body.shipmentId}`)).json().error.code).toBe('CANCELLATION_IDENTITY_CONFLICT');expect(await facts()).toEqual(before)
  await ctx.pool.query("insert into idempotency_keys(company_id,key,endpoint,status,response) values($1,'old-cancel','POST /v1/orders/status',200,'{\"ok\":true}')",[ctx.companyId])
  const r=await call(ctx,'POST',`/v1/orders/${f.orderId}/status`,{status:'cancelled'},'old-cancel');expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe('COMMERCIAL_ORDER_REQUIRES_CANCELLATION_V2')
 })
 it.each(['json','fingerprint','marker','line-cost','stock-cost','settlement','draft','void'])('rejects damaged %s or missing reversal receipt without mutations',async kind=>{
  const f=await prepare()
  if(kind==='json')await ctx.pool.query("update docs set source_payload='{' where company_id=$1 and id=$2",[ctx.companyId,f.documentId])
  if(kind==='fingerprint')await ctx.pool.query("update docs set source_payload=jsonb_set(source_payload::jsonb,'{fingerprint}',to_jsonb($3::text))::text where company_id=$1 and id=$2",[ctx.companyId,f.documentId,'0'.repeat(64)])
  if(kind==='marker')await ctx.pool.query('update orders set shipment_doc_id=null where company_id=$1 and id=$2',[ctx.companyId,f.orderId])
  if(kind==='line-cost')await ctx.pool.query('update doc_lines set cost_amount=999 where company_id=$1 and doc_id=$2',[ctx.companyId,f.documentId])
  if(kind==='stock-cost')await ctx.pool.query('update stock_movements set cost_amount=-999 where company_id=$1 and doc_id=$2',[ctx.companyId,f.documentId])
  if(kind==='settlement')await ctx.pool.query('update settlement_movements set amount=999 where company_id=$1 and doc_id=$2',[ctx.companyId,f.documentId])
  if(kind==='draft'||kind==='void'){await ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,f.documentId]);if(kind==='void')await ctx.pool.query("update docs set status='void' where company_id=$1 and id=$2",[ctx.companyId,f.documentId])}
  await denied(f,409,'CANCELLATION_RECONCILIATION_REQUIRED');expect(await receipts()).toHaveLength(0)
 })
 it.each(['hash','manifest','body','canonical'])('fails closed for corrupted lifecycle %s',async kind=>{
  const f=await prepare();expect((await cancel(f)).statusCode).toBe(200)
  const paths:Record<string,string[]>={hash:['evidence','manifestHash'],manifest:['evidence','manifest','stockMovements','0','qty'],body:['debtRemovedMinor']}
  if(kind==='canonical')await ctx.pool.query("update order_lifecycle_commands set canonical_payload='{}' where company_id=$1 and operation='cancelled'",[ctx.companyId])
  else await ctx.pool.query("update order_lifecycle_commands set response_body=jsonb_set(response_body,$2::text[],$3::jsonb) where company_id=$1 and operation='cancelled'",[ctx.companyId,paths[kind],JSON.stringify('broken')])
  await denied(f,409,'CANCELLATION_PROOF_INVALID')
 })
 it.each(['payment','increase','decrease','linked-payment'])('rejects %s without allocating or returning money',async kind=>{
  const f=await prepare()
  const r=await legacyCustomerFixture(ctx,{amount:10,...(kind==='increase'||kind==='decrease'?{kind:'adjustment' as const,direction:kind}:{})},undefined,'c1',financePool);expect(r.statusCode).toBe(201)
  if(kind==='linked-payment')await ctx.pool.query("update docs set order_id=$2 where company_id=$1 and doc_type='payment_in'",[ctx.companyId,f.orderId])
  await denied(f,422,'CANCELLATION_FINANCIAL_RECONCILIATION_REQUIRED')
 })
 it.each([1,2])('keeps P0010 priority for posted return v%s, including delivered',async version=>{
  const f=await prepare();if(version===2)expect((await deliver(f)).statusCode).toBe(200)
  const r=await refund(f,version);expect(r.statusCode,r.body).toBe(201);await denied(f,409,'SALE_HAS_POSTED_RETURNS')
 })
 it.each(['current','later-status'])('rejects delivered %s even when the textual status is subsequently changed',async mode=>{
  const f=await prepare();expect((await deliver(f)).statusCode).toBe(200)
  if(mode==='later-status')await ctx.pool.query("update orders set status='shipped' where company_id=$1 and id=$2",[ctx.companyId,f.orderId])
  await denied(f,409,'DELIVERED_ORDER_CANCELLATION_FORBIDDEN')
 })
 it('isolates company/order identity and preserves legacy cancellation',async()=>{
  const f=await prepare(),foreign=await setupIntegration()
  try{expect((await call(foreign,'POST',`/v1/orders/${f.orderId}/status`,cancellation(f),`cancelled:${f.body.shipmentId}`)).statusCode).toBe(404)}finally{await foreign.close()}
  const id=randomUUID();expect((await call(ctx,'POST','/v1/sales',{order:{id,customerId:'c1',onCredit:true,items:[{productId:'p1',qty:1,price:50}]}})).statusCode).toBe(201)
  expect((await call(ctx,'POST',`/v1/orders/${id}/status`,{status:'cancelled'})).statusCode).toBe(200)
 })
 it.each(['unpost_doc',"update docs set status='void'","update orders set status='cancelled'",'insert into order_lifecycle_commands','insert into audit'])('rolls back after actual SQL stage %s',async stage=>{
  const f=await prepare(),before=await facts();let fired=false
  const pool:DbPool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{
   const real=await ctx.pool.connect(),w=Object.create(real);w.release=real.release.bind(real);w.query=async(sql:string,params?:unknown[])=>{const r=await real.query(sql,params);if(!fired&&sql.includes(stage)){fired=true;throw Error('injected after SQL stage')}return r};return w
  }}
  await usePool(pool);expect((await cancel(f)).statusCode).toBe(500);expect(fired).toBe(true);expect(await facts()).toEqual(before)
 })
 it('retains the protected legacy gate even if commercial_snapshot is damaged to NULL',async()=>{
  const f=await prepare();await ctx.pool.query('update orders set commercial_snapshot=null where company_id=$1 and id=$2',[ctx.companyId,f.orderId]);const before=await facts()
  const r=await call(ctx,'POST',`/v1/orders/${f.orderId}/status`,{status:'cancelled'});expect(r.json().error.code).toBe('COMMERCIAL_ORDER_REQUIRES_CANCELLATION_V2');expect(await facts()).toEqual(before)
 })
 it('detects an incomplete unpost result and rolls its entire transaction back',async()=>{
  const f=await prepare(),before=await facts();let fired=false
  const pool:DbPool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{
   const real=await ctx.pool.connect(),w=Object.create(real);w.release=real.release.bind(real);w.query=async(sql:string,params?:unknown[])=>{const r=await real.query(sql,params);if(!fired&&sql.includes('select unpost_doc')){fired=true;await real.query("insert into stock_movements(company_id,id,doc_id,doc_type,warehouse_id,product_id,qty,cost_amount) values($1,$2,$3,'sales_shipment','w1','p1',-1,0)",[ctx.companyId,`${f.documentId}:ghost`,f.documentId])}return r};return w
  }};await usePool(pool);await denied(f,409,'CANCELLATION_RECONCILIATION_REQUIRED');expect(await facts()).toEqual(before)
 })
 it('does not automatically call unpost again after a real 40001 raised after unpost began',async()=>{
  const f=await prepare(),before=await facts();let fired=false,calls=0
  const pool:DbPool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{
   const real=await ctx.pool.connect(),w=Object.create(real);w.release=real.release.bind(real);w.query=async(sql:string,params?:unknown[])=>{const r=await real.query(sql,params);if(sql.includes('select unpost_doc')){calls++;if(!fired){fired=true;await real.query("do $$ begin raise exception 'test serialization' using errcode='40001'; end $$")}}return r};return w
  }};await usePool(pool);await denied(f,409,'CANCELLATION_RETRY_REQUIRED');expect(calls).toBe(1);expect(await facts()).toEqual(before)
  expect((await cancel(f)).statusCode).toBe(200);expect(calls).toBe(2);expect(await stockAt(ctx,'w1','p1')).toBe(40);expect(await receipts()).toHaveLength(1)
 })
 it('two concurrent cancellations create one receipt and invoke unpost once',async()=>{
  const f=await prepare(),g=gate(s=>s==='commit');await usePool(g.pool);const a=Promise.resolve(cancel(f));let b:Promise<any>|undefined
  try{await g.ready;b=Promise.resolve(cancel(f));await waitLock('pg_advisory_xact_lock');g.release();const first=await a,second=await b
   expect(first.statusCode).toBe(200);expect(second.json()).toEqual(first.json());expect(second.headers['idempotency-replayed']).toBe('true');expect(await receipts()).toHaveLength(1);expect(g.log.filter(s=>s.includes('select unpost_doc')).length).toBe(1)
   expect(await stockAt(ctx,'w1','p1')).toBe(40)
  }finally{g.release();await a;await b}
 })
 it.each(['cancel-first','delivered-first'])('%s serializes cancellation and delivery',async order=>{
  const f=await prepare(),g=gate(s=>s==='commit');await usePool(g.pool);const a=Promise.resolve(order==='cancel-first'?cancel(f):deliver(f));let b:Promise<any>|undefined
  try{await g.ready;b=Promise.resolve(order==='cancel-first'?deliver(f):cancel(f));await waitLock('pg_advisory_xact_lock');g.release();expect((await a).statusCode).toBe(200);expect((await b).statusCode).toBe(409)
   expect(await stockAt(ctx,'w1','p1')).toBe(order==='cancel-first'?40:38)
  }finally{g.release();await a;await b}
 })
 it.each([['cancel-first',1],['return-first',1],['cancel-first',2],['return-first',2]] as const)('%s serializes cancellation and return v%s without a late stock effect',async(order,version)=>{
  const f=await prepare(),g=order==='return-first'&&version===2?gate(s=>s.includes('from orders')&&s.includes('for update'),true):gate(s=>s==='commit');await usePool(g.pool)
  const a=Promise.resolve(order==='cancel-first'?cancel(f):refund(f,version));let b:Promise<any>|undefined
  try{await g.ready;b=Promise.resolve(order==='cancel-first'?refund(f,version):cancel(f));await waitLock('from orders');g.release()
   expect((await a).statusCode).toBe(order==='cancel-first'?200:version===1?201:422);expect((await b).statusCode).toBe(order==='cancel-first'?409:version===1?409:200);expect(await stockAt(ctx,'w1','p1')).toBe(order==='return-first'&&version===1?39:40)
  }finally{g.release();await a;await b}
 })
 it.each([['cancel-first',false],['payment-first',false],['cancel-first',true],['payment-first',true]] as const)('%s serializes cancellation and payment/adjustment=%s',async(order,adjustment)=>{
  const f=await prepare(),g=gate(s=>s==='commit');await usePool(g.pool);const pay=()=>payment(f,adjustment)
  const a=Promise.resolve(order==='cancel-first'?cancel(f):pay());let b:Promise<any>|undefined
  try{await g.ready;b=Promise.resolve(order==='cancel-first'?pay():cancel(f));await waitLock('$1::integer');g.release()
   expect((await a).statusCode).toBe(order==='cancel-first'?200:201);expect((await b).statusCode).toBe(order==='cancel-first'?201:422)
   expect(await debt(ctx,'customer','c1')).toBe(order==='cancel-first'?(adjustment?10:-10):(adjustment?110:90));expect(await cash(ctx,'cash')).toBe(adjustment?0:10)
  }finally{g.release();await a;await b}
 })
 it.each(['cancel-first','sql-first'])('%s serializes cancellation against direct SQL unpost',async order=>{
  const f=await prepare()
  if(order==='cancel-first'){
   const g=gate(s=>s==='commit');await usePool(g.pool);const a=Promise.resolve(cancel(f));let b:Promise<any>|undefined
   try{await g.ready;b=ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,f.documentId]).then(()=>null,e=>e);await waitLock('unpost_doc');g.release();expect((await a).statusCode).toBe(200);expect((await b).code).toBe('P0008')}
   finally{g.release();await a;await b}
  }else{
   const c=await ctx.pool.connect();let b:Promise<any>|undefined
   try{await c.query('begin');await c.query('select unpost_doc($1,$2)',[ctx.companyId,f.documentId]);b=Promise.resolve(cancel(f));await waitLock('from orders');await c.query('commit');expect((await b).json().error.code).toBe('CANCELLATION_RECONCILIATION_REQUIRED');expect(await receipts()).toHaveLength(0)}
   finally{await c.query('rollback');c.release();await b}
  }
  expect(await stockAt(ctx,'w1','p1')).toBe(40)
 })
 it.each(['read committed','repeatable read','serializable'])('%s cannot cancel across a newer payment; stale attempts use actual 40001 retry',async isolation=>{
  const f=await prepare(),g=gate(s=>s.includes('pg_advisory_xact_lock($1::integer'),false,isolation);await usePool(g.pool);const a=Promise.resolve(cancel(f))
  try{await g.ready;expect((await payment()).statusCode).toBe(201);g.release();expect((await a).statusCode).toBe(422);expect(g.errors.includes('40001')).toBe(isolation!=='read committed');expect(await receipts()).toHaveLength(0);expect(await stockAt(ctx,'w1','p1')).toBe(38)}finally{g.release();await a}
 })
 it('retries a real lost HTTP response after commit without another unpost or financial write',async()=>{
  ctx.app.addHook('onSend',async(req,reply,payload)=>{if(req.headers['x-test-drop']==='1')reply.raw.destroy();return payload})
  const f=await prepare(),address=await ctx.app.listen({host:'127.0.0.1',port:0}),key=`cancelled:${f.body.shipmentId}`
  const error=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{const req=httpRequest(`${address}/v1/orders/${f.orderId}/status`,{method:'POST',headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':ctx.companyId,'idempotency-key':key,'content-type':'application/json','x-test-drop':'1'}},r=>{r.resume();reject(Error('Expected lost response'))});req.on('error',resolve);req.end(JSON.stringify(cancellation(f)))})
  expect(error.code).toBe('ECONNRESET');const before=await facts(),r=await cancel(f);expect(r.statusCode).toBe(200);expect(r.headers['idempotency-replayed']).toBe('true');expect(await facts()).toEqual(before)
 })
 it('upgrades 0031 to 0032, preserves old receipts/fences and function definitions, and reruns safely',async()=>{
  const db=`cancel_upgrade_${randomUUID().replaceAll('-','')}`;await ctx.pool.query(`create database ${db}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname=`/${db}`;const p=new pg.Pool({connectionString:url.toString()})
  try{
   await p.query('create table schema_migrations(name text primary key,applied_at timestamptz not null default now())')
   for(const file of (await readdir('sql/migrations')).filter(f=>f.endsWith('.sql')&&f<'0032').sort()){
    const c=await p.connect();try{await c.query('begin');await c.query(await readFile(`sql/migrations/${file}`,'utf8'));await c.query('insert into schema_migrations(name) values($1)',[file]);await c.query('commit')}finally{c.release()}
   }
   const company=randomUUID();await p.query("insert into companies(id,name) values($1,'upgrade-fixture')",[company]);await p.query("insert into orders(company_id,id,status) values($1,'history','delivered')",[company]);await p.query("insert into customer_financial_fences values($1,'historical-customer',7)",[company]);await p.query("insert into order_lifecycle_commands(company_id,command_id,order_id,operation,canonical_payload,fingerprint,response_status,response_body) values($1,'delivered:history','history','delivered','{}',$2,200,'{}')",[company,'0'.repeat(64)])
   const state=async()=>({receipts:(await p.query('select * from order_lifecycle_commands')).rows,fences:(await p.query('select * from customer_financial_fences')).rows,orders:(await p.query('select * from orders')).rows,functions:(await p.query("select pg_get_functiondef('post_doc(uuid,text)'::regprocedure) p,pg_get_functiondef('unpost_doc(uuid,text)'::regprocedure) u")).rows})
   const before=await state();await runMigrations(p,()=>{});expect(await state()).toEqual(before);expect((await p.query('select count(*)::int n from schema_migrations')).rows[0].n).toBe((await readdir('sql/migrations')).filter(f=>f.endsWith('.sql')).length)
   await runMigrations(p,()=>{});expect(await state()).toEqual(before)
   await p.query("insert into order_lifecycle_commands(company_id,command_id,order_id,operation,canonical_payload,fingerprint,response_status,response_body) values($1,'cancelled:fixture','history','cancelled','{}',$2,200,'{}')",[company,'1'.repeat(64)])
   await expect(p.query("insert into order_lifecycle_commands(company_id,command_id,order_id,operation,canonical_payload,fingerprint,response_status,response_body) values($1,'invalid','history','unsupported','{}',$2,200,'{}')",[company,'2'.repeat(64)])).rejects.toMatchObject({code:'23514'})
  }finally{await p.end()}
 })
})
