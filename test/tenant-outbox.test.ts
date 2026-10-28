import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, coreHandler, makeTestApp } from './helpers.js'

const OTHER = 'c0000000-0000-4000-8000-000000000002'
const payload = { order: { id: 'o-scope', items: [{ productId: 'p-scope', qty: 1, price: 100 }], discount: 0 } }
describe('outbox retries keep tenant boundaries', () => {
  it('replay belongs to original company; the same key in another company is independent', async () => {
    const saved = new Map<string, { endpoint: string; response?: unknown; status?: number }>()
    const core = coreHandler()
    const { app, log } = await makeTestApp({ handler: (sql, params) => {
      if (sql.includes('from memberships m') && sql.includes('join users u')) return [COMPANY_ID, OTHER].map((company_id) => ({ company_id, role: 'admin', name: 'Test' }))
      if (sql.includes('insert into idempotency_keys')) {
        const key = `${params[0]}:${params[1]}`
        if (saved.has(key)) return []
        saved.set(key, { endpoint: String(params[2]) }); return [{ key: params[1] }]
      }
      if (sql.includes('select status, response, endpoint from idempotency_keys')) return [saved.get(`${params[0]}:${params[1]}`)]
      if (sql.includes('update idempotency_keys set status')) {
        Object.assign(saved.get(`${params[0]}:${params[1]}`)!, { status: params[2], response: JSON.parse(String(params[3])) }); return []
      }
      if (sql.includes('from products') && sql.includes('deleted_at is null')) return [{ name: 'Product', marked: false, codes: [] }]
      if (sql.includes('insert into orders') && sql.includes('returning id')) return [{ id: params[1] }]
      return core(sql, params)
    } })
    try {
      const headers = await authHeaders({ 'idempotency-key': 'sale-shared-0001' })
      const call = (company: string) => app.inject({ method: 'POST', url: '/v1/sales', headers: { ...headers, 'x-company-id': company }, payload })
      expect((await call(COMPANY_ID)).statusCode).toBe(201)
      const before = log.filter((r) => r.sql.includes('insert into docs')).length
      const replay = await call(COMPANY_ID)
      expect(replay.headers['idempotency-replayed']).toBe('true')
      expect(log.filter((r) => r.sql.includes('insert into docs'))).toHaveLength(before)
      const other = await call(OTHER)
      expect(other.statusCode).toBe(201); expect(other.headers['idempotency-replayed']).toBeUndefined()
      expect(saved.size).toBe(2)
      expect(log.filter((r) => r.sql.includes('insert into docs')).map((r) => r.params[0])).toEqual([COMPANY_ID, OTHER])
      const beforeDenied = log.length
      expect((await call('c0000000-0000-4000-8000-000000000003')).statusCode).toBe(403)
      expect(log.slice(beforeDenied).some((r) => r.sql === 'begin' || r.sql.includes('insert into docs'))).toBe(false)
    } finally { await app.close() }
  })
})
