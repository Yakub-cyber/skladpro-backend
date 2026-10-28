import { z } from 'zod'

const id = z.string().min(1).max(64)

export const SaleItem = z.object({
	productId: id,
	name: z.string().max(300).optional(),
	// qty — количество в единицах ввода (упаковки, если unitFactor задан; штуки, если нет).
	qty: z.number().positive().finite().max(1_000_000),
	// price — цена за единицу ввода. Если qty=2 и unitFactor=12, price — цена за упаковку,
	// total = 2 * price. Сервер НЕ пересчитывает price при unitFactor.
	price: z.number().min(0).finite().max(1_000_000_000),
	unitId: id.optional(),
	// unitFactor — коэффициент упаковки (default 1). Сервер вычисляет qtyBase = qty * unitFactor
	// для stock_movements. Передавать только когда пользователь явно выбрал единицу упаковки.
	unitFactor: z.number().finite().positive().optional(),
	// Коды маркировки «Честный знак» — конкретные DataMatrix, отсканированные
	// кассиром. Сервер списывает их из products.codes атомарно с продажей.
	// Пусто = продажа без маркировки (либо товар немаркированный).
	markCodes: z.array(z.string().min(1).max(300)).max(1000).optional(),
})

export const SaleBody = z.object({
	order: z.object({
		id: id,
		no: z.string().max(64).optional(),
		customerId: id.optional(),
		customerName: z.string().max(300).optional(),
		items: z.array(SaleItem).min(1).max(500),
		discount: z.number().min(0).finite().default(0),
		onCredit: z.boolean().default(false),
		priceTypeId: id.optional(),
		shiftId: id.optional(),
		// Клиентские события (оплата, фискальные реквизиты чека) — passthrough.
		track: z.array(z.record(z.unknown())).max(30).optional(),
	}),
})

export type SaleBodyType = z.infer<typeof SaleBody>

// Legacy parsing is deliberately unchanged. V2 is opt-in and rejects unknown
// fields so that significant client data cannot silently escape the fingerprint.
export const SaleV2Body = z.object({
	contractVersion: z.literal(2),
	order: SaleBody.shape.order.extend({ warehouseId: id, items: z.array(SaleItem.strict()).min(1).max(500) }).strict(),
}).strict().superRefine((body, ctx) => {
	for (const [index, item] of body.order.items.entries()) {
		const qty = Math.round(item.qty * 10000) / 10000
		const base = Math.round(qty * (item.unitFactor ?? 1) * 10000) / 10000
		if (qty <= 0 || !Number.isFinite(base) || base <= 0) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['order', 'items', index, 'qty'], message: 'Количество в базовых единицах должно быть положительным и конечным' })
		}
	}
})

export const IdempotencyKey = z
	.string()
	.min(8, 'Idempotency-Key: минимум 8 символов')
	.max(128)
	.regex(/^[A-Za-z0-9_:.-]+$/, 'Idempotency-Key: только [A-Za-z0-9_:.-]')

// V3 carries money only as integer kopecks; no coercion/defaults or packaging.
const minor = z.number().int().safe().min(0).max(100_000_000_000)
export const SaleV3Body = z.object({
 contractVersion: z.literal(3),
 order: z.object({
  id: id.regex(/^[A-Za-z0-9_:.-]+$/), warehouseId: id, customerId: id.nullable(),
  no: z.string().max(64).optional(), customerName: z.string().max(300).optional(),
  priceTypeId: id.optional(), shiftId: id.optional(),
  items: z.array(z.object({
   lineId: z.string().uuid(), productId: id,
   qtyBase: z.string().regex(/^(0|[1-9]\d{0,6})\.\d{4}$/).refine(v => /^(0|[1-9]\d{0,6})\.\d{4}$/.test(v) && BigInt(v.replace('.', '')) > 0n && BigInt(v.replace('.', '')) <= 10_000_000_000n),
   unitPriceMinor: minor,
  }).strict()).min(1).max(500),
  discountMinor: minor, saleTotalMinor: minor,
  payment: z.object({
   paymentMode: z.enum(['cash', 'credit']), moneyAccountId: id.nullable(),
   cashTendered: minor, change: minor,
  }).strict(),
 }).strict(),
}).strict().superRefine((body, ctx) => {
 if (new Set(body.order.items.map(i => i.lineId)).size !== body.order.items.length)
  ctx.addIssue({code: z.ZodIssueCode.custom, path: ['order','items'], message: 'ID строк должны быть уникальными'})
})
export type SaleV3 = z.infer<typeof SaleV3Body>
