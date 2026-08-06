import { describe, expect, it, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import {
	effectivePlan,
	extendPaidUntil,
	invalidateSubscriptionCache,
	PLAN_LIMITS,
	trialDaysLeft,
	type Subscription,
} from '../src/services/subscription.js'
import { authHeaders, baseHandler, COMPANY_ID, makeFakePool, makeTestApp, testConfig } from './helpers.js'

// Кеш подписок — модульная переменная в src/lib/subscription.ts. Между
// тестами чистим, иначе первый тест кэширует sub и следующие получают
// его же вместо своих хендлеров.
beforeEach(() => invalidateSubscriptionCache())

describe('effectivePlan', () => {
	const now = new Date('2026-08-01T00:00:00.000Z')

	it('null → free', () => {
		expect(effectivePlan(null, now)).toBe('free')
	})

	it('trial активный → trial', () => {
		const sub: Subscription = {
			companyId: 'c',
			plan: 'trial',
			status: 'trial',
			trialStartedAt: '2026-07-25T00:00:00.000Z',
			trialEndsAt: '2026-08-08T00:00:00.000Z',
			paidUntil: null,
			externalCustomerId: null,
			externalSubscriptionId: null,
		}
		expect(effectivePlan(sub, now)).toBe('trial')
	})

	it('trial истёк → free', () => {
		const sub: Subscription = {
			companyId: 'c', plan: 'trial', status: 'trial',
			trialStartedAt: '2026-07-01T00:00:00.000Z',
			trialEndsAt: '2026-07-15T00:00:00.000Z',
			paidUntil: null,
			externalCustomerId: null, externalSubscriptionId: null,
		}
		expect(effectivePlan(sub, now)).toBe('free')
	})

	it('оплата активна → выбранный план', () => {
		const sub: Subscription = {
			companyId: 'c', plan: 'business', status: 'active',
			trialStartedAt: '2026-05-01T00:00:00.000Z',
			trialEndsAt: '2026-05-15T00:00:00.000Z',
			paidUntil: '2027-01-01T00:00:00.000Z',
			externalCustomerId: null, externalSubscriptionId: null,
		}
		expect(effectivePlan(sub, now)).toBe('business')
	})

	it('оплата истекла → free', () => {
		const sub: Subscription = {
			companyId: 'c', plan: 'business', status: 'past_due',
			trialStartedAt: '2026-05-01T00:00:00.000Z',
			trialEndsAt: '2026-05-15T00:00:00.000Z',
			paidUntil: '2026-07-01T00:00:00.000Z',
			externalCustomerId: null, externalSubscriptionId: null,
		}
		expect(effectivePlan(sub, now)).toBe('free')
	})
})

describe('trialDaysLeft', () => {
	it('оставшиеся дни округляются вверх', () => {
		const sub: Subscription = {
			companyId: 'c', plan: 'trial', status: 'trial',
			trialStartedAt: '2026-07-25T00:00:00.000Z',
			trialEndsAt: '2026-08-08T12:00:00.000Z',
			paidUntil: null, externalCustomerId: null, externalSubscriptionId: null,
		}
		expect(trialDaysLeft(sub, new Date('2026-08-01T00:00:00.000Z'))).toBe(8)
	})
})

describe('extendPaidUntil', () => {
	it('null → now + N мес', () => {
		const now = new Date('2026-08-01T00:00:00.000Z')
		const r = extendPaidUntil(null, 3, now)
		expect(r.toISOString()).toBe('2026-11-01T00:00:00.000Z')
	})

	it('плюсует к будущему paid_until (продление)', () => {
		const now = new Date('2026-08-01T00:00:00.000Z')
		const r = extendPaidUntil(new Date('2026-09-15T00:00:00.000Z'), 2, now)
		expect(r.toISOString()).toBe('2026-11-15T00:00:00.000Z')
	})

	it('прошедший paid_until — берёт now', () => {
		const now = new Date('2026-08-01T00:00:00.000Z')
		const r = extendPaidUntil(new Date('2026-05-01T00:00:00.000Z'), 1, now)
		expect(r.toISOString()).toBe('2026-09-01T00:00:00.000Z')
	})
})

describe('GET /v1/subscription', () => {
	it('возвращает план + лимиты + prices', async () => {
		const { app } = await makeTestApp({
			handler: (sql) => {
				if (sql.includes('from subscriptions where company_id')) {
					return [{
						company_id: COMPANY_ID,
						plan: 'trial',
						status: 'trial',
						trial_started_at: new Date('2026-07-25T00:00:00.000Z'),
						trial_ends_at: new Date('2100-01-01T00:00:00.000Z'),
						paid_until: null,
						external_customer_id: null,
						external_subscription_id: null,
					}]
				}
				return undefined
			},
		})
		const res = await app.inject({ method: 'GET', url: '/v1/subscription', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		const body = res.json() as { effectivePlan: string; limits: { label: string }; plans: Record<string, unknown> }
		expect(body.effectivePlan).toBe('trial')
		expect(body.limits.label).toBe('Триал')
		expect(body.plans.business).toBeTruthy()
	})
})

describe('POST /v1/subscription/checkout', () => {
	it('без ЮKassa-ключей → 503 BILLING_DISABLED', async () => {
		const { app } = await makeTestApp({
			handler: (sql) => {
				if (sql.includes('from subscriptions where company_id')) return []
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/subscription/checkout',
			headers: await authHeaders(),
			payload: { plan: 'business', periodMonths: 1 },
		})
		expect(res.statusCode).toBe(503)
		expect(res.json().error.code).toBe('BILLING_DISABLED')
	})

	it('роль stock не может стартовать оплату → 403', async () => {
		const { app } = await makeTestApp({
			handler: () => undefined,
			membership: { company_id: COMPANY_ID, role: 'stock', name: 'Кладовщик' },
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/subscription/checkout',
			headers: await authHeaders(),
			payload: { plan: 'business', periodMonths: 1 },
		})
		expect(res.statusCode).toBe(403)
	})
})

describe('POST /v1/subscription/webhook/yookassa', () => {
	it('payment.succeeded → инсертит запись + апдейтит подписку', async () => {
		const events: { sql: string; params: unknown[] }[] = []
		const { pool } = makeFakePool((sql, params) => {
			events.push({ sql, params })
			if (sql.includes('insert into subscription_payments')) return []
			if (sql.includes('from subscriptions where company_id = $1 for update')) {
				return [{ paid_until: null }]
			}
			if (sql.includes('update subscriptions')) return []
			if (sql.includes('insert into security_events')) return []
			return undefined
		})
		const app = await buildApp({ config: testConfig, pool, eventBus: null })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/subscription/webhook/yookassa',
			payload: {
				event: 'payment.succeeded',
				object: {
					id: 'pay_abc123',
					status: 'succeeded',
					amount: { value: '2990.00', currency: 'RUB' },
					metadata: { companyId: COMPANY_ID, plan: 'business', periodMonths: '1' },
				},
			},
		})
		expect(res.statusCode).toBe(200)
		const insertCalls = events.filter(e => e.sql.includes('insert into subscription_payments'))
		const updateCalls = events.filter(e => e.sql.includes('update subscriptions'))
		expect(insertCalls).toHaveLength(1)
		expect(updateCalls).toHaveLength(1)
		expect(insertCalls[0]?.params[1]).toBe('pay_abc123')
		expect(insertCalls[0]?.params[3]).toBe('RUB')
		expect(insertCalls[0]?.params[4]).toBe('business')
	})

	it('duplicate 23505 — не роняет webhook (200 OK)', async () => {
		const { pool } = makeFakePool((sql) => {
			if (sql.includes('insert into subscription_payments')) {
				const err = new Error('duplicate') as Error & { code?: string }
				err.code = '23505'
				throw err
			}
			return undefined
		})
		const app = await buildApp({ config: testConfig, pool, eventBus: null })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/subscription/webhook/yookassa',
			payload: {
				event: 'payment.succeeded',
				object: {
					id: 'pay_dup',
					status: 'succeeded',
					amount: { value: '2990.00', currency: 'RUB' },
					metadata: { companyId: COMPANY_ID, plan: 'business', periodMonths: '1' },
				},
			},
		})
		expect(res.statusCode).toBe(200)
	})

	it('event != payment.succeeded → пропуск', async () => {
		const events: string[] = []
		const { pool } = makeFakePool((sql) => {
			events.push(sql)
			return undefined
		})
		const app = await buildApp({ config: testConfig, pool, eventBus: null })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/subscription/webhook/yookassa',
			payload: {
				event: 'payment.canceled',
				object: {
					id: 'p', status: 'canceled',
					amount: { value: '1.00', currency: 'RUB' },
					metadata: { companyId: COMPANY_ID, plan: 'business' },
				},
			},
		})
		expect(res.statusCode).toBe(200)
		expect(events.some(s => s.includes('insert into subscription_payments'))).toBe(false)
	})

	it('IP не в whitelist → 403', async () => {
		const { pool } = makeFakePool(() => undefined)
		const app = await buildApp({
			config: { ...testConfig, YOOKASSA_WEBHOOK_IP_WHITELIST: '203.0.113.1,203.0.113.2' },
			pool,
			eventBus: null,
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/subscription/webhook/yookassa',
			payload: { event: 'payment.succeeded', object: { id: 'x', status: 'succeeded', amount: { value: '1', currency: 'RUB' }, metadata: {} } },
		})
		expect(res.statusCode).toBe(403)
	})
})

