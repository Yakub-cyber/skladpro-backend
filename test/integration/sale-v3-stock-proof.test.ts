import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileStock, STOCK_RECONCILE_LIMITS } from '../../src/services/stockReconcile.js'
import type { StockReconcileInput } from '../../src/routes/stock.js'
import { allowSkipIntegration, call, hasDb, setupIntegration, type Ctx } from './helpers.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('sale v3 stock proof — one read-only PostgreSQL snapshot',()=>{
 let ctx:Ctx
 beforeEach(async()=>{ctx=await setupIntegration()})
 afterEach(async()=>{await ctx?.close()})
 const sale=(warehouseId='w1')=>({contractVersion:3,order:{id:randomUUID(),warehouseId,customerId:null as string|null,
  items:[{lineId:randomUUID(),productId:'p1',qtyBase:'2.0000',unitPriceMinor:10000}],discountMinor:0,saleTotalMinor:20000,
  payment:{paymentMode:'cash',moneyAccountId:'cash' as string|null,cashTendered:50000,change:30000}}})
 type Sale=ReturnType<typeof sale>
 const command=(payload:Sale)=>({kind:'sale' as const,commandId:payload.order.id,idempotencyKey:`sale-v3:${payload.order.id}`,payload})
 const request=(payload:Sale):StockReconcileInput=>({contractVersion:1,requestId:randomUUID(),productIds:['p1'],commands:[command(payload)]})
 const post=(payload:Sale)=>call(ctx,'POST','/v1/sales',payload,`sale-v3:${payload.order.id}`)
 const reconcile=async(payload:Sale)=>{
  const r=await call(ctx,'POST','/v1/stock/reconcile',request(payload));expect(r.statusCode,r.body).toBe(200);return r.json()
 }
 async function facts(){
  const out:Record<string,unknown>={}
  for(const t of ['orders','docs','doc_lines','stock_balances','stock_movements','money_movements','settlement_movements','customers','products','audit','idempotency_keys','order_lifecycle_commands','customer_financial_fences'])
   out[t]=(await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) r from ${t} t where company_id=$1`,[ctx.companyId])).rows[0].r
  return out
 }
 async function expected(payload:Sale,resolution:string,reason?:string){
  const before=await facts(),r=await reconcile(payload)
  expect(r.commands[0]).toMatchObject({resolution,effectIncluded:resolution==='applied'?true:resolution==='not_observed'?false:null,...(reason?{reason}:{})})
  expect(await facts()).toEqual(before);return r
 }
 async function seed(){for(const [warehouseId,qty] of [['w1',40],['w2',60]] as const){
  const r=await call(ctx,'POST','/v1/documents/post',{document:{id:randomUUID(),type:'receive',warehouseId,items:[{productId:'p1',qty,cost:7}]}})
  expect(r.statusCode,r.body).toBe(201)
 }}
 async function posted(payload=sale()){const r=await post(payload);expect(r.statusCode,r.body).toBe(201);return payload}
 async function editProof(payload:Sale,edit:(s:any)=>void){
  const id=`sale-${payload.order.id}`,s=JSON.parse((await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2',[ctx.companyId,id])).rows[0].source_payload)
  edit(s);await ctx.pool.query('update docs set source_payload=$3 where company_id=$1 and id=$2',[ctx.companyId,id,JSON.stringify(s)])
 }
 async function mutate(sql:string,params:unknown[]){
  const c=await ctx.pool.connect()
  try{await c.query('begin');await c.query("select set_config('app.ledger','1',true)");await c.query(sql,params);await c.query('commit')}
  catch(e){await c.query('rollback');throw e}finally{c.release()}
 }
 for(const mode of ['cash','credit'])for(const wh of ['w1','w2'])it(`${mode} ${wh}: applied, repeat, all warehouses, no writes`,async()=>{
  await seed();const b=sale(wh)
  if(mode==='credit'){b.order.customerId='c1';b.order.payment={paymentMode:'credit',moneyAccountId:null,cashTendered:0,change:0}}
  await posted(b)
  await ctx.pool.query('delete from idempotency_keys where company_id=$1',[ctx.companyId])
  for(let i=0;i<2;i++){
   const r=await expected(b,'applied','PERSISTENT_SALE_V3_STOCK_PROOF')
   expect(r.totals[0].qtyBase).toBe('98.0000')
   expect(r.balances.find((x:any)=>x.warehouseId===wh).qtyBase).toBe(wh==='w1'?'38.0000':'58.0000')
   expect(r.coverage).toMatchObject({complete:true,warehouseScope:'all-company-warehouses',missingBalanceMeansZero:true})
  }
 })
 it('preserves stable line IDs after sorting and exact base-unit fractional prices/rounding',async()=>{
  const b=sale();b.order.items=[{...b.order.items[0]!,lineId:'ffffffff-ffff-4fff-8fff-ffffffffffff',qtyBase:'0.5000',unitPriceMinor:1},
   {...b.order.items[0]!,lineId:'00000000-0000-4000-8000-000000000000',qtyBase:'0.5000',unitPriceMinor:1}]
  b.order.discountMinor=1;b.order.saleTotalMinor=1;b.order.payment.cashTendered=1;b.order.payment.change=0
  await posted(b);await expected(b,'applied')
 })
 it('not_observed is read-only and does not create/retry a sale',async()=>{const b=sale();await expected(b,'not_observed');await expected(b,'not_observed')})
 for(const bad of ['commandId','key'])it(`rejects mismatched ${bad} before proof lookup`,async()=>{
  const b=sale(),r=request(b)
  if(bad==='commandId')r.commands[0]!.commandId='other'
  else r.commands[0]!.idempotencyKey='sale-v3:other'
  const before=await facts(),response=await call(ctx,'POST','/v1/stock/reconcile',r)
  expect(response.statusCode).toBe(200);expect(response.json().commands[0].resolution).toBe('conflict');expect(await facts()).toEqual(before)
 })
 for(const field of ['warehouse','order','line','price'])it(`${field} request mismatch is conflict`,async()=>{
  const b=await posted(),changed=structuredClone(b)
  if(field==='warehouse')changed.order.warehouseId='w2'
  if(field==='order')changed.order.id=randomUUID()
  if(field==='line')changed.order.items[0]!.lineId=randomUUID()
  if(field==='price'){changed.order.items[0]!.unitPriceMinor=11000;changed.order.saleTotalMinor=22000;changed.order.payment.change=28000}
  const r=request(changed);if(field==='order')r.commands[0]!.commandId=b.order.id
  const before=await facts(),response=await call(ctx,'POST','/v1/stock/reconcile',r)
  expect(response.statusCode,response.body).toBe(200);expect(response.json().commands[0].resolution).toBe('conflict');expect(await facts()).toEqual(before)
 })
 for(const defect of ['json','missing','hash','request','result','response-status','company-missing'])it(`damaged ${defect} proof stays unverifiable`,async()=>{
  const b=await posted()
  if(defect==='json'||defect==='missing')await ctx.pool.query('update docs set source_payload=$3 where company_id=$1 and id=$2',[ctx.companyId,`sale-${b.order.id}`,defect==='json'?'{':null])
  else await editProof(b,s=>{
   if(defect==='hash')s.fingerprint='0'.repeat(64)
   if(defect==='request')s.request.body.order.warehouseId='w2'
   if(defect==='result')s.result.cashReceivedMinor++
   if(defect==='response-status')s.responseStatus=200
   if(defect==='company-missing')delete s.request.companyId
  })
  await expected(b,'unverifiable')
 })
 for(const state of ['draft','unposted','deleted'])it(`${state}: historical HTTP success never proves current applied or reversed`,async()=>{
  const b=await posted()
  if(state==='unposted')await ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,`sale-${b.order.id}`])
  else await ctx.pool.query(`update docs set ${state==='draft'?"status='draft'":"deleted_at=now()"} where company_id=$1 and id=$2`,[ctx.companyId,`sale-${b.order.id}`])
  const replay=await post(b);expect(replay.statusCode,replay.body).toBe(201);expect(replay.headers['idempotency-replayed']).toBe('true')
  await expected(b,'unverifiable','SALE_V3_REVERSAL_NOT_PROVEN')
 })
 it('missing document with an observed order marker is unverifiable rather than not_observed',async()=>{
  const b=await posted()
  await ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,`sale-${b.order.id}`])
  await ctx.pool.query('delete from docs where company_id=$1 and id=$2',[ctx.companyId,`sale-${b.order.id}`])
  await expected(b,'unverifiable','SALE_V3_DOCUMENT_MISSING')
 })
 for(const orphan of ['line','movement'])it(`orphan ${orphan} evidence is not not_observed after document/order loss`,async()=>{
  const b=await posted(),id=`sale-${b.order.id}`
  if(orphan==='line') await ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,id])
  else await ctx.pool.query('delete from doc_lines where company_id=$1 and doc_id=$2',[ctx.companyId,id])
  await ctx.pool.query('delete from docs where company_id=$1 and id=$2',[ctx.companyId,id])
  await ctx.pool.query('delete from orders where company_id=$1 and id=$2',[ctx.companyId,b.order.id])
  await expected(b,'unverifiable','SALE_V3_DOCUMENT_MISSING')
 })
 for(const field of ['warehouse','order'])it(`document ${field} link mismatch is conflict`,async()=>{
  const b=await posted();await ctx.pool.query(`update docs set ${field==='warehouse'?'warehouse_id':'order_id'}=$3 where company_id=$1 and id=$2`,[ctx.companyId,`sale-${b.order.id}`,field==='warehouse'?'w2':'different'])
  await expected(b,'conflict')
 })
 for(const defect of ['line-qty','line-price','line-amount','line-cost','line-id','line-input','line-factor','movement-qty','movement-cost','movement-id','movement-warehouse','missing-movement','doc-amount','order-link'])it(`${defect}: no false applied`,async()=>{
  const b=await posted(),docId=`sale-${b.order.id}`
  if(defect.startsWith('line-')){
   const assignments:Record<string,string>={'line-qty':'qty=qty+1','line-price':'price=price+0.01','line-amount':'amount=amount+0.01','line-cost':'cost_amount=cost_amount+1','line-id':"id=id||':bad'",'line-input':'qty_input=qty_input+1','line-factor':'unit_factor=2'}
   await mutate(`update doc_lines set ${assignments[defect]} where company_id=$1 and doc_id=$2`,[ctx.companyId,docId])
  }else if(defect.startsWith('movement-')||defect==='missing-movement'){
   const assignments:Record<string,string>={'movement-qty':'qty=qty-1','movement-cost':'cost_amount=cost_amount-1','movement-id':"id=id||':bad'",'movement-warehouse':"warehouse_id='w2'"}
   await mutate(defect==='missing-movement'?'delete from stock_movements where company_id=$1 and doc_id=$2':`update stock_movements set ${assignments[defect]} where company_id=$1 and doc_id=$2`,[ctx.companyId,docId])
  }else if(defect==='doc-amount')await mutate('update docs set amount=amount+0.01 where company_id=$1 and id=$2',[ctx.companyId,docId])
  else await ctx.pool.query('update orders set shipment_doc_id=null where company_id=$1 and id=$2',[ctx.companyId,b.order.id])
  await expected(b,'unverifiable')
 })
 it.each(['qty','cost_amount'])('other (archived) warehouse %s drift blocks applied for the affected product',async field=>{
  await seed();const b=await posted()
  await ctx.pool.query("update warehouses set deleted_at=now() where company_id=$1 and id='w2'",[ctx.companyId])
  const r=await expected(b,'applied');expect(r.warehouses.find((w:any)=>w.id==='w2').active).toBe(false)
  await mutate(`update stock_balances set ${field}=${field}+1 where company_id=$1 and warehouse_id='w2' and product_id='p1'`,[ctx.companyId])
  await expected(b,'unverifiable','SALE_V3_BALANCE_LEDGER_MISMATCH')
 })
 it('v2/v3 identity collision never confirms the wrong version',async()=>{
  const b=sale(),v2={contractVersion:2,order:{id:b.order.id,warehouseId:'w1',items:[{productId:'p1',qty:2,price:100}]}}
  expect((await call(ctx,'POST','/v1/sales',v2,`sale-${b.order.id}`)).statusCode).toBe(201)
  await expected(b,'conflict')
  const newer=await posted(),req=request(newer)
  req.commands=[{kind:'sale',commandId:newer.order.id,idempotencyKey:`sale-${newer.order.id}`,payload:{...v2,order:{...v2.order,id:newer.order.id}}}]
  const r=await call(ctx,'POST','/v1/stock/reconcile',req);expect(r.statusCode).toBe(200);expect(r.json().commands[0].resolution).toBe('unverifiable')
 })
 it('tenant isolation applies even when sale/product/account IDs match',async()=>{
  const other=await setupIntegration(),b=sale()
  try{
   expect((await call(other,'POST','/v1/sales',b,`sale-v3:${b.order.id}`)).statusCode).toBe(201)
   await expected(b,'not_observed')
   const denied=await ctx.app.inject({method:'POST',url:'/v1/stock/reconcile',payload:request(b),headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':other.companyId}})
   expect([403,404]).toContain(denied.statusCode)
   await posted(b);await expected(b,'applied')
  }finally{await other.close()}
 })
 it('lost HTTP response after commit is reconciled without replay execution or new movements',async()=>{
  ctx.app.addHook('onSend',async(req,reply,payload)=>{if(req.headers['x-drop']==='1')reply.raw.destroy();return payload})
  const b=sale(),address=await ctx.app.listen({host:'127.0.0.1',port:0})
  const error=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{
   const req=httpRequest(`${address}/v1/sales`,{method:'POST',headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':ctx.companyId,'idempotency-key':`sale-v3:${b.order.id}`,'content-type':'application/json','x-drop':'1'}},r=>{r.resume();reject(new Error('Expected lost response'))})
   req.on('error',resolve);req.end(JSON.stringify(b))
  })
  expect(error.code).toBe('ECONNRESET');await expected(b,'applied')
 })
 it('commit between balances and proof reads never creates a mixed snapshot',async()=>{
  await seed();const b=sale(),client=await ctx.pool.connect();let postedDuringRead=false
  const query=async(sql:string,values?:any[])=>{
   const result=await client.query(sql,values)
   if(sql.startsWith('select warehouse_id as')&&!postedDuringRead){postedDuringRead=true;await posted(b)}
   return result
  }
  try{
   const before=await reconcileStock({...ctx.pool,connect:async()=>({query,release:()=>{}})} as any,ctx.companyId,request(b))
   expect(postedDuringRead).toBe(true);expect(before.totals[0]!.qtyBase).toBe('100.0000');expect(before.commands[0]!.resolution).toBe('not_observed')
   const after=await expected(b,'applied');expect(after.totals[0].qtyBase).toBe('98.0000')
  }finally{client.release()}
 })
 it('retains public request limits, scope checks and command ID uniqueness',async()=>{
  const b=sale(),before=await facts()
  expect(STOCK_RECONCILE_LIMITS).toEqual({rows:20000,responseBytes:4194304,timeoutMs:5000})
  const duplicate=request(b);duplicate.commands.push({...duplicate.commands[0]!,kind:'doc_post'})
  expect((await call(ctx,'POST','/v1/stock/reconcile',duplicate)).statusCode).toBe(400)
  const many=request(b);many.commands=Array.from({length:501},(_,i)=>({...command(b),commandId:`sale-${i}`}))
  expect((await call(ctx,'POST','/v1/stock/reconcile',many)).statusCode).toBe(400)
  expect((await call(ctx,'POST','/v1/stock/reconcile',{...request(b),productIds:Array.from({length:501},(_,i)=>`p${i}`)})).statusCode).toBe(400)
  const outside=structuredClone(b);outside.order.items[0]!.productId='outside'
  expect((await call(ctx,'POST','/v1/stock/reconcile',request(outside))).statusCode).toBe(422)
  expect((await call(ctx,'POST','/v1/stock/reconcile',{...request(b),padding:'x'.repeat(270000)})).statusCode).toBe(413)
  expect(await facts()).toEqual(before)
 })
 it('mixed snapshot keeps v2/v3 sales, shipment applied and cancellation proof semantics',async()=>{
  await seed();const newer=await posted(),oldId=randomUUID()
  const old={contractVersion:2,order:{id:oldId,warehouseId:'w1',items:[{productId:'p1',qty:2,price:100}]}}
  expect((await call(ctx,'POST','/v1/sales',old,`sale-${oldId}`)).statusCode).toBe(201)
  async function shipment(){
   const orderId=randomUUID(),shipmentId=randomUUID()
   const commercial={items:[{lineId:'source',productId:'p1',unitId:'u-sht',unitFactor:'1',qtyInput:'2',qtyBase:'2',price:'50.00'}],
    customerId:'c1',customerName:'Customer',no:null,priceTypeId:null,shiftId:null,subtotal:'100.00',total:'100.00',discount:{kind:'percent',value:'0'},
    rounding:'kopeck',onCredit:true,creditTerms:null,vatSummary:null,payment:{method:'credit',cashPaid:'0',cardPaid:'0',change:'0'},address:null,geo:null,courier:null,assignedTo:null,priority:false}
   expect((await call(ctx,'POST','/v1/orders',{contractVersion:2,commandId:randomUUID(),orderId,commercial})).statusCode).toBe(201)
   expect((await call(ctx,'POST',`/v1/orders/${orderId}/status`,{status:'picking'})).statusCode).toBe(200)
   const payload={contractVersion:2,status:'shipped',shipmentId,warehouseId:'w1',orderSnapshot:commercial}
   const r=await call(ctx,'POST',`/v1/orders/${orderId}/status`,payload,`shipment:${shipmentId}`);expect(r.statusCode,r.body).toBe(200)
   return {orderId,payload,fingerprint:r.json().fingerprint}
  }
  const active=await shipment(),cancelled=await shipment()
  const cancellation={contractVersion:2 as const,status:'cancelled' as const,shipmentId:cancelled.payload.shipmentId,shipmentFingerprint:cancelled.fingerprint}
  const key=`cancelled:${cancellation.shipmentId}`
  expect((await call(ctx,'POST',`/v1/orders/${cancelled.orderId}/status`,cancellation,key)).statusCode).toBe(200)
  const req=request(newer)
  req.commands.push({kind:'sale',commandId:oldId,idempotencyKey:`sale-${oldId}`,payload:old},
   {kind:'order_status',commandId:active.orderId,idempotencyKey:`shipment:${active.payload.shipmentId}`,payload:active.payload},
   {kind:'order_status',commandId:cancelled.orderId,idempotencyKey:`shipment:${cancelled.payload.shipmentId}`,payload:cancelled.payload},
   {kind:'order_cancel',commandId:key,orderId:cancelled.orderId,idempotencyKey:key,payload:cancellation})
  const before=await facts(),r=await call(ctx,'POST','/v1/stock/reconcile',req)
  expect(r.statusCode,r.body).toBe(200);expect(r.json().commands.map((c:any)=>c.resolution)).toEqual(['applied','applied','applied','reversed','applied'])
  expect(r.json().totals[0].qtyBase).toBe('94.0000');expect(await facts()).toEqual(before)
 })
})
