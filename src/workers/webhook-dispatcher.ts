import { createHmac } from 'node:crypto'
import type { DbPool } from '../db.js'
import type { EventBus, SkladEvent } from '../services/events.js'
import type { Metrics } from '../services/metrics.js'
import { fromRequest, logSecurityEvent } from '../services/security-log.js'

/**
 * Диспатчер исходящих webhook'ов.
 *
 * 1. Подписан на eventBus — на каждый SkladEvent enqueue'ит записи в
 *    webhook_deliveries по числу активных endpoint'ов, подписанных на
 *    соответствующий event.
 * 2. Воркер тикает раз в POLL_INTERVAL_MS: выбирает up to 100 due-доставок,
 *    шлёт POST с HMAC-подписью, exp-backoff (1мин, 5мин, 30мин, 2ч, 12ч, 24ч).
 * 3. После MAX_ATTEMPTS — окончательно not delivered, `security_events`
 *    получает 'webhook_delivery_fail', delivered_at остаётся null.
 *
 * Мэппинг SkladEvent → webhook event имя:
 *   sale → sale.created
 *   order_status → order.status_changed
 *   return → return.created
 *   payment → payment.created
 *   fiscal_ready — отдельный path (публикуется из fiscal-worker'а).
 */

const POLL_INTERVAL_MS = 5_000
const BATCH_SIZE = 100
const MAX_ATTEMPTS = 7
// секунд от прошлого фейла до следующей попытки: 1мин, 5мин, 30мин, 2ч, 12ч, 24ч, 24ч
const BACKOFF_SEC = [60, 300, 1800, 7200, 43200, 86400, 86400]

const EVENT_MAP: Partial<Record<SkladEvent['type'], string>> = {
	sale: 'sale.created',
	order_status: 'order.status_changed',
	return: 'return.created',
	payment: 'payment.created',
}

let metricsRef: Metrics | null = null
export function bindWebhookMetrics(metrics: Metrics | null) {
	metricsRef = metrics
}

export type WebhookDispatcherDeps = {
	pool: DbPool
	eventBus: EventBus
	log?: (m: string) => void
	pollIntervalMs?: number
	fetchImpl?: typeof fetch  // для тестов
}

export function startWebhookDispatcher(deps: WebhookDispatcherDeps) {
	let closed = false
	let timer: NodeJS.Timeout | null = null
	const fetchImpl = deps.fetchImpl ?? fetch

	// Подписка на eventBus: на каждое событие enqueue'им доставки.
	const disposePromise = deps.eventBus.subscribe(ev => { void enqueue(ev) }).catch(e => {
		deps.log?.(`webhook-dispatcher subscribe failed: ${e instanceof Error ? e.message : e}`)
		return () => {}
	})

	async function enqueue(ev: SkladEvent) {
		const eventName = EVENT_MAP[ev.type]
		if (!eventName) return  // document/mark_codes/support_ticket не рассылаем наружу
		try {
			// insert into webhook_deliveries for each endpoint подписанного на этот event
			await deps.pool.query(
				`insert into webhook_deliveries (company_id, endpoint_id, event, payload)
				 select $1, id, $2, $3
				 from webhook_endpoints
				 where company_id = $1 and active and $2 = any(events)`,
				[ev.companyId, eventName, JSON.stringify({
					event: eventName,
					at: ev.at,
					companyId: ev.companyId,
					data: { id: ev.id, senderUserId: ev.senderUserId ?? null },
				})],
			)
		} catch (e) {
			deps.log?.(`webhook-dispatcher enqueue error: ${e instanceof Error ? e.message : e}`)
		}
	}

	async function tick() {
		if (closed) return
		try {
			await deliverBatch()
		} catch (e) {
			deps.log?.(`webhook-dispatcher tick error: ${e instanceof Error ? e.message : e}`)
		}
		if (!closed) timer = setTimeout(tick, deps.pollIntervalMs ?? POLL_INTERVAL_MS)
	}

	async function deliverBatch() {
		const { rows } = await deps.pool.query(
			`select d.id, d.company_id, d.endpoint_id, d.event, d.payload, d.attempts,
			        e.url, e.secret
			 from webhook_deliveries d
			 join webhook_endpoints e on e.id = d.endpoint_id and e.company_id = d.company_id
			 where d.delivered_at is null and d.attempts < $1 and d.next_retry_at <= now()
			 order by d.next_retry_at asc
			 limit $2`,
			[MAX_ATTEMPTS, BATCH_SIZE],
		)
		for (const row of rows) {
			if (closed) return
			await deliverOne(row).catch(e => deps.log?.(`webhook-dispatcher deliver error: ${e instanceof Error ? e.message : e}`))
		}
	}

	async function deliverOne(row: Record<string, unknown>) {
		const payload = JSON.stringify(row.payload)
		const timestamp = Math.floor(Date.now() / 1000).toString()
		const signature = createHmac('sha256', row.secret as string)
			.update(`${timestamp}.${payload}`).digest('hex')
		let status = 0
		let error: string | null = null
		try {
			const res = await fetchImpl(row.url as string, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Skladpro-Event': row.event as string,
					'X-Skladpro-Timestamp': timestamp,
					'X-Skladpro-Signature': `sha256=${signature}`,
				},
				body: payload,
				// таймаут 15 сек — за это время endpoint должен либо принять, либо мы retry.
				signal: AbortSignal.timeout(15_000),
			})
			status = res.status
			if (!res.ok) error = `HTTP ${status}`
		} catch (e) {
			error = e instanceof Error ? e.message.slice(0, 300) : 'unknown'
			status = 0
		}

		if (!error) {
			// Успех — фиксируем delivered_at.
			await deps.pool.query(
				`update webhook_deliveries set delivered_at = now(),
				   attempts = attempts + 1, last_status = $2, last_error = null
				 where id = $1`,
				[row.id, status],
			)
			await deps.pool.query(
				`update webhook_endpoints set last_delivery_at = now()
				 where company_id = $1 and id = $2`,
				[row.company_id, row.endpoint_id],
			)
			metricsRef?.webhookDeliveries.inc({ status: 'ok' })
			return
		}

		const attempts = (row.attempts as number) + 1
		if (attempts >= MAX_ATTEMPTS) {
			await deps.pool.query(
				`update webhook_deliveries set attempts = $2, last_status = $3, last_error = $4
				 where id = $1`,
				[row.id, attempts, status, error],
			)
			metricsRef?.webhookDeliveries.inc({ status: 'failed' })
			await logSecurityEvent(deps.pool, 'webhook_delivery_fail', fromRequest({ ip: null, headers: {}, auth: { companyId: row.company_id } } as never, {
				companyId: row.company_id as string,
				meta: { endpointId: row.endpoint_id, event: row.event, error, status, attempts },
			}))
			return
		}
		const nextSec = BACKOFF_SEC[attempts - 1] ?? BACKOFF_SEC[BACKOFF_SEC.length - 1]!
		await deps.pool.query(
			`update webhook_deliveries set attempts = $2, last_status = $3, last_error = $4,
			   next_retry_at = now() + make_interval(secs => $5)
			 where id = $1`,
			[row.id, attempts, status, error, nextSec],
		)
		metricsRef?.webhookDeliveries.inc({ status: 'retry' })
	}

	timer = setTimeout(tick, 0)

	return {
		close: async () => {
			closed = true
			if (timer) clearTimeout(timer)
			try { const off = await disposePromise; off() } catch {}
		},
		// для тестов
		enqueue,
		deliverBatch,
	}
}
