import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, makeTestApp } from './helpers.js'

describe('приложение', () => {
	it('GET /health отвечает без БД', async () => {
		const { app } = await makeTestApp({
			handler: () => {
				throw new Error('db down')
			},
		})
		const res = await app.inject({ method: 'GET', url: '/health' })
		expect(res.statusCode).toBe(200)
		expect(res.json().ok).toBe(true)
	})

	it('GET /health/db отдаёт 503 при недоступной БД', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql === 'select 1') throw new Error('db down')
				return []
			},
		})
		const res = await app.inject({ method: 'GET', url: '/health/db' })
		expect(res.statusCode).toBe(503)
	})

	it('GET /v1/me возвращает пользователя и членства', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.includes('from memberships m join companies'))
					return [{ company_id: COMPANY_ID, role: 'admin', name: 'Т', company_name: 'ООО Тест' }]
				return []
			},
		})
		const res = await app.inject({ method: 'GET', url: '/v1/me', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		expect(res.json().memberships[0]).toMatchObject({ companyId: COMPANY_ID, role: 'admin' })
	})

	it('внутренняя ошибка не раскрывает детали', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.includes('from products') && sql.includes('deleted_at is null')) throw new Error('secret sql failure at line 42')
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'boom-test-0001' }),
			payload: { order: { id: 'o-1', items: [{ productId: 'p-1', qty: 1, price: 1 }] } },
		})
		expect(res.statusCode).toBe(500)
		expect(JSON.stringify(res.json())).not.toContain('secret sql failure')
	})

	it('пользователь без компании получает 403 NO_COMPANY на company-эндпоинтах', async () => {
		const { app } = await makeTestApp({ handler: () => [], membership: null })
		const res = await app.inject({ method: 'GET', url: '/v1/sync/pull', headers: await authHeaders() })
		expect(res.statusCode).toBe(403)
		expect(res.json().error.code).toBe('NO_COMPANY')
	})

	it('404 на неизвестный маршрут в едином формате', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({ method: 'GET', url: '/nope' })
		expect(res.statusCode).toBe(404)
	})
})
