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

export const IdempotencyKey = z
	.string()
	.min(8, 'Idempotency-Key: минимум 8 символов')
	.max(128)
	.regex(/^[A-Za-z0-9_:.-]+$/, 'Idempotency-Key: только [A-Za-z0-9_:.-]')
