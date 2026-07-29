import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, makeTestApp, USER_ID } from './helpers.js'

describe('POST /v1/push/tokens', () => {
	it('регистрирует токен под текущим пользователем и компанией', async () => {
		let insertedParams: unknown[] = []
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('insert into push_tokens')) {
					insertedParams = params
					return []
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/push/tokens',
			headers: await authHeaders(),
			payload: { token: 'fcm-token-abc-123', platform: 'android' },
		})
		expect(res.statusCode).toBe(201)
		expect(insertedParams[0]).toBe(USER_ID)
		expect(insertedParams[1]).toBe(COMPANY_ID)
		expect(insertedParams[2]).toBe('fcm-token-abc-123')
		expect(insertedParams[3]).toBe('android')
	})

	it('невалидный platform → 400', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/push/tokens',
			headers: await authHeaders(),
			payload: { token: 'tok', platform: 'symbian' },
		})
		expect(res.statusCode).toBe(400)
	})

	it('без авторизации → 401', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/push/tokens',
			payload: { token: 'tok', platform: 'android' },
		})
		expect(res.statusCode).toBe(401)
	})
})

describe('DELETE /v1/push/tokens/:token', () => {
	it('удаляет токен только текущего пользователя', async () => {
		let deletedParams: unknown[] = []
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.startsWith('delete from push_tokens')) {
					deletedParams = params
					return []
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'DELETE',
			url: '/v1/push/tokens/fcm-token-abc-123',
			headers: { authorization: (await authHeaders()).authorization },
		})
		expect(res.statusCode).toBe(200)
		expect(deletedParams).toEqual([USER_ID, 'fcm-token-abc-123'])
	})
})
