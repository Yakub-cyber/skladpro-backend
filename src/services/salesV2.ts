import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { ApiError } from '../lib/errors.js'

// Key order is irrelevant (including nested track objects); array order remains
// significant because it determines stable sale line identifiers.
export function canonicalSale(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalSale).join(',')}]`
	if (value !== null && typeof value === 'object') return `{${Object.entries(value)
		.filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
		.map(([k, v]) => `${JSON.stringify(k)}:${canonicalSale(v)}`).join(',')}}`
	return JSON.stringify(value)
}
export const saleFingerprint = (request: unknown) => createHash('sha256').update(canonicalSale(request)).digest('hex')
export function saleConflict(): never {
	throw new ApiError(409, 'SALE_IDENTITY_CONFLICT', 'Идентичность или содержимое продажи не совпадает с сохранённой командой')
}

export async function saleV2Proof(client: PoolClient, companyId: string, saleId: string, fingerprint: string) {
	const { rows } = await client.query('select source_payload, order_id, doc_type, warehouse_id from docs where company_id=$1 and id=$2', [companyId, `sale-${saleId}`])
	if (!rows.length) return null
	let saved
	try { saved = JSON.parse(rows[0].source_payload) } catch { return saleConflict() }
	if (saved?.kind !== 'sale-v2' || !saved.request?.order || saved.fingerprint !== fingerprint ||
		saleFingerprint(saved.request) !== fingerprint || saved.request.companyId !== companyId ||
		saved.request.order.id !== saleId || rows[0].order_id !== saleId ||
		!['retail_receipt', 'sales_shipment'].includes(rows[0].doc_type) ||
		rows[0].warehouse_id !== saved.request.order.warehouseId ||
		saved.result?.ok !== true || saved.result.contractVersion !== 2 ||
		saved.result.fingerprint !== fingerprint || saved.result.documentId !== `sale-${saleId}` ||
		saved.result.order?.id !== saleId || saved.result.warehouseId !== rows[0].warehouse_id) return saleConflict()
	// Historical success is replayed even if the sale has since been cancelled.
	// This never reposts a document or changes current accounting state.
	return saved.result
}
