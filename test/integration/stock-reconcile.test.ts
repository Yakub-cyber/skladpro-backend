import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileStock, STOCK_RECONCILE_LIMITS } from '../../src/services/stockReconcile.js'
import type { StockReconcileInput } from '../../src/routes/stock.js'
import { allowSkipIntegration, call, hasDb, setupIntegration, type Ctx } from './helpers.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL is required')
const originalLimits = { ...STOCK_RECONCILE_LIMITS }
describe.skipIf(!hasDb)('atomic stock reconciliation — real PostgreSQL', () => {
	let ctx: Ctx
	beforeEach(async () => { ctx = await setupIntegration() })
	afterEach(async () => { Object.assign(STOCK_RECONCILE_LIMITS, originalLimits); vi.restoreAllMocks(); await ctx?.close() })
	const body = (commands: StockReconcileInput['commands'] = []): StockReconcileInput =>
		({ contractVersion: 1, requestId: randomUUID(), productIds: ['p1'], commands })
	const send = (payload = body()) => call(ctx, 'POST', '/v1/stock/reconcile', payload)
	async function receive(warehouseId: string, qty: number) {
		const document = { id: randomUUID(), type: 'receive', warehouseId, items: [{ productId: 'p1', qty, cost: 7 }] }
		expect((await call(ctx, 'POST', '/v1/documents/post', { document })).statusCode).toBe(201)
		return document
	}
	async function sourceAndReturn() {
		await receive('w1', 40)
		const id = randomUUID()
		expect((await call(ctx, 'POST', '/v1/sales', { order: { id, items: [{ productId: 'p1', qty: 3, price: 50 }] } })).statusCode).toBe(201)
		const payload = { contractVersion: 2, returnId: randomUUID(), orderId: id,
			items: [{ saleLineId: `sale-${id}-0`, qtyBase: '1' }] }
		const command = { commandId: payload.returnId, kind: 'return_v2' as const,
			idempotencyKey: `return:${payload.returnId}`, payload }
		return { payload, command }
	}
	async function facts() {
		const tables = ['docs', 'doc_lines', 'stock_balances', 'stock_movements', 'money_movements', 'settlement_movements', 'orders', 'idempotency_keys']
		const result: Record<string, unknown> = {}
		for (const table of tables) result[table] = (await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as rows from ${table} t where company_id=$1`, [ctx.companyId])).rows[0].rows
		return result
	}
	it('returns all warehouses, 40/60, exact strings and total 100 without writes', async () => {
		await receive('w1', 40); await receive('w2', 60)
		const before = await facts(), response = await send()
		expect(response.statusCode).toBe(200)
		const r = response.json()
		expect(r.coverage).toEqual({ productIds: ['p1'], warehouseScope: 'all-company-warehouses', complete: true, missingBalanceMeansZero: true })
		expect(r.balances.map((b: any) => Number(b.qtyBase))).toEqual([40, 60])
		expect(r.balances.every((b: any) => typeof b.qtyBase === 'string')).toBe(true)
		expect(r.totals).toEqual([{ productId: 'p1', qtyBase: '100.0000' }])
		expect(await facts()).toEqual(before)
		expect((await send()).json().snapshotId).not.toBe(r.snapshotId)
	})
	it('distinguishes a complete empty balance set from partial loading and includes zero rows', async () => {
		const empty = (await send()).json()
		expect(empty.balances).toEqual([]); expect(empty.totals[0].qtyBase).toBe('0')
		await receive('w1', 1)
		expect((await call(ctx, 'POST', '/v1/documents/post', { document: { id: randomUUID(), type: 'adjust', warehouseId: 'w1', items: [{ productId: 'p1', qty: 0 }] } })).statusCode).toBe(201)
		const zero = (await send()).json()
		expect(Number(zero.balances[0].qtyBase)).toBe(0); expect(zero.coverage.missingBalanceMeansZero).toBe(true)
	})
	it('includes an archived warehouse with stock', async () => {
		await receive('w2', 60)
		await ctx.pool.query('update warehouses set deleted_at=now() where company_id=$1 and id=$2', [ctx.companyId, 'w2'])
		const r = (await send()).json()
		expect(r.warehouses).toContainEqual({ id: 'w2', active: false })
		expect(Number(r.totals[0].qtyBase)).toBe(60)
	})
	it('resolves not_observed, applied after a lost response, conflict and unverifiable', async () => {
		const { payload, command } = await sourceAndReturn()
		expect((await send(body([command]))).json().commands[0].resolution).toBe('not_observed')
		// Commit the return, then deliberately discard its HTTP response at the client boundary.
		await call(ctx, 'POST', '/v1/returns', payload, command.idempotencyKey)
		const before = await facts()
		const applied = (await send(body([command]))).json().commands[0]
		expect(applied).toMatchObject({ resolution: 'applied', effectIncluded: true, documentId: `ret-${payload.returnId}` })
		const changed = { ...command, payload: { ...payload, items: [{ ...payload.items[0]!, qtyBase: '2' }] } }
		expect((await send(body([changed]))).json().commands[0].resolution).toBe('conflict')
		const legacy = { commandId: payload.orderId, kind: 'sale' as const, idempotencyKey: `sale-${payload.orderId}`, payload: { id: payload.orderId } }
		expect((await send(body([legacy]))).json().commands[0]).toMatchObject({ resolution: 'unverifiable', effectIncluded: null })
		expect(await facts()).toEqual(before)
	})
	it('uses permanent proof after temporary keys are removed; observes a reversed return', async () => {
		const { payload, command } = await sourceAndReturn()
		expect((await call(ctx, 'POST', '/v1/returns', payload, command.idempotencyKey)).statusCode).toBe(201)
		await ctx.pool.query('delete from idempotency_keys where company_id=$1', [ctx.companyId])
		expect((await send(body([command]))).json().commands[0].resolution).toBe('applied')
		await ctx.pool.query('select unpost_doc($1,$2)', [ctx.companyId, `ret-${payload.returnId}`])
		const before = await facts()
		expect((await send(body([command]))).json().commands[0]).toMatchObject({ resolution: 'reversed', effectIncluded: false })
		expect(await facts()).toEqual(before)
	})
	it('reconciles a return after a real HTTP connection is lost after commit', async () => {
		ctx.app.addHook('onSend', async (request, reply, payload) => {
			if (request.headers['x-test-drop-response'] === '1') reply.raw.destroy()
			return payload
		})
		const { payload, command } = await sourceAndReturn()
		const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 })
		const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
			const req = httpRequest(`${address}/v1/returns`, { method: 'POST', headers: {
				authorization: `Bearer ${ctx.token}`, 'x-company-id': ctx.companyId,
				'idempotency-key': command.idempotencyKey, 'content-type': 'application/json', 'x-test-drop-response': '1',
			} }, response => { response.resume(); reject(new Error('Expected lost response')) })
			req.on('error', resolve)
			req.setTimeout(5000, () => req.destroy(new Error('HTTP test timeout')))
			req.end(JSON.stringify(payload))
		})
		expect(error.code).toBe('ECONNRESET')
		const before = await facts()
		expect((await send(body([command]))).json().commands[0].resolution).toBe('applied')
		expect((await call(ctx, 'POST', '/v1/returns', payload, command.idempotencyKey)).headers['idempotency-replayed']).toBe('true')
		expect(await facts()).toEqual(before)
	})
	it('does not trust matching IDs with missing or damaged proof', async () => {
		const { payload, command } = await sourceAndReturn()
		expect((await call(ctx, 'POST', '/v1/returns', payload, command.idempotencyKey)).statusCode).toBe(201)
		await ctx.pool.query("update docs set source_payload='broken' where company_id=$1 and id=$2", [ctx.companyId, `ret-${payload.returnId}`])
		expect((await send(body([command]))).json().commands[0]).toMatchObject({ resolution: 'unverifiable', effectIncluded: null })
	})
	it('rejects command scope outside selected products and unknown products', async () => {
		const command = { commandId: 'd1', kind: 'doc_post' as const, idempotencyKey: 'doc-d1', payload: { id: 'd1', items: [{ productId: 'p2', qty: 1 }] } }
		expect((await send(body([command]))).json().error.code).toBe('STOCK_SCOPE_INCOMPLETE')
		expect((await send({ ...body(), productIds: ['unknown'] })).statusCode).toBe(404)
	})
	it('rejects incomplete scope discovered from server lines even if omitted in payload', async () => {
		await ctx.pool.query("insert into products (company_id,id,name) values ($1,'p2','Second')", [ctx.companyId])
		const document = { id: randomUUID(), type: 'receive', warehouseId: 'w1', items: [{ productId: 'p2', qty: 1 }] }
		expect((await call(ctx, 'POST', '/v1/documents/post', { document })).statusCode).toBe(201)
		const command = { commandId: document.id, kind: 'doc_post' as const, idempotencyKey: `doc-${document.id}`, payload: { id: document.id } }
		expect((await send(body([command]))).json().error.code).toBe('STOCK_SCOPE_INCOMPLETE')
	})
	it('isolates companies with identical product IDs and denies foreign company headers/body', async () => {
		const other = await setupIntegration()
		try {
			await receive('w1', 40)
			expect((await call(other, 'POST', '/v1/stock/reconcile', body())).json().totals[0].qtyBase).toBe('0')
			const denied = await ctx.app.inject({ method: 'POST', url: '/v1/stock/reconcile', payload: body(), headers: { authorization: `Bearer ${ctx.token}`, 'x-company-id': other.companyId } })
			expect(denied.statusCode).toBe(403)
			expect((await send({ ...body(), companyId: other.companyId } as any)).statusCode).toBe(400)
		} finally { await other.close() }
	})
	it('requires authentication and denies courier access', async () => {
		expect((await ctx.app.inject({ method: 'POST', url: '/v1/stock/reconcile', payload: body() })).statusCode).toBe(401)
		await ctx.pool.query("update memberships set role='courier' where user_id=$1", [ctx.userId])
		expect((await send()).statusCode).toBe(403)
	})
	it('rejects cardinality, duplicate IDs and oversized request bodies', async () => {
		expect((await send({ ...body(), productIds: Array.from({ length: 501 }, (_, i) => `p${i}`) })).statusCode).toBe(400)
		expect((await send({ ...body(), productIds: ['p1', 'p1'] })).statusCode).toBe(400)
		const c = { commandId: 'x', kind: 'sale' as const, idempotencyKey: 'x', payload: { note: 'x'.repeat(270000) } }
		expect((await send(body([c]))).statusCode).toBe(413)
	})
	it('fails explicitly at response row and byte limits, never returning partial coverage', async () => {
		await receive('w1', 40); await receive('w2', 60)
		Object.assign(STOCK_RECONCILE_LIMITS, { rows: 1 })
		expect((await send()).json().error.code).toBe('STOCK_SNAPSHOT_TOO_LARGE')
		Object.assign(STOCK_RECONCILE_LIMITS, originalLimits, { responseBytes: 1 })
		expect((await send()).json().error.code).toBe('STOCK_SNAPSHOT_TOO_LARGE')
	})
	it('enforces its overall transaction deadline without changing records', async () => {
		const before = await facts()
		Object.assign(STOCK_RECONCILE_LIMITS, { timeoutMs: 0 })
		expect((await send()).json().error.code).toBe('STOCK_RECONCILE_TIMEOUT')
		expect(await facts()).toEqual(before)
	})
	it('cancels a slow PostgreSQL statement, rolls back and releases its connection', async () => {
		const before = await facts(), client = await ctx.pool.connect(), original = client.query.bind(client)
		let released = false
		Object.assign(STOCK_RECONCILE_LIMITS, { timeoutMs: 150 })
		const wrapped = {
			query: (sql: string, values?: any) => sql.includes('select id from products') ? original('select pg_sleep(1)') : original(sql, values),
			release: () => { released = true },
		}
		try {
			await expect(reconcileStock({ ...ctx.pool, connect: async () => wrapped } as any, ctx.companyId, body())).rejects.toMatchObject({ code: 'STOCK_RECONCILE_TIMEOUT', statusCode: 503 })
			expect(released).toBe(true)
			expect((await original('select 1 as usable')).rows[0].usable).toBe(1)
			expect(await facts()).toEqual(before)
		} finally { client.release() }
	})
	it('keeps balances and proof before a concurrent commit, then observes both after commit', async () => {
		const { payload, command } = await sourceAndReturn()
		const client = await ctx.pool.connect(), original = client.query.bind(client)
		let triggered = false
		const query = async (sql: any, values?: any) => {
			const result = await original(sql, values)
			if (!triggered && typeof sql === 'string' && sql.includes('from stock_balances where')) {
				triggered = true
				const settings = await original("select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as readonly")
				expect(settings.rows[0]).toEqual({ isolation: 'repeatable read', readonly: 'on' })
				expect((await call(ctx, 'POST', '/v1/returns', payload, command.idempotencyKey)).statusCode).toBe(201)
			}
			return result
		}
		const wrapped = { query, release: () => {} } as any
		try {
			const snapshot = await reconcileStock({ ...ctx.pool, connect: async () => wrapped } as any, ctx.companyId, body([command]))
			expect(triggered).toBe(true)
			expect(Number(snapshot.totals[0]!.qtyBase)).toBe(37)
			expect(Number(snapshot.balances[0]!.qtyBase)).toBe(37)
			expect(snapshot.commands[0]!.resolution).toBe('not_observed')
			const after = (await send(body([command]))).json()
			expect(Number(after.totals[0].qtyBase)).toBe(38)
			expect(after.commands[0].resolution).toBe('applied')
		} finally { client.release() }
	})
})
