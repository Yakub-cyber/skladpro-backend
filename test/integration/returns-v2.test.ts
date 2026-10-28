import { legacyCustomerFixture } from './legacy-customer-fixture.js'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowSkipIntegration, call, cash, costAt, debt, drift, hasDb, setupIntegration, stockAt, type Ctx } from './helpers.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL is required for returns v2 integration tests')

describe.skipIf(!hasDb)('returns v2 — real PostgreSQL and unchanged post_doc', () => {
	let ctx: Ctx
	beforeEach(async () => { ctx = await setupIntegration() })
	afterEach(async () => { vi.restoreAllMocks(); await ctx?.close() })

	async function sale(options: { qty?: number; price?: number; discount?: number; customer?: boolean; credit?: boolean } = {}) {
		const orderId = randomUUID()
		const received = await call(ctx, 'POST', '/v1/documents/post', { document: {
			id: randomUUID(), type: 'receive', warehouseId: ctx.ids.warehouse,
			items: [{ productId: ctx.ids.product, qty: 100, cost: 7 }],
		} })
		expect(received.statusCode).toBe(201)
		const response = await call(ctx, 'POST', '/v1/sales', { order: {
			id: orderId, ...(options.customer ? { customerId: ctx.ids.customer } : {}),
			onCredit: options.credit ?? false, discount: options.discount ?? 0,
			items: [{ productId: ctx.ids.product, qty: options.qty ?? 3, price: options.price ?? 50 }],
		} })
		expect(response.statusCode).toBe(201)
		return { orderId, saleLineId: `sale-${orderId}-0` }
	}
	function command(source: { orderId: string; saleLineId: string }, qtyBase = '1') {
		return { contractVersion: 2, returnId: randomUUID(), orderId: source.orderId,
			items: [{ saleLineId: source.saleLineId, qtyBase }] }
	}
	const send = (body: ReturnType<typeof command>) => call(ctx, 'POST', '/v1/returns', body, `return:${body.returnId}`)
	async function counters() {
		const { rows } = await ctx.pool.query(`select
		 (select count(*) from docs where company_id=$1) as docs,
		 (select count(*) from stock_movements where company_id=$1) as stock,
		 (select count(*) from money_movements where company_id=$1) as money,
		 (select count(*) from settlement_movements where company_id=$1) as settlement,
		 (select count(*) from audit where company_id=$1) as audit`, [ctx.companyId])
		return rows[0]
	}

	it('two independent identical returns have distinct permanent documents and exact cost', async () => {
		const source = await sale()
		const first = await send(command(source))
		const second = await send(command(source))
		expect([first.statusCode, second.statusCode]).toEqual([201, 201])
		expect(first.json().documentId).not.toBe(second.json().documentId)
		expect(first.json().cashRefundMinor).toBe('5000')
		expect(await cash(ctx, ctx.ids.account)).toBe(50)
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(99)
		expect(await costAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toEqual({ qty: 99, costAmount: 693 })
		expect(await drift(ctx)).toEqual([])
		const history = await ctx.pool.query('select returns from orders where company_id=$1 and id=$2', [ctx.companyId, source.orderId])
		expect(history.rows[0].returns[0]).toMatchObject({ returnId: first.json().returnId, documentId: first.json().documentId,
			fingerprint: first.json().fingerprint, userId: ctx.userId, cashRefundMinor: '5000' })
	})

	it('same returnId replays the actual result; changed payload conflicts', async () => {
		const body = command(await sale())
		const first = await send(body)
		expect(first.statusCode).toBe(201)
		const before = await counters()
		const replay = await send(body)
		expect(replay.statusCode).toBe(201)
		expect(replay.headers['idempotency-replayed']).toBe('true')
		expect(replay.json()).toEqual(first.json())
		const changed = await send({ ...body, items: [{ ...body.items[0]!, qtyBase: '2' }] })
		expect(changed.statusCode).toBe(409)
		expect(changed.json().error.code).toBe('RETURN_ID_CONFLICT')
		expect(await counters()).toEqual(before)
		const changedId = await call(ctx, 'POST', '/v1/returns', { ...body, returnId: randomUUID() }, `return:${body.returnId}`)
		expect(changedId.statusCode).toBe(409)
	})

	it('replays after temporary-key cleanup without any new ledger rows', async () => {
		const body = command(await sale())
		await send(body)
		const before = await counters()
		await ctx.pool.query('delete from idempotency_keys where company_id=$1 and key=$2', [ctx.companyId, `return:${body.returnId}`])
		const replay = await send(body)
		expect(replay.statusCode).toBe(201)
		expect(replay.headers['idempotency-replayed']).toBe('true')
		expect(replay.json().returnId).toBe(body.returnId)
		expect(await counters()).toEqual(before)
		await ctx.pool.query('delete from idempotency_keys where company_id=$1 and key=$2', [ctx.companyId, `return:${body.returnId}`])
		expect((await send({ ...body, reason: 'changed' })).statusCode).toBe(409)
		const legacyOtherOrder = await sale()
		const legacy = await call(ctx, 'POST', '/v1/returns', { orderId: legacyOtherOrder.orderId,
			items: [{ productId: ctx.ids.product, qty: 1 }] }, `return:${body.returnId}`)
		expect(legacy.statusCode).toBe(409)
	})

	it('a real HTTP socket lost after commit can retry with no second posting', async () => {
		ctx.app.addHook('onSend', async (request, reply, payload) => {
			if (request.headers['x-test-drop-response'] === '1') reply.raw.destroy()
			return payload
		})
		const body = command(await sale())
		const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 })
		const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
			const req = httpRequest(`${address}/v1/returns`, { method: 'POST', headers: {
				authorization: `Bearer ${ctx.token}`, 'x-company-id': ctx.companyId,
				'idempotency-key': `return:${body.returnId}`, 'content-type': 'application/json', 'x-test-drop-response': '1',
			} }, response => { response.resume(); reject(new Error('Response should have been lost')) })
			req.on('error', resolve)
			req.end(JSON.stringify(body))
		})
		expect(error.code).toBe('ECONNRESET')
		const before = await counters()
		const replay = await send(body)
		expect(replay.statusCode).toBe(201)
		expect(replay.headers['idempotency-replayed']).toBe('true')
		expect(await counters()).toEqual(before)
		expect(await cash(ctx, ctx.ids.account)).toBe(100)
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(98)
	})

	it('concurrent identical requests post once; concurrent independent returns preserve remaining quantity', async () => {
		const source = await sale()
		const body = command(source)
		const duplicates = await Promise.all([send(body), send(body)])
		expect(duplicates.map(r => r.statusCode)).toEqual([201, 201])
		expect(duplicates.filter(r => r.headers['idempotency-replayed'] === 'true')).toHaveLength(1)
		const independent = await Promise.all([send(command(source)), send(command(source))])
		expect(independent.map(r => r.statusCode)).toEqual([201, 201])
		expect((await send(command(source))).statusCode).toBe(409)
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(100)
		expect(await cash(ctx, ctx.ids.account)).toBe(0)
		expect(await drift(ctx)).toEqual([])
	})

	it('two independent concurrent requests for the last unit cannot over-refund', async () => {
		const source = await sale({ qty: 1 })
		const responses = await Promise.all([send(command(source)), send(command(source))])
		expect(responses.map(r => r.statusCode).sort()).toEqual([201, 409])
		expect(await cash(ctx, ctx.ids.account)).toBe(0)
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(100)
		const { rows } = await ctx.pool.query("select count(*) as n from docs where company_id=$1 and doc_type='retail_return'", [ctx.companyId])
		expect(Number(rows[0].n)).toBe(1)
	})

	it('discount and cumulative rounding refund exactly the paid amount, never more', async () => {
		const source = await sale({ qty: 3, price: 0.05, discount: 0.05 })
		const refunds = []
		for (let i = 0; i < 3; i++) {
			const result = await send(command(source))
			expect(result.statusCode).toBe(201)
			refunds.push(result.json().amountMinor)
		}
		expect(refunds).toEqual(['3', '4', '3'])
		expect(await cash(ctx, ctx.ids.account)).toBe(0)
		const before = await counters()
		expect((await send(command(source))).statusCode).toBe(409)
		expect(await counters()).toEqual(before)
	})

	it('fractional base quantities and tiny net prices survive post_doc rounding', async () => {
		const source = await sale({ qty: 0.3, price: 1, discount: 0.2 })
		const amounts = []
		for (let i = 0; i < 3; i++) {
			const result = await send(command(source, '0.1'))
			expect(result.statusCode).toBe(201)
			amounts.push(result.json().amountMinor)
		}
		expect(amounts).toEqual(['3', '4', '3'])
		expect(await cash(ctx, ctx.ids.account)).toBe(0)
		expect(await drift(ctx)).toEqual([])
	})

	it('paid named customer: linked payout and goods return leave no artificial customer debt', async () => {
		const source = await sale({ customer: true, discount: 15 })
		expect(await debt(ctx, 'customer', ctx.ids.customer)).toBe(0)
		const result = await send(command(source))
		expect(result.statusCode).toBe(201)
		expect(result.json()).toMatchObject({ cashRefundMinor: '4500', debtReductionMinor: '0', paymentDocumentId: `retpay-${result.json().returnId}` })
		expect(await cash(ctx, ctx.ids.account)).toBe(90)
		expect(await debt(ctx, 'customer', ctx.ids.customer)).toBe(0)
		const before = await counters()
		await send({ ...command(source), returnId: result.json().returnId })
		expect(await counters()).toEqual(before)
		expect(await drift(ctx)).toEqual([])
	})

	it('provably unpaid credit: reduce debt, with no money movement', async () => {
		const source = await sale({ customer: true, credit: true, discount: 15 })
		const before = await counters()
		const result = await send(command(source))
		expect(result.statusCode).toBe(201)
		expect(result.json()).toMatchObject({ cashRefundMinor: '0', debtReductionMinor: '4500', paymentDocumentId: null })
		expect(await debt(ctx, 'customer', ctx.ids.customer)).toBe(90)
		expect((await counters()).money).toBe(before.money)
		expect(await drift(ctx)).toEqual([])
	})

	it('partial/unallocated payment is rejected before stock or money changes', async () => {
		const source = await sale({ customer: true, credit: true })
		expect((await legacyCustomerFixture(ctx, { amount: 10 }, undefined, ctx.ids.customer)).statusCode).toBe(201)
		const before = await counters()
		const result = await send(command(source))
		expect(result.statusCode).toBe(422)
		expect(result.json().error.code).toBe('FINANCIAL_RECONCILIATION_REQUIRED')
		expect(await counters()).toEqual(before)
	})

	it('bank/card payment is rejected without ledger writes', async () => {
		const source = await sale()
		const before = await counters()
		for (const kind of ['bank', 'card']) {
			await ctx.pool.query('update money_accounts set kind=$3 where company_id=$1 and id=$2', [ctx.companyId, ctx.ids.account, kind])
			expect((await send(command(source))).statusCode).toBe(422)
			expect(await counters()).toEqual(before)
		}
		await ctx.pool.query('delete from money_accounts where company_id=$1 and id=$2', [ctx.companyId, ctx.ids.account])
		expect((await send(command(source))).statusCode).toBe(422)
		expect(await counters()).toEqual(before)
	})

	it('missing payment proof cannot turn a credit sale into a cash payout', async () => {
		const source = await sale({ customer: true, credit: true })
		await ctx.pool.query('update orders set on_credit=false where company_id=$1 and id=$2', [ctx.companyId, source.orderId])
		const before = await counters()
		expect((await send(command(source))).statusCode).toBe(422)
		expect(await counters()).toEqual(before)
	})

	it('additional payment sources are rejected before posting any return', async () => {
		const source = await sale({ customer: true })
		const extra = `extra-${randomUUID()}`
		await ctx.pool.query(`insert into docs (company_id,id,doc_type,party_kind,party_id,account_id,order_id,amount)
		 values ($1,$2,'payment_in','customer',$3,$4,$5,1)`, [ctx.companyId, extra, ctx.ids.customer, ctx.ids.account, source.orderId])
		await ctx.pool.query('select post_doc($1,$2)', [ctx.companyId, extra])
		const before = await counters()
		expect((await send(command(source))).statusCode).toBe(422)
		expect(await counters()).toEqual(before)
	})

	it('discount allocation is stable across sale lines even with identical product IDs', async () => {
		const orderId = randomUUID()
		const response = await call(ctx, 'POST', '/v1/sales', { order: { id: orderId, discount: 0.01,
			items: [{ productId: ctx.ids.product, qty: 1, price: 0.05 }, { productId: ctx.ids.product, qty: 1, price: 0.05 }] } })
		expect(response.statusCode).toBe(201)
		const amounts = []
		for (const index of [1, 0]) {
			const result = await send(command({ orderId, saleLineId: `sale-${orderId}-${index}` }))
			expect(result.statusCode).toBe(201)
			amounts.push(result.json().amountMinor)
		}
		expect(amounts).toEqual(['4', '5'])
		expect(await cash(ctx, ctx.ids.account)).toBe(0)
		expect(await drift(ctx)).toEqual([])
	})

	it('rollback also removes the already-posted stock return if the linked payout fails', async () => {
		const source = await sale({ customer: true })
		const body = command(source)
		const before = await counters()
		const connect = ctx.pool.connect.bind(ctx.pool)
		const spy = vi.spyOn(ctx.pool, 'connect').mockImplementation((...args: any[]) => {
            // Pool.query uses the callback overload; only wrap explicit transactions.
            if (args.length) return (connect as any)(...args)
            return (async () => {
			const client = await connect()
			return new Proxy(client, { get(target, property) {
				if (property === 'query') return (...args: any[]) => {
					if (String(args[0]).startsWith('select post_doc') && args[1]?.[1] === `retpay-${body.returnId}`)
						throw new Error('TEST_PAYOUT_FAILURE')
					return (target.query as any)(...args)
				}
				const value = Reflect.get(target, property)
				return typeof value === 'function' ? value.bind(target) : value
			} })
            })()
		})
		expect((await send(body)).statusCode).toBe(500)
		spy.mockRestore()
		expect(await counters()).toEqual(before)
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(97)
		expect(await cash(ctx, ctx.ids.account)).toBe(150)
		expect(await debt(ctx, 'customer', ctx.ids.customer)).toBe(0)
		const history = await ctx.pool.query('select returns from orders where company_id=$1 and id=$2', [ctx.companyId, source.orderId])
		expect(history.rows[0].returns).toEqual([])
		expect((await send(body)).statusCode).toBe(201)
		expect(await drift(ctx)).toEqual([])
	})

	it('legacy returns are preserved; mixing v1/v2 requires reconciliation', async () => {
		const source = await sale()
		const legacy = await call(ctx, 'POST', '/v1/returns', { orderId: source.orderId, items: [{ productId: ctx.ids.product, qty: 1 }] })
		expect(legacy.statusCode).toBe(201)
		const before = await counters()
		expect((await send(command(source))).statusCode).toBe(422)
		expect(await counters()).toEqual(before)
		const next = await sale()
		expect((await send(command(next))).statusCode).toBe(201)
		const v1 = await call(ctx, 'POST', '/v1/returns', { orderId: next.orderId, items: [{ productId: ctx.ids.product, qty: 1 }] })
		expect(v1.statusCode).toBe(409)
		expect(v1.json().error.code).toBe('RETURN_V2_REQUIRED')
	})

	it('foreign saleLineId is rejected and returnId is scoped to the company', async () => {
		const source = await sale()
		const body = command(source)
		expect((await send({ ...body, items: [{ saleLineId: 'foreign-line', qtyBase: '1' }] })).statusCode).toBe(400)
		const other = await setupIntegration()
		try {
			const result = await call(other, 'POST', '/v1/returns', body, `return:${body.returnId}`)
			expect(result.statusCode).toBe(404)
			expect((await call(other, 'POST', '/v1/sales', { order: { id: source.orderId,
				items: [{ productId: other.ids.product, qty: 3, price: 50 }] } })).statusCode).toBe(201)
			expect((await send(body)).statusCode).toBe(201)
			const sameIdentity = await call(other, 'POST', '/v1/returns', body, `return:${body.returnId}`)
			expect(sameIdentity.statusCode).toBe(201)
			expect(await cash(ctx, ctx.ids.account)).toBe(100)
			expect(await cash(other, other.ids.account)).toBe(100)
			expect(sameIdentity.json().fingerprint).not.toBe((await send(body)).json().fingerprint)
		} finally { await other.close() }
	})
})
