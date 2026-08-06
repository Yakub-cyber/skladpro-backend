import { describe, expect, it } from 'vitest'
import { authHeaders, makeTestApp } from './helpers.js'

// Гейт супер-админа: authenticateUser + requireSuperAdmin. Логика гейта
// (users.is_super_admin) идёт в БД — поэтому эмулируем этот select в хендлере.
function withSuperAdmin(isAdmin: boolean, extra: (sql: string, params: unknown[]) => unknown[] | undefined) {
	return (sql: string, params: unknown[]) => {
		// requireSuperAdmin: select is_super_admin from users where id = $1 and active
		if (sql.startsWith('select is_super_admin from users where id')) {
			return [{ is_super_admin: isAdmin }]
		}
		return extra(sql, params)
	}
}

describe('super-admin: /v1/admin/stats', () => {
	it('обычному пользователю 403', async () => {
		const { app } = await makeTestApp({ handler: withSuperAdmin(false, () => undefined) })
		const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: await authHeaders() })
		expect(res.statusCode).toBe(403)
	})

	it('супер-админу отдаёт агрегаты по всей платформе', async () => {
		const { app } = await makeTestApp({
			handler: withSuperAdmin(true, sql => {
				if (sql.startsWith('select count(*)::int as n from companies')) return [{ n: 3 }]
				if (sql.startsWith('select count(*)::int as n from users')) return [{ n: 7 }]
				if (sql.startsWith('select count(*)::int as n from memberships where active')) return [{ n: 12 }]
				if (sql.startsWith('select count(*)::int as n from invitations')) return [{ n: 1 }]
				if (sql.startsWith('select pg_database_size')) return [{ bytes: '34567890' }]
				if (sql.includes("interval '24 hours'") && sql.includes('from orders')) return [{ orders: 5, revenue: '15000' }]
				if (sql.includes("interval '30 days'") && sql.includes('from orders')) return [{ orders: 80, revenue: '250000' }]
				if (sql.includes('from subscriptions') && sql.includes('group by plan')) return []
				if (sql.includes('from subscriptions') && sql.includes('trial')) return [{ n: 0 }]
				if (sql.includes('from subscription_payments')) return [{ total: '0' }]
				if (sql.includes('companies_7d')) return [{ companies_7d: 1, companies_30d: 2 }]
				if (sql.includes('from security_events') && sql.includes('dau')) return [{ dau: 3, mau: 5 }]
				if (sql.includes('from security_events') && sql.includes('login_ok')) return [{ login_ok: 10, login_fail: 2, reuse: 0 }]
				if (sql.includes('from users where active') && sql.includes('7 days')) return [{ w: 1, m: 3 }]
				return undefined
			}),
		})
		const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body).toMatchObject({
			companies: 3,
			users: 7,
			memberships: 12,
			activeInvitations: 1,
			dbBytes: 34567890,
			last24h: { orders: 5, revenue: 15000 },
			last30d: { orders: 80, revenue: 250000 },
		})
		expect(typeof body.uptimeSec).toBe('number')
	})

	it('без Authorization → 401', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({ method: 'GET', url: '/v1/admin/stats' })
		expect(res.statusCode).toBe(401)
	})
})

describe('super-admin: /v1/admin/companies', () => {
	it('обычному пользователю 403', async () => {
		const { app } = await makeTestApp({ handler: withSuperAdmin(false, () => undefined) })
		const res = await app.inject({ method: 'GET', url: '/v1/admin/companies', headers: await authHeaders() })
		expect(res.statusCode).toBe(403)
	})

	it('супер-админу отдаёт компании отсортированные по обороту', async () => {
		const now = new Date().toISOString()
		const { app } = await makeTestApp({
			handler: withSuperAdmin(true, sql => {
				if (sql.startsWith('select c.id, c.name, c.created_at')) {
					return [
						{
							id: 'c1',
							name: 'Первая',
							created_at: now,
							members: 5,
							orders_30d: 100,
							revenue_30d: '500000',
							last_activity: now,
						},
					]
				}
				return undefined
			}),
		})
		const res = await app.inject({ method: 'GET', url: '/v1/admin/companies', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		expect(res.json().companies[0]).toMatchObject({
			id: 'c1',
			name: 'Первая',
			members: 5,
			orders30d: 100,
			revenue30d: 500000,
		})
	})
})

describe('super-admin: /v1/admin/users', () => {
	it('обычному пользователю 403', async () => {
		const { app } = await makeTestApp({ handler: withSuperAdmin(false, () => undefined) })
		const res = await app.inject({ method: 'GET', url: '/v1/admin/users', headers: await authHeaders() })
		expect(res.statusCode).toBe(403)
	})

	it('супер-админу отдаёт список пользователей с флагом', async () => {
		const now = new Date().toISOString()
		const { app } = await makeTestApp({
			handler: withSuperAdmin(true, sql => {
				if (sql.startsWith('select u.id, u.email, u.name, u.active, u.is_super_admin')) {
					return [
						{
							id: 'u1',
							email: 'super@t.ru',
							name: 'Владелец',
							active: true,
							is_super_admin: true,
							created_at: now,
							companies: 0,
						},
						{
							id: 'u2',
							email: 'plain@t.ru',
							name: 'Юзер',
							active: true,
							is_super_admin: false,
							created_at: now,
							companies: 2,
						},
					]
				}
				return undefined
			}),
		})
		const res = await app.inject({ method: 'GET', url: '/v1/admin/users', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		const users = res.json().users
		expect(users).toHaveLength(2)
		expect(users[0]).toMatchObject({ email: 'super@t.ru', isSuperAdmin: true })
		expect(users[1]).toMatchObject({ email: 'plain@t.ru', isSuperAdmin: false, companies: 2 })
	})
})

describe('super-admin: расширенное /v1/me', () => {
	it('обычный пользователь → isSuperAdmin=false', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.startsWith('select m.company_id, m.role, m.name, c.name as company_name')) return []
				if (sql.startsWith('select is_super_admin from users where id')) return [{ is_super_admin: false }]
				return undefined
			},
		})
		const res = await app.inject({ method: 'GET', url: '/v1/me', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toMatchObject({ isSuperAdmin: false, memberships: [] })
	})

	it('супер-админ → isSuperAdmin=true', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.startsWith('select m.company_id, m.role, m.name, c.name as company_name')) return []
				if (sql.startsWith('select is_super_admin from users where id')) return [{ is_super_admin: true }]
				return undefined
			},
		})
		const res = await app.inject({ method: 'GET', url: '/v1/me', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		expect(res.json().isSuperAdmin).toBe(true)
	})
})
