import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { corsOrigins, type Config } from './config.js'
import type { DbPool } from './db.js'
import { ApiError } from './lib/errors.js'
import { makeTokenService, type TokenService } from './lib/tokens.js'
import { createEventBus, type EventBus } from './services/events.js'
import { makeFcm, type Fcm } from './services/fcm.js'
import { makeMailer, type Mailer } from './services/mailer.js'
import { createMetrics, registerMetrics, type Metrics } from './services/metrics.js'
import { captureException, initMonitoring } from './services/monitoring.js'
import { bindSecurityMetrics } from './services/security-log.js'
import { bindSubscriptionMetrics } from './services/subscription.js'
import { startFiscalWorker } from './workers/fiscal-worker.js'
import { startPushWorker } from './workers/push-worker.js'
import { bindWebhookMetrics, startWebhookDispatcher } from './workers/webhook-dispatcher.js'
import { registerAuth } from './plugins/auth.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerCompanyRoutes } from './routes/companies.js'
import { registerCustomerRoutes } from './routes/customers.js'
import { registerDocumentRoutes } from './routes/documents.js'
import { registerEventRoutes } from './routes/events.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerOrderRoutes } from './routes/orders.js'
import { registerPinRoutes } from './routes/pin.js'
import { registerProductRoutes } from './routes/products.js'
import { registerPushRoutes } from './routes/push.js'
import { registerReturnRoutes } from './routes/returns.js'
import { registerApiKeyRoutes } from './routes/api-keys.js'
import { registerFiscalRoutes } from './routes/fiscal.js'
import { registerGdprRoutes, startExportWorker } from './routes/gdpr.js'
import { registerPublicRoutes } from './routes/public.js'
import { registerSalesRoutes } from './routes/sales.js'
import { registerSubscriptionRoutes } from './routes/subscription.js'
import { registerSupportRoutes } from './routes/support.js'
import { registerSyncRoutes } from './routes/sync.js'
import { registerWebhookRoutes } from './routes/webhooks.js'

