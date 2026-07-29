/**
 * Супер-админ роуты (владелец SaaS). Только для users.is_super_admin.
 *
 * Не имеют доступа к бизнес-данным компаний — только агрегаты. Реальные
 * заказы/товары клиента здесь НЕ отдаём: это уже нарушение приватности.
 * Всё, что можно — count(*), sum(total), max(updated_at).
 *
 * Активация супер-админа: только SQL-командой на сервере
 *   update users set is_super_admin = true where email = '...';
 * Через API дать/отобрать эти права нельзя — иначе супер-права можно было бы
 * запросить обычным пользователем при компрометации токена.
 */

import type { FastifyInstance } from 'fastify'
import type { DbPool } from '../db.js'

export function registerAdminRoutes(app: FastifyInstance, pool: DbPool) {
	// Общие агрегаты по всей платформе.
	app.get(
		'/v1/admin/stats',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			// 7 запросов параллельно — все дешёвые (count/sum по индексам).
			// Отдельно от orders берём последние 24ч, за неделю и за 30 дней —
			// один и тот же SELECT с разным where'ом.
			const [
				companies,
				users,
				members,
				invitations,
				dbSize,
				orders24h,
				orders30d,
			] = await Promise.all([
				pool.query(`select count(*)::int as n from companies`),
				pool.query(`select count(*)::int as n from users where active`),
				pool.query(`select count(*)::int as n from memberships where active`),
				// invitations — «активное» = «ещё существует в таблице»: /v1/invitations
				// DELETE физически удаляет запись при accept или revoke (см. routes/companies.ts).
				pool.query(`select count(*)::int as n from invitations`),
				pool.query(`select pg_database_size(current_database())::bigint as bytes`),
				pool.query(
					`select
					   count(*)::int as orders,
					   coalesce(sum(total), 0)::numeric as revenue
					 from orders
					 where deleted_at is null and created_at > now() - interval '24 hours'`,
				),
				pool.query(
					`select
					   count(*)::int as orders,
					   coalesce(sum(total), 0)::numeric as revenue
					 from orders
					 where deleted_at is null and created_at > now() - interval '30 days'`,
				),
			])
			return {
				companies: companies.rows[0].n,
				users: users.rows[0].n,
				memberships: members.rows[0].n,
				activeInvitations: invitations.rows[0].n,
				dbBytes: Number(dbSize.rows[0].bytes),
				last24h: {
					orders: orders24h.rows[0].orders,
					revenue: Number(orders24h.rows[0].revenue),
				},
				last30d: {
					orders: orders30d.rows[0].orders,
					revenue: Number(orders30d.rows[0].revenue),
				},
				uptimeSec: Math.round(process.uptime()),
			}
		},
	)

	// Список компаний с активностью — топ по обороту за 30 дней.
	// Пагинация не нужна: <10 компаний ещё лет пять.
	app.get(
		'/v1/admin/companies',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			const { rows } = await pool.query(
				`select
				   c.id,
				   c.name,
				   c.created_at,
				   (select count(*)::int from memberships m where m.company_id = c.id and m.active) as members,
				   (select count(*)::int from orders o
				      where o.company_id = c.id and o.deleted_at is null
				      and o.created_at > now() - interval '30 days') as orders_30d,
				   (select coalesce(sum(total), 0)::numeric from orders o
				      where o.company_id = c.id and o.deleted_at is null
				      and o.created_at > now() - interval '30 days') as revenue_30d,
				   (select max(created_at) from orders o
				      where o.company_id = c.id and o.deleted_at is null) as last_activity
				 from companies c
				 order by revenue_30d desc, c.created_at desc
				 limit 500`,
			)
			return {
				companies: rows.map(r => ({
					id: r.id,
					name: r.name,
					createdAt: r.created_at,
					members: r.members,
					orders30d: r.orders_30d,
					revenue30d: Number(r.revenue_30d),
					lastActivity: r.last_activity,
				})),
			}
		},
	)

	// Список пользователей платформы (все, включая супер-админов).
	app.get(
		'/v1/admin/users',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			const { rows } = await pool.query(
				`select
				   u.id,
				   u.email,
				   u.name,
				   u.active,
				   u.is_super_admin,
				   u.created_at,
				   (select count(*)::int from memberships m where m.user_id = u.id and m.active) as companies
				 from users u
				 order by u.created_at desc
				 limit 500`,
			)
			return {
				users: rows.map(r => ({
					id: r.id,
					email: r.email,
					name: r.name,
					active: r.active,
					isSuperAdmin: r.is_super_admin,
					createdAt: r.created_at,
					companies: r.companies,
				})),
			}
		},
	)
}
