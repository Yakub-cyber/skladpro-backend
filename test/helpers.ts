import type { QueryResult } from 'pg'
import { buildApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import type { DbPool } from '../src/db.js'
import { makeTokenService } from '../src/lib/tokens.js'

export const testConfig: Config = {
	NODE_ENV: 'test',
	PORT: 0,
	HOST: '127.0.0.1',
	DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
	DATABASE_SSL: 'disable',
	DATABASE_SSL_CA: undefined,
	JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
	ACCESS_TOKEN_TTL_MIN: 15,
	REFRESH_TOKEN_TTL_DAYS: 30,
	CORS_ORIGINS: '',
	RATE_LIMIT_MAX: 10_000,
	TRUST_PROXY: false,
	SMTP_URL: undefined,
	SMTP_FROM: undefined,
	APP_URL: 'https://app.skladpro.ru/',
	FIREBASE_CREDENTIALS: undefined,
	AI_SUPPORT_WEBHOOK_URL: undefined,
	AI_SUPPORT_HMAC_SECRET: undefined,
	N8N_SUPPORT_WEBHOOK_URL: undefined,
	N8N_WEBHOOK_SECRET: undefined,
}

export const tokens = makeTokenService(testConfig)

export const USER_ID = 'a0000000-0000-4000-8000-000000000001'
export const COMPANY_ID = 'c0000000-0000-4000-8000-000000000001'

export type QueryLogEntry = { sql: string; params: unknown[] }

/**
 * Скриптованный фейк пула: handler получает нормализованный SQL и параметры,
 * возвращает rows. Все запросы (включая begin/commit) пишутся в log.
 */
export function makeFakePool(handler: (sql: string, params: unknown[]) => unknown[] | undefined) {
	const log: QueryLogEntry[] = []
	const query = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
		const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
		log.push({ sql: normalized, params })
		const rows = handler(normalized, params) ?? []
		return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as unknown as QueryResult
	}
	const pool: DbPool = {
		query,
		connect: async () =>
			({
				query,
				release: () => undefined,
			}) as never,
		end: async () => undefined,
	}
	return { pool, log }
}

/**
 * Общие обработчики, повторяющиеся в тестах бизнес-эндпоинтов:
 *  - claim идемпотентности (insert into idempotency_keys),
 *  - membership+users в authenticate,
 *  - «строки нет» для остальных select'ов.
 */
export function baseHandler(opts: { membership?: { company_id: string; role: string; name: string | null } | null } = {}) {
	const membership =
		opts.membership === undefined ? { company_id: COMPANY_ID, role: 'admin', name: 'Тест' } : opts.membership
	return (sql: string, params: unknown[]): unknown[] | undefined => {
		if (sql.includes('from memberships m') && sql.includes('join users u')) return membership ? [membership] : []
		if (sql.includes('insert into idempotency_keys')) return [{ key: params[1] }]
		return undefined
	}
}

export async function makeTestApp(opts: {
	handler: (sql: string, params: unknown[]) => unknown[] | undefined
	membership?: { company_id: string; role: string; name: string | null } | null
}) {
	const base = baseHandler({ membership: opts.membership })
	const { pool, log } = makeFakePool((sql, params) => {
		// Приоритет: тестовый обработчик (undefined = «пас») → base (membership + claim ключей).
		const t = opts.handler(sql, params)
		if (t !== undefined) return t
		return base(sql, params) ?? []
	})
	// В тестах eventBus не нужен — /v1/events юниты не проверяют, а publishEvent
	// сама глотает ошибки select pg_notify.
	const app = await buildApp({ config: testConfig, pool, eventBus: null })
	return { app, log, companyId: opts.membership?.company_id ?? COMPANY_ID }
}

/**
 * Общий мок для запросов учётного ядра (docs/post_doc/warehouses/money_accounts).
 * Без этого роуты падают на select post_doc / warehouse lookup.
 */
export function coreHandler(opts: {
	postDocTotal?: number
	throwOnPostDoc?: { code: string; message: string }
	afterBalance?: number
} = {}) {
	return (sql: string, _params: unknown[]): unknown[] | undefined => {
		if (sql.includes('from warehouses') && sql.includes('deleted_at is null'))
			return [{ id: 'wh-default' }]
		if (sql.includes('from money_accounts'))
			return [{ id: 'acc-default' }]
		if (sql.includes('post_doc') || sql.includes('unpost_doc')) {
			if (opts.throwOnPostDoc) {
				throw Object.assign(new Error(opts.throwOnPostDoc.message), { code: opts.throwOnPostDoc.code })
			}
			return [{ post_doc: opts.postDocTotal ?? 0, total: opts.postDocTotal ?? 0 }]
		}
		if (sql.includes('from docs') && sql.includes('for update'))
			return [{ id: 'doc-existing' }]
		// Re-read balance after post_doc (customers.ts)
		if (sql.startsWith('select balance from customers'))
			return [{ balance: opts.afterBalance ?? 0 }]
		return undefined
	}
}

export async function authHeaders(overrides: Record<string, string> = {}) {
	const token = await tokens.signAccessToken({ sub: USER_ID, email: 'test@example.com', name: 'Тест' })
	return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...overrides }
}
