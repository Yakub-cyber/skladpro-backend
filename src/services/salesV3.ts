import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { withTransaction, type DbPool } from '../db.js'
import { ApiError } from '../lib/errors.js'
import { requirePermission } from '../lib/permissions.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import type { AuthContext } from '../plugins/auth.js'
import { SaleV3Body, type SaleV3 } from '../schemas/sale.js'
import { canonicalSale, saleFingerprint } from './salesV2.js'
import { lockCommercialOrder } from './orderCommercial.js'
import { lockCustomerFinances } from './customerFinance.js'

const unsupported = (code: string, message: string): never => { throw new ApiError(422, code, message) }
const conflict = (): never => { throw new ApiError(409, 'SALE_IDENTITY_CONFLICT', 'Продажа или её постоянное доказательство не совпадает с командой') }
const LIMIT = 100_000_000_000n
const decimal = (minor: number | bigint) => `${BigInt(minor) / 100n}.${(BigInt(minor) % 100n).toString().padStart(2, '0')}`
const minorFromDecimal = (value: string) => {
 if (!/^\d+(\.\d+)?$/.test(value)) return conflict()
 const [whole, fraction = ''] = value.split('.')
 if (/[1-9]/.test(fraction.slice(2))) return conflict()
 return BigInt(whole!) * 100n + BigInt(fraction.slice(0,2).padEnd(2,'0'))
}
const scaledQty = (value: string) => BigInt(value.replace('.', ''))
const sourceLineId = (id: string, lineId: string) => `sale-${id}:line:${lineId}`

export function saleV3Amounts(body: SaleV3) {
 const o = body.order, p = o.payment
 const amounts = o.items.map(i => (scaledQty(i.qtyBase) * BigInt(i.unitPriceMinor) + 5000n) / 10000n)
 const subtotal = amounts.reduce((sum, a) => sum + a, 0n)
 const total = subtotal - BigInt(o.discountMinor)
 if (subtotal > LIMIT || total < 0n || total > LIMIT || total !== BigInt(o.saleTotalMinor))
  unsupported('SALE_TOTAL_MISMATCH', 'Сумма строк, скидка и итог чека не согласованы')
 const credit = p.paymentMode === 'credit'
 if (credit && (!o.customerId || o.customerId === 'retail')) unsupported('CREDIT_CUSTOMER_REQUIRED', 'Для кредита нужен реальный клиент')
 if (credit ? p.moneyAccountId !== null || p.cashTendered !== 0 || p.change !== 0
  : !p.moneyAccountId || p.cashTendered < o.saleTotalMinor || p.change !== p.cashTendered - o.saleTotalMinor)
  unsupported('PAYMENT_DETAILS_INVALID', 'Касса, принятые деньги или сдача не соответствуют способу оплаты')
 return { amounts, subtotal, total, credit, retail: !o.customerId || o.customerId === 'retail' }
}

function resultFor(body: SaleV3, fingerprint: string) {
 const o = body.order, a = saleV3Amounts(body)
 return { ok: true, contractVersion: 3, orderId: o.id, documentId: `sale-${o.id}`, warehouseId: o.warehouseId, fingerprint,
  subtotalMinor: Number(a.subtotal), discountMinor: o.discountMinor, saleTotalMinor: o.saleTotalMinor,
  paymentMode: o.payment.paymentMode, moneyAccountId: o.payment.moneyAccountId,
  cashTendered: o.payment.cashTendered, change: o.payment.change,
  cashReceivedMinor: a.credit ? 0 : o.saleTotalMinor,
  paymentDocumentId: !a.credit && !a.retail ? `pay-${o.id}` : null,
  items: o.items.map((i, n) => ({ lineId: i.lineId, saleLineId: sourceLineId(o.id, i.lineId), productId: i.productId,
   qtyBase: i.qtyBase, amountMinor: Number(a.amounts[n]) })) }
}

// Pure proof builders shared with the read-only stock verifier.
export { sourceLineId as saleV3LineId, resultFor as saleV3Result }
export function saleV3Identity(body: SaleV3, companyId: string) {
 const request = { kind: 'sale-v3', companyId, body }
 return { request, fingerprint: saleFingerprint(request), documentId: `sale-${body.order.id}` }
}

