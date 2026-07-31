import type { DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'
import type { Metrics } from './metrics.js'

// Модульный ref на счётчик 402. Инициализируется из buildApp
// вместе с security-log — чтобы не таскать Metrics через все вызовы.
let metricsRef: Metrics | null = null
export function bindSubscriptionMetrics(metrics: Metrics | null) {
	metricsRef = metrics
}

/**
 * Серверная модель подписки — источник истины.
 *
 * Раньше PLAN_LIMITS/effectivePlan жили только в веб-клиенте
 * (`skladpro/src/lib/subscription.js`). Локальное состояние обходилось
 * очисткой localStorage. Теперь сервер сам решает, что можно, а лимиты
 * проверяются в push/бизнес-эндпоинтах.
 */

export type Plan = 'trial' | 'free' | 'start' | 'business' | 'pro'
export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'canceled'

export type Subscription = {
	companyId: string
	plan: Plan
	status: SubscriptionStatus
	trialStartedAt: string
	trialEndsAt: string
	paidUntil: string | null
	externalCustomerId: string | null
	externalSubscriptionId: string | null
}

export type PlanLimits = {
	label: string
	warehouses: number  // Infinity нельзя в JSON — используем Number.MAX_SAFE_INTEGER
	employees: number
	products: number
	monthlyDocs: number
	aiMonthly: number
}

// Используем большое число вместо Infinity — иначе прожжёт при сравнении и JSON.
const INF = Number.MAX_SAFE_INTEGER

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
	trial: { label: 'Триал', warehouses: INF, employees: INF, products: INF, monthlyDocs: INF, aiMonthly: 30 },
	free: { label: 'Бесплатно', warehouses: 1, employees: 3, products: 100, monthlyDocs: 200, aiMonthly: 30 },
	start: { label: 'Старт', warehouses: 1, employees: 5, products: 2000, monthlyDocs: INF, aiMonthly: 400 },
	business: { label: 'Бизнес', warehouses: 3, employees: 15, products: INF, monthlyDocs: INF, aiMonthly: 2000 },
	pro: { label: 'Профи', warehouses: 10, employees: 50, products: INF, monthlyDocs: INF, aiMonthly: INF },
}

export const TRIAL_DAYS = 14

/**
 * Действующий на дату план: если триал не истёк — 'trial'; если платёж истёк
 * (paid_until в прошлом) — 'free'; иначе то, что выбрано. Функция чистая,
 * не трогает БД.
 */
export function effectivePlan(sub: Subscription | null | undefined, now: Date = new Date()): Plan {
	if (!sub) return 'free'
	const t = now.getTime()
	if (sub.plan === 'trial' || sub.status === 'trial') {
		return new Date(sub.trialEndsAt).getTime() > t ? 'trial' : 'free'
	}
	if (sub.paidUntil) {
		return new Date(sub.paidUntil).getTime() > t ? sub.plan : 'free'
	}
	return sub.plan
}

export function trialDaysLeft(sub: Subscription | null | undefined, now: Date = new Date()): number {
	if (!sub) return 0
	const ms = new Date(sub.trialEndsAt).getTime() - now.getTime()
	return Math.ceil(ms / 86_400_000)
}

// Кеш подписки на 60с — как memberships. Обновление плана после платежа
// займёт максимум минуту на всех инстансах.
type CacheEntry = { sub: Subscription | null; at: number }
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60 * 1000

export async function getSubscription(pool: DbPool, companyId: string, opts: { fresh?: boolean } = {}): Promise<Subscription | null> {
	if (!opts.fresh) {
		const c = cache.get(companyId)
		if (c && Date.now() - c.at < CACHE_TTL_MS) return c.sub
	}
	const { rows } = await pool.query(
		`select company_id, plan, status, trial_started_at, trial_ends_at,
		        paid_until, external_customer_id, external_subscription_id
		 from subscriptions where company_id = $1`,
		[companyId],
	)
	const row = rows[0]
	const sub: Subscription | null = row
		? {
			companyId: row.company_id,
			plan: row.plan,
			status: row.status,
			trialStartedAt: row.trial_started_at instanceof Date ? row.trial_started_at.toISOString() : String(row.trial_started_at),
			trialEndsAt: row.trial_ends_at instanceof Date ? row.trial_ends_at.toISOString() : String(row.trial_ends_at),
			paidUntil: row.paid_until instanceof Date ? row.paid_until.toISOString() : (row.paid_until ? String(row.paid_until) : null),
			externalCustomerId: row.external_customer_id ?? null,
			externalSubscriptionId: row.external_subscription_id ?? null,
		}
		: null
	cache.set(companyId, { sub, at: Date.now() })
	return sub
}

// Инвалидация кеша — при апдейте плана.
export function invalidateSubscriptionCache(companyId?: string) {
	if (companyId) cache.delete(companyId)
	else cache.clear()
}

/**
 * Считает количество активных записей и сравнивает с лимитом плана.
 * Используется в sync/push перед вставкой продукта/склада/сотрудника,
 * а также в бизнес-эндпоинтах.
 */
export type LimitFeature = 'products' | 'warehouses' | 'employees'

export async function checkLimit(
	pool: DbPool,
	companyId: string,
	feature: LimitFeature,
	countAfter: number,
): Promise<{ ok: true } | { ok: false; limit: number; current: number; plan: Plan }> {
	const sub = await getSubscription(pool, companyId)
	const plan = effectivePlan(sub)
	const limit = PLAN_LIMITS[plan][feature]
	if (countAfter <= limit) return { ok: true }
	return { ok: false, limit, current: countAfter, plan }
}

/**
 * Проверяет лимит и бросает ApiError 402, если он превышен. Одновременно
 * инкрементит prometheus-счётчик. Для использования из route-handler'ов,
 * которые готовы дать сервером-детальный error клиенту (веб-модалка
 * «пора апгрейд»).
 */
export async function checkLimitOrThrow(
	pool: DbPool,
	companyId: string,
	feature: LimitFeature,
	countAfter: number,
) {
	const res = await checkLimit(pool, companyId, feature, countAfter)
	if (!res.ok) {
		metricsRef?.subscriptionLimitExceeded.inc({ feature })
		throw Errors.subscriptionLimit(feature, res.limit, res.current, res.plan)
	}
}

/**
 * Продлевает paid_until на N месяцев. Простая арифметика JavaScript Date
 * (setMonth) — не работает с tz, но подписка билаемся с точностью до дня.
 * Если paid_until в будущем — плюсуем к нему; иначе — к текущей дате.
 */
export function extendPaidUntil(currentPaidUntil: Date | null, months: number, now: Date = new Date()): Date {
	const base = currentPaidUntil && currentPaidUntil.getTime() > now.getTime() ? currentPaidUntil : now
	const end = new Date(base)
	end.setMonth(end.getMonth() + months)
	return end
}
