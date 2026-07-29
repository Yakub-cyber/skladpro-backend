import { readFileSync } from 'node:fs'
import pg from 'pg'
import type { Config } from './config.js'

// pg по умолчанию возвращает NUMERIC (OID 1700) как строку — «12.5», а не 12.5,
// потому что произвольная точность не влезает в JS number. Наши количества/суммы
// умещаются в float64 без потерь (округляем до 2/4 знаков в бизнес-логике),
// поэтому даём клиентам ответ в человеческом виде.
// BIGINT (OID 20) оставляем строкой (курсоры row_version).
pg.types.setTypeParser(1700, v => (v == null ? null : Number(v)))

export type Queryable = {
	query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>
}

export type DbPool = Queryable & {
	connect: () => Promise<pg.PoolClient>
	end: () => Promise<void>
}

function sslConfig(config: Config): pg.PoolConfig['ssl'] {
	switch (config.DATABASE_SSL) {
		case 'disable':
			return undefined
		case 'require':
			// TLS есть, CA не проверяется — только для переходного периода.
			return { rejectUnauthorized: false }
		case 'verify':
			return {
				rejectUnauthorized: true,
				ca: config.DATABASE_SSL_CA ? readFileSync(config.DATABASE_SSL_CA, 'utf8') : undefined,
			}
	}
}

export function createPool(config: Config): DbPool {
	return new pg.Pool({
		connectionString: config.DATABASE_URL,
		max: 10,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 10_000,
		ssl: sslConfig(config),
	})
}

/**
 * Транзакция с автоматическим ROLLBACK при исключении.
 * Все денежные/складские операции идут только через неё.
 */
export async function withTransaction<T>(pool: DbPool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect()
	try {
		await client.query('begin')
		const result = await fn(client)
		await client.query('commit')
		return result
	} catch (err) {
		try {
			await client.query('rollback')
		} catch {
			// соединение могло умереть — pool сам его выкинет
		}
		throw err
	} finally {
		client.release()
	}
}
