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
			const [
				companies,
				users,
				members,
				invitations,
				dbSize,
				orders24h,
				orders30d,
				planBreakdown,
				expiringTrials,
				mrr,
				growth,
				dauMau,
				security24h,
			] = await Promise.all([
				pool.query(`select count(*)::int as n from companies`),
				pool.query(`select count(*)::int as n from users where active`),
				pool.query(`select count(*)::int as n from memberships where active`),
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
				pool.query(`select plan, count(*)::int as n from subscriptions group by plan`),
				pool.query(
					`select count(*)::int as n from subscriptions
					 where status = 'trial' and trial_ends_at < now() + interval '7 days' and trial_ends_at > now()`,
				),
				pool.query(
					`select coalesce(sum(amount), 0)::numeric as total
					 from subscription_payments
					 where status = 'succeeded' and created_at > now() - interval '30 days'`,
				),
				pool.query(
					`select
					   count(*) filter (where created_at > now() - interval '7 days')::int as companies_7d,
					   count(*) filter (where created_at > now() - interval '30 days')::int as companies_30d
					 from companies`,
				),
				pool.query(
					`select
					   count(distinct user_id) filter (where at > now() - interval '1 day')::int as dau,
					   count(distinct user_id)::int as mau
					 from security_events
					 where event = 'login_ok' and at > now() - interval '30 days'`,
				),
				pool.query(
					`select
					   count(*) filter (where event = 'login_ok')::int as login_ok,
					   count(*) filter (where event = 'login_fail')::int as login_fail,
					   count(*) filter (where event = 'refresh_reuse_detected')::int as reuse
					 from security_events
					 where at > now() - interval '1 day'`,
				),
			])

			const plans: Record<string, number> = {}
			for (const r of planBreakdown.rows) plans[r.plan] = r.n

			const g = growth.rows[0]
			const newUsers7d = await pool.query(
				`select count(*) filter (where created_at > now() - interval '7 days')::int as w,
				        count(*) filter (where created_at > now() - interval '30 days')::int as m
				 from users where active`,
			)

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
				planBreakdown: plans,
				expiringTrials: expiringTrials.rows[0].n,
				mrr: Number(mrr.rows[0].total),
				growth: {
					companies7d: g.companies_7d,
					companies30d: g.companies_30d,
					users7d: newUsers7d.rows[0].w,
					users30d: newUsers7d.rows[0].m,
				},
				dauMau: {
					dau: dauMau.rows[0].dau,
					mau: dauMau.rows[0].mau,
				},
				security24h: {
					loginOk: security24h.rows[0].login_ok,
					loginFail: security24h.rows[0].login_fail,
					reuse: security24h.rows[0].reuse,
				},
			}
		},
	)

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
				   (select count(*)::int from products p where p.company_id = c.id and p.deleted_at is null) as products,
				   (select count(*)::int from orders o
				      where o.company_id = c.id and o.deleted_at is null
				      and o.created_at > now() - interval '30 days') as orders_30d,
				   (select coalesce(sum(total), 0)::numeric from orders o
				      where o.company_id = c.id and o.deleted_at is null
				      and o.created_at > now() - interval '30 days') as revenue_30d,
				   (select max(created_at) from orders o
				      where o.company_id = c.id and o.deleted_at is null) as last_activity,
				   s.plan as sub_plan,
				   s.status as sub_status,
				   s.trial_ends_at
				 from companies c
				 left join subscriptions s on s.company_id = c.id
				 order by revenue_30d desc, c.created_at desc
				 limit 500`,
			)
			return {
				companies: rows.map(r => ({
					id: r.id,
					name: r.name,
					createdAt: r.created_at,
					members: r.members,
					products: r.products,
					orders30d: r.orders_30d,
					revenue30d: Number(r.revenue_30d),
					lastActivity: r.last_activity,
					plan: r.sub_plan,
					subStatus: r.sub_status,
					trialEndsAt: r.trial_ends_at,
				})),
			}
		},
	)

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
				   (select count(*)::int from memberships m where m.user_id = u.id and m.active) as companies,
				   ll.last_login,
				   ll.last_ip
				 from users u
				 left join lateral (
				   select se.at as last_login, se.ip::text as last_ip
				   from security_events se
				   where se.user_id = u.id and se.event = 'login_ok'
				   order by se.at desc limit 1
				 ) ll on true
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
					lastLogin: r.last_login,
					lastIp: r.last_ip,
				})),
			}
		},
	)

	// Журнал безопасности.
	app.get<{ Querystring: { event?: string; limit?: string; offset?: string } }>(
		'/v1/admin/security-events',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async (req) => {
			const event = (req.query.event as string) || null
			const limit = Math.min(Number(req.query.limit) || 100, 500)
			const offset = Number(req.query.offset) || 0

			const [events, counters] = await Promise.all([
				pool.query(
					`select se.id, se.event, se.ip::text, se.user_agent, se.at, se.meta,
					        u.email, u.name as user_name, c.name as company_name
					 from security_events se
					 left join users u on u.id = se.user_id
					 left join companies c on c.id = se.company_id
					 where ($1::text is null or se.event = $1)
					 order by se.at desc limit $2 offset $3`,
					[event, limit, offset],
				),
				pool.query(
					`select
					   count(*) filter (where event = 'login_ok')::int as login_ok,
					   count(*) filter (where event = 'login_fail')::int as login_fail,
					   count(*) filter (where event = 'password_change')::int as password_change,
					   count(*) filter (where event = 'refresh_reuse_detected')::int as reuse
					 from security_events where at > now() - interval '1 day'`,
				),
			])

			return {
				events: events.rows.map(r => ({
					id: r.id,
					event: r.event,
					ip: r.ip,
					userAgent: r.user_agent,
					at: r.at,
					meta: r.meta,
					email: r.email,
					userName: r.user_name,
					companyName: r.company_name,
				})),
				counters24h: {
					loginOk: counters.rows[0].login_ok,
					loginFail: counters.rows[0].login_fail,
					passwordChange: counters.rows[0].password_change,
					reuse: counters.rows[0].reuse,
				},
			}
		},
	)

	// Подписки и платежи.
	app.get(
		'/v1/admin/subscriptions',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			const [subs, payments, stats] = await Promise.all([
				pool.query(
					`select s.*, c.name as company_name
					 from subscriptions s
					 join companies c on c.id = s.company_id
					 order by s.updated_at desc`,
				),
				pool.query(
					`select sp.*, c.name as company_name
					 from subscription_payments sp
					 join companies c on c.id = sp.company_id
					 order by sp.created_at desc limit 200`,
				),
				pool.query(
					`select
					   coalesce(sum(amount), 0)::numeric as mrr,
					   count(*)::int as total_payments
					 from subscription_payments
					 where status = 'succeeded' and created_at > now() - interval '30 days'`,
				),
			])

			return {
				subscriptions: subs.rows.map(r => ({
					companyId: r.company_id,
					companyName: r.company_name,
					plan: r.plan,
					status: r.status,
					trialStartedAt: r.trial_started_at,
					trialEndsAt: r.trial_ends_at,
					paidUntil: r.paid_until,
					updatedAt: r.updated_at,
				})),
				payments: payments.rows.map(r => ({
					id: r.id,
					companyId: r.company_id,
					companyName: r.company_name,
					amount: Number(r.amount),
					currency: r.currency,
					plan: r.plan,
					periodMonths: r.period_months,
					status: r.status,
					createdAt: r.created_at,
				})),
				mrr: Number(stats.rows[0].mrr),
				totalPayments30d: stats.rows[0].total_payments,
			}
		},
	)

	// Тикеты поддержки.
	app.get(
		'/v1/admin/support-tickets',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			const [tickets, counters] = await Promise.all([
				pool.query(
					`select t.*, c.name as company_name, u.email
					 from support_tickets t
					 join companies c on c.id = t.company_id
					 join users u on u.id = t.user_id
					 where t.deleted_at is null
					 order by t.created_at desc limit 200`,
				),
				pool.query(
					`select status, count(*)::int as n
					 from support_tickets where deleted_at is null
					 group by status`,
				),
			])

			const statusCounts: Record<string, number> = {}
			for (const r of counters.rows) statusCounts[r.status] = r.n

			return {
				tickets: tickets.rows.map(r => ({
					id: r.id,
					companyName: r.company_name,
					email: r.email,
					description: r.description,
					status: r.status,
					prUrl: r.pr_url,
					aiExplanation: r.ai_explanation,
					createdAt: r.created_at,
					updatedAt: r.updated_at,
				})),
				statusCounts,
			}
		},
	)

	// Фискализация.
	app.get(
		'/v1/admin/fiscal-stats',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			const [statusCounts, failed, configs] = await Promise.all([
				pool.query(
					`select status, count(*)::int as n
					 from fiscal_receipts group by status`,
				),
				pool.query(
					`select fr.id, fr.sale_id, fr.status, fr.error_message, fr.retries, fr.created_at,
					        c.name as company_name
					 from fiscal_receipts fr
					 join companies c on c.id = fr.company_id
					 where fr.status = 'failed'
					 order by fr.created_at desc limit 100`,
				),
				pool.query(
					`select fc.company_id, fc.provider, fc.inn, fc.active, c.name as company_name
					 from fiscal_configs fc
					 join companies c on c.id = fc.company_id
					 order by fc.active desc, c.name`,
				),
			])

			const counts: Record<string, number> = {}
			for (const r of statusCounts.rows) counts[r.status] = r.n

			return {
				statusCounts: counts,
				failed: failed.rows.map(r => ({
					id: r.id,
					saleId: r.sale_id,
					companyName: r.company_name,
					errorMessage: r.error_message,
					retries: r.retries,
					createdAt: r.created_at,
				})),
				configs: configs.rows.map(r => ({
					companyId: r.company_id,
					companyName: r.company_name,
					provider: r.provider,
					inn: r.inn,
					active: r.active,
				})),
			}
		},
	)

	// Вебхуки.
	app.get(
		'/v1/admin/webhook-stats',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			const [endpoints, deliveries24h, failed] = await Promise.all([
				pool.query(
					`select we.id, we.name, we.url, we.events, we.active, we.last_delivery_at,
					        c.name as company_name
					 from webhook_endpoints we
					 join companies c on c.id = we.company_id
					 order by we.active desc, we.created_at desc`,
				),
				pool.query(
					`select
					   count(*) filter (where delivered_at is not null)::int as delivered,
					   count(*) filter (where delivered_at is null and attempts > 0)::int as retrying,
					   count(*) filter (where delivered_at is null and last_status >= 400)::int as failed
					 from webhook_deliveries
					 where created_at > now() - interval '1 day'`,
				),
				pool.query(
					`select wd.id, wd.event, wd.attempts, wd.last_status, wd.last_error, wd.created_at,
					        c.name as company_name, we.name as endpoint_name
					 from webhook_deliveries wd
					 join companies c on c.id = wd.company_id
					 left join webhook_endpoints we on we.id = wd.endpoint_id and we.company_id = wd.company_id
					 where wd.delivered_at is null and wd.attempts > 0
					 order by wd.created_at desc limit 100`,
				),
			])

			return {
				endpoints: endpoints.rows.map(r => ({
					id: r.id,
					companyName: r.company_name,
					name: r.name,
					url: r.url,
					events: r.events,
					active: r.active,
					lastDeliveryAt: r.last_delivery_at,
				})),
				deliveries24h: {
					delivered: deliveries24h.rows[0].delivered,
					retrying: deliveries24h.rows[0].retrying,
					failed: deliveries24h.rows[0].failed,
				},
				failed: failed.rows.map(r => ({
					id: r.id,
					companyName: r.company_name,
					endpointName: r.endpoint_name,
					event: r.event,
					attempts: r.attempts,
					lastStatus: r.last_status,
					lastError: r.last_error,
					createdAt: r.created_at,
				})),
			}
		},
	)

	// Графики роста за 30 дней.
	app.get(
		'/v1/admin/growth',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			const [companies, users, orders] = await Promise.all([
				pool.query(
					`select date_trunc('day', created_at)::date as d, count(*)::int as n
					 from companies where created_at > now() - interval '30 days'
					 group by d order by d`,
				),
				pool.query(
					`select date_trunc('day', created_at)::date as d, count(*)::int as n
					 from users where created_at > now() - interval '30 days'
					 group by d order by d`,
				),
				pool.query(
					`select date_trunc('day', created_at)::date as d, count(*)::int as n
					 from orders where deleted_at is null and created_at > now() - interval '30 days'
					 group by d order by d`,
				),
			])
			return {
				companies: companies.rows,
				users: users.rows,
				orders: orders.rows,
			}
		},
	)

	// Получить конфиг платформы (для админки).
	app.get(
		'/v1/admin/config',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async () => {
			const { rows } = await pool.query(`SELECT key, value FROM platform_config`)
			const config: Record<string, unknown> = {}
			for (const r of rows) config[r.key] = r.value
			return config
		},
	)

	// Обновить одну настройку платформы.
	app.put<{ Params: { key: string }; Body: { value: unknown } }>(
		'/v1/admin/config/:key',
		{ preHandler: [app.authenticateUser, app.requireSuperAdmin] },
		async (req) => {
			const { key } = req.params
			const { value } = req.body as { value: unknown }
			await pool.query(
				`INSERT INTO platform_config (key, value, updated_at)
				 VALUES ($1, $2, now())
				 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
				[key, JSON.stringify(value)],
			)
			return { ok: true }
		},
	)
}

// Публичный конфиг (без авторизации) — лендинг читает, показывать ли скачивание.
export function registerPublicConfigRoutes(app: FastifyInstance, pool: DbPool) {
	app.get('/v1/public/config', async () => {
		const { rows } = await pool.query(
			`SELECT value FROM platform_config WHERE key = 'site'`,
		)
		return rows[0]?.value ?? { showDownloads: false }
	})
}
