import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeFakePool, testConfig, USER_ID } from './helpers.js'

describe('registration rate limit HTTP contract', () => {
 afterEach(() => vi.restoreAllMocks())
 it('allows ten registrations, rejects retries with 429 and recovers after the unchanged window', async () => {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const { pool, log } = makeFakePool(sql => sql.includes('insert into users')
   ? [{ id: USER_ID, email: 'synthetic@example.test', name: null }] : [])
  const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null, metrics: null })
  const register = () => app.inject({ method: 'POST', url: '/v1/auth/register',
   payload: { email: 'synthetic@example.test', password: 'synthetic-password' } })
  try {
   for (let i = 0; i < 10; i++) expect((await register()).statusCode).toBe(201)
   const before = log.length
   for (let i = 0; i < 2; i++) {
    const limited = await register()
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toEqual({ error: { code: 'RATE_LIMITED', message: 'Слишком много запросов, попробуйте позже' } })
    expect(Number(limited.headers['retry-after'])).toBe(60)
    expect(limited.headers['x-ratelimit-remaining']).toBe('0')
   }
   expect(log.length).toBe(before)
   now += 60_001
   expect((await register()).statusCode).toBe(201)
  } finally { await app.close() }
 })
 it('keeps unexpected database errors private and distinct from throttling', async () => {
  const { pool } = makeFakePool(() => { throw new Error('private database detail') })
  const app = await buildApp({ config: testConfig, pool, eventBus: null, fcm: null, metrics: null })
  try {
   const response = await app.inject({ method: 'POST', url: '/v1/auth/register',
    payload: { email: 'synthetic@example.test', password: 'synthetic-password' } })
   expect(response.statusCode).toBe(500)
   expect(response.json()).toEqual({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } })
   expect(response.headers['retry-after']).toBeUndefined()
  } finally { await app.close() }
 })
})
