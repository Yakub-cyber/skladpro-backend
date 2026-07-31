import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import type { SupportTicketRow } from '../schemas/support.js'
import { SupportTicketBody, SupportTicketPatch } from '../schemas/support.js'

const TicketIdParam = z.object({ id: z.string().min(1).max(64) })

const ListQuery = z.object({
	// Клиенты видят только свои тикеты (mine=true — дефолт). admin/manager может
	// передать mine=false, чтобы получить все тикеты компании.
	mine: z
		.enum(['true', 'false'])
		.default('true')
		.transform(v => v === 'true'),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
})

/**
 * Per-user in-memory rate limit: 5 тикетов за 60 секунд.
 * Защищает LLM-цикл от спама в лоб (в дополнение к глобальному @fastify/rate-limit,
 * который считает по IP и потому не помешает злоумышленнику через один аккаунт
 * с разных IP). Держится в памяти инстанса — при рестарте счётчик обнуляется,
 * но злоумышленник от этого не выиграет: рестарт не под его контролем.
 */
const USER_LIMIT = { max: 5, windowMs: 60_000 }
const userHits = new Map<string, number[]>()
/** Только для тестов: сбрасывает счётчик, чтобы соседние тесты не мешали друг другу. */
export function _resetSupportUserLimit(): void {
	userHits.clear()
}
function checkUserLimit(userId: string): boolean {
	const now = Date.now()
	const hits = (userHits.get(userId) ?? []).filter(t => now - t < USER_LIMIT.windowMs)
	if (hits.length >= USER_LIMIT.max) {
		userHits.set(userId, hits)
		return false
	}
	hits.push(now)
	userHits.set(userId, hits)
	return true
}

/**
 * HMAC-SHA256 подпись webhook-тел. Формат заголовков:
 *   X-Signature-Timestamp: <unix seconds>
 *   X-Signature: sha256=<hex>
 * hex = HMAC(secret, `${timestamp}.${rawBody}`) — timestamp внутри подписи не даст
 * пересобрать её из «свежего» timestamp'а без секрета (защита от replay-атак).
 */
function signPayload(secret: string, timestamp: number, rawBody: string): string {
	return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

function verifySignature(secret: string, timestamp: number, rawBody: string, signature: string): boolean {
	// Дрейф ±5 минут — покрывает разбег часов и очередь на медленной сети,
	// но не даст злоумышленнику копить старые подписи.
	const now = Math.floor(Date.now() / 1000)
	if (Math.abs(now - timestamp) > 5 * 60) return false
	const expectedHex = signPayload(secret, timestamp, rawBody)
	const a = Buffer.from(expectedHex, 'hex')
	const b = Buffer.from(signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature, 'hex')
	if (a.length !== b.length || a.length === 0) return false
	return timingSafeEqual(a, b)
}

/**
 * Асинхронная отправка webhook в n8n. Не блокирует ответ клиенту.
 * При сбое отмечаем тикет как failed, чтобы UI не показывал вечный «received».
 * Ошибка сети/5xx — не бизнес-проблема, поэтому в лог warn, а не error.
 */
async function dispatchToN8n(
	app: FastifyInstance,
	pool: DbPool,
	config: Config,
	ticket: SupportTicketRow,
	requesterEmail: string | null,
): Promise<void> {
	if (!config.AI_SUPPORT_WEBHOOK_URL || !config.AI_SUPPORT_HMAC_SECRET) return
	const payload = {
		ticket: {
			id: ticket.id,
			companyId: ticket.company_id,
			userId: ticket.user_id,
			description: ticket.description,
			pageUrl: ticket.page_url,
			pageTitle: ticket.page_title,
			userAgent: ticket.user_agent,
			roleSnapshot: ticket.role_snapshot,
			context: ticket.context,
			createdAt: ticket.created_at,
		},
		requester: { email: requesterEmail },
		// URL для callback'а от n8n; строим относительный, чтобы не завязывать
		// сервер на конкретный внешний домен (n8n достроит по APP_URL, если надо).
		callbackPath: `/v1/support/tickets/${encodeURIComponent(ticket.id)}`,
	}
	const rawBody = JSON.stringify(payload)
	const timestamp = Math.floor(Date.now() / 1000)
	const signature = signPayload(config.AI_SUPPORT_HMAC_SECRET, timestamp, rawBody)

	try {
		const res = await fetch(config.AI_SUPPORT_WEBHOOK_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-signature-timestamp': String(timestamp),
				'x-signature': `sha256=${signature}`,
			},
			body: rawBody,
			// 10 секунд — n8n должен ответить быстро (только приём в очередь),
			// сам LLM-цикл длится минуты, но n8n возвращает 200 сразу.
			signal: AbortSignal.timeout(10_000),
		})
		if (!res.ok) throw new Error(`n8n webhook responded ${res.status}`)
	} catch (err) {
		app.log.warn({ err, ticketId: ticket.id }, 'n8n webhook dispatch failed')
		await pool
			.query(
				`update support_tickets
				 set status = 'failed'
				 where company_id = $1 and id = $2 and status = 'received'`,
				[ticket.company_id, ticket.id],
			)
			.catch(() => undefined)
		publishEvent(pool, { companyId: ticket.company_id, type: 'support_ticket', id: ticket.id })
	}
}

