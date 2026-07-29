import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors } from '../lib/errors.js'
import { fromRequest, logSecurityEvent } from '../lib/security-log.js'
import {
	effectivePlan,
	extendPaidUntil,
	getSubscription,
	invalidateSubscriptionCache,
	PLAN_LIMITS,
	trialDaysLeft,
	type Plan,
} from '../lib/subscription.js'
import { makeYooKassa, PLAN_PRICES_RUB, type YooKassaClient } from '../lib/yookassa.js'

const CheckoutBody = z.object({
	plan: z.enum(['start', 'business', 'pro']),
	periodMonths: z.number().int().min(1).max(24).default(1),
})

// Payload webhook'а от ЮKassa. Только те поля, что реально используем.
// Полная схема: https://yookassa.ru/developers/api#notification_object
const WebhookPayload = z.object({
	event: z.string(),
	object: z.object({
		id: z.string(),
		status: z.string(),
		amount: z.object({ value: z.string(), currency: z.string() }),
		metadata: z.record(z.string()).optional(),
		paid: z.boolean().optional(),
	}),
})

const AdminSetBody = z.object({
	plan: z.enum(['trial', 'free', 'start', 'business', 'pro']),
	paidUntil: z.string().datetime().optional(),
	trialEndsAt: z.string().datetime().optional(),
	reason: z.string().min(1).max(500),
})

