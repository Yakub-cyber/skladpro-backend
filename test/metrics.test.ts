import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createMetrics } from '../src/lib/metrics.js'
import { authHeaders, baseHandler, makeFakePool, testConfig } from './helpers.js'

describe('GET /metrics', () => {
	it('без basic-auth в конфиге — эндпоинт открыт, отдаёт prometheus-текст', async () => {
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({ config: testConfig, pool, eventBus: null })
		const res = await app.inject({ method: 'GET', url: '/metrics' })
		expect(res.statusCode).toBe(200)
		expect(res.headers['content-type']).toContain('text/plain')
		// Метрика http_requests_total должна попадать в вывод (хотя бы декларация).
		expect(res.body).toContain('http_requests_total')
	})

	it('с METRICS_USER/PASS — без Basic-auth → 401', async () => {
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({
			config: { ...testConfig, METRICS_USER: 'u', METRICS_PASS: 'p' },
			pool,
			eventBus: null,
		})
		const res = await app.inject({ method: 'GET', url: '/metrics' })
		expect(res.statusCode).toBe(401)
		expect(res.headers['www-authenticate']).toContain('Basic')
	})

	it('с валидным Basic-auth → 200', async () => {
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({
			config: { ...testConfig, METRICS_USER: 'admin', METRICS_PASS: 'secret' },
			pool,
			eventBus: null,
		})
		const b64 = Buffer.from('admin:secret').toString('base64')
		const res = await app.inject({
			method: 'GET',
			url: '/metrics',
			headers: { authorization: `Basic ${b64}` },
		})
		expect(res.statusCode).toBe(200)
	})

	it('с неверным паролем → 401', async () => {
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({
			config: { ...testConfig, METRICS_USER: 'admin', METRICS_PASS: 'secret' },
			pool,
			eventBus: null,
		})
		const b64 = Buffer.from('admin:WRONG').toString('base64')
		const res = await app.inject({
			method: 'GET',
			url: '/metrics',
			headers: { authorization: `Basic ${b64}` },
		})
		expect(res.statusCode).toBe(401)
	})

	it('http_requests_total инкрементится после запросов', async () => {
		const metrics = createMetrics()
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({ config: testConfig, pool, eventBus: null, metrics })
		// Пара тыков в API — должен инкрементнуться /health счётчик.
		await app.inject({ method: 'GET', url: '/health' })
		await app.inject({ method: 'GET', url: '/health' })
		const res = await app.inject({ method: 'GET', url: '/metrics' })
		expect(res.body).toMatch(/http_requests_total\{[^}]*route="\/health"[^}]*\} 2/)
	})

	it('/metrics не пишет саму себя в http_requests_total', async () => {
		const metrics = createMetrics()
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({ config: testConfig, pool, eventBus: null, metrics })
		await app.inject({ method: 'GET', url: '/metrics' })
		await app.inject({ method: 'GET', url: '/metrics' })
		const res = await app.inject({ method: 'GET', url: '/metrics' })
		expect(res.body).not.toMatch(/route="\/metrics"/)
	})
})

describe('security_events_total counter', () => {
	it('инкрементится при register_ok', async () => {
		const metrics = createMetrics()
		const { pool } = makeFakePool((sql, params) => {
			const base = baseHandler({ membership: null })
			if (sql.includes('insert into users')) {
				return [{ id: '00000000-0000-4000-8000-000000000099', email: params[0], name: params[2] }]
			}
			if (sql.includes('insert into refresh_tokens')) return []
			if (sql.includes('insert into security_events')) return []
			return base(sql, params)
		})
		const app = await buildApp({ config: testConfig, pool, eventBus: null, metrics })
		const reg = await app.inject({
			method: 'POST',
			url: '/v1/auth/register',
			payload: { email: 'metric-test@example.com', password: 'strong-pass-12', name: 'X' },
		})
		expect(reg.statusCode).toBe(201)
		// register_ok эмитится синхронно в logSecurityEvent через metricsRef —
		// значение должно быть ≥ 1 в этом registry.
		const registered = await metrics.registry.getSingleMetric('security_events_total')?.get()
		const value = registered?.values.find(v => v.labels.event === 'register_ok')?.value
		expect(value).toBe(1)
	})
})
