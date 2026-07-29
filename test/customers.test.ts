import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, makeTestApp } from './helpers.js'

function customerHandler(customer: { id: string; name: string; balance: number } | null) {
	return (sql: string, params: unknown[]): unknown[] | undefined => {
		if (sql.includes('from customers') && sql.includes('for update'))
			return customer && params[1] === customer.id ? [customer] : []
		return undefined
	}
}

describe('POST /v1/customers/:id/payments', () => {
	it('приём оплаты уменьшает баланс', async () => {
		const { app, log } = await makeTestApp({
			handler: customerHandler({ id: 'cu-1', name: 'ООО Мосторг', balance: 500 }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-1/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0001' }),
			payload: { amount: 300 },
		})
		expect(res.statusCode).toBe(201)
		const body = res.json()
		expect(body.customer).toMatchObject({ id: 'cu-1', balanceBefore: 500, balanceAfter: 200, applied: -300 })

		const upd = log.find(e => e.sql.includes('update customers set balance'))!
		expect(upd.params[0]).toBe(COMPANY_ID)
		expect(upd.params[1]).toBe('cu-1')
		expect(upd.params[2]).toBe(200)
		expect(log.some(e => e.sql.includes('insert into audit'))).toBe(true)
	})

	it('переплата не уводит баланс в минус — greatest(0, …)', async () => {
		const { app } = await makeTestApp({
			handler: customerHandler({ id: 'cu-1', name: 'Клиент', balance: 100 }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-1/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0002' }),
			payload: { amount: 500 },
		})
		expect(res.statusCode).toBe(201)
		expect(res.json().customer.balanceAfter).toBe(0)
	})

	it('adjustment + direction=increase — ручное увеличение долга', async () => {
		const { app } = await makeTestApp({
			handler: customerHandler({ id: 'cu-1', name: 'Клиент', balance: 100 }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-1/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0003' }),
			payload: { amount: 50, kind: 'adjustment', direction: 'increase', note: 'штраф' },
		})
		expect(res.statusCode).toBe(201)
		expect(res.json().customer).toMatchObject({ balanceBefore: 100, balanceAfter: 150, applied: 50 })
	})

	it('несуществующий клиент → 404', async () => {
		const { app } = await makeTestApp({ handler: customerHandler(null) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-nope/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0004' }),
			payload: { amount: 100 },
		})
		expect(res.statusCode).toBe(404)
	})

	it('без Idempotency-Key → 400', async () => {
		const { app } = await makeTestApp({
			handler: customerHandler({ id: 'cu-1', name: 'X', balance: 100 }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-1/payments',
			headers: await authHeaders(),
			payload: { amount: 100 },
		})
		expect(res.statusCode).toBe(400)
		expect(res.json().error.code).toBe('VALIDATION_ERROR')
	})

	it('курьеру запрещён', async () => {
		const { app } = await makeTestApp({
			handler: customerHandler({ id: 'cu-1', name: 'X', balance: 100 }),
			membership: { company_id: COMPANY_ID, role: 'courier', name: 'Курьер' },
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-1/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0005' }),
			payload: { amount: 100 },
		})
		expect(res.statusCode).toBe(403)
	})

	it('замок FOR UPDATE — блокирует ровно этого клиента', async () => {
		let lockParams: unknown[] = []
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from customers') && sql.includes('for update')) {
					lockParams = params
					return [{ id: params[1], name: 'X', balance: 500 }]
				}
				return undefined
			},
		})
		await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-777/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0006' }),
			payload: { amount: 100 },
		})
		expect(lockParams).toEqual([COMPANY_ID, 'cu-777'])
	})

	it('replay: повторный ключ возвращает сохранённый ответ, баланс не трогается', async () => {
		const stored = { ok: true, customer: { id: 'cu-1', balanceBefore: 500, balanceAfter: 200, applied: -300 } }
		const { app, log } = await makeTestApp({
			handler: sql => {
				if (sql.includes('insert into idempotency_keys')) return []
				if (sql.includes('select status, response, endpoint from idempotency_keys'))
					return [{ status: 201, response: stored, endpoint: 'POST /v1/customers/payments' }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-1/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0001' }),
			payload: { amount: 300 },
		})
		expect(res.statusCode).toBe(201)
		expect(res.json()).toEqual(stored)
		expect(res.headers['idempotency-replayed']).toBe('true')
		expect(log.some(e => e.sql.includes('update customers set balance'))).toBe(false)
	})
})
