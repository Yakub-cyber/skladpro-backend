import { saleFingerprint } from '../../src/services/salesV2.js'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import type { Config } from '../../src/config.js'
import { createPool, type DbPool } from '../../src/db.js'
import { makeTokenService } from '../../src/lib/tokens.js'
import { runMigrations } from '../../src/migrate.js'

/**
 * Интеграционные тесты идут по НАСТОЯЩЕЙ базе: реальный HTTP-запрос →
 * реальный роут → реальный post_doc() → реальные реестры.
 *
 * Юнит-тесты на фейковом пуле проверяют, что роут отправил ожидаемый SQL.
 * Здесь проверяется, что после этого SQL получились правильные ЦИФРЫ —
 * а это разные вещи, и вторая важнее.
 *
 * Запуск:
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5432/skladpro_test npm test
 */

export const hasDb = Boolean(process.env.TEST_DATABASE_URL)
export const allowSkipIntegration = Boolean(process.env.ALLOW_SKIP_INTEGRATION)

export function integrationConfig(): Config {
	return {
		NODE_ENV: 'test',
		PORT: 0,
		HOST: '127.0.0.1',
		DATABASE_URL: process.env.TEST_DATABASE_URL!,
		DATABASE_SSL: 'disable',
		DATABASE_SSL_CA: undefined,
		JWT_SECRET: 'integration-secret-integration-secret-integration',
		ACCESS_TOKEN_TTL_MIN: 15,
		REFRESH_TOKEN_TTL_DAYS: 30,
		CORS_ORIGINS: '',
		RATE_LIMIT_MAX: 100_000,
		TRUST_PROXY: false,
		SMTP_URL: undefined,
		SMTP_FROM: undefined,
		APP_URL: 'https://app.skladpro.ru/',
		FIREBASE_CREDENTIALS: undefined,
		AI_SUPPORT_WEBHOOK_URL: undefined,
		AI_SUPPORT_HMAC_SECRET: undefined,
		N8N_SUPPORT_WEBHOOK_URL: undefined,
		N8N_WEBHOOK_SECRET: undefined,
	} as Config
}

export type Ctx = {
	app: FastifyInstance
	pool: DbPool
	token: string
	companyId: string
	userId: string
	ids: Record<string, string>
	close: () => Promise<void>
}

/**
 * Каждый прогон получает СВОЮ компанию со своим uuid — тесты не мешают
 * друг другу и не требуют очистки базы между запусками.
 */
export async function setupIntegration(): Promise<Ctx> {
	const config = integrationConfig()
	const pool = createPool(config)
	await runMigrations(pool, () => undefined)

	const userId = randomUUID()
	const companyId = randomUUID()
	const suffix = companyId.slice(0, 8)

	await pool.query(
		`insert into users (id, email, password_hash, name, active) values ($1,$2,'x','Тест',true)`,
		[userId, `test-${suffix}@example.com`],
	)
	await pool.query(`insert into companies (id, name) values ($1,$2)`, [companyId, `Тест ${suffix}`])
	await pool.query(
		`insert into memberships (user_id, company_id, role, name, active) values ($1,$2,'admin','Тест',true)`,
		[userId, companyId],
	)

	const ids = {
		warehouse: 'w1',
		warehouse2: 'w2',
		account: 'cash',
		product: 'p1',
		unitBase: 'u-sht',
		unitPack: 'u-pack',
		customer: 'c1',
		supplier: 's1',
	}

	await pool.query(`insert into warehouses (company_id, id, name) values ($1,$2,'Основной'), ($1,$3,'Газель')`,
		[companyId, ids.warehouse, ids.warehouse2])
	await pool.query(
		`insert into money_accounts (company_id, id, name, kind, is_default) values ($1,$2,'Касса','cash',true)`,
		[companyId, ids.account])
	await pool.query(
		`insert into products (company_id, id, name, unit, price, cost, stock) values ($1,$2,'Кола 0.5','шт',50,0,0)`,
		[companyId, ids.product])
	await pool.query(
		`insert into product_units (company_id, id, product_id, name, factor, is_base) values
		 ($1,$2,$4,'шт',1,true), ($1,$3,$4,'упак',12,false)`,
		[companyId, ids.unitBase, ids.unitPack, ids.product])
	await pool.query(`insert into customers (company_id, id, name) values ($1,$2,'Магазин Ромашка')`,
		[companyId, ids.customer])
	await pool.query(`insert into suppliers (company_id, id, name) values ($1,$2,'Завод напитков')`,
		[companyId, ids.supplier])

	const tokens = makeTokenService(config)
	const token = await tokens.signAccessToken({ sub: userId, email: `test-${suffix}@example.com`, name: 'Тест' })

	const app = await buildApp({ config, pool, tokens, eventBus: null, fcm: null, metrics: null })

	return {
		app, pool, token, companyId, userId, ids,
		close: async () => {
			await app.close()
			await pool.query('delete from companies where id = $1', [companyId])
			await pool.query('delete from users where id = $1', [userId])
			await pool.end()
		},
	}
}

/** Запрос к API с авторизацией и уникальным ключом идемпотентности. */
export function call(ctx: Ctx, method: 'POST' | 'GET', url: string, payload?: unknown, idemKey?: string) {
	return ctx.app.inject({
		method,
		url,
		payload: payload as never,
		headers: {
			authorization: `Bearer ${ctx.token}`,
			'x-company-id': ctx.companyId,
			...(method === 'POST' ? { 'idempotency-key': idemKey ?? randomUUID() } : {}),
		},
	})
}

