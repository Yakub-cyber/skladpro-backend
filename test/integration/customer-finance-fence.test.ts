import { randomUUID } from 'node:crypto'
import { afterEach,beforeEach,describe,expect,it } from 'vitest'
import { allowSkipIntegration,call,hasDb,setupIntegration,type Ctx } from './helpers.js'
import { legacyCustomerFixture } from './legacy-customer-fixture.js'
if(!hasDb&&!allowSkipIntegration)throw Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('legacy customer payment/adjustment fence — PostgreSQL',()=>{
 let ctx:Ctx
 beforeEach(async()=>{ctx=await setupIntegration()})
 afterEach(async()=>{await ctx?.close()})
 const code=(kind:string)=>kind==='payment'?'LEGACY_CUSTOMER_PAYMENT_REQUIRES_RECONCILIATION':'LEGACY_CUSTOMER_ADJUSTMENT_REQUIRES_RECONCILIATION'
 async function facts(){const out:Record<string,unknown>={};for(const t of ['orders','docs','doc_lines','stock_movements','stock_balances','money_movements','settlement_movements','customers','products','audit','idempotency_keys','customer_financial_fences','order_lifecycle_commands'])out[t]=(await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) r from ${t} t where company_id=$1`,[ctx.companyId])).rows[0].r;return out}
 const send=(kind:string,key=randomUUID(),customer='c1')=>call(ctx,'POST',`/v1/customers/${customer}/payments`,{kind,amount:10,direction:'increase'},key)
 async function refused(kind:string,key=randomUUID()){
  const before=await facts(),r=await send(kind,key);expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe(code(kind));expect(r.headers['idempotency-replayed']).toBeUndefined();expect(await facts()).toEqual(before)
 }
 for(const kind of ['payment','adjustment'])it(`${kind}: new/repeated requests never mutate state, documents, fences or temporary keys`,async()=>{
  const key=randomUUID();await refused(kind,key);await refused(kind,key);await refused(kind)
 })
 for(const original of ['payment','adjustment'] as const)for(const next of ['payment','adjustment'])it(`${original} old successful key repeated as ${next} is not success`,async()=>{
  const key=randomUUID();const old=await legacyCustomerFixture(ctx,{amount:10,kind:original,direction:'increase'},key)
  expect(old.statusCode).toBe(201);await refused(next,key)
  await ctx.pool.query('delete from idempotency_keys where company_id=$1 and key=$2',[ctx.companyId,key])
  await refused(next,key)
 })
 it('a successful response from another customer cannot establish proof',async()=>{
  const key=randomUUID();await legacyCustomerFixture(ctx,{amount:10},key)
  await ctx.pool.query("insert into customers(company_id,id,name) values($1,'c2','Second')",[ctx.companyId])
  const before=await facts(),r=await send('adjustment',key,'c2');expect(r.statusCode).toBe(422);expect(await facts()).toEqual(before)
 })
 for(const kind of [undefined,null,'unknown','PAYMENT','payment '])it(`invalid kind ${String(kind)} is validation error without any write`,async()=>{
  const before=await facts(),r=await call(ctx,'POST','/v1/customers/c1/payments',{amount:10,...(kind===undefined?{}:{kind})})
  expect(r.statusCode).toBe(400);expect(r.json().error.code).toBe('VALIDATION_ERROR');expect(await facts()).toEqual(before)
 })
 it('strict payload validation cannot fall through to payment or adjustment',async()=>{
  const before=await facts()
  for(const payload of [{kind:'payment',amount:10,paymentMode:'cash'},{kind:'adjustment',amount:10,contractVersion:2},{kind:'payment',amount:-1},{kind:'adjustment',amount:10,direction:'unknown'}])expect((await call(ctx,'POST','/v1/customers/c1/payments',payload)).statusCode).toBe(400)
  expect(await facts()).toEqual(before)
 })
 it('tenant isolation and all supported human roles are preserved',async()=>{
  const other=await setupIntegration()
  try{
   await other.pool.query("insert into customers(company_id,id,name) values($1,'foreign','Foreign')",[other.companyId])
   const cross=await ctx.app.inject({method:'POST',url:'/v1/customers/c1/payments',payload:{kind:'payment',amount:10},headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':other.companyId,'idempotency-key':randomUUID()}})
   expect(cross.statusCode).toBe(403);expect((await send('payment',randomUUID(),'foreign')).statusCode).toBe(404)
   for(const role of ['stock','courier','cashier','admin','manager']){
    await ctx.pool.query('update memberships set role=$3 where company_id=$1 and user_id=$2',[ctx.companyId,ctx.userId,role])
    for(const kind of ['payment','adjustment']){const before=await facts(),r=await send(kind);expect(r.statusCode).toBe(['admin','manager'].includes(role)?422:403);expect(await facts()).toEqual(before)}
   }
  }finally{await other.close()}
 })
 it('concurrent payment/adjustment requests with shared and distinct keys create nothing',async()=>{
  const key=randomUUID(),before=await facts(),rs=await Promise.all(Array.from({length:10},(_,i)=>send(i%2?'adjustment':'payment',i%3?key:randomUUID())))
  expect(rs.map(r=>r.statusCode)).toEqual(Array(10).fill(422));expect(await facts()).toEqual(before)
 })
 it('public adjustment alias, sync and document posting cannot create customer finance',async()=>{
  const before=await facts()
  expect((await call(ctx,'POST','/v1/customers/c1/adjustments',{kind:'adjustment',amount:10})).statusCode).toBe(404)
  for(const table of ['docs','money_movements','settlement_movements']){
   const r=await call(ctx,'POST','/v1/sync/push',{ops:[{table,op:'upsert',row:{id:randomUUID(),doc_type:'payment_in',party_id:'c1',amount:10}}]})
   expect(r.statusCode).toBe(207);expect(r.json().results[0].ok).toBe(false)
  }
  for(const type of ['payment_in','opening_settlement'])expect((await call(ctx,'POST','/v1/documents/post',{document:{id:randomUUID(),type,items:[{productId:'p1',qty:1,cost:10}]}})).statusCode).toBe(400)
  expect(await facts()).toEqual(before)
 })
 for(const mode of ['cash','credit'])it(`sale v3 ${mode} and returns v2 remain independent of customer fence`,async()=>{
  expect((await call(ctx,'POST','/v1/documents/post',{document:{id:randomUUID(),type:'receive',warehouseId:'w1',items:[{productId:'p1',qty:10,cost:7}]}})).statusCode).toBe(201)
  const id=randomUUID(),lineId=randomUUID(),body={contractVersion:3,order:{id,warehouseId:'w1',customerId:'c1',items:[{lineId,productId:'p1',qtyBase:'2.0000',unitPriceMinor:10000}],discountMinor:0,saleTotalMinor:20000,payment:mode==='cash'?{paymentMode:'cash',moneyAccountId:'cash',cashTendered:50000,change:30000}:{paymentMode:'credit',moneyAccountId:null,cashTendered:0,change:0}}}
  const sold=await call(ctx,'POST','/v1/sales',body,`sale-v3:${id}`);expect(sold.statusCode,sold.body).toBe(201)
  const returnId=randomUUID(),r=await call(ctx,'POST','/v1/returns',{contractVersion:2,returnId,orderId:id,items:[{saleLineId:sold.json().items[0].saleLineId,qtyBase:'1.0000'}]},`return:${returnId}`)
  expect(r.statusCode,r.body).toBe(201);expect(r.json()).toMatchObject(mode==='cash'?{cashRefundMinor:'10000',debtReductionMinor:'0'}:{cashRefundMinor:'0',debtReductionMinor:'10000'})
  const before=await facts();await refused('payment');await refused('adjustment');expect(await facts()).toEqual(before)
 })
})
