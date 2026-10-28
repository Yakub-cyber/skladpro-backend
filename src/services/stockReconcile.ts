import { saleV3StockIdentity, resolveSaleV3Stock } from './saleV3StockProof.js'
import { resolveShipmentWithCancellation, resolveCancellationStock } from './shipmentReversalProof.js'
import { createHash, randomUUID } from 'node:crypto'
import type { StockReconcileInput } from '../routes/stock.js'
import type { DbPool } from '../db.js'
import { ApiError, Errors } from '../lib/errors.js'
import { saleStockIdentity, resolveSaleStock } from './saleStockProof.js'
import { shipmentStockIdentity } from './shipmentStockProof.js'
import { IdempotencyKey } from '../schemas/sale.js'

export const STOCK_RECONCILE_LIMITS = { rows: 20_000, responseBytes: 4 * 1024 * 1024, timeoutMs: 5000 } as const
type Command = StockReconcileInput['commands'][number]
type Resolution = 'applied' | 'not_observed' | 'reversed' | 'conflict' | 'unverifiable'
type Document = { id: string; doc_type: string; status: string; source_payload: string | null; order_id: string | null; warehouse_id: string | null; deleted_at: unknown }
const fail = (code: string, message: string, status = 422): never => { throw new ApiError(status, code, message) }
const object = (v: unknown): Record<string, any> | null => v != null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null
const text = (v: unknown): string | null => typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : null

// Same normalization as returnsV2. No write, replay, or financial calculation is performed here.
function returnIdentity(c: Extract<Command, {kind: 'sale' | 'doc_post' | 'order_status' | 'return_v2'}>, companyId: string) {
	const p = c.payload
	if (Object.keys(p).some(k => !['contractVersion', 'returnId', 'orderId', 'items', 'reason'].includes(k))) return null
	if (p.contractVersion !== 2 || typeof p.returnId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.returnId) ||
		!text(p.orderId) || String(p.orderId).length > 64 || !Array.isArray(p.items) || !p.items.length || p.items.length > 500 ||
		(p.reason !== undefined && (typeof p.reason !== 'string' || p.reason.length > 500))) return null
	const items: { saleLineId: string; qtyBase: string }[] = []
	for (const raw of p.items) {
		const item = object(raw)
		if (!item || Object.keys(item).some(k => !['saleLineId', 'qtyBase'].includes(k)) || !text(item.saleLineId) || typeof item.qtyBase !== 'string' || !/^\d{1,7}(\.\d{1,4})?$/.test(item.qtyBase)) return null
		const [whole, fraction = ''] = item.qtyBase.split('.')
		const units = BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, '0'))
		if (units <= 0n || units > 10_000_000_000n) return null
		items.push({ saleLineId: item.saleLineId, qtyBase: `${units / 10000n}.${(units % 10000n).toString().padStart(4, '0')}` })
	}
	if (new Set(items.map(i => i.saleLineId)).size !== items.length) return null
	items.sort((a, b) => a.saleLineId < b.saleLineId ? -1 : a.saleLineId > b.saleLineId ? 1 : 0)
	const returnId = p.returnId.toLowerCase()
	const request = { contractVersion: 2, companyId, returnId, orderId: p.orderId, items, reason: p.reason ?? null }
	return { request, fingerprint: createHash('sha256').update(JSON.stringify(request)).digest('hex'), documentId: `ret-${returnId}` }
}

