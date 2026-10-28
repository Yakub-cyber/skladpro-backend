import { canonicalSale, saleFingerprint } from './salesV2.js'
import { CancellationBody, verifyCancellationReceipt } from './cancellationsV2.js'
import { resolveShipmentStock, shipmentStockIdentity } from './shipmentStockProof.js'

type Command = Parameters<typeof resolveShipmentStock>[0]
type Outcome = {resolution:'applied'|'reversed'|'conflict'|'unverifiable'|'not_observed';reason:string}
const unknown = (reason:string):Outcome => ({resolution:'unverifiable',reason})
const conflict = (reason='SHIPMENT_CANCELLATION_IDENTITY_CONFLICT'):Outcome => ({resolution:'conflict',reason})
const lineFields = ['company_id','id','doc_id','product_id','unit_id','qty','qty_input','unit_factor','price','amount','cost_amount','deleted_at']
const documentFields = ['company_id','id','doc_type','warehouse_id','order_id','party_kind','party_id','amount','discount','deleted_at','source_payload']
const projected = (row:any,fields:string[]) => Object.fromEntries(fields.map(k=>[k,row?.[k]]))

/** Interpret permanent cancellation evidence in the caller's existing MVCC snapshot.
 * The original posted-proof resolver stays unchanged and is reused for applied.
 * Receipt validation also reuses the exact pure verifier used by cancellation replay.
 */
