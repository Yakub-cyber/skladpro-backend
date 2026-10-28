import { postSaleV3 } from '../services/salesV3.js'
import { requirePermission } from '../lib/permissions.js'
import { lockCustomerFinances } from '../services/customerFinance.js'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { ApiError, Errors, mapPgError } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import { round4 } from '../lib/utils.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey, SaleBody, SaleV2Body } from '../schemas/sale.js'
import { canonicalSale, saleConflict, saleFingerprint, saleV2Proof } from '../services/salesV2.js'
import { lockCommercialOrder, commercialError } from '../services/orderCommercial.js'

/**
 * POST /v1/sales — продажа (POS или веб).
 * Создаёт документ sales_shipment (опт, в долг) или retail_receipt (розница).
 * Вся арифметика остатков/себестоимости/взаиморасчётов — в post_doc().
 */
export function registerSalesRoutes(app: FastifyInstance, pool: DbPool) {
	app.post('/v1/sales', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		requirePermission(auth.role, 'sale')
  const version = (request.body as { contractVersion?: unknown } | null)?.contractVersion
  if (version === 3) {
   const result = await postSaleV3(pool, auth, request.body, request.headers['idempotency-key'])
   reply.code(result.status)
   if (result.replayed) reply.header('idempotency-replayed', 'true')
   else publishEvent(pool, { companyId: auth.companyId, type: 'sale', id: result.body.orderId, senderUserId: auth.userId })
   return result.body
  }
  if (version !== undefined && version !== 1 && version !== 2)
   throw new ApiError(422, 'SALE_VERSION_UNSUPPORTED', 'Неизвестная версия продажи')


		const keyParsed = IdempotencyKey.safeParse(request.headers['idempotency-key'])
		if (!keyParsed.success) throw Errors.validation(keyParsed.error.issues)
		const idemKey = keyParsed.data

		const v2 = (request.body as { contractVersion?: unknown } | null)?.contractVersion === 2
		const bodyParsed = (v2 ? SaleV2Body : SaleBody).safeParse(request.body)
		if (!bodyParsed.success) throw Errors.validation(bodyParsed.error.issues)
		const { order } = bodyParsed.data
		const warehouse = v2 && 'warehouseId' in order && typeof order.warehouseId === 'string' ? order.warehouseId : null
		const permanentRequest = v2 ? { contractVersion: 2, companyId: auth.companyId, order } : null
		const fingerprint = v2 ? saleFingerprint(permanentRequest) : null

		const result = await withTransaction(pool, async client => {
   await lockCommercialOrder(client,auth.companyId,order.id)
   if (!v2) {
    const saved = (await client.query('select source_payload from docs where company_id=$1 and id=$2', [auth.companyId, `sale-${order.id}`])).rows[0]
    let kind: unknown
    try { kind = JSON.parse(saved?.source_payload ?? 'null')?.kind }
    catch { if (saved?.source_payload?.includes('sale-v3')) saleConflict() }
    if (kind === 'sale-v3') saleConflict()
   }

			if (v2) {
				// Transaction-scoped, tenant-specific; works even before an order exists.
				await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['sale-v2', auth.companyId, order.id])])
			}
			const claim = await claimIdempotencyKey(client, {
				key: idemKey,
				companyId: auth.companyId,
				endpoint: 'POST /v1/sales',
			})
			if (v2) {
				const proof = await saleV2Proof(client, auth.companyId, order.id, fingerprint!)
				if (claim.replay && (!proof || canonicalSale(claim.response) !== canonicalSale(proof))) saleConflict()
				if (proof) {
					if (!claim.replay) await storeIdempotentResponse(client, auth.companyId, idemKey, 201, proof)
					return { status: 201, body: proof, replayed: true }
				}
				// Do not turn an existing historical shipment into a second sale.
				// Match the order-before-document lock order used by posting routes.
				const existingOrder = await client.query('select stock_consumed, shipment_doc_id from orders where company_id=$1 and id=$2 for update', [auth.companyId, order.id])
				if (existingOrder.rows[0]?.stock_consumed || existingOrder.rows[0]?.shipment_doc_id) saleConflict()
				const historical = await client.query(`select id from docs where company_id=$1 and order_id=$2 and doc_type in ('retail_receipt','sales_shipment') limit 1`, [auth.companyId, order.id])
				if (historical.rows.length) saleConflict()
			} else if (claim.replay) {
    if ((claim.response as {contractVersion?: unknown} | null)?.contractVersion === 3) saleConflict()
    return { status: claim.status, body: claim.response, replayed: true }
   }

   const protectedOrder = await client.query('select commercial_snapshot from orders where company_id=$1 and id=$2 for update',[auth.companyId,order.id])
   if (protectedOrder.rows[0]?.commercial_snapshot)
    commercialError('ORDER_COMMERCIAL_PROTECTED','Продажа не может перезаписать защищённый коммерческий заказ')

			await lockCustomerFinances(client, auth.companyId, [order.customerId === 'retail' ? null : order.customerId])

			const items = order.items
				.map(it => ({ ...it, qty: round4(it.qty) }))
				.sort((a, b) => a.productId.localeCompare(b.productId))

			const actor = auth.memberName ?? auth.email ?? auth.userId
			const isRetail = !order.customerId || order.customerId === 'retail'
			const isCredit = order.onCredit && !isRetail

			// Коды маркировки: проверяем до создания документа
			const products = new Map<string, { name: string; marked: boolean; codes: string[] }>()
			for (const item of items) {
				if (products.has(item.productId)) continue
				const { rows } = await client.query(
					`select name, marked, codes from products
					 where company_id = $1 and id = $2 and deleted_at is null`,
					[auth.companyId, item.productId],
				)
				const row = rows[0]
				if (!row) throw Errors.notFound(`Товар ${item.productId}`)
				products.set(item.productId, {
					name: row.name,
					marked: !!row.marked,
					codes: Array.isArray(row.codes) ? row.codes.map((c: unknown) => String(c)) : [],
				})
			}

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
				const codePool = new Set(p.codes)
				const missing = uniq.filter(c => !codePool.has(c))
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

			// Суммы пересчитываем на сервере
			const subtotal = round2(items.reduce((sum, it) => sum + it.qty * it.price, 0))
			const discount = round2(order.discount)
			const total = round2(subtotal - discount)
			if (total < -0.000001) throw Errors.validation([{ message: 'Скидка больше суммы чека' }])

			// V2 fixes the explicit warehouse; legacy retains default selection.
			const { rows: whs } = v2 ? await client.query(
				`select id from warehouses where company_id=$1 and id=$2 and deleted_at is null for share`,
				[auth.companyId, warehouse],
			) : await client.query(
				`select id from warehouses where company_id = $1 and deleted_at is null order by id limit 1`, [auth.companyId])
			if (v2 && !whs.length) throw new ApiError(422, 'SALE_WAREHOUSE_UNAVAILABLE', 'Склад недоступен для новой продажи')
			const warehouseId = whs[0]?.id ?? null

			// Счёт денег по умолчанию (для retail_receipt)
			let accountId: string | null = null
			if (!isCredit) {
				const { rows: accs } = await client.query(
					`select id from money_accounts where company_id = $1 and deleted_at is null order by is_default desc, id limit 1`,
					[auth.companyId],
				)
				accountId = accs[0]?.id ?? null
			}

			const docId = `sale-${order.id}`
			const docType = isRetail ? 'retail_receipt' : 'sales_shipment'
			const hasParty = !isRetail

			await client.query(
				`insert into docs (company_id, id, doc_type, warehouse_id, party_kind, party_id,
				                   account_id, price_type_id, order_id, discount, "by")
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
				[
					auth.companyId, docId, docType, warehouseId,
					hasParty ? 'customer' : null,
					hasParty ? order.customerId : null,
					accountId,
					order.priceTypeId ?? null,
					order.id,
					discount,
					actor,
				],
			)

			for (const [i, item] of items.entries()) {
				const factor = item.unitFactor ?? 1
				const qtyBase = round4(item.qty * factor)
				await client.query(
					`insert into doc_lines (company_id, id, doc_id, line_no, product_id, unit_id, unit_factor,
					                        qty_input, qty, price)
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
					[
						auth.companyId, `${docId}-${i}`, docId, i, item.productId,
						item.unitId ?? null, factor, item.qty, qtyBase, item.price,
					],
				)
			}

			try {
				await client.query('select post_doc($1,$2)', [auth.companyId, docId])
			} catch (err) {
				throw mapPgError(err, request.log)
			}

			// Наличная продажа реальному клиенту: sales_shipment создал долг,
			// payment_in тут же гасит его и кладёт деньги в кассу.
			if (!isCredit && !isRetail) {
				const payDocId = `pay-${order.id}`
				await client.query(
					`insert into docs (company_id, id, doc_type, party_kind, party_id, account_id, amount, "by")
					 values ($1,$2,'payment_in','customer',$3,$4,$5,$6)`,
					[auth.companyId, payDocId, order.customerId, accountId, total, actor],
				)
				try {
					await client.query('select post_doc($1,$2)', [auth.companyId, payDocId])
				} catch (err) {
					throw mapPgError(err, request.log)
				}
			}

			// Коды маркировки: списываем из products.codes
			for (const [productId, codes] of consumedCodes) {
				const p = products.get(productId)!
				const consumedSet = new Set(codes)
				const nextCodes = p.codes.filter(c => !consumedSet.has(c))
				await client.query(
					`update products set codes = $3 where company_id = $1 and id = $2`,
					[auth.companyId, productId, JSON.stringify(nextCodes)],
				)
			}
			// Для маркированных без явных кодов — снимаем первые N
			const totalsByProduct = new Map<string, number>()
			for (const item of items) {
				totalsByProduct.set(item.productId, round4((totalsByProduct.get(item.productId) ?? 0) + item.qty))
			}
			for (const [productId, qty] of totalsByProduct) {
				const p = products.get(productId)!
				if (p.marked && !consumedCodes.has(productId) && p.codes.length > 0) {
					const nextCodes = p.codes.slice(Math.min(p.codes.length, Math.ceil(qty)))
					await client.query(
						`update products set codes = $3 where company_id = $1 and id = $2`,
						[auth.companyId, productId, JSON.stringify(nextCodes)],
					)
				}
			}

			// Сохраняем в orders для совместимости с текущим фронтом.
			// on conflict do update: если sync/push успел раньше и оставил
			// заглушку со status='new', перезаписываем на 'delivered' —
			// это единственный источник истины для розничного чека.
			// docs/doc_lines уже вставлены выше и post_doc() успешно списал
			// остатки; отсутствие идемпотентности через сам INSERT в orders
			// закрыто через claimIdempotencyKey — второй /v1/sales с тем же
			// idem-ключом сюда не доходит.
			const enrichedItems = items.map(it => ({ ...it }))
			// shipment_doc_id — серверный маркер «заказ ушёл документным путём».
			// Клиент получает его через pull: без него свежая вкладка не знала бы,
			// что отмена этого заказа должна идти через /v1/orders/:id/status.
			await client.query(
				`insert into orders
				   (company_id, id, no, customer_id, customer_name, items, subtotal, discount, total,
				    price_type_id, on_credit, status, stock_consumed, shift_id, track, shipment_doc_id)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'delivered',true,$12,$13,$14)
				 on conflict (company_id, id) do update set
				   no = coalesce(orders.no, excluded.no),
				   customer_id = coalesce(orders.customer_id, excluded.customer_id),
				   customer_name = coalesce(orders.customer_name, excluded.customer_name),
				   items = excluded.items,
				   subtotal = excluded.subtotal,
				   discount = excluded.discount,
				   total = excluded.total,
				   price_type_id = coalesce(orders.price_type_id, excluded.price_type_id),
				   on_credit = excluded.on_credit,
				   status = 'delivered',
				   stock_consumed = true,
				   shift_id = coalesce(orders.shift_id, excluded.shift_id),
				   track = excluded.track,
				   shipment_doc_id = excluded.shipment_doc_id`,
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
					JSON.stringify(order.track ?? [{ type: 'paid', at: new Date().toISOString(), by: actor }]),
					docId,
				],
			)

			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'sales', 'sale')`,
				[auth.companyId, randomUUID(), actor, `Продажа №${order.no ?? order.id} на ${total}`],
			)

			const body = { ok: true, order: { id: order.id, no: order.no ?? null, subtotal, discount, total },
				...(v2 ? { contractVersion: 2, documentId: docId, warehouseId, fingerprint,
					items: items.map((item, i) => ({ saleLineId: `${docId}-${i}`, productId: item.productId,
						qtyBase: round4(item.qty * (item.unitFactor ?? 1)).toFixed(4) })) } : {}) }
			if (v2) await client.query('update docs set source_payload=$3 where company_id=$1 and id=$2',
				[auth.companyId, docId, JSON.stringify({ kind: 'sale-v2', request: permanentRequest, fingerprint, result: body })])
			await storeIdempotentResponse(client, auth.companyId, idemKey, 201, body)
			return { status: 201, body, replayed: false }
		})

		if (result.replayed) reply.header('idempotency-replayed', 'true')
		reply.code(result.status)
		if (!result.replayed) {
			publishEvent(pool, { companyId: auth.companyId, type: 'sale', id: bodyParsed.data.order.id, senderUserId: auth.userId })
		}
		return result.body
	})
}

function round2(n: number): number {
	return Math.round(n * 100) / 100
}
