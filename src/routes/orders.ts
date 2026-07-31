import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import type { Batch } from '../lib/fifo.js'
import { round4 } from '../lib/fifo.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'

const StatusBody = z.object({
	status: z.enum(['new', 'confirmed', 'picking', 'packed', 'shipped', 'delivered', 'cancelled']),
})

// Разрешённые переходы. Физическое списание — на shipped, возврат — на cancelled после shipped.
const TRANSITIONS: Record<string, string[]> = {
	new: ['confirmed', 'picking', 'cancelled'],
	confirmed: ['picking', 'packed', 'cancelled'],
	picking: ['packed', 'shipped', 'cancelled'],
	packed: ['shipped', 'cancelled'],
	shipped: ['delivered', 'cancelled'],
	delivered: [],
	cancelled: [],
}

type OrderItem = { productId: string; qty: number; name?: string; cost?: number }
type ReturnEvent = { at: string; by: string; items: Array<{ productId: string; qty: number }> }

/**
 * POST /v1/orders/:id/status — переход статуса заказа.
 *  - shipped: физическое списание остатков (если ещё не списаны) под FOR UPDATE,
 *    FIFO-партии съедаются;
 *  - cancelled после списания: возврат остатков С УЧЁТОМ уже возвращённого
 *    через /v1/returns (иначе задвоение) + партии обратно в products.batches;
 *  - курьер может только shipped → delivered (только своих заказов).
 */
