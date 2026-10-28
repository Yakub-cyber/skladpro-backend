import { requireAssignedDelivery } from '../lib/permissions.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { withTransaction, type DbPool } from '../db.js'
import { ApiError, Errors } from '../lib/errors.js'
import type { AuthContext } from '../plugins/auth.js'
import { lockCommercialOrder } from './orderCommercial.js'
import { canonicalSale, saleFingerprint } from './salesV2.js'
import { resolveShipmentStock } from './shipmentStockProof.js'

export const DeliveryBody = z.object({
  contractVersion: z.literal(2), status: z.literal('delivered'),
  shipmentId: z.string().uuid().refine(v => v === v.toLowerCase()),
  shipmentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
const conflict = (code: string, message: string): never => { throw new ApiError(409, code, message) }

export async function deliveryV2(pool: DbPool, auth: AuthContext, orderId: string, raw: unknown, key: string) {
  const parsed = DeliveryBody.safeParse(raw)
  if (!parsed.success || !/^[\w:.-]{1,64}$/.test(orderId)) throw new ApiError(422, 'DELIVERY_INVALID', 'Некорректная команда доставки')
  const body = parsed.data, commandId = `delivered:${body.shipmentId}`
  if (key !== commandId) return conflict('DELIVERY_IDENTITY_CONFLICT', 'Idempotency-Key должен быть delivered:<shipmentId>')
  const canonical = { companyId: auth.companyId, orderId, ...body }, fingerprint = saleFingerprint(canonical)
  return withTransaction(pool, async client => {
    await client.query('set transaction isolation level read committed')
    // No temporary key is acquired while holding an order tuple. Other paths take
    // temp-key -> order; this path never waits for that key and cannot invert it.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['order-lifecycle-command', auth.companyId, commandId])])
    await lockCommercialOrder(client, auth.companyId, orderId)
    const receipt = (await client.query('select * from order_lifecycle_commands where company_id=$1 and command_id=$2', [auth.companyId, commandId])).rows[0]
    if (receipt && (receipt.operation !== 'delivered' || receipt.order_id !== orderId || receipt.fingerprint !== fingerprint || canonicalSale(receipt.canonical_payload) !== canonicalSale(canonical)))
      return conflict('DELIVERY_IDENTITY_CONFLICT', 'Идентичность доставки уже связана с другим содержимым')
    const order = (await client.query('select * from orders where company_id=$1 and id=$2 for update', [auth.companyId, orderId])).rows[0]
    if (!order) throw Errors.notFound(`Заказ ${orderId}`)
    await requireAssignedDelivery(client,auth,order.assigned_to)
    // Replay is historical: current status, catalog and posting state do not
    // cause another delivery, nor replace its initial response with current data.
    if (receipt) {
      const result = receipt.response_body
      if (receipt.response_status !== 200 || result?.ok !== true || result.contractVersion !== 2 || result.fingerprint !== fingerprint || result.commandId !== commandId || result.order?.id !== orderId || result.order.status !== 'delivered' || result.shipmentId !== body.shipmentId || result.documentId !== `shipment-${body.shipmentId}`)
        return conflict('DELIVERY_PROOF_INVALID', 'Постоянная квитанция доставки повреждена')
      return { status: receipt.response_status as number, body: result, replayed: true }
    }
    if (!order.commercial_snapshot) return conflict('DELIVERY_REQUIRES_COMMERCIAL_V2', 'Нужен защищённый коммерческий заказ')
    if (order.deleted_at || order.status !== 'shipped') return conflict('DELIVERY_STATUS_CONFLICT', 'Новая доставка разрешена только из shipped')
    const documentId = `shipment-${body.shipmentId}`
    if (order.shipment_doc_id !== documentId || !order.stock_consumed) return conflict('DELIVERY_SHIPMENT_UNVERIFIED', 'Связь с проведённой отгрузкой не подтверждена')
    // Order tuple fence is shared with returns/cancellation and direct SQL
    // posting/unposting (0027). Document locks always follow the order lock.
    const docs = (await client.query(`select id,doc_type,status,warehouse_id,order_id,party_kind,party_id,amount::text,discount::text,deleted_at,
      case when octet_length(source_payload)<=262144 then source_payload else null end as source_payload
      from docs where company_id=$1 and order_id=$2 and doc_type in ('sales_shipment','retail_receipt') for share`, [auth.companyId, orderId])).rows
    const doc = docs.find(d => d.id === documentId)
    let saved: any
    try { saved = JSON.parse(doc?.source_payload || 'null') } catch { /* fail closed below */ }
    if (!saved?.request || saved.kind !== 'shipment-v2') return conflict('DELIVERY_SHIPMENT_UNVERIFIED', 'Доказательство отгрузки отсутствует или повреждено')
    if (saved.fingerprint !== body.shipmentFingerprint) return conflict('DELIVERY_IDENTITY_CONFLICT', 'Fingerprint исходной отгрузки не совпадает')
    const { companyId: _company, orderId: _order, ...shipmentPayload } = saved.request
    const lines = (await client.query(`select id,doc_id,product_id,unit_id,qty::text,qty_input::text,unit_factor::text,price::text,amount::text,deleted_at
      from doc_lines where company_id=$1 and doc_id=$2`, [auth.companyId, documentId])).rows
    const movements = (await client.query('select id,doc_id,doc_type,warehouse_id,product_id,qty::text from stock_movements where company_id=$1 and doc_id=$2', [auth.companyId, documentId])).rows
    // This single statement compares ledger and balances in one statement
    // snapshot, including concurrent inventory at other warehouses. It never
    // compares today's net quantity with the original shipment quantity.
    const drift = (await client.query(`with ledger as (
      select warehouse_id,product_id,sum(qty) qty from stock_movements where company_id=$1 and product_id=any($2::text[]) group by warehouse_id,product_id
    ), balance as (select warehouse_id,product_id,qty from stock_balances where company_id=$1 and product_id=any($2::text[]))
    select distinct coalesce(l.product_id,b.product_id) product_id from ledger l full join balance b using(warehouse_id,product_id)
    where coalesce(l.qty,0)<>coalesce(b.qty,0)`, [auth.companyId, [...new Set(lines.map(l => l.product_id))]])).rows
    const proof = resolveShipmentStock({ commandId: orderId, idempotencyKey: `shipment:${body.shipmentId}`, payload: shipmentPayload }, auth.companyId, doc, order, docs, lines, movements, new Set<string>(drift.map(r => r.product_id)))
    if (proof.resolution !== 'applied') return conflict('DELIVERY_SHIPMENT_UNVERIFIED', `Проведение отгрузки не доказано: ${proof.reason}`)
    const deliveredAt = new Date().toISOString(), actor = auth.memberName ?? auth.email ?? auth.userId
    const updated = (await client.query(`update orders set status='delivered',track=coalesce(track,'[]'::jsonb)||$3::jsonb
      where company_id=$1 and id=$2 returning row_version::text`, [auth.companyId, orderId, JSON.stringify([{ type: 'status', to: 'delivered', at: deliveredAt, by: actor, commandId }])])).rows[0]
    const response = { ok: true, contractVersion: 2, commandId, order: { id: orderId, status: 'delivered', rowVersion: updated.row_version }, shipmentId: body.shipmentId, documentId, fingerprint, deliveredAt }
    await client.query(`insert into order_lifecycle_commands(company_id,command_id,order_id,operation,canonical_payload,fingerprint,response_status,response_body)
      values($1,$2,$3,'delivered',$4::jsonb,$5,200,$6::jsonb)`, [auth.companyId, commandId, orderId, JSON.stringify(canonical), fingerprint, JSON.stringify(response)])
    await client.query(`insert into audit(company_id,id,"by",title,section,type) values($1,$2,$3,$4,'orders','status')`, [auth.companyId, randomUUID(), actor, `Заказ ${orderId}: доставлен v2`])
    return { status: 200, body: response, replayed: false }
  })
}