function reference(c: Command): { documentId: string | null; orderId: string | null; productIds: string[]; lineIds: string[] } {
	if(c.kind === 'order_cancel') return {documentId:`shipment-${c.payload.shipmentId}`,orderId:c.orderId,productIds:[],lineIds:[]}
	const shipment = c.kind === 'order_status' && c.payload.contractVersion === 2
	const p = shipment ? object(c.payload.orderSnapshot) ?? {} : c.kind === 'sale' && (c.payload.contractVersion === 2 || c.payload.contractVersion === 3) ? object(c.payload.order) ?? {} : c.payload
	const productIds: string[] = [], lineIds: string[] = []
	if (Array.isArray(p.items)) for (const raw of p.items) {
		const item = object(raw)
		if (text(item?.productId)) productIds.push(item!.productId)
		if (text(item?.saleLineId)) lineIds.push(item!.saleLineId)
	}
	if (shipment) return { documentId: text(c.payload.shipmentId) ? `shipment-${c.payload.shipmentId}` : null, orderId: text(c.commandId), productIds, lineIds }
	if (c.kind === 'doc_post') return { documentId: text(p.id), orderId: null, productIds, lineIds }
	if (c.kind === 'sale') return { documentId: text(p.id) ? `sale-${p.id}` : null, orderId: text(p.id), productIds, lineIds }
	if (c.kind === 'return_v2') return { documentId: text(p.returnId) ? `ret-${String(p.returnId).toLowerCase()}` : null, orderId: text(p.orderId), productIds, lineIds }
	return { documentId: null, orderId: text(p.orderId), productIds, lineIds }
}

