import { lockCustomerFinances } from './customerFinance.js'
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { withTransaction, type DbPool } from '../db.js'
import { ApiError, Errors } from '../lib/errors.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import type { AuthContext } from '../plugins/auth.js'

const Body = z.object({
	contractVersion: z.literal(2),
	returnId: z.string().uuid().transform(v => v.toLowerCase()),
	orderId: z.string().min(1).max(64),
	items: z.array(z.object({
		saleLineId: z.string().min(1).max(128),
		qtyBase: z.string().regex(/^\d{1,7}(\.\d{1,4})?$/),
	}).strict()).min(1).max(500),
	reason: z.string().max(500).optional(),
}).strict()

const reconciliation = (reason: string): never => {
	throw new ApiError(422, 'FINANCIAL_RECONCILIATION_REQUIRED', 'Возврат требует сверки', { reason })
}
const conflict = (): never => {
	throw new ApiError(409, 'RETURN_ID_CONFLICT', 'Идентификатор возврата уже связан с другой командой')
}

// All arithmetic stays in integer cents / ten-thousandths, including DB numerics.
function units(value: string, decimals: number): bigint {
	if (!/^\d+(\.\d+)?$/.test(value)) return reconciliation('INVALID_SOURCE_NUMBER')
	const [whole = '0', fraction = ''] = value.split('.')
	const tail = fraction.slice(decimals)
	if (/[1-9]/.test(tail)) return reconciliation('UNSUPPORTED_SOURCE_PRECISION')
	return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0') || '0')
}
const round = (n: bigint, d: bigint) => (2n * n + d) / (2n * d)
const signedUnits = (value: string, decimals: number) => value.startsWith('-') ? -units(value.slice(1), decimals) : units(value, decimals)
function fixed(n: bigint, decimals: number): string {
	const scale = 10n ** BigInt(decimals)
	return `${n / scale}.${(n % scale).toString().padStart(decimals, '0')}`
}

type LineResult = { saleLineId: string; productId: string; qtyBase: string; amountMinor: string; costAmount: string }
type Result = {
	ok: true; contractVersion: 2; returnId: string; orderId: string; documentId: string;
	paymentDocumentId: string | null; fingerprint: string; items: LineResult[];
	amountMinor: string; cashRefundMinor: string; debtReductionMinor: string;
	accountId: string | null; fullyReturned: boolean;
}
type Saved = {
	kind: 'return-v2'; request: unknown; fingerprint: string; result: Result;
}
type SourceLine = { id: string; product_id: string; qty: string; amount: string; cost_amount: string | null; marked: boolean }

async function transactionRetry<T>(pool: DbPool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await withTransaction(pool, async client => {
				// Also protects an unpaid-credit decision from concurrent customer payments.
				await client.query('set transaction isolation level serializable')
				return fn(client)
			})
		} catch (error) {
			const code = (error as { code?: string }).code
			if (code !== '40001' && code !== '40P01') throw error
			if (attempt >= 2) throw new ApiError(409, 'RETURN_RETRY_REQUIRED', 'Повторите ту же команду возврата')
		}
	}
}

