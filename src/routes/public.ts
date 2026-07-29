import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'

/**
 * Публичный REST API — авторизация только по X-API-Key.
 * Scope-guard проверяет `request.auth.apiKey.scopes` — если у ключа нет
 * нужного разрешения, 403.
 *
 * URL-префикс `/v1/public/*` — эти маршруты не пересекаются с внутренними
 * JWT-эндпоинтами; клиенты, читающие /v1/products, не могут случайно попасть
 * сюда.
 */

function requireScope(request: { auth: { apiKey?: { scopes: string[] } } }, scope: string) {
	if (!request.auth.apiKey?.scopes.includes(scope)) throw Errors.forbidden(`Ключу не выдан scope «${scope}»`)
}

const OrderCreateBody = z.object({
	customerId: z.string().uuid(),
	items: z.array(z.object({
		productId: z.string().uuid(),
		qty: z.number().positive(),
		price: z.number().nonnegative(),
	})).min(1),
	note: z.string().max(500).optional(),
})

export function registerPublicRoutes(app: FastifyInstance, pool: DbPool) {
	// ── /v1/public/products ─────────────────────────────────────────────
	app.get('/v1/public/products', { preHandler: app.authenticateApiKey }, async request => {
		requireScope(request, 'products:read')
		const q = (request.query as { limit?: string; offset?: string }) || {}
		const limit = Math.min(500, Math.max(1, Number(q.limit) || 100))
		const offset = Math.max(0, Number(q.offset) || 0)
		const { rows } = await pool.query(
			`select id, sku, name, category, unit, price, stock, barcode, updated_at
			 from products
			 where company_id = $1 and deleted_at is null
			 order by name asc
			 limit $2 offset $3`,
			[request.auth.companyId, limit, offset],
		)
		return { products: rows, limit, offset }
	})

	app.get('/v1/public/products/:id', { preHandler: app.authenticateApiKey }, async request => {
		requireScope(request, 'products:read')
		const id = (request.params as { id: string }).id
		const { rows } = await pool.query(
			`select id, sku, name, category, unit, price, stock, barcode, updated_at
			 from products where company_id = $1 and id = $2 and deleted_at is null`,
			[request.auth.companyId, id],
		)
		const row = rows[0]
		if (!row) throw Errors.notFound('Товар')
		return { product: row }
	})

	// ── /v1/public/customers ────────────────────────────────────────────
	app.get('/v1/public/customers', { preHandler: app.authenticateApiKey }, async request => {
		requireScope(request, 'customers:read')
		const q = (request.query as { limit?: string; offset?: string }) || {}
		const limit = Math.min(500, Math.max(1, Number(q.limit) || 100))
		const offset = Math.max(0, Number(q.offset) || 0)
		const { rows } = await pool.query(
			`select id, name, phone, email, city, updated_at
			 from customers where company_id = $1 and deleted_at is null
			 order by name asc
			 limit $2 offset $3`,
			[request.auth.companyId, limit, offset],
		)
		return { customers: rows, limit, offset }
	})

	// ── /v1/public/orders (создать заказ) ───────────────────────────────
	app.post('/v1/public/orders', { preHandler: app.authenticateApiKey }, async (request, reply) => {
		requireScope(request, 'orders:write')
		const idemKey = request.headers['idempotency-key'] as string | undefined
		if (!idemKey) throw Errors.validation([{ message: 'Idempotency-Key обязателен' }])
		const parsed = OrderCreateBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const body = parsed.data

		// Проверяем клиента и товары в БД
		const { rows: cRows } = await pool.query(
			`select id, name from customers where company_id = $1 and id = $2 and deleted_at is null`,
			[request.auth.companyId, body.customerId],
		)
		if (!cRows[0]) throw Errors.notFound('Клиент')
		const customerName = cRows[0].name as string

		const productIds = [...new Set(body.items.map(it => it.productId))]
		const { rows: pRows } = await pool.query(
			`select id, name from products where company_id = $1 and id = any($2) and deleted_at is null`,
			[request.auth.companyId, productIds],
		)
		const nameById = new Map(pRows.map(r => [r.id as string, r.name as string]))
		if (nameById.size !== productIds.length) throw Errors.notFound('Товар из заказа')

		// Простая идемпотентность через unique-индекс idempotency_keys —
		// не будем крутить transaction для read-only-эффекта, но конфликт
		// поймём.
		try {
			await pool.query(
				`insert into idempotency_keys (company_id, key, endpoint) values ($1, $2, '/v1/public/orders')`,
				[request.auth.companyId, idemKey],
			)
		} catch (e) {
			const err = e as { code?: string }
			if (err.code === '23505') {
				const { rows: prev } = await pool.query(
					`select response, status, endpoint from idempotency_keys
					 where company_id = $1 and key = $2`,
					[request.auth.companyId, idemKey],
				)
				const row = prev[0]
				if (!row) throw Errors.inProgress()
				if (row.endpoint !== '/v1/public/orders') throw Errors.idempotencyMismatch(row.endpoint, '/v1/public/orders')
				if (row.response == null) throw Errors.inProgress()
				reply.code(row.status ?? 200)
				return row.response
			}
			throw e
		}

		const total = body.items.reduce((s, it) => s + it.qty * it.price, 0)
		const items = body.items.map(it => ({
			productId: it.productId,
			name: nameById.get(it.productId) ?? '',
			qty: it.qty,
			price: it.price,
			sum: it.qty * it.price,
		}))
		const { rows: oRows } = await pool.query(
			`insert into orders (company_id, customer_id, customer_name, subtotal, total, note, source)
			 values ($1, $2, $3, $4, $4, $5, 'api')
			 returning id, no, created_at`,
			[request.auth.companyId, body.customerId, customerName, total, body.note ?? null],
		)
		const orderId = oRows[0].id as string
		// Сохраняем items в отдельной таблице ИЛИ jsonb — зависит от текущей
		// схемы. В нашем случае items лежат в orders.items (jsonb) — обновим.
		await pool.query(
			`update orders set items = $3 where company_id = $1 and id = $2`,
			[request.auth.companyId, orderId, JSON.stringify(items)],
		)
		const responseBody = { orderId, no: oRows[0].no, createdAt: oRows[0].created_at, total }
		await pool.query(
			`update idempotency_keys set response = $3, status = 201
			 where company_id = $1 and key = $2`,
			[request.auth.companyId, idemKey, JSON.stringify(responseBody)],
		)
		reply.code(201)
		return responseBody
	})

	app.get('/v1/public/orders/:id/status', { preHandler: app.authenticateApiKey }, async request => {
		requireScope(request, 'orders:read')
		const id = (request.params as { id: string }).id
		const { rows } = await pool.query(
			`select id, no, status, total, created_at
			 from orders where company_id = $1 and id = $2 and deleted_at is null`,
			[request.auth.companyId, id],
		)
		if (!rows[0]) throw Errors.notFound('Заказ')
		return { order: rows[0] }
	})
}
