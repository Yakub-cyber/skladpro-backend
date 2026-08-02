import type { FastifyInstance } from 'fastify'
import type { DbPool } from '../db.js'

export function registerTrackRoutes(app: FastifyInstance, pool: DbPool) {
	app.post<{ Body: { page: string } }>(
		'/v1/track',
		{ preHandler: app.authenticateUser },
		async (req, reply) => {
			const { page } = req.body as { page: string }
			if (!page || typeof page !== 'string') {
				reply.code(400)
				return { error: { message: 'page is required' } }
			}
			const { userId } = req.auth
			const companyId = req.headers['x-company-id'] as string | undefined

			await pool.query(
				`INSERT INTO page_views (company_id, user_id, page) VALUES ($1, $2, $3)`,
				[companyId || null, userId, page.slice(0, 100)],
			)
			return { ok: true }
		},
	)
}

export function registerFeatureUsageAdminRoutes(app: FastifyInstance, pool: DbPool) {
	app.get(
		'/v1/admin/feature-usage',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			const [topPages, byCompany] = await Promise.all([
				pool.query(
					`select page, count(*)::int as views,
					        count(distinct user_id)::int as users
					 from page_views where at > now() - interval '30 days'
					 group by page order by views desc limit 20`,
				),
				pool.query(
					`select c.name as company_name, pv.page, count(*)::int as views
					 from page_views pv
					 join companies c on c.id = pv.company_id
					 where pv.at > now() - interval '7 days'
					 group by c.name, pv.page order by views desc limit 50`,
				),
			])
			return {
				topPages: topPages.rows,
				byCompany: byCompany.rows,
			}
		},
	)
}
