import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors, mapPgError } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'

const ReturnBody = z.object({
	orderId: z.string().min(1).max(64),
	items: z
		.array(
			z.object({
				productId: z.string().min(1).max(64),
				qty: z.number().positive().finite(),
				markCodes: z.array(z.string().min(1).max(300)).max(1000).optional(),
			}),
		)
		.max(500)
		.optional(),
	reason: z.string().max(500).optional(),
})

type OrderItem = { productId: string; qty: number; name?: string; cost?: number; price?: number }
type ReturnEvent = { at: string; by: string; items: Array<{ productId: string; qty: number }> }

export function registerReturnRoutes(app: FastifyInstance, pool: DbPool) {
	app.post('/v1/returns', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (auth.role === 'courier') throw Errors.forbidden()

		const keyParsed = IdempotencyKey.safeParse(request.headers['idempotency-key'])
		if (!keyParsed.success) throw Errors.validation(keyParsed.error.issues)
		const idemKey = keyParsed.data

		const parsed = ReturnBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { orderId, items: requestedItems, reason } = parsed.data

		const result = await withTransaction(pool, async client => {
			const claim = await claimIdempotencyKey(client, {
				key: idemKey,
				companyId: auth.companyId,
				endpoint: 'POST /v1/returns',
			})
			if (claim.replay) return { status: claim.status, body: claim.response, replayed: true }

			const { rows } = await client.query(
				`select id, no, status, stock_consumed, returned, returns, items,
				        on_credit, customer_id
				 from orders
				 where company_id = $1 and id = $2 and deleted_at is null
				 for update`,
				[auth.companyId, orderId],
			)
			const order = rows[0]
			if (!order) throw Errors.notFound(`Заказ ${orderId}`)
			if (!order.stock_consumed)
				throw Errors.validation([{ message: 'По заказу не было отгрузки — возвращать нечего' }])
			if (order.returned) throw Errors.validation([{ message: 'Заказ уже полностью возвращён' }])

			const sold = new Map<string, { qty: number; name?: string; cost?: number; price?: number }>()
			for (const it of (order.items ?? []) as OrderItem[]) {
				if (!it?.productId) continue
				const prev = sold.get(it.productId)
				sold.set(it.productId, {
					qty: (prev?.qty ?? 0) + Number(it.qty),
					name: it.name ?? prev?.name,
					cost: prev?.cost ?? (typeof it.cost === 'number' ? it.cost : undefined),
					price: prev?.price ?? (typeof it.price === 'number' ? it.price : undefined),
				})
			}

			const alreadyReturned = new Map<string, number>()
			for (const ev of (order.returns ?? []) as ReturnEvent[]) {
				for (const it of ev.items ?? []) {
					alreadyReturned.set(it.productId, (alreadyReturned.get(it.productId) ?? 0) + Number(it.qty))
				}
			}

			const toReturn: Array<{ productId: string; qty: number; name?: string; cost?: number; price?: number }> = []
			if (requestedItems) {
				const req = new Map<string, number>()
				for (const it of requestedItems) req.set(it.productId, (req.get(it.productId) ?? 0) + it.qty)
				for (const [productId, qty] of req) {
					const soldQty = sold.get(productId)?.qty ?? 0
					const remaining = soldQty - (alreadyReturned.get(productId) ?? 0)
					if (qty > remaining + 1e-6)
						throw Errors.validation([
							{ message: `Возврат ${productId}: доступно ${remaining}, запрошено ${qty}` },
						])
					const s = sold.get(productId)
					toReturn.push({ productId, qty, name: s?.name, cost: s?.cost, price: s?.price })
				}
			} else {
				for (const [productId, { qty, name, cost, price }] of sold) {
					const remaining = qty - (alreadyReturned.get(productId) ?? 0)
					if (remaining > 1e-6) toReturn.push({ productId, qty: remaining, name, cost, price })
				}
			}
			if (toReturn.length === 0) throw Errors.validation([{ message: 'Нечего возвращать' }])

			const actor = auth.memberName ?? auth.email ?? auth.userId

			// Коды маркировки: возвращаем в пул товара
			const returnMarkCodes = new Map<string, string[]>()
			if (requestedItems) {
				for (const it of requestedItems) {
					if (it.markCodes?.length) returnMarkCodes.set(it.productId, it.markCodes)
				}
			}
			for (const [productId, codes] of returnMarkCodes) {
				const { rows: pr } = await client.query(
					`select marked, codes from products where company_id = $1 and id = $2`,
					[auth.companyId, productId],
				)
				const p = pr[0]
				if (p?.marked) {
					const existing: string[] = Array.isArray(p.codes) ? p.codes.map((c: unknown) => String(c)) : []
					const back = codes.filter(c => !existing.includes(c))
					if (back.length) {
						await client.query(
							`update products set codes = $3 where company_id = $1 and id = $2`,
							[auth.companyId, productId, JSON.stringify([...existing, ...back])],
						)
					}
				}
			}

			// Склад по умолчанию
			const { rows: whs } = await client.query(
				`select id from warehouses where company_id = $1 and deleted_at is null order by id limit 1`,
				[auth.companyId],
			)
			const warehouseId = whs[0]?.id ?? null

			const isCredit = order.on_credit && order.customer_id && order.customer_id !== 'retail'
			const docId = `ret-${orderId}-${Date.now()}`

			await client.query(
				`insert into docs (company_id, id, doc_type, warehouse_id, party_kind, party_id,
				                   order_id, reason, "by")
				 values ($1,$2,'sales_return',$3,$4,$5,$6,$7,$8)`,
				[
					auth.companyId, docId, warehouseId,
					isCredit ? 'customer' : null,
					isCredit ? order.customer_id : null,
					orderId,
					reason ?? null,
					actor,
				],
			)

			const sorted = [...toReturn].sort((a, b) => a.productId.localeCompare(b.productId))
			for (const [i, item] of sorted.entries()) {
				await client.query(
					`insert into doc_lines (company_id, id, doc_id, line_no, product_id, unit_id, unit_factor,
					                        qty_input, qty, price)
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
					[
						auth.companyId, `${docId}-${i}`, docId, i, item.productId,
						null, 1, item.qty, item.qty, item.price ?? item.cost ?? 0,
					],
				)
			}

			try {
				await client.query('select post_doc($1,$2)', [auth.companyId, docId])
			} catch (err) {
				throw mapPgError(err, request.log)
			}

			// Обновляем orders.returns / orders.returned
			const event: ReturnEvent = {
				at: new Date().toISOString(),
				by: actor,
				items: toReturn.map(i => ({ productId: i.productId, qty: i.qty })),
			}
			const returnedAfter = new Map(alreadyReturned)
			for (const it of toReturn) returnedAfter.set(it.productId, (returnedAfter.get(it.productId) ?? 0) + it.qty)
			const fullyReturned = [...sold.entries()].every(
				([pid, { qty }]) => (returnedAfter.get(pid) ?? 0) >= qty - 1e-6,
			)

			await client.query(
				`update orders set returns = coalesce(returns, '[]'::jsonb) || $3::jsonb, returned = $4
				 where company_id = $1 and id = $2`,
				[auth.companyId, orderId, JSON.stringify([event]), fullyReturned],
			)

			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'sales', 'return')`,
				[auth.companyId, randomUUID(), actor, `Возврат по заказу №${order.no ?? orderId}`],
			)

			const body = { ok: true, orderId, returned: toReturn, fullyReturned }
			await storeIdempotentResponse(client, auth.companyId, idemKey, 201, body)
			return { status: 201, body, replayed: false }
		})

		if (result.replayed) reply.header('idempotency-replayed', 'true')
		reply.code(result.status)
		if (!result.replayed) {
			publishEvent(pool, { companyId: auth.companyId, type: 'return', id: orderId, senderUserId: auth.userId })
		}
		return result.body
	})
}
