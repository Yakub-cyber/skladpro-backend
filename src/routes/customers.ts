import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors } from '../lib/errors.js'
import { publishEvent } from '../lib/events.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'

const PaymentBody = z.object({
	amount: z.number().positive().finite().max(1_000_000_000),
	// payment — приём денег от клиента (гасит долг).
	// adjustment — ручная корректировка (может увеличить или уменьшить долг).
	kind: z.enum(['payment', 'adjustment']).default('payment'),
	// Для adjustment amount может быть отрицательным семантически, поэтому берём
	// отдельный флаг направления. Для payment всегда −amount к балансу.
	direction: z.enum(['decrease', 'increase']).default('decrease'),
	note: z.string().max(500).optional(),
})

const CustomerIdParam = z.object({ id: z.string().min(1).max(64) })

/**
 * POST /v1/customers/:id/payments — приём оплаты от клиента / корректировка баланса.
 *  - Idempotency-Key обязателен: два касса-терминала не задваивают приём;
 *  - balance никогда не уходит в минус (greatest(0, …));
 *  - пишет audit-запись, чтобы историю платежей было видно.
 */
export function registerCustomerRoutes(app: FastifyInstance, pool: DbPool) {
	app.post('/v1/customers/:id/payments', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (auth.role === 'courier') throw Errors.forbidden('Курьеру оплаты недоступны')

		const keyParsed = IdempotencyKey.safeParse(request.headers['idempotency-key'])
		if (!keyParsed.success) throw Errors.validation(keyParsed.error.issues)
		const idemKey = keyParsed.data

		const paramsParsed = CustomerIdParam.safeParse(request.params)
		if (!paramsParsed.success) throw Errors.validation(paramsParsed.error.issues)
		const customerId = paramsParsed.data.id

		const bodyParsed = PaymentBody.safeParse(request.body)
		if (!bodyParsed.success) throw Errors.validation(bodyParsed.error.issues)
		const { amount, kind, direction, note } = bodyParsed.data

		const result = await withTransaction(pool, async client => {
			const claim = await claimIdempotencyKey(client, {
				key: idemKey,
				companyId: auth.companyId,
				endpoint: 'POST /v1/customers/payments',
			})
			if (claim.replay) return { status: claim.status, body: claim.response, replayed: true }

			// FOR UPDATE — два одновременных приёма не наступают друг на друга.
			const { rows } = await client.query(
				`select id, name, balance from customers
				 where company_id = $1 and id = $2 and deleted_at is null
				 for update`,
				[auth.companyId, customerId],
			)
			const c = rows[0]
			if (!c) throw Errors.notFound(`Клиент ${customerId}`)

			const delta = direction === 'increase' ? +amount : -amount
			const before = Number(c.balance ?? 0)
			// greatest(0, ...) — балансу нельзя быть отрицательным.
			// Если платёж больше долга — переплата уходит в audit (для наглядности).
			const nextBalance = Math.max(0, Math.round((before + delta) * 100) / 100)

			await client.query(
				`update customers set balance = $3
				 where company_id = $1 and id = $2`,
				[auth.companyId, customerId, nextBalance],
			)

			const actor = auth.memberName ?? auth.email ?? auth.userId
			const title =
				kind === 'payment'
					? `Оплата от «${c.name}»: ${amount} ₽ (долг: ${before} → ${nextBalance})`
					: `Корректировка баланса «${c.name}»: ${direction === 'increase' ? '+' : '−'}${amount} ₽ (${before} → ${nextBalance})`
			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'finance', $5)`,
				[auth.companyId, randomUUID(), actor, title + (note ? ` — ${note}` : ''), kind],
			)

			const body = {
				ok: true,
				customer: { id: customerId, balanceBefore: before, balanceAfter: nextBalance, applied: nextBalance - before },
			}
			await storeIdempotentResponse(client, auth.companyId, idemKey, 201, body)
			return { status: 201, body, replayed: false }
		})

		if (result.replayed) reply.header('idempotency-replayed', 'true')
		reply.code(result.status)
		if (!result.replayed) {
			publishEvent(pool, { companyId: auth.companyId, type: 'payment', id: customerId, senderUserId: auth.userId })
		}
		return result.body
	})
}
