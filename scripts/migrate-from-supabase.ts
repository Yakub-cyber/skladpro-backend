/**
 * Разовый перенос данных Supabase → собственный Postgres.
 *
 * Запуск:  npm run migrate:from-supabase
 * Нужны env: SUPABASE_DATABASE_URL (старая БД) и DATABASE_URL (новая, с уже
 * применёнными миграциями: npm run migrate).
 *
 * Переносит: пользователей (включая bcrypt-хэши паролей GoTrue — вход по старым
 * паролям сохраняется!), компании, membership'ы, приглашения, настройки и все
 * таблицы данных с company_id. Строки без company_id (бесхозные) пропускаются.
 * Скрипт идемпотентен: повторный запуск делает upsert, ничего не дублируя.
 */
import 'dotenv/config'
import pg from 'pg'
import { isBcryptHash } from '../src/lib/passwords.js'

const SRC = process.env.SUPABASE_DATABASE_URL
const DST = process.env.DATABASE_URL
if (!SRC || !DST) {
	console.error('Нужны SUPABASE_DATABASE_URL и DATABASE_URL в .env')
	process.exit(1)
}

const src = new pg.Pool({ connectionString: SRC, max: 3, ssl: { rejectUnauthorized: false } })
const dst = new pg.Pool({
	connectionString: DST,
	max: 3,
	ssl: /localhost|127\.0\.0\.1/.test(DST) ? undefined : { rejectUnauthorized: false },
})

// Колонки, общие для старой и новой схемы (новые: company_id обязателен).
const DATA_TABLES: Record<string, string[]> = {
	price_types: ['id', 'name', 'color', 'is_default', 'sort', 'updated_at'],
	warehouses: ['id', 'name', 'address', 'updated_at'],
	cells: ['id', 'warehouse_id', 'code', 'zone', 'x', 'y', 'updated_at'],
	products: [
		'id', 'sku', 'name', 'category', 'unit', 'price', 'cost', 'stock', 'min_stock', 'cell',
		'warehouse_id', 'tags', 'barcode', 'weighted', 'plu', 'marked', 'image', 'codes', 'prices',
		'created_at', 'updated_at',
	],
	customers: [
		'id', 'name', 'type', 'city', 'contact', 'phone', 'email', 'total_spent', 'bonus', 'since',
		'price_type_id', 'balance', 'updated_at',
	],
	suppliers: ['id', 'name', 'category', 'phone', 'city', 'updated_at'],
	employees: ['id', 'name', 'role', 'phone', 'active', 'updated_at'], // pin (plaintext) сознательно НЕ переносим
	orders: [
		'id', 'no', 'customer_id', 'customer_name', 'items', 'subtotal', 'discount', 'total',
		'price_type_id', 'on_credit', 'status', 'stock_consumed', 'priority', 'courier',
		'assigned_to', 'address', 'shift_id', 'track', 'created_at', 'updated_at',
	],
	invoices: ['id', 'no', 'kind', 'party', 'party_id', 'items', 'total', 'price_type_id', 'source', 'created_at', 'updated_at'],
	documents: [
		'id', 'no', 'type', 'status', 'items', 'to_warehouse_id', 'reason', 'note', 'total_qty',
		'by', 'created_at', 'posted_at', 'cancelled_at', 'updated_at',
	],
	movements: ['id', 'type', 'product_id', 'name', 'qty', 'delta', 'reason', 'by', 'at', 'updated_at'],
	shifts: [
		'id', 'user_id', 'opened_at', 'closed_at', 'opening_cash', 'closing_cash', 'revenue',
		'orders_count', 'moves_count', 'updated_at',
	],
	audit: ['id', 'at', 'by', 'title', 'section', 'type', 'updated_at'],
}

const q = (name: string) => `"${name}"`

