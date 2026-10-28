import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileStock } from '../../src/services/stockReconcile.js'
import type { StockReconcileInput } from '../../src/routes/stock.js'
import { allowSkipIntegration, call, hasDb, setupIntegration, type Ctx } from './helpers.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL is required')
describe.skipIf(!hasDb)('permanent sale v2 stock proof — PostgreSQL', () => {
	let ctx: Ctx
	beforeEach(async () => { ctx = await setupIntegration() })
	afterEach(async () => { await ctx?.close() })
	const sale = (warehouseId = 'w1') => ({ contractVersion: 2, order: { id: randomUUID(), warehouseId,
		items: [{ productId: 'p1', qty: 2, price: 50 }], discount: 1, track: [{ nested: { a: 1, b: 2 } }] } })
	const command = (payload: ReturnType<typeof sale>) => ({ commandId: payload.order.id, kind: 'sale' as const, idempotencyKey: `sale-${payload.order.id}`, payload })
	const request = (payload: ReturnType<typeof sale>): StockReconcileInput => ({ contractVersion: 1, requestId: randomUUID(), productIds: ['p1'], commands: [command(payload)] })
	const post = (payload: ReturnType<typeof sale>) => call(ctx, 'POST', '/v1/sales', payload, `sale-${payload.order.id}`)
	const reconcile = async (payload: ReturnType<typeof sale>) => {
		const response = await call(ctx, 'POST', '/v1/stock/reconcile', request(payload))
		expect(response.statusCode).toBe(200)
		return response.json()
	}
	async function seed() {
		for (const [warehouseId, qty] of [['w1', 40], ['w2', 60]] as const) {
			expect((await call(ctx, 'POST', '/v1/documents/post', { document: { id: randomUUID(), type: 'receive', warehouseId, items: [{ productId: 'p1', qty, cost: 7 }] } })).statusCode).toBe(201)
		}
	}
	async function facts() {
		const result: Record<string, unknown> = {}
		for (const table of ['docs', 'doc_lines', 'stock_balances', 'stock_movements', 'money_movements', 'settlement_movements', 'orders', 'idempotency_keys']) {
			result[table] = (await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as rows from ${table} t where company_id=$1`, [ctx.companyId])).rows[0].rows
		}
		return result
	}
	async function editProof(payload: ReturnType<typeof sale>, edit: (saved: any) => any) {
		const id = `sale-${payload.order.id}`
		const saved = JSON.parse((await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2', [ctx.companyId, id])).rows[0].source_payload)
		await ctx.pool.query('update docs set source_payload=$3 where company_id=$1 and id=$2', [ctx.companyId, id, JSON.stringify(edit(saved))])
	}
	for (const warehouse of ['w1', 'w2']) it(`resolves ${warehouse} applied with balances, repeat and expired temporary key, without writes`, async () => {
		await seed(); const payload = sale(warehouse)
		expect((await post(payload)).statusCode).toBe(201)
		await ctx.pool.query('delete from idempotency_keys where company_id=$1', [ctx.companyId])
		const before = await facts()
		for (let i = 0; i < 2; i++) {
			const snapshot = await reconcile(payload)
			expect(snapshot.commands[0]).toMatchObject({ resolution: 'applied', effectIncluded: true, documentId: `sale-${payload.order.id}` })
			expect(Number(snapshot.totals[0].qtyBase)).toBe(98)
			expect(Number(snapshot.balances.find((b: any) => b.warehouseId === warehouse).qtyBase)).toBe(warehouse === 'w1' ? 38 : 58)
		}
		expect(await facts()).toEqual(before)
	})
	it('reports not_observed only within the snapshot, and rejects an inconsistent command ID', async () => {
		const payload = sale()
		expect((await reconcile(payload)).commands[0]).toMatchObject({ resolution: 'not_observed', effectIncluded: false })
		const body = request(payload); body.commands[0]!.commandId = 'other-sale'
		expect((await call(ctx, 'POST', '/v1/stock/reconcile', body)).json().commands[0].resolution).toBe('conflict')
	})
	for (const change of ['warehouse', 'qty', 'price', 'discount', 'track'] as const) it(`detects ${change} payload conflict without writes`, async () => {
		const payload = sale(); expect((await post(payload)).statusCode).toBe(201)
		const altered = structuredClone(payload)
		if (change === 'warehouse') altered.order.warehouseId = 'w2'
		else if (change === 'qty') altered.order.items[0]!.qty = 1
		else if (change === 'price') altered.order.items[0]!.price = 51
		else if (change === 'discount') altered.order.discount = 2
		else altered.order.track[0]!.nested.a = 3
		const before = await facts()
		expect((await reconcile(altered)).commands[0]).toMatchObject({ resolution: 'conflict', effectIncluded: null })
		expect(await facts()).toEqual(before)
	})
	for (const defect of ['fingerprint', 'request', 'json', 'missing', 'result'] as const) it(`fails closed for ${defect} proof`, async () => {
		const payload = sale(); expect((await post(payload)).statusCode).toBe(201)
		if (defect === 'json' || defect === 'missing') await ctx.pool.query('update docs set source_payload=$3 where company_id=$1 and id=$2', [ctx.companyId, `sale-${payload.order.id}`, defect === 'json' ? '{' : null])
		else await editProof(payload, s => {
			if (defect === 'fingerprint') s.fingerprint = '0'.repeat(64)
			else if (defect === 'request') s.request.order.warehouseId = 'w2'
			else s.result.fingerprint = 'invalid'
			return s
		})
		const before = await facts()
		expect((await reconcile(payload)).commands[0]).toMatchObject({ resolution: 'unverifiable', effectIncluded: null })
		expect(await facts()).toEqual(before)
	})
	for (const mode of ['draft', 'cancelled', 'unposted'] as const) it(`does not invent reversed proof for ${mode}`, async () => {
		const payload = sale(); expect((await post(payload)).statusCode).toBe(201)
		if (mode === 'cancelled') expect((await call(ctx, 'POST', `/v1/orders/${payload.order.id}/status`, { status: 'cancelled' })).statusCode).toBe(200)
		else if (mode === 'unposted') await ctx.pool.query('select unpost_doc($1,$2)', [ctx.companyId, `sale-${payload.order.id}`])
		else await ctx.pool.query(`update docs set status='draft' where company_id=$1 and id=$2`, [ctx.companyId, `sale-${payload.order.id}`])
		const before = await facts()
		expect((await reconcile(payload)).commands[0]).toMatchObject({ resolution: 'unverifiable', effectIncluded: null, reason: 'SALE_REVERSAL_NOT_PROVEN' })
		expect(await facts()).toEqual(before)
	})
	it('keeps legacy sale proof unverifiable', async () => {
		const payload = sale()
		expect((await call(ctx, 'POST', '/v1/sales', { order: payload.order })).statusCode).toBe(201)
		expect((await reconcile(payload)).commands[0].resolution).toBe('unverifiable')
	})
	it('does not trust document IDs, changed warehouse or ledger/balance drift', async () => {
		const payload = sale(); expect((await post(payload)).statusCode).toBe(201)
		await ctx.pool.query(`update docs set warehouse_id='w2' where company_id=$1 and id=$2`, [ctx.companyId, `sale-${payload.order.id}`])
		expect((await reconcile(payload)).commands[0].resolution).toBe('conflict')
		await ctx.pool.query(`update docs set warehouse_id='w1' where company_id=$1 and id=$2`, [ctx.companyId, `sale-${payload.order.id}`])
		const client = await ctx.pool.connect()
		try {
			await client.query('begin'); await client.query("select set_config('app.ledger','1',true)")
			await client.query(`update stock_balances set qty=qty+1 where company_id=$1 and warehouse_id='w1' and product_id='p1'`, [ctx.companyId]); await client.query('commit')
		} finally { client.release() }
		const before = await facts()
		expect((await reconcile(payload)).commands[0]).toMatchObject({ resolution: 'unverifiable', reason: 'SALE_BALANCE_LEDGER_MISMATCH' })
		expect(await facts()).toEqual(before)
	})
	it('reconciles a real lost HTTP response after commit', async () => {
		ctx.app.addHook('onSend', async (req, reply, data) => { if (req.headers['x-drop'] === '1') reply.raw.destroy(); return data })
		const payload = sale(), address = await ctx.app.listen({ host: '127.0.0.1', port: 0 })
		const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
			const req = httpRequest(`${address}/v1/sales`, { method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'x-company-id': ctx.companyId, 'idempotency-key': `sale-${payload.order.id}`, 'content-type': 'application/json', 'x-drop': '1' } }, res => { res.resume(); reject(new Error('Expected lost response')) })
			req.on('error', resolve); req.end(JSON.stringify(payload))
		})
		expect(error.code).toBe('ECONNRESET')
		const before = await facts()
		expect((await reconcile(payload)).commands[0].resolution).toBe('applied')
		expect(await facts()).toEqual(before)
	})
	it('reads entirely before a concurrent commit between balances and proof, then entirely after', async () => {
		await seed(); const payload = sale(), client = await ctx.pool.connect(); let posted = false
		const query = async (sql: string, values?: any[]) => {
			const result = await client.query(sql, values)
			if (sql.startsWith('select warehouse_id as') && !posted) {
				posted = true; expect((await post(payload)).statusCode).toBe(201)
			}
			return result
		}
		try {
			const before = await reconcileStock({ ...ctx.pool, connect: async () => ({ query, release: () => {} }) } as any, ctx.companyId, request(payload))
			expect(posted).toBe(true)
			expect(Number(before.totals[0]!.qtyBase)).toBe(100)
			expect(before.commands[0]!.resolution).toBe('not_observed')
			const after = await reconcile(payload)
			expect(Number(after.totals[0].qtyBase)).toBe(98)
			expect(after.commands[0].resolution).toBe('applied')
		} finally { client.release() }
	})
	it('validates nested scope and isolates identical sale IDs in different companies', async () => {
		const payload = sale(), other = await setupIntegration()
		try {
			expect((await call(other, 'POST', '/v1/sales', payload, `sale-${payload.order.id}`)).statusCode).toBe(201)
			expect((await reconcile(payload)).commands[0].resolution).toBe('not_observed')
			const expanded = structuredClone(payload); expanded.order.items.push({ productId: 'outside', qty: 1, price: 1 })
			expect((await call(ctx, 'POST', '/v1/stock/reconcile', request(expanded))).statusCode).toBe(422)
		} finally { await other.close() }
	})
})