// Historical success is deliberately independent of the current posting/account status.
// A damaged proof never authorizes a fresh execution.
async function permanentReplay(client: PoolClient, companyId: string, body: SaleV3, fingerprint: string) {
 const doc = (await client.query(`select *, amount::text as amount_text, discount::text as discount_text from docs
  where company_id=$1 and id=$2`, [companyId, `sale-${body.order.id}`])).rows[0]
 if (!doc) return null
 try {
  const saved = JSON.parse(doc.source_payload), request = { kind: 'sale-v3', companyId, body }
  const parsed = SaleV3Body.safeParse(saved?.request?.body)
  if (!parsed.success || saved.kind !== 'sale-v3' || saved.responseStatus !== 201 ||
   canonicalSale(saved.request) !== canonicalSale(request) || saleFingerprint(saved.request) !== saved.fingerprint || saved.fingerprint !== fingerprint)
   return conflict()
  const a = saleV3Amounts(parsed.data), expected = resultFor(parsed.data, fingerprint), o = body.order
  if (canonicalSale(saved.result) !== canonicalSale(expected) || doc.order_id !== o.id || doc.warehouse_id !== o.warehouseId ||
   doc.doc_type !== (a.retail ? 'retail_receipt' : 'sales_shipment') || doc.account_id !== (a.credit ? null : o.payment.moneyAccountId) ||
   doc.party_kind !== (a.retail ? null : 'customer') || doc.party_id !== (a.retail ? null : o.customerId) ||
   minorFromDecimal(doc.amount_text) !== a.total ||
   minorFromDecimal(doc.discount_text) !== BigInt(o.discountMinor)) return conflict()
  return saved.result as ReturnType<typeof resultFor>
 } catch { return conflict() }
}

