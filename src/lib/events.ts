import type pg from 'pg'
import type { DbPool } from '../db.js'

/**
 * Realtime-события через PostgreSQL LISTEN/NOTIFY.
 *
 * Плюсы такой схемы:
 *   • не нужен Redis / отдельный broker: сервер уже держит соединение с PG;
 *   • при рестарте API-инстанса подписки восстанавливаются сами (клиенты
 *     переподключаются к SSE, сервер снова LISTEN);
 *   • горизонтальное масштабирование: каждый инстанс держит свой LISTEN,
 *     сервер PG рассылает NOTIFY всем — sticky sessions не нужны.
 *
 * Канал: `skladpro_events`. Payload: JSON вида
 *   { companyId, type, id?, at }
 * Ограничение payload — 8 КБ (PG NOTIFY limit); мы шлём только id операции,
 * клиент делает pull за подробностями.
 */
export type SkladEvent = {
	companyId: string
	type: 'sale' | 'document' | 'order_status' | 'return' | 'payment' | 'mark_codes' | 'support_ticket'
	id?: string | null
	/**
	 * Инициатор события (userId, если запрос был аутентифицирован). Клиент,
	 * которому пуш прилетит от FCM, должен подавить нотификацию, если это его
	 * собственная операция — иначе кассир видит пуш о чеке, который он только
	 * что пробил. Хранить не обязательно; поле опционально.
	 */
	senderUserId?: string | null
	at: string
}

const CHANNEL = 'skladpro_events'

/**
 * Опубликовать событие в PG NOTIFY.
 * Вызывается ВНЕ основной транзакции операции (чтобы NOTIFY не откатился
 * при её rollback'e; если событие потеряется — клиенты всё равно узнают
 * из следующего pull). Тихо съедаем ошибку — не блокируем бизнес-операцию.
 */
export async function publishEvent(pool: DbPool, ev: Omit<SkladEvent, 'at'>): Promise<void> {
	try {
		const payload: SkladEvent = { ...ev, at: new Date().toISOString() }
		const str = JSON.stringify(payload)
		if (str.length > 7500) return // защита от переполнения (маловероятно)
		await pool.query(`select pg_notify($1, $2)`, [CHANNEL, str])
	} catch {
		// noop — realtime это best-effort, клиенты дошлифуют через pull
	}
}

export type EventListener = (event: SkladEvent) => void

/**
 * Постоянное соединение LISTEN. Один экземпляр на процесс API — раздаёт события
 * всем подписчикам (SSE-клиентам) через диспетчер.
 */
export function createEventBus(pool: DbPool) {
	const listeners = new Set<EventListener>()
	let client: pg.PoolClient | null = null
	let connecting: Promise<void> | null = null
	let closed = false

	async function connect() {
		if (client || closed) return
		if (connecting) return connecting
		connecting = (async () => {
			try {
				const c = await pool.connect()
				c.on('notification', (msg) => {
					if (msg.channel !== CHANNEL || !msg.payload) return
					try {
						const ev = JSON.parse(msg.payload) as SkladEvent
						for (const cb of listeners) { try { cb(ev) } catch {} }
					} catch { /* игнорируем битый payload */ }
				})
				c.on('error', () => {
					// Пул сам вернёт клиент; переподключимся при следующем subscribe.
					try { c.release(true) } catch {}
					client = null
				})
				await c.query(`listen ${CHANNEL}`)
				client = c
			} finally {
				connecting = null
			}
		})()
		return connecting
	}

	async function subscribe(cb: EventListener): Promise<() => void> {
		listeners.add(cb)
		if (!client) await connect().catch(() => {})
		return () => listeners.delete(cb)
	}

	async function close() {
		closed = true
		listeners.clear()
		if (client) { try { await client.query(`unlisten ${CHANNEL}`) } catch {} client.release(); client = null }
	}

	return { subscribe, close }
}

export type EventBus = ReturnType<typeof createEventBus>
