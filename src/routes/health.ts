import type { FastifyInstance } from 'fastify'
import type { DbPool } from '../db.js'

export function registerHealthRoutes(app: FastifyInstance, pool: DbPool) {
	// Живость процесса — без похода в БД (для load balancer / uptime-монитора).
	app.get('/health', async () => ({ ok: true, uptime: Math.round(process.uptime()) }))

	// Готовность: реально ли доступна БД.
	app.get('/health/db', async (_request, reply) => {
		try {
			await pool.query('select 1')
			return { ok: true }
		} catch {
			reply.code(503)
			return { ok: false, error: 'DB_UNAVAILABLE' }
		}
	})

	// Кто я: работает и до вступления в компанию (smoke-тест интеграции).
	app.get('/v1/me', { preHandler: app.authenticateUser }, async request => {
		const { userId, email } = request.auth
		// Один round-trip: список membership'ов + флаг супер-админа. Второй
		// select users.is_super_admin выносить в middleware не хочется — /v1/me
		// уже показывает роли, здесь же удобно вернуть и супер-флаг для UI.
		const [members, meRow] = await Promise.all([
			pool.query(
				`select m.company_id, m.role, m.name, c.name as company_name
				 from memberships m join companies c on c.id = m.company_id
				 where m.user_id = $1 and m.active
				 order by m.created_at asc`,
				[userId],
			),
			pool.query(`select is_super_admin from users where id = $1`, [userId]),
		])
		return {
			userId,
			email,
			isSuperAdmin: meRow.rows[0]?.is_super_admin === true,
			memberships: members.rows.map(r => ({
				companyId: r.company_id,
				role: r.role,
				name: r.name,
				companyName: r.company_name,
			})),
		}
	})
}