export async function postSaleV3(pool: DbPool, auth: AuthContext, raw: unknown, key: unknown) {
 requirePermission(auth.role, 'sale')
 const parsed = SaleV3Body.safeParse(raw)
 if (!parsed.success) return unsupported('SALE_V3_INVALID', 'Некорректная продажа v3: поддерживаются только базовые единицы и cash/credit без предоплаты')
 const body = parsed.data, o = body.order
 if (key !== `sale-v3:${o.id}`) unsupported('SALE_IDEMPOTENCY_KEY_INVALID', 'Нужен ключ sale-v3:<order.id>')
 const { request, fingerprint } = saleV3Identity(body, auth.companyId)
 return withTransaction(pool, async client => {
  await lockCommercialOrder(client, auth.companyId, o.id)
  // Same identity lock as v2, not a parallel version-specific namespace.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['sale-v2', auth.companyId, o.id])])
  const historical = await permanentReplay(client, auth.companyId, body, fingerprint)
  const claim = await claimIdempotencyKey(client, { companyId: auth.companyId, key: key as string, endpoint: 'POST /v1/sales' })
  if (historical) {
   if (claim.replay && (claim.status !== 201 || canonicalSale(claim.response) !== canonicalSale(historical))) conflict()
   if (!claim.replay) await storeIdempotentResponse(client, auth.companyId, key as string, 201, historical)
   return { status: 201, body: historical, replayed: true }
  }
  if (claim.replay) conflict()
  const a = saleV3Amounts(body)
  const existing = (await client.query('select * from orders where company_id=$1 and id=$2 for update', [auth.companyId, o.id])).rows[0]
  // Never adopt or overwrite an unrelated legacy/commercial order.
  if (existing) conflict()
  if ((await client.query(`select id from docs where company_id=$1 and order_id=$2
   and doc_type in ('retail_receipt','sales_shipment') limit 1`, [auth.companyId,o.id])).rowCount) conflict()
  await lockCustomerFinances(client, auth.companyId, [a.retail ? null : o.customerId])
  if (!a.retail && !(await client.query('select id from customers where company_id=$1 and id=$2 and deleted_at is null for share', [auth.companyId,o.customerId])).rowCount)
   unsupported('SALE_CUSTOMER_UNAVAILABLE', 'Клиент недоступен')
  if (!a.credit) {
   const account = (await client.query('select kind, deleted_at from money_accounts where company_id=$1 and id=$2 for share', [auth.companyId,o.payment.moneyAccountId])).rows[0]
   if (!account || account.deleted_at || account.kind !== 'cash') unsupported('CASH_ACCOUNT_UNAVAILABLE', 'Нужна действующая касса текущей компании')
  }
  if (!(await client.query('select id from warehouses where company_id=$1 and id=$2 and deleted_at is null for share', [auth.companyId,o.warehouseId])).rowCount)
   unsupported('SALE_WAREHOUSE_UNAVAILABLE', 'Склад недоступен')
  // Read catalogue without share locks: post_doc later updates product mirrors.
  // Holding share locks here would create a lock-upgrade cycle with legacy posting.
  const productIds = [...new Set(o.items.map(i => i.productId))].sort()
  for (const id of productIds) {
   const p = (await client.query('select id, marked from products where company_id=$1 and id=$2 and deleted_at is null', [auth.companyId,id])).rows[0]
   if (!p) unsupported('SALE_PRODUCT_UNAVAILABLE', 'Товар недоступен')
   if (p.marked) unsupported('SALE_MARKING_UNSUPPORTED', 'Маркированные товары требуют отдельного поддерживаемого контракта')
  }
  const actor = auth.memberName ?? auth.email ?? auth.userId, docId = `sale-${o.id}`
  // Create the order before post_doc so SQL's write fence always has a real row.
  const storedItems = o.items.map(i => ({ lineId: i.lineId, productId: i.productId, qty: Number(i.qtyBase),
   inputQty: Number(i.qtyBase), unitFactor: 1, price: Number(decimal(i.unitPriceMinor)) }))
  await client.query(`insert into orders(company_id,id,no,customer_id,customer_name,items,subtotal,discount,total,on_credit,price_type_id,shift_id)
   values($1,$2,$3,$4,$5,$6::jsonb,$7::numeric,$8::numeric,$9::numeric,$10,$11,$12)`,
  [auth.companyId,o.id,o.no ?? null,a.retail ? null : o.customerId,o.customerName ?? null,JSON.stringify(storedItems),decimal(a.subtotal),decimal(o.discountMinor),decimal(a.total),a.credit,o.priceTypeId ?? null,o.shiftId ?? null])
  await client.query(`insert into docs(company_id,id,doc_type,warehouse_id,party_kind,party_id,account_id,order_id,discount,price_type_id,"by")
   values($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11)`,
  [auth.companyId,docId,a.retail ? 'retail_receipt' : 'sales_shipment',o.warehouseId,a.retail ? null : 'customer',a.retail ? null : o.customerId,
   a.credit ? null : o.payment.moneyAccountId,o.id,decimal(o.discountMinor),o.priceTypeId ?? null,actor])
  const sorted = [...o.items].sort((x,y) => x.productId.localeCompare(y.productId) || x.lineId.localeCompare(y.lineId))
  for (const [n,i] of sorted.entries()) await client.query(`insert into doc_lines(company_id,id,doc_id,line_no,product_id,unit_factor,qty_input,qty,price)
   values($1,$2,$3,$4,$5,1,$6::numeric,$6::numeric,$7::numeric)`, [auth.companyId,sourceLineId(o.id,i.lineId),docId,n,i.productId,i.qtyBase,decimal(i.unitPriceMinor)])
  const posted = await client.query('select post_doc($1,$2)::text as total', [auth.companyId,docId])
  if (BigInt((await client.query('select (amount*100)::bigint::text as minor from docs where company_id=$1 and id=$2', [auth.companyId,docId])).rows[0].minor) !== a.total || !posted.rowCount)
   unsupported('SALE_POSTING_TOTAL_MISMATCH','Проведение не соответствует сумме чека')
  const result = resultFor(body,fingerprint)
  if (result.paymentDocumentId) {
   await client.query(`insert into docs(company_id,id,doc_type,party_kind,party_id,account_id,amount,"by")
    values($1,$2,'payment_in','customer',$3,$4,$5::numeric,$6)`, [auth.companyId,result.paymentDocumentId,o.customerId,o.payment.moneyAccountId,decimal(a.total),actor])
   await client.query('select post_doc($1,$2)', [auth.companyId,result.paymentDocumentId])
  }
  // Verify actual money and debt before committing proof, never use JS float totals.
  const ledger = (await client.query(`select
   (select coalesce(sum(amount),0)*100 from money_movements where company_id=$1 and doc_id=any($2::text[]))::bigint::text as cash,
   (select coalesce(sum(amount),0)*100 from settlement_movements where company_id=$1 and doc_id=any($2::text[]))::bigint::text as debt`,
  [auth.companyId,[docId,result.paymentDocumentId].filter(Boolean)])).rows[0]
  if (BigInt(ledger.cash) !== (a.credit ? 0n : a.total) || BigInt(ledger.debt) !== (a.credit ? a.total : 0n))
   unsupported('SALE_POSTING_TOTAL_MISMATCH', 'Денежные и долговые движения не соответствуют продаже')
  await client.query(`update orders set status='delivered',stock_consumed=true,shipment_doc_id=$3,
   track=$4::jsonb where company_id=$1 and id=$2`, [auth.companyId,o.id,docId,JSON.stringify([{status:'delivered',at:new Date().toISOString(),by:actor}])])
  await client.query('update docs set source_payload=$3 where company_id=$1 and id=$2', [auth.companyId,docId,
   JSON.stringify({kind:'sale-v3',request,fingerprint,responseStatus:201,result})])
  await client.query(`insert into audit(company_id,id,"by",title,section,type) values($1,$2,$3,$4,'sales','sale')`,
   [auth.companyId,randomUUID(),actor,`Продажа v3 ${o.id}`])
  await storeIdempotentResponse(client,auth.companyId,key as string,201,result)
  return {status:201,body:result,replayed:false}
 })
}
