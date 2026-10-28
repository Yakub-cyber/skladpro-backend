import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowSkipIntegration, call, hasDb, setupIntegration, type Ctx } from './helpers.js'

if(!hasDb&&!allowSkipIntegration)throw Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('legacy shipment fence — real PostgreSQL',()=>{
 let ctx:Ctx
 beforeEach(async()=>{ctx=await setupIntegration()})
 afterEach(async()=>{await ctx?.close()})
 async function facts(tables=['orders','docs','doc_lines','stock_movements','money_movements','settlement_movements','stock_balances','customers','products','audit','idempotency_keys','customer_financial_fences','order_lifecycle_commands']){
  const result:Record<string,unknown>={}
  for(const t of tables)result[t]=(await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) r from ${t} t where company_id=$1`,[ctx.companyId])).rows[0].r
  return result
 }
 const financial=()=>facts(['docs','doc_lines','stock_movements','money_movements','settlement_movements','stock_balances','customers','products','customer_financial_fences'])
 async function legacy(status='packed',retail=true,credit=false){
  const id=randomUUID();await ctx.pool.query(`insert into orders(company_id,id,status,customer_id,on_credit,items,total)
   values($1,$2,$3,$4,$5,$6::jsonb,200)`,[ctx.companyId,id,status,retail?'retail':'c1',credit,JSON.stringify([{productId:'p1',qty:2,price:100}])]);return id
 }
 // Test-only reconstruction of a pre-fence committed shipment. No production switch.
 async function historical(){
  const id=await legacy(),key=`historic:${id}`,c=await ctx.pool.connect(),doc=`ship-${id}`
  try{
   await c.query('begin')
   await c.query(`insert into docs(company_id,id,doc_type,warehouse_id,account_id,order_id) values($1,$2,'retail_receipt','w1','cash',$3)`,[ctx.companyId,doc,id])
   await c.query(`insert into doc_lines(company_id,id,doc_id,line_no,product_id,unit_factor,qty_input,qty,price) values($1,$2,$3,0,'p1',1,2,2,100)`,[ctx.companyId,`${doc}-0`,doc])
   await c.query('select post_doc($1,$2)',[ctx.companyId,doc])
   await c.query("update orders set status='shipped',stock_consumed=true,shipment_doc_id=$3 where company_id=$1 and id=$2",[ctx.companyId,id,doc])
   await c.query(`insert into idempotency_keys(company_id,key,endpoint,status,response) values($1,$2,'POST /v1/orders/status',200,$3::jsonb)`,[ctx.companyId,key,JSON.stringify({ok:true,order:{id,status:'shipped'}})])
   await c.query('commit')
  }catch(e){await c.query('rollback');throw e}finally{c.release()}
  return {id,key}
 }
 const ship=(id:string,key=randomUUID(),extra:Record<string,unknown>={})=>call(ctx,'POST',`/v1/orders/${id}/status`,{...extra,status:'shipped'},key)
 async function denied(id:string,key=randomUUID(),extra:Record<string,unknown>={},status=422){
  const before=await facts(),r=await ship(id,key,extra)
  expect(r.statusCode,r.body).toBe(status)
  if(status===422)expect(r.json().error.code).toBe('LEGACY_SHIPMENT_REQUIRES_RECONCILIATION')
  expect(await facts()).toEqual(before)
 }
 for(const status of ['picking','packed'])for(const retail of [false,true])for(const credit of [false,true])
  it(`${status}, retail=${retail}, onCredit=${credit}: no new document, keys, stock, cash or debt`,async()=>{
   const id=await legacy(status,retail,credit),key=randomUUID()
   await denied(id,key);await denied(id,key);await denied(id)
  })
 it('rejects historical temporary shipment replay and preserves all original facts',async()=>{
  const f=await historical();await denied(f.id,f.key);await denied(f.id)
  const source=(await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2',[ctx.companyId,`ship-${f.id}`])).rows[0].source_payload
  expect(source).toBeNull()
 })
 it('a shipment temporary response cannot masquerade as delivered/packed workflow replay',async()=>{
  const f=await historical(),before=await facts()
  for(const status of ['delivered','packed']){
   const r=await call(ctx,'POST',`/v1/orders/${f.id}/status`,{status},f.key)
   expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe('LEGACY_SHIPMENT_REQUIRES_RECONCILIATION')
   expect(await facts()).toEqual(before)
  }
 })
 for(const version of [undefined,1,'2',3,null])it(`version ${String(version)} cannot bypass the legacy fence`,async()=>{
  const id=await legacy(),extra=version===undefined?{}:{contractVersion:version},before=await facts(),r=await ship(id,randomUUID(),extra)
  expect(r.statusCode).toBe(422);expect(await facts()).toEqual(before)
 })
 it('fake v2 payload, extra keys and status variants cannot cause legacy posting',async()=>{
  const id=await legacy(),before=await facts()
  expect((await ship(id,randomUUID(),{contractVersion:2})).statusCode).toBe(422)
  expect((await ship(id,randomUUID(),{warehouseId:'w1',payment:{method:'cash'},stock_consumed:true})).statusCode).toBe(422)
  for(const status of ['SHIPPED','shipped ','ship','delivered']){
   const r=await call(ctx,'POST',`/v1/orders/${id}/status`,{status})
   expect(r.statusCode,r.body).toBe(400)
  }
  expect(await facts()).toEqual(before)
 })
 it('workflow new/confirmed/picking/packed changes no financial facts; shipped-to-delivered does not repost',async()=>{
  const id=await legacy('new'),before=await financial()
  for(const status of ['confirmed','picking','packed'])expect((await call(ctx,'POST',`/v1/orders/${id}/status`,{status})).statusCode).toBe(200)
  expect(await financial()).toEqual(before)
  const f=await historical(),posted=await financial(),r=await call(ctx,'POST',`/v1/orders/${f.id}/status`,{status:'delivered'})
  expect(r.statusCode,r.body).toBe(200);expect(await financial()).toEqual(posted)
  const order=(await ctx.pool.query('select status,stock_consumed from orders where company_id=$1 and id=$2',[ctx.companyId,f.id])).rows[0]
  expect(order).toEqual({status:'delivered',stock_consumed:true})
 })
 it('tenant isolation and existing RBAC remain enforced',async()=>{
  const other=await setupIntegration(),id=await legacy()
  try{
   const cross=await ctx.app.inject({method:'POST',url:`/v1/orders/${id}/status`,payload:{status:'shipped'},headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':other.companyId,'idempotency-key':randomUUID()}})
   expect(cross.statusCode).toBe(403)
   const foreignId=randomUUID();expect((await ship(foreignId)).statusCode).toBe(404)
   for(const role of ['stock','cashier','courier']){
    await ctx.pool.query('update memberships set role=$3 where company_id=$1 and user_id=$2',[ctx.companyId,ctx.userId,role])
    await denied(id,randomUUID(),{},403)
   }
   for(const role of ['admin','manager']){
    await ctx.pool.query('update memberships set role=$3 where company_id=$1 and user_id=$2',[ctx.companyId,ctx.userId,role])
    await denied(id)
   }
  }finally{await other.close()}
 })
 it('concurrent requests leave a legacy order and all accounting facts unchanged',async()=>{
  const id=await legacy(),before=await facts(),key=randomUUID()
  const r=await Promise.all(Array.from({length:8},(_,i)=>ship(id,i%2?key:randomUUID())))
  expect(r.map(x=>x.statusCode)).toEqual(Array(8).fill(422));expect(await facts()).toEqual(before)
 })
 async function protectedOrder(){
  const orderId=randomUUID(),snapshot={items:[{lineId:'source',productId:'p1',unitId:'u-sht',unitFactor:'1',qtyInput:'2',qtyBase:'2',price:'50.00'}],customerId:'c1',customerName:'Customer',no:null,priceTypeId:null,shiftId:null,
   subtotal:'100.00',total:'100.00',discount:{kind:'percent',value:'0'},rounding:'kopeck',onCredit:true,creditTerms:null,vatSummary:null,payment:{method:'credit',cashPaid:'0',cardPaid:'0',change:'0'},address:null,geo:null,courier:null,assignedTo:null,priority:false}
  expect((await call(ctx,'POST','/v1/orders',{contractVersion:2,commandId:randomUUID(),orderId,commercial:snapshot})).statusCode).toBe(201)
  expect((await call(ctx,'POST',`/v1/orders/${orderId}/status`,{status:'picking'})).statusCode).toBe(200)
  const shipment={contractVersion:2,status:'shipped',shipmentId:randomUUID(),warehouseId:'w1',orderSnapshot:snapshot}
  return {orderId,shipment}
 }
 it('v2 shipment/delivery/cancellation and their permanent historical replays remain functional',async()=>{
  const a=await protectedOrder(),url=`/v1/orders/${a.orderId}/status`,key=`shipment:${a.shipment.shipmentId}`
  const rs=await Promise.all([call(ctx,'POST',url,a.shipment,key),ship(a.orderId)])
  expect(rs.map(r=>r.statusCode)).toEqual([200,409])
  const delivery={contractVersion:2,status:'delivered',shipmentId:a.shipment.shipmentId,shipmentFingerprint:rs[0].json().fingerprint}
  const delivered=await call(ctx,'POST',url,delivery,`delivered:${delivery.shipmentId}`);expect(delivered.statusCode,delivered.body).toBe(200)
  await ctx.pool.query('delete from idempotency_keys where company_id=$1',[ctx.companyId])
  const before=await financial()
  expect((await call(ctx,'POST',url,a.shipment,key)).json()).toEqual(rs[0].json())
  expect((await call(ctx,'POST',url,delivery,`delivered:${delivery.shipmentId}`)).json()).toEqual(delivered.json());expect(await financial()).toEqual(before)
  const b=await protectedOrder(),posted=await call(ctx,'POST',`/v1/orders/${b.orderId}/status`,b.shipment,`shipment:${b.shipment.shipmentId}`)
  expect(posted.statusCode,posted.body).toBe(200)
  const cancel={contractVersion:2,status:'cancelled',shipmentId:b.shipment.shipmentId,shipmentFingerprint:posted.json().fingerprint}
  const cancelled=await call(ctx,'POST',`/v1/orders/${b.orderId}/status`,cancel,`cancelled:${cancel.shipmentId}`)
  expect(cancelled.statusCode,cancelled.body).toBe(200)
  const after=await financial();expect((await call(ctx,'POST',`/v1/orders/${b.orderId}/status`,cancel,`cancelled:${cancel.shipmentId}`)).json()).toEqual(cancelled.json());expect(await financial()).toEqual(after)
 })
 for(const mode of ['cash','credit'])it(`sale v3 ${mode} still posts once`,async()=>{
  const body={contractVersion:3,order:{id:randomUUID(),warehouseId:'w1',customerId:mode==='credit'?'c1':null,items:[{lineId:randomUUID(),productId:'p1',qtyBase:'2.0000',unitPriceMinor:10000}],discountMinor:0,saleTotalMinor:20000,
   payment:mode==='credit'?{paymentMode:'credit',moneyAccountId:null,cashTendered:0,change:0}:{paymentMode:'cash',moneyAccountId:'cash',cashTendered:50000,change:30000}}}
  const key=`sale-v3:${body.order.id}`,r=await call(ctx,'POST','/v1/sales',body,key);expect(r.statusCode,r.body).toBe(201)
  const before=await facts();expect((await call(ctx,'POST','/v1/sales',body,key)).json()).toEqual(r.json());expect(await facts()).toEqual(before)
 })
})
