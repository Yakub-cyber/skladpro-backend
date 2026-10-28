import { cancelShipmentV2 } from './helpers.js'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowSkipIntegration, call, hasDb, integrationConfig, setupIntegration, stockAt, type Ctx } from './helpers.js'
import { shipmentV2 } from '../../src/services/shipmentsV2.js'
import { buildApp } from '../../src/app.js'
import type { DbPool } from '../../src/db.js'

if(!hasDb&&!allowSkipIntegration) throw new Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('shipment v2 — real PostgreSQL',()=>{
 let ctx:Ctx
 beforeEach(async()=>{ctx=await setupIntegration()})
 afterEach(async()=>{await ctx?.close()})
 const snapshot=()=>({items:[{lineId:'source-z',productId:'p1',unitId:'u-sht',unitFactor:'1',qtyInput:'2',qtyBase:'2',price:'50.00'}],
  customerId:'c1',customerName:'Клиент',no:null,priceTypeId:null,shiftId:null,subtotal:'100.00',discount:{kind:'percent',value:'0'},
  total:'100.00',rounding:'kopeck',onCredit:true,creditTerms:null,payment:{method:'credit',cashPaid:'0',cardPaid:'0',change:'0'},
  vatSummary:null,address:'Адрес',geo:null,courier:null,assignedTo:null,priority:false})
 type Fixture={orderId:string;body:{contractVersion:2;status:'shipped';shipmentId:string;warehouseId:string;orderSnapshot:ReturnType<typeof snapshot>}}
 const prepare=async(c=snapshot()):Promise<Fixture>=>{
  const orderId=randomUUID()
  const created=await call(ctx,'POST','/v1/orders',{contractVersion:2,commandId:randomUUID(),orderId,commercial:c})
  expect(created.statusCode).toBe(201)
  for(const status of ['confirmed','packed']) expect((await call(ctx,'POST',`/v1/orders/${orderId}/status`,{status})).statusCode).toBe(200)
  return {orderId,body:{contractVersion:2,status:'shipped',shipmentId:randomUUID(),warehouseId:'w1',orderSnapshot:c}}
 }
 const send=(f:Fixture,key=`shipment:${f.body.shipmentId}`)=>call(ctx,'POST',`/v1/orders/${f.orderId}/status`,f.body,key)
 const deliver = async (f: Fixture) => {
  const saved = JSON.parse((await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2',[ctx.companyId,`shipment-${f.body.shipmentId}`])).rows[0].source_payload)
  return call(ctx,'POST',`/v1/orders/${f.orderId}/status`,{contractVersion:2,status:'delivered',shipmentId:f.body.shipmentId,shipmentFingerprint:saved.fingerprint},`delivered:${f.body.shipmentId}`)
 }
 const auth=()=>({companyId:ctx.companyId,userId:ctx.userId,role:'admin',email:null,memberName:'Тест',isSuperAdmin:false})
 const counters=async()=>(await ctx.pool.query(`select
  (select count(*) from docs where company_id=$1) as docs,
  (select count(*) from stock_movements where company_id=$1) as stock,
  (select count(*) from money_movements where company_id=$1) as money,
  (select count(*) from settlement_movements where company_id=$1) as settlement,
  (select count(*) from audit where company_id=$1) as audit`,[ctx.companyId])).rows[0]
 const version=async(orderId:string)=>(await ctx.pool.query('select row_version::text from orders where company_id=$1 and id=$2',[ctx.companyId,orderId])).rows[0].row_version
 const edit=(f:Fixture,c=f.body.orderSnapshot,v?:string)=>ctx.app.inject({method:'PUT',url:`/v1/orders/${f.orderId}/commercial`,
  headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':ctx.companyId},payload:{contractVersion:2,commandId:randomUUID(),orderId:f.orderId,expectedRowVersion:v,commercial:c}})
 const waitForLock=async(fragment:string)=>{
  const deadline=Date.now()+5000
  while(Date.now()<deadline){
   if((await ctx.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like $1",[`%${fragment}%`])).rowCount) return
   await new Promise(r=>setTimeout(r,10))
  }
  throw new Error(`No PostgreSQL lock wait for ${fragment}`)
 }
 function gateCommit(){
  let unblock!:()=>void,readyResolve!:()=>void,paused=false
  const released=new Promise<void>(r=>{unblock=r}),ready=new Promise<void>(r=>{readyResolve=r})
  const pool:DbPool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{
   const real=await ctx.pool.connect(),wrapped=Object.create(real)
   wrapped.release=real.release.bind(real)
   wrapped.query=(...args:any[])=>{
    if(String(args[0]).toLowerCase()==='commit'&&!paused){paused=true;readyResolve();return released.then(()=>(real.query as any)(...args))}
    return (real.query as any)(...args)
   }
   return wrapped
  }}
  return {pool,ready,release:unblock}
 }
 for(const warehouse of ['w1','w2']) it(`ships from ${warehouse} with one stock/debt effect and no money receipt`,async()=>{
  const f=await prepare();f.body.warehouseId=warehouse
  const r=await send(f);expect(r.statusCode).toBe(200)
  expect(r.json()).toMatchObject({contractVersion:2,shipmentId:f.body.shipmentId,warehouseId:warehouse,amount:'100.00',cashReceivedMinor:'0',debtCreatedMinor:'10000',items:[{sourceLineId:'source-z',documentLineId:`shipment-${f.body.shipmentId}:source-z`}]})
  expect(await stockAt(ctx,warehouse,'p1')).toBe(-2);expect(await stockAt(ctx,warehouse==='w1'?'w2':'w1','p1')).toBe(0)
  expect(await counters()).toMatchObject({docs:'1',stock:'1',money:'0',settlement:'1'})
  const stored=(await ctx.pool.query('select source_payload,warehouse_id,status from docs where company_id=$1 and id=$2',[ctx.companyId,r.json().documentId])).rows[0]
  expect(JSON.parse(stored.source_payload)).toMatchObject({kind:'shipment-v2',request:{companyId:ctx.companyId,orderId:f.orderId,...f.body},result:r.json()})
 })
 it('requires an explicit warehouse',async()=>{
  const f=await prepare(),{warehouseId:_,...body}=f.body
  expect((await call(ctx,'POST',`/v1/orders/${f.orderId}/status`,body,`shipment:${f.body.shipmentId}`)).statusCode).toBe(422)
  expect(await counters()).toMatchObject({docs:'0',stock:'0',money:'0'})
 })
 it('rejects absent, foreign and archived warehouses',async()=>{
  const foreign=await setupIntegration()
  try{
   await foreign.pool.query("insert into warehouses(company_id,id,name) values($1,'foreign-only','Other')",[foreign.companyId])
   await ctx.pool.query("update warehouses set deleted_at=now() where company_id=$1 and id='w2'",[ctx.companyId])
   for(const wh of ['missing','foreign-only','w2']){
    const f=await prepare();f.body.warehouseId=wh
    expect((await send(f)).json().error.code).toBe('SHIPMENT_WAREHOUSE_UNAVAILABLE')
   }
   expect(await counters()).toMatchObject({docs:'0',stock:'0',money:'0',settlement:'0'})
  }finally{await foreign.close()}
 })
 it('rejects a historical order without adopting its empty items',async()=>{
  const f=await prepare();await ctx.pool.query('update orders set commercial_snapshot=null,items=\'[]\' where company_id=$1 and id=$2',[ctx.companyId,f.orderId])
  expect((await send(f)).json().error.code).toBe('SHIPMENT_REQUIRES_COMMERCIAL_V2')
 })
 for(const field of ['items','price','discount','customer','credit']) it(`rejects a stale or changed ${field} snapshot`,async()=>{
  const f=await prepare(),changed=structuredClone(f.body.orderSnapshot)
  if(field==='items') changed.items[0]!.qtyInput=changed.items[0]!.qtyBase='3',changed.subtotal=changed.total='150.00'
  if(field==='price') changed.items[0]!.price='60.00',changed.subtotal=changed.total='120.00'
  if(field==='discount') changed.discount.value='10',changed.total='90.00'
  if(field==='customer') changed.customerName='Changed'
  if(field==='credit') changed.onCredit=false,changed.payment.method='unpaid'
  const e=await edit(f,changed,await version(f.orderId));expect(e.statusCode).toBe(200)
  const before=await counters(),r=await send(f)
  expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe('SHIPMENT_SNAPSHOT_CONFLICT');expect(await counters()).toEqual(before)
 })
 it('replays permanently after temporary key cleanup, delivered, archive and forbidden cancellation',async()=>{
  const f=await prepare(),first=await send(f);expect(first.statusCode).toBe(200)
  expect((await send(f)).json()).toEqual(first.json())
  expect((await deliver(f)).statusCode).toBe(200)
  await ctx.pool.query('delete from idempotency_keys where company_id=$1',[ctx.companyId])
  await ctx.pool.query("update warehouses set deleted_at=now() where company_id=$1 and id='w1'",[ctx.companyId])
  let before=await counters(),replay=await send(f)
  expect(replay.headers['idempotency-replayed']).toBe('true');expect(replay.json()).toEqual(first.json());expect(await counters()).toEqual(before)
  expect((await call(ctx,'POST',`/v1/orders/${f.orderId}/status`,{status:'cancelled'})).statusCode).toBe(409)
  before=await counters();expect((await send(f)).json()).toEqual(first.json());expect(await counters()).toEqual(before)
  expect(await stockAt(ctx,'w1','p1')).toBe(-2)
 })
 it('replays decimal-equivalent money without relying on lexical formatting of SQL numeric',async()=>{
  const c=snapshot();c.subtotal=c.total='100';const f=await prepare(c),first=await send(f)
  expect(first.statusCode).toBe(200);expect((await send(f)).json()).toEqual(first.json())
 })
 for(const expired of [false,true]) it(`changed fingerprint cannot use replay (expired=${expired})`,async()=>{
  const f=await prepare();expect((await send(f)).statusCode).toBe(200)
  if(expired) await ctx.pool.query('delete from idempotency_keys where company_id=$1',[ctx.companyId])
  const before=await counters()
  for(const body of [{...f.body,warehouseId:'w2'},{...f.body,orderSnapshot:{...f.body.orderSnapshot,address:'Changed'}}]){
   const r=await send({...f,body});expect(r.statusCode).toBe(409);expect(await counters()).toEqual(before)
  }
 })
 it('does not trust a temporary receipt without a permanent proof',async()=>{
  const f=await prepare();await send(f)
  await ctx.pool.query("update docs set source_payload='{}' where company_id=$1 and order_id=$2",[ctx.companyId,f.orderId])
  const before=await counters();expect((await send(f)).statusCode).toBe(409);expect(await counters()).toEqual(before)
 })
 it('serializes identical and different shipment IDs for one order',async()=>{
  const f=await prepare(),same=await Promise.all([send(f),send(f)])
  expect(same.map(r=>r.statusCode)).toEqual([200,200]);expect(same[0]!.json()).toEqual(same[1]!.json())
  const other=await prepare(),different=await Promise.all([send(other),send({...other,body:{...other.body,shipmentId:randomUUID()}})])
  expect(different.map(r=>r.statusCode).sort()).toEqual([200,409])
  expect(await counters()).toMatchObject({docs:'2',stock:'2',money:'0',settlement:'2'})
 })
 it('does not reuse shipmentId across orders',async()=>{
  const a=await prepare(),b=await prepare();b.body.shipmentId=a.body.shipmentId
  const r=await Promise.all([send(a),send(b)])
  expect(r.map(v=>v.statusCode).sort()).toEqual([200,409]);expect(await counters()).toMatchObject({docs:'1',stock:'1'})
 })
 it('ships independent orders for the same customer and product concurrently',async()=>{
  const a=await prepare(),b=await prepare(),r=await Promise.all([send(a),send(b)])
  expect(r.map(v=>v.statusCode)).toEqual([200,200])
  expect(await stockAt(ctx,'w1','p1')).toBe(-4)
  expect(await counters()).toMatchObject({docs:'2',stock:'2',money:'0',settlement:'2'})
  expect((await ctx.pool.query('select sum(amount)::text as amount from settlement_movements where company_id=$1',[ctx.companyId])).rows[0].amount).toBe('200.00')
 })
 it('isolates identical shipment/order IDs across companies and denies foreign access',async()=>{
  const f=await prepare(),foreign=await setupIntegration()
  try{
   expect((await call(foreign,'POST','/v1/orders',{contractVersion:2,commandId:randomUUID(),orderId:f.orderId,commercial:f.body.orderSnapshot})).statusCode).toBe(201)
   for(const status of ['confirmed','packed']) await call(foreign,'POST',`/v1/orders/${f.orderId}/status`,{status})
   const mine=await send(f),other=await call(foreign,'POST',`/v1/orders/${f.orderId}/status`,f.body,`shipment:${f.body.shipmentId}`)
   expect(mine.statusCode).toBe(200);expect(other.statusCode).toBe(200)
   expect(mine.json().fingerprint).not.toBe(other.json().fingerprint)
   expect(await stockAt(ctx,'w1','p1')).toBe(-2);expect(await stockAt(foreign,'w1','p1')).toBe(-2)
   expect((await ctx.app.inject({method:'POST',url:`/v1/orders/${f.orderId}/status`,payload:f.body,headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':foreign.companyId,'idempotency-key':`shipment:${f.body.shipmentId}`}})).statusCode).toBe(403)
  }finally{await foreign.close()}
 })
 it('rejects partial composition, additional warehouse fields and wrong idempotency key',async()=>{
  const c=snapshot();c.items.push({...c.items[0]!,lineId:'other'});c.subtotal=c.total='200.00'
  const f=await prepare(c),partial=structuredClone(f);partial.body.orderSnapshot.items.splice(0,1)
  partial.body.orderSnapshot.subtotal=partial.body.orderSnapshot.total='100.00'
  expect((await send(partial)).json().error.code).toBe('SHIPMENT_SNAPSHOT_CONFLICT')
  expect((await call(ctx,'POST',`/v1/orders/${f.orderId}/status`,{...f.body,warehouseToId:'w2'},`shipment:${f.body.shipmentId}`)).statusCode).toBe(422)
  expect((await send(f,'wrong-stable-key')).statusCode).toBe(409)
  expect(await counters()).toMatchObject({docs:'0',stock:'0',money:'0'})
 })
 it('rejects missing order, unprepared state and courier requests',async()=>{
  const f=await prepare()
  expect((await send({...f,orderId:randomUUID()})).statusCode).toBe(404)
  await ctx.pool.query("update orders set status='new' where company_id=$1 and id=$2",[ctx.companyId,f.orderId])
  expect((await send(f)).json().error.code).toBe('SHIPMENT_STATUS_CONFLICT')
  await ctx.pool.query("update memberships set role='courier' where company_id=$1 and user_id=$2",[ctx.companyId,ctx.userId]);ctx.app.invalidateMembershipCache(ctx.userId)
  expect((await send(f)).statusCode).toBe(403)
 })
 it('rejects a new shipment ID after a previous shipment or cancelled order',async()=>{
  const a=await prepare();await send(a)
  expect((await send({...a,body:{...a.body,shipmentId:randomUUID()}})).json().error.code).toBe('SHIPMENT_ALREADY_EXISTS')
  const b=await prepare();expect((await call(ctx,'POST',`/v1/orders/${b.orderId}/status`,{status:'cancelled'})).statusCode).toBe(409)
  await ctx.pool.query("update orders set status='cancelled' where company_id=$1 and id=$2",[ctx.companyId,b.orderId]) // historical-state fixture, not an unshipped cancellation API
  expect((await send(b)).json().error.code).toBe('SHIPMENT_ORDER_CANCELLED')
 })
 it('preserves stable mappings for duplicate products, sorted execution and packaging',async()=>{
  const c=snapshot();c.items=[{...c.items[0]!,lineId:'z-source'},{...c.items[0]!,lineId:'a-source',unitId:'u-pack',unitFactor:'12',qtyInput:'0.5',qtyBase:'6',price:'10.00'}]
  c.subtotal=c.total='160.00'
  const f=await prepare(c),r=await send(f);expect(r.statusCode).toBe(200)
  expect(r.json().items.map((l:any)=>[l.sourceLineId,l.documentLineId,l.amount])).toEqual([
   ['z-source',`shipment-${f.body.shipmentId}:z-source`,'100.00'],['a-source',`shipment-${f.body.shipmentId}:a-source`,'60.00']])
  const lines=(await ctx.pool.query('select id,unit_id,qty_input::text,qty::text,price::text from doc_lines where company_id=$1 and doc_id=$2 order by line_no',[ctx.companyId,r.json().documentId])).rows
  expect(lines[0]).toMatchObject({id:`shipment-${f.body.shipmentId}:a-source`,unit_id:'u-pack',qty_input:'0.5',qty:'6',price:'10.00'})
  expect(await stockAt(ctx,'w1','p1')).toBe(-8)
 })
 for(const kind of ['discount','cash','unpaid','rounding','line-rounding','prepayment','unit','marked']) it(`rejects unsupported ${kind} without effects`,async()=>{
  const c=snapshot()
  if(kind==='discount') c.discount.value='10',c.total='90.00'
  if(kind==='cash'||kind==='unpaid') c.onCredit=false,c.payment.method=kind
  if(kind==='rounding') c.items[0]!.price='50.24',c.subtotal='100.48',c.total='100.00',c.rounding='ruble'
  if(kind==='line-rounding') Object.assign(c.items[0]!,{qtyInput:'0.1',qtyBase:'0.1',price:'0.01'}),c.subtotal=c.total='0.00'
  const f=await prepare(c)
  if(kind==='unit') await ctx.pool.query("update product_units set factor=2 where company_id=$1 and id='u-sht'",[ctx.companyId])
  if(kind==='marked') await ctx.pool.query("update products set marked=true where company_id=$1 and id='p1'",[ctx.companyId])
  if(kind==='prepayment'){
   await ctx.pool.query(`insert into docs(company_id,id,doc_type,party_kind,party_id,account_id,order_id,amount) values($1,'prepay','payment_in','customer','c1','cash',$2,10)`,[ctx.companyId,f.orderId])
   await ctx.pool.query('select post_doc($1,$2)',[ctx.companyId,'prepay'])
  }
  const before=await counters();expect((await send(f)).statusCode).toBe(422);expect(await counters()).toEqual(before)
 })
 it('rejects edits after shipment',async()=>{
  const f=await prepare();await send(f)
  expect((await edit(f,f.body.orderSnapshot,await version(f.orderId))).json().error.code).toBe('ORDER_COMMERCIAL_LOCKED')
 })
 it('real lost HTTP response after commit never duplicates posting',async()=>{
  ctx.app.addHook('onSend',async(request,reply,payload)=>{if(request.headers['x-test-drop']==='1') reply.raw.destroy();return payload})
  const f=await prepare()
  const address=await ctx.app.listen({host:'127.0.0.1',port:0})
  const error=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{
   const req=httpRequest(`${address}/v1/orders/${f.orderId}/status`,{method:'POST',headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':ctx.companyId,
    'idempotency-key':`shipment:${f.body.shipmentId}`,'content-type':'application/json','x-test-drop':'1'}},r=>{r.resume();reject(new Error('Expected lost response'))})
   req.on('error',resolve);req.end(JSON.stringify(f.body))
  })
  expect(error.code).toBe('ECONNRESET');const before=await counters();expect((await send(f)).statusCode).toBe(200);expect(await counters()).toEqual(before)
 })
 it('rolls back real SQL posting if storing the permanent proof fails',async()=>{
  const f=await prepare(),before=await counters()
  const pool:DbPool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{
   const real=await ctx.pool.connect(),wrapped=Object.create(real);wrapped.release=real.release.bind(real)
   wrapped.query=(sql:string,params?:unknown[])=>sql.startsWith('update docs set source_payload')?real.query('select 1/0'):real.query(sql,params)
   return wrapped
  }}
  await expect(shipmentV2(pool,auth(),f.orderId,f.body,`shipment:${f.body.shipmentId}`)).rejects.toThrow('division by zero')
  expect(await counters()).toEqual(before)
  expect((await ctx.pool.query('select stock_consumed,status,shipment_doc_id from orders where company_id=$1 and id=$2',[ctx.companyId,f.orderId])).rows[0]).toEqual({stock_consumed:false,status:'packed',shipment_doc_id:null})
  expect((await send(f)).statusCode).toBe(200)
 })
 it('edit commits first: shipment waits and rejects stale snapshot',async()=>{
  const f=await prepare(),gate=gateCommit(),v=await version(f.orderId)
  await ctx.app.close();ctx.app=await buildApp({config:integrationConfig(),pool:gate.pool,eventBus:null,fcm:null,metrics:null})
  const c=structuredClone(f.body.orderSnapshot);c.address='Changed'
  const editor=Promise.resolve(edit(f,c,v));let ship:Promise<any>|undefined
  try{
   await gate.ready;ship=Promise.resolve(send(f));await waitForLock('pg_advisory_xact_lock');gate.release()
   expect((await editor).statusCode).toBe(200);expect((await ship).json().error.code).toBe('SHIPMENT_SNAPSHOT_CONFLICT')
   expect(await counters()).toMatchObject({docs:'0',stock:'0',money:'0'})
  }finally{gate.release();await editor;await ship}
 })
 it('shipment commits first: concurrent editor waits then rejects',async()=>{
  const f=await prepare(),gate=gateCommit(),v=await version(f.orderId)
  const ship=shipmentV2(gate.pool,auth(),f.orderId,f.body,`shipment:${f.body.shipmentId}`);let editor:Promise<any>|undefined
  try{
   await gate.ready;editor=Promise.resolve(edit(f,f.body.orderSnapshot,v));await waitForLock('pg_advisory_xact_lock');gate.release()
   expect((await ship).status).toBe(200);expect((await editor).statusCode).toBe(409)
   expect(await counters()).toMatchObject({docs:'1',stock:'1',money:'0'})
  }finally{gate.release();await ship;await editor}
 })
 it('protected cancellation before the first shipment is not supported and cannot bypass the v2 gate',async()=>{
  const f=await prepare()
  expect((await call(ctx,'POST',`/v1/orders/${f.orderId}/status`,{status:'cancelled'})).json().error.code).toBe('COMMERCIAL_ORDER_REQUIRES_CANCELLATION_V2')
  expect((await cancelShipmentV2(ctx,f.orderId,f.body)).json().error.code).toBe('CANCELLATION_STATUS_CONFLICT')
  expect((await send(f)).statusCode).toBe(200)
 })
 it('shipment commits first: cancellation waits and reverses exactly once; replay never reposts',async()=>{
  const f=await prepare(),gate=gateCommit()
  const ship=shipmentV2(gate.pool,auth(),f.orderId,f.body,`shipment:${f.body.shipmentId}`);let cancel:Promise<any>|undefined
  try{
   await gate.ready;cancel=Promise.resolve(cancelShipmentV2(ctx,f.orderId,f.body));await waitForLock('pg_advisory_xact_lock');gate.release()
   const initial=await ship;expect((await cancel).statusCode).toBe(200)
   const before=await counters();expect((await send(f)).json()).toEqual(initial.body);expect(await counters()).toEqual(before)
   expect(await counters()).toMatchObject({docs:'1',stock:'0',money:'0',settlement:'0'})
  }finally{gate.release();await ship;await cancel}
 })
 it('returns v2 uses the source line and warehouse; posted return prevents cancellation',async()=>{
  const f=await prepare();f.body.warehouseId='w2';const shipped=await send(f)
  expect((await deliver(f)).statusCode).toBe(200)
  const returnId=randomUUID(),refund={contractVersion:2,returnId,orderId:f.orderId,items:[{saleLineId:shipped.json().items[0].saleLineId,qtyBase:'1'}]}
  const r=await call(ctx,'POST','/v1/returns',refund,`return:${returnId}`)
  expect(r.statusCode).toBe(201);expect(r.json()).toMatchObject({debtReductionMinor:'5000',cashRefundMinor:'0'})
  expect(await stockAt(ctx,'w2','p1')).toBe(-1);expect(await stockAt(ctx,'w1','p1')).toBe(0)
  const before=await counters();expect((await cancelShipmentV2(ctx,f.orderId,f.body)).json().error.code).toBe('SALE_HAS_POSTED_RETURNS')
  expect((await call(ctx,'POST','/v1/returns',refund,`return:${returnId}`)).json()).toEqual(r.json());expect(await counters()).toEqual(before)
  const sql=await ctx.pool.connect();try{await sql.query('begin');await expect(sql.query('select unpost_doc($1,$2)',[ctx.companyId,shipped.json().documentId])).rejects.toMatchObject({code:'P0010'});await sql.query('rollback')}finally{sql.release()}
  expect(await counters()).toEqual(before)
 })
})
