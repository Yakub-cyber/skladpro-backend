import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { ApiError, Errors } from '../lib/errors.js'
import { checkLimit, type LimitFeature } from '../services/subscription.js'

/**
 * Синхронизация offline-first клиентов.
 *
 * PULL: по монотонному row_version (bigserial, ставится триггером), а не
 * по updated_at. Времена НЕЛЬЗЯ использовать курсором: now() = время начала
 * транзакции, коммит позже — строка «в прошлом» относительно ушедшего вперёд
 * курсора и теряется навсегда. row_version инкрементируется при каждой записи,
 * ORDER BY monotonic → пропусков нет.
 *
 * PUSH: батч из клиентского outbox. Whitelist таблиц/колонок; LWW-защита
 * (не откатываем более новую серверную версию клиентской старой); запрет
 * вернуть tombstone-упокоенную строку через upsert; для orders запрещены
 * статусы, влияющие на остатки (они меняются только /v1/orders/:id/status).
 */

// Таблица → колонки, которые клиент может писать. company_id/updated_at/row_version/deleted_at
// проставляет сервер. Чего нет в списке — молча отбрасывается.
const PUSH_WHITELIST: Record<string, string[]> = {
	price_types: ['name', 'color', 'is_default', 'sort'],
	warehouses: ['name', 'address'],
	cells: ['warehouse_id', 'code', 'zone', 'x', 'y'],
	// stock/batches/cost НЕ здесь: остатки меняют только бизнес-эндпоинты.
	products: [
		'sku', 'name', 'category', 'unit', 'price', 'min_stock', 'cell', 'warehouse_id',
		'tags', 'barcode', 'weighted', 'plu', 'marked', 'vat', 'image', 'codes', 'prices',
	],
	// balance/total_spent/bonus/since ведёт СЕРВЕР (при продаже, оплате, возврате),
	// иначе LWW двух устройств теряет инкременты.
	customers: ['name', 'type', 'city', 'contact', 'phone', 'email', 'price_type_id'],
	suppliers: ['name', 'category', 'phone', 'city'],
	// pin_hash/user_id/role НЕ здесь. Роль сотрудника — только через админ-эндпоинт (защита от эскалации).
	employees: ['name', 'phone', 'active'],
	// status/items НЕ здесь: их изменения ломают учёт остатков.
	// Заказ создаётся с базовыми полями; переходы — /v1/orders/:id/status.
	orders: [
		'no', 'customer_id', 'customer_name', 'subtotal', 'discount', 'total',
		'price_type_id', 'on_credit', 'priority', 'courier', 'assigned_to',
		'address', 'shift_id', 'track', 'created_at',
	],
	invoices: ['no', 'kind', 'party', 'party_id', 'items', 'total', 'price_type_id', 'source', 'created_at'],
	shifts: [
		'user_id', 'opened_at', 'closed_at', 'opening_cash', 'closing_cash',
		'revenue', 'orders_count', 'moves_count',
	],
}
// movements, audit, documents — только сервер. settings — отдельные эндпоинты ниже.

// Пары (таблица → набор колонок), которые клиенту НЕ отдаём.
// Ролевая фильтрация ниже.
const PULL_EXCLUDE_BASE: Record<string, string[]> = {
	employees: ['pin_hash'],
}

// Курьер видит только то, что нужно для доставки. Больше — потенциальная утечка
// коммерческой тайны и PII.
const COURIER_TABLES = new Set(['orders', 'customers', 'warehouses', 'cells', 'employees'])
const COURIER_EXTRA_EXCLUDE: Record<string, string[]> = {
	products: ['cost', 'batches', 'min_stock', 'prices'],
	movements: ['cost'],
	customers: ['balance', 'bonus', 'total_spent'],
	orders: ['discount', 'subtotal'],
	stock_balances: ['cost_amount'],
	doc_lines: ['price', 'cost_amount'],
}

const PULL_TABLES = Object.freeze([
	'price_types', 'warehouses', 'cells', 'products', 'customers', 'suppliers',
	'employees', 'orders', 'invoices', 'documents', 'movements', 'shifts', 'audit',
	'docs', 'doc_lines', 'product_units', 'money_accounts', 'stock_balances',
	'product_aliases', 'doc_counters',
] as const)
const PULL_TABLES_SET = new Set(PULL_TABLES)

const PullQuery = z.object({
	// Курсор — bigint как строка (числа JS теряют точность после 2^53).
	since: z.string().regex(/^\d{1,20}$/).optional(),
	table: z.enum(PULL_TABLES).optional(),
	limit: z.coerce.number().int().min(1).max(1000).default(500),
})