export type BuildAppOptions = {
	config: Config
	pool: DbPool
	/** Подмена сервиса токенов в тестах. */
	tokens?: TokenService
	/** Подмена mailer'а в тестах (можно ловить отправленные письма). */
	mailer?: Mailer
	/** В тестах можно отключить eventBus — SSE-эндпоинт всё равно работает. */
	eventBus?: EventBus | null
	/** Подмена FCM в тестах / отключение push-worker'а. */
	fcm?: Fcm | null
	/** Подмена реестра метрик в тестах / отключение (null = /metrics не регистрируется). */
	metrics?: Metrics | null
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
	const { config, pool } = opts

	// Sentry — идемпотентная инициализация; noop без SENTRY_DSN.
	// Ставим ДО регистрации error handler'а, чтобы 5xx долетели.
	initMonitoring(config)

	const app = Fastify({
		logger: {
			level: config.NODE_ENV === 'test' ? 'silent' : 'info',
			redact: ['req.headers.authorization', 'req.headers["idempotency-key"]'],
		},
		trustProxy: config.TRUST_PROXY,
		bodyLimit: 512 * 1024, // 512 КБ хватает на чек в 500 позиций; защита от гигантских тел
	})

	await app.register(helmet, { contentSecurityPolicy: false })

	const origins = corsOrigins(config)
	await app.register(cors, {
		// production без списка origins = браузерам нельзя ничего; мобильным
		// приложениям CORS не мешает — они не браузер.
		origin: origins.length > 0 ? origins : config.NODE_ENV !== 'production',
		credentials: false,
	})

	await app.register(rateLimit, {
		max: config.RATE_LIMIT_MAX,
		timeWindow: '1 minute',
		// Per-tenant защита: один шумный тенант не отберёт лимит у остальных.
		// Для авторизованных запросов ключ — companyId (если есть), иначе userId,
		// иначе fallback на IP. Для неавторизованных (login/register) — IP.
		keyGenerator: req => {
			const auth = (req as { auth?: { companyId?: string; userId?: string } }).auth
			if (auth?.companyId) return `co:${auth.companyId}`
			if (auth?.userId) return `u:${auth.userId}`
			return req.ip
		},
		errorResponseBuilder: () => ({
			error: { code: 'RATE_LIMITED', message: 'Слишком много запросов, попробуйте позже' },
		}),
	})

	app.setErrorHandler((err, request, reply) => {
		if (err instanceof ApiError) {
			reply.code(err.statusCode)
			return reply.send({ error: { code: err.code, message: err.message, details: err.details ?? undefined } })
		}
		const fErr = err as { statusCode?: number; code?: string; message?: string }
		// Гонка на уникальном индексе (например, две регистрации одного email
		// одновременно) — это конфликт, а не падение сервера.
		if (fErr.code === '23505') {
			reply.code(409)
			return reply.send({ error: { code: 'DUPLICATE', message: 'Запись уже существует' } })
		}
		const status = typeof fErr.statusCode === 'number' && fErr.statusCode >= 400 ? fErr.statusCode : 500
		if (status >= 500) {
			request.log.error({ err }, 'unhandled error')
			// Sentry: только настоящие 5xx (не отбитые ApiError'ы), с базовым контекстом.
			captureException(err, {
				method: request.method,
				url: request.url,
				companyId: request.auth?.companyId,
				userId: request.auth?.userId,
			})
			reply.code(500)
			// Внутренности (SQL, стек) наружу не отдаём.
			return reply.send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } })
		}
		reply.code(status)
		return reply.send({ error: { code: fErr.code ?? 'BAD_REQUEST', message: fErr.message ?? 'Некорректный запрос' } })
	})

	// Метрики регистрируем до маршрутов, чтобы onRequest-хук ловил ВСЕ запросы.
	// В тестах можно передать metrics: null — тогда /metrics и хуки не подключаются
	// (иначе тесты аккумулировали бы label'ы между buildApp'ами).
	const metrics = opts.metrics === null ? null : opts.metrics ?? createMetrics()
	if (metrics) {
		registerMetrics(app, metrics, config)
		bindSecurityMetrics(metrics)
		bindSubscriptionMetrics(metrics)
		bindWebhookMetrics(metrics)
	} else {
		bindSecurityMetrics(null)
		bindSubscriptionMetrics(null)
		bindWebhookMetrics(null)
	}

	const tokens = opts.tokens ?? makeTokenService(config)
	const mailer = opts.mailer ?? makeMailer(config)
	registerAuth(app, pool, tokens)

	registerHealthRoutes(app, pool)
	registerAuthRoutes(app, { pool, tokens, mailer, config })
	registerCompanyRoutes(app, pool)
	registerSyncRoutes(app, pool)
	registerSalesRoutes(app, pool)
	registerDocumentRoutes(app, pool)
	registerOrderRoutes(app, pool)
	registerReturnRoutes(app, pool)
	registerCustomerRoutes(app, pool)
	registerProductRoutes(app, pool)
	registerPinRoutes(app, pool)
	registerPushRoutes(app, pool)
	registerSupportRoutes(app, pool, config)
	registerAdminRoutes(app, pool)
	registerSubscriptionRoutes(app, pool, config)
	registerFiscalRoutes(app, pool, config)
	registerApiKeyRoutes(app, pool)
	registerWebhookRoutes(app, pool)
	registerPublicRoutes(app, pool)
	registerGdprRoutes(app, pool)

	const eventBus = opts.eventBus === null ? null : opts.eventBus ?? createEventBus(pool)
	if (eventBus) {
		registerEventRoutes(app, eventBus)
		app.addHook('onClose', async () => { await eventBus.close() })
	}

	// FCM push-worker: слушает eventBus и шлёт FCM.
	// В тестах отключается через fcm: null.
	const fcm = opts.fcm === null ? null : opts.fcm ?? makeFcm(config)
	if (fcm && eventBus && fcm.available) {
		const worker = startPushWorker(pool, eventBus, fcm, m => app.log.info(m))
		app.addHook('onClose', async () => { await worker.close() })
	}

	// Fiscal-worker: раз в 30 сек polling fiscal_receipts (processing/pending)
	// и вызов АТОЛ getReport / retry sell. Не запускается в тестах (когда
	// FISCAL_KMS_KEY пусто) и когда fcm явно отключён (общий флаг «моки»).
	if (config.FISCAL_KMS_KEY && opts.fcm !== null) {
		const fw = startFiscalWorker({ pool, config, log: m => app.log.info(m) })
		app.addHook('onClose', async () => { await fw.close() })
	}

	// Webhook-dispatcher: enqueue при publishEvent + polling с exp-backoff.
	// Отключается общим fcm: null (тестовый режим — там eventBus тоже null).
	if (eventBus && opts.fcm !== null) {
		const wd = startWebhookDispatcher({ pool, eventBus, log: m => app.log.info(m) })
		app.addHook('onClose', async () => { await wd.close() })
	}

	// GDPR export-воркер: раз в минуту забирает pending job'ы и генерит JSON-дамп.
	// В тестах не запускаем (fcm: null — общий флаг «моки»).
	if (opts.fcm !== null) {
		const ew = startExportWorker({ pool, log: m => app.log.info(m) })
		app.addHook('onClose', async () => { await ew.close() })
	}

	return app
}