function rowToDto(r: SupportTicketRow) {
	return {
		id: r.id,
		userId: r.user_id,
		description: r.description,
		pageUrl: r.page_url,
		pageTitle: r.page_title,
		userAgent: r.user_agent,
		roleSnapshot: r.role_snapshot,
		context: r.context,
		status: r.status,
		prUrl: r.pr_url,
		prNumber: r.pr_number,
		branchName: r.branch_name,
		aiExplanation: r.ai_explanation,
		aiFilePath: r.ai_file_path,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}
}

export function registerSupportRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
	// ── POST /v1/support/tickets — клиент отправляет жалобу ──────────────────
	app.post('/v1/support/tickets', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (!checkUserLimit(auth.userId)) {
			throw Errors.validation({ code: 'RATE_LIMITED', message: 'Не более 5 обращений в минуту' })
		}

		const parsed = SupportTicketBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const body = parsed.data

		const ticketId = randomUUID()
		const inserted = await pool.query(
			`insert into support_tickets
			   (company_id, id, user_id, description, page_url, page_title, user_agent,
			    role_snapshot, context, status)
			 values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'received')
			 returning *`,
			[
				auth.companyId,
				ticketId,
				auth.userId,
				body.description,
				body.pageUrl ?? null,
				body.pageTitle ?? null,
				body.userAgent ?? null,
				auth.role,
				JSON.stringify(body.context),
			],
		)
		const ticket = inserted.rows[0] as SupportTicketRow

		publishEvent(pool, { companyId: auth.companyId, type: 'support_ticket', id: ticket.id })

		// Не await'им — клиент не должен ждать сеть до n8n.
		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		dispatchToN8n(app, pool, config, ticket, auth.email)

		reply.code(201)
		return { ok: true, ticket: rowToDto(ticket) }
	})

	// ── GET /v1/support/tickets — список ─────────────────────────────────────
	app.get('/v1/support/tickets', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		const q = ListQuery.safeParse(request.query)
		if (!q.success) throw Errors.validation(q.error.issues)
		const canSeeAll = auth.role === 'admin' || auth.role === 'manager'
		const mineOnly = q.data.mine || !canSeeAll

		const params: unknown[] = [auth.companyId]
		let where = `company_id = $1 and deleted_at is null`
		if (mineOnly) {
			params.push(auth.userId)
			where += ` and user_id = $${params.length}`
		}
		params.push(q.data.limit, q.data.offset)
		const listed = await pool.query(
			`select * from support_tickets
			 where ${where}
			 order by created_at desc
			 limit $${params.length - 1} offset $${params.length}`,
			params,
		)
		const rows = listed.rows as SupportTicketRow[]
		return { ok: true, tickets: rows.map(rowToDto) }
	})

	// ── GET /v1/support/tickets/:id — детали одного тикета ───────────────────
	app.get('/v1/support/tickets/:id', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		const parsed = TicketIdParam.safeParse(request.params)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const ticketId = parsed.data.id

		const canSeeAll = auth.role === 'admin' || auth.role === 'manager'
		const one = await pool.query(
			`select * from support_tickets
			 where company_id = $1 and id = $2 and deleted_at is null`,
			[auth.companyId, ticketId],
		)
		const ticket = one.rows[0] as SupportTicketRow | undefined
		if (!ticket) throw Errors.notFound(`Тикет ${ticketId}`)
		if (!canSeeAll && ticket.user_id !== auth.userId) {
			throw Errors.forbidden('Нет доступа к этому тикету')
		}
		return { ok: true, ticket: rowToDto(ticket) }
	})

	// ── PATCH /v1/support/tickets/:id — callback от n8n ──────────────────────
	// Без JWT: аутентификация через HMAC-подпись тела (X-Signature + timestamp).
	// Нужен raw body для проверки подписи — Fastify по умолчанию парсит JSON
	// и raw теряется, поэтому включаем контент-парсер, который сохраняет raw
	// на request.rawBody. Простой путь: считаем HMAC от canonical JSON, который
	// получается из уже распарсенного тела — эквивалентно, если n8n тоже
	// стрингифаит через JSON.stringify(body). Мы принудительно требуем JSON,
	// поэтому переупорядочивание ключей не проблема (сервер сравнит подпись
	// от той же строки, что n8n подписал).
	app.patch('/v1/support/tickets/:id', async request => {
		if (!config.AI_SUPPORT_HMAC_SECRET) {
			// Feature-flag: если не настроен n8n — этот эндпоинт закрыт.
			throw Errors.forbidden('n8n integration is disabled')
		}
		const paramsParsed = TicketIdParam.safeParse(request.params)
		if (!paramsParsed.success) throw Errors.validation(paramsParsed.error.issues)
		const ticketId = paramsParsed.data.id

		const timestampHeader = request.headers['x-signature-timestamp']
		const signatureHeader = request.headers['x-signature']
		if (typeof timestampHeader !== 'string' || typeof signatureHeader !== 'string') {
			throw Errors.forbidden('Missing signature headers')
		}
		const timestamp = Number(timestampHeader)
		if (!Number.isFinite(timestamp)) throw Errors.forbidden('Bad timestamp')

		// Канонизируем: подписываем ту же строку, что n8n. Здесь фронт-договор:
		// n8n шлёт JSON.stringify(тело) и подписывает эту же строку.
		const rawBody = JSON.stringify(request.body ?? {})
		if (!verifySignature(config.AI_SUPPORT_HMAC_SECRET, timestamp, rawBody, signatureHeader)) {
			throw Errors.forbidden('Bad signature')
		}

		const bodyParsed = SupportTicketPatch.safeParse(request.body)
		if (!bodyParsed.success) throw Errors.validation(bodyParsed.error.issues)
		const patch = bodyParsed.data

		// Заранее не знаем companyId → находим тикет по id глобально (id UUID уникален).
		const updated = await pool.query(
			`update support_tickets
			 set status = $2,
			     pr_url = coalesce($3, pr_url),
			     pr_number = coalesce($4, pr_number),
			     branch_name = coalesce($5, branch_name),
			     ai_explanation = coalesce($6, ai_explanation),
			     ai_file_path = coalesce($7, ai_file_path)
			 where id = $1 and deleted_at is null
			 returning *`,
			[
				ticketId,
				patch.status,
				patch.prUrl ?? null,
				patch.prNumber ?? null,
				patch.branchName ?? null,
				patch.aiExplanation ?? null,
				patch.aiFilePath ?? null,
			],
		)
		const ticket = updated.rows[0] as SupportTicketRow | undefined
		if (!ticket) throw Errors.notFound(`Тикет ${ticketId}`)

		publishEvent(pool, { companyId: ticket.company_id, type: 'support_ticket', id: ticket.id })
		return { ok: true, ticket: rowToDto(ticket) }
	})
}
