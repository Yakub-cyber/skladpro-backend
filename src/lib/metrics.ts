import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'

/**
 * Prometheus /metrics для мониторинга сервера.
 *
 * Что копим:
 *  - `http_requests_total{method,route,status}` — общее число запросов.
 *  - `http_request_duration_seconds{method,route,status}` — латентность в секундах.
 *  - `security_events_total{event}` — счётчик событий безопасности (login/pin/…)
 *    для быстрого дашборда «вход по PIN упал 20 раз за минуту» без запроса в БД.
 *  - `sse_connections_active` — сколько клиентов сейчас на /v1/events.
 *  - `webhook_deliveries_total{status}` — доставки исходящих webhook'ов (B4).
 *  - `subscription_limit_exceeded_total{feature}` — 402 сработал по плану (B2).
 *  - `fiscal_receipts_total{result}` — фискализация чеков через АТОЛ (B3).
 *  - плюс дефолтные Node.js метрики (event loop, gc, память) — copiscollectDefaultMetrics.
 *
 * Регистрируется в собственном Registry (не в глобальный prom-client'а), чтобы
 * тесты не аккумулировали метрики между `buildApp()` вызовами.
 *
 * Доступ: `/metrics` — если METRICS_USER/METRICS_PASS заданы, HTTP Basic Auth;
 * иначе открыто (только для локальной разработки).
 */
export function createMetrics() {
	const registry = new Registry()
	collectDefaultMetrics({ register: registry, prefix: 'skladpro_' })

	const httpRequestsTotal = new Counter({
		name: 'http_requests_total',
		help: 'Общее число HTTP-запросов',
		labelNames: ['method', 'route', 'status'] as const,
		registers: [registry],
	})

	const httpRequestDuration = new Histogram({
		name: 'http_request_duration_seconds',
		help: 'Латентность HTTP-запросов в секундах',
		labelNames: ['method', 'route', 'status'] as const,
		buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
		registers: [registry],
	})

	const securityEvents = new Counter({
		name: 'security_events_total',
		help: 'События безопасности (login/pin/api-key/…)',
		labelNames: ['event'] as const,
		registers: [registry],
	})

	const sseConnections = new Gauge({
		name: 'sse_connections_active',
		help: 'Активные SSE-подключения к /v1/events',
		registers: [registry],
	})

	const webhookDeliveries = new Counter({
		name: 'webhook_deliveries_total',
		help: 'Доставки исходящих webhook-endpoint\'ам (публичный API)',
		labelNames: ['status'] as const, // ok | retry | failed
		registers: [registry],
	})

	const subscriptionLimitExceeded = new Counter({
		name: 'subscription_limit_exceeded_total',
		help: 'Отказы 402 по лимиту плана подписки',
		labelNames: ['feature'] as const, // products | warehouses | employees | sales
		registers: [registry],
	})

	const fiscalReceipts = new Counter({
		name: 'fiscal_receipts_total',
		help: 'Фискализация чеков через провайдера ККТ',
		labelNames: ['result'] as const, // ok | failed | retry
		registers: [registry],
	})

	return {
		registry,
		httpRequestsTotal,
		httpRequestDuration,
		securityEvents,
		sseConnections,
		webhookDeliveries,
		subscriptionLimitExceeded,
		fiscalReceipts,
	}
}

export type Metrics = ReturnType<typeof createMetrics>

/**
 * Регистрирует /metrics-эндпоинт и хук на все запросы, который пишет
 * counter + histogram по методу/маршруту/статусу. Маршрут берём из
 * `request.routerPath` (обобщённый шаблон вроде `/v1/orders/:id/status`),
 * чтобы не плодить cardinality за счёт id'шников.
 */
export function registerMetrics(
	app: FastifyInstance,
	metrics: Metrics,
	config: Config,
) {
	// Замер продолжительности через onRequest → onResponse. Кладём метку
	// в request.raw, чтобы hook мог считать время до отправки ответа.
	app.addHook('onRequest', async request => {
		;(request as unknown as { _mStart: bigint })._mStart = process.hrtime.bigint()
	})

	app.addHook('onResponse', async (request, reply) => {
		const start = (request as unknown as { _mStart?: bigint })._mStart
		// routeOptions.url — обобщённый шаблон (`/v1/orders/:id/status`), не raw
		// URL с id внутри — это нужно, чтобы cardinality label'а `route` не
		// росла с каждым уникальным id.
		const route = request.routeOptions?.url ?? request.url
		// Не пишем /metrics в свои же метрики — не хотим self-полла шум.
		if (route === '/metrics') return
		const labels = {
			method: request.method,
			route,
			status: String(reply.statusCode),
		}
		metrics.httpRequestsTotal.inc(labels)
		if (start) {
			const durSec = Number(process.hrtime.bigint() - start) / 1e9
			metrics.httpRequestDuration.observe(labels, durSec)
		}
	})

	// Basic-auth, если METRICS_USER/METRICS_PASS заданы. Иначе открыто.
	const expectedUser = config.METRICS_USER
	const expectedPass = config.METRICS_PASS
	const authRequired = Boolean(expectedUser && expectedPass)

	app.get('/metrics', async (request, reply) => {
		if (authRequired) {
			const header = request.headers.authorization ?? ''
			if (!header.startsWith('Basic ')) {
				reply.header('WWW-Authenticate', 'Basic realm="metrics"')
				reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Basic auth required' } })
				return
			}
			const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
			const [u, p] = decoded.split(':')
			if (u !== expectedUser || p !== expectedPass) {
				reply.header('WWW-Authenticate', 'Basic realm="metrics"')
				reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Bad credentials' } })
				return
			}
		}
		reply.header('Content-Type', metrics.registry.contentType)
		return metrics.registry.metrics()
	})
}