export function resolveShipmentWithCancellation(command:Command,companyId:string,doc:any,order:any,
  relatedDocs:any[],lines:any[],movements:any[],inconsistentProducts:Set<string>,
  lifecycle:any[],remainingStock:any[],remainingMoney:any[],remainingSettlement:any[],reversalDrift:Set<string>):Outcome {
  const base = resolveShipmentStock(command,companyId,doc,order,relatedDocs,lines,movements,inconsistentProducts)
  if(base.resolution==='conflict')return base
  const identity=shipmentStockIdentity(command.payload,companyId,command.commandId)
  if(!identity)return base
  const expected=identity.request,cancelId=`cancelled:${expected.shipmentId}`
  const cancellations=lifecycle.filter(r=>r.operation==='cancelled'&&(r.order_id===expected.orderId||r.command_id===cancelId))
  if(!cancellations.length)return order?.status==='cancelled'?unknown('SHIPMENT_CANCELLATION_NOT_PROVEN'):base
  if(cancellations.length!==1)return unknown('SHIPMENT_CANCELLATION_AMBIGUOUS')
  const receipt=cancellations[0]
  let result:any
  try{
    const c=receipt.canonical_payload
    if(!c||receipt.company_id!==companyId||typeof receipt.order_id!=='string')return unknown('SHIPMENT_CANCELLATION_PROOF_INVALID')
    const {companyId:_company,orderId:_order,...body}=c
    const parsed=CancellationBody.safeParse(body)
    if(!parsed.success||receipt.command_id!==`cancelled:${parsed.data.shipmentId}`)return unknown('SHIPMENT_CANCELLATION_PROOF_INVALID')
    // Validate internally before treating a different identity as a proven conflict.
    result=verifyCancellationReceipt(receipt,companyId,receipt.order_id,parsed.data)
    if(receipt.order_id!==expected.orderId||parsed.data.shipmentId!==expected.shipmentId||
      parsed.data.shipmentFingerprint!==identity.fingerprint||result.warehouseId!==expected.warehouseId)return conflict()
  }catch{return unknown('SHIPMENT_CANCELLATION_PROOF_INVALID')}
  const manifest=result.evidence.manifest
  if(!doc||doc.status!=='void'||doc.posted_at!==null||doc.deleted_at!==null)return unknown('SHIPMENT_REVERSAL_DOCUMENT_NOT_VOID')
  if(!order||order.deleted_at!==null||order.status!=='cancelled'||order.shipment_doc_id!==doc.id||order.stock_consumed!==false||
    canonicalSale(order.commercial_snapshot)!==canonicalSale(expected.orderSnapshot)||
    typeof order.row_version!=='string'||!/^\d+$/.test(order.row_version)||BigInt(order.row_version)<BigInt(result.order.rowVersion))return unknown('SHIPMENT_REVERSAL_ORDER_LINK_INVALID')
  if(lifecycle.some(r=>r.operation==='delivered'&&(r.order_id===expected.orderId||r.command_id===`delivered:${expected.shipmentId}`)))return unknown('SHIPMENT_REVERSAL_DELIVERY_CONFLICT')
  if(relatedDocs.some(d=>d.id!==doc.id&&['sales_shipment','retail_receipt'].includes(d.doc_type)))return unknown('SHIPMENT_ORDER_LINK_AMBIGUOUS')
  if(canonicalSale(projected(doc,documentFields))!==canonicalSale(projected(manifest.document,documentFields)))return unknown('SHIPMENT_REVERSAL_SOURCE_DOCUMENT_CHANGED')
  // Shipment v2 assigns line_no in its documented product/source-ID order and
  // writes no note. IDs still establish identity; array position never does.
  const expectedOrder=[...expected.orderSnapshot.items].sort((a,b)=>a.productId<b.productId?-1:a.productId>b.productId?1:a.lineId<b.lineId?-1:a.lineId>b.lineId?1:0)
  const lineNumbers=new Map(expectedOrder.map((l,i)=>[`${doc.id}:${l.lineId}`,i]))
  if(lines.some(l=>l.line_no!==lineNumbers.get(l.id)||l.note!==null))return unknown('SHIPMENT_REVERSAL_SOURCE_LINES_CHANGED')
  const nativeLines=lines.map(l=>projected(l,lineFields)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
  if(saleFingerprint(nativeLines)!==result.evidence.sourceLinesHash||canonicalSale(nativeLines)!==canonicalSale(manifest.lines))return unknown('SHIPMENT_REVERSAL_SOURCE_LINES_CHANGED')
  if(remainingStock.length||remainingMoney.length||remainingSettlement.length)return unknown('SHIPMENT_REVERSAL_MOVEMENTS_REMAIN')
  if(expected.orderSnapshot.items.some(l=>reversalDrift.has(l.productId)))return unknown('SHIPMENT_REVERSAL_BALANCE_LEDGER_MISMATCH')
  return {resolution:'reversed',reason:'PERSISTENT_SHIPMENT_V2_CANCELLATION_PROOF'}
}

/** Validate the requested cancellation, then reuse the shipment reversal decision unchanged. */
export function resolveCancellationStock(command:Command & {orderId:string},companyId:string,doc:any,order:any,
 relatedDocs:any[],lines:any[],movements:any[],inconsistentProducts:Set<string>,lifecycle:any[],
 remainingStock:any[],remainingMoney:any[],remainingSettlement:any[],reversalDrift:Set<string>):Outcome {
 const parsed=CancellationBody.safeParse(command.payload)
 if(!parsed.success)return unknown('INVALID_CANCELLATION_V2_REQUEST')
 const body=parsed.data,key=`cancelled:${body.shipmentId}`
 if(command.commandId!==key||command.idempotencyKey!==key)return conflict()
 const candidates=lifecycle.filter(r=>r.operation==='cancelled'&&(r.command_id===key||r.order_id===command.orderId))
 if(!candidates.length)return order?.status==='cancelled'||doc?.status==='void'
  ?unknown('SHIPMENT_CANCELLATION_NOT_PROVEN'):{resolution:'not_observed',reason:'NOT_VISIBLE_IN_SNAPSHOT'}
 if(candidates.length!==1)return unknown('SHIPMENT_CANCELLATION_AMBIGUOUS')
 const receipt=candidates[0]
 let result:any
 try {
  const {companyId:_company,orderId:_order,...savedBody}=receipt.canonical_payload??{}
  const saved=CancellationBody.parse(savedBody)
  if(receipt.company_id!==companyId||receipt.command_id!==`cancelled:${saved.shipmentId}`)return unknown('SHIPMENT_CANCELLATION_PROOF_INVALID')
  result=verifyCancellationReceipt(receipt,companyId,receipt.order_id,saved)
  if(receipt.order_id!==command.orderId||canonicalSale(saved)!==canonicalSale(body))return conflict()
 }catch{return unknown('SHIPMENT_CANCELLATION_PROOF_INVALID')}
 const original=JSON.parse(result.evidence.manifest.document.source_payload)
 const {companyId:_company,orderId:_order,...payload}=original.request
 const outcome=resolveShipmentWithCancellation({commandId:command.orderId,idempotencyKey:`shipment:${body.shipmentId}`,payload},companyId,doc,order,relatedDocs,lines,movements,inconsistentProducts,lifecycle,remainingStock,remainingMoney,remainingSettlement,reversalDrift)
 return outcome.resolution==='reversed'?{resolution:'applied',reason:'PERSISTENT_CANCELLATION_V2_PROOF'}:
  outcome.resolution==='applied'?unknown('SHIPMENT_REVERSAL_NOT_PROVEN'):outcome
}
