import { lockCustomerFinances } from './customerFinance.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type pg from 'pg'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { ApiError, Errors } from '../lib/errors.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import type { AuthContext } from '../plugins/auth.js'
import { CommercialBody, lockCommercialOrder, validateCommercial } from './orderCommercial.js'
import { canonicalSale, saleFingerprint } from './salesV2.js'

const id = z.string().regex(/^[\w:.-]{1,64}$/)
export const ShipmentBody = z.object({ contractVersion:z.literal(2),status:z.literal('shipped'),
 shipmentId:z.string().uuid().refine(v=>v===v.toLowerCase()),warehouseId:id,
 orderSnapshot:CommercialBody.shape.commercial,
}).strict()
const conflict = (code:string,message:string):never => {throw new ApiError(409,code,message)}
const unsupported = (reason:string):never => {throw new ApiError(422,'SHIPMENT_UNSUPPORTED','Условия отгрузки требуют отдельного согласованного проведения',{reason})}
const scaled = (value:string,scale:number) => {
 const [whole,fraction='']=value.split('.')
 return BigInt(whole!)*10n**BigInt(scale)+BigInt(fraction.padEnd(scale,'0'))
}
type Command = z.infer<typeof ShipmentBody> & {companyId:string;orderId:string}
const endpoint = 'POST /v1/orders/status:shipment-v2'

async function postingTransaction<T>(pool:DbPool,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
 for(let attempt=0;;attempt++){
  try{return await withTransaction(pool,async client=>{
   await client.query('set transaction isolation level serializable')
   return fn(client)
  })}catch(error){
   if(!['40001','40P01'].includes((error as {code?:string}).code??'')) throw error
   if(attempt>=2) return conflict('SHIPMENT_RETRY_REQUIRED','Повторите ту же команду отгрузки без изменения идентификаторов')
  }
 }
}

async function permanentProof(client:pg.PoolClient,command:Command,fingerprint:string,documentId:string) {
 const doc=(await client.query('select source_payload,order_id,warehouse_id,doc_type from docs where company_id=$1 and id=$2',[command.companyId,documentId])).rows[0]
 if(!doc) return null
 let saved
 try {saved=JSON.parse(doc.source_payload)} catch {return conflict('SHIPMENT_PROOF_INVALID','Постоянное доказательство отгрузки повреждено')}
 if(saved?.kind!=='shipment-v2' || saved.fingerprint!==fingerprint ||
   canonicalSale(saved.request)!==canonicalSale(command) || saleFingerprint(saved.request)!==fingerprint ||
   doc.order_id!==command.orderId || doc.warehouse_id!==command.warehouseId || doc.doc_type!=='sales_shipment')
   return conflict('SHIPMENT_IDENTITY_CONFLICT','shipmentId уже связан с другой командой или документом')
 const result=saved.result
 if(!result || result.ok!==true || result.contractVersion!==2 || result.fingerprint!==fingerprint ||
   result.documentId!==documentId || result.shipmentId!==command.shipmentId ||
   result.warehouseId!==command.warehouseId || result.order?.id!==command.orderId || result.order.status!=='shipped' ||
   typeof result.amount!=='string' || !/^\d+(\.\d{1,2})?$/.test(result.amount) || scaled(result.amount,2)!==scaled(command.orderSnapshot.total,2) ||
   !Array.isArray(result.items) || result.items.length!==command.orderSnapshot.items.length ||
   command.orderSnapshot.items.some(line=>!result.items.some((r:{sourceLineId:string;documentLineId:string;productId:string;qtyBase:string})=>
     r.sourceLineId===line.lineId && r.documentLineId===`${documentId}:${line.lineId}` && r.productId===line.productId && r.qtyBase===line.qtyBase)))
   return conflict('SHIPMENT_PROOF_INVALID','Сохранённый результат отгрузки не подтверждён')
 // A historical receipt is not a claim that the effect remains applied now.
 // Cancellation/delivery never causes a replay to repost the document.
 return result
}

