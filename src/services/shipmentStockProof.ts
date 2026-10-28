import { ShipmentBody } from './shipmentsV2.js'
import { canonicalSale, saleFingerprint } from './salesV2.js'

type Command = { commandId: string; idempotencyKey: string; payload: Record<string, unknown> }
type Outcome = { resolution: 'applied' | 'conflict' | 'unverifiable' | 'not_observed'; reason: string }
const unknown = (reason: string): Outcome => ({ resolution: 'unverifiable', reason })
const conflict = (reason = 'SHIPMENT_IDENTITY_CONFLICT'): Outcome => ({ resolution: 'conflict', reason })
const decimal = (value: unknown): bigint | null => {
 if (typeof value !== 'string' || !/^-?\d+(\.\d{1,4})?$/.test(value)) return null
 const [whole, fraction = ''] = value.replace('-', '').split('.')
 return (BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, '0'))) * (value.startsWith('-') ? -1n : 1n)
}

// commandId supplies the URL orderId; payload remains the exact shipment HTTP body.
export function shipmentStockIdentity(payload: Record<string, unknown>, companyId: string, orderId: string) {
 const parsed = ShipmentBody.safeParse(payload)
 if (!parsed.success || typeof companyId !== 'string' || !/^[\w:.-]{1,64}$/.test(orderId)) return null
 const request = { companyId, orderId, ...parsed.data }
 return { request, fingerprint: saleFingerprint(request), documentId: `shipment-${request.shipmentId}` }
}

