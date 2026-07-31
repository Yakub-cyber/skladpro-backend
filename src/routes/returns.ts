import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import type { Batch } from '../lib/fifo.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'

const ReturnBody = z.object({
	orderId: z.string().min(1).max(64),
	// Не указано — полный возврат всего, что ещё не возвращено.
	items: z
		.array(
			z.object({
				productId: z.string().min(1).max(64),
				qty: z.number().positive().finite(),
				// Явно возвращаемые коды маркировки (если сканирует кассир при возврате).
				markCodes: z.array(z.string().min(1).max(300)).max(1000).optional(),
			}),
		)
		.max(500)
		.optional(),
	reason: z.string().max(500).optional(),
})

type OrderItem = { productId: string; qty: number; name?: string; cost?: number }
type ReturnEvent = { at: string; by: string; items: Array<{ productId: string; qty: number }> }

/**
 * POST /v1/returns — возврат по заказу (полный или частичный).
 *  - нельзя вернуть больше проданного минус уже возвращённое
 *    (дубликаты productId в одном запросе агрегируются ДО проверки);
 *  - возвращаемые единицы возвращаются в products.batches по себестоимости
 *    из order.items (сохраняется при продаже) — FIFO не разъезжается со stock;
 *  - остатки восстанавливаются атомарно, движения и аудит пишет сервер.
 */
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

			// Что было продано (агрегация по productId — товар мог прийти двумя строками).
			const sold = new Map<string, { qty: number; name?: string; cost?: number }>()
			for (const it of (order.items ?? []) as OrderItem[]) {
				if (!it?.productId) continue
				const prev = sold.get(it.productId)
				sold.set(it.productId, {
					qty: (prev?.qty ?? 0) + Number(it.qty),
					name: it.name ?? prev?.name,
					// себестоимость из первой строки; при разных стоимостях получим
					// «в среднем ту же» партию, что для FIFO приемлемо.
					cost: prev?.cost ?? (typeof it.cost === 'number' ? it.cost : undefined),
				})
			}

			const alreadyReturned = new Map<string, number>()
			for (const ev of (order.returns ?? []) as ReturnEvent[]) {
				for (const it of ev.items ?? []) {
					alreadyReturned.set(it.productId, (alreadyReturned.get(it.productId) ?? 0) + Number(it.qty))
				}
			}

			// Что возвращаем — сначала агрегируем дубликаты в запросе, потом проверяем remaining.
			const toReturn: Array<{ productId: string; qty: number; name?: string; cost?: number }> = []
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
					toReturn.push({ productId, qty, name: s?.name, cost: s?.cost })
				}
			} else {
				for (const [productId, { qty, name, cost }] of sold) {
					const remaining = qty - (alreadyReturned.get(productId) ?? 0)
					if (remaining > 1e-6) toReturn.push({ productId, qty: remaining, name, cost })
				}
			}
			if (toReturn.length === 0) throw Errors.validation([{ message: 'Нечего возвращать' }])

			const actor = auth.memberName ?? auth.email ?? auth.userId
			// Коды маркировки к возврату (взяты из body или прошлись из order.items).
			const returnMarkCodes = new Map<string, string[]>()
			if (requestedItems) {
				for (const it of requestedItems) {
					if (it.markCodes?.length) returnMarkCodes.set(it.productId, it.markCodes)
				}
			}
			const sorted = [...toReturn].sort((a, b) => a.productId.localeCompare(b.productId))
			for (const it of sorted) {
				// Восстанавливаем партию FIFO: `at = 1970-01-01` — чтобы возвращённые
				// единицы уходили ПЕРВЫМИ на следующей продаже (LIFO по факту).
				// Себестоимость из чека; если пропала — из текущей продуктовой.
				const { rows: pr } = await client.query(
					`select cost, batches, marked, codes from products where company_id = $1 and id = $2 for update`,
					[auth.companyId, it.productId],
				)
				const p = pr[0]
				const cost = it.cost ?? Number(p?.cost ?? 0)
				const batches: Batch[] = Array.isArray(p?.batches) ? p.batches : []
				batches.unshift({ id: randomUUID(), qty: it.qty, cost, at: '1970-01-01T00:00:00Z' })
				// Возвращённые коды маркировки — добавляем обратно в пул.
				// Только если товар маркированный и явно переданы коды.
				let nextCodes: string[] | null = null
				if (p?.marked && returnMarkCodes.has(it.productId)) {
					const existing: string[] = Array.isArray(p.codes) ? p.codes.map((c: unknown) => String(c)) : []
					const back = returnMarkCodes.get(it.productId)!.filter(c => !existing.includes(c))
					if (back.length) nextCodes = [...existing, ...back]
				}
				if (nextCodes !== null) {
					await client.query(
						`update products set stock = stock + $3, batches = $4, codes = $5
						 where company_id = $1 and id = $2`,
						[auth.companyId, it.productId, it.qty, JSON.stringify(batches), JSON.stringify(nextCodes)],
					)
				} else {
					await client.query(
						`update products set stock = stock + $3, batches = $4
						 where company_id = $1 and id = $2`,
						[auth.companyId, it.productId, it.qty, JSON.stringify(batches)],
					)
				}
				await client.query(
					`insert into movements (company_id, id, type, product_id, name, qty, delta, cost, reason, "by")
					 values ($1,$2,'return',$3,$4,$5,$6,$7,$8,$9)`,
					[
						auth.companyId,
						randomUUID(),
						it.productId,
						it.name ?? it.productId,
						it.qty,
						it.qty,
						cost,
						reason ?? `Возврат по заказу №${order.no ?? orderId}`,
						actor,
					],
				)
			}

			// Полный ли возврат после этой операции?
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

			// Возврат по заказу «в долг» уменьшает баланс клиента на возвращённую
			// сумму (по ценам продажи, а не текущим). Берём цены из order.items
			// (это то, за что клиент реально задолжал).
			let creditRefund = 0
			if (order.on_credit && order.customer_id && order.customer_id !== 'retail') {
				const priceMap = new Map<string, number>()
				for (const it of (order.items ?? []) as Array<{ productId: string; price?: number }>) {
					if (it?.productId && typeof it.price === 'number') priceMap.set(it.productId, it.price)
				}
				for (const it of toReturn) creditRefund += it.qty * (priceMap.get(it.productId) ?? 0)
				creditRefund = Math.round(creditRefund * 100) / 100
				if (creditRefund > 0) {
					await client.query(
						`update customers set balance = greatest(0, coalesce(balance, 0) - $3)
						 where company_id = $1 and id = $2 and deleted_at is null`,
						[auth.companyId, order.customer_id, creditRefund],
					)
				}
			}

			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'sales', 'return')`,
				[
					auth.companyId,
					randomUUID(),
					actor,
					creditRefund > 0
						? `Возврат по заказу №${order.no ?? orderId} (долг −${creditRefund})`
						: `Возврат по заказу №${order.no ?? orderId}`,
				],
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
