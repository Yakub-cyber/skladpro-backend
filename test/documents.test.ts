import { describe, expect, it } from 'vitest'
import { authHeaders, coreHandler, makeTestApp } from './helpers.js'

describe('POST /v1/documents/post', () => {
	it('receive: создаёт purchase_receipt + doc_lines + post_doc', async () => {
		const core = coreHandler({ postDocTotal: 1000 })
		const { app, log } = await makeTestApp({
			handler: (sql, params) => {
				const c = core(sql, params)
				if (c !== undefined) return c
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-receive-001' }),
			payload: { document: { id: 'd-1', type: 'receive', items: [{ productId: 'p-1', qty: 10, cost: 100 }] } },
		})
		expect(res.statusCode).toBe(201)
		expect(res.json().document).toMatchObject({ id: 'd-1', type: 'receive', total: 1000 })

		const sqls = log.map(e => e.sql)
		const docsInsert = log.find(e => e.sql.includes('insert into docs'))!
		expect(docsInsert.params).toContain('stock_income') // receive без supplierId → stock_income
		expect(sqls.some(s => s.includes('insert into doc_lines'))).toBe(true)
		expect(sqls.some(s => s.includes('post_doc'))).toBe(true)
		expect(sqls.some(s => s.includes('insert into documents'))).toBe(true) // backward compat
	})

	it('receive с supplierId → purchase_receipt + party', async () => {
		const core = coreHandler({ postDocTotal: 3000 })
		const { app, log } = await makeTestApp({
			handler: (sql, params) => {
				const c = core(sql, params)
				if (c !== undefined) return c
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-receive-002' }),
			payload: { document: { id: 'd-s1', type: 'receive', supplierId: 's-1', items: [{ productId: 'p-1', qty: 10, cost: 300 }] } },
		})
		expect(res.statusCode).toBe(201)
		const docsInsert = log.find(e => e.sql.includes('insert into docs'))!
		expect(docsInsert.params).toContain('purchase_receipt')
		expect(docsInsert.params).toContain('supplier')
		expect(docsInsert.params).toContain('s-1')
	})

	it('writeoff: создаёт writeoff doc + post_doc', async () => {
		const core = coreHandler({ postDocTotal: 0 })
		const { app, log } = await makeTestApp({
			handler: (sql, params) => {
				const c = core(sql, params)
				if (c !== undefined) return c
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-writeoff-001' }),
			payload: { document: { id: 'd-2', type: 'writeoff', items: [{ productId: 'p-1', qty: 8 }], reason: 'Бой' } },
		})
		expect(res.statusCode).toBe(201)
		const docsInsert = log.find(e => e.sql.includes('insert into docs'))!
		expect(docsInsert.params).toContain('writeoff')
		expect(log.some(e => e.sql.includes('post_doc'))).toBe(true)
	})

	it('writeoff: больше остатка → post_doc бросает P0001 → 409', async () => {
		const core = coreHandler({ throwOnPostDoc: { code: 'P0001', message: 'Недостаточно остатка' } })
		const { app, log } = await makeTestApp({
			handler: (sql, params) => {
				const c = core(sql, params)
				if (c !== undefined) return c
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-writeoff-002' }),
			payload: { document: { id: 'd-3', type: 'writeoff', items: [{ productId: 'p-1', qty: 5 }] } },
		})
		expect(res.statusCode).toBe(409)
		expect(res.json().error.code).toBe('INSUFFICIENT_STOCK')
		expect(log.some(e => e.sql.startsWith('rollback'))).toBe(true)
	})

	it('adjust: инвентаризация создаёт inventory doc + post_doc', async () => {
		const core = coreHandler({ postDocTotal: 0 })
		const { app, log } = await makeTestApp({
			handler: (sql, params) => {
				const c = core(sql, params)
				if (c !== undefined) return c
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/documents/post',
			headers: await authHeaders({ 'idempotency-key': 'doc-adjust-001' }),
			payload: { document: { id: 'd-4', type: 'adjust', items: [{ productId: 'p-1', qty: 7 }] } },
		})
		expect(res.statusCode).toBe(201)
		const docsInsert = log.find(e => e.sql.includes('insert into docs'))!
		expect(docsInsert.params).toContain('inventory')
		expect(log.some(e => e.sql.includes('post_doc'))).toBe(true)
		expect(log.some(e => e.sql.includes('insert into audit'))).toBe(true)
	})
})
