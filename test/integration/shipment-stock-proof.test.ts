import { cancelShipmentV2 } from './helpers.js'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileStock } from '../../src/services/stockReconcile.js'
import type { StockReconcileInput } from '../../src/routes/stock.js'
import { allowSkipIntegration, call, hasDb, setupIntegration, type Ctx } from './helpers.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('shipment v2 stock proof — PostgreSQL', () => {
 let ctx: Ctx
 beforeEach(async () => { ctx = await setupIntegration() })
 afterEach(async () => { await ctx?.close() })
 const snapshot = () => ({ items: [{ lineId: 'source-z', productId: 'p1', unitId: 'u-sht', unitFactor: '1', qtyInput: '2', qtyBase: '2', price: '50.00' }],
  customerId: 'c1', customerName: 'Customer', no: null, priceTypeId: null, shiftId: null, subtotal: '100.00', discount: { kind: 'percent', value: '0' },
  total: '100.00', rounding: 'kopeck', onCredit: true, creditTerms: null, payment: { method: 'credit', cashPaid: '0', cardPaid: '0', change: '0' },
  vatSummary: null, address: 'Address', geo: null, courier: null, assignedTo: null, priority: false })
 const fixture = (warehouseId = 'w1') => ({ orderId: randomUUID(), payload: {
  contractVersion: 2, status: 'shipped', shipmentId: randomUUID(), warehouseId, orderSnapshot: snapshot(),
 } })
 type Fixture = ReturnType<typeof fixture>
 async function prepare(f: Fixture) {
  expect((await call(ctx, 'POST', '/v1/orders', { contractVersion: 2, commandId: randomUUID(), orderId: f.orderId, commercial: f.payload.orderSnapshot })).statusCode).toBe(201)
  for (const status of ['confirmed', 'packed']) expect((await call(ctx, 'POST', `/v1/orders/${f.orderId}/status`, { status })).statusCode).toBe(200)
 }
 const post = (f: Fixture) => call(ctx, 'POST', `/v1/orders/${f.orderId}/status`, f.payload, `shipment:${f.payload.shipmentId}`)
 const deliver = async (f: Fixture) => {
  const saved = JSON.parse((await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2',[ctx.companyId,`shipment-${f.payload.shipmentId}`])).rows[0].source_payload)
  return call(ctx,'POST',`/v1/orders/${f.orderId}/status`,{contractVersion:2,status:'delivered',shipmentId:f.payload.shipmentId,shipmentFingerprint:saved.fingerprint},`delivered:${f.payload.shipmentId}`)
 }
 const request = (f: Fixture): StockReconcileInput => ({ contractVersion: 1, requestId: randomUUID(), productIds: ['p1'],
  commands: [{ commandId: f.orderId, kind: 'order_status', idempotencyKey: `shipment:${f.payload.shipmentId}`, payload: f.payload }] })
 const reconcile = async (f: Fixture) => {
  const response = await call(ctx, 'POST', '/v1/stock/reconcile', request(f))
  expect(response.statusCode).toBe(200)
  return response.json()
 }
 async function seed() {
  for (const [warehouseId, qty] of [['w1', 40], ['w2', 60]] as const) expect((await call(ctx, 'POST', '/v1/documents/post', {
   document: { id: randomUUID(), type: 'receive', warehouseId, items: [{ productId: 'p1', qty, cost: 7 }] },
  })).statusCode).toBe(201)
 }
 async function facts() {
  const result: Record<string, unknown> = {}
  for (const table of ['docs', 'doc_lines', 'orders', 'order_commercial_commands', 'stock_balances', 'stock_movements', 'money_movements', 'settlement_movements', 'customers', 'idempotency_keys', 'audit']) {
   result[table] = (await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as rows from ${table} t where company_id=$1`, [ctx.companyId])).rows[0].rows
  }
  return result
 }
 async function editProof(f: Fixture, edit: (saved: any) => any) {
  const id = `shipment-${f.payload.shipmentId}`
  const saved = JSON.parse((await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2', [ctx.companyId, id])).rows[0].source_payload)
  await ctx.pool.query('update docs set source_payload=$3 where company_id=$1 and id=$2', [ctx.companyId, id, JSON.stringify(edit(saved))])
 }
 async function ledgerWrite(sql: string, params: unknown[]) {
  const client = await ctx.pool.connect()
  try {
   await client.query('begin'); await client.query("select set_config('app.ledger','1',true)"); await client.query(sql, params); await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
 }
 for (const warehouse of ['w1', 'w2']) it(`proves ${warehouse}, repeated reads and TTL cleanup without writes`, async () => {
  await seed(); const f = fixture(warehouse); await prepare(f); expect((await post(f)).statusCode).toBe(200)
  await ctx.pool.query('delete from idempotency_keys where company_id=$1', [ctx.companyId])
  const before = await facts()
  for (let i = 0; i < 2; i++) {
   const response = await reconcile(f)
   expect(response.commands[0]).toMatchObject({ resolution: 'applied', effectIncluded: true, documentId: `shipment-${f.payload.shipmentId}` })
   expect(Number(response.totals[0].qtyBase)).toBe(98)
   expect(Number(response.balances.find((b: any) => b.warehouseId === warehouse).qtyBase)).toBe(warehouse === 'w1' ? 38 : 58)
  }
  expect(await facts()).toEqual(before)
 })
 it('not_observed is snapshot-local, including an unshipped protected order', async () => {
  const f = fixture(); expect((await reconcile(f)).commands[0].resolution).toBe('not_observed')
  await prepare(f); expect((await reconcile(f)).commands[0]).toMatchObject({ resolution: 'not_observed', effectIncluded: false })
  expect((await post(f)).statusCode).toBe(200); expect((await reconcile(f)).commands[0].resolution).toBe('applied')
 })
 it('keeps delivered proof but treats cancelled text without cancellation proof as ambiguous', async () => {
  const f = fixture(); await prepare(f); await post(f)
  expect((await deliver(f)).statusCode).toBe(200)
  expect((await reconcile(f)).commands[0].resolution).toBe('applied')
  await ctx.pool.query("update orders set status='cancelled' where company_id=$1 and id=$2", [ctx.companyId, f.orderId])
  const before = await facts(); expect((await reconcile(f)).commands[0].resolution).toBe('unverifiable'); expect(await facts()).toEqual(before)
 })
 for (const mode of ['cancelled', 'unposted', 'draft', 'deleted']) it(`requires permanent cancellation proof for ${mode}`, async () => {
  const f = fixture(); await prepare(f); await post(f)
  const id = `shipment-${f.payload.shipmentId}`
  if (mode === 'cancelled') expect((await cancelShipmentV2(ctx,f.orderId,f.payload)).statusCode).toBe(200)
  if (mode === 'unposted') await ctx.pool.query('select unpost_doc($1,$2)', [ctx.companyId, id])
  if (mode === 'draft') await ctx.pool.query("update docs set status='draft' where company_id=$1 and id=$2", [ctx.companyId, id])
  if (mode === 'deleted') await ctx.pool.query('update docs set deleted_at=now() where company_id=$1 and id=$2', [ctx.companyId, id])
  const before = await facts(); expect((await reconcile(f)).commands[0]).toMatchObject(mode === 'cancelled' ? {resolution:'reversed',effectIncluded:false,reason:'PERSISTENT_SHIPMENT_V2_CANCELLATION_PROOF'} : { resolution: 'unverifiable', effectIncluded: null, reason: 'SHIPMENT_REVERSAL_NOT_PROVEN' }); expect(await facts()).toEqual(before)
 })
 for (const field of ['warehouseId', 'shipmentId', 'orderId', 'orderSnapshot', 'key']) it(`detects ${field} identity conflict`, async () => {
  const f = fixture(); await prepare(f); await post(f)
  const changed = structuredClone(f)
  if (field === 'warehouseId') changed.payload.warehouseId = 'w2'
  if (field === 'shipmentId') changed.payload.shipmentId = randomUUID()
  if (field === 'orderId') changed.orderId = randomUUID()
  if (field === 'orderSnapshot') changed.payload.orderSnapshot.address = 'Changed'
  const body = request(changed); if (field === 'key') body.commands[0]!.idempotencyKey = 'other-key'
  const before = await facts(), response = await call(ctx, 'POST', '/v1/stock/reconcile', body)
  expect(response.statusCode).toBe(200); expect(response.json().commands[0]).toMatchObject({ resolution: 'conflict', effectIncluded: null }); expect(await facts()).toEqual(before)
 })
 for (const defect of ['fingerprint', 'request', 'json', 'missing', 'result', 'oversized']) it(`fails closed for ${defect} proof`, async () => {
  const f = fixture(); await prepare(f); await post(f)
  const id = `shipment-${f.payload.shipmentId}`
  if (defect === 'json' || defect === 'missing' || defect === 'oversized') await ctx.pool.query('update docs set source_payload=$3 where company_id=$1 and id=$2',
   [ctx.companyId, id, defect === 'json' ? '{' : defect === 'missing' ? null : ' '.repeat(262145)])
  else await editProof(f, s => { if (defect === 'fingerprint') s.fingerprint = '0'.repeat(64); else if (defect === 'request') s.request.warehouseId = 'w2'; else s.result.items = []; return s })
  const before = await facts(); expect((await reconcile(f)).commands[0]).toMatchObject({ resolution: 'unverifiable', effectIncluded: null }); expect(await facts()).toEqual(before)
 })
 for (const defect of ['warehouse', 'line', 'link', 'order-snapshot', 'duplicate-source']) it(`rejects inconsistent ${defect} evidence`, async () => {
  const f = fixture(); await prepare(f); await post(f); const id = `shipment-${f.payload.shipmentId}`
  if (defect === 'warehouse') await ctx.pool.query("update docs set warehouse_id='w2' where company_id=$1 and id=$2", [ctx.companyId, id])
  if (defect === 'line') await ctx.pool.query('update doc_lines set qty=3 where company_id=$1 and doc_id=$2', [ctx.companyId, id])
  if (defect === 'link') await ctx.pool.query('update orders set shipment_doc_id=null where company_id=$1 and id=$2', [ctx.companyId, f.orderId])
  if (defect === 'order-snapshot') await ctx.pool.query(`update orders set commercial_snapshot=jsonb_set(commercial_snapshot,'{address}','"Other"') where company_id=$1 and id=$2`, [ctx.companyId, f.orderId])
  if (defect === 'duplicate-source') await ctx.pool.query("insert into docs(company_id,id,doc_type,order_id,warehouse_id) values($1,'other-source','sales_shipment',$2,'w1')", [ctx.companyId, f.orderId])
  const before = await facts(), resolution = (await reconcile(f)).commands[0].resolution
  expect(resolution).toBe(['warehouse', 'line'].includes(defect) ? 'conflict' : 'unverifiable'); expect(await facts()).toEqual(before)
 })
 for (const defect of ['missing', 'qty', 'warehouse']) it(`cannot apply ${defect} stock movement`, async () => {
  const f = fixture(); await prepare(f); await post(f); const id = `shipment-${f.payload.shipmentId}`
  await ledgerWrite(defect === 'missing' ? 'delete from stock_movements where company_id=$1 and doc_id=$2' :
   defect === 'qty' ? 'update stock_movements set qty=-3 where company_id=$1 and doc_id=$2' :
    "update stock_movements set warehouse_id='w2' where company_id=$1 and doc_id=$2", [ctx.companyId, id])
  const before = await facts(); expect((await reconcile(f)).commands[0]).toMatchObject({ resolution: 'unverifiable', effectIncluded: null }); expect(await facts()).toEqual(before)
 })
 for (const warehouse of ['w1', 'w2']) it(`rejects balance drift in ${warehouse}, including other warehouse of affected product`, async () => {
  await seed(); const f = fixture(); await prepare(f); await post(f)
  await ledgerWrite('update stock_balances set qty=qty+1 where company_id=$1 and warehouse_id=$2 and product_id=$3', [ctx.companyId, warehouse, 'p1'])
  const before = await facts(); expect((await reconcile(f)).commands[0]).toMatchObject({ resolution: 'unverifiable', reason: 'SHIPMENT_BALANCE_LEDGER_MISMATCH' }); expect(await facts()).toEqual(before)
 })
 it('does not call a missing document not_observed when a marker or orphaned effect remains', async () => {
  const f = fixture(); await prepare(f); await post(f)
  await ctx.pool.query('delete from docs where company_id=$1 and id=$2', [ctx.companyId, `shipment-${f.payload.shipmentId}`])
  expect((await reconcile(f)).commands[0]).toMatchObject({ resolution: 'unverifiable', effectIncluded: null })
 })
 it('matches duplicate-product packaging lines by source ID, not execution positions', async () => {
  const f = fixture(); f.payload.orderSnapshot.items.push({ lineId: 'source-a', productId: 'p1', unitId: 'u-pack', unitFactor: '12', qtyInput: '0.5', qtyBase: '6', price: '10.00' })
  f.payload.orderSnapshot.subtotal = f.payload.orderSnapshot.total = '160.00'
  await prepare(f); expect((await post(f)).statusCode).toBe(200); expect((await reconcile(f)).commands[0].resolution).toBe('applied')
 })
 it('retains shipment effect proof after a return changes net balance', async () => {
  await seed(); const f = fixture(); await prepare(f); const shipped = await post(f)
  await deliver(f)
  const returnId = randomUUID(); expect((await call(ctx, 'POST', '/v1/returns', { contractVersion: 2, returnId, orderId: f.orderId,
   items: [{ saleLineId: shipped.json().items[0].saleLineId, qtyBase: '1' }] }, `return:${returnId}`)).statusCode).toBe(201)
  const before = await facts(), response = await reconcile(f); expect(response.commands[0].resolution).toBe('applied'); expect(Number(response.totals[0].qtyBase)).toBe(99); expect(await facts()).toEqual(before)
 })
 it('reconciles a real lost HTTP response after commit without writing any receipts', async () => {
  ctx.app.addHook('onSend', async (req, reply, data) => { if (req.headers['x-drop'] === '1') reply.raw.destroy(); return data })
  const f = fixture(); await prepare(f); const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 })
  const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
   const req = httpRequest(`${address}/v1/orders/${f.orderId}/status`, { method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'x-company-id': ctx.companyId,
    'idempotency-key': `shipment:${f.payload.shipmentId}`, 'content-type': 'application/json', 'x-drop': '1' } }, res => { res.resume(); reject(new Error('Expected connection loss')) })
   req.on('error', resolve); req.end(JSON.stringify(f.payload))
  })
  expect(error.code).toBe('ECONNRESET'); const before = await facts(); expect((await reconcile(f)).commands[0].resolution).toBe('applied'); expect(await facts()).toEqual(before)
 })
 for (const transition of ['post', 'cancel']) it(`keeps one read-only snapshot across a concurrent ${transition} commit`, async () => {
  await seed(); const f = fixture(); await prepare(f); if (transition === 'cancel') await post(f)
  const client = await ctx.pool.connect(); let committed = false, checked = false
  const query = async (sql: string, values?: any[]) => {
   const result = await client.query(sql, values)
   if (sql.startsWith('select warehouse_id as') && !committed) {
    expect((await client.query('show transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read')
    expect((await client.query('show transaction_read_only')).rows[0].transaction_read_only).toBe('on'); checked = true
    committed = true
    expect((transition === 'post' ? await post(f) : await cancelShipmentV2(ctx,f.orderId,f.payload)).statusCode).toBe(200)
   }
   return result
  }
  try {
   const before = await reconcileStock({ ...ctx.pool, connect: async () => ({ query, release: () => {} }) } as any, ctx.companyId, request(f))
   expect(committed && checked).toBe(true)
   expect(Number(before.totals[0]!.qtyBase)).toBe(transition === 'post' ? 100 : 98)
   expect(before.commands[0]!.resolution).toBe(transition === 'post' ? 'not_observed' : 'applied')
   const after = await reconcile(f)
   expect(Number(after.totals[0].qtyBase)).toBe(transition === 'post' ? 98 : 100)
   expect(after.commands[0].resolution).toBe(transition === 'post' ? 'applied' : 'reversed')
  } finally { client.release() }
 })
 it('preserves legacy command behavior and rejects incomplete nested product scope', async () => {
  const f = fixture(); await prepare(f)
  const legacy = request(f); legacy.commands[0]!.payload = { orderId: f.orderId, status: 'shipped' }
  expect((await call(ctx, 'POST', '/v1/stock/reconcile', legacy)).json().commands[0].resolution).toBe('unverifiable')
  f.payload.orderSnapshot.items.push({ ...f.payload.orderSnapshot.items[0]!, lineId: 'outside', productId: 'outside' })
  expect((await call(ctx, 'POST', '/v1/stock/reconcile', request(f))).json().error.code).toBe('STOCK_SCOPE_INCOMPLETE')
 })
 it('isolates proof across companies and rejects foreign company access', async () => {
  const f = fixture(), foreign = await setupIntegration()
  try {
   await call(foreign, 'POST', '/v1/orders', { contractVersion: 2, commandId: randomUUID(), orderId: f.orderId, commercial: f.payload.orderSnapshot })
   for (const status of ['confirmed', 'packed']) await call(foreign, 'POST', `/v1/orders/${f.orderId}/status`, { status })
   expect((await call(foreign, 'POST', `/v1/orders/${f.orderId}/status`, f.payload, `shipment:${f.payload.shipmentId}`)).statusCode).toBe(200)
   expect((await reconcile(f)).commands[0].resolution).toBe('not_observed')
   expect((await ctx.app.inject({ method: 'POST', url: '/v1/stock/reconcile', payload: request(f), headers: { authorization: `Bearer ${ctx.token}`, 'x-company-id': foreign.companyId } })).statusCode).toBe(403)
  } finally { await foreign.close() }
 })
})
