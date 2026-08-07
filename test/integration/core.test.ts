import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, cash, costAt, debt, drift, hasDb, allowSkipIntegration, setupIntegration, stockAt, type Ctx } from './helpers.js'

if (!hasDb && !allowSkipIntegration) {
	throw new Error(
		'TEST_DATABASE_URL не задан. Интеграционные тесты требуют живую базу.\n' +
		'Задайте TEST_DATABASE_URL или ALLOW_SKIP_INTEGRATION=1 для явного пропуска.',
	)
}

describe.skipIf(!hasDb)('учётное ядро на живой базе', () => {
	let ctx: Ctx

	beforeAll(async () => { ctx = await setupIntegration() })
	afterAll(async () => { await ctx?.close() })

	it('приход в упаковках пересчитывается в штуки и создаёт долг поставщику', async () => {
		const res = await call(ctx, 'POST', '/v1/documents/post', {
			document: {
				id: 'doc-in-1',
				type: 'receive',
				warehouseId: ctx.ids.warehouse,
				supplierId: ctx.ids.supplier,
				items: [{ productId: ctx.ids.product, qty: 10, cost: 30, unitId: ctx.ids.unitPack, unitFactor: 12 }],
			},
		})
		expect(res.statusCode).toBe(201)

		// 10 упаковок по 12 = 120 штук, 120 × 30 = 3600
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(120)
		expect(await debt(ctx, 'supplier', ctx.ids.supplier)).toBe(-3600)
		expect(await drift(ctx)).toEqual([])
	})

	it('продажа в долг списывает товар и увеличивает долг клиента', async () => {
		const res = await call(ctx, 'POST', '/v1/sales', {
			order: {
				id: 'order-1',
				customerId: ctx.ids.customer,
				onCredit: true,
				discount: 0,
				items: [{ productId: ctx.ids.product, qty: 20, price: 50 }],
			},
		})
		expect(res.statusCode).toBe(201)

		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(100)
		expect(await debt(ctx, 'customer', ctx.ids.customer)).toBe(1000)
		expect(await drift(ctx)).toEqual([])
	})

	it('себестоимость списания считается по средней, а не по цене продажи', async () => {
		const { rows } = await ctx.pool.query(
			`select cost_amount from doc_lines where company_id=$1 and doc_id='sale-order-1'`,
			[ctx.companyId])
		expect(Number(rows[0].cost_amount)).toBe(600) // 20 шт × 30
	})

	it('оплата гасит долг и кладёт деньги в кассу', async () => {
		const res = await call(ctx, 'POST', `/v1/customers/${ctx.ids.customer}/payments`, {
			amount: 600, kind: 'payment',
		})
		expect(res.statusCode).toBeLessThan(300)

		expect(await debt(ctx, 'customer', ctx.ids.customer)).toBe(400)
		expect(await cash(ctx, ctx.ids.account)).toBe(600)
		expect(await drift(ctx)).toEqual([])
	})

	it('продажа за наличные реальному клиенту НЕ теряет контрагента', async () => {
		await call(ctx, 'POST', '/v1/sales', {
			order: {
				id: 'order-cash',
				customerId: ctx.ids.customer,
				onCredit: false,
				discount: 0,
				items: [{ productId: ctx.ids.product, qty: 5, price: 50 }],
			},
		})

		const { rows } = await ctx.pool.query(
			`select doc_type, party_kind, party_id from docs where company_id=$1 and order_id='order-cash'`,
			[ctx.companyId])

		expect(rows[0]?.doc_type).toBe('sales_shipment')
		expect(rows[0]?.party_id).toBe(ctx.ids.customer)

		const { rows: mv } = await ctx.pool.query(
			`select count(*) c from settlement_movements
			  where company_id=$1 and doc_id in (select id from docs where company_id=$1 and order_id='order-cash')`,
			[ctx.companyId])
		expect(Number(mv[0].c)).toBeGreaterThan(0)

		expect(await cash(ctx, ctx.ids.account)).toBeGreaterThan(0)
		expect(await drift(ctx)).toEqual([])
	})

	it('возврат уменьшает долг и может увести его в минус (предоплата не пропадает)', async () => {
		const res = await call(ctx, 'POST', '/v1/returns', {
			orderId: 'order-1',
			items: [{ productId: ctx.ids.product, qty: 20 }],
			reason: 'тест',
		})
		expect(res.statusCode).toBeLessThan(300)

		// Клиент был должен 400, вернул товар на 1000 → теперь МЫ должны 600.
		expect(await debt(ctx, 'customer', ctx.ids.customer)).toBeLessThan(0)
		expect(await drift(ctx)).toEqual([])
	})

	it('отгрузка сверх остатка проходит и честно уводит склад в минус', async () => {
		// Работа опта: физически товар приехал, продали с колёс, накладную
		// от поставщика оператор проведёт позже. Минус — сигнал «есть
		// непроведённый приход», а не блокировка отгрузки.
		const before = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		const res = await call(ctx, 'POST', '/v1/sales', {
			order: {
				id: 'order-oversold',
				customerId: ctx.ids.customer,
				onCredit: true,
				discount: 0,
				items: [{ productId: ctx.ids.product, qty: before + 30, price: 50 }],
			},
		})
		expect(res.statusCode).toBe(201)
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(-30)
		expect(await drift(ctx)).toEqual([])
	})

	it('приход, закрывающий минус, восстанавливает среднюю по last known', async () => {
		// Ожидаем: продали в минус по last known, потом привезли по той же цене —
		// средневзвешенная должна вернуться к исходной, а не поехать.
		const stockBefore = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		const { rows: costBefore } = await ctx.pool.query(
			`select cost from products where company_id=$1 and id=$2`, [ctx.companyId, ctx.ids.product])
		const priorCost = Number(costBefore[0].cost)

		await call(ctx, 'POST', '/v1/documents/post', {
			document: {
				id: 'doc-close-negative',
				type: 'receive',
				warehouseId: ctx.ids.warehouse,
				supplierId: ctx.ids.supplier,
				items: [{ productId: ctx.ids.product, qty: Math.abs(stockBefore) + 30, cost: priorCost }],
			},
		})

		const { rows: costAfter } = await ctx.pool.query(
			`select cost from products where company_id=$1 and id=$2`, [ctx.companyId, ctx.ids.product])
		expect(Number(costAfter[0].cost)).toBeCloseTo(priorCost, 4)
		expect(await drift(ctx)).toEqual([])
	})

	it('перемещение через API: количество и себестоимость сходятся', async () => {
		const before1 = await costAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		const before2 = await costAt(ctx, ctx.ids.warehouse2, ctx.ids.product)
		const totalCostBefore = before1.costAmount + before2.costAmount
		const avgBefore = before1.qty > 0 ? before1.costAmount / before1.qty : 0
		const qty = 10

		const res = await call(ctx, 'POST', '/v1/documents/post', {
			document: {
				id: 'doc-transfer-ok',
				type: 'transfer',
				warehouseId: ctx.ids.warehouse,
				warehouseToId: ctx.ids.warehouse2,
				items: [{ productId: ctx.ids.product, qty }],
			},
		})
		expect(res.statusCode).toBe(201)

		const after1 = await costAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		const after2 = await costAt(ctx, ctx.ids.warehouse2, ctx.ids.product)

		// Количество переместилось
		expect(after1.qty).toBe(before1.qty - qty)
		expect(after2.qty).toBe(before2.qty + qty)

		// Сумма cost_amount по компании не изменилась
		const totalCostAfter = after1.costAmount + after2.costAmount
		expect(totalCostAfter).toBeCloseTo(totalCostBefore, 2)

		// Средняя на приёмном складе = средней источника (товар пришёл по той же цене)
		const avgAfter2 = after2.qty > 0 ? after2.costAmount / after2.qty : 0
		expect(avgAfter2).toBeCloseTo(avgBefore, 2)

		expect(await drift(ctx)).toEqual([])
	})

	it('перемещение на тот же склад отклоняется валидацией', async () => {
		const res = await call(ctx, 'POST', '/v1/documents/post', {
			document: {
				id: 'doc-transfer-same-wh',
				type: 'transfer',
				warehouseId: ctx.ids.warehouse,
				warehouseToId: ctx.ids.warehouse,
				items: [{ productId: ctx.ids.product, qty: 1 }],
			},
		})
		expect(res.statusCode).toBe(400)
		expect(res.json().error.code).toBe('VALIDATION_ERROR')
	})

	it('перемещение сверх остатка отклоняется — товар физически на складе отсутствует', async () => {
		const have = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		const res = await call(ctx, 'POST', '/v1/documents/post', {
			document: {
				id: 'doc-transfer-too-big',
				type: 'transfer',
				warehouseId: ctx.ids.warehouse,
				warehouseToId: ctx.ids.warehouse2,
				items: [{ productId: ctx.ids.product, qty: have + 5000 }],
			},
		})
		expect(res.statusCode).toBeGreaterThanOrEqual(400)
		expect(res.json().error.code).toBe('INSUFFICIENT_STOCK')
	})

	it('списание сверх остатка отклоняется — списывать нечего', async () => {
		const have = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		const res = await call(ctx, 'POST', '/v1/documents/post', {
			document: {
				id: 'doc-writeoff-too-big',
				type: 'writeoff',
				warehouseId: ctx.ids.warehouse,
				items: [{ productId: ctx.ids.product, qty: have + 5000 }],
				reason: 'бой',
			},
		})
		expect(res.statusCode).toBeGreaterThanOrEqual(400)
		expect(res.json().error.code).toBe('INSUFFICIENT_STOCK')
	})

	it('распроведение прихода после продажи уводит в минус (исправление ошибки оператора)', async () => {
		// Оператор ошибся в количестве прихода, товар уже продан.
		// Распроведение и перепроведение с правильным количеством должно работать.
		const docId = 'doc-in-fixable'
		await call(ctx, 'POST', '/v1/documents/post', {
			document: {
				id: docId,
				type: 'receive',
				warehouseId: ctx.ids.warehouse,
				supplierId: ctx.ids.supplier,
				items: [{ productId: ctx.ids.product, qty: 100, cost: 30 }],
			},
		})
		const afterIncome = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)

		// Продаём часть
		await call(ctx, 'POST', '/v1/sales', {
			order: {
				id: 'order-before-unpost',
				customerId: ctx.ids.customer,
				onCredit: true,
				discount: 0,
				items: [{ productId: ctx.ids.product, qty: 80, price: 50 }],
			},
		})
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(afterIncome - 80)

		// Распроводим ошибочный приход — уводит в минус, но должно пройти
		const dbDocId = (await ctx.pool.query(
			`select id from docs where company_id=$1 and order_id is null and doc_type='purchase_receipt'
			 and status='posted' order by posted_at desc limit 1`, [ctx.companyId])).rows[0]?.id
			?? `receive-${docId}`

		await ctx.pool.query('select unpost_doc($1,$2)', [ctx.companyId, dbDocId])
		const afterUnpost = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		expect(afterUnpost).toBeLessThan(0)
		expect(await drift(ctx)).toEqual([])
	})

	it('повтор запроса с тем же Idempotency-Key не задваивает проводку', async () => {
		const key = randomUUID()
		const body = {
			document: {
				id: 'doc-in-idem',
				type: 'receive',
				warehouseId: ctx.ids.warehouse,
				supplierId: ctx.ids.supplier,
				items: [{ productId: ctx.ids.product, qty: 5, cost: 30 }],
			},
		}
		const before = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		await call(ctx, 'POST', '/v1/documents/post', body, key)
		await call(ctx, 'POST', '/v1/documents/post', body, key)
		const after = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)

		expect(after - before).toBe(5)
		expect(await drift(ctx)).toEqual([])
	})

	it('отмена заказа распроводит документ и возвращает товар', async () => {
		await call(ctx, 'POST', '/v1/sales', {
			order: {
				id: 'order-cancel', customerId: ctx.ids.customer, onCredit: true, discount: 0,
				items: [{ productId: ctx.ids.product, qty: 3, price: 50 }],
			},
		})
		const afterSale = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)

		const res = await call(ctx, 'POST', '/v1/orders/order-cancel/status', { status: 'cancelled' })
		// Продажа через /v1/sales создаёт заказ сразу в статусе delivered, из
		// которого переходов нет — отменить проведённую продажу невозможно.
		expect(res.statusCode).toBeLessThan(300)

		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(afterSale + 3)
		expect(await drift(ctx)).toEqual([])
	})

	it('продажа в упаковках: qty пересчитывается по unitFactor', async () => {
		const before = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)

		const res = await call(ctx, 'POST', '/v1/sales', {
			order: {
				id: 'order-pack-sale', customerId: ctx.ids.customer, onCredit: true, discount: 0,
				items: [{ productId: ctx.ids.product, qty: 2, price: 600, unitFactor: 12 }],
			},
		})
		expect(res.statusCode).toBe(201)

		// 2 упаковки по 12 = 24 штуки списано
		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(before - 24)
		// сумма: 2 × 600 = 1200 (цена за упаковку, не за штуку)
		expect(res.json().order.total).toBe(1200)
		expect(await drift(ctx)).toEqual([])
	})

	it('отмена продажи в упаковках: stock возвращается ровно на 24', async () => {
		const before = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)

		const res = await call(ctx, 'POST', '/v1/orders/order-pack-sale/status', { status: 'cancelled' })
		expect(res.statusCode).toBeLessThan(300)

		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(before + 24)
		expect(await drift(ctx)).toEqual([])
	})

	it('розничная продажа (без контрагента) → retail_receipt + деньги в кассу', async () => {
		await call(ctx, 'POST', '/v1/documents/post', {
			document: {
				id: 'doc-in-for-retail',
				type: 'receive',
				warehouseId: ctx.ids.warehouse,
				supplierId: ctx.ids.supplier,
				items: [{ productId: ctx.ids.product, qty: 50, cost: 30 }],
			},
		})
		const stockBefore = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		const cashBefore = await cash(ctx, ctx.ids.account)

		const res = await call(ctx, 'POST', '/v1/sales', {
			order: {
				id: 'order-retail',
				onCredit: false,
				discount: 0,
				items: [{ productId: ctx.ids.product, qty: 10, price: 50 }],
			},
		})
		expect(res.statusCode).toBe(201)

		const { rows } = await ctx.pool.query(
			`select doc_type, party_kind, party_id from docs
			  where company_id=$1 and order_id='order-retail' and status='posted'`,
			[ctx.companyId])
		expect(rows[0]?.doc_type).toBe('retail_receipt')
		expect(rows[0]?.party_id).toBeNull()

		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(stockBefore - 10)
		expect(await cash(ctx, ctx.ids.account)).toBe(cashBefore + 500)

		const { rows: sms } = await ctx.pool.query(
			`select count(*) c from settlement_movements
			  where company_id=$1 and doc_id in (select id from docs where company_id=$1 and order_id='order-retail')`,
			[ctx.companyId])
		expect(Number(sms[0].c)).toBe(0)

		expect(await drift(ctx)).toEqual([])
	})

	it('розничный возврат → retail_return, деньги уходят из кассы', async () => {
		const stockBefore = await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)
		const cashBefore = await cash(ctx, ctx.ids.account)

		const res = await call(ctx, 'POST', '/v1/returns', {
			orderId: 'order-retail',
			items: [{ productId: ctx.ids.product, qty: 3 }],
			reason: 'брак',
		})
		expect(res.statusCode).toBeLessThan(300)

		const { rows } = await ctx.pool.query(
			`select doc_type, party_kind, party_id from docs
			  where company_id=$1 and doc_type='retail_return' and status='posted'`,
			[ctx.companyId])
		expect(rows).toHaveLength(1)
		expect(rows[0]?.party_id).toBeNull()

		expect(await stockAt(ctx, ctx.ids.warehouse, ctx.ids.product)).toBe(stockBefore + 3)
		expect(await cash(ctx, ctx.ids.account)).toBe(cashBefore - 150)

		const { rows: sms } = await ctx.pool.query(
			`select count(*) c from settlement_movements
			  where company_id=$1 and doc_id in (select id from docs where company_id=$1 and doc_type='retail_return')`,
			[ctx.companyId])
		expect(Number(sms[0].c)).toBe(0)

		expect(await drift(ctx)).toEqual([])
	})

	it('ledger_guard: прямой UPDATE products.stock → P0009', async () => {
		await ctx.pool.query('select install_ledger_guard()')
		try {
			await expect(
				ctx.pool.query(`update products set stock = stock + 1 where company_id=$1 and id=$2`,
					[ctx.companyId, ctx.ids.product])
			).rejects.toMatchObject({ code: 'P0009' })
		} finally {
			await ctx.pool.query('drop trigger if exists products_ledger_guard on products')
			await ctx.pool.query('drop trigger if exists customers_ledger_guard on customers')
			await ctx.pool.query('drop trigger if exists suppliers_ledger_guard on suppliers')
		}
	})

	it('ledger_guard: прямой UPDATE customers.balance → P0009', async () => {
		await ctx.pool.query('select install_ledger_guard()')
		try {
			await expect(
				ctx.pool.query(`update customers set balance = balance + 1 where company_id=$1 and id=$2`,
					[ctx.companyId, ctx.ids.customer])
			).rejects.toMatchObject({ code: 'P0009' })
		} finally {
			await ctx.pool.query('drop trigger if exists products_ledger_guard on products')
			await ctx.pool.query('drop trigger if exists customers_ledger_guard on customers')
			await ctx.pool.query('drop trigger if exists suppliers_ledger_guard on suppliers')
		}
	})

	it('ledger_guard: прямой UPDATE suppliers.balance → P0009', async () => {
		await ctx.pool.query('select install_ledger_guard()')
		try {
			await expect(
				ctx.pool.query(`update suppliers set balance = balance + 1 where company_id=$1 and id=$2`,
					[ctx.companyId, ctx.ids.supplier])
			).rejects.toMatchObject({ code: 'P0009' })
		} finally {
			await ctx.pool.query('drop trigger if exists products_ledger_guard on products')
			await ctx.pool.query('drop trigger if exists customers_ledger_guard on customers')
			await ctx.pool.query('drop trigger if exists suppliers_ledger_guard on suppliers')
		}
	})

	it('ledger_guard: UPDATE products.name (не stock) проходит', async () => {
		await ctx.pool.query('select install_ledger_guard()')
		try {
			await ctx.pool.query(`update products set name = 'Тест-переименование' where company_id=$1 and id=$2`,
				[ctx.companyId, ctx.ids.product])
			const { rows } = await ctx.pool.query(`select name from products where company_id=$1 and id=$2`,
				[ctx.companyId, ctx.ids.product])
			expect(rows[0].name).toBe('Тест-переименование')
		} finally {
			await ctx.pool.query('drop trigger if exists products_ledger_guard on products')
			await ctx.pool.query('drop trigger if exists customers_ledger_guard on customers')
			await ctx.pool.query('drop trigger if exists suppliers_ledger_guard on suppliers')
		}
	})

	it('ledger_guard: post_doc проходит с активным guard', async () => {
		await ctx.pool.query('select install_ledger_guard()')
		try {
			const res = await call(ctx, 'POST', '/v1/documents/post', {
				document: {
					id: 'doc-with-guard',
					type: 'receive',
					warehouseId: ctx.ids.warehouse,
					supplierId: ctx.ids.supplier,
					items: [{ productId: ctx.ids.product, qty: 1, cost: 10 }],
				},
			})
			expect(res.statusCode).toBe(201)
		} finally {
			await ctx.pool.query('drop trigger if exists products_ledger_guard on products')
			await ctx.pool.query('drop trigger if exists customers_ledger_guard on customers')
			await ctx.pool.query('drop trigger if exists suppliers_ledger_guard on suppliers')
		}
	})
})
