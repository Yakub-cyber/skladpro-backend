import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/lib/passwords.js'
import { startExportWorker } from '../src/routes/gdpr.js'
import { authHeaders, baseHandler, COMPANY_ID, makeFakePool, makeTestApp, testConfig, USER_ID } from './helpers.js'

describe('POST /v1/account/export', () => {
	it('роль stock → 403', async () => {
		const { app } = await makeTestApp({
			handler: () => undefined,
			membership: { company_id: COMPANY_ID, role: 'stock', name: 'X' },
		})
		const h = await authHeaders()
		const res = await app.inject({
			method: 'POST',
			url: '/v1/account/export',
			headers: { authorization: h.authorization },
		})
		expect(res.statusCode).toBe(403)
	})

	it('admin → 202 + возвращает jobId', async () => {
		const { app } = await makeTestApp({
			handler: (sql) => {
				if (sql.includes('select id from export_jobs')) return []
				if (sql.includes('insert into export_jobs')) return [{ id: 'job-1', created_at: new Date() }]
				return undefined
			},
		})
		const h = await authHeaders()
		const res = await app.inject({
			method: 'POST',
			url: '/v1/account/export',
			headers: { authorization: h.authorization },
		})
		expect(res.statusCode).toBe(202)
		expect(res.json().jobId).toBe('job-1')
		expect(res.json().status).toBe('pending')
	})

	it('уже есть pending за последний час → возвращает существующий', async () => {
		const { app } = await makeTestApp({
			handler: (sql) => {
				if (sql.includes('select id from export_jobs')) return [{ id: 'existing-job' }]
				return undefined
			},
		})
		const h = await authHeaders()
		const res = await app.inject({
			method: 'POST',
			url: '/v1/account/export',
			headers: { authorization: h.authorization },
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().jobId).toBe('existing-job')
	})
})

describe('GET /v1/account/export/:jobId', () => {
	it('ready → отдаёт downloadUrl', async () => {
		const { app } = await makeTestApp({
			handler: (sql) => {
				if (sql.includes('from export_jobs where company_id = $1 and id = $2')) {
					return [{
						id: 'j-1',
						status: 'ready',
						size_bytes: 12345,
						download_token: 'abc-token-xyz',
						error: null,
						created_at: new Date(),
						completed_at: new Date(),
						expires_at: new Date(Date.now() + 3600_000),
					}]
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'GET',
			url: '/v1/account/export/j-1',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.job.status).toBe('ready')
		expect(body.job.downloadUrl).toContain('abc-token-xyz')
	})

	it('pending → downloadUrl = null', async () => {
		const { app } = await makeTestApp({
			handler: (sql) => {
				if (sql.includes('from export_jobs where company_id = $1 and id = $2')) {
					return [{ id: 'j', status: 'pending', download_token: null, created_at: new Date(), expires_at: null }]
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'GET',
			url: '/v1/account/export/j',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().job.downloadUrl).toBeNull()
	})
})

describe('POST /v1/account/delete', () => {
	it('роль stock → 403', async () => {
		const { app } = await makeTestApp({
			handler: () => undefined,
			membership: { company_id: COMPANY_ID, role: 'stock', name: 'X' },
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/account/delete',
			headers: await authHeaders(),
			payload: { passwordConfirm: 'anything' },
		})
		expect(res.statusCode).toBe(403)
	})

	it('неверный пароль → 401', async () => {
		const correctHash = await hashPassword('correct-password')
		const { app } = await makeTestApp({
			handler: (sql) => {
				if (sql.includes('select password_hash from users')) return [{ password_hash: correctHash }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/account/delete',
			headers: await authHeaders(),
			payload: { passwordConfirm: 'wrong-password' },
		})
		expect(res.statusCode).toBe(401)
	})

	it('верный пароль → 200 + деактивирует api-keys и webhooks', async () => {
		const correctHash = await hashPassword('secret-1234')
		const seenSql: string[] = []
		const { app } = await makeTestApp({
			handler: (sql) => {
				seenSql.push(sql)
				if (sql.includes('select password_hash from users')) return [{ password_hash: correctHash }]
				if (sql.includes('update companies set deleted_at')) return [{}]
				if (sql.includes('update refresh_tokens set revoked_at')) return []
				if (sql.includes('update api_keys set active = false')) return []
				if (sql.includes('update webhook_endpoints set active = false')) return []
				if (sql.includes('insert into security_events')) return []
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/account/delete',
			headers: await authHeaders(),
			payload: { passwordConfirm: 'secret-1234' },
		})
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.ok).toBe(true)
		expect(body.graceUntil).toBeTruthy()
		expect(seenSql.some(s => s.includes('update api_keys set active = false'))).toBe(true)
		expect(seenSql.some(s => s.includes('update webhook_endpoints set active = false'))).toBe(true)
	})
})

describe('POST /v1/account/delete/cancel', () => {
	it('grace ещё не истёк → 200 + восстанавливает api-keys/webhooks', async () => {
		const seenSql: string[] = []
		const { app } = await makeTestApp({
			handler: (sql) => {
				seenSql.push(sql)
				if (sql.includes('update companies set deleted_at = null')) return [{ id: COMPANY_ID }]
				if (sql.includes('update api_keys set active = true')) return []
				if (sql.includes('update webhook_endpoints set active = true')) return []
				return undefined
			},
		})
		const h = await authHeaders()
		const res = await app.inject({
			method: 'POST',
			url: '/v1/account/delete/cancel',
			headers: { authorization: h.authorization },
		})
		expect(res.statusCode).toBe(200)
		expect(seenSql.some(s => s.includes('update api_keys set active = true'))).toBe(true)
	})

	it('grace истёк → 409 CANNOT_CANCEL', async () => {
		const { app } = await makeTestApp({
			handler: (sql) => {
				if (sql.includes('update companies set deleted_at = null')) return []
				return undefined
			},
		})
		const h = await authHeaders()
		const res = await app.inject({
			method: 'POST',
			url: '/v1/account/delete/cancel',
			headers: { authorization: h.authorization },
		})
		expect(res.statusCode).toBe(409)
		expect(res.json().error.code).toBe('CANNOT_CANCEL')
	})
})

describe('B5-2: inviteToken в register', () => {
	it('валидный токен + совпадающий email → авто-accept membership', async () => {
		const events: string[] = []
		const seenSql: string[] = []
		const { pool } = makeFakePool((sql, params) => {
			seenSql.push(sql)
			if (sql.includes('insert into users')) {
				return [{ id: USER_ID, email: params[0], name: params[2] }]
			}
			if (sql.includes('insert into refresh_tokens')) return []
            if (sql.includes('select email from users')) return [{email:params[0] === USER_ID ? 'invited@company.ru' : 'unknown@example.test'}]
			if (sql.includes('from invitations where secret_hash')) {
				return [{
					id: 'inv-1', expires_at:new Date(Date.now()+86400000),
					company_id: COMPANY_ID,
					role: 'manager',
					name: 'Приглашённый',
					email: 'invited@company.ru',
				}]
			}
			if (sql.includes('insert into memberships')) return []
			if (sql.includes('delete from invitations')) return []
			if (sql.includes('insert into security_events')) {
				events.push(String(params[2]))
				return []
			}
			if (sql.includes('from memberships m') && sql.includes('join companies c')) return []
			return undefined
		})
		const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/register',
			payload: {
				email: 'invited@company.ru',
				password: 'strong-pass-12',
				name: 'Новый',
				inviteToken: 'a'.repeat(32),
			},
		})
		expect(res.statusCode).toBe(201)
		// insert into memberships присутствует — авто-accept сработал
		expect(seenSql.some(s => s.includes('insert into memberships'))).toBe(true)
	})

	it('токен корректный, но email НЕ совпадает → отказ и rollback', async () => {
		const seenSql: string[] = []
		const { pool } = makeFakePool((sql, params) => {
			seenSql.push(sql)
			if (sql.includes('insert into users')) {
				return [{ id: USER_ID, email: params[0], name: params[2] }]
			}
			if (sql.includes('insert into refresh_tokens')) return []
            if (sql.includes('select email from users')) return [{email:params[0] === USER_ID ? 'invited@company.ru' : 'unknown@example.test'}]
			if (sql.includes('from invitations where secret_hash')) {
				return [{
					id: 'inv-1', expires_at:new Date(Date.now()+86400000),
					company_id: COMPANY_ID,
					role: 'manager',
					email: 'ORIGINAL@company.ru',  // не совпадает
				}]
			}
			if (sql.includes('from memberships m') && sql.includes('join companies c')) return []
			return undefined
		})
		const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/register',
			payload: {
				email: 'attacker@evil.ru',
				password: 'strong-pass-12',
				inviteToken: 'b'.repeat(32),
			},
		})
		expect(res.statusCode).toBe(403)
		expect(seenSql.some(s => s.includes('insert into memberships'))).toBe(false)
	})

	it('без inviteToken → просто обычная регистрация', async () => {
		const seenSql: string[] = []
		const { pool } = makeFakePool((sql, params) => {
			seenSql.push(sql)
			if (sql.includes('insert into users')) {
				return [{ id: USER_ID, email: params[0], name: params[2] }]
			}
			if (sql.includes('insert into refresh_tokens')) return []
			if (sql.includes('from memberships m') && sql.includes('join companies c')) return []
			return undefined
		})
		const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/register',
			payload: {
				email: 'noinvite@example.com',
				password: 'strong-pass-12',
			},
		})
		expect(res.statusCode).toBe(201)
		expect(seenSql.some(s => s.includes('from invitations where secret_hash'))).toBe(false)
	})
})

describe('export-worker', () => {
	it('runOnce: собирает JSON и апдейтит job → ready', async () => {
		const updates: unknown[] = []
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('from export_jobs where status = \'pending\'')) {
				return [{ id: 'j-42', company_id: COMPANY_ID }]
			}
			// на каждую таблицу из EXPORT_TABLES возвращаем пустой массив
			if (sql.includes('select * from ')) return []
			if (sql.includes('from users u join memberships m')) return []
			if (sql.includes('update export_jobs')) {
				updates.push(params)
				return [{}]
			}
			return undefined
		})
		const worker = startExportWorker({ pool, pollIntervalMs: 60_000 })
		await worker.runOnce()
		await worker.close()
		expect(updates.length).toBe(1)
		const p = updates[0] as unknown[]
		expect(p[0]).toBe('j-42')
		// payload — string (JSON), size > 0
		const payloadStr = p[1] as string
		expect(payloadStr).toContain('"exportedAt"')
		expect(Number(p[2])).toBeGreaterThan(20)
		// download_token — base64url, ~43 символа
		expect(typeof p[3]).toBe('string')
		expect((p[3] as string).length).toBeGreaterThan(30)
	})
})
