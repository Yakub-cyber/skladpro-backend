import type { FastifyRequest } from 'fastify'
import type { DbPool } from '../db.js'
import type { Metrics } from './metrics.js'

// Метрики (Counter security_events_total) настраиваются один раз при
// buildApp; helper использует их через модульный singleton, чтобы не
// прокидывать в каждый вызов.
let metricsRef: Metrics | null = null
export function bindSecurityMetrics(metrics: Metrics | null) {
	metricsRef = metrics
}

/**
 * Журнал security-событий (таблица `security_events`, миграция 0007).
 *
 * Использование:
 *   await logSecurityEvent(pool, 'login_ok', {
 *     userId, ip, ua, meta: { email }
 *   })
 * или из route-handler'а короче:
 *   await logSecurityEvent(pool, 'login_fail', fromRequest(request, { meta: { email } }))
 *
 * Best-effort — если запись упала (например, БД временно недоступна),
 * ошибку глотаем и продолжаем handler. Мы не хотим блокировать логин
 * из-за проблем с audit-таблицей.
 */
export type SecurityEvent =
	| 'login_ok'
	| 'login_fail'
	| 'register_ok'
	| 'logout'
	| 'refresh_ok'
	| 'refresh_reuse_detected'
	| 'refresh_expired'
	| 'password_change'
	| 'password_reset_requested'
	| 'password_reset_confirmed'
	| 'pin_set'
	| 'pin_verify_ok'
	| 'pin_verify_fail'
	| 'api_key_created'
	| 'api_key_used'
	| 'api_key_revoked'
	| 'webhook_delivery_fail'
	| 'subscription_activated'
	| 'subscription_admin_override'
	| 'super_admin_action'

export type SecurityEventOpts = {
	companyId?: string | null
	userId?: string | null
	ip?: string | null
	ua?: string | null
	meta?: Record<string, unknown> | null
}

export async function logSecurityEvent(
	pool: DbPool,
	event: SecurityEvent,
	opts: SecurityEventOpts = {},
): Promise<void> {
	// Метрика — синхронно, до БД. Даже если запись упадёт, счётчик работает.
	metricsRef?.securityEvents.inc({ event })
	try {
		// inet-колонка не принимает пустую строку, только null или валидный IP.
		const ip = opts.ip && opts.ip.length > 0 ? opts.ip : null
		await pool.query(
			`insert into security_events (company_id, user_id, event, ip, user_agent, meta)
			 values ($1, $2, $3, $4, $5, $6)`,
			[
				opts.companyId ?? null,
				opts.userId ?? null,
				event,
				ip,
				(opts.ua ?? '').slice(0, 500) || null,
				opts.meta ? JSON.stringify(opts.meta) : null,
			],
		)
	} catch {
		// noop — журнал не должен ронять бизнес-путь
	}
}

/** Собирает ip/ua из request'а и мержит с ручными опциями. */
export function fromRequest(
	request: FastifyRequest,
	extra: SecurityEventOpts = {},
): SecurityEventOpts {
	return {
		ip: request.ip,
		ua: (request.headers['user-agent'] ?? '').slice(0, 500),
		userId: request.auth?.userId ?? null,
		companyId: request.auth?.companyId ?? null,
		...extra,
	}
}
