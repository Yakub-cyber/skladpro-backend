import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'
import { fromRequest, logSecurityEvent } from '../lib/security-log.js'

const PinSetBody = z.object({
	employeeId: z.string().min(1).max(64),
	pin: z.string().regex(/^\d{4,8}$/, 'PIN — от 4 до 8 цифр'),
})

const PinVerifyBody = z.object({
	employeeId: z.string().min(1).max(64),
	pin: z.string().min(1).max(32),
})

const BCRYPT_ROUNDS = 10
// Строгий лимит на подбор PIN: 10 попыток в минуту с одного IP.
const PIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' as const }

/**
 * PIN сотрудников: bcrypt-хэш в employees.pin_hash, наружу не отдаётся
 * (исключён из sync pull), открытых PIN в схеме нет вообще.
 */
export function registerPinRoutes(app: FastifyInstance, pool: DbPool) {
	app.post(
		'/v1/employees/pin/set',
		{ preHandler: app.authenticate, config: { rateLimit: PIN_RATE_LIMIT } },
		async (request, reply) => {
			const auth = request.auth
			if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden('PIN меняет только админ или менеджер')

			const parsed = PinSetBody.safeParse(request.body)
			if (!parsed.success) throw Errors.validation(parsed.error.issues)
			const { employeeId, pin } = parsed.data

			const hash = await bcrypt.hash(pin, BCRYPT_ROUNDS)
			const { rows } = await pool.query(
				`update employees set pin_hash = $3
				 where company_id = $1 and id = $2 and deleted_at is null
				 returning id`,
				[auth.companyId, employeeId, hash],
			)
			if (rows.length === 0) throw Errors.notFound(`Сотрудник ${employeeId}`)
			await logSecurityEvent(pool, 'pin_set', fromRequest(request, { meta: { employeeId } }))
			reply.code(200)
			return { ok: true }
		},
	)

	app.post(
		'/v1/employees/pin/verify',
		{ preHandler: app.authenticate, config: { rateLimit: PIN_RATE_LIMIT } },
		async request => {
			const auth = request.auth
			const parsed = PinVerifyBody.safeParse(request.body)
			if (!parsed.success) throw Errors.validation(parsed.error.issues)
			const { employeeId, pin } = parsed.data

			const { rows } = await pool.query(
				`select id, name, role, active, pin_hash from employees
				 where company_id = $1 and id = $2 and deleted_at is null`,
				[auth.companyId, employeeId],
			)
			const emp = rows[0]
			// Не различаем «нет сотрудника» и «неверный PIN» — меньше информации перебору.
			if (!emp || !emp.active || !emp.pin_hash) {
				await logSecurityEvent(pool, 'pin_verify_fail', fromRequest(request, {
					meta: { employeeId, reason: emp ? (emp.active ? 'no_pin' : 'inactive') : 'no_emp' },
				}))
				throw Errors.pinInvalid()
			}

			const ok = await bcrypt.compare(pin, emp.pin_hash)
			if (!ok) {
				await logSecurityEvent(pool, 'pin_verify_fail', fromRequest(request, {
					meta: { employeeId, reason: 'bad_pin' },
				}))
				throw Errors.pinInvalid()
			}

			await logSecurityEvent(pool, 'pin_verify_ok', fromRequest(request, { meta: { employeeId } }))
			return { ok: true, employee: { id: emp.id, name: emp.name, role: emp.role } }
		},
	)
}
