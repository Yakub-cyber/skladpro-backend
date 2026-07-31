import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'
import { fromRequest, logSecurityEvent } from '../services/security-log.js'

/**
 * CRUD API-ключей компании. Только для admin/manager.
 * Формат ключа: sk_live_<8char prefix>_<32char secret>.
 * Секрет отдаётся клиенту РОВНО ОДИН РАЗ при создании — потом маска.
 */

// Допустимые scopes. При добавлении фичи публичного API — добавляй сюда,
// а не в БД: тогда старые ключи со снятыми scopes не смогут случайно
// получить доступ к новой возможности.
export const KNOWN_SCOPES = [
	'products:read',
	'products:write',
	'customers:read',
	'customers:write',
	'orders:read',
	'orders:write',
	'documents:read',
	'documents:write',
] as const

const CreateBody = z.object({
	name: z.string().min(1).max(200),
	scopes: z.array(z.enum(KNOWN_SCOPES)).min(1),
})

function generateKey() {
	// prefix: 8 символов base32 (шумит меньше чем hex, читабельнее),
	// secret: 32 байта base64url.
	const prefix = randomBytes(6).toString('hex').slice(0, 8)
	const secret = randomBytes(32).toString('base64url')
	return { prefix, secret, hash: createHash('sha256').update(secret).digest('hex') }
}

export function registerApiKeyRoutes(app: FastifyInstance, pool: DbPool) {
	app.get('/v1/api-keys', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden()
		const { rows } = await pool.query(
			`select id, name, prefix, scopes, active, created_at, last_used_at, revoked_at
			 from api_keys where company_id = $1
			 order by created_at desc`,
			[auth.companyId],
		)
		return {
			keys: rows.map(r => ({
				id: r.id, name: r.name, prefix: r.prefix,
				// Маскируем секрет ('sk_live_prefix_...') — plain уже не отдаём никогда.
				keyPreview: `sk_live_${r.prefix}_${'*'.repeat(8)}...`,
				scopes: r.scopes,
				active: r.active,
				createdAt: r.created_at,
				lastUsedAt: r.last_used_at,
				revokedAt: r.revoked_at,
			})),
		}
	})

	app.post('/v1/api-keys', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden()
		const parsed = CreateBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const key = generateKey()
		const { rows } = await pool.query(
			`insert into api_keys (company_id, name, prefix, hash, scopes)
			 values ($1, $2, $3, $4, $5)
			 returning id, created_at`,
			[auth.companyId, parsed.data.name, key.prefix, key.hash, parsed.data.scopes],
		)
		const row = rows[0]
		await logSecurityEvent(pool, 'api_key_created', fromRequest(request, {
			meta: { id: row.id, prefix: key.prefix, name: parsed.data.name },
		}))
		reply.code(201)
		return {
			id: row.id,
			name: parsed.data.name,
			scopes: parsed.data.scopes,
			// Первый и последний раз, когда пользователь видит plain-секрет.
			key: `sk_live_${key.prefix}_${key.secret}`,
			prefix: key.prefix,
			createdAt: row.created_at,
		}
	})

	app.delete('/v1/api-keys/:id', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden()
		const id = (request.params as { id: string }).id
		const { rowCount } = await pool.query(
			`update api_keys set active = false, revoked_at = now()
			 where company_id = $1 and id = $2 and revoked_at is null`,
			[auth.companyId, id],
		)
		if (!rowCount) throw Errors.notFound('API-ключ')
		await logSecurityEvent(pool, 'api_key_revoked', fromRequest(request, { meta: { id } }))
		return { ok: true }
	})
}
