/** Historical finance fixture ONLY. Not an HTTP route, not a production bypass.
 * Reproduces the former payment/opening_settlement transaction on synthetic PG
 * data. Barrier tests also exercise the shared production lock helper directly.
 */
import { randomUUID } from 'node:crypto'
import { withTransaction, type DbPool } from '../../src/db.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../../src/lib/idempotency.js'
import { lockCustomerFinances } from '../../src/services/customerFinance.js'
import type { Ctx } from './helpers.js'

export async function legacyCustomerFixture(ctx:Ctx,body:{amount:number;kind?:'payment'|'adjustment';direction?:'increase'|'decrease';note?:string},
 key=randomUUID(),customerId='c1',pool:DbPool=ctx.pool) {
 const outcome=await withTransaction(pool,async client=>{
  const claim=await claimIdempotencyKey(client,{companyId:ctx.companyId,key,endpoint:'POST /v1/customers/payments'})
  if(claim.replay)return {status:claim.status,body:claim.response,replayed:true}
  await lockCustomerFinances(client,ctx.companyId,[customerId])
  const customer=(await client.query('select id,name,balance from customers where company_id=$1 and id=$2 and deleted_at is null',[ctx.companyId,customerId])).rows[0]
  if(!customer)throw Error('Missing synthetic fixture customer')
  const kind=body.kind??'payment',direction=body.direction??'decrease',before=Number(customer.balance)
  const docId=`${kind==='payment'?'pay':'adj'}-${customerId}-${Date.now()}`
  if(kind==='payment'){
   const account=(await client.query('select id from money_accounts where company_id=$1 and deleted_at is null order by is_default desc,id limit 1',[ctx.companyId])).rows[0]
   await client.query(`insert into docs(company_id,id,doc_type,party_kind,party_id,account_id,amount,note,"by") values($1,$2,'payment_in','customer',$3,$4,$5,$6,'Historical fixture')`,[ctx.companyId,docId,customerId,account.id,body.amount,body.note??null])
  }else await client.query(`insert into docs(company_id,id,doc_type,party_kind,party_id,amount,note,"by") values($1,$2,'opening_settlement','customer',$3,$4,$5,'Historical fixture')`,[ctx.companyId,docId,customerId,direction==='increase'?body.amount:-body.amount,body.note??null])
  await client.query('select post_doc($1,$2)',[ctx.companyId,docId])
  const after=Number((await client.query('select balance from customers where company_id=$1 and id=$2',[ctx.companyId,customerId])).rows[0].balance)
  const response={ok:true,customer:{id:customerId,balanceBefore:before,balanceAfter:after,applied:after-before}}
  await client.query(`insert into audit(company_id,id,"by",title,section,type) values($1,$2,'Historical fixture','Historical finance fixture','finance',$3)`,[ctx.companyId,randomUUID(),kind])
  await storeIdempotentResponse(client,ctx.companyId,key,201,response)
  return {status:201,body:response,replayed:false}
 })
 return {statusCode:outcome.status,body:JSON.stringify(outcome.body),json:()=>outcome.body as any,headers:outcome.replayed?{'idempotency-replayed':'true'}:{}}
}
