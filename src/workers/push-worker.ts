import type { DbPool } from '../db.js'
import type { EventBus, SkladEvent } from '../services/events.js'
import type { Fcm } from '../services/fcm.js'

/**
 * Push-воркер:
 *  - подписывается на eventBus (LISTEN skladpro_events);
 *  - на события sale/order_status/return/payment достаёт токены компании из
 *    push_tokens и вызывает FCM;
 *  - INVALID_TOKEN ошибки → удаляем токен из БД (перестанем стучаться).
 *
 * Ограничения:
 *  - шлём коротко: title + краткое body; данные для клика — в data.
 *  - НЕ дедупим внутри окна: одна касса → одна продажа → один пуш.
 *    Если это станет проблемой, добавим Redis-набор seen(id) с TTL 30с.
 *  - senderUserId прокидывается в data payload — клиент подавит нотификацию,
 *    если это его собственная операция. На сервере не отсеиваем: push_tokens
 *    не хранят user_id (мы бы не знали, кому какой токен принадлежит),
 *    поэтому решение принимает клиент.
 */
export function startPushWorker(pool: DbPool, eventBus: EventBus, fcm: Fcm, log?: (m: string) => void) {
	if (!fcm.available) return { close: async () => {} }
	let closed = false

	const dispose = eventBus.subscribe(ev => { void handle(ev) }).catch(e => {
		log?.(`push-worker subscribe failed: ${e instanceof Error ? e.message : e}`)
		return () => {}
	})

	async function handle(ev: SkladEvent) {
		if (closed) return
		const msg = renderNotification(ev)
		if (!msg) return
		try {
			const { rows } = await pool.query(
				`select token from push_tokens where company_id = $1`,
				[ev.companyId],
			)
			const tokens = rows.map(r => r.token as string)
			if (!tokens.length) return
			const res = await fcm.send(tokens, msg)
			if (res.invalidTokens.length) {
				await pool.query(`delete from push_tokens where token = any($1)`, [res.invalidTokens])
				log?.(`push-worker удалил ${res.invalidTokens.length} мёртвых токенов`)
			}
		} catch (e) {
			log?.(`push-worker handle error: ${e instanceof Error ? e.message : e}`)
		}
	}

	return {
		close: async () => {
			closed = true
			try { const off = await dispose; off() } catch {}
		},
	}
}

function renderNotification(
	ev: SkladEvent,
): { title: string; body: string; data?: Record<string, string> } | null {
	// Данные в notification — только для attention grabbing.
	// Детали клиент подтянет через /v1/sync/pull при клике.
	// senderUserId — чтобы клиент подавил уведомление о своей же операции.
	const base: Record<string, string> = ev.senderUserId ? { senderUserId: ev.senderUserId } : {}
	switch (ev.type) {
		case 'sale':
			return { title: 'Новая продажа', body: `Чек №${ev.id ?? ''}`.trim(), data: { type: 'sale', id: String(ev.id ?? ''), ...base } }
		case 'order_status':
			return { title: 'Заказ обновлён', body: `Статус заказа №${ev.id ?? ''} изменён`, data: { type: 'order', id: String(ev.id ?? ''), ...base } }
		case 'return':
			return { title: 'Возврат', body: `Возврат по заказу №${ev.id ?? ''}`, data: { type: 'return', id: String(ev.id ?? ''), ...base } }
		case 'payment':
			return { title: 'Оплата от клиента', body: `Погашение долга клиента`, data: { type: 'payment', id: String(ev.id ?? ''), ...base } }
		default:
			return null // document / mark_codes / support_ticket — не пушим (не нужно кассиру)
	}
}