export async function shipmentV2(pool:DbPool,auth:AuthContext,orderId:string,raw:unknown,key:string) {
 if(auth.role==='courier') throw Errors.forbidden('Курьеру отгрузка недоступна')
 const parsed=ShipmentBody.safeParse(raw)
 if(!parsed.success || !id.safeParse(orderId).success) throw new ApiError(422,'SHIPMENT_INVALID','Некорректная команда отгрузки')
 const input=parsed.data
 if(key!==`shipment:${input.shipmentId}`) return conflict('SHIPMENT_IDENTITY_CONFLICT','Idempotency-Key должен быть shipment:<shipmentId>')
 const command:Command={companyId:auth.companyId,orderId,...input}
 const fingerprint=saleFingerprint(command),documentId=`shipment-${input.shipmentId}`
 return postingTransaction(pool,async client=>{
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['shipment-v2',auth.companyId,input.shipmentId])])
  await lockCommercialOrder(client,auth.companyId,orderId)
  // Lookup permanent identity before even consulting the expiring HTTP receipt.
  const proof=await permanentProof(client,command,fingerprint,documentId)
  // Temporary key before order tuple: compatible with legacy cancellation and returns.
  const claim=await claimIdempotencyKey(client,{companyId:auth.companyId,key,endpoint})
  if(proof){
   if(claim.replay && canonicalSale(claim.response)!==canonicalSale(proof)) return conflict('SHIPMENT_PROOF_INVALID','Временная квитанция не совпадает с постоянной')
   if(!claim.replay) await storeIdempotentResponse(client,auth.companyId,key,200,proof)
   return {status:200,body:proof,replayed:true}
  }
  if(claim.replay) return conflict('SHIPMENT_PROOF_INVALID','Временной квитанции недостаточно для отгрузки')
  const order=(await client.query('select *,total::text as total_text from orders where company_id=$1 and id=$2 for update',[auth.companyId,orderId])).rows[0]
  if(!order || order.deleted_at) throw Errors.notFound(`Заказ ${orderId}`)
  if(!order.commercial_snapshot) return conflict('SHIPMENT_REQUIRES_COMMERCIAL_V2','Исторический заказ не имеет подтверждённого коммерческого состава')
  if(order.status==='cancelled') return conflict('SHIPMENT_ORDER_CANCELLED','Заказ отменён')
  const previous=await client.query(`select id from docs where company_id=$1 and order_id=$2
   and doc_type in ('sales_shipment','retail_receipt') limit 1`,[auth.companyId,orderId])
  if(order.stock_consumed || order.shipment_doc_id || previous.rowCount) return conflict('SHIPMENT_ALREADY_EXISTS','Заказ уже имеет отгрузку; повторное проведение запрещено')
  if(!['picking','packed'].includes(order.status)) return conflict('SHIPMENT_STATUS_CONFLICT','Заказ ещё не подготовлен к отгрузке')
  const server=CommercialBody.shape.commercial.safeParse(order.commercial_snapshot)
  if(!server.success) return conflict('SHIPMENT_ORDER_UNVERIFIABLE','Серверный коммерческий снимок повреждён')
  if(canonicalSale(server.data)!==canonicalSale(input.orderSnapshot)) return conflict('SHIPMENT_SNAPSHOT_CONFLICT','Коммерческий состав заказа изменён')
  const snapshot=server.data
  if(order.customer_id!==snapshot.customerId || order.on_credit!==snapshot.onCredit ||
    scaled(order.total_text,2)!==scaled(snapshot.total,2))
   return conflict('SHIPMENT_ORDER_UNVERIFIABLE','Поля заказа не соответствуют защищённому снимку')
  // Use only server-owned values from this point onward.
  await lockCustomerFinances(client,auth.companyId,[snapshot.customerId])
  const warehouse=await client.query('select id from warehouses where company_id=$1 and id=$2 and deleted_at is null for share',[auth.companyId,input.warehouseId])
  if(!warehouse.rowCount) throw new ApiError(422,'SHIPMENT_WAREHOUSE_UNAVAILABLE','Склад недоступен для новой отгрузки')
  try { await validateCommercial(client,auth.companyId,snapshot,false) }
  catch(error){
   if(error instanceof ApiError && error.statusCode===422) return unsupported(error.message)
   throw error
  }
  if((await client.query('select id from products where company_id=$1 and id=any($2::text[]) and marked=true limit 1',[auth.companyId,snapshot.items.map(l=>l.productId)])).rowCount)
   return unsupported('MARKING_NOT_SUPPORTED')
  if(!snapshot.onCredit || snapshot.payment.method!=='credit' || !snapshot.customerId || snapshot.customerId==='retail')
   return unsupported('ONLY_UNPAID_CUSTOMER_CREDIT_SUPPORTED')
  if(scaled(snapshot.discount.value,2)!==0n) return unsupported('DISCOUNT_REQUIRES_SUPPORTED_ALLOCATION')
  if(scaled(snapshot.total,2)<=0n) return unsupported('NON_POSITIVE_TOTAL')
  let expectedAmount=0n
  for(const line of snapshot.items){
   const gross=scaled(line.qtyBase,4)*scaled(line.price,2)
   if(gross%10000n!==0n) return unsupported('LINE_ROUNDING_NOT_EXACT')
   expectedAmount+=gross/10000n
  }
  if(expectedAmount!==scaled(snapshot.total,2)) return unsupported('POSTING_TOTAL_DIFFERS_FROM_COMMERCIAL_TOTAL')
  const payments=await client.query(`select id from docs d where d.company_id=$1
   and (d.order_id=$2 or d.id=$3) and d.doc_type in ('payment_in','payment_out','opening_settlement')
   and (d.status='posted' or exists(select 1 from money_movements m where m.company_id=d.company_id and m.doc_id=d.id)
   or exists(select 1 from settlement_movements m where m.company_id=d.company_id and m.doc_id=d.id)) limit 1`,[auth.companyId,orderId,`pay-${orderId}`])
  if(payments.rowCount) return unsupported('ORDER_HAS_PAYMENT_OR_PREPAYMENT')
  const actor=auth.memberName??auth.email??auth.userId
  await client.query(`insert into docs(company_id,id,doc_type,warehouse_id,party_kind,party_id,order_id,price_type_id,discount,"by")
   values($1,$2,'sales_shipment',$3,'customer',$4,$5,$6,0,$7)`,[auth.companyId,documentId,input.warehouseId,snapshot.customerId,orderId,snapshot.priceTypeId,actor])
  // Deterministic product lock order, but identity is the source line ID, never an array index.
  const sorted=[...snapshot.items].sort((a,b)=>a.productId<b.productId?-1:a.productId>b.productId?1:a.lineId<b.lineId?-1:a.lineId>b.lineId?1:0)
  for(const [index,line] of sorted.entries()) await client.query(`insert into doc_lines(company_id,id,doc_id,line_no,product_id,unit_id,unit_factor,qty_input,qty,price)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[auth.companyId,`${documentId}:${line.lineId}`,documentId,index,line.productId,line.unitId,line.unitFactor,line.qtyInput,line.qtyBase,line.price])
  await client.query('select post_doc($1,$2)',[auth.companyId,documentId])
  const actual=(await client.query('select amount::text from docs where company_id=$1 and id=$2',[auth.companyId,documentId])).rows[0]
  if(scaled(actual.amount,2)!==expectedAmount) return unsupported('ACTUAL_POSTING_TOTAL_MISMATCH')
  const lines=await client.query('select id,product_id,amount::text from doc_lines where company_id=$1 and doc_id=$2',[auth.companyId,documentId])
  const lineAmounts=new Map<string,string>(lines.rows.map(l=>[l.id,l.amount]))
  await client.query(`update orders set status='shipped',stock_consumed=true,shipment_doc_id=$3,
   track=coalesce(track,'[]'::jsonb)||$4::jsonb where company_id=$1 and id=$2`,[auth.companyId,orderId,documentId,
    JSON.stringify([{type:'status',to:'shipped',shipmentId:input.shipmentId,at:new Date().toISOString(),by:actor}])])
  const result={ok:true,contractVersion:2,order:{id:orderId,status:'shipped'},documentId,shipmentId:input.shipmentId,
   warehouseId:input.warehouseId,fingerprint,amount:actual.amount,cashReceivedMinor:'0',debtCreatedMinor:expectedAmount.toString(),
   items:snapshot.items.map(line=>({sourceLineId:line.lineId,documentLineId:`${documentId}:${line.lineId}`,
    saleLineId:`${documentId}:${line.lineId}`,productId:line.productId,qtyBase:line.qtyBase,
    amount:lineAmounts.get(`${documentId}:${line.lineId}`)!}))}
  await client.query('update docs set source_payload=$3 where company_id=$1 and id=$2',[auth.companyId,documentId,JSON.stringify({kind:'shipment-v2',request:command,fingerprint,result})])
  await client.query(`insert into audit(company_id,id,"by",title,section,type) values($1,$2,$3,$4,'orders','status')`,[auth.companyId,randomUUID(),actor,`Заказ ${orderId}: отгружен`])
  await storeIdempotentResponse(client,auth.companyId,key,200,result)
  return {status:200,body:result,replayed:false}
 })
}
