import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { mapPgError } from '../../src/lib/errors.js'
import { call, cash, debt, drift, hasDb, allowSkipIntegration, setupIntegration, stockAt, type Ctx } from './helpers.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL is required')

describe.skipIf(!hasDb)('PostgreSQL sale / return cancellation fence', () => {
	let ctx: Ctx
	beforeEach(async () => { ctx = await setupIntegration() })
	afterEach(async () => { await ctx?.close() })
	async function sale(credit = false) {
		expect((await call(ctx, 'POST', '/v1/documents/post', { document: { id: randomUUID(), type: 'receive',
			items: [{ productId: ctx.ids.product, qty: 100, cost: 7 }] } })).statusCode).toBe(201)
		const id = randomUUID()
		expect((await call(ctx, 'POST', '/v1/sales', { order: { id, ...(credit ? { customerId: ctx.ids.customer, onCredit: true } : {}),
			items: [{ productId: ctx.ids.product, qty: 3, price: 50 }] } })).statusCode).toBe(201)
		return id
	}
	async function refund(id: string, version: number) {
		const returnId = randomUUID()
		return call(ctx, 'POST', '/v1/returns', version === 2 ? { contractVersion: 2, returnId, orderId: id,
			items: [{ saleLineId: `sale-${id}-0`, qtyBase: '1.0000' }] } : { orderId: id, items: [{ productId: ctx.ids.product, qty: 1 }] },
			version === 2 ? `return:${returnId}` : randomUUID())
	}
	async function snapshot(client: Pick<pg.PoolClient, 'query'> = ctx.pool as pg.PoolClient) {
		const result: Record<string, unknown> = {}
		for (const table of ['orders', 'docs', 'doc_lines', 'stock_movements', 'money_movements', 'settlement_movements',
			'stock_balances', 'products', 'customers', 'audit', 'doc_counters', 'idempotency_keys']) {
			const { rows } = await client.query(`select to_jsonb(t) as row from ${table} t where company_id=$1 order by to_jsonb(t)::text`, [ctx.companyId])
			result[table] = rows.map(r => r.row)
		}
		return result
	}
	async function directFailure(sql: string, params: unknown[], code: string) {
		const client = await ctx.pool.connect()
		try {
			await client.query('begin')
			await expect(client.query(sql, params)).rejects.toMatchObject({ code })
		} finally { await client.query('rollback'); client.release() }
	}
	async function draft(id: string) {
		const doc = `return-${randomUUID()}`
		await ctx.pool.query(`insert into docs (company_id,id,doc_type,warehouse_id,account_id,order_id)
		 values ($1,$2,'retail_return',$3,$4,$5)`, [ctx.companyId, doc, ctx.ids.warehouse, ctx.ids.account, id])
		await ctx.pool.query(`insert into doc_lines (company_id,id,doc_id,product_id,qty_input,qty,price,cost_amount)
		 values ($1,$2,$3,$4,1,1,50,7)`, [ctx.companyId, `${doc}-0`, doc, ctx.ids.product])
		return doc
	}

	it('ordinary sale cancels and same-key replay preserves every row', async () => {
		const id = await sale(), key = randomUUID()
		const first = await call(ctx, 'POST', `/v1/orders/${id}/status`, { status: 'cancelled' }, key)
		expect(first.statusCode).toBe(200)
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(100)
		expect(await cash(ctx, ctx.ids.account)).toBe(0)
		const before = await snapshot()
		const again = await call(ctx, 'POST', `/v1/orders/${id}/status`, { status: 'cancelled' }, key)
		expect(again.statusCode).toBe(200); expect(again.json()).toEqual(first.json())
		expect(again.headers['idempotency-replayed']).toBe('true')
		expect(await snapshot()).toEqual(before)
		expect(await drift(ctx)).toEqual([])
	})
	it.each([1, 2])('partial v%s return blocks HTTP and direct SQL cancellation without changing any row', async (version) => {
		const id = await sale()
		expect((await refund(id, version)).statusCode).toBe(201)
		const before = await snapshot()
		const cancel = await call(ctx, 'POST', `/v1/orders/${id}/status`, { status: 'cancelled' })
		expect(cancel.statusCode).toBe(409); expect(cancel.json().error.code).toBe('SALE_HAS_POSTED_RETURNS')
		expect(await snapshot()).toEqual(before)
		await directFailure('select unpost_doc($1,$2)', [ctx.companyId, `sale-${id}`], 'P0010')
		expect(await snapshot()).toEqual(before)
	})
	it('credit sale and settlements are unchanged after blocked cancellation', async () => {
		const id = await sale(true)
		expect((await refund(id, 2)).statusCode).toBe(201)
		expect(await debt(ctx, 'customer', ctx.ids.customer)).toBe(100)
		const before = await snapshot()
		await directFailure('select unpost_doc($1,$2)', [ctx.companyId, `sale-${id}`], 'P0010')
		expect(await snapshot()).toEqual(before)
	})
	it('a posted return blocks cancellation even without JSON history or after soft deletion', async () => {
		const id = await sale(), doc = await draft(id)
		await ctx.pool.query('select post_doc($1,$2)', [ctx.companyId, doc])
		await ctx.pool.query('update docs set deleted_at=now() where company_id=$1 and id=$2', [ctx.companyId, doc])
		const before = await snapshot()
		const cancel = await call(ctx, 'POST', `/v1/orders/${id}/status`, { status: 'cancelled' })
		expect(cancel.statusCode).toBe(409); expect(cancel.json().error.code).toBe('SALE_HAS_POSTED_RETURNS')
		expect(await snapshot()).toEqual(before)
	})
	it('a draft return does not block a valid cancellation', async () => {
		const id = await sale(); await draft(id)
		expect((await call(ctx, 'POST', `/v1/orders/${id}/status`, { status: 'cancelled' })).statusCode).toBe(200)
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(100)
	})
	it('JSON flags alone do not prove a posted return', async () => {
		const id = await sale()
		await ctx.pool.query(`update orders set returned=true, returns='[{"contractVersion":2,"items":[]}]'::jsonb where company_id=$1 and id=$2`, [ctx.companyId, id])
		expect((await call(ctx, 'POST', `/v1/orders/${id}/status`, { status: 'cancelled' })).statusCode).toBe(200)
	})
	it.each([1, 2])('v%s HTTP return after cancellation reports SALE_NOT_POSTED and changes nothing', async version => {
		const id = await sale()
		expect((await call(ctx, 'POST', `/v1/orders/${id}/status`, { status: 'cancelled' })).statusCode).toBe(200)
		const before = await snapshot()
		const response = await refund(id, version)
		expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('SALE_NOT_POSTED')
		expect(await snapshot()).toEqual(before)
	})
	it.each(['http', 'sql'])('direct SQL return after %s cancellation is rejected before any writes', async kind => {
		const id = await sale(), doc = await draft(id)
		if (kind === 'http') expect((await call(ctx, 'POST', `/v1/orders/${id}/status`, { status: 'cancelled' })).statusCode).toBe(200)
		else await ctx.pool.query('select unpost_doc($1,$2)', [ctx.companyId, `sale-${id}`])
		const before = await snapshot()
		await directFailure('select post_doc($1,$2)', [ctx.companyId, doc], 'P0011')
		expect(await snapshot()).toEqual(before)
	})
	it('maps SQL conflicts to HTTP errors', () => {
		expect(mapPgError({ code: 'P0010', message: 'blocked' })).toMatchObject({ statusCode: 409, code: 'SALE_HAS_POSTED_RETURNS' })
		expect(mapPgError({ code: 'P0011', message: 'blocked' })).toMatchObject({ statusCode: 409, code: 'SALE_NOT_POSTED' })
	})

	async function waitBlocked(pid: number) {
		const until = Date.now() + 3000
		while (Date.now() < until) {
			const { rows } = await ctx.pool.query('select cardinality(pg_blocking_pids($1)) as n', [pid])
			if (rows[0].n > 0) return
			await new Promise(resolve => setTimeout(resolve, 10))
		}
		throw new Error('Expected the second transaction to wait for the original order')
	}
	it.each(['return-first', 'cancel-first'])('%s: direct SQL transactions serialize without deadlock', async order => {
		const id = await sale(), doc = await draft(id)
		const first = await ctx.pool.connect(), second = await ctx.pool.connect()
		try {
			for (const client of [first, second]) { await client.query('begin'); await client.query("set local statement_timeout='5s'") }
			const pid = (await second.query('select pg_backend_pid() as pid')).rows[0].pid
			const args = (name: string) => [ctx.companyId, name === 'post_doc' ? doc : `sale-${id}`]
			const firstFn = order === 'return-first' ? 'post_doc' : 'unpost_doc'
			const secondFn = order === 'return-first' ? 'unpost_doc' : 'post_doc'
			await first.query(`select ${firstFn}($1,$2)`, args(firstFn))
			const waiting = second.query(`select ${secondFn}($1,$2)`, args(secondFn)).then(() => null, error => error)
			await waitBlocked(pid)
			await first.query('commit')
			const committed = await snapshot()
			const error = await waiting
			expect(error?.code).toBe(order === 'return-first' ? 'P0010' : 'P0011')
			await second.query('rollback')
			expect(await snapshot()).toEqual(committed)
			expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(order === 'return-first' ? 98 : 100)
			expect(await cash(ctx, ctx.ids.account)).toBe(order === 'return-first' ? 100 : 0)
			expect(await drift(ctx)).toEqual([])
		} finally {
			await first.query('rollback'); await second.query('rollback'); first.release(); second.release()
		}
	})
	it.each([
		['repeatable read', 'return-first'], ['serializable', 'return-first'],
		['repeatable read', 'cancel-first'], ['serializable', 'cancel-first'],
	])('%s stale snapshot cannot bypass %s winner', async (isolation, order) => {
		const id = await sale(), doc = await draft(id), stale = await ctx.pool.connect()
		try {
			await stale.query(`begin isolation level ${isolation}`)
			await stale.query('select id from orders where company_id=$1 and id=$2', [ctx.companyId, id])
			await ctx.pool.query(`select ${order === 'return-first' ? 'post_doc' : 'unpost_doc'}($1,$2)`,
				[ctx.companyId, order === 'return-first' ? doc : `sale-${id}`])
			const before = await snapshot()
			await expect(stale.query(`select ${order === 'return-first' ? 'unpost_doc' : 'post_doc'}($1,$2)`,
				[ctx.companyId, order === 'return-first' ? `sale-${id}` : doc])).rejects.toMatchObject({ code: '40001' })
			await stale.query('rollback')
			expect(await snapshot()).toEqual(before)
		} finally { await stale.query('rollback'); stale.release() }
	})
	it.each([[1, 'return-first'], [2, 'return-first'], [1, 'cancel-first'], [2, 'cancel-first']] as const)(
		'HTTP v%s %s serializes through the original order', async (version, order) => {
			const id = await sale(), blocker = await ctx.pool.connect()
			const requests: Array<Promise<Awaited<ReturnType<typeof call>>>> = []
			try {
				await blocker.query('begin')
				await blocker.query('select id from orders where company_id=$1 and id=$2 for update', [ctx.companyId, id])
				async function waitCount(n: number) {
					const until = Date.now() + 3000
					while (Date.now() < until) {
						const { rows } = await ctx.pool.query(`select count(*)::int as n from pg_stat_activity
						 where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()`)
						if (rows[0].n >= n) return
						await new Promise(resolve => setTimeout(resolve, 10))
					}
					throw new Error('HTTP operation failed to acquire its order lock')
				}
				const cancel = () => call(ctx, 'POST', `/v1/orders/${id}/status`, { status: 'cancelled' })
				const sendReturn = () => refund(id, version)
				requests.push(order === 'return-first' ? sendReturn() : Promise.resolve(cancel()))
				await waitCount(1)
				requests.push(order === 'return-first' ? Promise.resolve(cancel()) : sendReturn())
				await waitCount(2)
				await blocker.query('commit')
				const [first, second] = await Promise.all(requests)
				expect(first!.statusCode).toBe(order === 'return-first' ? 201 : 200)
				expect(second!.statusCode).toBe(409)
				expect(second!.json().error.code).toBe(order === 'return-first' ? 'SALE_HAS_POSTED_RETURNS' : 'SALE_NOT_POSTED')
				expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(order === 'return-first' ? 98 : 100)
				expect(await cash(ctx, ctx.ids.account)).toBe(order === 'return-first' ? 100 : 0)
			} finally {
				await blocker.query('rollback'); blocker.release(); await Promise.allSettled(requests)
			}
		}, 15000)
})
