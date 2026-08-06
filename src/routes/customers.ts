import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors, mapPgError } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'

const PaymentBody = z.object({
	amount: z.number().positive().finite().max(1_000_000_000),
	kind: z.enum(['payment', 'adjustment']).default('payment'),
	direction: z.enum(['decrease', 'increase']).default('decrease'),
	note: z.string().max(500).optional(),
})

const CustomerIdParam = z.object({ id: z.string().min(1).max(64) })

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

			const { rows } = await client.query(
				`select id, name, balance from customers
				 where company_id = $1 and id = $2 and deleted_at is null`,
				[auth.companyId, customerId],
			)
			const c = rows[0]
			if (!c) throw Errors.notFound(`Клиент ${customerId}`)

			const actor = auth.memberName ?? auth.email ?? auth.userId
			const before = Number(c.balance ?? 0)

			// Счёт денег по умолчанию
			const { rows: accs } = await client.query(
				`select id from money_accounts where company_id = $1 and deleted_at is null order by is_default desc, id limit 1`,
				[auth.companyId],
			)
			const accountId = accs[0]?.id ?? null

			if (kind === 'payment') {
				// payment_in: деньги +, долг клиента −
				const docId = `pay-${customerId}-${Date.now()}`
				await client.query(
					`insert into docs (company_id, id, doc_type, party_kind, party_id, account_id, amount, note, "by")
					 values ($1,$2,'payment_in','customer',$3,$4,$5,$6,$7)`,
					[auth.companyId, docId, customerId, accountId, amount, note ?? null, actor],
				)
				try {
					await client.query('select post_doc($1,$2)', [auth.companyId, docId])
				} catch (err) {
					throw mapPgError(err)
				}
			} else {
				// adjustment → opening_settlement со знаковой суммой
				const signedAmount = direction === 'increase' ? amount : -amount
				const docId = `adj-${customerId}-${Date.now()}`
				await client.query(
					`insert into docs (company_id, id, doc_type, party_kind, party_id, amount, note, "by")
					 values ($1,$2,'opening_settlement','customer',$3,$4,$5,$6)`,
					[auth.companyId, docId, customerId, signedAmount, note ?? null, actor],
				)
				try {
					await client.query('select post_doc($1,$2)', [auth.companyId, docId])
				} catch (err) {
					throw mapPgError(err)
				}
			}

			// Перечитываем баланс после проводки
			const { rows: afterRows } = await client.query(
				`select balance from customers where company_id = $1 and id = $2`,
				[auth.companyId, customerId],
			)
			const nextBalance = Number(afterRows[0]?.balance ?? 0)

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
