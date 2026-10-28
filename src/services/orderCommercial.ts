import { createHash } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { ApiError } from '../lib/errors.js'
import { canonicalSale } from './salesV2.js'

const id = z.string().regex(/^[\w:.-]{1,64}$/)
const decimal = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,4})?$/)
const money = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
const text = z.string().max(1000)
const line = z.object({ lineId: id, productId: id, name: text.optional(), unitId: id,
  unitFactor: decimal, qtyInput: decimal, qtyBase: decimal, price: money,
  basePrice: money.optional(), markCodes: z.array(z.string().max(500)).max(500).optional(),
}).strict()
export const CommercialBody = z.object({ contractVersion: z.literal(2), commandId: id, orderId: id,
  expectedRowVersion: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
  commercial: z.object({ items: z.array(line).min(1).max(500),
    customerId: id.nullable(), customerName: text.nullable(), no: text.nullable(),
    priceTypeId: id.nullable(), shiftId: id.nullable(),
    subtotal: money, discount: z.object({ kind: z.enum(['percent','absolute']), value: money }).strict(),
    total: money, rounding: z.enum(['kopeck','ruble']), onCredit: z.boolean(),
    creditTerms: z.null(),
    payment: z.object({ method: z.enum(['cash','card','mixed','credit','unpaid']), cashPaid: money,
      cardPaid: money, change: money }).strict(),
    vatSummary: z.null(), address: text.nullable(),
    geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().nullable(),
    courier: text.nullable(), assignedTo: text.nullable(), priority: z.boolean(),
  }).strict(),
}).strict()
type Body = z.infer<typeof CommercialBody>
export const commercialError = (code: string, message: string, status = 409): never => { throw new ApiError(status, code, message) }
export async function lockCommercialOrder(client: pg.PoolClient, companyId: string, orderId: string) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['order-commercial',companyId,orderId])])
}
const scaled = (value: string, scale = 4) => {
  const [whole, rawFraction = ''] = value.split('.')
  const fraction = rawFraction.replace(/0+$/, '')
  if (fraction.length > scale) return commercialError('COMMERCIAL_UNSUPPORTED','Точность коэффициента не поддерживается',422)
  return BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale,'0'))
}
const round = (n: bigint, denominator: bigint) => (n + denominator / 2n) / denominator
const fixed = (n: bigint, scale = 2) => `${n / 10n ** BigInt(scale)}.${String(n % 10n ** BigInt(scale)).padStart(scale,'0')}`

export async function validateCommercial(client: pg.PoolClient, companyId: string, c: Body['commercial'], lockReferences = true) {
  // Posting updates product/customer mirrors after locking stock balances. Do not
  // acquire SHARE locks first and later upgrade them in the opposite lock order.
  const referenceLock = lockReferences ? ' for share' : ''
  const bad = (message: string): never => commercialError('COMMERCIAL_UNSUPPORTED', message, 422)
  if (new Set(c.items.map(l => l.lineId)).size !== c.items.length) bad('Повтор ID строки')
  if (c.customerId && c.customerId !== 'retail') {
    const customer = await client.query(`select id from customers where company_id=$1 and id=$2 and deleted_at is null${referenceLock}`, [companyId,c.customerId])
    if (!customer.rowCount) bad('Клиент недоступен в компании')
  }
  if (c.priceTypeId && !(await client.query(`select id from price_types where company_id=$1 and id=$2 and deleted_at is null${referenceLock}`,[companyId,c.priceTypeId])).rowCount) bad('Тип цен недоступен')
  if (c.shiftId && !(await client.query(`select id from shifts where company_id=$1 and id=$2 and deleted_at is null${referenceLock}`,[companyId,c.shiftId])).rowCount) bad('Смена недоступна')
  if (c.onCredit && (!c.customerId || c.customerId === 'retail')) bad('Для кредита нужен клиент')
  if (c.onCredit !== (c.payment.method === 'credit')) bad('Несогласованные кредитные условия')
  if (!['cash','credit','unpaid'].includes(c.payment.method) || [c.payment.cashPaid,c.payment.cardPaid,c.payment.change].some(v => scaled(v) !== 0n)) bad('Приём оплаты и неоднозначные платёжные условия не поддерживаются')
  let subtotalRaw = 0n
  const stored = []
  for (const l of c.items) {
    if (l.markCodes?.length) bad('Резервирование кодов маркировки не поддерживается коммерческим контрактом')
    const unit = (await client.query(`select u.factor::text, p.name from product_units u join products p
      on p.company_id=u.company_id and p.id=u.product_id where u.company_id=$1 and u.id=$2
      and u.product_id=$3 and u.deleted_at is null and p.deleted_at is null${lockReferences ? ' for share of u,p' : ''}`,[companyId,l.unitId,l.productId])).rows[0]
    if (!unit || scaled(unit.factor) !== scaled(l.unitFactor)) bad('Товар, единица или коэффициент недоступны')
    const qty = scaled(l.qtyInput), factor = scaled(l.unitFactor), base = scaled(l.qtyBase)
    if (qty <= 0n || factor <= 0n || base <= 0n || qty * factor !== base * 10000n) bad('Количество и единицы не согласованы точно')
    // Explicit price per base unit, matching the stored order items consumed by legacy readers.
    subtotalRaw += base * scaled(l.price,2)
    stored.push({ ...l, qty: l.qtyBase, price: l.price, unit: l.unitId, inputQty: l.qtyInput })
  }
  const subtotal = round(subtotalRaw,10000n)
  if (scaled(c.subtotal,2) !== subtotal) bad('Некорректная промежуточная сумма')
  const d = scaled(c.discount.value,2)
  if (c.discount.kind === 'percent' && d > 10000n) bad('Скидка превышает 100%')
  if (c.discount.kind === 'absolute' && d*10000n > subtotalRaw) bad('Скидка превышает сумму')
  // Round the payable amount once, not the discount first (half-cent ties differ).
  const payable = c.discount.kind === 'percent' ? subtotalRaw*(10000n-d) : (subtotalRaw-d*10000n)*10000n
  const denominator = 100000000n * (c.rounding === 'ruble' ? 100n : 1n)
  const total = round(payable,denominator) * (c.rounding === 'ruble' ? 100n : 1n)
  if (scaled(c.total,2) !== total) bad('Некорректная итоговая сумма')
  return { stored, subtotal: fixed(subtotal), total: fixed(total) }
}

