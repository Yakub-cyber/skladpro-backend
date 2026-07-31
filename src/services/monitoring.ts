/**
 * Sentry для бэкенда. Ленивая инициализация:
 *  - если SENTRY_DSN пуст → все функции noop (dev, CI, локальные прогоны);
 *  - иначе — @sentry/node с redaction (JWT, пароли, refresh-токены).
 *
 * Использование: `captureException(err, { op: 'sales.commit', orderId })`
 * из setErrorHandler в app.ts для 5xx и в местах где мы уже пишем request.log.error.
 */
import type { Config } from '../config.js'

let sentryInited = false
let sentry: typeof import('@sentry/node') | null = null

// Deny-list ключей — маскируем в extra контексте и в HTTP-запросах.
const REDACT_KEYS = /^(authorization|cookie|password|refresh_?token|access_?token|token|api[_-]?key|secret|pin|pin_hash)$/i

function redact<T>(value: T): T {
	if (!value || typeof value !== 'object') return value
	if (Array.isArray(value)) return value.map(redact) as unknown as T
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (REDACT_KEYS.test(k)) out[k] = '[REDACTED]'
		else if (v && typeof v === 'object') out[k] = redact(v)
		else out[k] = v
	}
	return out as T
}

export function initMonitoring(config: Config): void {
	if (sentryInited) return
	const dsn = config.SENTRY_DSN
	if (!dsn) return
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		sentry = require('@sentry/node') as typeof import('@sentry/node')
		sentry.init({
			dsn,
			environment: config.NODE_ENV,
			// Никаких перфоманс-транзакций (только ошибки) — экономим лимит free-плана.
			tracesSampleRate: 0,
			// Прикладной slug для группировки релизов на sentry.io.
			release: `skladpro-backend@${process.env.npm_package_version ?? 'unknown'}`,
			beforeSend(event) {
				// Redact заголовков и данных запроса.
				if (event.request) {
					if (event.request.headers) event.request.headers = redact(event.request.headers) as never
					if (event.request.data) event.request.data = redact(event.request.data)
					if (event.request.query_string && typeof event.request.query_string === 'string') {
						event.request.query_string = event.request.query_string.replace(
							/(access_token|token)=[^&]+/gi,
							'$1=[REDACTED]',
						)
					}
				}
				if (event.extra) event.extra = redact(event.extra) as never
				return event
			},
		})
		sentryInited = true
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn('[monitoring] Sentry init failed:', err instanceof Error ? err.message : err)
	}
}

/**
 * Отправить исключение в Sentry. Тихо no-op если Sentry не инициализирован.
 */
export function captureException(err: unknown, extra?: Record<string, unknown>): void {
	if (!sentry) return
	try {
		sentry.captureException(err, extra ? { extra: redact(extra) } : undefined)
	} catch { /* Sentry сам мог сломаться — не роняем прод */ }
}

/**
 * Отправить произвольное сообщение (для реже, чем captureException).
 */
export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info', extra?: Record<string, unknown>): void {
	if (!sentry) return
	try {
		sentry.captureMessage(message, { level, extra: extra ? redact(extra) : undefined })
	} catch { /* noop */ }
}

/** Флаг для тестов: активна ли отправка. */
export function monitoringAvailable(): boolean {
	return sentry !== null
}
