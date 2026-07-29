import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createMetrics } from '../src/lib/metrics.js'
import { startWebhookDispatcher } from '../src/lib/webhook-dispatcher.js'
import { authHeaders, baseHandler, COMPANY_ID, makeFakePool, makeTestApp, testConfig } from './helpers.js'

describe('POST /v1/api-keys', () => {
	it('роль stock → 403', async () => {
		const { app } = await makeTestApp({
			handler: () => undefined,
			membership: { company_id: COMPANY_ID, role: 'stock', name: 'X' },
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/api-keys',
			headers: await authHeaders(),
			payload: { name: 'test key', scopes: ['products:read'] },
		})
		expect(res.statusCode).toBe(403)
	})

	it('admin → 201 + отдаёт plain-секрет один раз', async () => {
		let inserted: unknown[] = []
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('insert into api_keys')) {
					inserted = params
					return [{ id: '00000000-0000-4000-8000-000000000abc', created_at: new Date() }]
				}
				if (sql.includes('insert into security_events')) return []
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/api-keys',
			headers: await authHeaders(),
			payload: { name: 'Integration key', scopes: ['products:read', 'orders:write'] },
		})
		expect(res.statusCode).toBe(201)
		const body = res.json()
		expect(body.key).toMatch(/^sk_live_[a-z0-9]{6,16}_.+/)
		expect(body.prefix).toBe(inserted[2])
		// hash в БД — sha256(secret), не plain
		const secret = body.key.split('_').slice(3).join('_')
		expect(inserted[3]).toBe(createHash('sha256').update(secret).digest('hex'))
		expect(inserted[4]).toEqual(['products:read', 'orders:write'])
	})

	it('невалидный scope → 400', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/api-keys',
			headers: await authHeaders(),
			payload: { name: 'X', scopes: ['admin:everything'] },  // не в KNOWN_SCOPES
		})
		expect(res.statusCode).toBe(400)
	})
})

describe('DELETE /v1/api-keys/:id', () => {
	it('revoke → 200 + пишет security_events', async () => {
		const events: string[] = []
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('update api_keys set active = false')) return [{}]
				if (sql.includes('insert into security_events')) {
					events.push(String(params[2]))
					return []
				}
				return undefined
			},
		})
		// DELETE без content-type: fastify + no body с application/json → 400.
		const h = await authHeaders()
		const res = await app.inject({
			method: 'DELETE',
			url: '/v1/api-keys/00000000-0000-4000-8000-000000000abc',
			headers: { authorization: h.authorization },
		})
		expect(res.statusCode).toBe(200)
		expect(events).toContain('api_key_revoked')
	})
})

describe('X-API-Key auth', () => {
	it('без заголовка → 401', async () => {
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null })
		const res = await app.inject({ method: 'GET', url: '/v1/public/products' })
		expect(res.statusCode).toBe(401)
	})

	it('некорректный формат → 401', async () => {
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'GET',
			url: '/v1/public/products',
			headers: { 'x-api-key': 'invalid-format' },
		})
		expect(res.statusCode).toBe(401)
	})

	it('валидный ключ без нужного scope → 403', async () => {
		const secret = 'secretvalue32chars0000000000000000'
		const hash = createHash('sha256').update(secret).digest('hex')
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('from api_keys ak')) {
				if (params[0] === 'abc12345' && params[1] === hash) {
					return [{ company_id: COMPANY_ID, id: 'k-1', scopes: ['orders:read'], active: true, revoked_at: null }]
				}
				return []
			}
			if (sql.includes('update api_keys set last_used_at')) return []
			return undefined
		})
		const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'GET',
			url: '/v1/public/products',
			headers: { 'x-api-key': `sk_live_abc12345_${secret}` },
		})
		expect(res.statusCode).toBe(403)
	})

	it('валидный ключ + нужный scope → 200', async () => {
		const secret = 'secretvalue32chars0000000000000000'
		const hash = createHash('sha256').update(secret).digest('hex')
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('from api_keys ak')) {
				if (params[0] === 'abc12345' && params[1] === hash) {
					return [{ company_id: COMPANY_ID, id: 'k-1', scopes: ['products:read'], active: true, revoked_at: null }]
				}
				return []
			}
			if (sql.includes('update api_keys set last_used_at')) return []
			if (sql.includes('from products where company_id')) return [{ id: 'p-1', sku: 'X', name: 'Товар', price: 100, stock: 5 }]
			return undefined
		})
		const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'GET',
			url: '/v1/public/products',
			headers: { 'x-api-key': `sk_live_abc12345_${secret}` },
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().products[0].sku).toBe('X')
	})
})

describe('POST /v1/webhooks/endpoints', () => {
	it('создание → 201 + возвращает secret', async () => {
		const { app } = await makeTestApp({
			handler: (sql) => {
				if (sql.includes('insert into webhook_endpoints')) {
					return [{ id: '00000000-0000-4000-8000-000000000wep', created_at: new Date() }]
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/webhooks/endpoints',
			headers: await authHeaders(),
			payload: {
				name: 'Notify',
				url: 'https://example.com/hook',
				events: ['sale.created'],
			},
		})
		expect(res.statusCode).toBe(201)
		const body = res.json()
		expect(body.secret).toBeTruthy()
		expect(body.secret.length).toBeGreaterThan(30)
	})

	it('неизвестный event → 400', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/webhooks/endpoints',
			headers: await authHeaders(),
			payload: { name: 'X', url: 'https://example.com/hook', events: ['unknown.event'] },
		})
		expect(res.statusCode).toBe(400)
	})
})

