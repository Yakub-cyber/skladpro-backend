import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors } from '../lib/errors.js'
import { publishEvent } from '../lib/events.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'

const ProductIdParam = z.object({ id: z.string().min(1).max(64) })

const MarkCodesBody = z.object({
	// action=add — приёмка: добавляем коды в пул.
	// action=remove — коррекция: убираем указанные коды (или обнуляем пул при
	// пустых кодах со специальным флагом clearAll).
	action: z.enum(['add', 'remove']),
	codes: z.array(z.string().min(1).max(300)).min(1).max(1000),
})

/**
 * POST /v1/products/:id/mark-codes — атомарное управление пулом кодов
 * маркировки «Честный знак» (products.codes).
 *
 *  - action='add': коды из body добавляются, дубликаты пропускаются;
 *  - action='remove': коды из body удаляются, не найденные — молча пропускаем.
 *
 * FOR UPDATE защищает от гонки между приёмкой и продажей на другой кассе.
 * Idempotency-Key обязателен — приёмка коробки не должна задваиваться при ретрае.
 */
export function registerProductRoutes(app: FastifyInstance, pool: DbPool) {
	app.post('/v1/products/:id/mark-codes', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (auth.role === 'courier') throw Errors.forbidden('Курьеру недоступно')

		const keyParsed = IdempotencyKey.safeParse(request.headers['idempotency-key'])
		if (!keyParsed.success) throw Errors.validation(keyParsed.error.issues)
		const idemKey = keyParsed.data

		const paramsParsed = ProductIdParam.safeParse(request.params)
		if (!paramsParsed.success) throw Errors.validation(paramsParsed.error.issues)
		const productId = paramsParsed.data.id

		const bodyParsed = MarkCodesBody.safeParse(request.body)
		if (!bodyParsed.success) throw Errors.validation(bodyParsed.error.issues)
		const { action, codes } = bodyParsed.data

		// Внутри батча дубликаты сразу отсекаем — иначе идентичный код
		// прошёл бы дважды с некорректной семантикой.
		const uniq = Array.from(new Set(codes))

		const result = await withTransaction(pool, async client => {
			const claim = await claimIdempotencyKey(client, {
				key: idemKey,
				companyId: auth.companyId,
				endpoint: 'POST /v1/products/mark-codes',
			})
			if (claim.replay) return { status: claim.status, body: claim.response, replayed: true }

			const { rows } = await client.query(
				`select id, name, marked, codes from products
				 where company_id = $1 and id = $2 and deleted_at is null
				 for update`,
				[auth.companyId, productId],
			)
			const p = rows[0]
			if (!p) throw Errors.notFound(`Товар ${productId}`)
			if (!p.marked) throw Errors.validation([{ message: 'Товар не помечен как маркированный' }])

			const existing = new Set<string>(Array.isArray(p.codes) ? p.codes.map((c: unknown) => String(c)) : [])
			let added = 0
			let removed = 0
			if (action === 'add') {
				for (const c of uniq) if (!existing.has(c)) { existing.add(c); added++ }
			} else {
				for (const c of uniq) if (existing.has(c)) { existing.delete(c); removed++ }
			}
			const nextCodes = Array.from(existing)

			await client.query(
				`update products set codes = $3 where company_id = $1 and id = $2`,
				[auth.companyId, productId, JSON.stringify(nextCodes)],
			)

			const actor = auth.memberName ?? auth.email ?? auth.userId
			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'marking', $5)`,
				[
					auth.companyId,
					randomUUID(),
					actor,
					action === 'add'
						? `Маркировка: принято ${added} КМ для «${p.name}»`
						: `Маркировка: снято ${removed} КМ для «${p.name}»`,
					action,
				],
			)

			const body = { ok: true, productId, action, added, removed, poolSize: nextCodes.length }
			await storeIdempotentResponse(client, auth.companyId, idemKey, 201, body)
			return { status: 201, body, replayed: false }
		})

		if (result.replayed) reply.header('idempotency-replayed', 'true')
		reply.code(result.status)
		if (!result.replayed) {
			publishEvent(pool, { companyId: auth.companyId, type: 'mark_codes', id: productId, senderUserId: auth.userId })
		}
		return result.body
	})
}