const PushOp = z.object({
	table: z.string().min(1).max(40).regex(/^[a-z_]+$/),
	op: z.enum(['upsert', 'delete']),
	// updated_at клиента: чтобы сервер отверг перезапись более свежей версии.
	clientUpdatedAt: z.string().datetime({ offset: true }).optional(),
	row: z.record(z.unknown()),
})
const PushBody = z.object({ ops: z.array(PushOp).min(1).max(500) })

const ID_RE = /^[\w:.-]{1,64}$/

export function registerSyncRoutes(app: FastifyInstance, pool: DbPool) {
	app.get('/v1/sync/pull', { preHandler: app.authenticate }, async request => {
		const parsed = PullQuery.safeParse(request.query)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { since, table, limit } = parsed.data
		const auth = request.auth
		const requested = table ? [table] : [...PULL_TABLES]
		const allowedTables = auth.role === 'courier' ? requested.filter(t => COURIER_TABLES.has(t)) : requested

		// Курсор ≥ 0; для bigint передаём как строку — pg сам приведёт к bigint.
		const cursor = since ?? '0'

		const out: Record<
			string,
			{ rows: unknown[]; hasMore: boolean; cursor: string | null }
		> = {}
		for (const t of allowedTables) {
			const exclude = new Set([
				...(PULL_EXCLUDE_BASE[t] ?? []),
				...(auth.role === 'courier' ? COURIER_EXTRA_EXCLUDE[t] ?? [] : []),
			])
			const { rows } = await pool.query(
				`select * from ${t}
				 where company_id = $1
				   and row_version > $2::bigint
				 order by row_version asc
				 limit $3`,
				[auth.companyId, cursor, limit + 1],
			)
			const hasMore = rows.length > limit
			const page = hasMore ? rows.slice(0, limit) : rows
			const last = page[page.length - 1]
			out[t] = {
				rows: page.map(r => {
					const { company_id: _cid, ...rest } = r
					for (const col of exclude) delete rest[col]
					// row_version в JSON — строкой, чтобы клиент не сломал точность 64-битного числа.
					if (rest.row_version != null) rest.row_version = String(rest.row_version)
					return rest
				}),
				hasMore,
				cursor: last ? String(last.row_version) : null,
			}
		}
		return { serverTime: new Date().toISOString(), tables: out }
	})

	app.post('/v1/sync/push', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (auth.role === 'courier') throw Errors.forbidden('Курьеру запись недоступна')

		const parsed = PushBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)

		const results: Array<{ ok: boolean; error?: string; code?: string }> = []
		for (const op of parsed.data.ops) {
			try {
				results.push(await applyOp(pool, auth, op))
			} catch (err) {
				// Одна ядовитая запись не валит батч.
				results.push({ ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'unknown' })
			}
		}
		return { results }
	})

	// Настройки компании (jsonb целиком).
	app.get('/v1/settings', { preHandler: app.authenticate }, async request => {
		const { rows } = await pool.query(`select data, updated_at from settings where company_id = $1`, [
			request.auth.companyId,
		])
		return { data: rows[0]?.data ?? {}, updatedAt: rows[0]?.updated_at ?? null }
	})

	app.put('/v1/settings', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (auth.role === 'courier') throw Errors.forbidden()
		const body = z.object({ data: z.record(z.unknown()) }).safeParse(request.body)
		if (!body.success) throw Errors.validation(body.error.issues)
		await pool.query(
			`insert into settings (company_id, data) values ($1, $2)
			 on conflict (company_id) do update set data = excluded.data`,
			[auth.companyId, JSON.stringify(body.data.data)],
		)
		return { ok: true }
	})
}

