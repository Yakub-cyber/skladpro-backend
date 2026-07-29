import bcrypt from 'bcryptjs'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { hashRefreshToken } from '../src/lib/tokens.js'
import { COMPANY_ID, makeFakePool, testConfig, USER_ID } from './helpers.js'

const passwordHash = bcrypt.hashSync('correct-password', 4) // 4 раунда — быстрее в тестах

describe('auth', () => {
	it('register: создаёт пользователя, отдаёт пару токенов', async () => {
		const { pool, log } = makeFakePool(sql => {
			if (sql.includes('insert into users')) return [{ id: USER_ID, email: 'new@example.com', name: 'Новый' }]
			if (sql.includes('from memberships m join companies')) return []
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/register',
			payload: { email: 'new@example.com', password: 'password123', name: 'Новый' },
		})
		expect(res.statusCode).toBe(201)
		const body = res.json()
		expect(body.accessToken).toBeTruthy()
		expect(body.refreshToken).toBeTruthy()
		expect(body.user.email).toBe('new@example.com')
		// Пароль захэширован bcrypt'ом, не в открытом виде
		const insert = log.find(e => e.sql.includes('insert into users'))!
		expect(String(insert.params[1])).toMatch(/^\$2[aby]\$/)
		// refresh-токен в БД — только хэш
		const rt = log.find(e => e.sql.includes('insert into refresh_tokens'))!
		expect(String(rt.params[1])).toHaveLength(64) // sha256 hex
		expect(body.refreshToken).not.toBe(rt.params[1])
		// НИ ОДИН запрос к invitations — auto-join сознательно убран
		expect(log.some(e => e.sql.includes('from invitations'))).toBe(false)
		expect(log.some(e => e.sql.includes('insert into memberships'))).toBe(false)
	})

	it('register: пользователь с приглашением НЕ автоприсоединяется (нужен явный accept)', async () => {
		const { pool, log } = makeFakePool(sql => {
			if (sql.includes('insert into users')) return [{ id: USER_ID, email: 'invited@example.com', name: null }]
			if (sql.includes('from memberships m join companies')) return []
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/register',
			payload: { email: 'invited@example.com', password: 'password123' },
		})
		expect(res.statusCode).toBe(201)
		expect(res.json().memberships).toEqual([])
		expect(log.some(e => e.sql.includes('insert into memberships'))).toBe(false)
	})

	it('register: занятый email → 409 (23505), слабый пароль → 400', async () => {
		const { pool } = makeFakePool(sql => {
			if (sql.includes('insert into users')) {
				// эмулируем unique-конфликт по email — как это делает Postgres
				const err = new Error('duplicate key value violates unique constraint "users_email_unique"') as Error & {
					code?: string
				}
				err.code = '23505'
				throw err
			}
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const dup = await app.inject({
			method: 'POST',
			url: '/v1/auth/register',
			payload: { email: 'taken@example.com', password: 'password123' },
		})
		expect(dup.statusCode).toBe(409)

		const weak = await app.inject({
			method: 'POST',
			url: '/v1/auth/register',
			payload: { email: 'x@example.com', password: 'short' },
		})
		expect(weak.statusCode).toBe(400)
	})

	it('login: верный пароль → токены, неверный → 401 с одинаковым сообщением', async () => {
		const { pool } = makeFakePool(sql => {
			if (sql.includes('from users where lower(email)'))
				return [{ id: USER_ID, email: 't@t.ru', name: null, password_hash: passwordHash, active: true, must_reset: false }]
			if (sql.includes('from memberships m join companies'))
				return [{ company_id: COMPANY_ID, role: 'admin', name: 'Т', company_name: 'ООО Тест' }]
			return []
		})
		const app = await buildApp({ config: testConfig, pool })

		const ok = await app.inject({
			method: 'POST',
			url: '/v1/auth/login',
			payload: { email: 't@t.ru', password: 'correct-password' },
		})
		expect(ok.statusCode).toBe(200)
		expect(ok.json().memberships[0].companyId).toBe(COMPANY_ID)

		const bad = await app.inject({
			method: 'POST',
			url: '/v1/auth/login',
			payload: { email: 't@t.ru', password: 'wrong-password' },
		})
		expect(bad.statusCode).toBe(401)

		const noUser = await app.inject({
			method: 'POST',
			url: '/v1/auth/login',
			payload: { email: 'nobody@t.ru', password: 'whatever-pass' },
		})
		expect(noUser.statusCode).toBe(401)
		expect(noUser.json().error.message).toBe(bad.json().error.message)
	})

	it('refresh: ротация — старый токен гасится, выдаётся новый', async () => {
		const tokenHash = hashRefreshToken('some-refresh-token-value')
		let revoked = false
		const { pool, log } = makeFakePool(sql => {
			if (sql.includes('from refresh_tokens rt join users'))
				return [
					{
						id: 'rt-1',
						user_id: USER_ID,
						family: 'fam-1',
						expires_at: new Date(Date.now() + 86400_000).toISOString(),
						revoked_at: null,
						email: 't@t.ru',
						name: null,
						active: true,
					},
				]
			if (sql.includes('update refresh_tokens set revoked_at = now() where id')) {
				revoked = true
				return []
			}
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/refresh',
			payload: { refreshToken: 'some-refresh-token-value' },
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().accessToken).toBeTruthy()
		expect(revoked).toBe(true)
		const lookup = log.find(e => e.sql.includes('from refresh_tokens rt join users'))!
		expect(lookup.params[0]).toBe(tokenHash)
		const insert = log.find(e => e.sql.includes('insert into refresh_tokens'))!
		expect(insert.params[2]).toBe('fam-1')
	})

	it('refresh: повторный запрос в GRACE-окне (потерянный ответ на LTE) НЕ гасит семью', async () => {
		// Токен только что ротирован (2 секунды назад) → это ретрай, а не кража.
		let familyRevoked = false
		const { pool } = makeFakePool(sql => {
			if (sql.includes('from refresh_tokens rt join users'))
				return [
					{
						id: 'rt-1',
						user_id: USER_ID,
						family: 'fam-1',
						expires_at: new Date(Date.now() + 86400_000).toISOString(),
						revoked_at: new Date(Date.now() - 2_000).toISOString(), // ротирован 2с назад
						email: 't@t.ru',
						name: null,
						active: true,
					},
				]
			if (sql.includes('from refresh_tokens where family') && sql.includes('created_at >'))
				return [{ id: 'rt-2', token_hash_ciphertext: null, revoked_at: null }] // преемник ещё жив
			if (sql.includes('where family = $1 and revoked_at is null')) {
				familyRevoked = true
				return []
			}
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/refresh',
			payload: { refreshToken: 'lte-retry-value-longer-than-min' },
		})
		expect(res.statusCode).toBe(401) // клиенту скажем «используйте новую пару»
		expect(res.json().error.message).toContain('свежую') // «свежую пару»
		expect(familyRevoked).toBe(false) // а семью НЕ гасим
	})

	it('refresh: старый токен вне grace-окна → семья гасится (кража)', async () => {
		let familyRevoked = false
		const { pool } = makeFakePool(sql => {
			if (sql.includes('from refresh_tokens rt join users'))
				return [
					{
						id: 'rt-1',
						user_id: USER_ID,
						family: 'fam-1',
						expires_at: new Date(Date.now() + 86400_000).toISOString(),
						revoked_at: new Date(Date.now() - 60_000).toISOString(), // минуту назад — за окном
						email: 't@t.ru',
						name: null,
						active: true,
					},
				]
			if (sql.includes('where family = $1 and revoked_at is null')) {
				familyRevoked = true
				return []
			}
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/refresh',
			payload: { refreshToken: 'stolen-token-value' },
		})
		expect(res.statusCode).toBe(401)
		expect(familyRevoked).toBe(true)
	})

	it('доступ с чужим X-Company-Id запрещён', async () => {
		const { pool } = makeFakePool(sql => {
			if (sql.includes('from memberships m') && sql.includes('join users u'))
				return [{ company_id: COMPANY_ID, role: 'admin', name: 'Т' }]
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const { tokens } = await import('./helpers.js')
		const token = await tokens.signAccessToken({ sub: USER_ID, email: 't@t.ru', name: null })
		const res = await app.inject({
			method: 'GET',
			url: '/v1/sync/pull',
			headers: { authorization: `Bearer ${token}`, 'x-company-id': 'c9999999-0000-4000-8000-000000000999' },
		})
		expect(res.statusCode).toBe(403)
	})
})
