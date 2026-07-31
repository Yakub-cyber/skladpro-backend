import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { encryptSecret, decryptSecret } from '../src/lib/crypto-aes.js'
import { classifyAtolError } from '../src/services/fiscal/atol.js'
import { authHeaders, baseHandler, COMPANY_ID, makeFakePool, testConfig } from './helpers.js'

const FISCAL_KEY = 'test-fiscal-key-that-is-long-enough-1234567890'
const cfg = { ...testConfig, FISCAL_KMS_KEY: FISCAL_KEY }

describe('AES-GCM crypto helper', () => {
	it('encrypt → decrypt возвращает исходный plaintext', () => {
		const secret = 'p@ssw0rd-2024'
		const enc = encryptSecret(secret, 'kms-key-1')
		expect(enc.length).toBeGreaterThan(28)  // iv(12)+ct+tag(16)
		const dec = decryptSecret(enc, 'kms-key-1')
		expect(dec).toBe(secret)
	})

	it('wrong key → бросает исключение', () => {
		const enc = encryptSecret('secret', 'kms-key-1')
		expect(() => decryptSecret(enc, 'kms-key-2')).toThrow()
	})

	it('пустой ключ → бросает при encrypt', () => {
		expect(() => encryptSecret('x', '')).toThrow(/FISCAL_KMS_KEY/)
	})
})

describe('GET /v1/fiscal/config', () => {
	it('без FISCAL_KMS_KEY → 503', async () => {
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'GET',
			url: '/v1/fiscal/config',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(503)
		expect(res.json().error.code).toBe('FISCAL_DISABLED')
	})

	it('с ключом и без конфига → { config: null }', async () => {
		const { pool } = makeFakePool((sql, params) => {
			const base = baseHandler()
			if (sql.includes('from fiscal_configs where company_id')) return []
			return base(sql, params)
		})
		const app = await buildApp({ config: cfg, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'GET',
			url: '/v1/fiscal/config',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().config).toBeNull()
	})

	it('возвращает конфиг без plaintext пароля', async () => {
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('from fiscal_configs where company_id')) {
				return [{
					provider: 'atol',
					login: 'atol-user',
					group_code: 'gc-42',
					inn: '1234567890',
					payment_address: 'skladpro.ru',
					organization_name: 'ООО «Тест»',
					sno: 'usn_income',
					default_vat: 'none',
					sender_email: 'kassa@example.ru',
					active: true,
					updated_at: new Date('2026-08-01'),
				}]
			}
			return baseHandler()(sql, params)
		})
		const app = await buildApp({ config: cfg, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'GET',
			url: '/v1/fiscal/config',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.config.login).toBe('atol-user')
		expect(body.config.password).toBe('***')  // маска
	})
})

describe('PUT /v1/fiscal/config', () => {
	it('роль stock → 403', async () => {
		const { pool } = makeFakePool(baseHandler({ membership: { company_id: COMPANY_ID, role: 'stock', name: 'X' } }))
		const app = await buildApp({ config: cfg, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'PUT',
			url: '/v1/fiscal/config',
			headers: await authHeaders(),
			payload: {
				login: 'atol-user',
				password: 'secret',
				groupCode: 'gc',
				inn: '1234567890',
				paymentAddress: 'skladpro.ru',
			},
		})
		expect(res.statusCode).toBe(403)
	})

	it('admin с паролем → шифрует и upsert', async () => {
		let inserted: unknown[] = []
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('insert into fiscal_configs')) {
				inserted = params
				return []
			}
			return baseHandler()(sql, params)
		})
		const app = await buildApp({ config: cfg, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'PUT',
			url: '/v1/fiscal/config',
			headers: await authHeaders(),
			payload: {
				login: 'atol-user',
				password: 'super-secret',
				groupCode: 'gc-42',
				inn: '1234567890',
				paymentAddress: 'skladpro.ru',
			},
		})
		expect(res.statusCode).toBe(200)
		// params[2] — password_encrypted (Buffer)
		expect(Buffer.isBuffer(inserted[2])).toBe(true)
		// расшифровка возвращает исходный пароль
		expect(decryptSecret(inserted[2] as Buffer, FISCAL_KEY)).toBe('super-secret')
	})

	it('admin без пароля → пропускает password_encrypted', async () => {
		let calledCols = ''
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('insert into fiscal_configs')) {
				calledCols = sql
				return []
			}
			return baseHandler()(sql, params)
		})
		const app = await buildApp({ config: cfg, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'PUT',
			url: '/v1/fiscal/config',
			headers: await authHeaders(),
			payload: {
				login: 'atol-user',
				groupCode: 'gc',
				inn: '1234567890',
				paymentAddress: 'skladpro.ru',
			},
		})
		expect(res.statusCode).toBe(200)
		expect(calledCols).not.toContain('password_encrypted')
	})
})

describe('POST /v1/fiscal/receipts', () => {
	it('без Idempotency-Key → 400', async () => {
		const { pool } = makeFakePool(baseHandler())
		const app = await buildApp({ config: cfg, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/fiscal/receipts',
			headers: await authHeaders(),
			payload: {
				saleId: '00000000-0000-4000-8000-000000000042',
				items: [{ name: 'Товар', price: 100, quantity: 1, sum: 100 }],
				payments: [{ type: 1, sum: 100 }],
				total: 100,
			},
		})
		expect(res.statusCode).toBe(400)
	})

	it('без настроенного конфига ККТ → 412 FISCAL_NOT_CONFIGURED', async () => {
		const { pool } = makeFakePool((sql, params) => {
			if (sql.includes('from fiscal_configs where company_id')) return []
			if (sql.includes('insert into idempotency_keys')) return [{ key: params[1] }]
			return baseHandler()(sql, params)
		})
		const app = await buildApp({ config: cfg, pool, eventBus: null, fcm: null })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/fiscal/receipts',
			headers: {
				...(await authHeaders()),
				'idempotency-key': 'fiscal-test-1',
			},
			payload: {
				saleId: '00000000-0000-4000-8000-000000000042',
				items: [{ name: 'Товар', price: 100, quantity: 1, sum: 100 }],
				payments: [{ type: 1, sum: 100 }],
				total: 100,
			},
		})
		expect(res.statusCode).toBe(412)
		expect(res.json().error.code).toBe('FISCAL_NOT_CONFIGURED')
	})
})

describe('classifyAtolError', () => {
	it('код 20 → AUTH_FAIL', () => {
		expect(classifyAtolError(20, 'session expired')).toBe('AUTH_FAIL')
	})
	it('код 30 → RETRY_LATER', () => {
		expect(classifyAtolError(30, 'нет связи с ккт')).toBe('RETRY_LATER')
	})
	it('код 5 + «таймаут» → RETRY_LATER (по тексту)', () => {
		expect(classifyAtolError(5, 'таймаут запроса')).toBe('RETRY_LATER')
	})
	it('неизвестный код → FATAL_INVALID_DATA', () => {
		expect(classifyAtolError(99, 'unknown')).toBe('FATAL_INVALID_DATA')
	})
})