export async function saveCommercial(client: pg.PoolClient, companyId: string, operation: 'create'|'replace', body: Body) {
  // A command can be reused against another order: serialize identity before order identity.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['order-commercial-command',companyId,body.commandId])])
  await lockCommercialOrder(client,companyId,body.orderId)
  const canonical = { companyId, operation, ...body }
  const fingerprint = createHash('sha256').update(canonicalSale(canonical)).digest('hex')
  const receipt = (await client.query('select * from order_commercial_commands where company_id=$1 and command_id=$2',[companyId,body.commandId])).rows[0]
  if (receipt) {
    if (receipt.fingerprint !== fingerprint || canonicalSale(receipt.canonical_payload) !== canonicalSale(canonical)) commercialError('COMMERCIAL_IDENTITY_CONFLICT','Команда уже сохранена с другим содержимым')
    return { status: receipt.response_status as number, body: receipt.response_body, replayed: true }
  }
  const order = (await client.query('select * from orders where company_id=$1 and id=$2 for update',[companyId,body.orderId])).rows[0]
  if (operation === 'create' && order) commercialError('ORDER_EXISTS','Заказ уже существует')
  if (operation === 'replace') {
    if (!order || order.deleted_at) commercialError('ORDER_NOT_FOUND','Заказ не найден',404)
    if (!order.commercial_snapshot) commercialError('LEGACY_ORDER_UNVERIFIED','Исторический состав не подтверждён; автоматическое принятие запрещено')
    if (String(order.row_version) !== body.expectedRowVersion) commercialError('COMMERCIAL_VERSION_CONFLICT','Заказ изменён другим клиентом')
    const posted = await client.query(`select d.id from docs d where d.company_id=$1 and d.order_id=$2
      and d.doc_type in ('sales_shipment','retail_receipt') and (d.status='posted'
      or exists(select 1 from stock_movements m where m.company_id=d.company_id and m.doc_id=d.id)
      or exists(select 1 from money_movements m where m.company_id=d.company_id and m.doc_id=d.id)
      or exists(select 1 from settlement_movements m where m.company_id=d.company_id and m.doc_id=d.id)) limit 1`,[companyId,body.orderId])
    if (order.stock_consumed || order.shipment_doc_id || order.status === 'cancelled' || posted.rowCount) commercialError('ORDER_COMMERCIAL_LOCKED','Состав отгруженного или отменённого заказа менять нельзя')
    const reused = await client.query(`select 1 from order_commercial_commands c
      cross join lateral jsonb_array_elements(c.canonical_payload->'commercial'->'items') old
      join jsonb_to_recordset($3::jsonb) as incoming("lineId" text,"productId" text)
        on old->>'lineId'=incoming."lineId"
      where c.company_id=$1 and c.order_id=$2 and old->>'productId'<>incoming."productId" limit 1`,
      [companyId,body.orderId,JSON.stringify(body.commercial.items)])
    if (reused.rowCount) commercialError('COMMERCIAL_LINE_CONFLICT','ID строки нельзя назначить другому товару, включая удалённые строки')
  }
  const c = body.commercial, amounts = await validateCommercial(client,companyId,c)
  if (operation === 'create') await client.query('insert into orders(company_id,id) values($1,$2)',[companyId,body.orderId])
  const updated = await client.query(`update orders set commercial_snapshot=$3::jsonb, items=$4::jsonb,
    no=$5,customer_id=$6,customer_name=$7,subtotal=$8,discount=$9,total=$10,price_type_id=$11,
    on_credit=$12,address=$13,courier=$14,assigned_to=$15,priority=$16,shift_id=$17
    where company_id=$1 and id=$2 returning row_version::text`,
    [companyId,body.orderId,JSON.stringify(c),JSON.stringify(amounts.stored),c.no,c.customerId,c.customerName,
      amounts.subtotal,c.discount.kind === 'percent' ? c.discount.value : '0',amounts.total,c.priceTypeId,c.onCredit,
      c.address,c.courier,c.assignedTo,c.priority,c.shiftId])
  const version = updated.rows[0].row_version as string
  const response = { ok:true,contractVersion:2,commandId:body.commandId,order:{id:body.orderId,rowVersion:version,commercial:c},fingerprint }
  const status = operation === 'create' ? 201 : 200
  await client.query(`insert into order_commercial_commands(company_id,command_id,order_id,operation,canonical_payload,
    fingerprint,response_status,response_body,resulting_row_version) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9)`,
    [companyId,body.commandId,body.orderId,operation,JSON.stringify(canonical),fingerprint,status,JSON.stringify(response),version])
  return { status, body:response,replayed:false }
}
