import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { _resetSupportUserLimit } from '../src/routes/support.js'
import { authHeaders, baseHandler, COMPANY_ID, makeFakePool, testConfig, USER_ID } from './helpers.js'

const OTHER_USER_ID = 'b0000000-0000-4000-8000-000000000002'

const TEST_N8N_URL = 'https://n8n.test.local/webhook/support'
const TEST_N8N_SECRET = 'test-secret-1234567890abcdef1234567890abcdef'

type Handler = (sql: string, params: unknown[]) => unknown[] | undefined
type MembershipOpt = { company_id: string; role: string; name: string | null } | null | undefined

async function makeApp(opts: {
	handler: Handler
	membership?: MembershipOpt
	n8n?: boolean
}) {
	const config: Config = {
		...testConfig,
		AI_SUPPORT_WEBHOOK_URL: opts.n8n ? TEST_N8N_URL : undefined,
		AI_SUPPORT_HMAC_SECRET: opts.n8n ? TEST_N8N_SECRET : undefined,
		N8N_SUPPORT_WEBHOOK_URL: undefined,
		N8N_WEBHOOK_SECRET: undefined,
	}
	const base = baseHandler({ membership: opts.membership })
	const { pool, log } = makeFakePool((sql, params) => {
		const t = opts.handler(sql, params)
		if (t !== undefined) return t
		return base(sql, params) ?? []
	})
	const app = await buildApp({ config, pool, eventBus: null })
	return { app, log }
}

/** Стандартная строка тикета из БД (то, что вернёт `returning *`). */
function ticketRow(over: Partial<Record<string, unknown>> = {}) {
	return {
		company_id: COMPANY_ID,
		id: over.id ?? 'ticket-uuid-1',
		user_id: over.user_id ?? USER_ID,
		description: 'Кнопка "Открыть смену" в кассе не срабатывает.',
		page_url: 'https://app.skladpro.ru/#/pos',
		page_title: 'Касса',
		user_agent: 'Chrome/127 build a1b2c3',
		role_snapshot: 'admin',
		context: { sentryEventId: 'evt-1' },
		status: 'received',
		pr_url: null,
		pr_number: null,
		branch_name: null,
		ai_explanation: null,
		ai_file_path: null,
		created_at: '2026-07-22T10:00:00.000Z',
		updated_at: '2026-07-22T10:00:00.000Z',
		deleted_at: null,
		...over,
	}
}

function insertHandler(row = ticketRow()): Handler {
	return (sql: string): unknown[] | undefined => {
		if (sql.includes('insert into support_tickets')) return [row]
		return undefined
	}
}

