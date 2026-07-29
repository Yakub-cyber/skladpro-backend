import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'

/**
 * CRUD webhook-endpoints. Компания задаёт URL, набор событий, получает
 * secret (виден клиенту, но это НЕ криптосекрет — из него делаем HMAC).
 * URL должен быть https в prod (проверяется по NODE_ENV).
 */

export const KNOWN_EVENTS = [
	'sale.created',
	'order.status_changed',
	'return.created',
	'payment.created',
	'fiscal.ready',
] as const

const UpsertBody = z.object({
	name: z.string().min(1).max(200),
	url: z.string().url(),
	events: z.array(z.enum(KNOWN_EVENTS)).min(1),
	active: z.boolean().default(true),
})

export function registerWebhookRoutes(app: FastifyInstance, pool: DbPool) {
	app.get('/v1/webhooks/endpoints', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden()
		const { rows } = await pool.query(
			`select id, name, url, events, active, secret, created_at, last_delivery_at
			 from webhook_endpoints where company_id = $1
			 order by created_at desc`,
			[auth.companyId],
		)
		return {
			endpoints: rows.map(r => ({
				id: r.id, name: r.name, url: r.url, events: r.events, active: r.active,
				// Секрет отдаём (без него подписать нельзя проверить у себя).
				secret: r.secret,
				createdAt: r.created_at,
				lastDeliveryAt: r.last_delivery_at,
			})),
		}
	})

	app.post('/v1/webhooks/endpoints', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden()
		const parsed = UpsertBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const url = parsed.data.url
		if (process.env.NODE_ENV === 'production' && !url.startsWith('https://')) {
			throw Errors.validation([{ message: 'В production разрешены только https URL' }])
		}
		const secret = randomBytes(32).toString('base64url')
		const { rows } = await pool.query(
			`insert into webhook_endpoints (company_id, name, url, secret, events, active)
			 values ($1, $2, $3, $4, $5, $6)
			 returning id, created_at`,
			[auth.companyId, parsed.data.name, url, secret, parsed.data.events, parsed.data.active],
		)
		reply.code(201)
		return {
			id: rows[0].id,
			name: parsed.data.name,
			url,
			events: parsed.data.events,
			active: parsed.data.active,
			secret,
			createdAt: rows[0].created_at,
		}
	})

	app.put('/v1/webhooks/endpoints/:id', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden()
		const id = (request.params as { id: string }).id
		const parsed = UpsertBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { rowCount } = await pool.query(
			`update webhook_endpoints set name = $3, url = $4, events = $5, active = $6
			 where company_id = $1 and id = $2`,
			[auth.companyId, id, parsed.data.name, parsed.data.url, parsed.data.events, parsed.data.active],
		)
		if (!rowCount) throw Errors.notFound('Webhook endpoint')
		return { ok: true }
	})

	app.delete('/v1/webhooks/endpoints/:id', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden()
		const id = (request.params as { id: string }).id
		const { rowCount } = await pool.query(
			`delete from webhook_endpoints where company_id = $1 and id = $2`,
			[auth.companyId, id],
		)
		if (!rowCount) throw Errors.notFound('Webhook endpoint')
		return { ok: true }
	})
}
