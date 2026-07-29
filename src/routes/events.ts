import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { EventBus } from '../lib/events.js'
import { Errors } from '../lib/errors.js'

/**
 * GET /v1/events — Server-Sent Events поток для клиентов.
 * Клиент открывает EventSource, сервер держит соединение и отправляет
 * события своей компании (фильтрация по auth.companyId).
 *
 * Формат SSE: `data: {json}\n\n` каждые несколько секунд + keepalive-комментарий,
 * чтобы прокси/nginx не закрывали idle-соединение.
 *
 * Авторизация: как для остальных эндпоинтов, но токен в EventSource нельзя
 * передать заголовком — поэтому принимаем ?access_token=... как fallback
 * (эквивалент по безопасности: тот же самый JWT, короткий TTL).
 */
const KEEPALIVE_MS = 25_000

export function registerEventRoutes(app: FastifyInstance, eventBus: EventBus) {
	app.get('/v1/events', {}, async (request: FastifyRequest, reply: FastifyReply) => {
		// Fallback для EventSource, который не передаёт заголовков.
		const q = request.query as { access_token?: string } | undefined
		if (q?.access_token && !request.headers.authorization) {
			request.headers.authorization = `Bearer ${q.access_token}`
		}
		try {
			await app.authenticate(request)
		} catch (err) {
			throw err instanceof Error ? err : Errors.unauthorized()
		}
		const auth = request.auth

		reply.raw.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			// SSE через nginx: X-Accel-Buffering: no отключает буферизацию.
			'x-accel-buffering': 'no',
		})
		// Первый event — приветствие с серверным временем.
		reply.raw.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString(), companyId: auth.companyId })}\n\n`)

		let closed = false
		const keepalive = setInterval(() => {
			if (closed) return
			try { reply.raw.write(`: keepalive\n\n`) } catch { /* соединение уже мертво */ }
		}, KEEPALIVE_MS)

		const unsubscribe = await eventBus.subscribe(ev => {
			if (closed) return
			if (ev.companyId !== auth.companyId) return
			try {
				reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`)
			} catch { /* соединение упало */ }
		})

		const cleanup = () => {
			if (closed) return
			closed = true
			clearInterval(keepalive)
			try { unsubscribe() } catch {}
			try { reply.raw.end() } catch {}
		}
		request.raw.on('close', cleanup)
		request.raw.on('error', cleanup)
		reply.raw.on('close', cleanup)
	})
}
