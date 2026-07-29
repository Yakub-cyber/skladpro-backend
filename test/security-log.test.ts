import { describe, expect, it } from 'vitest'
import { bindSecurityMetrics, fromRequest, logSecurityEvent } from '../src/lib/security-log.js'
import { authHeaders, makeTestApp, USER_ID } from './helpers.js'
import { makeFakePool } from './helpers.js'

describe('security-log helper', () => {
	it('вставляет строку в security_events с ip/ua/meta', async () => {
		let inserted: unknown[] = []
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('insert into security_events')) {
				inserted = params
				return []
			}
			return undefined
		})
		bindSecurityMetrics(null)
		await logSecurityEvent(pool, 'login_ok', {
			userId: USER_ID,
			companyId: null,
			ip: '10.0.0.5',
			ua: 'jest-agent/1.0',
			meta: { email: 'x@y.z' },
		})
		expect(inserted[0]).toBeNull()
		expect(inserted[1]).toBe(USER_ID)
		expect(inserted[2]).toBe('login_ok')
		expect(inserted[3]).toBe('10.0.0.5')
		expect(inserted[4]).toBe('jest-agent/1.0')
		expect(JSON.parse(inserted[5] as string)).toEqual({ email: 'x@y.z' })
	})

	it('пустой ip не ломает inet-колонку — сохраняется null', async () => {
		let inserted: unknown[] = []
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('insert into security_events')) {
				inserted = params
				return []
			}
			return undefined
		})
		bindSecurityMetrics(null)
		await logSecurityEvent(pool, 'login_fail', { ip: '', ua: '' })
		expect(inserted[3]).toBeNull()
		expect(inserted[4]).toBeNull()
	})

	it('ошибка insert не бросается наружу (best-effort)', async () => {
		const { pool } = makeFakePool(sql => {
			if (sql.includes('insert into security_events')) throw new Error('DB down')
			return undefined
		})
		bindSecurityMetrics(null)
		await expect(logSecurityEvent(pool, 'login_ok', {})).resolves.toBeUndefined()
	})
})

describe('logSecurityEvent на login/register через API', () => {
	it('при 201 register — пишется register_ok', async () => {
		const events: string[] = []
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('insert into security_events')) {
					events.push(String(params[2]))
					return []
				}
				if (sql.includes('insert into users')) {
					return [{ id: USER_ID, email: params[0], name: params[2] }]
				}
				if (sql.includes('insert into refresh_tokens')) return []
				return undefined
			},
			membership: null,
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/register',
			headers: await authHeaders(),
			payload: { email: 'new@user.ru', password: 'strong-pass-12', name: 'Новый' },
		})
		expect(res.statusCode).toBe(201)
		expect(events).toContain('register_ok')
	})

	it('login_fail пишется при неизвестном email', async () => {
		const events: string[] = []
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.includes('insert into security_events')) {
					events.push('login_fail')
					return []
				}
				if (sql.includes('from users where lower(email)')) return []
				return undefined
			},
			membership: null,
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/login',
			payload: { email: 'ghost@nope.ru', password: 'whatever' },
		})
		expect(res.statusCode).toBe(401)
		expect(events).toContain('login_fail')
	})
})

describe('fromRequest helper', () => {
	it('собирает ip/ua из request', () => {
		const req = {
			ip: '127.0.0.1',
			headers: { 'user-agent': 'test-agent' },
			auth: { userId: USER_ID, companyId: 'c-1' },
		} as never
		const opts = fromRequest(req, { meta: { foo: 1 } })
		expect(opts.ip).toBe('127.0.0.1')
		expect(opts.ua).toBe('test-agent')
		expect(opts.userId).toBe(USER_ID)
		expect(opts.companyId).toBe('c-1')
		expect(opts.meta).toEqual({ foo: 1 })
	})
})
