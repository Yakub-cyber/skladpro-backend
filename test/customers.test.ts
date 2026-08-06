import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, coreHandler, makeTestApp } from './helpers.js'

function customerHandler(
	customer: { id: string; name: string; balance: number } | null,
	afterBalance?: number,
) {
	const core = coreHandler({ afterBalance: afterBalance ?? 0 })
	return (sql: string, params: unknown[]): unknown[] | undefined => {
		const c = core(sql, params)
		if (c !== undefined) return c
		// First read: select id, name, balance ... deleted_at is null
		if (sql.includes('id, name, balance') && sql.includes('from customers') && sql.includes('deleted_at is null'))
			return customer && params[1] === customer.id ? [customer] : []
		return undefined
	}
}

describe('POST /v1/customers/:id/payments', () => {
	it('приём оплаты создаёт payment_in doc + post_doc', async () => {
		const { app, log } = await makeTestApp({
			handler: customerHandler({ id: 'cu-1', name: 'ООО Мосторг', balance: 500 }, 200),
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

		const docsInsert = log.find(e => e.sql.includes('insert into docs'))!
		expect(docsInsert.sql).toContain('payment_in')
		expect(docsInsert.sql).toContain('customer')
		expect(docsInsert.params).toContain('cu-1')
		expect(log.some(e => e.sql.includes('post_doc'))).toBe(true)
		expect(log.some(e => e.sql.includes('insert into audit'))).toBe(true)
	})

	it('переплата: post_doc может увести баланс в минус (переплата — это аванс)', async () => {
		const { app } = await makeTestApp({
			handler: customerHandler({ id: 'cu-1', name: 'Клиент', balance: 100 }, -400),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-1/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0002' }),
			payload: { amount: 500 },
		})
		expect(res.statusCode).toBe(201)
		// Баланс может быть отрицательным (аванс); old greatest(0,...) был багом
		expect(res.json().customer.balanceAfter).toBe(-400)
	})

	it('adjustment + direction=increase — создаёт opening_settlement', async () => {
		const { app, log } = await makeTestApp({
			handler: customerHandler({ id: 'cu-1', name: 'Клиент', balance: 100 }, 150),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-1/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0003' }),
			payload: { amount: 50, kind: 'adjustment', direction: 'increase', note: 'штраф' },
		})
		expect(res.statusCode).toBe(201)
		expect(res.json().customer).toMatchObject({ balanceBefore: 100, balanceAfter: 150, applied: 50 })
		const docsInsert = log.find(e => e.sql.includes('insert into docs'))!
		expect(docsInsert.sql).toContain('opening_settlement')
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

	it('правильный customer_id передаётся в doc', async () => {
		const { app, log } = await makeTestApp({
			handler: customerHandler({ id: 'cu-777', name: 'X', balance: 500 }, 400),
		})
		await app.inject({
			method: 'POST',
			url: '/v1/customers/cu-777/payments',
			headers: await authHeaders({ 'idempotency-key': 'pay-test-0006' }),
			payload: { amount: 100 },
		})
		const docsInsert = log.find(e => e.sql.includes('insert into docs'))!
		expect(docsInsert.params).toContain('cu-777')
	})

	it('replay: повторный ключ возвращает сохранённый ответ, doc не создаётся', async () => {
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
		expect(log.some(e => e.sql.includes('insert into docs'))).toBe(false)
	})
})