describe('webhook-dispatcher', () => {
	it('enqueue → insert into webhook_deliveries', async () => {
		let insertedPayload: string | null = null
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('insert into webhook_deliveries')) {
				insertedPayload = params[2] as string
				return []
			}
			return undefined
		})
		const eventBus = { subscribe: async () => () => {}, close: async () => {} }
		const wd = startWebhookDispatcher({ pool, eventBus, pollIntervalMs: 60_000 })
		await wd.enqueue({
			companyId: COMPANY_ID,
			type: 'sale',
			id: 'sale-1',
			at: '2026-08-01T00:00:00.000Z',
			senderUserId: 'user-1',
		})
		expect(insertedPayload).toBeTruthy()
		const p = JSON.parse(insertedPayload!)
		expect(p.event).toBe('sale.created')
		expect(p.data.id).toBe('sale-1')
		await wd.close()
	})

	it('deliverBatch: успех → delivered_at + metrics ok', async () => {
		const metrics = createMetrics()
		let deliveredId: unknown = null
		const mockFetch = async () => ({ ok: true, status: 200 } as Response)
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('from webhook_deliveries d')) {
				return [{
					id: 42,
					company_id: COMPANY_ID,
					endpoint_id: 'ep-1',
					event: 'sale.created',
					payload: { event: 'sale.created', data: { id: 'sale-1' } },
					attempts: 0,
					url: 'https://example.com/hook',
					secret: 'shhhh',
				}]
			}
			if (sql.includes('update webhook_deliveries set delivered_at')) {
				deliveredId = params[0]
				return [{}]
			}
			if (sql.includes('update webhook_endpoints set last_delivery_at')) return [{}]
			return undefined
		})
		const eventBus = { subscribe: async () => () => {}, close: async () => {} }
		// bind metrics для этого dispatcher'а
		const { bindWebhookMetrics } = await import('../src/lib/webhook-dispatcher.js')
		bindWebhookMetrics(metrics)
		const wd = startWebhookDispatcher({ pool, eventBus, pollIntervalMs: 60_000, fetchImpl: mockFetch as never })
		await wd.deliverBatch()
		expect(deliveredId).toBe(42)
		const m = await metrics.registry.getSingleMetric('webhook_deliveries_total')?.get()
		const okVal = m?.values.find(v => v.labels.status === 'ok')?.value
		expect(okVal).toBe(1)
		await wd.close()
	})

	it('deliverBatch: 500 → retry (next_retry_at обновляется, delivered_at null)', async () => {
		let updatedRetry = false
		const mockFetch = async () => ({ ok: false, status: 500 } as Response)
		const { pool } = makeFakePool((sql) => {
			if (sql.includes('from webhook_deliveries d')) {
				return [{
					id: 100,
					company_id: COMPANY_ID,
					endpoint_id: 'ep-1',
					event: 'sale.created',
					payload: { event: 'sale.created' },
					attempts: 0,
					url: 'https://example.com/hook',
					secret: 's',
				}]
			}
			if (sql.includes('update webhook_deliveries set attempts') && sql.includes('next_retry_at')) {
				updatedRetry = true
				return [{}]
			}
			return undefined
		})
		const eventBus = { subscribe: async () => () => {}, close: async () => {} }
		const wd = startWebhookDispatcher({ pool, eventBus, pollIntervalMs: 60_000, fetchImpl: mockFetch as never })
		await wd.deliverBatch()
		expect(updatedRetry).toBe(true)
		await wd.close()
	})

	it('HMAC-подпись валидна', async () => {
		let capturedHeaders: Record<string, string> = {}
		let capturedBody = ''
		const mockFetch = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
			capturedHeaders = init.headers
			capturedBody = init.body
			return { ok: true, status: 200 } as Response
		}
		const secret = 'wh-secret-key-1'
		const { pool } = makeFakePool((sql) => {
			if (sql.includes('from webhook_deliveries d')) {
				return [{
					id: 1,
					company_id: COMPANY_ID,
					endpoint_id: 'ep',
					event: 'sale.created',
					payload: { event: 'sale.created', data: { id: 'x' } },
					attempts: 0,
					url: 'https://example.com/hook',
					secret,
				}]
			}
			return undefined
		})
		const eventBus = { subscribe: async () => () => {}, close: async () => {} }
		const wd = startWebhookDispatcher({ pool, eventBus, pollIntervalMs: 60_000, fetchImpl: mockFetch as never })
		await wd.deliverBatch()
		expect(capturedHeaders['X-Skladpro-Event']).toBe('sale.created')
		const timestamp = capturedHeaders['X-Skladpro-Timestamp']
		const sig = capturedHeaders['X-Skladpro-Signature']
		const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${capturedBody}`).digest('hex')
		expect(sig).toBe(expected)
		await wd.close()
	})
})
