import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors, mapPgError } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import { round4 } from '../lib/utils.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'

const StatusBody = z.object({
	status: z.enum(['new', 'confirmed', 'picking', 'packed', 'shipped', 'delivered', 'cancelled']),
})

const TRANSITIONS: Record<string, string[]> = {
	new: ['confirmed', 'picking', 'cancelled'],
	confirmed: ['picking', 'packed', 'cancelled'],
	picking: ['packed', 'shipped', 'cancelled'],
	packed: ['shipped', 'cancelled'],
	shipped: ['delivered', 'cancelled'],
	delivered: ['cancelled'],
	cancelled: [],
}

type OrderItem = { productId: string; qty: number; name?: string; cost?: number; price?: number }
type ReturnEvent = { at: string; by: string; items: Array<{ productId: string; qty: number }> }

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
				`select id, no, status, stock_consumed, items, returns, assigned_to,
				        on_credit, customer_id
				 from orders
				 where company_id = $1 and id = $2 and deleted_at is null
				 for update`,
				[auth.companyId, orderId],
			)
			const order = rows[0]
			if (!order) throw Errors.notFound(`Заказ ${orderId}`)

			if (auth.role === 'courier') {
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

			// Склад по умолчанию
			const { rows: whs } = await client.query(
				`select id from warehouses where company_id = $1 and deleted_at is null order by id limit 1`,
				[auth.companyId],
			)
			const warehouseId = whs[0]?.id ?? null

			const isCredit = order.on_credit && order.customer_id && order.customer_id !== 'retail'
			const hasParty = !!order.customer_id && order.customer_id !== 'retail'

			const isRetail = !order.customer_id || order.customer_id === 'retail'

			// shipped: создаём документ отгрузки
			if (nextStatus === 'shipped' && !order.stock_consumed) {
				const docId = `ship-${orderId}`
				const docType = isRetail ? 'retail_receipt' : 'sales_shipment'

				let accountId: string | null = null
				if (!isCredit) {
					const { rows: accs } = await client.query(
						`select id from money_accounts where company_id = $1 and deleted_at is null order by is_default desc, id limit 1`,
						[auth.companyId],
					)
					accountId = accs[0]?.id ?? null
				}

				await client.query(
					`insert into docs (company_id, id, doc_type, warehouse_id, party_kind, party_id,
					                   account_id, order_id, "by")
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
					[
						auth.companyId, docId, docType, warehouseId,
						hasParty ? 'customer' : null,
						hasParty ? order.customer_id : null,
						accountId,
						orderId,
						actor,
					],
				)

				const totals = new Map<string, { qty: number; price: number }>()
				for (const it of items) {
					if (!it?.productId) continue
					const prev = totals.get(it.productId)
					totals.set(it.productId, {
						qty: round4((prev?.qty ?? 0) + Number(it.qty)),
						price: prev?.price ?? (typeof it.price === 'number' ? it.price : 0),
					})
				}
				const sorted = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))

				for (const [i, [productId, { qty, price }]] of sorted.entries()) {
					await client.query(
						`insert into doc_lines (company_id, id, doc_id, line_no, product_id, unit_id, unit_factor,
						                        qty_input, qty, price)
						 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
						[auth.companyId, `${docId}-${i}`, docId, i, productId, null, 1, qty, qty, price],
					)
				}

				try {
					await client.query('select post_doc($1,$2)', [auth.companyId, docId])
				} catch (err) {
					throw mapPgError(err, request.log)
				}

				// Наличная продажа реальному клиенту: гасим долг мгновенной оплатой
				if (!isCredit && !isRetail) {
					const orderTotal = [...totals.values()].reduce((s, t) => s + t.qty * t.price, 0)
					const payDocId = `pay-${orderId}`
					await client.query(
						`insert into docs (company_id, id, doc_type, party_kind, party_id, account_id, amount, "by")
						 values ($1,$2,'payment_in','customer',$3,$4,$5,$6)`,
						[auth.companyId, payDocId, order.customer_id, accountId, Math.round(orderTotal * 100) / 100, actor],
					)
					try {
						await client.query('select post_doc($1,$2)', [auth.companyId, payDocId])
					} catch (err) {
						throw mapPgError(err, request.log)
					}
				}

				// stock_consumed + маркер серверного пути: клиент по shipment_doc_id
				// понимает, что дальнейшие переходы (в т.ч. отмена) идут через
				// этот эндпоинт, а не через sync/push.
				await client.query(
					`update orders set stock_consumed = true, shipment_doc_id = $3
					 where company_id = $1 and id = $2`,
					[auth.companyId, orderId, docId],
				)
			}

			// cancelled после отгрузки: распроводим все документы по этому заказу
			if (nextStatus === 'cancelled' && order.stock_consumed) {
				const returnedByProduct = new Map<string, number>()
				for (const ev of (order.returns ?? []) as ReturnEvent[]) {
					for (const it of ev.items ?? []) {
						returnedByProduct.set(it.productId, (returnedByProduct.get(it.productId) ?? 0) + Number(it.qty))
					}
				}

				const { rows: docRows } = await client.query(
					`select id from docs
					 where company_id = $1 and order_id = $2 and status = 'posted'
					   and doc_type in ('sales_shipment','retail_receipt')
					 for update`,
					[auth.companyId, orderId],
				)

				for (const d of docRows) {
					try {
						await client.query('select unpost_doc($1,$2)', [auth.companyId, d.id])
					} catch (err) {
						throw mapPgError(err, request.log)
					}
				}

				// unpost_doc ставит status='draft', но для отмены нужен 'void':
				// draft = «можно провести», void = «аннулирован, повторное проведение запрещено».
				if (docRows.length > 0) {
					await client.query(
						`update docs set status = 'void'
						 where company_id = $1 and order_id = $2 and status = 'draft'`,
						[auth.companyId, orderId],
					)
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
