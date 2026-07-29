import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, makeTestApp } from './helpers.js'

const saleBody = (over: Record<string, unknown> = {}) => ({
	order: {
		id: 'o-1',
		no: '42',
		items: [
			{ productId: 'p-1', qty: 2, price: 100 },
			{ productId: 'p-2', qty: 1, price: 50 },
		],
		discount: 10,
		...over,
	},
})

function happyHandler(stock: Record<string, number>) {
	return (sql: string, params: unknown[]): unknown[] | undefined => {
		if (sql.includes('from products') && sql.includes('for update')) {
			const id = params[1] as string
			if (!(id in stock)) return []
			return [{ id, name: `Товар ${id}`, stock: stock[id], cost: 0, batches: [] }]
		}
		if (sql.includes('insert into orders') && sql.includes('returning id')) return [{ id: params[1] }]
		return undefined
	}
}

describe('POST /v1/sales', () => {
	it('проводит продажу: списание, заказ, движения, аудит, пересчёт сумм', async () => {
		const { app, log } = await makeTestApp({ handler: happyHandler({ 'p-1': 5, 'p-2': 3 }) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-test-0001' }),
			payload: saleBody(),
		})
		expect(res.statusCode).toBe(201)
		const body = res.json()
		expect(body.order).toMatchObject({ id: 'o-1', subtotal: 250, discount: 10, total: 240 })

		const sqls = log.map(e => e.sql)
		expect(sqls.some(s => s.startsWith('begin'))).toBe(true)
		expect(sqls.some(s => s.startsWith('commit'))).toBe(true)
		expect(sqls.filter(s => s.includes('update products set stock = stock -')).length).toBe(2)
		expect(sqls.filter(s => s.includes('insert into movements')).length).toBe(2)
		expect(sqls.some(s => s.includes('insert into audit'))).toBe(true)

		const productLocks = log.filter(e => e.sql.includes('for update') && e.sql.includes('from products'))
		for (const q of productLocks) expect(q.params[0]).toBe(COMPANY_ID)

		// storeIdempotentResponse теперь пишет с composite (company_id, key)
		const upd = log.find(e => e.sql.includes('update idempotency_keys set status'))!
		expect(upd.params[0]).toBe(COMPANY_ID)
		expect(upd.params[1]).toBe('sale-test-0001')
	})

	it('откатывает всё при нехватке остатка (409 INSUFFICIENT_STOCK)', async () => {
		const { app, log } = await makeTestApp({ handler: happyHandler({ 'p-1': 1, 'p-2': 3 }) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-test-0002' }),
			payload: saleBody(),
		})
		expect(res.statusCode).toBe(409)
		expect(res.json().error.code).toBe('INSUFFICIENT_STOCK')
		expect(res.json().error.details).toMatchObject({ productId: 'p-1', available: 1, requested: 2 })

		const sqls = log.map(e => e.sql)
		expect(sqls.some(s => s.startsWith('rollback'))).toBe(true)
		expect(sqls.some(s => s.includes('update products'))).toBe(false)
	})

	it('суммирует количество, когда один товар пришёл несколькими строками', async () => {
		const { app } = await makeTestApp({ handler: happyHandler({ 'p-1': 3 }) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-test-0003' }),
			payload: saleBody({
				items: [
					{ productId: 'p-1', qty: 2, price: 100 },
					{ productId: 'p-1', qty: 2, price: 100 },
				],
				discount: 0,
			}),
		})
		expect(res.statusCode).toBe(409)
		expect(res.json().error.details).toMatchObject({ productId: 'p-1', available: 3, requested: 4 })
	})

	it('возвращает сохранённый ответ при повторе Idempotency-Key', async () => {
		const stored = { ok: true, order: { id: 'o-1', no: '42', subtotal: 250, discount: 10, total: 240 } }
		const { app, log } = await makeTestApp({
			handler: sql => {
				if (sql.includes('insert into idempotency_keys')) return [] // конфликт
				if (sql.includes('select status, response, endpoint from idempotency_keys'))
					return [{ status: 201, response: stored, endpoint: 'POST /v1/sales' }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-test-0001' }),
			payload: saleBody(),
		})
		expect(res.statusCode).toBe(201)
		expect(res.json()).toEqual(stored)
		expect(res.headers['idempotency-replayed']).toBe('true')
		expect(log.some(e => e.sql.includes('update products'))).toBe(false)
	})

	it('replay ключа с ЧУЖИМ endpoint → 409 IDEMPOTENCY_MISMATCH (не молча возвращаем чужой ответ)', async () => {
		const stored = { ok: true, order: { id: 'sale-body' } }
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.includes('insert into idempotency_keys')) return []
				if (sql.includes('select status, response, endpoint from idempotency_keys'))
					return [{ status: 201, response: stored, endpoint: 'POST /v1/returns' }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'shared-key-01' }),
			payload: saleBody(),
		})
		expect(res.statusCode).toBe(409)
		expect(res.json().error.code).toBe('IDEMPOTENCY_MISMATCH')
	})

	it('отклоняет запрос без Idempotency-Key', async () => {
		const { app } = await makeTestApp({ handler: happyHandler({ 'p-1': 5, 'p-2': 3 }) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders(),
			payload: saleBody(),
		})
		expect(res.statusCode).toBe(400)
		expect(res.json().error.code).toBe('VALIDATION_ERROR')
	})

	it('запрещает продажу курьеру', async () => {
		const { app } = await makeTestApp({
			handler: happyHandler({ 'p-1': 5, 'p-2': 3 }),
			membership: { company_id: COMPANY_ID, role: 'courier', name: 'Курьер' },
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-test-0004' }),
			payload: saleBody(),
		})
		expect(res.statusCode).toBe(403)
	})

	it('401 без токена и с мусорным токеном', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const noAuth = await app.inject({ method: 'POST', url: '/v1/sales', payload: saleBody() })
		expect(noAuth.statusCode).toBe(401)
		const badAuth = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: { authorization: 'Bearer garbage', 'content-type': 'application/json', 'idempotency-key': 'sale-test-0005' },
			payload: saleBody(),
		})
		expect(badAuth.statusCode).toBe(401)
	})

	it('on_credit продажа реального клиента увеличивает customers.balance атомарно', async () => {
		const { app, log } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from products') && sql.includes('for update'))
					return [{ id: params[1], name: 'X', stock: 100, cost: 0, batches: [] }]
				if (sql.includes('insert into orders') && sql.includes('returning id')) return [{ id: params[1] }]
				if (sql.includes('update customers set balance = coalesce(balance, 0)') && sql.includes('returning id'))
					return [{ id: params[1] }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-oncredit-01' }),
			payload: {
				order: {
					id: 'o-credit-1',
					customerId: 'cu-42',
					customerName: 'ООО Долг',
					items: [{ productId: 'p-1', qty: 2, price: 500 }],
					discount: 0,
					onCredit: true,
				},
			},
		})
		expect(res.statusCode).toBe(201)
		const upd = log.find(e => e.sql.includes('update customers set balance = coalesce(balance, 0) + $3'))
		expect(upd).toBeTruthy()
		expect(upd!.params[1]).toBe('cu-42')
		expect(upd!.params[2]).toBe(1000) // total = 2 * 500 - 0
		// В аудите пометка «Долг +…»
		const auditInsert = log.filter(e => e.sql.includes("insert into audit"))
		expect(auditInsert.length).toBeGreaterThanOrEqual(2) // 'sale' + 'credit'
	})

	it('on_credit + customerId="retail" не трогает баланс (розница)', async () => {
		const { app, log } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from products') && sql.includes('for update'))
					return [{ id: params[1], name: 'X', stock: 100, cost: 0, batches: [] }]
				if (sql.includes('insert into orders') && sql.includes('returning id')) return [{ id: params[1] }]
				return undefined
			},
		})
		await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-retail-01' }),
			payload: {
				order: {
					id: 'o-retail-1',
					customerId: 'retail',
					items: [{ productId: 'p-1', qty: 1, price: 100 }],
					onCredit: true,
				},
			},
		})
		expect(log.some(e => e.sql.includes('update customers set balance'))).toBe(false)
	})

	it('404, если товар не принадлежит компании', async () => {
		const { app } = await makeTestApp({ handler: happyHandler({}) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-test-0006' }),
			payload: saleBody(),
		})
		expect(res.statusCode).toBe(404)
	})
})
