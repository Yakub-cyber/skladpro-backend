/**
 * Мини-раннер миграций: sql/migrations/*.sql применяются по алфавиту,
 * каждая в своей транзакции, повторно не применяются.
 * Запуск: npm run migrate
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { createPool } from './db.js'

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql', 'migrations')

export async function runMigrations(pool: ReturnType<typeof createPool>, log: (msg: string) => void = console.log) {
	await pool.query(`create table if not exists schema_migrations (
		name text primary key,
		applied_at timestamptz not null default now()
	)`)

	const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort()
	const { rows } = await pool.query('select name from schema_migrations')
	const applied = new Set(rows.map(r => r.name))

	for (const file of files) {
		if (applied.has(file)) continue
		const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
		const client = await pool.connect()
		try {
			await client.query('begin')
			await client.query(sql)
			await client.query('insert into schema_migrations (name) values ($1)', [file])
			await client.query('commit')
			log(`✓ ${file}`)
		} catch (err) {
			await client.query('rollback').catch(() => undefined)
			throw new Error(`Миграция ${file} упала: ${err instanceof Error ? err.message : String(err)}`)
		} finally {
			client.release()
		}
	}
	log('Миграции применены.')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
	const pool = createPool(loadConfig())
	runMigrations(pool)
		.then(() => pool.end())
		.catch(err => {
			console.error(err.message)
			process.exit(1)
		})
}
