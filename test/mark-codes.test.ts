import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, makeTestApp } from './helpers.js'

function productHandler(p: { id: string; name: string; stock: number; marked: boolean; codes?: string[] } | null) {
	return (sql: string, params: unknown[]): unknown[] | undefined => {
		if (sql.includes('from products') && sql.includes('for update')) {
			if (!p || params[1] !== p.id) return []
			return [{
				id: p.id, name: p.name, stock: p.stock, cost: 0, batches: [],
				marked: p.marked, codes: p.codes ?? [],
			}]
		}
		if (sql.includes('insert into orders') && sql.includes('returning id')) return [{ id: params[1] }]
		return undefined
	}
}

describe('POST /v1/products/:id/mark-codes — приёмка/коррекция', () => {
	it('add: новые коды добавляются в пул, дубликаты игнорируются', async () => {
		let savedCodes: unknown = null
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from products') && sql.includes('for update'))
					return [{ id: 'p-1', name: 'Пиво', marked: true, codes: ['A', 'B'] }]
				if (sql.includes('update products set codes')) {
					savedCodes = params[2]
					return []
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/products/p-1/mark-codes',
			headers: await authHeaders({ 'idempotency-key': 'mc-add-01' }),
			payload: { action: 'add', codes: ['B', 'C', 'D'] },
		})
		expect(res.statusCode).toBe(201)
		expect(res.json()).toMatchObject({ productId: 'p-1', action: 'add', added: 2, removed: 0, poolSize: 4 })
		const stored = JSON.parse(String(savedCodes))
		expect(stored.sort()).toEqual(['A', 'B', 'C', 'D'])
	})

	it('remove: только указанные коды убираются', async () => {
		let savedCodes: unknown = null
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from products') && sql.includes('for update'))
					return [{ id: 'p-1', name: 'Пиво', marked: true, codes: ['A', 'B', 'C'] }]
				if (sql.includes('update products set codes')) {
					savedCodes = params[2]
					return []
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/products/p-1/mark-codes',
			headers: await authHeaders({ 'idempotency-key': 'mc-rm-01' }),
			payload: { action: 'remove', codes: ['B', 'Z'] }, // Z нет в пуле — молча пропускаем
		})
		expect(res.statusCode).toBe(201)
		expect(res.json()).toMatchObject({ action: 'remove', added: 0, removed: 1, poolSize: 2 })
		const stored = JSON.parse(String(savedCodes))
		expect(stored.sort()).toEqual(['A', 'C'])
	})

	it('немаркированный товар → 400', async () => {
		const { app } = await makeTestApp({
			handler: sql => (sql.includes('from products') && sql.includes('for update')
				? [{ id: 'p-1', name: 'Обычный', marked: false, codes: [] }]
				: undefined),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/products/p-1/mark-codes',
			headers: await authHeaders({ 'idempotency-key': 'mc-nomark-01' }),
			payload: { action: 'add', codes: ['X'] },
		})
		expect(res.statusCode).toBe(400)
	})

	it('несуществующий товар → 404', async () => {
		const { app } = await makeTestApp({
			handler: sql => (sql.includes('from products') && sql.includes('for update') ? [] : undefined),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/products/p-nope/mark-codes',
			headers: await authHeaders({ 'idempotency-key': 'mc-404-01' }),
			payload: { action: 'add', codes: ['X'] },
		})
		expect(res.statusCode).toBe(404)
	})

	it('курьеру запрещено', async () => {
		const { app } = await makeTestApp({
			handler: () => undefined,
			membership: { company_id: COMPANY_ID, role: 'courier', name: 'X' },
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/products/p-1/mark-codes',
			headers: await authHeaders({ 'idempotency-key': 'mc-403-01' }),
			payload: { action: 'add', codes: ['X'] },
		})
		expect(res.statusCode).toBe(403)
	})
})

describe('POST /v1/sales — items.markCodes', () => {
	it('продажа со сканированными КМ снимает именно их из пула', async () => {
		let savedCodes: unknown = null
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from products') && sql.includes('for update'))
					return [{ id: params[1], name: 'Пиво', stock: 10, cost: 0, batches: [], marked: true, codes: ['A', 'B', 'C'] }]
				if (sql.includes('insert into orders') && sql.includes('returning id')) return [{ id: params[1] }]
				if (sql.includes('update products set stock = stock - $3, batches = $4, codes = $5')) {
					savedCodes = params[4]
					return []
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-mc-01' }),
			payload: {
				order: {
					id: 'o-mc-1',
					items: [{ productId: 'p-1', qty: 2, price: 100, markCodes: ['B', 'C'] }],
				},
			},
		})
		expect(res.statusCode).toBe(201)
		const stored = JSON.parse(String(savedCodes))
		expect(stored).toEqual(['A']) // 'B','C' сняты
	})

	it('markCodes на немаркированном товаре → 400', async () => {
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from products') && sql.includes('for update'))
					return [{ id: params[1], name: 'Обычный', stock: 10, cost: 0, batches: [], marked: false, codes: [] }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-mc-noflag' }),
			payload: {
				order: {
					id: 'o-mc-2',
					items: [{ productId: 'p-1', qty: 1, price: 100, markCodes: ['X'] }],
				},
			},
		})
		expect(res.statusCode).toBe(400)
	})

	it('markCodes отсутствуют в пуле → 409 MARK_CODE_NOT_IN_POOL', async () => {
		const { app } = await makeTestApp({
			handler: productHandler({ id: 'p-1', name: 'Пиво', stock: 10, marked: true, codes: ['A', 'B'] }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-mc-miss' }),
			payload: {
				order: {
					id: 'o-mc-3',
					items: [{ productId: 'p-1', qty: 1, price: 100, markCodes: ['Z'] }],
				},
			},
		})
		expect(res.statusCode).toBe(409)
		expect(res.json().error.code).toBe('MARK_CODE_NOT_IN_POOL')
		expect(res.json().error.details).toMatchObject({ productId: 'p-1', missing: ['Z'] })
	})

	it('дубликаты в markCodes → 400', async () => {
		const { app } = await makeTestApp({
			handler: productHandler({ id: 'p-1', name: 'Пиво', stock: 10, marked: true, codes: ['A', 'B'] }),
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-mc-dup' }),
			payload: {
				order: {
					id: 'o-mc-4',
					items: [{ productId: 'p-1', qty: 2, price: 100, markCodes: ['A', 'A'] }],
				},
			},
		})
		expect(res.statusCode).toBe(400)
	})

	it('маркированный товар БЕЗ явных markCodes — снимаем первые N (совместимость)', async () => {
		let savedCodes: unknown = null
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from products') && sql.includes('for update'))
					return [{ id: params[1], name: 'Пиво', stock: 10, cost: 0, batches: [], marked: true, codes: ['A', 'B', 'C', 'D'] }]
				if (sql.includes('insert into orders') && sql.includes('returning id')) return [{ id: params[1] }]
				if (sql.includes('update products set stock = stock - $3, batches = $4, codes = $5')) {
					savedCodes = params[4]
					return []
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sales',
			headers: await authHeaders({ 'idempotency-key': 'sale-mc-firstn' }),
			payload: {
				order: {
					id: 'o-mc-5',
					items: [{ productId: 'p-1', qty: 2, price: 100 }],
				},
			},
		})
		expect(res.statusCode).toBe(201)
		// Первые 2 (A, B) сняты; остаток C, D.
		expect(JSON.parse(String(savedCodes))).toEqual(['C', 'D'])
	})
})