/** Остаток по складу — читаем ИЗ РЕЕСТРА, а не из зеркала. */
export async function stockAt(ctx: Ctx, warehouseId: string, productId: string): Promise<number> {
	const { rows } = await ctx.pool.query(
		`select coalesce(sum(qty),0) as qty from stock_movements
		 where company_id=$1 and warehouse_id=$2 and product_id=$3`,
		[ctx.companyId, warehouseId, productId])
	return Number(rows[0].qty)
}

/** Себестоимость на складе из реестра stock_balances. */
export async function costAt(ctx: Ctx, warehouseId: string, productId: string): Promise<{ qty: number; costAmount: number }> {
	const { rows } = await ctx.pool.query(
		`select coalesce(qty,0) as qty, coalesce(cost_amount,0) as cost_amount
		   from stock_balances
		  where company_id=$1 and warehouse_id=$2 and product_id=$3`,
		[ctx.companyId, warehouseId, productId])
	return { qty: Number(rows[0]?.qty ?? 0), costAmount: Number(rows[0]?.cost_amount ?? 0) }
}

/** Долг контрагента из реестра взаиморасчётов: + должен нам, − должны мы. */
export async function debt(ctx: Ctx, kind: 'customer' | 'supplier', partyId: string): Promise<number> {
	const { rows } = await ctx.pool.query(
		`select coalesce(sum(amount),0) as amount from settlement_movements
		 where company_id=$1 and party_kind=$2 and party_id=$3`,
		[ctx.companyId, kind, partyId])
	return Number(rows[0].amount)
}

export async function cash(ctx: Ctx, accountId: string): Promise<number> {
	const { rows } = await ctx.pool.query(
		`select coalesce(sum(amount),0) as amount from money_movements
		 where company_id=$1 and account_id=$2`,
		[ctx.companyId, accountId])
	return Number(rows[0].amount)
}

/** Зеркала обязаны сходиться с реестрами. Возвращает список расхождений. */
export async function drift(ctx: Ctx): Promise<string[]> {
	const problems: string[] = []

	const { rows: stockRows } = await ctx.pool.query(
		`select p.id, p.stock as mirror, coalesce(b.qty,0) as balance, coalesce(m.qty,0) as registry
		   from products p
		   left join (select product_id, sum(qty) qty from stock_balances
		               where company_id=$1 group by 1) b on b.product_id = p.id
		   left join (select product_id, sum(qty) qty from stock_movements
		               where company_id=$1 group by 1) m on m.product_id = p.id
		  where p.company_id=$1`, [ctx.companyId])
	for (const r of stockRows) {
		if (Math.abs(Number(r.mirror) - Number(r.balance)) > 0.0001)
			problems.push(`${r.id}: зеркало ${r.mirror} ≠ остаток ${r.balance}`)
		if (Math.abs(Number(r.balance) - Number(r.registry)) > 0.0001)
			problems.push(`${r.id}: остаток ${r.balance} ≠ реестр ${r.registry}`)
	}

	const { rows: debtRows } = await ctx.pool.query(
		`select c.id, c.balance as mirror, coalesce(s.amount,0) as registry
		   from customers c
		   left join (select party_id, sum(amount) amount from settlement_movements
		               where company_id=$1 and party_kind='customer' group by 1) s on s.party_id = c.id
		  where c.company_id=$1`, [ctx.companyId])
	for (const r of debtRows) {
		if (Math.abs(Number(r.mirror) - Number(r.registry)) > 0.01)
			problems.push(`${r.id}: долг-зеркало ${r.mirror} ≠ реестр ${r.registry}`)
	}

	// Отрицательный остаток — не рассинхрон, а рабочее состояние: товар
	// физически ушёл покупателю, накладную от поставщика ещё не провели.
	// Проверять здесь его нельзя, иначе валидные сценарии падают как «drift».

	const { rows: ghost } = await ctx.pool.query(
		`select m.doc_id from stock_movements m
		   join docs d on d.company_id=m.company_id and d.id=m.doc_id
		  where m.company_id=$1 and d.status <> 'posted' group by 1`, [ctx.companyId])
	for (const r of ghost) problems.push(`движения от распроведённого документа ${r.doc_id}`)

	const { rows: dbl } = await ctx.pool.query(
		`select order_id, count(*) c from docs
		  where company_id=$1 and order_id is not null and status='posted'
		    and doc_type in ('sales_shipment','retail_receipt')
		  group by 1 having count(*) > 1`, [ctx.companyId])
	for (const r of dbl) problems.push(`двойная отгрузка по заказу ${r.order_id}: ${r.c} документа`)

	return problems
}

/** Protected cancellation uses the exact original shipment body, including in races
 * where its posting transaction has not committed yet. Test helper only. */
export function cancelShipmentV2(ctx: Ctx, orderId: string, shipment: {shipmentId: string} & Record<string, unknown>) {
  return call(ctx, 'POST', `/v1/orders/${orderId}/status`, {
    contractVersion: 2, status: 'cancelled', shipmentId: shipment.shipmentId,
    shipmentFingerprint: saleFingerprint({companyId: ctx.companyId, orderId, ...shipment}),
  }, `cancelled:${shipment.shipmentId}`)
}