export function registerSubscriptionRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
	// Ленивая инициализация клиента ЮKassa: если ключи не заданы, checkout
	// вернёт 503, но GET /subscription и enforcement лимитов работают.
	let yookassa: YooKassaClient | null = null
	function yoo() {
		if (!yookassa) yookassa = makeYooKassa(config)
		return yookassa
	}

	// ── Клиент видит: сам план + сколько дней триала осталось ────────────
	app.get('/v1/subscription', { preHandler: app.authenticate }, async request => {
		const sub = await getSubscription(pool, request.auth.companyId)
		const eff = effectivePlan(sub)
		const trialLeft = sub ? trialDaysLeft(sub) : 0
		return {
			subscription: sub,
			effectivePlan: eff,
			limits: PLAN_LIMITS[eff],
			trialDaysLeft: Math.max(0, trialLeft),
			plans: {
				start: { price: PLAN_PRICES_RUB.start, limits: PLAN_LIMITS.start },
				business: { price: PLAN_PRICES_RUB.business, limits: PLAN_LIMITS.business },
				pro: { price: PLAN_PRICES_RUB.pro, limits: PLAN_LIMITS.pro },
			},
		}
	})

	// ── Создать чекаут-ссылку ЮKassa ────────────────────────────────────
	// Возвращает confirmation_url — фронт делает redirect. После успеха
	// ЮKassa POST'ит нам webhook, и мы обновляем paid_until.
	app.post('/v1/subscription/checkout', { preHandler: app.authenticate }, async request => {
		const parsed = CheckoutBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { plan, periodMonths } = parsed.data
		const auth = request.auth
		// Только admin может стартовать оплату — иначе кассир может «случайно»
		// нажать «оплатить бизнес» и списать деньги владельца.
		if (!['admin', 'manager'].includes(auth.role)) {
			throw Errors.forbidden('Оплата подписки доступна только администратору или менеджеру')
		}
		const y = yoo()
		if (!y.available) {
			throw new (await import('../lib/errors.js')).ApiError(503, 'BILLING_DISABLED', 'Приём онлайн-платежей не настроен на этом сервере. Обратитесь в поддержку для ручного оформления.')
		}
		const price = PLAN_PRICES_RUB[plan]
		if (!price) throw Errors.validation([{ message: `Нет цены для плана ${plan}` }])
		const returnUrl = config.YOOKASSA_RETURN_URL || 'https://yakub-cyber.github.io/skladpro/#/settings/subscription'
		const total = price * periodMonths

		// Idempotency-Key для ЮKassa: тот же ключ за 24ч не спишет дважды.
		// Составляем из companyId + plan + period + сутки, чтобы если клиент
		// ткнёт «оплатить» дважды в течение секунд, получил тот же платёж.
		const dayBucket = new Date().toISOString().slice(0, 10)
		const key = createHash('sha256')
			.update(`${auth.companyId}:${plan}:${periodMonths}:${dayBucket}`)
			.digest('hex')
			.slice(0, 32)

		const res = await y.createPayment(
			{
				amount: { value: total.toFixed(2), currency: 'RUB' },
				confirmation: { type: 'redirect', return_url: returnUrl },
				description: `SkladPro «${PLAN_LIMITS[plan].label}» × ${periodMonths} мес`,
				capture: true,
				metadata: {
					companyId: auth.companyId,
					plan,
					periodMonths: String(periodMonths),
					// initiator — для аудита, кто именно запустил платёж
					userId: auth.userId,
				},
			},
			key,
		)
		if (!res.confirmation?.confirmation_url) {
			throw new (await import('../lib/errors.js')).ApiError(502, 'BILLING_ERROR', 'ЮKassa не вернула ссылку оплаты')
		}
		return {
			paymentId: res.id,
			confirmationUrl: res.confirmation.confirmation_url,
			amount: res.amount,
			status: res.status,
		}
	})

	// ── Webhook от ЮKassa ────────────────────────────────────────────────
	// Без нашей авторизации: ЮKassa приходит с их IP. Защита от подделки:
	//  - опциональный IP-whitelist (config.YOOKASSA_WEBHOOK_IP_WHITELIST);
	//  - unique (external_provider, external_id) — replay даст 200 быстрым
	//    возвратом без повторной обработки.
	app.post('/v1/subscription/webhook/yookassa', async (request, reply) => {
		// IP-whitelist если задан
		if (config.YOOKASSA_WEBHOOK_IP_WHITELIST) {
			const whitelist = config.YOOKASSA_WEBHOOK_IP_WHITELIST.split(',').map(s => s.trim()).filter(Boolean)
			if (!whitelist.includes(request.ip)) {
				request.log.warn({ ip: request.ip }, 'yookassa webhook: ip not in whitelist')
				return reply.code(403).send({ error: 'IP not allowed' })
			}
		}
		const parsed = WebhookPayload.safeParse(request.body)
		if (!parsed.success) return reply.code(400).send({ error: 'Bad payload' })
		const { event, object: payment } = parsed.data
		// Интересуют только успешные платежи. Прочие события (canceled,
		// refunded) можно логировать, но не апдейтим план.
		if (event !== 'payment.succeeded' || payment.status !== 'succeeded') {
			return reply.code(200).send({ ok: true })
		}
		const metadata = payment.metadata ?? {}
		const companyId = metadata.companyId
		const plan = metadata.plan as Plan | undefined
		const periodMonths = Number(metadata.periodMonths || '1')
		if (!companyId || !plan || !(plan in PLAN_LIMITS) || plan === 'trial' || plan === 'free') {
			request.log.warn({ metadata }, 'yookassa webhook: bad metadata')
			return reply.code(200).send({ ok: true, warning: 'Bad metadata, skipped' })
		}

		// Атомарно: (1) записать платёж, (2) обновить subscriptions. Дубли
		// external_id разрулит unique-индекс — при повторе просто return 200.
		await withTransaction(pool, async client => {
			try {
				await client.query(
					`insert into subscription_payments
					   (company_id, external_id, external_provider, amount, currency, plan, period_months, status, metadata)
					 values ($1, $2, 'yookassa', $3, $4, $5, $6, 'succeeded', $7)`,
					[
						companyId,
						payment.id,
						Number(payment.amount.value),
						payment.amount.currency,
						plan,
						periodMonths,
						JSON.stringify(metadata),
					],
				)
			} catch (e) {
				const err = e as { code?: string }
				// 23505 = уже обработан. Не паникуем.
				if (err.code === '23505') return
				throw e
			}
			const { rows } = await client.query(
				`select paid_until from subscriptions where company_id = $1 for update`,
				[companyId],
			)
			const current = rows[0]?.paid_until ? new Date(rows[0].paid_until) : null
			const nextPaidUntil = extendPaidUntil(current, periodMonths)
			await client.query(
				`update subscriptions
				 set plan = $2, status = 'active', paid_until = $3
				 where company_id = $1`,
				[companyId, plan, nextPaidUntil],
			)
			invalidateSubscriptionCache(companyId)
		})
		await logSecurityEvent(pool, 'subscription_activated', fromRequest(request, {
			companyId,
			meta: { plan, periodMonths, paymentId: payment.id, amount: payment.amount.value },
		}))
		return reply.code(200).send({ ok: true })
	})

	// ── Super-admin ручное выставление плана ────────────────────────────
	// Для оплат по договору/счёту (юрлица платят раз в год, ЮKassa не участвует).
	app.post(
		'/v1/admin/subscriptions/:companyId',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async request => {
			const parsed = AdminSetBody.safeParse(request.body)
			if (!parsed.success) throw Errors.validation(parsed.error.issues)
			const { plan, paidUntil, trialEndsAt, reason } = parsed.data
			const companyId = (request.params as { companyId: string }).companyId
			await pool.query(
				`insert into subscriptions (company_id, plan, status, paid_until, trial_ends_at)
				 values ($1, $2, case when $3::timestamptz > now() then 'active' else 'trial' end,
				         $3::timestamptz, coalesce($4::timestamptz, now() + interval '14 days'))
				 on conflict (company_id) do update set
				   plan = excluded.plan,
				   status = excluded.status,
				   paid_until = coalesce(excluded.paid_until, subscriptions.paid_until),
				   trial_ends_at = coalesce(excluded.trial_ends_at, subscriptions.trial_ends_at)`,
				[companyId, plan, paidUntil ?? null, trialEndsAt ?? null],
			)
			invalidateSubscriptionCache(companyId)
			await logSecurityEvent(pool, 'subscription_admin_override', fromRequest(request, {
				companyId,
				meta: { plan, paidUntil, trialEndsAt, reason },
			}))
			return { ok: true }
		},
	)
}
