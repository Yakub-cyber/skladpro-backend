import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, makeTestApp } from './helpers.js'

type OrderRow = {
	id: string
	no: string
	status: string
	stock_consumed: boolean
	returned?: boolean
	returns?: unknown[]
	items: unknown[]
	assigned_to?: string | null
}

function handlerWith(order: OrderRow, stock: Record<string, { qty: number; cost?: number; batches?: unknown[] }>) {
	return (sql: string, params: unknown[]): unknown[] | undefined => {
		if (sql.includes('from orders') && sql.includes('for update')) return params[1] === order.id ? [order] : []
		if (sql.includes('from products') && sql.includes('for update')) {
			const id = params[1] as string
			const p = stock[id]
			return p ? [{ id, name: `Товар ${id}`, stock: p.qty, cost: p.cost ?? 0, batches: p.batches ?? [] }] : []
		}
		return undefined
	}
}

describe('POST /v1/orders/:id/status', () => {
	const items = [{ productId: 'p-1', qty: 2, name: 'Товар' }]

	it('shipped: списывает остаток и ставит stock_consumed', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith({ id: 'o-1', no: '1', status: 'packed', stock_consumed: false, items }, { 'p-1': { qty: 5 } }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0001' }),
			payload: { status: 'shipped' },
		})
		expect(res.statusCode).toBe(200)
		// В новом коде списание идёт как `stock = stock - $3` (не +/-1).
		expect(log.some(e => e.sql.includes('update products set stock = stock - $3') && e.params[2] === 2)).toBe(true)
		expect(log.some(e => e.sql.includes('set stock_consumed = true'))).toBe(true)
	})

	it('shipped при нехватке остатка → 409', async () => {
		const { app } = await makeTestApp({
			handler: handlerWith({ id: 'o-1', no: '1', status: 'packed', stock_consumed: false, items }, { 'p-1': { qty: 1 } }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0002' }),
			payload: { status: 'shipped' },
		})
		expect(res.statusCode).toBe(409)
	})

	it('cancelled после отгрузки возвращает остаток', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '1', status: 'shipped', stock_consumed: true, returns: [], items },
				{ 'p-1': { qty: 0 } },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0003' }),
			payload: { status: 'cancelled' },
		})
		expect(res.statusCode).toBe(200)
		expect(log.some(e => e.sql.includes('update products set stock = stock + $3') && e.params[2] === 2)).toBe(true)
		expect(log.some(e => e.sql.includes('set stock_consumed = false'))).toBe(true)
	})

	it('cancelled после ЧАСТИЧНОГО возврата НЕ возвращает уже возвращённые единицы', async () => {
		// Продано 2 шт p-1, 1 шт уже возвращён через /v1/returns → отмена
		// должна вернуть только 1 оставшуюся, а не 2 (иначе +1 фантом на складе).
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{
					id: 'o-1',
					no: '1',
					status: 'shipped',
					stock_consumed: true,
					returns: [{ at: 'x', by: 'y', items: [{ productId: 'p-1', qty: 1 }] }],
					items,
				},
				{ 'p-1': { qty: 0 } },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/orders/o-1/status',
			headers: await authHeaders({ 'idempotency-key': 'status-test-0007' }),
			payload: { status: 'cancelled' },
		})
		expect(res.statusCode).toBe(200)
		const restocks = log.filter(e => e.sql.includes('update products set stock = stock + $3'))
		expect(restocks).toHaveLength(1)
		expect(restocks[0]!.params[2]).toBe(1) // только 1 оставшаяся, не 2
	})

	it('запрещённый переход delivered → new отклоняется', async () => {
		const { app } = await makeTestApp({
			handler: handlerWith({ id: 'o-1', no: '1', status: 'delivered', stock_consumed: true, items }, {}),
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
					{},
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
				{},
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
		{ productId: 'p-1', qty: 2, name: 'А' },
		{ productId: 'p-2', qty: 1, name: 'Б' },
	]

	it('полный возврат: restock всех позиций, returned=true', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [], items: soldItems },
				{ 'p-1': { qty: 0 }, 'p-2': { qty: 0 } },
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
		const restocks = log.filter(e => e.sql.includes('update products set stock = stock + $3'))
		expect(restocks).toHaveLength(2)
		expect(log.some(e => e.sql.includes('update orders set returns') && e.params[3] === true)).toBe(true)
	})

	it('дубликат productId в одном запросе НЕ обходит проверку remaining', async () => {
		const { app } = await makeTestApp({
			handler: handlerWith(
				{ id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [], items: soldItems },
				{ 'p-1': { qty: 0 } },
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
				{ 'p-1': { qty: 0 } },
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
				{},
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

	it('возврат заказа on_credit — уменьшает customers.balance на сумму возвращённых позиций', async () => {
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
				} as OrderRow & { on_credit: boolean; customer_id: string },
				{ 'p-1': { qty: 0 }, 'p-2': { qty: 0 } },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-oncredit-01' }),
			// Возвращаем 1 шт p-1 (по 300) → долг −300
			payload: { orderId: 'o-1', items: [{ productId: 'p-1', qty: 1 }] },
		})
		expect(res.statusCode).toBe(201)
		const balUpd = log.find(e => e.sql.includes('update customers set balance = greatest(0, coalesce(balance, 0) - $3)'))
		expect(balUpd).toBeTruthy()
		expect(balUpd!.params[1]).toBe('cu-42')
		expect(balUpd!.params[2]).toBe(300)
	})

	it('возврат заказа НЕ on_credit — customers.balance не трогается', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{
					id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [],
					items: [{ productId: 'p-1', qty: 1, name: 'А', price: 300 }],
					on_credit: false,
					customer_id: 'cu-42',
				} as OrderRow & { on_credit: boolean; customer_id: string },
				{ 'p-1': { qty: 0 } },
			),
		})
		await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-cash-01' }),
			payload: { orderId: 'o-1' },
		})
		expect(log.some(e => e.sql.includes('update customers set balance'))).toBe(false)
	})

	it('возврат восстанавливает FIFO-партию (batches получает +qty)', async () => {
		const { app, log } = await makeTestApp({
			handler: handlerWith(
				{
					id: 'o-1', no: '7', status: 'delivered', stock_consumed: true, returned: false, returns: [],
					// Продано 1 шт p-1 по себестоимости 40 (из order.items)
					items: [{ productId: 'p-1', qty: 1, name: 'А', cost: 40 }],
				},
				{ 'p-1': { qty: 0, cost: 55, batches: [] } },
			),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/returns',
			headers: await authHeaders({ 'idempotency-key': 'return-test-0005' }),
			payload: { orderId: 'o-1' },
		})
		expect(res.statusCode).toBe(201)
		// batches обновились: новая партия по себестоимости продажи (40, не 55)
		const upd = log.find(e => e.sql.includes('update products set stock = stock + $3'))!
		const batches = JSON.parse(String(upd.params[3]))
		expect(batches[0]).toMatchObject({ qty: 1, cost: 40 })
	})
})
