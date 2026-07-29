import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'

const RegisterBody = z.object({
	token: z.string().min(4).max(4096),
	platform: z.enum(['android', 'ios', 'web']),
})

/**
 * POST /v1/push/tokens        — регистрация FCM-токена устройства.
 * DELETE /v1/push/tokens/:token — отписка (при logout).
 *
 * Токен уникален в паре (user_id, token). При обновлении токена Firebase
 * (rotate) клиент шлёт новый — старый удалится при следующей чистке
 * или после первой попытки отправки (invalidTokens).
 */
export function registerPushRoutes(app: FastifyInstance, pool: DbPool) {
	app.post('/v1/push/tokens', { preHandler: app.authenticate }, async (request, reply) => {
		const parsed = RegisterBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { token, platform } = parsed.data
		const auth = request.auth

		await pool.query(
			`insert into push_tokens (user_id, company_id, token, platform)
			 values ($1, $2, $3, $4)
			 on conflict (user_id, token) do update
			   set company_id = excluded.company_id,
			       platform = excluded.platform,
			       last_error = null,
			       last_error_at = null`,
			[auth.userId, auth.companyId, token, platform],
		)
		reply.code(201)
		return { ok: true }
	})

	app.delete('/v1/push/tokens/:token', { preHandler: app.authenticate }, async request => {
		const token = (request.params as { token: string }).token
		if (!token || token.length > 4096) throw Errors.validation([{ message: 'Некорректный токен' }])
		await pool.query(
			`delete from push_tokens where user_id = $1 and token = $2`,
			[request.auth.userId, token],
		)
		return { ok: true }
	})
}