async function main() {
	console.log('→ Пользователи (auth.users)…')
	const users = await src.query(
		`select id, email, encrypted_password, coalesce(raw_user_meta_data->>'name', null) as name, created_at
		 from auth.users where email is not null`,
	)
	let carried = 0
	for (const u of users.rows) {
		const hashOk = isBcryptHash(u.encrypted_password)
		if (hashOk) carried++
		await dst.query(
			`insert into users (id, email, password_hash, name, must_reset, created_at)
			 values ($1, $2, $3, $4, $5, $6)
			 on conflict (id) do update set email = excluded.email`,
			[
				u.id,
				u.email,
				hashOk ? u.encrypted_password : 'IMPORTED_NO_HASH',
				u.name,
				!hashOk, // без хэша — потребуется сброс пароля
				u.created_at,
			],
		)
	}
	console.log(`  ${users.rows.length} пользователей (${carried} со старым паролем, ${users.rows.length - carried} потребуют сброса)`)

	console.log('→ Компании…')
	const companies = await src.query(`select id, name, plan, created_at from public.companies`)
	for (const c of companies.rows) {
		await dst.query(
			`insert into companies (id, name, plan, created_at) values ($1,$2,$3,$4)
			 on conflict (id) do update set name = excluded.name, plan = excluded.plan`,
			[c.id, c.name, c.plan ?? 'free', c.created_at],
		)
	}
	console.log(`  ${companies.rows.length}`)

	console.log('→ Membership…')
	const memberships = await src.query(`select user_id, company_id, role, name, active, created_at from public.memberships`)
	for (const m of memberships.rows) {
		await dst.query(
			`insert into memberships (user_id, company_id, role, name, active, created_at)
			 values ($1,$2,$3,$4,$5,$6)
			 on conflict (user_id, company_id) do update set role = excluded.role, active = excluded.active`,
			[m.user_id, m.company_id, m.role ?? 'stock', m.name, m.active ?? true, m.created_at],
		)
	}
	console.log(`  ${memberships.rows.length}`)

	console.log('→ Приглашения…')
	const invitations = await src.query(`select company_id, email, role, name, created_at from public.invitations`)
	for (const i of invitations.rows) {
		await dst.query(
			`insert into invitations (company_id, email, role, name, created_at)
			 select $1,$2,$3,$4,$5
			 where not exists (select 1 from invitations where company_id = $1 and lower(email) = lower($2))`,
			[i.company_id, i.email, i.role ?? 'stock', i.name, i.created_at],
		)
	}
	console.log(`  ${invitations.rows.length}`)

	console.log('→ Настройки…')
	const settings = await src.query(`select company_id, data, updated_at from public.settings`)
	for (const s of settings.rows) {
		await dst.query(
			`insert into settings (company_id, data) values ($1, $2)
			 on conflict (company_id) do update set data = excluded.data`,
			[s.company_id, s.data],
		)
	}
	console.log(`  ${settings.rows.length}`)

	for (const [table, cols] of Object.entries(DATA_TABLES)) {
		console.log(`→ ${table}…`)
		const srcCols = ['company_id', ...cols].map(q).join(', ')
		const { rows } = await src.query(
			`select ${srcCols} from public.${q(table)} where company_id is not null`,
		)
		let n = 0
		for (const row of rows) {
			const insertCols = ['company_id', ...cols]
			const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ')
			const updates = cols.map(c => `${q(c)} = excluded.${q(c)}`).join(', ')
			const values = insertCols.map(c => {
				const v = row[c]
				return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v
			})
			await dst.query(
				`insert into ${q(table)} (${insertCols.map(q).join(', ')})
				 values (${placeholders})
				 on conflict (company_id, id) do update set ${updates}`,
				values,
			)
			n++
		}
		console.log(`  ${n}`)
	}

	console.log('\nГотово. Проверьте выборочно данные и попросите пользователей без пароля сбросить его.')
}

main()
	.catch(err => {
		console.error('Ошибка переноса:', err.message)
		process.exitCode = 1
	})
	.finally(async () => {
		await src.end()
		await dst.end()
	})
