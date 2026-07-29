import bcrypt from 'bcryptjs'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeFakePool, testConfig, tokens, USER_ID } from './helpers.js'

const passwordHash = bcrypt.hashSync('old-password-1', 4)

async function bearer() {
	const token = await tokens.signAccessToken({ sub: USER_ID, email: 't@t.ru', name: null })
	return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

describe('POST /v1/auth/password/change', () => {
	it('меняет пароль и гасит все refresh-семьи пользователя', async () => {
		let revokedAll = false
		let newHash: string | null = null
		const { pool } = makeFakePool((sql, params) => {
			if (sql.startsWith('select password_hash from users where id')) return [{ password_hash: passwordHash }]
			if (sql.startsWith('update users set password_hash')) {
				newHash = String(params[1])
				return []
			}
			if (sql.startsWith('update refresh_tokens set revoked_at') && sql.includes('user_id = $1')) {
				revokedAll = true
				return []
			}
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/change',
			headers: await bearer(),
			payload: { oldPassword: 'old-password-1', newPassword: 'new-password-2' },
		})
		expect(res.statusCode).toBe(200)
		expect(revokedAll).toBe(true)
		expect(newHash).toBeTruthy()
		expect(bcrypt.compareSync('new-password-2', newHash!)).toBe(true)
	})

	it('неверный старый пароль → 401', async () => {
		const { pool } = makeFakePool(sql => {
			if (sql.startsWith('select password_hash from users where id')) return [{ password_hash: passwordHash }]
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/change',
			headers: await bearer(),
			payload: { oldPassword: 'wrong-password', newPassword: 'new-password-2' },
		})
		expect(res.statusCode).toBe(401)
	})

	it('слабый новый пароль → 400', async () => {
		const { pool } = makeFakePool(() => [])
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/change',
			headers: await bearer(),
			payload: { oldPassword: 'anything', newPassword: 'short' },
		})
		expect(res.statusCode).toBe(400)
	})

	it('новый == старый → 400', async () => {
		const { pool } = makeFakePool(sql => {
			if (sql.startsWith('select password_hash from users where id')) return [{ password_hash: passwordHash }]
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/change',
			headers: await bearer(),
			payload: { oldPassword: 'old-password-1', newPassword: 'old-password-1' },
		})
		expect(res.statusCode).toBe(400)
	})

	it('без токена → 401', async () => {
		const { pool } = makeFakePool(() => [])
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/change',
			payload: { oldPassword: 'x', newPassword: 'new-password-2' },
		})
		expect(res.statusCode).toBe(401)
	})
})

// Тесты /v1/auth/password/reset и /reset/confirm вынесены в password-reset.test.ts.
