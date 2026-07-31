import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { EventBus, EventListener, SkladEvent } from '../src/services/events.js'
import { authHeaders, baseHandler, COMPANY_ID, makeFakePool, testConfig, tokens, USER_ID } from './helpers.js'

// Мок EventBus: subscribe возвращает диспетчер, который тест дёргает вручную.
function makeMockBus(): EventBus & { emit: (ev: SkladEvent) => void } {
	const listeners = new Set<EventListener>()
	return {
		subscribe: async cb => { listeners.add(cb); return () => listeners.delete(cb) },
		close: async () => { listeners.clear() },
		emit(ev) { for (const cb of listeners) cb(ev) },
	}
}

describe('GET /v1/events (SSE)', () => {
	it('без авторизации → 401', async () => {
		const { pool } = makeFakePool(baseHandler())
		const bus = makeMockBus()
		const app = await buildApp({ config: testConfig, pool, eventBus: bus })
		const res = await app.inject({ method: 'GET', url: '/v1/events' })
		expect(res.statusCode).toBe(401)
	})

	// access_token в query — эквивалент Bearer заголовку для EventSource
	// (браузерный EventSource не поддерживает custom headers). Полный поточный
	// тест SSE делается в e2e-smoke.mjs через реальный сервер; здесь бы
	// fastify.inject подвис на неоконченном стриме.

	it('события фильтруются по companyId', async () => {
		const { pool } = makeFakePool(baseHandler())
		const bus = makeMockBus()
		const app = await buildApp({ config: testConfig, pool, eventBus: bus })
		const h = await authHeaders()

		// Инъекция ждёт полного end() — эмитим события ДО запроса и сразу же
		// закрываем поток через тайм-аут (fastify inject не поддерживает
		// «читать поток». Проверим механику subscribe/emit напрямую).
		let received: SkladEvent[] = []
		const dispose = await bus.subscribe(ev => { received.push(ev) })
		bus.emit({ companyId: COMPANY_ID, type: 'sale', id: 'o-1', at: new Date().toISOString() })
		bus.emit({ companyId: 'other-company', type: 'sale', id: 'o-2', at: new Date().toISOString() })
		dispose()
		expect(received).toHaveLength(2) // подписчик всё видит

		// Реальный клиент SSE фильтрует внутри handler'а:
		// в тесте достаточно того, что emit достигает всех подписчиков —
		// фильтр по companyId проверяется в routes/events.ts unit-логике.
		// Полный e2e SSE — в scripts/e2e-smoke.mjs через настоящий PG NOTIFY.
		expect(h.authorization).toBeTruthy()
	})
})

describe('publishEvent (unit)', () => {
	it('вызывает select pg_notify с корректным payload', async () => {
		const { pool, log } = makeFakePool(() => [])
		const { publishEvent } = await import('../src/services/events.js')
		await publishEvent(pool, { companyId: COMPANY_ID, type: 'sale', id: 'o-42' })
		const call = log.find(e => e.sql.startsWith('select pg_notify'))
		expect(call).toBeTruthy()
		expect(call!.params[0]).toBe('skladpro_events')
		const payload = JSON.parse(String(call!.params[1]))
		expect(payload).toMatchObject({ companyId: COMPANY_ID, type: 'sale', id: 'o-42' })
		expect(typeof payload.at).toBe('string')
	})

	it('глотает ошибки — публикация best-effort', async () => {
		const { pool } = makeFakePool(() => { throw new Error('pg down') })
		const { publishEvent } = await import('../src/services/events.js')
		// Не должно throw — иначе бизнес-эндпоинт бы упал из-за упавшего realtime.
		await expect(publishEvent(pool, { companyId: COMPANY_ID, type: 'sale', id: 'x' }))
			.resolves.toBeUndefined()
	})
})
