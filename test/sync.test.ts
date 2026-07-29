import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, makeTestApp } from './helpers.js'

// Preread строки перед push (LWW + tombstone-guard).
// Матчим только SELECT с этими проекциями, чтобы не задеть UPDATE/INSERT с тем же WHERE.
function existingRowSql(sql: string) {
	return sql.startsWith('select updated_at, deleted_at,') && sql.includes(' where company_id = $1 and id = $2')
}

describe('sync', () => {
	it('pull: без company_id и без pin_hash, курсор = row_version', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.startsWith('select * from employees'))
					return [{ company_id: 'c-1', id: 'e-1', name: 'Иван', pin_hash: 'SECRET', row_version: '42', deleted_at: null }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'GET',
			url: '/v1/sync/pull?table=employees',
			headers: await authHeaders(),
		})
		expect(res.statusCode).toBe(200)
		const emp = res.json().tables.employees
		expect(emp.rows[0].name).toBe('Иван')
		expect(emp.rows[0].pin_hash).toBeUndefined()
		expect(emp.rows[0].company_id).toBeUndefined()
		expect(emp.rows[0].row_version).toBe('42') // строкой, чтобы клиент не потерял точность 64-битного bigint
		expect(emp.cursor).toBe('42')
	})

	it('pull: keyset по row_version — bigint, не время', async () => {
		const { app, log } = await makeTestApp({
			handler: sql => (sql.startsWith('select * from products') ? [] : undefined),
		})
		await app.inject({
			method: 'GET',
			url: '/v1/sync/pull?table=products&since=12345',
			headers: await authHeaders(),
		})
		const q = log.find(e => e.sql.includes('from products') && e.sql.includes('row_version >'))!
		expect(q.params).toEqual(expect.arrayContaining([COMPANY_ID, '12345']))
	})

	it('pull: hasMore при переполнении лимита', async () => {
		const rows = Array.from({ length: 3 }, (_, i) => ({
			company_id: 'c-1',
			id: `p-${i}`,
			row_version: String(i + 1),
		}))
		const { app } = await makeTestApp({
			handler: sql => (sql.startsWith('select * from products') ? rows : undefined),
		})
		const res = await app.inject({
			method: 'GET',
			url: '/v1/sync/pull?table=products&limit=2',
			headers: await authHeaders(),
		})
		const products = res.json().tables.products
		expect(products.rows).toHaveLength(2)
		expect(products.hasMore).toBe(true)
		expect(products.cursor).toBe('2')
	})

	it('pull: курьер получает только whitelisted таблицы и без PII', async () => {
		const customersRow = {
			company_id: 'c-1',
			id: 'cu-1',
			name: 'Клиент',
			phone: '+7',
			balance: 500,
			bonus: 10,
			total_spent: 999,
			row_version: '2',
		}
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.startsWith('select * from customers')) return [customersRow]
				if (sql.startsWith('select * from')) return []
				return undefined
			},
			membership: { company_id: COMPANY_ID, role: 'courier', name: 'Вася' },
		})
		const res = await app.inject({ method: 'GET', url: '/v1/sync/pull', headers: await authHeaders() })
		expect(res.statusCode).toBe(200)
		const tables = res.json().tables
		// Курьер вообще не получает: products, documents, movements, suppliers, audit, invoices, shifts, price_types
		expect(tables.products).toBeUndefined()
		expect(tables.documents).toBeUndefined()
		expect(tables.movements).toBeUndefined()
		expect(tables.suppliers).toBeUndefined()
		expect(tables.audit).toBeUndefined()
		expect(tables.invoices).toBeUndefined()
		expect(tables.shifts).toBeUndefined()
		expect(tables.price_types).toBeUndefined()
		// А те, что видит (customers/orders/warehouses/cells/employees) — без коммерческих полей
		const c = tables.customers.rows[0]
		expect(c.phone).toBe('+7')
		expect(c.balance).toBeUndefined()
		expect(c.bonus).toBeUndefined()
		expect(c.total_spent).toBeUndefined()
	})

	it('push: movements/audit/idempotency_keys отклоняются — только через бизнес-эндпоинты', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: {
				ops: [
					{ table: 'movements', op: 'upsert', row: { id: 'm-1', delta: 100000 } },
					{ table: 'audit', op: 'upsert', row: { id: 'a-1' } },
					{ table: 'idempotency_keys', op: 'upsert', row: { id: 'k' } },
				],
			},
		})
		expect(res.statusCode).toBe(200)
		const results = res.json().results
		expect(results.every((r: { ok: boolean }) => !r.ok)).toBe(true)
	})

	it('push: имена методов Object.prototype отклоняются (hasOwn, не оператор in)', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		// 'constructor' проходит regex [a-z_]+, hasOwnProperty НЕ проходит (заглавные)
		// и отсекается zod-валидацией до попадания в applyOp — оба пути безопасны.
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: { ops: [{ table: 'constructor', op: 'upsert', row: { id: 'x' } }] },
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().results[0]).toMatchObject({ ok: false, code: 'TABLE_FORBIDDEN' })
	})

	it('push: products upsert проходит, но stock/batches/cost игнорируются', async () => {
		const { app, log } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: {
				ops: [
					{
						table: 'products',
						op: 'upsert',
						row: { id: 'p-1', name: 'Товар', price: 100, stock: 999999, batches: [{ qty: 999 }], pin_hash: 'x' },
					},
				],
			},
		})
		expect(res.json().results[0].ok).toBe(true)
		const upsert = log.find(e => e.sql.includes('insert into products'))!
		expect(upsert.sql).not.toContain('stock')
		expect(upsert.sql).not.toContain('batches')
		expect(upsert.sql).toContain('"name"')
		expect(upsert.sql).toContain('"price"')
	})

	it('push: whitelist orders не содержит status/items (обход машины состояний невозможен)', async () => {
		const { app, log } = await makeTestApp({ handler: () => undefined })
		await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: {
				ops: [{ table: 'orders', op: 'upsert', row: { id: 'o-1', status: 'shipped', items: [{ qty: 999 }], no: '1' } }],
			},
		})
		const upsert = log.find(e => e.sql.includes('insert into orders'))!
		expect(upsert.sql).not.toContain('"status"')
		expect(upsert.sql).not.toContain('"items"')
		expect(upsert.sql).toContain('"no"')
	})

	it('push: LWW — клиентская запись со старым clientUpdatedAt отклоняется', async () => {
		// Серверное updated_at фиксировано (свежее клиентского на 60с).
		const serverTs = new Date()
		const clientFuture = new Date(Date.now() + 60_000).toISOString()
		const clientOlder = new Date(Date.now() - 120_000).toISOString()
		const { app } = await makeTestApp({
			handler: sql => {
				if (existingRowSql(sql)) return [{ updated_at: serverTs, deleted_at: null, stock_consumed: null, status: null }]
				return undefined
			},
		})
		// Первый: клиентская новее серверной → проходит
		const fresh = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: {
				ops: [{ table: 'customers', op: 'upsert', clientUpdatedAt: clientFuture, row: { id: 'cu-1', name: 'X' } }],
			},
		})
		expect(fresh.json().results[0].ok).toBe(true)

		// Второй: клиентская сильно старше серверной → STALE
		const stale = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: {
				ops: [{ table: 'customers', op: 'upsert', clientUpdatedAt: clientOlder, row: { id: 'cu-1', name: 'X' } }],
			},
		})
		expect(stale.json().results[0]).toMatchObject({ ok: false, code: 'STALE' })
	})

	it('push delete: заказ со списанным остатком удалить нельзя (HAS_STOCK_MOVEMENT)', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (existingRowSql(sql)) return [{ updated_at: new Date(), deleted_at: null, stock_consumed: true, status: 'shipped' }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: { ops: [{ table: 'orders', op: 'delete', row: { id: 'o-1' } }] },
		})
		expect(res.json().results[0]).toMatchObject({ ok: false, code: 'HAS_STOCK_MOVEMENT' })
	})

	it('push upsert: воскрешение удалённого заказа со списанным остатком запрещено', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (existingRowSql(sql)) return [{ updated_at: new Date(), deleted_at: new Date(), stock_consumed: true, status: 'shipped' }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: { ops: [{ table: 'orders', op: 'upsert', row: { id: 'o-1', no: '1' } }] },
		})
		expect(res.json().results[0]).toMatchObject({ ok: false, code: 'TOMBSTONE_LOCKED' })
	})

	it('push: delete на не-orders ставит tombstone', async () => {
		const { app, log } = await makeTestApp({
			handler: sql => {
				if (existingRowSql(sql)) return [] // строки нет — обычный delete проходит
				return undefined
			},
		})
		await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: { ops: [{ table: 'customers', op: 'delete', row: { id: 'cu-1' } }] },
		})
		const del = log.find(e => e.sql.includes('set deleted_at = now()'))!
		expect(del.sql).toContain('update customers')
		expect(del.params).toEqual(expect.arrayContaining(['cu-1']))
	})

	it('push: курьер не может писать', async () => {
		const { app } = await makeTestApp({
			handler: () => undefined,
			membership: { company_id: COMPANY_ID, role: 'courier', name: 'Курьер' },
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: { ops: [{ table: 'customers', op: 'upsert', row: { id: 'cu-1', name: 'X' } }] },
		})
		expect(res.statusCode).toBe(403)
	})

	it('push: некорректный id отклоняется', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/sync/push',
			headers: await authHeaders(),
			payload: { ops: [{ table: 'customers', op: 'upsert', row: { id: "1'; drop table customers; --", name: 'X' } }] },
		})
		expect(res.json().results[0]).toMatchObject({ ok: false, code: 'BAD_ID' })
	})

	it('settings: get/put jsonb целиком', async () => {
		let saved: unknown = null
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('select data, updated_at from settings'))
					return [{ data: { currency: 'RUB' }, updated_at: new Date().toISOString() }]
				if (sql.includes('insert into settings')) {
					saved = params[1]
					return []
				}
				return undefined
			},
		})
		const get = await app.inject({ method: 'GET', url: '/v1/settings', headers: await authHeaders() })
		expect(get.json().data.currency).toBe('RUB')

		const put = await app.inject({
			method: 'PUT',
			url: '/v1/settings',
			headers: await authHeaders(),
			payload: { data: { currency: 'USD' } },
		})
		expect(put.statusCode).toBe(200)
		expect(JSON.parse(String(saved)).currency).toBe('USD')
	})
})
