import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowSkipIntegration, call, cash, drift, hasDb, setupIntegration, stockAt, type Ctx } from './helpers.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL is required for sales v2 integration tests')

describe.skipIf(!hasDb)('sales v2 — permanent identity and explicit warehouse on PostgreSQL', () => {
	let ctx: Ctx
	beforeEach(async () => { ctx = await setupIntegration() })
	afterEach(async () => { await ctx?.close() })
	const command = (warehouseId = 'w1') => ({ contractVersion: 2, order: {
		id: randomUUID(), warehouseId, items: [{ productId: 'p1', qty: 2, price: 50 }],
	} })
	const send = (body: ReturnType<typeof command>, key = `sale-${body.order.id}`) => call(ctx, 'POST', '/v1/sales', body, key)
	async function counters() {
		return (await ctx.pool.query(`select
		 (select count(*) from docs where company_id=$1) as docs,
		 (select count(*) from stock_movements where company_id=$1) as stock,
		 (select count(*) from money_movements where company_id=$1) as money,
		 (select count(*) from settlement_movements where company_id=$1) as settlement,
		 (select count(*) from orders where company_id=$1) as orders,
		 (select count(*) from audit where company_id=$1) as audit`, [ctx.companyId])).rows[0]
	}
	for (const warehouse of ['w1', 'w2']) it(`posts all sale lines to ${warehouse}, once`, async () => {
		const body = command(warehouse), response = await send(body)
		expect(response.statusCode).toBe(201)
		expect(response.json()).toMatchObject({ contractVersion: 2, warehouseId: warehouse, documentId: `sale-${body.order.id}`,
			items: [{ saleLineId: `sale-${body.order.id}-0`, productId: 'p1', qtyBase: '2.0000' }] })
		expect(await stockAt(ctx, warehouse, 'p1')).toBe(-2)
		expect(await stockAt(ctx, warehouse === 'w1' ? 'w2' : 'w1', 'p1')).toBe(0)
		expect(await cash(ctx, 'cash')).toBe(100)
		expect(await counters()).toMatchObject({ docs: '1', stock: '1', money: '1' })
		expect(await drift(ctx)).toEqual([])
	})
	it('requires warehouse and rejects unknown fields and non-positive base quantities', async () => {
		const body = command(), { warehouseId: _, ...order } = body.order
		for (const payload of [{ contractVersion: 2, order }, { ...body, unexpected: true },
			{ ...body, order: { ...body.order, items: [{ productId: 'p1', qty: 0.000001, price: 50 }] } },
			{ ...body, order: { ...body.order, items: [{ productId: 'p1', qty: 2, price: 50, unitFactor: 1e305 }] } },
			{ ...body, order: { ...body.order, items: [{ productId: 'p1', qty: 2, price: 50, warehouseId: 'w2' }] } }]) {
			expect((await call(ctx, 'POST', '/v1/sales', payload)).statusCode).toBe(400)
		}
		expect(await counters()).toMatchObject({ docs: '0', stock: '0', money: '0' })
	})
	it('rejects missing, foreign and archived warehouses without posting', async () => {
		const foreign = await setupIntegration()
		try {
			await foreign.pool.query(`insert into warehouses (company_id,id,name) values ($1,'foreign-only','Foreign')`, [foreign.companyId])
			await ctx.pool.query(`update warehouses set deleted_at=now() where company_id=$1 and id='w2'`, [ctx.companyId])
			for (const wh of ['missing', 'foreign-only', 'w2']) {
				const result = await send(command(wh))
				expect(result.statusCode).toBe(422)
				expect(result.json().error.code).toBe('SALE_WAREHOUSE_UNAVAILABLE')
			}
			expect(await counters()).toMatchObject({ docs: '0', stock: '0', money: '0' })
		} finally { await foreign.close() }
	})
	it('identical replay survives temporary key deletion, archive and application restart', async () => {
		const body = command(), first = await send(body), before = await counters()
		expect(first.statusCode).toBe(201)
		expect((await send(body)).json()).toEqual(first.json())
		await ctx.pool.query('delete from idempotency_keys where company_id=$1', [ctx.companyId])
		await ctx.pool.query(`update warehouses set deleted_at=now() where company_id=$1 and id='w1'`, [ctx.companyId])
		// Restart the HTTP application with the same pool, token and durable database.
		const { buildApp } = await import('../../src/app.js')
		const { integrationConfig } = await import('./helpers.js')
		await ctx.app.close()
		ctx.app = await buildApp({ config: integrationConfig(), pool: ctx.pool, eventBus: null, fcm: null, metrics: null })
		const replay = await send(body)
		expect(replay.statusCode).toBe(201)
		expect(replay.headers['idempotency-replayed']).toBe('true')
		expect(replay.json()).toEqual(first.json())
		expect(await counters()).toEqual(before)
	})
	for (const expired of [false, true]) it(`rejects changed warehouse, composition, money or metadata (expired=${expired})`, async () => {
		const body = command()
		expect((await send(body)).statusCode).toBe(201)
		if (expired) await ctx.pool.query('delete from idempotency_keys where company_id=$1', [ctx.companyId])
		const before = await counters()
		for (const order of [{ ...body.order, warehouseId: 'w2' },
			{ ...body.order, items: [{ productId: 'p1', qty: 1, price: 50 }] },
			{ ...body.order, items: [{ productId: 'p1', qty: 2, price: 51 }] },
			{ ...body.order, discount: 1 }, { ...body.order, customerName: 'Changed' }]) {
			const result = await send({ ...body, order })
			expect(result.statusCode).toBe(409)
			expect(result.json().error.code).toBe('SALE_IDENTITY_CONFLICT')
			expect(await counters()).toEqual(before)
		}
	})
	it('does not replay another sale through the same temporary key', async () => {
		const key = 'shared-sale-key'
		expect((await send(command(), key)).statusCode).toBe(201)
		const before = await counters()
		expect((await send(command(), key)).statusCode).toBe(409)
		expect(await counters()).toEqual(before)
	})
	for (const sameKey of [true, false]) it(`serializes concurrent identical sale IDs (same key=${sameKey})`, async () => {
		const body = command()
		const result = await Promise.all([send(body), send(body, sameKey ? `sale-${body.order.id}` : 'second-sale-key')])
		expect(result.map(r => r.statusCode)).toEqual([201, 201])
		expect(result[0].json()).toEqual(result[1].json())
		expect(await counters()).toMatchObject({ docs: '1', stock: '1', money: '1' })
	})
	it('serializes concurrent conflicting sale IDs without extra movements', async () => {
		const body = command()
		const results = await Promise.all([send(body), send({ ...body, order: { ...body.order, warehouseId: 'w2' } }, 'conflicting-key')])
		expect(results.map(r => r.statusCode).sort()).toEqual([201, 409])
		expect(await counters()).toMatchObject({ docs: '1', stock: '1', money: '1' })
	})
	it('rolls back stock, document, proof and idempotency claim on posting error', async () => {
		// A referenced money account that does not exist fails after stock posting starts.
		await ctx.pool.query('delete from money_accounts where company_id=$1', [ctx.companyId])
		const body = command(), before = await counters()
		expect((await send(body)).statusCode).toBeGreaterThanOrEqual(400)
		expect(await counters()).toEqual(before)
		expect(await stockAt(ctx, 'w1', 'p1')).toBe(0)
		expect((await ctx.pool.query('select * from idempotency_keys where company_id=$1', [ctx.companyId])).rows).toHaveLength(0)
		await ctx.pool.query(`insert into money_accounts (company_id,id,name,kind,is_default) values ($1,'cash','Cash','cash',true)`, [ctx.companyId])
		expect((await send(body)).statusCode).toBe(201)
	})
	it('a real lost HTTP response after commit replays without new posting', async () => {
		ctx.app.addHook('onSend', async (request, reply, payload) => {
			if (request.headers['x-test-drop-response'] === '1') reply.raw.destroy()
			return payload
		})
		const body = command(), address = await ctx.app.listen({ host: '127.0.0.1', port: 0 })
		const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
			const req = httpRequest(`${address}/v1/sales`, { method: 'POST', headers: {
				authorization: `Bearer ${ctx.token}`, 'x-company-id': ctx.companyId,
				'idempotency-key': `sale-${body.order.id}`, 'content-type': 'application/json', 'x-test-drop-response': '1',
			} }, response => { response.resume(); reject(new Error('Response must be lost')) })
			req.on('error', resolve); req.end(JSON.stringify(body))
		})
		expect(error.code).toBe('ECONNRESET')
		const before = await counters(), replay = await send(body)
		expect(replay.statusCode).toBe(201)
		expect(replay.headers['idempotency-replayed']).toBe('true')
		expect(await counters()).toEqual(before)
		expect(before).toMatchObject({ docs: '1', stock: '1', money: '1' })
	})
	it('legacy default warehouse and result stay unchanged; v2 cannot adopt legacy proof', async () => {
		const body = command('w2'), key = `sale-${body.order.id}`
		const response = await call(ctx, 'POST', '/v1/sales', { order: body.order }, key)
		expect(response.statusCode).toBe(201)
		expect(response.json()).toEqual({ ok: true, order: { id: body.order.id, no: null, subtotal: 100, discount: 0, total: 100 } })
		expect(await stockAt(ctx, 'w1', 'p1')).toBe(-2)
		const before = await counters()
		expect((await send(body)).statusCode).toBe(409)
		expect(await counters()).toEqual(before)
	})
	it('returns v2 uses the actual v2 source warehouse and posts once', async () => {
		expect((await call(ctx, 'POST', '/v1/documents/post', { document: { id: randomUUID(), type: 'receive', warehouseId: 'w2', items: [{ productId: 'p1', qty: 10, cost: 7 }] } })).statusCode).toBe(201)
		const body = command('w2')
		expect((await send(body)).statusCode).toBe(201)
		const refund = { contractVersion: 2, returnId: randomUUID(), orderId: body.order.id, items: [{ saleLineId: `sale-${body.order.id}-0`, qtyBase: '1.0000' }] }
		const first = await call(ctx, 'POST', '/v1/returns', refund, `return:${refund.returnId}`)
		expect(first.statusCode).toBe(201)
		const before = await counters()
		expect((await call(ctx, 'POST', '/v1/returns', refund, `return:${refund.returnId}`)).json()).toEqual(first.json())
		expect(await counters()).toEqual(before)
		expect(await stockAt(ctx, 'w2', 'p1')).toBe(9)
		expect(await stockAt(ctx, 'w1', 'p1')).toBe(0)
		expect(await cash(ctx, 'cash')).toBe(50)
	})
	it('canonicalizes nested object keys in the fingerprint', async () => {
		const body = { ...command(), order: { ...command().order, track: [{ nested: { a: 1, b: 2 } }] } }
		const first = await send(body)
		expect(first.statusCode).toBe(201)
		expect((await send({ ...body, order: { ...body.order, track: [{ nested: { b: 2, a: 1 } }] } })).json()).toEqual(first.json())
	})
	it('corrupt proof fails closed even with an available temporary replay', async () => {
		const body = command()
		expect((await send(body)).statusCode).toBe(201)
		const before = await counters()
		await ctx.pool.query(`update docs set source_payload='{"kind":"sale-v2"}' where company_id=$1 and id=$2`, [ctx.companyId, `sale-${body.order.id}`])
		expect((await send(body)).statusCode).toBe(409)
		expect(await counters()).toEqual(before)
	})
	it('replays historical success after cancellation without posting again', async () => {
		const body = command(), first = await send(body)
		expect(first.statusCode).toBe(201)
		expect((await call(ctx, 'POST', `/v1/orders/${body.order.id}/status`, { status: 'cancelled' })).statusCode).toBe(200)
		await ctx.pool.query('delete from idempotency_keys where company_id=$1', [ctx.companyId])
		const before = await counters()
		expect((await send(body)).json()).toEqual(first.json())
		expect(await counters()).toEqual(before)
		expect(await stockAt(ctx, 'w1', 'p1')).toBe(0)
		expect(await cash(ctx, 'cash')).toBe(0)
	})
	it('does not overwrite historical status-based shipment with a new v2 sale', async () => {
		const body = command()
		await ctx.pool.query(`insert into orders (company_id,id,status,items) values ($1,$2,'packed',$3)`, [ctx.companyId, body.order.id, JSON.stringify(body.order.items)])
		// Reconstruct a pre-fence committed shipment in the isolated fixture only.
        // Production legacy shipped must remain disabled.
        const historical = await ctx.pool.connect(), docId = `ship-${body.order.id}`
        try {
          await historical.query('begin')
          await historical.query(`insert into docs(company_id,id,doc_type,warehouse_id,account_id,order_id)
            values($1,$2,'retail_receipt','w1','cash',$3)`,[ctx.companyId,docId,body.order.id])
          await historical.query(`insert into doc_lines(company_id,id,doc_id,line_no,product_id,unit_factor,qty_input,qty,price)
            values($1,$2,$3,0,'p1',1,2,2,50)`,[ctx.companyId,`${docId}-0`,docId])
          await historical.query('select post_doc($1,$2)',[ctx.companyId,docId])
          await historical.query("update orders set status='shipped',stock_consumed=true,shipment_doc_id=$3 where company_id=$1 and id=$2",[ctx.companyId,body.order.id,docId])
          await historical.query('commit')
        } catch (error) { await historical.query('rollback'); throw error }
        finally { historical.release() }
		const before = await counters()
		expect((await send(body)).statusCode).toBe(409)
		expect(await counters()).toEqual(before)
	})
})