async function applyOp(
	pool: DbPool,
	auth: { companyId: string; role: string },
	op: {
		table: string
		op: 'upsert' | 'delete'
		clientUpdatedAt?: string
		row: Record<string, unknown>
	},
): Promise<{ ok: boolean; error?: string; code?: string }> {
	// Object.hasOwn — иначе `PUSH_WHITELIST['constructor']` возвращает функцию Object.prototype.
	if (!Object.hasOwn(PUSH_WHITELIST, op.table)) {
		return { ok: false, error: `Таблица ${op.table} доступна только через бизнес-эндпоинты API`, code: 'TABLE_FORBIDDEN' }
	}
	const allowedCols = PUSH_WHITELIST[op.table]!

	const id = op.row.id
	if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'Некорректный id', code: 'BAD_ID' }

	// Читаем текущее состояние строки в компании: нужно и для LWW,
	// и для запрета воскрешения tombstone, и для машины состояний заказа.
	const existing = await pool.query(
		`select updated_at, deleted_at, ${op.table === 'orders' ? 'stock_consumed, status' : "null as stock_consumed, null as status"}
		 from ${op.table} where company_id = $1 and id = $2`,
		[auth.companyId, id],
	)
	const current = existing.rows[0] as
		| { updated_at: Date; deleted_at: Date | null; stock_consumed: boolean | null; status: string | null }
		| undefined

	// LWW: если серверная версия свежее клиентской — операция отбрасывается.
	if (current && op.clientUpdatedAt) {
		const serverTs = new Date(current.updated_at).getTime()
		const clientTs = new Date(op.clientUpdatedAt).getTime()
		if (Number.isFinite(clientTs) && clientTs + 1 < serverTs) {
			return { ok: false, error: 'Серверная версия свежее', code: 'STALE' }
		}
	}

	// Запрет воскрешения tombstone для orders со списанным остатком: если бы
	// клиент вернул отменённый/удалённый заказ, cancel/return потом задвоил бы остаток.
	if (op.op === 'upsert' && op.table === 'orders' && current?.deleted_at && current?.stock_consumed) {
		return { ok: false, error: 'Заказ удалён после отгрузки, восстановить нельзя', code: 'TOMBSTONE_LOCKED' }
	}

	if (op.op === 'delete') {
		// Удалять заказ, по которому был движ на складе, нельзя — иначе теряются
		// возможности возврата/аудита.
		if (op.table === 'orders' && current?.stock_consumed) {
			return { ok: false, error: 'Заказ с движением остатка удалять нельзя', code: 'HAS_STOCK_MOVEMENT' }
		}
		await pool.query(`update ${op.table} set deleted_at = now() where company_id = $1 and id = $2`, [
			auth.companyId,
			id,
		])
		return { ok: true }
	}

	// B2: enforcement лимитов плана. Проверяем только при СОЗДАНИИ (upsert
	// без current), чтобы не блочить update существующего товара при апгрейде.
	// Если строка была стёрта (deleted_at) и восстанавливаем — тоже считаем
	// как «новую» единицу.
	const LIMIT_TABLES: Partial<Record<string, LimitFeature>> = {
		products: 'products',
		warehouses: 'warehouses',
		employees: 'employees',
	}
	if (op.op === 'upsert' && !!LIMIT_TABLES[op.table] && (!current || current.deleted_at)) {
		const feature = LIMIT_TABLES[op.table]!
		const { rows: cnt } = await pool.query(
			`select count(*)::int as c from ${op.table}
			 where company_id = $1 and deleted_at is null`,
			[auth.companyId],
		)
		const currentCount = Number(cnt[0]?.c ?? 0)
		const limitResult = await checkLimit(pool, auth.companyId, feature, currentCount + 1)
		if (!limitResult.ok) {
			// Возвращаем в структуре push-op result, не throw'ем — чтобы одна
			// строка не валила весь батч. Клиент увидит code='SUBSCRIPTION_LIMIT_EXCEEDED'
			// и покажет UpgradeModal (Errors.subscriptionLimit кладёт details.plan/limit,
			// но здесь мы возвращаем плоским объектом — метрику всё равно инкрементируем).
			const err = new ApiError(
				402,
				'SUBSCRIPTION_LIMIT_EXCEEDED',
				`Лимит плана «${limitResult.plan}» на ${feature} исчерпан (${limitResult.current}/${limitResult.limit}).`,
				{ feature, limit: limitResult.limit, current: limitResult.current, plan: limitResult.plan },
			)
			return { ok: false, error: err.message, code: err.code }
		}
	}

	const cols: string[] = []
	const values: unknown[] = []
	for (const col of allowedCols) {
		if (col in op.row) {
			cols.push(col)
			const v = op.row[col]
			values.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v)
		}
	}

	const insertCols = ['company_id', 'id', ...cols]
	const placeholders = insertCols.map((_, i) => `$${i + 1}`)
	// Сохраняем deleted_at (не воскрешаем), если уже стоит.
	const updates = cols.map(c => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)

	await pool.query(
		`insert into ${op.table} (${insertCols.map(quoteIdent).join(', ')})
		 values (${placeholders.join(', ')})
		 on conflict (company_id, id) do update set ${updates.join(', ')}`,
		[auth.companyId, id, ...values],
	)
	return { ok: true }
}

function quoteIdent(name: string): string {
	if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier: ${name}`)
	return `"${name}"`
}

export { PUSH_WHITELIST, PULL_TABLES, PULL_TABLES_SET }