beforeEach(() => {
	_resetSupportUserLimit()
	// В тестах фейковый fetch чтобы не пытаться реально идти в n8n.
	vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('POST /v1/support/tickets', () => {
	it('создание тикета: 201 + запись в БД + ответ клиенту', async () => {
		const { app, log } = await makeApp({ handler: insertHandler() })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/support/tickets',
			headers: await authHeaders(),
			payload: {
				description: 'При открытии смены кнопка зависает и не срабатывает.',
				pageUrl: 'https://app.skladpro.ru/#/pos',
				pageTitle: 'Касса',
				userAgent: 'Chrome/127',
				context: { sentryEventId: 'evt-1' },
			},
		})
		expect(res.statusCode).toBe(201)
		const body = res.json()
		expect(body.ok).toBe(true)
		expect(body.ticket.status).toBe('received')
		// description возвращается тот, что положила фикстура ticketRow (мок insert returning *).
		expect(body.ticket.description).toBe(ticketRow().description)
		const insert = log.find(e => e.sql.includes('insert into support_tickets'))!
		expect(insert.params[0]).toBe(COMPANY_ID)
		expect(insert.params[2]).toBe(USER_ID)
	})

	it('слишком короткое описание → 400', async () => {
		const { app } = await makeApp({ handler: insertHandler() })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/support/tickets',
			headers: await authHeaders(),
			payload: { description: 'коротко' },
		})
		expect(res.statusCode).toBe(400)
		expect(res.json().error.code).toBe('VALIDATION_ERROR')
	})

	it('без Bearer → 401', async () => {
		const { app } = await makeApp({ handler: insertHandler() })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/support/tickets',
			payload: { description: 'Достаточно длинное описание проблемы для проверки.' },
		})
		expect(res.statusCode).toBe(401)
	})

	it('rate limit: 6-й тикет за минуту → 400 RATE_LIMITED', async () => {
		const { app } = await makeApp({ handler: insertHandler() })
		const payload = { description: 'Валидное описание проблемы клиента для теста.' }
		for (let i = 0; i < 5; i++) {
			const r = await app.inject({ method: 'POST', url: '/v1/support/tickets', headers: await authHeaders(), payload })
			expect(r.statusCode).toBe(201)
		}
		const r6 = await app.inject({ method: 'POST', url: '/v1/support/tickets', headers: await authHeaders(), payload })
		expect(r6.statusCode).toBe(400)
		expect(JSON.stringify(r6.json())).toContain('RATE_LIMITED')
	})

	it('если задан AI_SUPPORT_WEBHOOK_URL — исходящий webhook уходит с HMAC-подписью', async () => {
		const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)

		const { app } = await makeApp({ handler: insertHandler(), n8n: true })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/support/tickets',
			headers: await authHeaders(),
			payload: { description: 'Достаточно длинное описание проблемы клиента.' },
		})
		expect(res.statusCode).toBe(201)

		// dispatchToN8n не await'ится в роуте — даём микротаск исполниться.
		await new Promise(resolve => setImmediate(resolve))

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const call = fetchMock.mock.calls[0]!
		expect(call[0]).toBe(TEST_N8N_URL)
		const init = call[1] as RequestInit & { headers: Record<string, string> }
		expect(init.method).toBe('POST')
		expect(init.headers['x-signature']).toMatch(/^sha256=[a-f0-9]{64}$/)
		expect(init.headers['x-signature-timestamp']).toMatch(/^\d+$/)
		const rawBody = init.body as string
		const ts = Number(init.headers['x-signature-timestamp'])
		const expected = createHmac('sha256', TEST_N8N_SECRET).update(`${ts}.${rawBody}`).digest('hex')
		expect(init.headers['x-signature']).toBe(`sha256=${expected}`)
	})
})

