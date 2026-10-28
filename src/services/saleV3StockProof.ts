import { SaleV3Body } from '../schemas/sale.js'
import { canonicalSale, saleFingerprint } from './salesV2.js'
import { saleStockIdentity } from './saleStockProof.js'
import { saleV3Amounts, saleV3Identity, saleV3LineId, saleV3Result } from './salesV3.js'

type Outcome = { resolution: 'applied' | 'conflict' | 'unverifiable'; reason: string }
const unknown = (reason: string): Outcome => ({ resolution: 'unverifiable', reason })
const conflict = (): Outcome => ({ resolution: 'conflict', reason: 'SALE_IDENTITY_CONFLICT' })
// DB numeric values are cast to text. Reject excess precision, never round evidence.
const scaled = (value: unknown, scale: number): bigint | null => {
 if (typeof value !== 'string' || value.length > 64 || !/^-?\d+(\.\d+)?$/.test(value)) return null
 const negative = value.startsWith('-'), [whole = '0', fraction = ''] = value.replace('-', '').split('.')
 if (/[1-9]/.test(fraction.slice(scale))) return null
 return (BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.slice(0, scale).padEnd(scale, '0') || '0')) * (negative ? -1n : 1n)
}

export function saleV3StockIdentity(payload: Record<string, unknown>, companyId: string) {
 if (typeof companyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) return null
 const parsed = SaleV3Body.safeParse(payload)
 if (!parsed.success) return null
 try { saleV3Amounts(parsed.data); return saleV3Identity(parsed.data, companyId) }
 catch { return null }
}

// No transaction, replay execution or DB writes: all evidence is supplied by one
// REPEATABLE READ READ ONLY stock snapshot. HTTP success alone is insufficient.
export function resolveSaleV3Stock(command: {commandId: string; idempotencyKey: string; payload: Record<string, unknown>},
 companyId: string, doc: any, order: any, lines: any[], movements: any[], inconsistentProducts: Set<string>): Outcome {
 const identity = saleV3StockIdentity(command.payload, companyId)
 if (!identity) return unknown('INVALID_SALE_V3_REQUEST')
 const o = identity.request.body.order
 if (command.commandId !== o.id || command.idempotencyKey !== `sale-v3:${o.id}`) return conflict()
 let saved: any
 try { saved = JSON.parse(doc.source_payload || 'null') } catch { return unknown('SALE_V3_PROOF_CORRUPT') }
 // A self-consistent permanent v2 identity establishes a version collision, not its current stock effect.
 // Unrecognized/malformed markers never establish identity on their own.
 if (saved?.kind === 'sale-v2') {
  const prior = saleStockIdentity({contractVersion: saved.request?.contractVersion, order: saved.request?.order}, companyId)
  return prior && canonicalSale(prior.request) === canonicalSale(saved.request) && prior.fingerprint === saved.fingerprint &&
   doc.company_id === companyId && doc.id === prior.documentId && doc.order_id === prior.request.order.id &&
   doc.warehouse_id === prior.request.order.warehouseId && ['retail_receipt','sales_shipment'].includes(doc.doc_type) &&
   saved.result?.ok === true && saved.result?.contractVersion === 2 && saved.result?.fingerprint === prior.fingerprint &&
   saved.result?.order?.id === prior.request.order.id && saved.result?.warehouseId === doc.warehouse_id && saved.result?.documentId === doc.id
   ? conflict() : unknown('NO_PERMANENT_SALE_V3_PROOF')
 }
 if (saved?.kind !== 'sale-v3' || typeof saved.fingerprint !== 'string') return unknown('NO_PERMANENT_SALE_V3_PROOF')
 const original = saleV3StockIdentity(saved.request?.body ?? {}, saved.request?.companyId)
 if (!original || canonicalSale(original.request) !== canonicalSale(saved.request) || saleFingerprint(saved.request) !== saved.fingerprint)
  return unknown('SALE_V3_PROOF_CORRUPT')
 // Validate the stored original HTTP result before allowing it to establish a conflict.
 if (saved.responseStatus !== 201 || canonicalSale(saved.result) !== canonicalSale(saleV3Result(original.request.body, original.fingerprint)))
  return unknown('SALE_V3_RESULT_INVALID')
 if (saved.request.companyId !== companyId || saved.fingerprint !== identity.fingerprint || canonicalSale(saved.request) !== canonicalSale(identity.request)) return conflict()
 const a = saleV3Amounts(identity.request.body)
 if (doc.company_id !== companyId || doc.id !== identity.documentId || doc.order_id !== o.id || doc.warehouse_id !== o.warehouseId ||
  doc.doc_type !== (a.retail ? 'retail_receipt' : 'sales_shipment')) return conflict()
 if (doc.status !== 'posted' || doc.deleted_at !== null || !doc.posted_at) return unknown('SALE_V3_REVERSAL_NOT_PROVEN')
 if (doc.account_id !== (a.credit ? null : o.payment.moneyAccountId) || doc.party_kind !== (a.retail ? null : 'customer') ||
  doc.party_id !== (a.retail ? null : o.customerId) || doc.price_type_id !== (o.priceTypeId ?? null) ||
  scaled(doc.amount,2) !== a.total || scaled(doc.discount,2) !== BigInt(o.discountMinor)) return unknown('SALE_V3_DOCUMENT_MISMATCH')
 if (!order || order.company_id !== companyId || order.id !== o.id || order.deleted_at !== null ||
  !order.stock_consumed || order.shipment_doc_id !== doc.id || order.status !== 'delivered') return unknown('SALE_V3_ORDER_LINK_INVALID')
 const expected = [...o.items].sort((x,y) => x.productId.localeCompare(y.productId) || x.lineId.localeCompare(y.lineId))
 const lineById = new Map(lines.map(l=>[l.id,l])), movementById = new Map(movements.map(m=>[m.id,m]))
 if (lines.length !== expected.length || lineById.size !== expected.length || movements.length !== expected.length || movementById.size !== expected.length)
  return unknown('SALE_V3_STOCK_LEDGER_MISMATCH')
 for (const [n,i] of expected.entries()) {
  const id = saleV3LineId(o.id,i.lineId), l = lineById.get(id), m = movementById.get(id), qty = BigInt(i.qtyBase.replace('.',''))
  const lineAmount = (qty * BigInt(i.unitPriceMinor) + 5000n) / 10000n
  const cost = scaled(l?.cost_amount,4), movementCost = scaled(m?.cost_amount,4)
  if (!l || l.company_id !== companyId || l.doc_id !== doc.id || l.product_id !== i.productId || l.line_no !== n || l.deleted_at !== null ||
   l.unit_id !== null || scaled(l.unit_factor,4) !== 10000n || scaled(l.qty,4) !== qty || scaled(l.qty_input,4) !== qty ||
   scaled(l.price,2) !== BigInt(i.unitPriceMinor) || scaled(l.amount,2) !== lineAmount ||
   !m || m.company_id !== companyId || m.doc_id !== doc.id || m.doc_type !== doc.doc_type || m.product_id !== i.productId ||
   m.warehouse_id !== o.warehouseId || scaled(m.qty,4) !== -qty ||
   cost === null || cost < 0n || movementCost !== -cost) return unknown('SALE_V3_STOCK_LEDGER_MISMATCH')
  if (inconsistentProducts.has(i.productId)) return unknown('SALE_V3_BALANCE_LEDGER_MISMATCH')
 }
 return {resolution:'applied',reason:'PERSISTENT_SALE_V3_STOCK_PROOF'}
}
