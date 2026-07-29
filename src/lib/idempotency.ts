import type pg from 'pg'
import { Errors } from './errors.js'

/**
 * Идемпотентность внутри транзакции операции.
 *
 * Клиенты ретраят запросы из offline-outbox — без этого один чек может
 * списать остаток дважды. Схема:
 *  1. INSERT ключа в той же транзакции, что и сама операция
 *     (упали — всё откатилось, ключ свободен для ретрая);
 *  2. конфликт (company_id, key) с тем же endpoint → операция уже была: отдаём сохранённый ответ;
 *  3. конфликт с ДРУГИМ endpoint → 409 IDEMPOTENCY_MISMATCH (не молча возвращаем чужой ответ);
 *  4. конфликт, но ответа ещё нет → параллельный запрос в полёте → 409 IN_PROGRESS.
 *
 * PK составной — (company_id, key) — иначе одна компания могла бы навсегда
 * заблокировать операции другой предсказуемым ключом.
 * Конкурентный INSERT того же ключа блокируется на PK до
 * COMMIT/ROLLBACK первой транзакции — гонки нет.
 */
export async function claimIdempotencyKey(
	client: pg.PoolClient,
	opts: { key: string; companyId: string; endpoint: string },
): Promise<{ replay: false } | { replay: true; status: number; response: unknown }> {
	const inserted = await client.query(
		`insert into idempotency_keys (company_id, key, endpoint)
		 values ($1, $2, $3)
		 on conflict (company_id, key) do nothing
		 returning key`,
		[opts.companyId, opts.key, opts.endpoint],
	)
	if (inserted.rows.length > 0) return { replay: false }

	const existing = await client.query(
		`select status, response, endpoint from idempotency_keys where company_id = $1 and key = $2`,
		[opts.companyId, opts.key],
	)
	const row = existing.rows[0]
	if (!row) throw Errors.inProgress() // race с чисткой — крайне маловероятно
	if (row.endpoint !== opts.endpoint) throw Errors.idempotencyMismatch(row.endpoint, opts.endpoint)
	if (row.response == null) throw Errors.inProgress()
	return { replay: true, status: row.status ?? 200, response: row.response }
}

export async function storeIdempotentResponse(
	client: pg.PoolClient,
	companyId: string,
	key: string,
	status: number,
	response: unknown,
): Promise<void> {
	await client.query(
		`update idempotency_keys set status = $3, response = $4 where company_id = $1 and key = $2`,
		[companyId, key, status, JSON.stringify(response)],
	)
}
