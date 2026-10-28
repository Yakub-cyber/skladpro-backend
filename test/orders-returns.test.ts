import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, USER_ID, coreHandler, makeTestApp } from './helpers.js'

type OrderRow = {
	id: string
	no: string
	status: string
	stock_consumed: boolean
	returned?: boolean
	returns?: unknown[]
	items: unknown[]
	assigned_to?: string | null
	on_credit?: boolean
	customer_id?: string | null
}

function handlerWith(order: OrderRow, postDocOpts?: Parameters<typeof coreHandler>[0]) {
	const core = coreHandler(postDocOpts)
	return (sql: string, params: unknown[]): unknown[] | undefined => {
		if (sql.includes('select commercial_snapshot from orders')) return params[1] === order.id ? [order] : []
		if (sql.includes('select assigned_to from orders')) return params[1] === order.id ? [order] : []
        if (sql.includes('select distinct m.user_id from memberships')) return params[1] === 'Вася' || params[1] === USER_ID ? [{user_id:USER_ID}] : []
		if (sql.includes('from orders') && sql.includes('for update'))
			return params[1] === order.id ? [order] : []
		const c = core(sql, params)
		if (c !== undefined) return c
		// Returns: products query for mark codes
		if (sql.includes('from products') && sql.includes('deleted_at is null'))
			return [{ name: 'Товар', marked: false, codes: [] }]
		return undefined
	}
}

describe('POST /v1/orders/:id/status', () => {
	const items = [{ productId: 'p-1', qty: 2, name: 'Товар', price: 100 }]

	it('legacy shipped: 422 before keys, documents or stock changes', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith({ id: 'o-1', no: '1', status: 'packed', stock_consumed: false, items }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0001' }),
			payload: { status: 'shipped' },
		})
		expect(res.statusCode).toBe(422)
		expect(res.json().error.code).toBe('LEGACY_SHIPMENT_REQUIRES_RECONCILIATION')
		expect(log.some(e => /insert into|update orders|post_doc|begin/.test(e.sql))).toBe(false)
	})

	it('legacy shipped does not reach post_doc, including insufficient-stock orders', async () => {
		const { app } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '1', status: 'packed', stock_consumed: false, items },
				{ throwOnPostDoc: { code: 'P0001', message: 'Недостаточно остатка' } },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0002' }),
			payload: { status: 'shipped' },
		})
		expect(res.statusCode).toBe(422)
		expect(res.json().error.code).toBe('LEGACY_SHIPMENT_REQUIRES_RECONCILIATION')
	})

	it('cancelled после отгрузки: находит docs + unpost_doc', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '1', status: 'shipped', stock_consumed: true, returns: [], items },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0003' }),
			payload: { status: 'cancelled' },
		})
		expect(res.statusCode).toBe(200)
		const sqls = log.map(e => e.sql)
		expect(sqls.some(s => s.includes('from docs') && s.includes('for update'))).toBe(true)
		expect(sqls.some(s => s.includes('unpost_doc'))).toBe(true)
		expect(sqls.some(s => s.includes('set stock_consumed = false'))).toBe(true)
	})

	it('cancelled без отгрузки не вызывает unpost_doc', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '1', status: 'confirmed', stock_consumed: false, items },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0007' }),
			payload: { status: 'cancelled' },
		})
		expect(res.statusCode).toBe(200)
		expect(log.some(e => e.sql.includes('unpost_doc'))).toBe(false)
	})

	it('запрещённый переход delivered → new отклоняется', async () => {
		const { app } = await makeTestApp({
			handler: handlerWith({ id: 'o-1', no: '1', status: 'delivered', stock_consumed: true, items }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0004' }),
			payload: { status: 'new' },
		})
		expect(res.statusCode).toBe(400)
	})

	it('курьер: может отметить доставку своего заказа, чужой — нет', async () => {
		const mkApp = (assignedTo: string) =>
			makeTestApp({
				handler: handlerWith(
					{ id: 'o-1', no: '1', status: 'shipped', stock_consumed: true, items, assigned_to: assignedTo },
				),
				membership: { company_id: COMPANY_ID, role: 'courier', name: 'Вася' },
			})

		const mine = await (await mkApp('Вася')).app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0005' }),
			payload: { status: 'delivered' },
		})
		expect(mine.statusCode).toBe(200)

		const foreign = await (await mkApp('Петя')).app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0006' }),
			payload: { status: 'cancelled' },
		})
		expect(foreign.statusCode).toBe(403)
	})

	it('курьер без имени (memberName=null) НЕ может закрыть неназначенный заказ (null===null не даёт «свой»)', async () => {
		const { app } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '1', status: 'shipped', stock_consumed: true, items, assigned_to: null },
			),
			membership: { company_id: COMPANY_ID, role: 'courier', name: null },
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0008' }),
			payload: { status: 'delivered' },
		})
		expect(res.statusCode).toBe(403)
	})
})

