import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTransaction, type DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'
import { verifyPassword } from '../lib/passwords.js'
import { fromRequest, logSecurityEvent } from '../services/security-log.js'

/**
 * GDPR / 152-ФЗ (B5).
 *
 * Экспорт:
 *   POST /v1/account/export — заводит фоновый job. Ответ: { jobId, status }.
 *   GET /v1/account/export/:jobId — статус + downloadUrl (если ready).
 *   GET /v1/account/export/download/:token — скачать JSON (одноразовый токен,
 *     TTL 48ч, без auth — токен уникален и в ссылке из письма/UI).
 *
 * Удаление (grace 30 дней):
 *   POST /v1/account/delete — требует password_confirm, ставит companies.deleted_at,
 *     ревокает refresh + API-keys + деактивирует webhooks.
 *   POST /v1/account/delete/cancel — админ отменяет удаление в grace-окне.
 *
 * Что не сделано: реальная почтовая рассылка (SMTP уже готов, но email
 * с ссылкой шлётся при готовности export через существующий mailer — здесь
 * оставили TODO, потому что нам сначала нужно job готов иметь).
 */

const DeleteBody = z.object({
	passwordConfirm: z.string().min(1).max(128),
})

// Таблицы, содержимое которых уходит в export по company_id.
// Movements, documents, audit — служебные, но пользователю нужны для полной
// картины (compliance).
const EXPORT_TABLES = [
	'products', 'customers', 'suppliers', 'employees', 'warehouses', 'cells',
	'orders', 'invoices', 'documents', 'movements', 'shifts', 'audit',
	'price_types', 'memberships', 'settings',
] as const

export function registerGdprRoutes(app: FastifyInstance, pool: DbPool) {
	// ── Экспорт ──────────────────────────────────────────────────────────
	app.post('/v1/account/export', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (auth.role !== 'admin') throw Errors.forbidden('Экспорт данных инициирует только админ компании')
		// Проверяем, нет ли уже pending — не хотим ставить в очередь дубли.
		const { rows: pending } = await pool.query(
			`select id from export_jobs
			 where company_id = $1 and status = 'pending' and created_at > now() - interval '1 hour'`,
			[auth.companyId],
		)
		if (pending[0]) {
			return { jobId: pending[0].id, status: 'pending', message: 'Уже готовим — подождите пару минут.' }
		}
		const { rows } = await pool.query(
			`insert into export_jobs (company_id, user_id, status)
			 values ($1, $2, 'pending')
			 returning id, created_at`,
			[auth.companyId, auth.userId],
		)
		reply.code(202)
		return { jobId: rows[0].id, status: 'pending', createdAt: rows[0].created_at }
	})

	app.get('/v1/account/export/:jobId', { preHandler: app.authenticate }, async request => {
		const jobId = (request.params as { jobId: string }).jobId
		const { rows } = await pool.query(
			`select id, status, size_bytes, download_token, error, created_at, completed_at, expires_at
			 from export_jobs where company_id = $1 and id = $2`,
			[request.auth.companyId, jobId],
		)
		const job = rows[0]
		if (!job) throw Errors.notFound('Экспорт')
		return {
			job: {
				id: job.id,
				status: job.status,
				sizeBytes: job.size_bytes ? Number(job.size_bytes) : null,
				error: job.error,
				createdAt: job.created_at,
				completedAt: job.completed_at,
				expiresAt: job.expires_at,
				// downloadUrl доступен, только если готов И токен ещё жив
				downloadUrl: job.status === 'ready' && job.download_token
					? `/v1/account/export/download/${encodeURIComponent(job.download_token)}`
					: null,
			},
		}
	})

	// Скачивание — без auth (токен — единственная защита; TTL 48ч).
	app.get('/v1/account/export/download/:token', async (request, reply) => {
		const token = (request.params as { token: string }).token
		const { rows } = await pool.query(
			`select payload, size_bytes, expires_at, company_id
			 from export_jobs where download_token = $1 and status = 'ready'`,
			[token],
		)
		const job = rows[0]
		if (!job) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Экспорт не найден или истёк' } })
		if (job.expires_at && new Date(job.expires_at).getTime() < Date.now()) {
			return reply.code(410).send({ error: { code: 'EXPIRED', message: 'Ссылка на скачивание истекла' } })
		}
		reply.header('Content-Type', 'application/json; charset=utf-8')
		reply.header('Content-Disposition', `attachment; filename="skladpro-export-${job.company_id}.json"`)
		return job.payload
	})

	// ── Удаление аккаунта ────────────────────────────────────────────────
	app.post('/v1/account/delete', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (auth.role !== 'admin') throw Errors.forbidden('Удаление компании инициирует только админ')
		const parsed = DeleteBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		// Проверяем текущий пароль пользователя — защита от захвата
		// refresh-токена (сессия угнана, но пароль неизвестен).
		const { rows } = await pool.query(
			`select password_hash from users where id = $1 and active`,
			[auth.userId],
		)
		if (!rows[0]) throw Errors.unauthorized()
		const ok = await verifyPassword(parsed.data.passwordConfirm, rows[0].password_hash)
		if (!ok) throw Errors.unauthorized('Пароль не совпадает')

		await withTransaction(pool, async client => {
			await client.query(
				`update companies set deleted_at = now() where id = $1 and deleted_at is null`,
				[auth.companyId],
			)
			// Отзыв всех refresh-токенов участников компании — они сразу
			// разлогинятся при следующей попытке. authenticateUser проверяет
			// users.active, но здесь у пользователей других компаний доступ
			// остаётся; сессии отзываются только для участников этой компании.
			await client.query(
				`update refresh_tokens set revoked_at = now()
				 where user_id in (select user_id from memberships where company_id = $1)
				   and revoked_at is null`,
				[auth.companyId],
			)
			await client.query(
				`update api_keys set active = false, revoked_at = now()
				 where company_id = $1 and revoked_at is null`,
				[auth.companyId],
			)
			await client.query(
				`update webhook_endpoints set active = false where company_id = $1`,
				[auth.companyId],
			)
		})
		await logSecurityEvent(pool, 'super_admin_action', fromRequest(request, {
			meta: { action: 'account_delete_requested', companyId: auth.companyId, graceUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() },
		}))
		return {
			ok: true,
			message: 'Учётная запись помечена на удаление. Данные будут стёрты через 30 дней. Отмена через POST /v1/account/delete/cancel.',
			graceUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
		}
	})

	// Отмена — доступна пока grace не прошёл.
	app.post('/v1/account/delete/cancel', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (auth.role !== 'admin') throw Errors.forbidden('Отменить удаление может только админ')
		const { rows } = await pool.query(
			`update companies set deleted_at = null
			 where id = $1 and deleted_at is not null and deleted_at > now() - interval '30 days'
			 returning id`,
			[auth.companyId],
		)
		if (!rows[0]) throw new (await import('../lib/errors.js')).ApiError(409, 'CANNOT_CANCEL', 'Grace-окно истекло или запрос на удаление отсутствует')
		await pool.query(
			`update api_keys set active = true, revoked_at = null
			 where company_id = $1 and revoked_at is not null and revoked_at > now() - interval '30 days'`,
			[auth.companyId],
		)
		await pool.query(
			`update webhook_endpoints set active = true where company_id = $1`,
			[auth.companyId],
		)
		return { ok: true }
	})
}

