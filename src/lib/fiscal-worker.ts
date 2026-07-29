import type { Config } from '../config.js'
import type { DbPool } from '../db.js'
import { decryptSecret } from './crypto-aes.js'
import { publishEvent } from './events.js'
import { makeAtolClient, type AtolClient, type AtolConfig } from './fiscal/atol.js'

/**
 * Fiscal worker — раз в 30 секунд забирает fiscal_receipts со status='processing'
 * и вызывает getReport. При успехе апдейтит FN/FD/FP + status='ready' и шлёт
 * SSE-событие 'sale' (клиент подтянет обновлённую запись через pull).
 *
 * Ретраи 'pending' (были RETRY_LATER на sell): пробуем sell ещё раз, но не
 * чаще N раз (лимит retries=10, потом status='failed' и вручную).
 */
const POLL_INTERVAL_MS = 30_000
const MAX_RETRIES = 10

export type FiscalWorkerDeps = {
	pool: DbPool
	config: Config
	atol?: AtolClient
	log?: (m: string) => void
	pollIntervalMs?: number  // override для тестов
}

export function startFiscalWorker(deps: FiscalWorkerDeps) {
	const atol = deps.atol ?? makeAtolClient()
	if (!deps.config.FISCAL_KMS_KEY) {
		deps.log?.('fiscal-worker: FISCAL_KMS_KEY не задан — воркер не стартует')
		return { close: async () => {} }
	}
	let closed = false
	let timer: NodeJS.Timeout | null = null

	const tick = async () => {
		if (closed) return
		try {
			await runOnce()
		} catch (e) {
			deps.log?.(`fiscal-worker tick error: ${e instanceof Error ? e.message : e}`)
		}
		if (!closed) timer = setTimeout(tick, deps.pollIntervalMs ?? POLL_INTERVAL_MS)
	}

	const runOnce = async () => {
		const { rows } = await deps.pool.query(
			`select r.company_id, r.id, r.sale_id, r.status, r.retries,
			        r.request_body, r.external_id,
			        c.login, c.password_encrypted, c.group_code, c.inn, c.payment_address,
			        c.organization_name, c.sno, c.sender_email
			 from fiscal_receipts r
			 join fiscal_configs c on c.company_id = r.company_id and c.active
			 where r.status in ('pending', 'processing') and r.retries < $1
			 order by r.created_at asc
			 limit 50`,
			[MAX_RETRIES],
		)
		for (const row of rows) {
			if (closed) return
			try {
				const cfg: AtolConfig = {
					login: row.login,
					password: decryptSecret(row.password_encrypted as Buffer, deps.config.FISCAL_KMS_KEY!),
					groupCode: row.group_code,
					inn: row.inn,
					paymentAddress: row.payment_address,
					organizationName: row.organization_name,
					sno: row.sno,
					senderEmail: row.sender_email,
					baseUrl: deps.config.FISCAL_ATOL_BASE_URL,
				}
				if (row.status === 'processing') {
					await handleReport(cfg, row, atol, deps)
				} else if (row.status === 'pending') {
					await handleRetrySell(cfg, row, atol, deps)
				}
			} catch (e) {
				deps.log?.(`fiscal-worker row ${row.id} error: ${e instanceof Error ? e.message : e}`)
			}
		}
	}

	// Стартуем первый тик сразу
	timer = setTimeout(tick, 0)

	return {
		close: async () => {
			closed = true
			if (timer) clearTimeout(timer)
		},
		// для тестов — форсированный один прогон
		runOnce,
	}
}

async function handleReport(cfg: AtolConfig, row: Record<string, unknown>, atol: AtolClient, deps: FiscalWorkerDeps) {
	const uuid = row.external_id as string
	const report = await atol.getReport(cfg, uuid)
	if (report.status === 'wait') {
		await deps.pool.query(
			`update fiscal_receipts set retries = retries + 1 where company_id = $1 and id = $2`,
			[row.company_id, row.id],
		)
		return
	}
	if (report.status === 'done') {
		await deps.pool.query(
			`update fiscal_receipts
			 set status = 'ready', fn = $3, fd = $4, fp = $5, qr = $6, ofd_url = $7,
			     response_body = $8, closed_at = now()
			 where company_id = $1 and id = $2`,
			[row.company_id, row.id, report.fn, report.fd, report.fp, report.qr ?? null, report.ofdUrl ?? null, JSON.stringify(report.raw)],
		)
		// SSE-нотификация клиенту — тот подтянет свежий receipt через GET.
		void publishEvent(deps.pool, {
			companyId: row.company_id as string,
			type: 'sale',
			id: row.sale_id as string,
		})
		deps.log?.(`fiscal-worker: чек ${row.id} готов (FD=${report.fd})`)
		return
	}
	// fail
	await deps.pool.query(
		`update fiscal_receipts set status = 'failed', error_code = 'ATOL_FAIL',
		   error_message = $3, retries = retries + 1
		 where company_id = $1 and id = $2`,
		[row.company_id, row.id, (report.error ?? '').slice(0, 500)],
	)
}

async function handleRetrySell(cfg: AtolConfig, row: Record<string, unknown>, atol: AtolClient, deps: FiscalWorkerDeps) {
	const requestBody = row.request_body as {
		externalId: string
		receipt: Parameters<AtolClient['sell']>[1]['receipt']
	}
	const res = await atol.sell(cfg, {
		externalId: requestBody.externalId,
		receipt: requestBody.receipt,
	})
	if (res.ok) {
		await deps.pool.query(
			`update fiscal_receipts set status = 'processing', external_id = $3,
			   response_body = $4, retries = retries + 1
			 where company_id = $1 and id = $2`,
			[row.company_id, row.id, res.uuid, JSON.stringify({ status: res.status })],
		)
		return
	}
	const finalStatus = res.kind === 'RETRY_LATER' ? 'pending' : 'failed'
	await deps.pool.query(
		`update fiscal_receipts set status = $3, error_code = $4, error_message = $5,
		   retries = retries + 1
		 where company_id = $1 and id = $2`,
		[row.company_id, row.id, finalStatus, res.kind, res.error],
	)
}
