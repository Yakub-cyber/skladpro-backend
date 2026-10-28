import { SaleV2Body, IdempotencyKey } from '../schemas/sale.js'
import { canonicalSale, saleFingerprint } from './salesV2.js'
import { round4 } from '../lib/utils.js'

// A v2 reconciliation payload is the unchanged HTTP sales request envelope.
export function saleStockIdentity(payload: Record<string, unknown>, companyId: string) {
	const parsed = SaleV2Body.safeParse(payload)
	if (!parsed.success) return null
	const request = { ...parsed.data, companyId }
	return { request, fingerprint: saleFingerprint(request), documentId: `sale-${request.order.id}` }
}
type Outcome = { resolution: 'applied' | 'conflict' | 'unverifiable'; reason: string }
const unknown = (reason: string): Outcome => ({ resolution: 'unverifiable', reason })
const conflict = (): Outcome => ({ resolution: 'conflict', reason: 'SALE_IDENTITY_CONFLICT' })
const decimal = (value: string) => {
	if (!/^-?\d+(\.\d{1,4})?$/.test(value)) return null
	const [whole, fraction = ''] = value.replace('-', '').split('.')
	return (BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, '0'))) * (value.startsWith('-') ? -1n : 1n)
}

export function resolveSaleStock(command: { commandId: string; idempotencyKey: string; payload: Record<string, unknown> },
	companyId: string, doc: any, order: any, lines: any[], movements: any[], inconsistentPairs: Set<string>): Outcome {
	const identity = saleStockIdentity(command.payload, companyId)
	if (!identity) return unknown('INVALID_SALE_V2_REQUEST')
	if (command.commandId !== identity.request.order.id || !IdempotencyKey.safeParse(command.idempotencyKey).success) return conflict()
	let saved: any
	try { saved = JSON.parse(doc.source_payload || 'null') } catch { return unknown('SALE_PROOF_CORRUPT') }
	if (saved?.kind !== 'sale-v2' || typeof saved.fingerprint !== 'string' || !saved.request?.order) return unknown('NO_PERMANENT_SALE_V2_PROOF')
	const original = saleStockIdentity({ contractVersion: saved.request.contractVersion, order: saved.request.order }, saved.request.companyId)
	if (!original || canonicalSale(original.request) !== canonicalSale(saved.request) || saleFingerprint(saved.request) !== saved.fingerprint) return unknown('SALE_PROOF_CORRUPT')
	if (saved.request.companyId !== companyId || saved.fingerprint !== identity.fingerprint) return conflict()
	const input = identity.request.order, result = saved.result
	if (doc.id !== identity.documentId || doc.order_id !== input.id || doc.warehouse_id !== input.warehouseId ||
		doc.doc_type !== (!input.customerId || input.customerId === 'retail' ? 'retail_receipt' : 'sales_shipment')) return conflict()
	if (!result || result.ok !== true || result.contractVersion !== 2 || result.fingerprint !== identity.fingerprint ||
		result.documentId !== doc.id || result.warehouseId !== doc.warehouse_id || result.order?.id !== input.id) return unknown('SALE_RESULT_INVALID')
	// A saved success plus a mutable draft/void state is not a permanent reversal receipt.
	if (doc.status !== 'posted' || doc.deleted_at !== null) return unknown('SALE_REVERSAL_NOT_PROVEN')
	if (!order || order.deleted_at !== null || !order.stock_consumed || order.shipment_doc_id !== doc.id || order.status === 'cancelled') return unknown('SALE_ORDER_LINK_INVALID')
	const expected = input.items.map(item => ({ ...item, qty: round4(item.qty) })).sort((a, b) => a.productId.localeCompare(b.productId))
	if (lines.length !== expected.length || movements.length !== expected.length || !Array.isArray(result.items) || result.items.length !== expected.length) return unknown('SALE_STOCK_LEDGER_MISMATCH')
	const byLine = new Map(lines.map(line => [line.id, line])), byMovement = new Map(movements.map(m => [m.id, m]))
	for (const [i, item] of expected.entries()) {
		const id = `${doc.id}-${i}`, line = byLine.get(id), movement = byMovement.get(id), receipt = result.items[i]
		const qty = round4(item.qty * (item.unitFactor ?? 1)).toFixed(4), amount = decimal(qty)
		if (amount === null) return unknown('SALE_QUANTITY_UNVERIFIABLE')
		if (!line || line.deleted_at !== null || line.product_id !== item.productId || line.line_no !== i ||
			decimal(line.qty) !== amount || Number(line.qty_input) !== item.qty || Number(line.price) !== item.price ||
			Number(line.unit_factor) !== (item.unitFactor ?? 1) || line.unit_id !== (item.unitId ?? null) ||
			!movement || movement.product_id !== item.productId || movement.warehouse_id !== input.warehouseId ||
			movement.doc_type !== doc.doc_type || decimal(movement.qty) !== -amount ||
			receipt?.saleLineId !== id || receipt.productId !== item.productId || receipt.qtyBase !== qty) return unknown('SALE_STOCK_LEDGER_MISMATCH')
		if (inconsistentPairs.has(JSON.stringify([input.warehouseId, item.productId]))) return unknown('SALE_BALANCE_LEDGER_MISMATCH')
	}
	return { resolution: 'applied', reason: 'PERSISTENT_SALE_V2_STOCK_PROOF' }
}