describe('POST /v1/returns', () => {
	const soldItems = [
		{ productId: 'p-1', qty: 2, name: 'А', price: 100 },
		{ productId: 'p-2', qty: 1, name: 'Б', price: 200 },
	]

	it('полный возврат: создаёт sales_return + post_doc, returned=true', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [], items: soldItems, customer_id: 'cu-1' },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-test-0001' }),
			payload: { orderId: 'o-1' },
		})
		expect(res.statusCode).toBe(201)
		expect(res.json().fullyReturned).toBe(true)

		const docsInsert = log.find(e => e.sql.includes('insert into docs') && !e.sql.includes('doc_lines'))!
		expect(docsInsert.params).toContain('sales_return')
		expect(log.filter(e => e.sql.includes('insert into doc_lines')).length).toBe(2)
		expect(log.some(e => e.sql.includes('post_doc'))).toBe(true)
		expect(log.some(e => e.sql.includes('update orders set returns') && e.params[3] === true)).toBe(true)
	})

	it('дубликат productId в одном запросе НЕ обходит проверку remaining', async () => {
		const { app } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [], items: soldItems },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-test-0004' }),
			payload: {
				orderId: 'o-1',
				items: [
					{ productId: 'p-1', qty: 2 },
					{ productId: 'p-1', qty: 2 }, // всего 4 при проданных 2
				],
			},
		})
		expect(res.statusCode).toBe(400)
	})

	it('частичный возврат: нельзя вернуть больше проданного с учётом прошлых возвратов', async () => {
		const { app } = await makeTestApp({
			handler: handlerWith(
				{
					id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false,
					returns: [{ at: 'x', by: 'y', items: [{ productId: 'p-1', qty: 1 }] }],
					items: soldItems,
				},
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-test-0002' }),
			payload: { orderId: 'o-1', items: [{ productId: 'p-1', qty: 2 }] },
		})
		expect(res.statusCode).toBe(400)
	})

	it('повторный полный возврат → 400 (заказ уже возвращён)', async () => {
		const { app } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: true, returns: [], items: soldItems },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-test-0003' }),
			payload: { orderId: 'o-1' },
		})
		expect(res.statusCode).toBe(400)
	})

	it('возврат заказа on_credit — создаёт sales_return с party_kind=customer', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{
					id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [],
					items: [
						{ productId: 'p-1', qty: 2, name: 'А', price: 300, cost: 100 },
						{ productId: 'p-2', qty: 1, name: 'Б', price: 400, cost: 200 },
					],
					on_credit: true,
					customer_id: 'cu-42',
				},
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-oncredit-01' }),
			payload: { orderId: 'o-1', items: [{ productId: 'p-1', qty: 1 }] },
		})
		expect(res.statusCode).toBe(201)
		const docsInsert = log.find(e => e.sql.includes('insert into docs') && !e.sql.includes('doc_lines'))!
		expect(docsInsert.params).toContain('sales_return')
		expect(docsInsert.params).toContain('customer')
		expect(docsInsert.params).toContain('cu-42')
	})

	it('возврат заказа с клиентом (не on_credit) — sales_return с party', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{
					id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [],
					items: [{ productId: 'p-1', qty: 1, name: 'А', price: 300 }],
					on_credit: false,
					customer_id: 'cu-42',
				},
			),
		})
		await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-cash-01' }),
			payload: { orderId: 'o-1' },
		})
		const docsInsert = log.find(e => e.sql.includes('insert into docs') && !e.sql.includes('doc_lines'))!
		expect(docsInsert.params).toContain('sales_return')
		expect(docsInsert.params).toContain('customer')
		expect(docsInsert.params).toContain('cu-42')
	})

	it('розничный возврат (без customer_id) создаёт retail_return', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [], items: soldItems },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-retail-01' }),
			payload: { orderId: 'o-1' },
		})
		expect(res.statusCode).toBe(201)
		const docsInsert = log.find(e => e.sql.includes('insert into docs') && !e.sql.includes('doc_lines'))!
		expect(docsInsert.params).toContain('retail_return')
	})

	it('полный возврат вызывает post_doc, не ручное обновление stock', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{
					id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [],
					items: [{ productId: 'p-1', qty: 1, name: 'А', cost: 40 }],
				},
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-test-0005' }),
			payload: { orderId: 'o-1' },
		})
		expect(res.statusCode).toBe(201)
		expect(log.some(e => e.sql.includes('post_doc'))).toBe(true)
		// Нет ручных update products
		expect(log.some(e => e.sql.includes('update products set stock'))).toBe(false)
	})
})