describe('GET /v1/support/tickets', () => {
	it('обычный юзер (stock) видит только свои тикеты', async () => {
		let capturedParams: unknown[] = []
		const { app } = await makeApp({
			handler: (sql, params) => {
				if (sql.startsWith('select * from support_tickets')) {
					capturedParams = params
					return [ticketRow()]
				}
				return undefined
			},
			membership: { company_id: COMPANY_ID, role: 'stock', name: 'Кладовщик' },
		})
		const res = await app.inject({ method: 'GET', url: '/v1/support/tickets', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		expect(res.json().tickets).toHaveLength(1)
		expect(capturedParams[0]).toBe(COMPANY_ID)
		expect(capturedParams[1]).toBe(USER_ID)
	})

	it('admin с mine=false — фильтр по user_id снимается', async () => {
		let capturedParams: unknown[] = []
		let capturedSql = ''
		const { app } = await makeApp({
			handler: (sql, params) => {
				if (sql.startsWith('select * from support_tickets')) {
					capturedSql = sql
					capturedParams = params
					return []
				}
				return undefined
			},
		})
		const res = await app.inject({ method: 'GET', url: '/v1/support/tickets?mine=false', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		expect(capturedSql).not.toContain('user_id = $2')
		expect(capturedParams).toEqual([COMPANY_ID, 20, 0])
	})

	it('stock с mine=false — принудительно только свои (доступ не расширяется)', async () => {
		let capturedParams: unknown[] = []
		const { app } = await makeApp({
			handler: (sql, params) => {
				if (sql.startsWith('select * from support_tickets')) {
					capturedParams = params
					return []
				}
				return undefined
			},
			membership: { company_id: COMPANY_ID, role: 'stock', name: 'Кладовщик' },
		})
		await app.inject({ method: 'GET', url: '/v1/support/tickets?mine=false', headers: await authHeaders() })
		expect(capturedParams[1]).toBe(USER_ID)
	})
})

describe('GET /v1/support/tickets/:id', () => {
	it('владелец видит свой тикет', async () => {
		const { app } = await makeApp({
			handler: sql => {
				if (sql.startsWith('select * from support_tickets')) return [ticketRow()]
				return undefined
			},
			membership: { company_id: COMPANY_ID, role: 'stock', name: 'X' },
		})
		const res = await app.inject({
			method: 'GET',
			url: '/v1/support/tickets/ticket-uuid-1',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().ticket.id).toBe('ticket-uuid-1')
	})

	it('чужой тикет для stock → 403', async () => {
		const { app } = await makeApp({
			handler: sql => {
				if (sql.startsWith('select * from support_tickets')) return [ticketRow({ user_id: OTHER_USER_ID })]
				return undefined
			},
			membership: { company_id: COMPANY_ID, role: 'stock', name: 'X' },
		})
		const res = await app.inject({
			method: 'GET',
			url: '/v1/support/tickets/ticket-uuid-1',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(403)
	})

	it('admin видит чужой тикет', async () => {
		const { app } = await makeApp({
			handler: sql => {
				if (sql.startsWith('select * from support_tickets')) return [ticketRow({ user_id: OTHER_USER_ID })]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'GET',
			url: '/v1/support/tickets/ticket-uuid-1',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(200)
	})

	it('несуществующий тикет → 404', async () => {
		const { app } = await makeApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'GET',
			url: '/v1/support/tickets/no-such',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(404)
	})
})

describe('PATCH /v1/support/tickets/:id (webhook от n8n)', () => {
	function signBody(body: unknown, secret = TEST_N8N_SECRET, ts?: number): { headers: Record<string, string>; body: string } {
		const rawBody = JSON.stringify(body)
		const timestamp = ts ?? Math.floor(Date.now() / 1000)
		const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
		return {
			body: rawBody,
			headers: {
				'content-type': 'application/json',
				'x-signature-timestamp': String(timestamp),
				'x-signature': `sha256=${signature}`,
			},
		}
	}

	function updatingApp(): Promise<{ app: FastifyInstance }> {
		return makeApp({
			handler: sql => {
				if (sql.startsWith('update support_tickets')) return [ticketRow({ status: 'pr_open', pr_url: 'https://github.com/x/y/pull/1' })]
				return undefined
			},
			n8n: true,
		})
	}

	it('верная подпись — обновляет статус', async () => {
		const { app } = await updatingApp()
		const patch = { status: 'pr_open', prUrl: 'https://github.com/x/y/pull/1', prNumber: 1, aiExplanation: 'Причина: null-check' }
		const { headers, body } = signBody(patch)
		const res = await app.inject({ method: 'PATCH', url: '/v1/support/tickets/ticket-uuid-1', headers, payload: body })
		expect(res.statusCode).toBe(200)
		expect(res.json().ticket.status).toBe('pr_open')
	})

	it('подделанная подпись → 403', async () => {
		const { app } = await updatingApp()
		const { headers, body } = signBody({ status: 'merged' }, 'wrong-secret-wrong-secret-wrong-secret')
		const res = await app.inject({ method: 'PATCH', url: '/v1/support/tickets/ticket-uuid-1', headers, payload: body })
		expect(res.statusCode).toBe(403)
	})

	it('старый timestamp (>5 мин) → 403 (защита от replay)', async () => {
		const { app } = await updatingApp()
		const oldTs = Math.floor(Date.now() / 1000) - 10 * 60
		const { headers, body } = signBody({ status: 'merged' }, TEST_N8N_SECRET, oldTs)
		const res = await app.inject({ method: 'PATCH', url: '/v1/support/tickets/ticket-uuid-1', headers, payload: body })
		expect(res.statusCode).toBe(403)
	})

	it('нет заголовков подписи → 403', async () => {
		const { app } = await updatingApp()
		const res = await app.inject({
			method: 'PATCH',
			url: '/v1/support/tickets/ticket-uuid-1',
			headers: { 'content-type': 'application/json' },
			payload: JSON.stringify({ status: 'merged' }),
		})
		expect(res.statusCode).toBe(403)
	})

	it('feature-flag OFF (AI_SUPPORT_HMAC_SECRET не задан) → 403', async () => {
		const { app } = await makeApp({ handler: () => undefined, n8n: false })
		const { headers, body } = signBody({ status: 'merged' })
		const res = await app.inject({ method: 'PATCH', url: '/v1/support/tickets/x', headers, payload: body })
		expect(res.statusCode).toBe(403)
	})

	it('неизвестный статус → 400', async () => {
		const { app } = await updatingApp()
		const { headers, body } = signBody({ status: 'not-a-real-status' })
		const res = await app.inject({ method: 'PATCH', url: '/v1/support/tickets/ticket-uuid-1', headers, payload: body })
		expect(res.statusCode).toBe(400)
	})
})