export async function reconcileStock(pool: DbPool, companyId: string, input: StockReconcileInput) {
	const started = performance.now()
	const deadline = () => { if (performance.now() - started >= STOCK_RECONCILE_LIMITS.timeoutMs) fail('STOCK_RECONCILE_TIMEOUT', 'Время складской сверки превышено', 503) }
	const refs = input.commands.map(reference)
 const saleV3Refs = input.commands.flatMap((c,i) => c.kind === 'sale' && c.payload.contractVersion === 3 ? [refs[i]!] : [])
	const shipmentRefs = input.commands.flatMap((c, i) => (c.kind === 'order_status' && c.payload.contractVersion === 2 || c.kind === 'order_cancel') ? [refs[i]!] : [])
	const requested = new Set(input.productIds)
	for (const ref of refs) for (const id of ref.productIds) if (!requested.has(id)) fail('STOCK_SCOPE_INCOMPLETE', 'Товары команды не входят в productIds')
	const client = await new Promise<Awaited<ReturnType<DbPool['connect']>>>((resolve, reject) => {
		let settled = false
		const timer = setTimeout(() => {
			settled = true
			reject(new ApiError(503, 'STOCK_RECONCILE_TIMEOUT', 'Время ожидания соединения превышено'))
		}, STOCK_RECONCILE_LIMITS.timeoutMs)
		pool.connect().then(connection => {
			clearTimeout(timer)
			if (settled) connection.release()
			else { settled = true; resolve(connection) }
		}, error => { clearTimeout(timer); if (!settled) { settled = true; reject(error) } })
	})
	try {
		await client.query('begin transaction isolation level repeatable read read only')
		await client.query("set local statement_timeout = '5s'")
		await client.query("set local idle_in_transaction_session_timeout = '5s'")
		const query = async (sql: string, values: unknown[]) => {
			deadline()
			const remaining = Math.max(1, Math.floor(STOCK_RECONCILE_LIMITS.timeoutMs - (performance.now() - started)))
			await client.query(`set local statement_timeout = '${remaining}ms'`)
			const result = await client.query(sql, values)
			deadline()
			return result
		}
		// First data read establishes the MVCC snapshot. Every subsequent read uses this connection.
		const products = await query('select id from products where company_id=$1 and id=any($2::text[])', [companyId, input.productIds])
		if (products.rows.length !== input.productIds.length) throw Errors.notFound('Один из товаров компании')
		const balances = await query(`select warehouse_id as "warehouseId", product_id as "productId", qty::text as "qtyBase"
		 from stock_balances where company_id=$1 and product_id=any($2::text[])
		 order by warehouse_id, product_id limit $3`, [companyId, input.productIds, STOCK_RECONCILE_LIMITS.rows + 1])
		if (balances.rows.length > STOCK_RECONCILE_LIMITS.rows) fail('STOCK_SNAPSHOT_TOO_LARGE', 'Превышен лимит строк снимка', 413)
		const warehouses = await query(`select id, (deleted_at is null) as active from warehouses where company_id=$1
		 union select warehouse_id as id, false as active from stock_balances b where company_id=$1 and product_id=any($2::text[])
		 and not exists (select 1 from warehouses w where w.company_id=b.company_id and w.id=b.warehouse_id)
		 order by id limit $3`, [companyId, input.productIds, STOCK_RECONCILE_LIMITS.rows + 1])
		if (warehouses.rows.length > STOCK_RECONCILE_LIMITS.rows) fail('STOCK_SNAPSHOT_TOO_LARGE', 'Превышен лимит складов снимка', 413)
		const docs = await query(`select company_id::text, id, doc_type, status, posted_at::text, warehouse_id, deleted_at, party_kind, party_id, account_id, price_type_id, amount::text, discount::text,
		 case when (id=any($5::text[]) or (doc_type='sales_shipment' and id in
		 (select shipment_doc_id from orders where company_id=$1 and id=any($6::text[]))))
		 and octet_length(source_payload)<=262144 then source_payload else null end as source_payload, order_id from docs
		 where company_id=$1 and (id=any($2::text[]) or order_id=any($3::text[])) limit $4`,
		 [companyId, refs.flatMap(r => r.documentId ? [r.documentId] : []), refs.flatMap(r => r.orderId ? [r.orderId] : []), STOCK_RECONCILE_LIMITS.rows + 1,
		 input.commands.flatMap((c, i) => (c.kind === 'order_cancel' || c.kind === 'return_v2' || c.kind === 'sale' && (c.payload.contractVersion === 2 || c.payload.contractVersion === 3) || c.kind === 'order_status' && c.payload.contractVersion === 2) && refs[i]?.documentId ? [refs[i]!.documentId] : []),
		 shipmentRefs.flatMap(r => r.orderId ? [r.orderId] : [])])
		if (docs.rows.length > STOCK_RECONCILE_LIMITS.rows) fail('STOCK_SNAPSHOT_TOO_LARGE', 'Превышен лимит документов сверки', 413)
		const lines = await query(`select company_id::text, id, doc_id, product_id, line_no, note, cost_amount::text, qty::text, qty_input::text, price::text, amount::text, unit_factor::text, unit_id, deleted_at from doc_lines where company_id=$1
		 and (doc_id=any($2::text[]) or id=any($3::text[])) limit $4`,
		 [companyId, [...docs.rows.map(d => d.id), ...shipmentRefs.flatMap(r => r.documentId ? [r.documentId] : []), ...saleV3Refs.flatMap(r => r.documentId ? [r.documentId] : [])], refs.flatMap(r => r.lineIds), STOCK_RECONCILE_LIMITS.rows + 1])
		if (lines.rows.length > STOCK_RECONCILE_LIMITS.rows) fail('STOCK_SNAPSHOT_TOO_LARGE', 'Превышен лимит строк документов', 413)
		for (const line of lines.rows) if (!requested.has(line.product_id)) fail('STOCK_SCOPE_INCOMPLETE', 'Связанный документ затрагивает товар вне productIds')
		const saleRefs = input.commands.flatMap((c, i) => c.kind === 'sale' && (c.payload.contractVersion === 2 || c.payload.contractVersion === 3) ? [refs[i]!] : [])
		const effectRefs = [...saleRefs, ...shipmentRefs]
		const saleDocs = effectRefs.flatMap(r => r.documentId ? [r.documentId] : [])
		const orders = effectRefs.length ? await query(`select company_id::text, id, status, row_version::text, stock_consumed, shipment_doc_id, deleted_at,
		 case when octet_length(commercial_snapshot::text)<=262144 then commercial_snapshot else null end as commercial_snapshot
		 from orders where company_id=$1 and id=any($2::text[]) limit $3`,
			[companyId, effectRefs.flatMap(r => r.orderId ? [r.orderId] : []), STOCK_RECONCILE_LIMITS.rows + 1]) : { rows: [] }
		const shipmentIdentities = input.commands.flatMap(c => {
			const identity = c.kind === 'order_status' && c.payload.contractVersion === 2 ? shipmentStockIdentity(c.payload,companyId,c.commandId) : null
			return identity ? [identity] : []
		})
		const shipmentDocs = [...new Set(shipmentRefs.flatMap(r=>r.documentId?[r.documentId]:[]))]
		const shipmentMovementIds = [...new Set([...shipmentIdentities.flatMap(i=>i.request.orderSnapshot.items.map(l=>`${i.documentId}:${l.lineId}`)),...lines.rows.filter(l=>shipmentDocs.includes(l.doc_id)).map(l=>l.id)])]
		const lifecycle = shipmentRefs.length ? await query(`select company_id::text,command_id,order_id,operation,fingerprint,response_status,
		 case when sum(octet_length(canonical_payload::text)+octet_length(response_body::text)) over ()<=$5 then canonical_payload else null end canonical_payload,
		 case when sum(octet_length(canonical_payload::text)+octet_length(response_body::text)) over ()<=$5 then response_body else null end response_body,
		 sum(octet_length(canonical_payload::text)+octet_length(response_body::text)) over ()::text evidence_bytes
		 from order_lifecycle_commands where company_id=$1 and operation in ('cancelled','delivered')
		 and (order_id=any($2::text[]) or command_id=any($3::text[])) limit $4`,
		 [companyId,shipmentRefs.flatMap(r=>r.orderId?[r.orderId]:[]),[...shipmentIdentities.flatMap(i=>[`cancelled:${i.request.shipmentId}`,`delivered:${i.request.shipmentId}`]),...input.commands.filter(c=>c.kind==='order_cancel').flatMap(c=>[c.commandId,`delivered:${c.payload.shipmentId}`])],STOCK_RECONCILE_LIMITS.rows+1,STOCK_RECONCILE_LIMITS.responseBytes]) : {rows:[]}
		if(lifecycle.rows.length>STOCK_RECONCILE_LIMITS.rows||lifecycle.rows.some(r=>Number(r.evidence_bytes)>STOCK_RECONCILE_LIMITS.responseBytes))fail('STOCK_SNAPSHOT_TOO_LARGE','Превышен лимит lifecycle-доказательств',413)
		const movements = effectRefs.length ? await query(`select company_id::text, id, doc_id, doc_type, warehouse_id, product_id, qty::text, cost_amount::text from stock_movements where company_id=$1 and (doc_id=any($2::text[]) or id=any($4::text[])) limit $3`,
			[companyId, saleDocs, STOCK_RECONCILE_LIMITS.rows + 1,shipmentMovementIds]) : { rows: [] }
		const remainingMoney = shipmentDocs.length ? await query('select id,doc_id from money_movements where company_id=$1 and doc_id=any($2::text[]) limit $3',[companyId,shipmentDocs,STOCK_RECONCILE_LIMITS.rows+1]) : {rows:[]}
		const remainingSettlement = shipmentDocs.length ? await query('select id,doc_id from settlement_movements where company_id=$1 and (doc_id=any($2::text[]) or id=any($3::text[])) limit $4',[companyId,shipmentDocs,shipmentDocs.map(id=>`${id}:settle`),STOCK_RECONCILE_LIMITS.rows+1]) : {rows:[]}
		if(remainingMoney.rows.length>STOCK_RECONCILE_LIMITS.rows||remainingSettlement.rows.length>STOCK_RECONCILE_LIMITS.rows)fail('STOCK_SNAPSHOT_TOO_LARGE','Превышен лимит остаточных движений',413)
		if (orders.rows.length > STOCK_RECONCILE_LIMITS.rows || movements.rows.length > STOCK_RECONCILE_LIMITS.rows) fail('STOCK_SNAPSHOT_TOO_LARGE', 'Превышен лимит доказательств продажи', 413)
		for (const movement of movements.rows) if (!requested.has(movement.product_id)) fail('STOCK_SCOPE_INCOMPLETE', 'Движение продажи затрагивает товар вне productIds')
		// Compare the balances returned above against the actual ledger in this same
		// MVCC snapshot. No current/default warehouse or product mirror is consulted.
		const drift = effectRefs.length ? await query(`with ledger as (
		 select warehouse_id, product_id, sum(qty) as qty from stock_movements where company_id=$1 and product_id=any($2::text[]) group by warehouse_id,product_id
		), balance as (select warehouse_id,product_id,qty from stock_balances where company_id=$1 and product_id=any($2::text[]))
		 select coalesce(l.warehouse_id,b.warehouse_id) as warehouse_id, coalesce(l.product_id,b.product_id) as product_id
		 from ledger l full join balance b using (warehouse_id,product_id) where coalesce(l.qty,0)<>coalesce(b.qty,0) limit $3`,
			[companyId, input.productIds, STOCK_RECONCILE_LIMITS.rows + 1]) : { rows: [] }
		if (drift.rows.length > STOCK_RECONCILE_LIMITS.rows) fail('STOCK_SNAPSHOT_TOO_LARGE', 'Превышен лимит сверки реестра', 413)
		// Reversals and sale v3 validate quantity and cost across all warehouses.
		// Existing v2 applied checks remain quantity-only.
		const reversalDrift = (shipmentDocs.length || saleV3Refs.length) ? await query(`with ledger as (
		 select warehouse_id,product_id,sum(qty) qty,sum(cost_amount) cost from stock_movements where company_id=$1 and product_id=any($2::text[]) group by warehouse_id,product_id
		), balance as (select warehouse_id,product_id,qty,cost_amount cost from stock_balances where company_id=$1 and product_id=any($2::text[]))
		 select distinct coalesce(l.product_id,b.product_id) product_id from ledger l full join balance b using(warehouse_id,product_id)
		 where coalesce(l.qty,0)<>coalesce(b.qty,0) or coalesce(l.cost,0)<>coalesce(b.cost,0) limit $3`,[companyId,input.productIds,STOCK_RECONCILE_LIMITS.rows+1]) : {rows:[]}
		if(reversalDrift.rows.length>STOCK_RECONCILE_LIMITS.rows)fail('STOCK_SNAPSHOT_TOO_LARGE','Превышен лимит сверки восстановления',413)
		const inconsistentPairs = new Set<string>(drift.rows.map(r => JSON.stringify([r.warehouse_id, r.product_id])))
		const inconsistentProducts = new Set<string>(drift.rows.map(r => r.product_id))
		const orderById = new Map(orders.rows.map(o => [o.id, o]))
		const groupByDoc = (rows: any[]) => {
			const grouped = new Map<string, any[]>()
			for (const row of rows) {
				if (!grouped.has(row.doc_id)) grouped.set(row.doc_id, [])
				grouped.get(row.doc_id)!.push(row)
			}
			return grouped
		}
		const linesByDoc = groupByDoc(lines.rows), movementsByDoc = groupByDoc(movements.rows)
		const docsByOrder = new Map<string, any[]>()
		for (const doc of docs.rows) {
			if (!docsByOrder.has(doc.order_id)) docsByOrder.set(doc.order_id, [])
			docsByOrder.get(doc.order_id)!.push(doc)
		}
		const stockById = new Map(movements.rows.map(m=>[m.id,m]))
		const moneyByDoc = groupByDoc(remainingMoney.rows), settlementByDoc = groupByDoc(remainingSettlement.rows)
		const settlementById = new Map(remainingSettlement.rows.map(m=>[m.id,m]))
		const reversalInconsistent = new Set<string>(reversalDrift.rows.map(r=>r.product_id))
		const lifecycleByOrder = new Map<string,any[]>(), lifecycleById = new Map(lifecycle.rows.map(r=>[r.command_id,r]))
		for(const r of lifecycle.rows){if(!lifecycleByOrder.has(r.order_id))lifecycleByOrder.set(r.order_id,[]);lifecycleByOrder.get(r.order_id)!.push(r)}
		const sourceRows = (rows:any[],ids:string[],byId:Map<string,any>) => [...new Map([...rows,...ids.flatMap(id=>byId.has(id)?[byId.get(id)]:[])].map(r=>[r.id,r])).values()]
		const byId = new Map<string, Document>(docs.rows.map(d => [d.id, d]))
		const commands = input.commands.map((c, index) => {
			const ref = refs[index]!
			const doc = ref.documentId ? byId.get(ref.documentId) : undefined
			let resolution: Resolution = 'unverifiable'
			let reason = 'NO_PERMANENT_PAYLOAD_PROOF'
			if (c.kind === 'order_cancel') {
				const receiptIds = [c.commandId, `delivered:${c.payload.shipmentId}`]
				const lifecycleProof = [...new Map([...(lifecycleByOrder.get(c.orderId) ?? []),
					...receiptIds.flatMap(id => lifecycleById.has(id) ? [lifecycleById.get(id)] : [])].map(r => [r.command_id, r])).values()]
				;({ resolution, reason } = resolveCancellationStock(c, companyId, doc, orderById.get(c.orderId),
					docsByOrder.get(c.orderId) ?? [], linesByDoc.get(ref.documentId!) ?? [], movementsByDoc.get(ref.documentId!) ?? [], inconsistentProducts,
					lifecycleProof, sourceRows(movementsByDoc.get(ref.documentId!) ?? [], (linesByDoc.get(ref.documentId!) ?? []).map(l => l.id), stockById),
					moneyByDoc.get(ref.documentId!) ?? [], sourceRows(settlementByDoc.get(ref.documentId!) ?? [], [`${ref.documentId}:settle`], settlementById), reversalInconsistent))
			} else if (c.kind === 'order_status' && c.payload.contractVersion === 2) {
				const identity = shipmentStockIdentity(c.payload, companyId, c.commandId)
				if (!identity) reason = 'INVALID_SHIPMENT_V2_REQUEST'
				else {
					const receiptIds=[`cancelled:${identity.request.shipmentId}`,`delivered:${identity.request.shipmentId}`]
					const lifecycleProof=[...new Map([...(lifecycleByOrder.get(ref.orderId!)??[]),...receiptIds.flatMap(id=>lifecycleById.has(id)?[lifecycleById.get(id)]:[])].map(r=>[r.command_id,r])).values()]
					;({ resolution, reason } = resolveShipmentWithCancellation(c, companyId, doc, orderById.get(ref.orderId),
						docsByOrder.get(ref.orderId!) ?? [], linesByDoc.get(ref.documentId!) ?? [], movementsByDoc.get(ref.documentId!) ?? [], inconsistentProducts,
						lifecycleProof,sourceRows(movementsByDoc.get(ref.documentId!)??[],identity.request.orderSnapshot.items.map(l=>`${ref.documentId}:${l.lineId}`),stockById),
						moneyByDoc.get(ref.documentId!)??[],sourceRows(settlementByDoc.get(ref.documentId!)??[],[`${ref.documentId}:settle`],settlementById),reversalInconsistent))
				}
			} else if (c.kind === 'sale' && c.payload.contractVersion === 3) {
    const identity = saleV3StockIdentity(c.payload, companyId)
    if (!identity) reason = 'INVALID_SALE_V3_REQUEST'
    else if (c.commandId !== identity.request.body.order.id || c.idempotencyKey !== `sale-v3:${identity.request.body.order.id}`) { resolution = 'conflict'; reason = 'SALE_IDENTITY_CONFLICT' }
    else if (doc) ({resolution, reason} = resolveSaleV3Stock(c,companyId,doc,orderById.get(ref.orderId),
     linesByDoc.get(doc.id) ?? [],movementsByDoc.get(doc.id) ?? [],reversalInconsistent))
    else if (!docs.rows.some(d => d.order_id === ref.orderId) && !orderById.get(ref.orderId)?.stock_consumed && !orderById.get(ref.orderId)?.shipment_doc_id && !(linesByDoc.get(ref.documentId!)?.length) && !(movementsByDoc.get(ref.documentId!)?.length)) { resolution = 'not_observed'; reason = 'NOT_VISIBLE_IN_SNAPSHOT' }
    else reason = 'SALE_V3_DOCUMENT_MISSING'
   } else if (c.kind === 'sale' && c.payload.contractVersion === 2) {
				const identity = saleStockIdentity(c.payload, companyId)
				if (!identity) reason = 'INVALID_SALE_V2_REQUEST'
				else if (c.commandId !== identity.request.order.id || !IdempotencyKey.safeParse(c.idempotencyKey).success) { resolution = 'conflict'; reason = 'SALE_IDENTITY_CONFLICT' }
				else if (doc) ({ resolution, reason } = resolveSaleStock(c, companyId, doc, orderById.get(ref.orderId),
					linesByDoc.get(doc.id) ?? [], movementsByDoc.get(doc.id) ?? [], inconsistentPairs))
				else if (!docs.rows.some(d => d.order_id === ref.orderId)) { resolution = 'not_observed'; reason = 'NOT_VISIBLE_IN_SNAPSHOT' }
			} else if (c.kind === 'return_v2') {
				const identity = returnIdentity(c, companyId)
				if (!identity) reason = 'INVALID_COMMAND_IDENTITY'
				else if (c.commandId.toLowerCase() !== identity.request.returnId || c.idempotencyKey !== `return:${identity.request.returnId}`) { resolution = 'conflict'; reason = 'IDENTITY_MISMATCH' }
				else if (!doc) { resolution = 'not_observed'; reason = 'NOT_VISIBLE_IN_SNAPSHOT' }
				else {
					let saved: any
					try { saved = JSON.parse(doc.source_payload || 'null') } catch { /* historical payload is not proof */ }
					if (saved?.kind === 'return-v2' && typeof saved.fingerprint === 'string') {
						if (saved.fingerprint !== identity.fingerprint) { resolution = 'conflict'; reason = 'PAYLOAD_MISMATCH' }
						else if (saved.result?.documentId === identity.documentId && saved.result?.returnId === identity.request.returnId &&
							saved.result?.fingerprint === identity.fingerprint && saved.result?.orderId === identity.request.orderId &&
							saved.result?.contractVersion === 2 && saved.result?.ok === true &&
							createHash('sha256').update(JSON.stringify(saved.request) || '').digest('hex') === identity.fingerprint && doc.order_id === identity.request.orderId &&
							['sales_return', 'retail_return'].includes(doc.doc_type)) {
							resolution = doc.status === 'posted' ? 'applied' : doc.status === 'draft' ? 'reversed' : 'unverifiable'
							reason = 'PERSISTENT_RETURN_V2_PROOF'
						}
					}
				}
			} else if (c.kind !== 'order_status' && ref.documentId && !doc &&
				!(ref.orderId && docs.rows.some(d => d.order_id === ref.orderId))) {
				resolution = 'not_observed'; reason = 'NOT_VISIBLE_IN_SNAPSHOT'
			}
			return { commandId: c.commandId, resolution, effectIncluded: resolution === 'applied' ? true :
				resolution === 'not_observed' || resolution === 'reversed' ? false : null,
				documentId: doc?.id ?? null, reason }
		})
		const totals = await query(`select p.id as "productId", coalesce(sum(b.qty),0)::text as "qtyBase" from products p
		 left join stock_balances b on b.company_id=p.company_id and b.product_id=p.id
		 where p.company_id=$1 and p.id=any($2::text[]) group by p.id order by p.id`, [companyId, input.productIds])
		const response = { contractVersion: 1, requestId: input.requestId, companyId, snapshotId: randomUUID(),
			consistency: 'transaction-snapshot', coverage: { productIds: input.productIds, warehouseScope: 'all-company-warehouses', complete: true, missingBalanceMeansZero: true },
			warehouses: warehouses.rows, balances: balances.rows, totals: totals.rows, commands }
		if (Buffer.byteLength(JSON.stringify(response)) > STOCK_RECONCILE_LIMITS.responseBytes) fail('STOCK_SNAPSHOT_TOO_LARGE', 'Превышен размер ответа', 413)
		deadline()
		await client.query('commit')
		return response
	} catch (error) {
		try { await client.query('rollback') } catch { /* preserve original error */ }
		if ((error as { code?: string }).code === '57014') throw new ApiError(503, 'STOCK_RECONCILE_TIMEOUT', 'Время складской сверки превышено')
		throw error
	} finally { client.release() }
}