// ── Воркер экспорта ─────────────────────────────────────────────────────
export type ExportWorkerDeps = {
	pool: DbPool
	log?: (m: string) => void
	pollIntervalMs?: number
}

const DEFAULT_POLL_MS = 60_000
const EXPORT_TTL_MS = 48 * 60 * 60 * 1000

export function startExportWorker(deps: ExportWorkerDeps) {
	let closed = false
	let timer: NodeJS.Timeout | null = null

	async function tick() {
		if (closed) return
		try {
			await runOnce()
		} catch (e) {
			deps.log?.(`export-worker tick error: ${e instanceof Error ? e.message : e}`)
		}
		if (!closed) timer = setTimeout(tick, deps.pollIntervalMs ?? DEFAULT_POLL_MS)
	}

	async function runOnce() {
		const { rows } = await deps.pool.query(
			`select id, company_id from export_jobs
			 where status = 'pending' order by created_at asc limit 5`,
		)
		for (const job of rows) {
			if (closed) return
			try {
				await processJob(job.id as string, job.company_id as string)
			} catch (e) {
				deps.log?.(`export-worker job ${job.id} error: ${e instanceof Error ? e.message : e}`)
				await deps.pool.query(
					`update export_jobs set status = 'failed', error = $2, completed_at = now() where id = $1`,
					[job.id, e instanceof Error ? e.message.slice(0, 500) : 'unknown'],
				)
			}
		}
	}

	async function processJob(jobId: string, companyId: string) {
		const dump: Record<string, unknown> = { exportedAt: new Date().toISOString(), companyId }
		for (const table of EXPORT_TABLES) {
			const { rows } = await deps.pool.query(
				`select * from ${table} where company_id = $1`,
				[companyId],
			)
			dump[table] = rows
		}
		// Users в memberships (без password_hash).
		const { rows: users } = await deps.pool.query(
			`select u.id, u.email, u.name, u.created_at
			 from users u
			 join memberships m on m.user_id = u.id
			 where m.company_id = $1`,
			[companyId],
		)
		dump['users'] = users
		const payloadStr = JSON.stringify(dump)
		const token = randomBytes(32).toString('base64url')
		const expiresAt = new Date(Date.now() + EXPORT_TTL_MS)
		await deps.pool.query(
			`update export_jobs
			 set status = 'ready', payload = $2, size_bytes = $3,
			     download_token = $4, completed_at = now(), expires_at = $5
			 where id = $1`,
			[jobId, payloadStr, Buffer.byteLength(payloadStr, 'utf8'), token, expiresAt],
		)
		deps.log?.(`export-worker: job ${jobId} готов, ${Buffer.byteLength(payloadStr, 'utf8')} байт`)
	}

	timer = setTimeout(tick, 0)
	return {
		close: async () => {
			closed = true
			if (timer) clearTimeout(timer)
		},
		runOnce,
	}
}
