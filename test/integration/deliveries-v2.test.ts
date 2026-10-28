import { cancelShipmentV2 } from './helpers.js'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowSkipIntegration, call, hasDb, integrationConfig, setupIntegration, type Ctx } from './helpers.js'
import { deliveryV2 } from '../../src/services/deliveriesV2.js'
import { buildApp } from '../../src/app.js'
import type { DbPool } from '../../src/db.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('delivered v2 — real PostgreSQL', () => {
  let ctx: Ctx
  beforeEach(async () => { ctx = await setupIntegration() })
  afterEach(async () => { await ctx?.close() })
  const auth = () => ({ companyId: ctx.companyId, userId: ctx.userId, role: 'admin', email: null, memberName: 'Тест', isSuperAdmin: false })
  async function prepare() {
    const orderId = randomUUID(), shipmentId = randomUUID()
    const commercial = { items: [{ lineId: 'source', productId: 'p1', unitId: 'u-sht', unitFactor: '1', qtyInput: '2', qtyBase: '2', price: '50.00' }], customerId: 'c1', customerName: 'Customer', no: null, priceTypeId: null, shiftId: null,
      subtotal: '100.00', total: '100.00', discount: { kind: 'percent', value: '0' }, rounding: 'kopeck', onCredit: true, creditTerms: null, vatSummary: null,
      payment: { method: 'credit', cashPaid: '0', cardPaid: '0', change: '0' }, address: null, geo: null, courier: null, assignedTo: null, priority: false }
    expect((await call(ctx, 'POST', '/v1/orders', { contractVersion: 2, commandId: randomUUID(), orderId, commercial })).statusCode).toBe(201)
    expect((await call(ctx, 'POST', `/v1/orders/${orderId}/status`, { status: 'picking' })).statusCode).toBe(200)
    const shipment = { contractVersion: 2, status: 'shipped', shipmentId, warehouseId: 'w1', orderSnapshot: commercial }
    const posted = await call(ctx, 'POST', `/v1/orders/${orderId}/status`, shipment, `shipment:${shipmentId}`)
    expect(posted.statusCode).toBe(200)
    return { orderId, shipment, documentId: posted.json().documentId, body: { contractVersion: 2 as const, status: 'delivered' as const, shipmentId, shipmentFingerprint: posted.json().fingerprint as string } }
  }
  type Fixture = Awaited<ReturnType<typeof prepare>>
  const deliver = (f: Fixture, body: unknown = f.body, key = `delivered:${f.body.shipmentId}`) => call(ctx, 'POST', `/v1/orders/${f.orderId}/status`, body, key)
  async function rows(table: string) {
    return (await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as rows from ${table} t where company_id=$1`, [ctx.companyId])).rows[0].rows
  }
  async function facts() {
    const out: Record<string, unknown> = {}
    for (const table of ['docs', 'doc_lines', 'stock_balances', 'stock_movements', 'money_movements', 'settlement_movements', 'customers', 'products', 'money_accounts']) out[table] = await rows(table)
    return out
  }
  async function state(f: Fixture) {
    return (await ctx.pool.query('select * from orders where company_id=$1 and id=$2', [ctx.companyId, f.orderId])).rows[0]
  }
  async function reconcile(f: Fixture) {
    return call(ctx, 'POST', '/v1/stock/reconcile', { contractVersion: 1, requestId: randomUUID(), productIds: ['p1'], commands: [{ kind: 'order_status', commandId: f.orderId, idempotencyKey: `shipment:${f.body.shipmentId}`, payload: f.shipment }] })
  }
  async function waitForLock(fragment: string) {
    for (let i = 0; i < 400; i++) {
      if ((await ctx.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like $1", [`%${fragment}%`])).rowCount) return
      await new Promise(r => setTimeout(r, 10))
    }
    throw Error(`No lock wait: ${fragment}`)
  }
  function gateCommit() {
    let release!: () => void, readyResolve!: () => void, paused = false
    const released = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { readyResolve = r })
    const pool: DbPool = { query: ctx.pool.query.bind(ctx.pool), end: ctx.pool.end.bind(ctx.pool), connect: async () => {
      const real = await ctx.pool.connect(), wrapped = Object.create(real); wrapped.release = real.release.bind(real)
      wrapped.query = (...args: any[]) => {
        if (String(args[0]).toLowerCase() === 'commit' && !paused) { paused = true; readyResolve(); return released.then(() => (real.query as any)(...args)) }
        return (real.query as any)(...args)
      }
      return wrapped
    } }
    return { pool, ready, release }
  }
  async function noWaiters() {
    expect((await ctx.pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and state='idle in transaction' and pid<>pg_backend_pid()" )).rows[0].n).toBe(0)
  }
  it('delivers once, changes only workflow fields, keeps shipment applied and generates no accounting facts', async () => {
    const f = await prepare(), before = await facts(), initial = await state(f), result = await deliver(f)
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ ok: true, contractVersion: 2, commandId: `delivered:${f.body.shipmentId}`, order: { id: f.orderId, status: 'delivered' }, shipmentId: f.body.shipmentId, documentId: f.documentId })
    const after = await state(f)
    for (const field of Object.keys(initial).filter(k => !['status', 'track', 'row_version', 'updated_at'].includes(k))) expect(after[field]).toEqual(initial[field])
    expect(after.status).toBe('delivered'); expect(after.track.length).toBe(initial.track.length + 1); expect(after.row_version).not.toBe(initial.row_version)
    expect(await facts()).toEqual(before)
    const receipts = await rows('order_lifecycle_commands'); expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ operation: 'delivered', response_status: 200, response_body: result.json(), canonical_payload: { companyId: ctx.companyId, orderId: f.orderId, ...f.body } })
    expect((await reconcile(f)).json().commands[0].resolution).toBe('applied')
    await noWaiters()
  })
  it('replays permanently after temporary cleanup and a later status change, without overwriting current state', async () => {
    const f = await prepare(), first = await deliver(f)
    for (const later of [false, true]) {
      await ctx.pool.query('delete from idempotency_keys where company_id=$1', [ctx.companyId])
      if (later) await ctx.pool.query("update orders set status='cancelled' where company_id=$1 and id=$2", [ctx.companyId, f.orderId]) // test-only inconsistent later state; no historical backfill
      const before = { facts: await facts(), order: await state(f), receipts: await rows('order_lifecycle_commands'), audit: await rows('audit') }
      const replay = await deliver(f)
      expect(replay.statusCode).toBe(first.statusCode); expect(replay.json()).toEqual(first.json()); expect(replay.headers['idempotency-replayed']).toBe('true')
      expect({ facts: await facts(), order: await state(f), receipts: await rows('order_lifecycle_commands'), audit: await rows('audit') }).toEqual(before)
    }
  })
  it('rejects changed fingerprint under the same identity and a wrong fingerprint on first delivery', async () => {
    const f = await prepare(), before = await facts()
    expect((await deliver(f, { ...f.body, shipmentFingerprint: '0'.repeat(64) })).json().error.code).toBe('DELIVERY_IDENTITY_CONFLICT')
    expect((await deliver(f)).statusCode).toBe(200)
    expect((await deliver(f, { ...f.body, shipmentFingerprint: 'f'.repeat(64) })).json().error.code).toBe('DELIVERY_IDENTITY_CONFLICT')
    expect(await facts()).toEqual(before); expect(await rows('order_lifecycle_commands')).toHaveLength(1)
  })
  it('rejects missing/foreign orders, foreign shipment and cross-order identity reuse', async () => {
    const f = await prepare(), foreign = await setupIntegration()
    try {
      expect((await call(ctx, 'POST', '/v1/orders/absent/status', f.body, `delivered:${f.body.shipmentId}`)).statusCode).toBe(404)
      expect((await call(foreign, 'POST', `/v1/orders/${f.orderId}/status`, f.body, `delivered:${f.body.shipmentId}`)).statusCode).toBe(404)
      const other = await prepare()
      expect((await deliver(f, other.body, `delivered:${other.body.shipmentId}`)).statusCode).toBe(409)
      expect((await deliver(f)).statusCode).toBe(200)
      expect((await deliver(other, f.body, `delivered:${f.body.shipmentId}`)).json().error.code).toBe('DELIVERY_IDENTITY_CONFLICT')
    } finally { await foreign.close() }
  })
  it.each(['historical', 'marker', 'unposted', 'proof', 'line', 'movement', 'balance', 'snapshot'])('fails closed for %s without changing order or ledgers', async kind => {
    const f = await prepare()
    if (kind === 'historical') await ctx.pool.query('update orders set commercial_snapshot=null where company_id=$1 and id=$2', [ctx.companyId, f.orderId])
    if (kind === 'marker') await ctx.pool.query('update orders set shipment_doc_id=null where company_id=$1 and id=$2', [ctx.companyId, f.orderId])
    if (kind === 'unposted') await ctx.pool.query('select unpost_doc($1,$2)', [ctx.companyId, f.documentId])
    if (kind === 'proof') await ctx.pool.query("update docs set source_payload='{' where company_id=$1 and id=$2", [ctx.companyId, f.documentId])
    if (kind === 'line') await ctx.pool.query('update doc_lines set qty=3 where company_id=$1 and doc_id=$2', [ctx.companyId, f.documentId])
    if (kind === 'movement') await ctx.pool.query('delete from stock_movements where company_id=$1 and doc_id=$2', [ctx.companyId, f.documentId])
    if (kind === 'balance') await ctx.pool.query('update stock_balances set qty=999 where company_id=$1 and product_id=$2', [ctx.companyId, 'p1'])
    if (kind === 'snapshot') await ctx.pool.query(`update orders set commercial_snapshot=jsonb_set(commercial_snapshot,'{customerName}','"changed"') where company_id=$1 and id=$2`, [ctx.companyId, f.orderId])
    const before = { facts: await facts(), order: await state(f), audit: await rows('audit') }
    expect((await deliver(f)).statusCode).toBe(409)
    expect({ facts: await facts(), order: await state(f), audit: await rows('audit') }).toEqual(before); expect(await rows('order_lifecycle_commands')).toEqual([])
  })
  it('blocks legacy protected delivery but preserves historical delivery and courier authorization', async () => {
    const f = await prepare()
    expect((await call(ctx, 'POST', `/v1/orders/${f.orderId}/status`, { status: 'delivered' })).json().error.code).toBe('COMMERCIAL_ORDER_REQUIRES_DELIVERY_V2')
    await ctx.pool.query(`insert into idempotency_keys(company_id,key,endpoint,status,response) values($1,'old-legacy-delivery','POST /v1/orders/status',200,$2::jsonb)`, [ctx.companyId, JSON.stringify({ ok: true, order: { id: f.orderId, status: 'delivered' } })])
    expect((await call(ctx, 'POST', `/v1/orders/${f.orderId}/status`, { status: 'delivered' }, 'old-legacy-delivery')).json().error.code).toBe('COMMERCIAL_ORDER_REQUIRES_DELIVERY_V2')
    await expect(deliveryV2(ctx.pool, { ...auth(), role: 'courier', userId: randomUUID() }, f.orderId, f.body, `delivered:${f.body.shipmentId}`)).rejects.toMatchObject({ statusCode: 403 })
    await ctx.pool.query("insert into orders(company_id,id,status) values($1,'legacy','shipped')", [ctx.companyId])
    expect((await call(ctx, 'POST', '/v1/orders/legacy/status', { status: 'delivered' })).statusCode).toBe(200)
    expect((await deliver(f)).statusCode).toBe(200)
    expect((await cancelShipmentV2(ctx,f.orderId,f.shipment)).json().error.code).toBe('DELIVERED_ORDER_CANCELLATION_FORBIDDEN')
  })
  it('concurrent identical deliveries wait on the command lock and replay exactly one receipt', async () => {
    const f = await prepare(), gate = gateCommit(), first = deliveryV2(gate.pool, auth(), f.orderId, f.body, `delivered:${f.body.shipmentId}`)
    let second: ReturnType<typeof deliver> | undefined
    try { await gate.ready; second = deliver(f); await waitForLock('pg_advisory_xact_lock'); gate.release()
      const a = await first, b = await second; expect(b.json()).toEqual(a.body); expect(b.headers['idempotency-replayed']).toBe('true'); expect(await rows('order_lifecycle_commands')).toHaveLength(1)
    } finally { gate.release(); await first; await second }
    await noWaiters()
  })
  it.each(['delivery-first', 'cancel-first'])('%s serializes delivery/cancellation without deadlock', async order => {
    const f = await prepare(), gate = gateCommit()
    let first: Promise<any>, second: Promise<any> | undefined
    if (order === 'delivery-first') first = deliveryV2(gate.pool, auth(), f.orderId, f.body, `delivered:${f.body.shipmentId}`)
    else { await ctx.app.close(); ctx.app = await buildApp({ config: integrationConfig(), pool: gate.pool, eventBus: null, fcm: null, metrics: null }); first = Promise.resolve(cancelShipmentV2(ctx,f.orderId,f.shipment)) }
    try { await gate.ready; second = order === 'delivery-first' ? Promise.resolve(cancelShipmentV2(ctx,f.orderId,f.shipment)) : deliver(f)
      await waitForLock('pg_advisory_xact_lock'); gate.release(); await first
      const rejected = await second; expect(rejected.statusCode).toBe(409)
      expect((await state(f)).status).toBe(order === 'delivery-first' ? 'delivered' : 'cancelled')
      expect(await rows('order_lifecycle_commands')).toHaveLength(1)
      expect((await rows('order_lifecycle_commands'))[0].operation).toBe(order === 'delivery-first' ? 'delivered' : 'cancelled')
    } finally { gate.release(); await first; await second }
    await noWaiters()
  })
  it('return waits for a concurrent delivery commit, then posts once; delivery replay leaves return facts untouched', async () => {
    const f = await prepare(), gate = gateCommit(), first = deliveryV2(gate.pool, auth(), f.orderId, f.body, `delivered:${f.body.shipmentId}`)
    let refund: Promise<any> | undefined
    try { await gate.ready
      const returnId = randomUUID()
      refund = Promise.resolve(call(ctx, 'POST', '/v1/returns', { contractVersion: 2, returnId, orderId: f.orderId, items: [{ saleLineId: `${f.documentId}:source`, qtyBase: '1' }] }, `return:${returnId}`))
      await waitForLock('from orders'); gate.release(); await first; expect((await refund).statusCode).toBe(201)
      const before = await facts(); expect((await deliver(f)).statusCode).toBe(200); expect(await facts()).toEqual(before)
      expect((await reconcile(f)).json().commands[0].resolution).toBe('applied')
      expect((await cancelShipmentV2(ctx,f.orderId,f.shipment)).json().error.code).toBe('SALE_HAS_POSTED_RETURNS')
    } finally { gate.release(); await first; await refund }
    await noWaiters()
  })
  it('return-first holds the tuple then rejects an undelivered sale; delivery proceeds after rollback without deadlock', async () => {
    const f = await prepare(); let release!: () => void, readyResolve!: () => void, paused = false
    const released = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { readyResolve = r })
    const pool: DbPool = { query: ctx.pool.query.bind(ctx.pool), end: ctx.pool.end.bind(ctx.pool), connect: async () => {
      const real = await ctx.pool.connect(), wrapped = Object.create(real); wrapped.release = real.release.bind(real)
      wrapped.query = async (sql: string, params?: unknown[]) => {
        const result = await real.query(sql, params)
        if (!paused && sql.includes('from orders') && sql.includes('for update')) { paused = true; readyResolve(); await released }
        return result
      }; return wrapped
    } }
    await ctx.app.close(); ctx.app = await buildApp({ config: integrationConfig(), pool, eventBus: null, fcm: null, metrics: null })
    const returnId = randomUUID(), refund = Promise.resolve(call(ctx, 'POST', '/v1/returns', { contractVersion: 2, returnId, orderId: f.orderId, items: [{ saleLineId: `${f.documentId}:source`, qtyBase: '1' }] }, `return:${returnId}`))
    let delivery: ReturnType<typeof deliver> | undefined
    const before = await facts()
    try { await ready; delivery = deliver(f); await waitForLock('from orders'); release()
      expect((await refund).statusCode).toBe(422); expect((await delivery).statusCode).toBe(200)
      expect(await facts()).toEqual(before); expect(await rows('order_lifecycle_commands')).toHaveLength(1)
    } finally { release(); await refund; await delivery }
    await noWaiters()
  })
  it('the permanent delivered receipt prevents cancellation even if a later writer changes the textual status', async () => {
    const f = await prepare(); expect((await deliver(f)).statusCode).toBe(200)
    await ctx.pool.query("update orders set status='shipped' where company_id=$1 and id=$2", [ctx.companyId, f.orderId])
    const before = await facts()
    expect((await cancelShipmentV2(ctx,f.orderId,f.shipment)).json().error.code).toBe('DELIVERED_ORDER_CANCELLATION_FORBIDDEN')
    expect(await facts()).toEqual(before)
  })
  it('a real lost HTTP response after commit replays the persistent response with no second audit or movements', async () => {
    ctx.app.addHook('onSend', async (request, reply, payload) => { if (request.headers['x-test-drop'] === '1') reply.raw.destroy(); return payload })
    const f = await prepare(), address = await ctx.app.listen({ host: '127.0.0.1', port: 0 })
    const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      const req = httpRequest(`${address}/v1/orders/${f.orderId}/status`, { method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'x-company-id': ctx.companyId, 'idempotency-key': `delivered:${f.body.shipmentId}`, 'content-type': 'application/json', 'x-test-drop': '1' } }, r => { r.resume(); reject(Error('Expected lost response')) })
      req.on('error', resolve); req.end(JSON.stringify(f.body))
    })
    expect(error.code).toBe('ECONNRESET'); const before = { facts: await facts(), order: await state(f), audit: await rows('audit') }
    const replay = await deliver(f); expect(replay.statusCode).toBe(200); expect(replay.headers['idempotency-replayed']).toBe('true')
    expect({ facts: await facts(), order: await state(f), audit: await rows('audit') }).toEqual(before)
  })
  it('rolls back workflow and receipt if persistence or audit fails', async () => {
    const f = await prepare(), before = { facts: await facts(), order: await state(f), audit: await rows('audit') }
    for (const failure of ['insert into order_lifecycle_commands', 'insert into audit']) {
      const pool: DbPool = { query: ctx.pool.query.bind(ctx.pool), end: ctx.pool.end.bind(ctx.pool), connect: async () => {
        const real = await ctx.pool.connect(), wrapped = Object.create(real); wrapped.release = real.release.bind(real)
        wrapped.query = (sql: string, params?: unknown[]) => sql.startsWith(failure) ? real.query('select 1/0') : real.query(sql, params); return wrapped
      } }
      await expect(deliveryV2(pool, auth(), f.orderId, f.body, `delivered:${f.body.shipmentId}`)).rejects.toThrow('division by zero')
      expect({ facts: await facts(), order: await state(f), audit: await rows('audit') }).toEqual(before); expect(await rows('order_lifecycle_commands')).toEqual([])
    }
  })
})
