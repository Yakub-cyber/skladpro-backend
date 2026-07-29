import { describe, expect, it } from 'vitest'
import { authHeaders, makeTestApp } from './helpers.js'

function productHandler(products: Record<string, { stock: number; cost: number; batches?: unknown[] }>) {
	return (sql: string, params: unknown[]): unknown[] | undefined => {
		if (sql.includes('from products') && sql.includes('for update')) {
			const id = params[1] as string
			const p = products[id]
			if (!p) return []
			return [{ id, name: `Товар ${id}`, stock: p.stock, cost: p.cost, batches: p.batches ?? [] }]
		}
		if (sql.includes('insert into documents') && sql.includes('returning id')) return [{ id: params[1] }]
		return undefined
	}
}

describe('POST /v1/documents/post', () => {
	it('receive: приход увеличивает остаток, пересчитывает себестоимость, создаёт партию', async () => {
		const { app, log } = await makeTestApp({ handler: productHandler({ 'p-1': { stock: 10, cost: 50 } }) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-receive-001' }),
			payload: { document: { id: 'd-1', type: 'receive', items: [{ productId: 'p-1', qty: 10, cost: 100 }] } },
		})
		expect(res.statusCode).toBe(201)

		const upd = log.find(e => e.sql.includes('update products set stock = stock +'))!
		// средневзвешенная: (10*50 + 10*100) / 20 = 75
		expect(upd.params[3]).toBe(75)
		const batches = JSON.parse(String(upd.params[4]))
		expect(batches).toHaveLength(1)
		expect(batches[0]).toMatchObject({ qty: 10, cost: 100 })
		expect(log.some(e => e.sql.includes('insert into movements'))).toBe(true)
	})

	it('writeoff: списание по FIFO с проверкой остатка', async () => {
		const batches = [
			{ id: 'b1', qty: 5, cost: 40, at: '2026-01-01T00:00:00Z' },
			{ id: 'b2', qty: 10, cost: 60, at: '2026-02-01T00:00:00Z' },
		]
		const { app, log } = await makeTestApp({ handler: productHandler({ 'p-1': { stock: 15, cost: 53, batches } }) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-writeoff-001' }),
			payload: { document: { id: 'd-2', type: 'writeoff', items: [{ productId: 'p-1', qty: 8 }], reason: 'Бой' } },
		})
		expect(res.statusCode).toBe(201)
		const upd = log.find(e => e.sql.includes('update products set stock = stock -'))!
		const rest = JSON.parse(String(upd.params[3]))
		// FIFO: съедена вся b1 (5) и 3 из b2 → остаток b2 = 7
		expect(rest).toHaveLength(1)
		expect(rest[0]).toMatchObject({ id: 'b2', qty: 7 })
		// COGS в движении: 5*40 + 3*60 = 380
		const mov = log.find(e => e.sql.includes('insert into movements'))!
		expect(mov.params[7]).toBe(380)
	})

	it('writeoff: больше остатка → 409, ничего не меняется', async () => {
		const { app, log } = await makeTestApp({ handler: productHandler({ 'p-1': { stock: 3, cost: 50 } }) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-writeoff-002' }),
			payload: { document: { id: 'd-3', type: 'writeoff', items: [{ productId: 'p-1', qty: 5 }] } },
		})
		expect(res.statusCode).toBe(409)
		expect(log.some(e => e.sql.startsWith('rollback'))).toBe(true)
	})

	it('adjust: инвентаризация выставляет остаток и пишет дельту', async () => {
		const { app, log } = await makeTestApp({ handler: productHandler({ 'p-1': { stock: 10, cost: 50 } }) })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-adjust-001' }),
			payload: { document: { id: 'd-4', type: 'adjust', items: [{ productId: 'p-1', qty: 7 }] } },
		})
		expect(res.statusCode).toBe(201)
		const upd = log.find(e => e.sql.includes('update products set stock = $3'))!
		expect(upd.params[2]).toBe(7)
		const mov = log.find(e => e.sql.includes('insert into movements'))!
		expect(mov.params[6]).toBe(-3) // delta
	})

	it('дубликат документа → 409', async () => {
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('from products') && sql.includes('for update'))
					return [{ id: params[1], name: 'Т', stock: 100, cost: 1, batches: [] }]
				if (sql.includes('insert into documents')) return [] // конфликт id
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-dup-001' }),
			payload: { document: { id: 'd-1', type: 'receive', items: [{ productId: 'p-1', qty: 1 }] } },
		})
		expect(res.statusCode).toBe(409)
	})
})