export async function returnV2(pool: DbPool, auth: AuthContext, raw: unknown, key: string) {
	const parsed = Body.safeParse(raw)
	if (!parsed.success) throw Errors.validation(parsed.error.issues)
	const input = parsed.data
	if (key !== `return:${input.returnId}`) {
		if (key.startsWith('return:')) return conflict()
		throw Errors.validation([{ message: 'Idempotency-Key должен быть return:<returnId>' }])
	}
	const seen = new Set<string>()
	const items = input.items.map(item => {
		if (seen.has(item.saleLineId)) throw Errors.validation([{ message: 'saleLineId повторяется' }])
		seen.add(item.saleLineId)
		const qty = units(item.qtyBase, 4)
		if (qty <= 0n || qty > 10_000_000_000n) throw Errors.validation([{ message: 'qtyBase вне допустимого диапазона' }])
		return { saleLineId: item.saleLineId, qtyBase: fixed(qty, 4) }
	}).sort((a, b) => a.saleLineId < b.saleLineId ? -1 : 1)
	const command = { contractVersion: 2, companyId: auth.companyId, returnId: input.returnId,
		orderId: input.orderId, items, reason: input.reason ?? null }
	const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex')
	const documentId = `ret-${input.returnId}`
	return transactionRetry(pool, async client => {
		const company = auth.companyId
		const claim = await claimIdempotencyKey(client, { companyId: company, key, endpoint: 'POST /v1/returns' })
		// A document PK is permanent; never rely on the expiring idempotency table for identity.
		const existing = await client.query('select source_payload, status from docs where company_id=$1 and id=$2', [company, documentId])
		if (existing.rows[0]) {
			let saved: Saved
			try { saved = JSON.parse(existing.rows[0].source_payload) as Saved } catch { return conflict() }
			if (saved?.kind !== 'return-v2' || saved.fingerprint !== fingerprint) return conflict()
			if (existing.rows[0].status !== 'posted' || !saved.result) return reconciliation('RETURN_DOCUMENT_CHANGED')
			await storeIdempotentResponse(client, company, key, 201, saved.result)
			return { status: 201, body: saved.result, replayed: true }
		}
		if (claim.replay) return conflict()
		const { rows } = await client.query(
			`select *, total::text as total_text from orders where company_id=$1 and id=$2 for update`, [company, input.orderId])
		const order = rows[0]
		if (!order || order.deleted_at) throw Errors.notFound(`Заказ ${input.orderId}`)
		if (order.status === 'cancelled') throw Errors.saleNotPosted()
		if (!order.stock_consumed || order.status !== 'delivered' || !order.shipment_doc_id) return reconciliation('SALE_NOT_FINAL')
		await lockCustomerFinances(client, company, [order.customer_id === 'retail' ? null : order.customer_id])
		const sourceRows = await client.query(
			`select *, amount::text as amount_text, discount::text as discount_text from docs
			 where company_id=$1 and id=$2 for share`, [company, order.shipment_doc_id])
		const source = sourceRows.rows[0]
		if (source && source.status !== 'posted') throw Errors.saleNotPosted()
		if (!source || source.deleted_at || source.status !== 'posted' || source.order_id !== input.orderId ||
			!['retail_receipt', 'sales_shipment'].includes(source.doc_type)) return reconciliation('SOURCE_DOCUMENT')
		const total = units(source.amount_text, 2)
		if (units(order.total_text, 2) !== total || total <= 0n) return reconciliation('SALE_TOTAL_MISMATCH')
		const saleLines = await client.query<SourceLine>(
			`select l.id, l.product_id, l.qty::text, l.amount::text, l.cost_amount::text, p.marked
			 from doc_lines l join products p on p.company_id=l.company_id and p.id=l.product_id
			 where l.company_id=$1 and l.doc_id=$2 and l.deleted_at is null order by l.id`, [company, source.id])
		if (!saleLines.rows.length) return reconciliation('SOURCE_LINES')
		const gross = saleLines.rows.reduce((sum, line) => sum + units(line.amount, 2), 0n)
		if (gross - units(source.discount_text, 2) !== total || gross <= 0n) return reconciliation('SOURCE_DISCOUNT')
		const allocations = saleLines.rows.map(line => ({
			...line, sold: units(line.qty, 4), net: total * units(line.amount, 2) / gross,
			remainder: total * units(line.amount, 2) % gross,
			cost: line.cost_amount === null ? reconciliation('SOURCE_COST') : units(line.cost_amount, 4),
		}))
		let pennies = total - allocations.reduce((sum, line) => sum + line.net, 0n)
		for (const line of [...allocations].sort((a, b) => a.remainder === b.remainder ?
			(a.id < b.id ? -1 : 1) : a.remainder > b.remainder ? -1 : 1)) {
			if (pennies-- > 0n) line.net++
		}
		const history = order.returns as Array<{ contractVersion?: number; documentId?: string; returnId?: string; items?: LineResult[] }>
		if (!Array.isArray(history) || history.some(h => h.contractVersion !== 2 || !h.documentId)) return reconciliation('LEGACY_RETURN_HISTORY')
		const previous = new Map<string, { qty: bigint; amount: bigint; cost: bigint }>()
		const historyDocs = history.map(h => h.documentId!)
		const priorDocs = await client.query(
			`select id, source_payload, status, deleted_at from docs where company_id=$1 and order_id=$2
			 and doc_type in ('sales_return','retail_return')`, [company, input.orderId])
		if (priorDocs.rows.length !== history.length) return reconciliation('RETURN_HISTORY_MISMATCH')
		let previousMoney = 0n
		for (const prior of priorDocs.rows) {
			let saved: Saved
			try { saved = JSON.parse(prior.source_payload) as Saved } catch { return reconciliation('RETURN_HISTORY_INVALID') }
			if (!historyDocs.includes(prior.id) || prior.status !== 'posted' || prior.deleted_at || saved?.kind !== 'return-v2') return reconciliation('RETURN_HISTORY_INVALID')
			const money = await client.query(
				`select coalesce(sum(amount),0)::text as amount from money_movements where company_id=$1 and doc_id=any($2::text[])`,
				[company, [prior.id, saved.result.paymentDocumentId].filter(Boolean)])
			if (signedUnits(money.rows[0].amount, 2) !== -BigInt(saved.result.cashRefundMinor)) return reconciliation('RETURN_MONEY_LEDGER')
			previousMoney += BigInt(saved.result.cashRefundMinor)
			for (const line of saved.result.items) {
				const p = previous.get(line.saleLineId) ?? { qty: 0n, amount: 0n, cost: 0n }
				previous.set(line.saleLineId, { qty: p.qty + units(line.qtyBase, 4), amount: p.amount + BigInt(line.amountMinor), cost: p.cost + units(line.costAmount, 4) })
			}
		}
		// Verify the original ledger, not mutable order flags or the current default account.
		const sourceStock = await client.query(
			`select id, product_id, qty::text, cost_amount::text, warehouse_id from stock_movements where company_id=$1 and doc_id=$2`, [company, source.id])
		if (sourceStock.rows.length !== allocations.length || allocations.some(line => {
			const movement = sourceStock.rows.find(m => m.id === line.id)
			return !movement || movement.product_id !== line.product_id || movement.warehouse_id !== source.warehouse_id ||
				signedUnits(movement.qty, 4) !== -line.sold || signedUnits(movement.cost_amount, 4) !== -line.cost
		})) return reconciliation('SOURCE_STOCK_LEDGER')
		const retail = source.doc_type === 'retail_receipt'
		const relatedPayments = await client.query(
			`select d.id from docs d join money_movements m on m.company_id=d.company_id and m.doc_id=d.id
			 where d.company_id=$1 and (d.order_id=$2 or d.id=$3) and m.amount>0`,
			[company, input.orderId, `pay-${input.orderId}`])
		if (relatedPayments.rows.some(p => p.id !== (retail ? source.id : `pay-${input.orderId}`))) return reconciliation('MULTIPLE_PAYMENT_SOURCES')
		let accountId: string | null = null
		let mode: 'cash' | 'debt' = 'cash'
		if (!retail && (source.party_kind !== 'customer' || source.party_id !== order.customer_id)) return reconciliation('SOURCE_CUSTOMER')
		if (!retail && order.on_credit) {
			mode = 'debt'
			const negative = await client.query(
				`select 1 from settlement_movements where company_id=$1 and party_kind='customer' and party_id=$2
				 and amount < 0 and not (doc_id = any($3::text[])) limit 1`, [company, source.party_id, historyDocs])
			if (negative.rows.length) return reconciliation('UNALLOCATED_CUSTOMER_PAYMENT')
		} else {
			const paymentId = retail ? source.id : `pay-${input.orderId}`
			const payment = await client.query(
				`select d.id, d.status, d.deleted_at, d.doc_type, d.party_kind, d.party_id, d.amount::text,
				 m.account_id, m.amount::text as paid, a.kind, a.deleted_at as account_deleted
				 from docs d join money_movements m on m.company_id=d.company_id and m.doc_id=d.id
				 left join money_accounts a on a.company_id=m.company_id and a.id=m.account_id
				 where d.company_id=$1 and d.id=$2`, [company, paymentId])
			const p = payment.rows[0]
			if (payment.rows.length !== 1 || !p || p.status !== 'posted' || p.deleted_at || p.account_deleted || p.kind !== 'cash' ||
				units(p.paid, 2) !== total || units(p.amount, 2) !== total ||
				(!retail && (p.doc_type !== 'payment_in' || p.party_kind !== 'customer' || p.party_id !== source.party_id))) return reconciliation('PAYMENT_ORIGIN_AMBIGUOUS')
			accountId = p.account_id
			if (!retail) {
				const paidSettlement = await client.query(
					`select amount::text from settlement_movements where company_id=$1 and doc_id=$2 and party_kind='customer' and party_id=$3`,
					[company, paymentId, source.party_id])
				if (paidSettlement.rows.length !== 1 || signedUnits(paidSettlement.rows[0].amount, 2) !== -total) return reconciliation('PAYMENT_SETTLEMENT')
			}
		}
		if (!retail) {
			const settlement = await client.query(
				`select amount::text from settlement_movements where company_id=$1 and doc_id=$2
				 and party_kind='customer' and party_id=$3`, [company, source.id, source.party_id])
			if (settlement.rows.length !== 1 || units(settlement.rows[0].amount, 2) !== total) return reconciliation('SOURCE_SETTLEMENT')
		}
		const returned: LineResult[] = items.map(item => {
			const line = allocations.find(l => l.id === item.saleLineId)
			if (!line || line.sold <= 0n) throw Errors.validation([{ message: 'Неизвестная строка продажи' }])
			if (line.marked) return reconciliation('MARKED_RETURN_UNSUPPORTED')
			const old = previous.get(line.id) ?? { qty: 0n, amount: 0n, cost: 0n }
			const qty = units(item.qtyBase, 4)
			if (old.qty + qty > line.sold) throw new ApiError(409, 'RETURN_QUANTITY_EXCEEDED', 'Превышено доступное количество возврата')
			const amount = round(line.net * (old.qty + qty), line.sold) - old.amount
			const cost = round(line.cost * (old.qty + qty), line.sold) - old.cost
			if (amount < 0n || cost < 0n) return reconciliation('RETURN_HISTORY_AMOUNT')
			return { saleLineId: line.id, productId: line.product_id, qtyBase: item.qtyBase,
				amountMinor: amount.toString(), costAmount: fixed(cost, 4) }
		})
		const refund = returned.reduce((sum, line) => sum + BigInt(line.amountMinor), 0n)
		if (mode === 'cash' && previousMoney + refund > total) return reconciliation('PAID_AMOUNT_EXCEEDED')
		const actor = auth.memberName ?? auth.email ?? auth.userId
		await client.query(
			`insert into docs (company_id,id,doc_type,warehouse_id,party_kind,party_id,account_id,order_id,reason,"by")
			 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[company, documentId, retail ? 'retail_return' : 'sales_return', source.warehouse_id,
				retail ? null : 'customer', retail ? null : source.party_id, retail ? accountId : null, input.orderId, input.reason ?? null, actor])
		for (const [index, line] of returned.entries()) {
			// Net price includes the original discount. Division in NUMERIC avoids floating-point rounding;
			// post_doc rounds the line back to the already allocated exact number of cents.
			await client.query(
				`insert into doc_lines (company_id,id,doc_id,line_no,product_id,qty_input,qty,price,cost_amount)
				 values ($1,$2,$3,$4,$5,$6,$6,($7::numeric/100)/$6::numeric,$8)`,
				[company, `${documentId}-${index}`, documentId, index, line.productId, line.qtyBase, line.amountMinor, line.costAmount])
		}
		const posted = await client.query('select post_doc($1,$2)::text as amount', [company, documentId])
		if (units(posted.rows[0].amount, 2) !== refund) return reconciliation('POSTED_AMOUNT_MISMATCH')
		const paymentDocumentId = !retail && mode === 'cash' && refund > 0n ? `retpay-${input.returnId}` : null
		if (paymentDocumentId) {
			await client.query(
				`insert into docs (company_id,id,doc_type,party_kind,party_id,account_id,order_id,amount,"by")
				 values ($1,$2,'payment_out','customer',$3,$4,$5,$6,$7)`,
				[company, paymentDocumentId, source.party_id, accountId, input.orderId, fixed(refund, 2), actor])
			await client.query('select post_doc($1,$2)', [company, paymentDocumentId])
		}
		const fullyReturned = allocations.every(line => (previous.get(line.id)?.qty ?? 0n) +
			returned.filter(r => r.saleLineId === line.id).reduce((sum, r) => sum + units(r.qtyBase, 4), 0n) === line.sold)
		const result: Result = { ok: true, contractVersion: 2, returnId: input.returnId, orderId: input.orderId,
			documentId, paymentDocumentId, fingerprint, items: returned, amountMinor: refund.toString(),
			cashRefundMinor: mode === 'cash' ? refund.toString() : '0', debtReductionMinor: mode === 'debt' ? refund.toString() : '0',
			accountId, fullyReturned }
		const saved: Saved = { kind: 'return-v2', request: command, fingerprint, result }
		await client.query('update docs set source_payload=$3 where company_id=$1 and id=$2', [company, documentId, JSON.stringify(saved)])
		// qty is retained for legacy readers; v2 accounting always uses saleLineId + qtyBase.
		const event = { ...result, at: new Date().toISOString(), by: actor, userId: auth.userId,
			items: returned.map(line => ({ ...line, qty: Number(line.qtyBase) })) }
		await client.query(
			`update orders set returns=coalesce(returns,'[]'::jsonb)||$3::jsonb, returned=$4 where company_id=$1 and id=$2`,
			[company, input.orderId, JSON.stringify([event]), fullyReturned])
		await client.query(`insert into audit (company_id,id,"by",title,section,type) values ($1,$2,$3,$4,'sales','return')`,
			[company, randomUUID(), actor, `Возврат v2 ${input.returnId} по заказу ${input.orderId}`])
		await storeIdempotentResponse(client, company, key, 201, result)
		return { status: 201, body: result, replayed: false }
	})
}
