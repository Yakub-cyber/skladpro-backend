import bcrypt from 'bcryptjs'
import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, USER_ID, makeTestApp } from './helpers.js'

describe('POST /v1/employees/me — привязка сотрудника к user', () => {
	it('upsert: создаёт/обновляет сотрудника с user_id из JWT', async () => {
		let insertedParams: unknown[] | null = null
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('insert into employees')) {
					insertedParams = params
					return [{ id: params[1], name: params[2], role: params[3], user_id: params[4] }]
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/employees/me',
			headers: await authHeaders(),
			payload: { id: 'e-42', name: 'Якуб', role: 'admin' },
		})
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.ok).toBe(true)
		expect(body.employee.id).toBe('e-42')
		expect(insertedParams).toBeTruthy()
		expect(insertedParams![0]).toBe(COMPANY_ID)
		expect(insertedParams![4]).toBe(USER_ID)
	})

	it('без name → 400', async () => {
		const { app } = await makeTestApp({ handler: () => undefined })
		const res = await app.inject({
			method: 'POST',
			url: '/v1/employees/me',
			headers: await authHeaders(),
			payload: { id: 'e-42' },
		})
		expect(res.statusCode).toBe(400)
	})
})

describe('PIN endpoints', () => {
	it('set: хэширует PIN', async () => {
		let savedHash: string | null = null
		const { app } = await makeTestApp({
			handler: (sql, params) => {
				if (sql.includes('update employees set pin_hash')) {
					savedHash = params[2] as string
					return [{ id: params[1] }]
				}
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/employees/pin/set',
			headers: await authHeaders(),
			payload: { employeeId: 'e-1', pin: '4321' },
		})
		expect(res.statusCode).toBe(200)
		expect(savedHash).toBeTruthy()
		expect(savedHash).not.toContain('4321')
		expect(bcrypt.compareSync('4321', savedHash!)).toBe(true)
	})

	it('set: запрещён обычному сотруднику', async () => {
		const { app } = await makeTestApp({
			handler: () => undefined,
			membership: { company_id: COMPANY_ID, role: 'stock', name: null },
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/employees/pin/set',
			headers: await authHeaders(),
			payload: { employeeId: 'e-1', pin: '4321' },
		})
		expect(res.statusCode).toBe(403)
	})

	it('verify: верный PIN проходит, неверный — 401 PIN_INVALID', async () => {
		const hash = bcrypt.hashSync('1234', 4)
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.includes('select id, name, role, active, pin_hash'))
					return [{ id: 'e-1', name: 'Иван', role: 'stock', active: true, pin_hash: hash }]
				return undefined
			},
		})
		const ok = await app.inject({
			method: 'POST',
			url: '/v1/employees/pin/verify',
			headers: await authHeaders(),
			payload: { employeeId: 'e-1', pin: '1234' },
		})
		expect(ok.statusCode).toBe(200)
		expect(ok.json().employee).toMatchObject({ id: 'e-1', name: 'Иван' })

		const bad = await app.inject({
			method: 'POST',
			url: '/v1/employees/pin/verify',
			headers: await authHeaders(),
			payload: { employeeId: 'e-1', pin: '0000' },
		})
		expect(bad.statusCode).toBe(401)
		expect(bad.json().error.code).toBe('PIN_INVALID')
	})

	it('verify: неактивный сотрудник или без pin_hash — тоже PIN_INVALID', async () => {
		const { app } = await makeTestApp({
			handler: sql => {
				if (sql.includes('select id, name, role, active, pin_hash'))
					return [{ id: 'e-1', name: 'Иван', role: 'stock', active: false, pin_hash: null }]
				return undefined
			},
		})
		const res = await app.inject({
			method: 'POST',
			url: '/v1/employees/pin/verify',
			headers: await authHeaders(),
			payload: { employeeId: 'e-1', pin: '1234' },
		})
		expect(res.statusCode).toBe(401)
	})
})
