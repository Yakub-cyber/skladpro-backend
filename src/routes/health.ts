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

	app.get('/v1/diagnostics', { preHandler: app.authenticate }, async (request, reply) => {
		if (request.auth.role !== 'admin') throw Object.assign(new Error('Только для админа'), { statusCode: 403 })

		const t0 = Date.now()
		const [dbCheck, migrationInfo, guardInfo, reconcileInfo] = await Promise.all([
			pool.query('select 1').then(() => ({ ok: true, latencyMs: Date.now() - t0 })).catch(() => ({ ok: false, latencyMs: Date.now() - t0 })),
			pool.query("select name, applied_at from schema_migrations order by name desc limit 1").then(r => ({
				last: r.rows[0]?.name ?? null,
				count: 0,
			})).then(async info => {
				const c = await pool.query("select count(*)::int as c from schema_migrations")
				return { ...info, count: c.rows[0].c }
			}),
			pool.query("select count(*)::int as c from pg_trigger where tgname like '%ledger%' and not tgisinternal").then(r => ({
				installed: r.rows[0].c > 0,
				triggers: r.rows[0].c,
			})),
			pool.query(`select count(*)::int as issues from (
				select 1 from products p
				left join (select product_id, sum(qty) qty from stock_balances where company_id = $1 group by 1) b on b.product_id = p.id
				where p.company_id = $1 and p.deleted_at is null and abs(coalesce(p.stock,0) - coalesce(b.qty,0)) > 0.01
				union all
				select 1 from customers c
				left join (select party_id, sum(amount) amount from settlement_movements where company_id = $1 and party_kind='customer' group by 1) s on s.party_id = c.id
				where c.company_id = $1 and abs(coalesce(c.balance,0) - coalesce(s.amount,0)) > 0.01
			) t`, [request.auth.companyId]).then(r => ({
				issues: r.rows[0].issues,
			})).catch(() => ({ issues: -1 })),
		])

		return {
			version: '0.1.0',
			uptime: Math.round(process.uptime()),
			migrations: migrationInfo,
			ledgerGuard: guardInfo,
			db: dbCheck,
			reconcile: reconcileInfo,
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
