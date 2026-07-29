import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, makeTestApp, USER_ID } from './helpers.js'

const OTHER_USER = 'b0000000-0000-4000-8000-0000000000ab'

// DELETE-запросы в Fastify не должны нести content-type: application/json без
// тела — иначе body parser возвращает 400. Берём только Authorization.
async function bearerOnly() {
	const h = await authHeaders()
	return { authorization: h.authorization }
}

describe('admin: приглашения', () => {
	it('GET /v1/invitations — админу возвращаем список', async () => {
		const now = new Date().toISOString()
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.startsWith('select id, email, role, name, created_at from invitations'))
					return [{ id: 'i1', email: 'x@t.ru', role: 'stock', name: null, created_at: now }]
				return undefined
			},
		})
		const res = await app.inject({ method: 'GET', url: '/v1/invitations', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		expect(res.json().invitations[0]).toMatchObject({ id: 'i1', email: 'x@t.ru' })
	})

	it('GET /v1/invitations — курьеру запрещён (403)', async () => {
		const { app } = await makeTestApp({
			handler: () => undefined,
			membership: { company_id: COMPANY_ID, role: 'courier', name: null },
		})
		const res = await app.inject({ method: 'GET', url: '/v1/invitations', headers: await authHeaders() })
		expect(res.statusCode).toBe(403)
	})

	it('DELETE /v1/invitations/:id — матчит id + company_id', async () => {
		let deletedParams: unknown[] = []
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.startsWith('delete from invitations where id')) {
					deletedParams = params
					return [{ id: params[0] }] // rowCount 1
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'DELETE',
			url: '/v1/invitations/00000000-0000-4000-8000-000000000001',
			headers: await bearerOnly(),
		})
		expect(res.statusCode).toBe(200)
		expect(deletedParams).toEqual(['00000000-0000-4000-8000-000000000001', COMPANY_ID])
	})

	it('DELETE /v1/invitations/:id — несуществующее → 404', async () => {
		const { app } = await makeTestApp({
			handler: sql => (sql.startsWith('delete from invitations') ? [] : undefined),
		})
		const res = await app.inject({
			method: 'DELETE',
			url: '/v1/invitations/00000000-0000-4000-8000-000000000002',
			headers: await bearerOnly(),
		})
		expect(res.statusCode).toBe(404)
	})

	it('DELETE /v1/invitations/:id — невалидный uuid → 400', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({ method: 'DELETE', url: '/v1/invitations/not-a-uuid', headers: await bearerOnly() })
		expect(res.statusCode).toBe(400)
	})
})

describe('admin: смена роли и удаление участника', () => {
	it('PATCH /v1/memberships/:userId — админ меняет чужую роль', async () => {
		let updatedParams: unknown[] = []
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.startsWith('update memberships set role')) {
					updatedParams = params
					return [{ user_id: params[0] }]
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'PATCH',
			url: `/v1/memberships/${OTHER_USER}`,
			headers: await authHeaders(),
			payload: { role: 'manager' },
		})
		expect(res.statusCode).toBe(200)
		expect(updatedParams).toEqual([OTHER_USER, COMPANY_ID, 'manager'])
	})

	it('PATCH /v1/memberships/:userId — себе роль менять нельзя', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'PATCH',
			url: `/v1/memberships/${USER_ID}`,
			headers: await authHeaders(),
			payload: { role: 'stock' },
		})
		expect(res.statusCode).toBe(403)
	})

	it('PATCH /v1/memberships/:userId — менеджеру нельзя менять роли', async () => {
		const { app } = await makeTestApp({
			handler: () => undefined,
			membership: { company_id: COMPANY_ID, role: 'manager', name: null },
		})
		const res = await app.inject({
			method: 'PATCH',
			url: `/v1/memberships/${OTHER_USER}`,
			headers: await authHeaders(),
			payload: { role: 'stock' },
		})
		expect(res.statusCode).toBe(403)
	})

	it('DELETE /v1/memberships/:userId — админ удаляет обычного участника', async () => {
		const deletedParams: unknown[][] = []
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from memberships') && sql.includes('for update'))
					return [
						{ user_id: USER_ID, role: 'admin' },
						{ user_id: OTHER_USER, role: 'stock' },
					]
				if (sql.startsWith('delete from memberships where user_id')) {
					deletedParams.push(params)
					return []
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'DELETE',
			url: `/v1/memberships/${OTHER_USER}`,
			headers: await bearerOnly(),
		})
		expect(res.statusCode).toBe(200)
		expect(deletedParams[0]).toEqual([OTHER_USER, COMPANY_ID])
	})

	it('DELETE /v1/memberships/:userId — последнего админа удалить нельзя', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.includes('from memberships') && sql.includes('for update'))
					// Только один админ в компании
					return [
						{ user_id: USER_ID, role: 'admin' },
						{ user_id: OTHER_USER, role: 'admin' },
					]
				return undefined
			},
		})
		// Проверим, что при 2 админах — удаление другого админа ОК
		const ok = await app.inject({
			method: 'DELETE',
			url: `/v1/memberships/${OTHER_USER}`,
			headers: await bearerOnly(),
		})
		expect(ok.statusCode).toBe(200)

		// А теперь мокаем handler так, чтобы был только 1 админ.
		const { app: app2 } = await makeTestApp({
			handler: sql => {
				if (sql.includes('from memberships') && sql.includes('for update'))
					return [
						{ user_id: OTHER_USER, role: 'admin' },
						{ user_id: 'c9999999-0000-4000-8000-000000000099', role: 'stock' },
					]
				return undefined
			},
		})
		const res = await app2.inject({
			method: 'DELETE',
			url: `/v1/memberships/${OTHER_USER}`,
			headers: await bearerOnly(),
		})
		expect(res.statusCode).toBe(403)
	})

	it('DELETE /v1/memberships/:userId — себя удалить нельзя', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'DELETE',
			url: `/v1/memberships/${USER_ID}`,
			headers: await bearerOnly(),
		})
		expect(res.statusCode).toBe(403)
	})
})

describe('GET /v1/companies/members', () => {
	it('возвращает участников с email', async () => {
		const now = new Date().toISOString()
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.includes('from memberships m join users u'))
					return [{ user_id: USER_ID, email: 'admin@t.ru', role: 'admin', name: 'A', active: true, created_at: now }]
				return undefined
			},
		})
		const res = await app.inject({ method: 'GET', url: '/v1/companies/members', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		expect(res.json().members[0]).toMatchObject({ userId: USER_ID, email: 'admin@t.ru', role: 'admin' })
	})
})
