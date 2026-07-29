import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { ApiError, Errors } from '../lib/errors.js'
import { publishEvent } from '../lib/events.js'
import { consumeFifo, round4, type Batch } from '../lib/fifo.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey, SaleBody } from '../schemas/sale.js'

const EPS = 0.000001

/**
 * POST /v1/sales — продажа (POS или веб).
 *
 *  - остаток проверяется и списывается под SELECT … FOR UPDATE
 *    (две кассы не продадут последнюю штуку одновременно);
 *  - суммы пересчитываются на сервере, клиентскому total не верим;
 *  - движения (movements) и аудит пишет сервер от имени проверенного пользователя;
 *  - Idempotency-Key обязателен: ретрай из offline-очереди не спишет остаток дважды.
 */
export function registerSalesRoutes(app: FastifyInstance, pool: DbPool) {
	app.post('/v1/sales', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (auth.role === 'courier') throw Errors.forbidden('Курьеру продажи недоступны')

		const keyParsed = IdempotencyKey.safeParse(request.headers['idempotency-key'])
		if (!keyParsed.success) throw Errors.validation(keyParsed.error.issues)
		const idemKey = keyParsed.data

		const bodyParsed = SaleBody.safeParse(request.body)
		if (!bodyParsed.success) throw Errors.validation(bodyParsed.error.issues)
		const { order } = bodyParsed.data

		const result = await withTransaction(pool, async client => {
			const claim = await claimIdempotencyKey(client, {
				key: idemKey,
				companyId: auth.companyId,
				endpoint: 'POST /v1/sales',
			})
			if (claim.replay) return { status: claim.status, body: claim.response, replayed: true }

			// qty округляем до 4 знаков — иначе весовой товар с копеечным «хвостом»
			// (0.3 vs 0.3000000000000004 из-за float-суммирования) проходит app-check и
			// падает на DB check(stock>=0) c 500 INTERNAL, зависая в offline-outbox.
			// Детерминированный порядок блокировок — защита от deadlock между кассами.
			const items = order.items
				.map(it => ({ ...it, qty: round4(it.qty) }))
				.sort((a, b) => a.productId.localeCompare(b.productId))

			const products = new Map<
				string,
				{ name: string; stock: number; cost: number; batches: Batch[]; marked: boolean; codes: string[] }
			>()
			for (const item of items) {
				if (products.has(item.productId)) continue
				const { rows } = await client.query(
					`select id, name, stock, cost, batches, marked, codes from products
					 where company_id = $1 and id = $2 and deleted_at is null
					 for update`,
					[auth.companyId, item.productId],
				)
				const row = rows[0]
				if (!row) throw Errors.notFound(`Товар ${item.productId}`)
				products.set(item.productId, {
					name: row.name,
					stock: Number(row.stock ?? 0),
					cost: Number(row.cost ?? 0),
					batches: Array.isArray(row.batches) ? row.batches : [],
					marked: !!row.marked,
					codes: Array.isArray(row.codes) ? row.codes.map((c: unknown) => String(c)) : [],
				})
			}

			// Коды маркировки: собираем по товару, проверяем что все они есть в
			// пуле, дубликаты запрещены. Отсекаем ДО списания остатка.
			const consumedCodes = new Map<string, string[]>()
			for (const item of items) {
				if (!item.markCodes?.length) continue
				const p = products.get(item.productId)!
				if (!p.marked) {
					throw Errors.validation([{ message: `Товар ${item.productId} не маркированный, markCodes не ожидаются` }])
				}
				const uniq = Array.from(new Set(item.markCodes))
				if (uniq.length !== item.markCodes.length) {
					throw Errors.validation([{ message: `Товар ${item.productId}: дубликаты в markCodes` }])
				}
				const pool = new Set(p.codes)
				const missing = uniq.filter(c => !pool.has(c))
				if (missing.length) {
					throw new ApiError(
						409,
						'MARK_CODE_NOT_IN_POOL',
						`Коды маркировки ${missing.slice(0, 3).join(', ')} не найдены в пуле товара`,
						{ productId: item.productId, missing },
					)
				}
				const prev = consumedCodes.get(item.productId) ?? []
				consumedCodes.set(item.productId, [...prev, ...uniq])
			}

			// Суммарное количество по товару (один товар мог прийти двумя строками).
			const totalsByProduct = new Map<string, number>()
			for (const item of items) {
				totalsByProduct.set(item.productId, round4((totalsByProduct.get(item.productId) ?? 0) + item.qty))
			}
			for (const [productId, qty] of totalsByProduct) {
				const p = products.get(productId)!
				// Строгая проверка на уже округлённом qty. EPS убран сознательно.
				if (p.stock < qty) throw Errors.insufficientStock(productId, p.stock, qty)
			}

			const subtotal = round2(items.reduce((sum, it) => sum + it.qty * it.price, 0))
			const discount = round2(order.discount)
			const total = round2(subtotal - discount)
			if (total < -EPS) throw Errors.validation([{ message: 'Скидка больше суммы чека' }])

			const actor = auth.memberName ?? auth.email ?? auth.userId
			const now = new Date().toISOString()

			// Себестоимость по FIFO: партии съедаются по каждой строке чека.
			const itemCogs = new Map<(typeof items)[number], number>()
			for (const item of items) {
				const p = products.get(item.productId)!
				const consumed = consumeFifo(p.batches, item.qty, p.cost)
				p.batches = consumed.batches
				itemCogs.set(item, consumed.cogs)
			}

			for (const [productId, qty] of totalsByProduct) {
				const p = products.get(productId)!
				// Если сканировали конкретные КМ — снимаем именно их. Иначе, для
				// маркированного товара без явного скана, снимаем «первые N» из
				// пула (совместимость с текущим поведением POS-кассы).
				const consumed = consumedCodes.get(productId)
				let nextCodes = p.codes
				if (p.marked) {
					if (consumed?.length) {
						const consumedSet = new Set(consumed)
						nextCodes = p.codes.filter(c => !consumedSet.has(c))
					} else if (p.codes.length > 0) {
						nextCodes = p.codes.slice(Math.min(p.codes.length, Math.ceil(qty)))
					}
				}
				await client.query(
					`update products set stock = stock - $3, batches = $4, codes = $5
					 where company_id = $1 and id = $2`,
					[auth.companyId, productId, qty, JSON.stringify(p.batches), JSON.stringify(nextCodes)],
				)
			}

			// Сохраняем в order.items ВЗВЕШЕННУЮ себестоимость каждой строки —
			// чтобы возврат восстановил FIFO-партию по цене продажи (иначе stock
			// расходится с sum(batches) навсегда).
			const enrichedItems = items.map(it => {
				const cogs = itemCogs.get(it) ?? 0
				const cost = it.qty > 0 ? round4(cogs / it.qty) : 0
				return { ...it, cost }
			})

			const insertedOrder = await client.query(
				`insert into orders
				   (company_id, id, no, customer_id, customer_name, items, subtotal, discount, total,
				    price_type_id, on_credit, status, stock_consumed, shift_id, track)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'delivered',true,$12,$13)
				 on conflict (company_id, id) do nothing
				 returning id`,
				[
					auth.companyId,
					order.id,
					order.no ?? null,
					order.customerId ?? null,
					order.customerName ?? null,
					JSON.stringify(enrichedItems),
					subtotal,
					discount,
					total,
					order.priceTypeId ?? null,
					order.onCredit,
					order.shiftId ?? null,
					JSON.stringify(order.track ?? [{ type: 'paid', at: now, by: actor }]),
				],
			)
			if (insertedOrder.rows.length === 0) throw Errors.duplicate(`Заказ ${order.id}`)

			// Продажа «в долг» реального клиента (не «розница/retail») увеличивает
			// его баланс на сумму чека. Атомарно с продажей — иначе между
			// устройствами долг разъезжается. Баланс сервер держит как источник
			// истины (клиенты через sync-push его не пишут: `balance` в SERVER_MANAGED).
			if (order.onCredit && order.customerId && order.customerId !== 'retail' && total > 0) {
				const upd = await client.query(
					`update customers set balance = coalesce(balance, 0) + $3
					 where company_id = $1 and id = $2 and deleted_at is null
					 returning id`,
					[auth.companyId, order.customerId, total],
				)
				// Клиент удалён/не в этой компании — тихо игнорируем (не блокируем
				// продажу; долг остаётся некому — в отчётах это заметно).
				if (upd.rows.length > 0) {
					await client.query(
						`insert into audit (company_id, id, "by", title, section, type)
						 values ($1, $2, $3, $4, 'finance', 'credit')`,
						[auth.companyId, randomUUID(), actor, `Долг +${total} по продаже №${order.no ?? order.id}`],
					)
				}
			}

			for (const item of items) {
				await client.query(
					`insert into movements (company_id, id, type, product_id, name, qty, delta, cost, reason, "by")
					 values ($1,$2,'sale',$3,$4,$5,$6,$7,$8,$9)`,
					[
						auth.companyId,
						randomUUID(),
						item.productId,
						item.name ?? products.get(item.productId)!.name,
						item.qty,
						-item.qty,
						itemCogs.get(item) ?? null,
						`Продажа №${order.no ?? order.id}`,
						actor,
					],
				)
			}

			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'sales', 'sale')`,
				[auth.companyId, randomUUID(), actor, `Продажа №${order.no ?? order.id} на ${total}`],
			)

			const body = { ok: true, order: { id: order.id, no: order.no ?? null, subtotal, discount, total } }
			await storeIdempotentResponse(client, auth.companyId, idemKey, 201, body)
			return { status: 201, body, replayed: false }
		})

		if (result.replayed) reply.header('idempotency-replayed', 'true')
		reply.code(result.status)
		// Публикуем событие ПОСЛЕ COMMIT — иначе realtime не увидел бы данных.
		// Первичный ретрай (replay) не публикуем — событие уже было при первой попытке.
		if (!result.replayed) {
			publishEvent(pool, { companyId: auth.companyId, type: 'sale', id: bodyParsed.data.order.id, senderUserId: auth.userId })
		}
		return result.body
	})
}

function round2(n: number): number {
	return Math.round(n * 100) / 100
}
