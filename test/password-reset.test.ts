import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Mailer } from '../src/services/mailer.js'
import { makeFakePool, testConfig, USER_ID } from './helpers.js'

const passwordHash = bcrypt.hashSync('old-password-1', 4)

function fakeMailer() {
	const sent: Array<{ to: string; subject: string; text: string }> = []
	const mailer: Mailer = {
		available: true,
		send: async opts => { sent.push(opts); return { ok: true } },
	}
	return { mailer, sent }
}

describe('POST /v1/auth/password/reset', () => {
	it('известный email → 200 + письмо с magic-link', async () => {
		const { mailer, sent } = fakeMailer()
		let insertedTokenHash: string | null = null
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('from users where lower(email)'))
				return [{ id: USER_ID, email: 't@t.ru', name: 'Тест', active: true }]
			if (sql.startsWith('insert into password_reset_tokens')) {
				insertedTokenHash = String(params[1])
				return []
			}
			return []
		})
		const app = await buildApp({ config: { ...testConfig, APP_URL: 'https://app.skladpro.ru/' }, pool, mailer })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/reset',
			payload: { email: 't@t.ru' },
		})
		expect(res.statusCode).toBe(200)
		// Ждём tick, чтобы .then() успел выполниться (mailer.send fire-and-forget).
		await new Promise(r => setTimeout(r, 20))
		expect(sent).toHaveLength(1)
		expect(sent[0]!.to).toBe('t@t.ru')
		expect(sent[0]!.text).toMatch(/https:\/\/app\.skladpro\.ru\/#\/reset\?token=/)
		// Токен НЕ хранится в открытом виде — только sha256-хэш.
		expect(insertedTokenHash).toBeTruthy()
		expect(insertedTokenHash).toHaveLength(64)
		// URL содержит именно тот токен, hash которого лёг в БД.
		const rawToken = decodeURIComponent(sent[0]!.text.match(/token=([^\s]+)/)![1]!)
		expect(createHash('sha256').update(rawToken).digest('hex')).toBe(insertedTokenHash)
	})

	it('неизвестный email → 200 БЕЗ письма (не выдаём user enumeration)', async () => {
		const { mailer, sent } = fakeMailer()
		const { pool } = makeFakePool(sql => {
			if (sql.includes('from users where lower(email)')) return []
			return []
		})
		const app = await buildApp({ config: testConfig, pool, mailer })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/reset',
			payload: { email: 'nobody@t.ru' },
		})
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual({ ok: true })
		await new Promise(r => setTimeout(r, 20))
		expect(sent).toHaveLength(0)
	})

	it('SMTP недоступен → 200 БЕЗ письма (CI/dev-конфиг)', async () => {
		const mailer: Mailer = { available: false, send: async () => ({ ok: false }) }
		const { pool, log } = makeFakePool(sql => {
			if (sql.includes('from users where lower(email)'))
				return [{ id: USER_ID, email: 't@t.ru', name: null, active: true }]
			return []
		})
		const app = await buildApp({ config: testConfig, pool, mailer })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/reset',
			payload: { email: 't@t.ru' },
		})
		expect(res.statusCode).toBe(200)
		// Токен не создавался — smtp не готов, смысла нет.
		expect(log.some(e => e.sql.startsWith('insert into password_reset_tokens'))).toBe(false)
	})

	it('деактивированный пользователь → 200 без письма', async () => {
		const { mailer, sent } = fakeMailer()
		const { pool } = makeFakePool(sql => {
			if (sql.includes('from users where lower(email)'))
				return [{ id: USER_ID, email: 't@t.ru', name: null, active: false }]
			return []
		})
		const app = await buildApp({ config: testConfig, pool, mailer })
		await app.inject({ method: 'POST', url: '/v1/auth/password/reset', payload: { email: 't@t.ru' } })
		await new Promise(r => setTimeout(r, 20))
		expect(sent).toHaveLength(0)
	})

	it('невалидный email → 400', async () => {
		const { mailer } = fakeMailer()
		const { pool } = makeFakePool(() => [])
		const app = await buildApp({ config: testConfig, pool, mailer })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/reset',
			payload: { email: 'not-email' },
		})
		expect(res.statusCode).toBe(400)
	})
})

describe('POST /v1/auth/password/reset/confirm', () => {
	it('валидный неиспользованный токен → меняет пароль + гасит семьи', async () => {
		let familyRevoked = false
		let tokenUsed = false
		let newHash: string | null = null
		const { pool } = makeFakePool((sql, params) => {
			if (sql.startsWith('select id, user_id, expires_at, used_at from password_reset_tokens')) {
				return [{ id: 'prt-1', user_id: USER_ID, expires_at: new Date(Date.now() + 3600_000), used_at: null }]
			}
			if (sql.startsWith('update users set password_hash')) {
				newHash = String(params[1])
				return []
			}
			if (sql.startsWith('update password_reset_tokens set used_at')) { tokenUsed = true; return [] }
			if (sql.startsWith('update refresh_tokens set revoked_at') && sql.includes('user_id = $1')) {
				familyRevoked = true; return []
			}
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/reset/confirm',
			payload: { token: 'a-good-long-reset-token-value', newPassword: 'new-password-2' },
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().ok).toBe(true)
		expect(tokenUsed).toBe(true)
		expect(familyRevoked).toBe(true)
		expect(bcrypt.compareSync('new-password-2', newHash!)).toBe(true)
	})

	it('токен уже использован → 401', async () => {
		const { pool } = makeFakePool(sql => {
			if (sql.startsWith('select id, user_id, expires_at, used_at from password_reset_tokens'))
				return [{ id: 'prt-1', user_id: USER_ID, expires_at: new Date(Date.now() + 3600_000), used_at: new Date() }]
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/reset/confirm',
			payload: { token: 'a-good-long-reset-token-value', newPassword: 'new-password-2' },
		})
		expect(res.statusCode).toBe(401)
	})

	it('токен истёк → 401 с сообщением про новую ссылку', async () => {
		const { pool } = makeFakePool(sql => {
			if (sql.startsWith('select id, user_id, expires_at, used_at from password_reset_tokens'))
				return [{ id: 'prt-1', user_id: USER_ID, expires_at: new Date(Date.now() - 60_000), used_at: null }]
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/reset/confirm',
			payload: { token: 'a-good-long-reset-token-value', newPassword: 'new-password-2' },
		})
		expect(res.statusCode).toBe(401)
		expect(res.json().error.message).toMatch(/истек|новую/i)
	})

	it('несуществующий токен → 401', async () => {
		const { pool } = makeFakePool(sql => {
			if (sql.startsWith('select id, user_id, expires_at, used_at from password_reset_tokens')) return []
			return []
		})
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/reset/confirm',
			payload: { token: 'a-good-long-reset-token-value', newPassword: 'new-password-2' },
		})
		expect(res.statusCode).toBe(401)
	})

	it('слабый пароль → 400', async () => {
		const { pool } = makeFakePool(() => [])
		const app = await buildApp({ config: testConfig, pool })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/auth/password/reset/confirm',
			payload: { token: 'a-good-long-reset-token-value', newPassword: 'short' },
		})
		expect(res.statusCode).toBe(400)
	})
})