export function resolveShipmentStock(command: Command, companyId: string, doc: any, order: any,
 relatedDocs: any[], lines: any[], movements: any[], inconsistentProducts: Set<string>): Outcome {
 const identity = shipmentStockIdentity(command.payload, companyId, command.commandId)
 if (!identity) return unknown('INVALID_SHIPMENT_V2_REQUEST')
 const input = identity.request
 if (command.idempotencyKey !== `shipment:${input.shipmentId}`) return conflict()
 if (!doc) {
  // Another source document/marker or orphaned rows are evidence, not absence.
  const sourceDocs = relatedDocs.filter(d => ['sales_shipment', 'retail_receipt'].includes(d.doc_type))
  for (const other of sourceDocs) {
   const outcome = verifiedProof(other)
   if (outcome && outcome.request.companyId === companyId && outcome.request.orderId === input.orderId &&
     outcome.request.shipmentId !== input.shipmentId && other.id === `shipment-${outcome.request.shipmentId}` &&
     other.order_id === input.orderId && other.warehouse_id === outcome.request.warehouseId &&
     outcome.result?.ok === true && outcome.result.fingerprint === outcome.fingerprint &&
     outcome.result.documentId === other.id && outcome.result.shipmentId === outcome.request.shipmentId &&
     outcome.result.order?.id === input.orderId) return conflict()
  }
  if (sourceDocs.length || order?.shipment_doc_id || order?.stock_consumed || lines.length || movements.length ||
    ['shipped', 'delivered'].includes(order?.status)) return unknown('SHIPMENT_SOURCE_NOT_PROVEN')
  return { resolution: 'not_observed', reason: 'NOT_VISIBLE_IN_SNAPSHOT' }
 }
 const saved = verifiedProof(doc)
 if (!saved) return unknown('SHIPMENT_PROOF_CORRUPT_OR_MISSING')
 if (saved.request.companyId !== companyId || saved.fingerprint !== identity.fingerprint ||
   canonicalSale(saved.request) !== canonicalSale(input)) return conflict()
 if (doc.id !== identity.documentId || doc.order_id !== input.orderId || doc.warehouse_id !== input.warehouseId ||
   doc.doc_type !== 'sales_shipment') return conflict()
 const result = saved.result, expected = input.orderSnapshot.items
 if (!result || result.ok !== true || result.contractVersion !== 2 || result.fingerprint !== identity.fingerprint ||
   result.documentId !== doc.id || result.shipmentId !== input.shipmentId || result.warehouseId !== input.warehouseId ||
   result.order?.id !== input.orderId || result.order.status !== 'shipped' ||
   decimal(result.amount) !== decimal(input.orderSnapshot.total) || decimal(result.amount) === null ||
   !Array.isArray(result.items) || result.items.length !== expected.length) return unknown('SHIPMENT_RESULT_INVALID')
 // Initial success is not a permanent receipt of reversal. This stage never emits reversed.
 if (doc.status !== 'posted' || doc.deleted_at !== null) return unknown('SHIPMENT_REVERSAL_NOT_PROVEN')
 if (!order || order.deleted_at !== null || order.shipment_doc_id !== doc.id || !order.stock_consumed ||
   canonicalSale(order.commercial_snapshot) !== canonicalSale(input.orderSnapshot)) return unknown('SHIPMENT_ORDER_LINK_INVALID')
 if (relatedDocs.some(d => d.id !== doc.id && ['sales_shipment', 'retail_receipt'].includes(d.doc_type)))
   return unknown('SHIPMENT_ORDER_LINK_AMBIGUOUS')
 // delivered/cancelled text alone cannot establish presence or absence of stock effect.
 if (doc.party_kind !== 'customer' || doc.party_id !== input.orderSnapshot.customerId ||
   decimal(doc.amount) !== decimal(result.amount) || decimal(doc.discount) !== 0n) return conflict('SHIPMENT_DOCUMENT_CONTENT_CONFLICT')
 if (lines.length !== expected.length || movements.length !== expected.length ||
   new Set(expected.map(l => l.lineId)).size !== expected.length) return unknown('SHIPMENT_STOCK_LEDGER_MISMATCH')
 const byLine = new Map(lines.map(l => [l.id, l])), byMovement = new Map(movements.map(m => [m.id, m]))
 const bySource = new Map<string, any>(result.items.map((r: any) => [r?.sourceLineId, r]))
 if (bySource.size !== expected.length) return unknown('SHIPMENT_RESULT_INVALID')
 let total = 0n
 for (const item of expected) {
  const id = `${doc.id}:${item.lineId}`, line = byLine.get(id), movement = byMovement.get(id), receipt = bySource.get(item.lineId)
  const qty = decimal(item.qtyBase), qtyInput = decimal(item.qtyInput), factor = decimal(item.unitFactor), price = decimal(item.price)
  if (qty === null || qty <= 0n || qtyInput === null || factor === null || factor <= 0n ||
    price === null || qtyInput * factor !== qty * 10000n) return unknown('SHIPMENT_QUANTITY_UNVERIFIABLE')
  if (!line || line.deleted_at !== null) return unknown('SHIPMENT_SOURCE_LINES_MISSING')
  if (line.product_id !== item.productId || line.unit_id !== item.unitId || decimal(line.qty) !== qty ||
    decimal(line.qty_input) !== qtyInput || decimal(line.unit_factor) !== factor || decimal(line.price) !== price)
    return conflict('SHIPMENT_DOCUMENT_CONTENT_CONFLICT')
  const amount = qty * price / 10000n
  if (qty * price % 10000n !== 0n || decimal(line.amount) !== amount ||
    receipt?.documentLineId !== id || receipt.saleLineId !== id || receipt.productId !== item.productId ||
    receipt.qtyBase !== item.qtyBase || decimal(receipt.amount) !== amount) return unknown('SHIPMENT_RESULT_INVALID')
  total += amount
  if (!movement || movement.doc_id !== doc.id || movement.doc_type !== 'sales_shipment' ||
    movement.product_id !== item.productId || movement.warehouse_id !== input.warehouseId || decimal(movement.qty) !== -qty)
    return unknown('SHIPMENT_STOCK_LEDGER_MISMATCH')
  if (inconsistentProducts.has(item.productId)) return unknown('SHIPMENT_BALANCE_LEDGER_MISMATCH')
 }
 if (total !== decimal(result.amount)) return unknown('SHIPMENT_RESULT_INVALID')
 return { resolution: 'applied', reason: 'PERSISTENT_SHIPMENT_V2_STOCK_PROOF' }
}

// Corruption is not proof that the client sent a conflicting intention.
function verifiedProof(doc: any): any | null {
 let saved: any
 try { saved = JSON.parse(doc.source_payload || 'null') } catch { return null }
 if (saved?.kind !== 'shipment-v2' || !saved.request || typeof saved.fingerprint !== 'string') return null
 const { companyId, orderId, ...payload } = saved.request
 if (typeof orderId !== 'string') return null
 const original = shipmentStockIdentity(payload, companyId, orderId)
 if (!original || canonicalSale(original.request) !== canonicalSale(saved.request) ||
   original.fingerprint !== saved.fingerprint) return null
 return saved
}