export function registerOrderRoutes(app: FastifyInstance, pool: DbPool) {
	app.post('/v1/orders/:id/status', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		const orderId = (request.params as { id: string }).id

		const keyParsed = IdempotencyKey.safeParse(request.headers['idempotency-key'])
		if (!keyParsed.success) throw Errors.validation(keyParsed.error.issues)
		const idemKey = keyParsed.data

		const parsed = StatusBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const nextStatus = parsed.data.status

		const result = await withTransaction(pool, async client => {
			const claim = await claimIdempotencyKey(client, {
				key: idemKey,
				companyId: auth.companyId,
				endpoint: `POST /v1/orders/status`,
			})
			if (claim.replay) return { status: claim.status, body: claim.response, replayed: true }

			const { rows } = await client.query(
				`select id, no, status, stock_consumed, items, returns, assigned_to from orders
				 where company_id = $1 and id = $2 and deleted_at is null
				 for update`,
				[auth.companyId, orderId],
			)
			const order = rows[0]
			if (!order) throw Errors.notFound(`Заказ ${orderId}`)

			if (auth.role === 'courier') {
				// null === null для курьера без имени и неназначенного заказа даёт
				// «свой» → бросали заглушку. memberName обязателен для доступа.
				const isMine =
					(!!auth.memberName && order.assigned_to === auth.memberName) ||
					(!!order.assigned_to && order.assigned_to === auth.userId)
				if (!(order.status === 'shipped' && nextStatus === 'delivered' && isMine))
					throw Errors.forbidden('Курьер может только отметить доставку своего заказа')
			}

			const allowed = TRANSITIONS[order.status] ?? []
			if (!allowed.includes(nextStatus))
				throw Errors.validation([{ message: `Переход ${order.status} → ${nextStatus} запрещён` }])

			const items: OrderItem[] = Array.isArray(order.items) ? order.items : []
			const actor = auth.memberName ?? auth.email ?? auth.userId

			// Физическое списание при отгрузке.
			if (nextStatus === 'shipped' && !order.stock_consumed) {
				await moveStock(client, auth.companyId, items, -1, `Отгрузка №${order.no ?? order.id}`, actor, 'sale')
				await client.query(`update orders set stock_consumed = true where company_id = $1 and id = $2`, [
					auth.companyId,
					orderId,
				])
			}
			// Отмена после списания: восстановить остаток С УЧЁТОМ уже возвращённого.
			if (nextStatus === 'cancelled' && order.stock_consumed) {
				const returnedByProduct = new Map<string, number>()
				for (const ev of (order.returns ?? []) as ReturnEvent[]) {
					for (const it of ev.items ?? []) {
						returnedByProduct.set(it.productId, (returnedByProduct.get(it.productId) ?? 0) + Number(it.qty))
					}
				}
				const soldByProduct = new Map<string, { qty: number; name?: string; cost?: number }>()
				for (const it of items) {
					if (!it?.productId) continue
					const prev = soldByProduct.get(it.productId)
					soldByProduct.set(it.productId, {
						qty: (prev?.qty ?? 0) + Number(it.qty),
						name: it.name ?? prev?.name,
						cost: prev?.cost ?? (typeof it.cost === 'number' ? it.cost : undefined),
					})
				}
				const remaining: OrderItem[] = []
				for (const [productId, s] of soldByProduct) {
					const left = s.qty - (returnedByProduct.get(productId) ?? 0)
					if (left > 1e-6) remaining.push({ productId, qty: left, name: s.name, cost: s.cost })
				}
				if (remaining.length > 0) {
					await moveStock(client, auth.companyId, remaining, +1, `Отмена №${order.no ?? order.id}`, actor, 'return')
				}
				await client.query(`update orders set stock_consumed = false where company_id = $1 and id = $2`, [
					auth.companyId,
					orderId,
				])
			}

			await client.query(
				`update orders set status = $3,
				   track = coalesce(track, '[]'::jsonb) || $4::jsonb
				 where company_id = $1 and id = $2`,
				[
					auth.companyId,
					orderId,
					nextStatus,
					JSON.stringify([{ type: 'status', to: nextStatus, at: new Date().toISOString(), by: actor }]),
				],
			)

			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'orders', 'status')`,
				[auth.companyId, randomUUID(), actor, `Заказ №${order.no ?? orderId}: ${order.status} → ${nextStatus}`],
			)

			const body = { ok: true, order: { id: orderId, status: nextStatus } }
			await storeIdempotentResponse(client, auth.companyId, idemKey, 200, body)
			return { status: 200, body, replayed: false }
		})

		if (result.replayed) reply.header('idempotency-replayed', 'true')
		reply.code(result.status)
		if (!result.replayed) {
			publishEvent(pool, { companyId: auth.companyId, type: 'order_status', id: orderId, senderUserId: auth.userId })
		}
		return result.body
	})
}

/**
 * direction = -1 (отгрузка): списание с FIFO-съедением партий.
 * direction = +1 (отмена/возврат): восстановление stock + добавление партии
 *   по себестоимости из order.items (или текущей product.cost, если нет).
 */
async function moveStock(
	client: pg.PoolClient,
	companyId: string,
	items: OrderItem[],
	direction: 1 | -1,
	reason: string,
	actor: string,
	movementType: string,
) {
	const totals = new Map<string, { qty: number; name?: string; cost?: number }>()
	for (const it of items) {
		if (!it?.productId || !(Number(it.qty) > 0)) continue
		const prev = totals.get(it.productId)
		totals.set(it.productId, {
			qty: round4((prev?.qty ?? 0) + Number(it.qty)),
			name: it.name ?? prev?.name,
			cost: prev?.cost ?? (typeof it.cost === 'number' ? it.cost : undefined),
		})
	}
	const sorted = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))

	for (const [productId, { qty, name, cost }] of sorted) {
		const { rows } = await client.query(
			`select name, stock, cost, batches from products where company_id = $1 and id = $2 for update`,
			[companyId, productId],
		)
		const p = rows[0]
		if (!p) {
			if (direction < 0) throw Errors.notFound(`Товар ${productId}`)
			continue // возврат/отмена товара, которого больше нет в справочнике — пропускаем
		}
		const stock = Number(p.stock)
		if (direction < 0 && stock < qty) throw Errors.insufficientStock(productId, stock, qty)

		const batches: Batch[] = Array.isArray(p.batches) ? p.batches : []
		let realizedCost: number | null = null
		if (direction < 0) {
			// FIFO списание, стоимость строки посчитается серверу для movements.cost
			const { consumeFifo } = await import('../lib/fifo.js')
			const consumed = consumeFifo(batches, qty, Number(p.cost ?? 0))
			await client.query(
				`update products set stock = stock - $3, batches = $4 where company_id = $1 and id = $2`,
				[companyId, productId, qty, JSON.stringify(consumed.batches)],
			)
			realizedCost = qty > 0 ? round4(consumed.cogs / qty) : 0
		} else {
			// Возврат партии — «в начало очереди» чтобы уходила первой на следующей продаже.
			const returnCost = cost ?? Number(p.cost ?? 0)
			batches.unshift({ id: randomUUID(), qty, cost: returnCost, at: '1970-01-01T00:00:00Z' })
			await client.query(
				`update products set stock = stock + $3, batches = $4 where company_id = $1 and id = $2`,
				[companyId, productId, qty, JSON.stringify(batches)],
			)
			realizedCost = returnCost
		}

		await client.query(
			`insert into movements (company_id, id, type, product_id, name, qty, delta, cost, reason, "by")
			 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[companyId, randomUUID(), movementType, productId, name ?? p.name, qty, direction * qty, realizedCost, reason, actor],
		)
	}
}