describe('sync/push enforcement лимитов', () => {
	it('превышение products → 402 SUBSCRIPTION_LIMIT_EXCEEDED', async () => {
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from subscriptions where company_id')) {
					// free-план: 100 products, subscription с истёкшим trial
					return [{
						company_id: params[0],
						plan: 'free',
						status: 'trial',
						trial_started_at: new Date('2026-01-01T00:00:00.000Z'),
						trial_ends_at: new Date('2026-01-15T00:00:00.000Z'),
						paid_until: null,
						external_customer_id: null,
						external_subscription_id: null,
					}]
				}
				// LWW-select: строки нет (новый продукт)
				if (sql.includes('select updated_at, deleted_at')) return []
				// подсчёт текущих товаров: уже 100
				if (sql.includes('select count(*)::int as c from products')) return [{ c: PLAN_LIMITS.free.products }]
				if (sql.includes('insert into products')) return []
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: {
				ops: [{
					table: 'products',
					op: 'upsert',
					row: { id: 'p-new-1', name: 'Новый', sku: 'X-1', price: 100, unit: 'шт' },
				}],
			},
		})
		expect(res.statusCode).toBe(207)
		const body = res.json() as { results: Array<{ ok: boolean; code?: string }> }
		expect(body.results[0]?.ok).toBe(false)
		expect(body.results[0]?.code).toBe('SUBSCRIPTION_LIMIT_EXCEEDED')
	})

	it('update существующего товара — не проверяет лимит', async () => {
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from subscriptions where company_id')) {
					return [{
						company_id: params[0], plan: 'free', status: 'trial',
						trial_started_at: new Date(), trial_ends_at: new Date('2026-01-15'),
						paid_until: null, external_customer_id: null, external_subscription_id: null,
					}]
				}
				// строка есть — update
				if (sql.includes('select updated_at, deleted_at')) {
					return [{ updated_at: new Date('2026-07-01'), deleted_at: null, stock_consumed: null, status: null }]
				}
				if (sql.includes('insert into products')) return []
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: {
				ops: [{
					table: 'products',
					op: 'upsert',
					row: { id: 'p-existing', name: 'Обновлённый', sku: 'X', price: 200, unit: 'шт' },
				}],
			},
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().results[0]?.ok).toBe(true)
	})

	it('trial активный → лимиты Infinity → любой upsert проходит', async () => {
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from subscriptions where company_id')) {
					return [{
						company_id: params[0], plan: 'trial', status: 'trial',
						trial_started_at: new Date(),
						trial_ends_at: new Date('2100-01-01'),
						paid_until: null, external_customer_id: null, external_subscription_id: null,
					}]
				}
				if (sql.includes('select updated_at, deleted_at')) return []
				if (sql.includes('select count(*)::int as c from products')) return [{ c: 100_000 }]
				if (sql.includes('insert into products')) return []
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: {
				ops: [{
					table: 'products',
					op: 'upsert',
					row: { id: 'p-trial', name: 'Trial товар', sku: 'X', price: 1, unit: 'шт' },
				}],
			},
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().results[0]?.ok).toBe(true)
	})
})
