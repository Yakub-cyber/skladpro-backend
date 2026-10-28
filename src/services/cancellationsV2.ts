import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { withTransaction, type DbPool } from '../db.js'
import { ApiError, Errors } from '../lib/errors.js'
import type { AuthContext } from '../plugins/auth.js'
import { lockCommercialOrder } from './orderCommercial.js'
import { lockCustomerFinances } from './customerFinance.js'
import { canonicalSale, saleFingerprint } from './salesV2.js'
import { resolveShipmentStock } from './shipmentStockProof.js'

export const CancellationBody = z.object({
  contractVersion: z.literal(2), status: z.literal('cancelled'),
  shipmentId: z.string().uuid().refine(v => v === v.toLowerCase()),
  shipmentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
type Body = z.infer<typeof CancellationBody>
const conflict = (code: string, message: string): never => { throw new ApiError(409, code, message) }
const reconcile = (reason: string): never => { throw new ApiError(409, 'CANCELLATION_RECONCILIATION_REQUIRED', 'Отмена требует сверки', { reason }) }
const unsupported = (reason: string): never => { throw new ApiError(422, 'CANCELLATION_FINANCIAL_RECONCILIATION_REQUIRED', 'Отмена требует финансовой сверки; распределение платежей не выполняется', { reason }) }
const hashText = (s: string) => createHash('sha256').update(s).digest('hex')
const decimal = (v: unknown, scale = 4): bigint => {
  if (typeof v !== 'string' || !/^-?\d{1,20}(\.\d{1,4})?$/.test(v)) return reconcile('INVALID_MANIFEST_DECIMAL')
  const [whole = '0', fraction = ''] = v.replace('-', '').split('.')
  if (/[1-9]/.test(fraction.slice(scale))) return reconcile('INVALID_MANIFEST_PRECISION')
  return (BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.slice(0, scale).padEnd(scale, '0'))) * (v.startsWith('-') ? -1n : 1n)
}
const fixed = (v: bigint, scale = 4) => { const p = 10n ** BigInt(scale); return `${v / p}.${(v % p).toString().padStart(scale, '0')}` }
const ordered = (rows: any[]) => [...rows].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Validate the immutable captured source effect, not today's order status/balance.
// Reused for stored receipt integrity without making historical replay execute SQL.
function validateManifest(m: any, companyId: string, orderId: string, body: Body) {
  const documentId = `shipment-${body.shipmentId}`
  if (!m || m.version !== 1 || m.companyId !== companyId || m.orderId !== orderId ||
    m.shipmentId !== body.shipmentId || m.shipmentFingerprint !== body.shipmentFingerprint ||
    !m.document || m.document.company_id !== companyId || m.document.id !== documentId ||
    typeof m.document.source_payload !== 'string' || Buffer.byteLength(m.document.source_payload) > 262144 ||
    !Array.isArray(m.lines) || !m.lines.length || m.lines.length > 500 ||
    !Array.isArray(m.stockMovements) || !Array.isArray(m.settlementMovements) ||
    !Array.isArray(m.moneyMovements) || m.moneyMovements.length) return reconcile('MANIFEST_IDENTITY')
  let saved: any
  try { saved = JSON.parse(m.document.source_payload) } catch { return reconcile('SHIPMENT_PROOF_CORRUPT') }
  if (saved?.kind !== 'shipment-v2' || !saved.request || saved.fingerprint !== body.shipmentFingerprint) return reconcile('SHIPMENT_PROOF_CORRUPT')
  const { companyId: _company, orderId: _order, ...payload } = saved.request
  const originalOrder = { deleted_at: null, stock_consumed: true, shipment_doc_id: documentId, commercial_snapshot: saved.request.orderSnapshot }
  const proof = resolveShipmentStock({ commandId: orderId, idempotencyKey: `shipment:${body.shipmentId}`, payload },
    companyId, m.document, originalOrder, [m.document], m.lines, m.stockMovements, new Set())
  if (proof.resolution !== 'applied') return reconcile(proof.reason)
  const snapshot = saved.request.orderSnapshot
  if (!snapshot.onCredit || snapshot.payment.method !== 'credit' || !snapshot.customerId || snapshot.customerId === 'retail' ||
    decimal(snapshot.discount.value) !== 0n || decimal(snapshot.payment.cashPaid) !== 0n || decimal(snapshot.payment.cardPaid) !== 0n ||
    decimal(snapshot.payment.change) !== 0n || snapshot.creditTerms !== null || snapshot.vatSummary !== null) return unsupported('ONLY_UNPAID_CUSTOMER_CREDIT_SUPPORTED')
  const total = decimal(m.document.amount, 2)
  if (total <= 0n || saved.result.cashReceivedMinor !== '0' || saved.result.debtCreatedMinor !== total.toString()) return reconcile('SOURCE_DEBT_RESULT')
  for (const rows of [m.lines, m.stockMovements, m.settlementMovements]) {
    if (new Set(rows.map((r: any) => r.id)).size !== rows.length || rows.some((r: any) => r.company_id !== companyId || r.doc_id !== documentId) || canonicalSale(rows) !== canonicalSale(ordered(rows))) return reconcile('MANIFEST_ROWS')
  }
  const lines = new Map<string, any>(m.lines.map((l: any) => [l.id, l]))
  const bySource = new Map<string, string>(saved.result.items.map((l: any) => [l.documentLineId, l.sourceLineId]))
  const restoredItems = m.stockMovements.map((movement: any) => {
    const line = lines.get(movement.id), qty = decimal(movement.qty), cost = decimal(movement.cost_amount)
    if (!line || qty >= 0n || cost > 0n || decimal(line.cost_amount) !== -cost) return reconcile('SOURCE_COST_MISMATCH')
    return { sourceLineId: bySource.get(line.id), documentLineId: line.id, productId: line.product_id,
      warehouseId: movement.warehouse_id, qtyBase: fixed(-qty), costAmount: fixed(-cost) }
  })
  const settlement = m.settlementMovements[0]
  if (m.settlementMovements.length !== 1 || settlement.id !== `${documentId}:settle` || settlement.doc_type !== 'sales_shipment' ||
    settlement.party_kind !== 'customer' || settlement.party_id !== snapshot.customerId || decimal(settlement.amount, 2) !== total) return reconcile('SOURCE_SETTLEMENT_MISMATCH')
  return { warehouseId: m.document.warehouse_id as string, customerId: snapshot.customerId as string,
    amount: m.document.amount as string, debtRemovedMinor: total.toString(), restoredItems, payload,
    sourcePayloadHash: hashText(m.document.source_payload), sourceLinesHash: saleFingerprint(m.lines) }
}

function replayResult(receipt: any, canonical: any, fingerprint: string, body: Body, companyId: string, orderId: string) {
  if (receipt.operation !== 'cancelled' || receipt.fingerprint !== saleFingerprint(receipt.canonical_payload)) return conflict('CANCELLATION_PROOF_INVALID', 'Постоянная квитанция отмены повреждена')
  if (receipt.order_id !== orderId || receipt.fingerprint !== fingerprint || canonicalSale(receipt.canonical_payload) !== canonicalSale(canonical)) return conflict('CANCELLATION_IDENTITY_CONFLICT', 'Идентичность отмены связана с другим содержимым')
  try {
    const r = receipt.response_body, e = r?.evidence
    if (receipt.response_status !== 200 || r?.ok !== true || r.contractVersion !== 2 || r.commandId !== `cancelled:${body.shipmentId}` ||
      r.fingerprint !== fingerprint || r.shipmentId !== body.shipmentId || r.shipmentFingerprint !== body.shipmentFingerprint ||
      r.documentId !== `shipment-${body.shipmentId}` || r.documentStatus !== 'void' || r.order?.id !== orderId || r.order.status !== 'cancelled' ||
      typeof r.order.rowVersion !== 'string' || !/^\d+$/.test(r.order.rowVersion) || typeof r.cancelledAt !== 'string' || !Number.isFinite(Date.parse(r.cancelledAt)) ||
      e?.version !== 1 || e.manifestHash !== saleFingerprint(e.manifest) || e.documentStatus !== 'void' || e.remainingSourceMovements !== 0 || r.cashRefundedMinor !== '0') throw Error('Invalid receipt')
    const derived = validateManifest(e.manifest, companyId, orderId, body)
    if (r.warehouseId !== derived.warehouseId || r.amount !== derived.amount || r.debtRemovedMinor !== derived.debtRemovedMinor ||
      canonicalSale(r.restoredItems) !== canonicalSale(derived.restoredItems) || e.sourcePayloadHash !== derived.sourcePayloadHash || e.sourceLinesHash !== derived.sourceLinesHash ||
      canonicalSale(e.removed) !== canonicalSale({ stockIds: e.manifest.stockMovements.map((m: any) => m.id), settlementIds: e.manifest.settlementMovements.map((m: any) => m.id), moneyIds: [] })) throw Error('Invalid evidence')
    return { status: receipt.response_status as number, body: r, replayed: true }
  } catch { return conflict('CANCELLATION_PROOF_INVALID', 'Постоянное доказательство отмены требует сверки') }
}

/** Pure persisted-receipt validation for read-only reconciliation. No SQL or replay writes. */
export function verifyCancellationReceipt(receipt: unknown, companyId: string, orderId: string, body: Body) {
  const canonical = {companyId,orderId,...body}
  return replayResult(receipt,canonical,saleFingerprint(canonical),body,companyId,orderId).body
}

async function driftProducts(client: any, companyId: string, productIds: string[]) {
  return (await client.query(`with ledger as (
    select warehouse_id,product_id,sum(qty) qty,sum(cost_amount) cost from stock_movements where company_id=$1 and product_id=any($2::text[]) group by warehouse_id,product_id
  ), balance as (select warehouse_id,product_id,qty,cost_amount cost from stock_balances where company_id=$1 and product_id=any($2::text[]))
  select distinct coalesce(l.product_id,b.product_id) product_id from ledger l full join balance b using(warehouse_id,product_id)
  where coalesce(l.qty,0)<>coalesce(b.qty,0) or coalesce(l.cost,0)<>coalesce(b.cost,0)`, [companyId,productIds])).rows
}
async function customerDebt(client: any, companyId: string, customerId: string) {
  const r = (await client.query(`select c.balance::text mirror,
    (select coalesce(sum(amount),0)::text from settlement_movements where company_id=$1 and party_kind='customer' and party_id=$2) ledger
    from customers c where c.company_id=$1 and c.id=$2`, [companyId,customerId])).rows[0]
  if (!r || decimal(r.mirror,2) !== decimal(r.ledger,2)) return reconcile('CUSTOMER_DEBT_LEDGER_MISMATCH')
  return decimal(r.ledger,2)
}
const lineSql = `select company_id::text,id,doc_id,product_id,unit_id,qty::text,qty_input::text,unit_factor::text,
  price::text,amount::text,cost_amount::text,deleted_at from doc_lines where company_id=$1 and doc_id=$2 order by id`

export async function cancellationV2(pool: DbPool, auth: AuthContext, orderId: string, raw: unknown, key: string) {
  if (auth.role === 'courier') throw Errors.forbidden('Курьеру отмена недоступна')
  const parsed = CancellationBody.safeParse(raw)
  if (!parsed.success || !/^[\w:.-]{1,64}$/.test(orderId)) throw new ApiError(422,'CANCELLATION_INVALID','Некорректная команда отмены')
  const body = parsed.data, commandId = `cancelled:${body.shipmentId}`, documentId = `shipment-${body.shipmentId}`
  if (key !== commandId) return conflict('CANCELLATION_IDENTITY_CONFLICT','Idempotency-Key должен быть cancelled:<shipmentId>')
  const canonical = { companyId: auth.companyId, orderId, ...body }, fingerprint = saleFingerprint(canonical), company = auth.companyId
  for (let attempt = 0; ; attempt++) {
    let unpostStarted = false
    try { return await withTransaction(pool, async client => {
      await client.query('set transaction isolation level read committed')
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['order-lifecycle-command',company,commandId])])
      await lockCommercialOrder(client,company,orderId)
      const receipt = (await client.query('select * from order_lifecycle_commands where company_id=$1 and command_id=$2',[company,commandId])).rows[0]
      if (receipt) return replayResult(receipt,canonical,fingerprint,body,company,orderId)
      const order = (await client.query('select * from orders where company_id=$1 and id=$2 for update',[company,orderId])).rows[0]
      if (!order) throw Errors.notFound(`Заказ ${orderId}`)
      if ((await client.query("select 1 from order_lifecycle_commands where company_id=$1 and order_id=$2 and operation='cancelled'",[company,orderId])).rowCount) return reconcile('ORDER_ALREADY_HAS_CANCELLATION_PROOF')
      if (!order.commercial_snapshot) return conflict('CANCELLATION_REQUIRES_COMMERCIAL_V2','Нужен защищённый коммерческий заказ')
      const returns = await client.query(`select 1 from docs r where r.company_id=$1 and r.order_id=$2
        and r.doc_type in ('sales_return','retail_return') and (r.status='posted'
        or exists(select 1 from stock_movements m where m.company_id=$1 and m.doc_id=r.id)
        or exists(select 1 from money_movements m where m.company_id=$1 and m.doc_id=r.id)
        or exists(select 1 from settlement_movements m where m.company_id=$1 and m.doc_id=r.id)) limit 1`,[company,orderId])
      if (returns.rowCount) throw Errors.saleHasPostedReturns()
      if (order.status === 'delivered' || (await client.query("select 1 from order_lifecycle_commands where company_id=$1 and order_id=$2 and operation='delivered'",[company,orderId])).rowCount)
        return conflict('DELIVERED_ORDER_CANCELLATION_FORBIDDEN','Доставленный заказ отменять нельзя; оформите возврат')
      if (order.deleted_at || order.status !== 'shipped') return conflict('CANCELLATION_STATUS_CONFLICT','Новая отмена разрешена только из shipped')
      if (order.shipment_doc_id !== documentId || !order.stock_consumed) return reconcile('SHIPMENT_LINK_INVALID')
      const party = (await client.query('select party_kind,party_id from docs where company_id=$1 and id=$2',[company,documentId])).rows[0]
      const parties = [order.customer_id,order.commercial_snapshot.customerId,party?.party_kind === 'customer' ? party.party_id : null]
      if (parties.some(id => id != null && (typeof id !== 'string' || !/^[\w:.-]{1,64}$/.test(id)))) return reconcile('CUSTOMER_IDENTITY_INVALID')
      await lockCustomerFinances(client,company,parties)
      const docs = (await client.query(`select company_id::text,id,doc_type,status,warehouse_id,order_id,party_kind,party_id,amount::text,discount::text,deleted_at,
        case when octet_length(source_payload)<=262144 then source_payload else null end source_payload
        from docs where company_id=$1 and (id=$3 or (order_id=$2 and doc_type in ('sales_shipment','retail_receipt'))) order by id for update`,[company,orderId,documentId])).rows
      const doc = docs.find(d => d.id === documentId)
      if (!doc || doc.status !== 'posted' || doc.deleted_at || docs.length !== 1) return reconcile('SHIPMENT_NOT_POSTED_OR_AMBIGUOUS')
      const lines = (await client.query(lineSql,[company,documentId])).rows
      const stock = (await client.query('select company_id::text,id,doc_id,doc_type,at::text,warehouse_id,product_id,qty::text,cost_amount::text,updated_at::text from stock_movements where company_id=$1 and doc_id=$2 order by id',[company,documentId])).rows
      const settlement = (await client.query('select company_id::text,id,doc_id,doc_type,at::text,party_kind,party_id,amount::text,updated_at::text from settlement_movements where company_id=$1 and doc_id=$2 order by id',[company,documentId])).rows
      const money = (await client.query('select id from money_movements where company_id=$1 and doc_id=$2',[company,documentId])).rows
      const manifest = { version: 1, companyId: company, orderId, shipmentId: body.shipmentId, shipmentFingerprint: body.shipmentFingerprint, document: doc, lines, stockMovements: stock, settlementMovements: settlement, moneyMovements: money }
      const derived = validateManifest(manifest,company,orderId,body)
      if (order.customer_id !== derived.customerId || canonicalSale(order.commercial_snapshot) !== canonicalSale(JSON.parse(doc.source_payload!).request.orderSnapshot)) return reconcile('ORDER_COMMERCIAL_LINK')
      const products = [...new Set(lines.map(l => l.product_id))]
      if ((await driftProducts(client,company,products)).length) return reconcile('STOCK_BALANCE_LEDGER_MISMATCH')
      const financial = await client.query(`select 1 where exists (
        select 1 from docs d where d.company_id=$1 and d.id<>$3
        and (d.order_id=$2 or d.id=$4 or (d.party_kind='customer' and d.party_id=$5))
        and (d.doc_type in ('payment_in','payment_out','opening_settlement') or exists(select 1 from money_movements m where m.company_id=$1 and m.doc_id=d.id))
        and (d.status='posted' or exists(select 1 from money_movements m where m.company_id=$1 and m.doc_id=d.id) or exists(select 1 from settlement_movements m where m.company_id=$1 and m.doc_id=d.id))
      ) or exists (
        select 1 from settlement_movements m where m.company_id=$1 and m.party_kind='customer' and m.party_id=$5 and m.doc_id<>$3
        and (m.amount<0 or m.doc_type<>'sales_shipment' or not exists(select 1 from docs d where d.company_id=$1 and d.id=m.doc_id and d.status='posted' and d.doc_type=m.doc_type and d.party_kind='customer' and d.party_id=$5))
      )`,[company,orderId,documentId,`pay-${orderId}`,derived.customerId])
      if (financial.rowCount) return unsupported('PAYMENT_PREPAYMENT_OR_CUSTOMER_ADJUSTMENT')
      const beforeDebt = await customerDebt(client,company,derived.customerId)
      // Exactly one unpost for a new operation. Replays return above this point.
      unpostStarted = true
      await client.query('select unpost_doc($1,$2)',[company,documentId])
      const afterDoc = (await client.query('select status,posted_at,source_payload from docs where company_id=$1 and id=$2',[company,documentId])).rows[0]
      const remaining = (await client.query(`select
        (select count(*) from stock_movements where company_id=$1 and doc_id=$2)+
        (select count(*) from settlement_movements where company_id=$1 and doc_id=$2)+
        (select count(*) from money_movements where company_id=$1 and doc_id=$2) n`,[company,documentId])).rows[0].n
      if (!afterDoc || afterDoc.status !== 'draft' || afterDoc.posted_at !== null || afterDoc.source_payload !== doc.source_payload || Number(remaining) !== 0 ||
        saleFingerprint((await client.query(lineSql,[company,documentId])).rows) !== derived.sourceLinesHash) return reconcile('UNPOST_RESULT_INVALID')
      if ((await driftProducts(client,company,products)).length || (await customerDebt(client,company,derived.customerId)) !== beforeDebt-BigInt(derived.debtRemovedMinor)) return reconcile('RESTORATION_LEDGER_MISMATCH')
      const voided = await client.query("update docs set status='void' where company_id=$1 and id=$2 and status='draft' returning status",[company,documentId])
      if (voided.rowCount !== 1 || voided.rows[0].status !== 'void') return reconcile('VOID_RESULT_INVALID')
      const cancelledAt = new Date().toISOString(), actor = auth.memberName ?? auth.email ?? auth.userId
      const updated = (await client.query(`update orders set status='cancelled',stock_consumed=false,track=coalesce(track,'[]'::jsonb)||$3::jsonb
        where company_id=$1 and id=$2 returning row_version::text`,[company,orderId,JSON.stringify([{type:'status',to:'cancelled',at:cancelledAt,by:actor,commandId}])])).rows[0]
      const response = { ok: true, contractVersion: 2, commandId, fingerprint, shipmentId: body.shipmentId, shipmentFingerprint: body.shipmentFingerprint,
        documentId, warehouseId: derived.warehouseId, documentStatus: 'void', amount: derived.amount, restoredItems: derived.restoredItems,
        debtRemovedMinor: derived.debtRemovedMinor, cashRefundedMinor: '0', cancelledAt, order: {id:orderId,status:'cancelled',rowVersion:updated.row_version},
        evidence: {version:1,manifest,manifestHash:saleFingerprint(manifest),sourcePayloadHash:derived.sourcePayloadHash,sourceLinesHash:derived.sourceLinesHash,
          removed:{stockIds:stock.map(m=>m.id),settlementIds:settlement.map(m=>m.id),moneyIds:[]},documentStatus:'void',remainingSourceMovements:0} }
      await client.query(`insert into order_lifecycle_commands(company_id,command_id,order_id,operation,canonical_payload,fingerprint,response_status,response_body)
        values($1,$2,$3,'cancelled',$4::jsonb,$5,200,$6::jsonb)`,[company,commandId,orderId,JSON.stringify(canonical),fingerprint,JSON.stringify(response)])
      await client.query(`insert into audit(company_id,id,"by",title,section,type) values($1,$2,$3,$4,'orders','status')`,[company,randomUUID(),actor,`Заказ ${orderId}: отменён v2`])
      return {status:200,body:response,replayed:false}
    }) } catch (error) {
      if (!['40001','40P01'].includes((error as {code?:string}).code ?? '')) throw error
      if (unpostStarted || attempt >= 2) return conflict('CANCELLATION_RETRY_REQUIRED','Повторите ту же команду отмены без изменения идентичности')
    }
  }
}
