import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'
import { fromRequest, logSecurityEvent } from '../services/security-log.js'

const EnsureMeBody = z.object({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(200),
	role: z.enum(['admin', 'manager', 'stock', 'courier']).optional(),
})

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
	// ── Ensure-me: привязка сотрудника к текущему user ────────────────────
	// Bootstrap клиента вызывает этот эндпоинт вместо cloudUpsert, чтобы
	// user_id ставился сервером (привилегированное поле, не в push whitelist).
	// Upsert по (company_id, user_id) — повторный вызов обновляет имя/роль,
	// а не создаёт дубликат.
	app.post('/v1/employees/me', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		const parsed = EnsureMeBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { id, name } = parsed.data
		const effectiveRole = auth.role

		// Если user уже привязан к сотруднику (после предыдущего bootstrap) —
		// обновляем имя и возвращаем. Не создаём второго.
		const existing = await pool.query(
			`select id, name, role, user_id from employees
			 where company_id = $1 and user_id = $2 and deleted_at is null
			 limit 1`,
			[auth.companyId, auth.userId],
		)
		if (existing.rows.length > 0) {
			const emp = existing.rows[0]
			if (emp.name !== name || emp.role !== effectiveRole) {
				await pool.query(
					`update employees set name=$3, role=$4 where company_id=$1 and id=$2`,
					[auth.companyId, emp.id, name, effectiveRole],
				)
				emp.name = name
                emp.role = effectiveRole
			}
			reply.code(200)
			return { ok: true, employee: emp }
		}

		const { rows } = await pool.query(
			`insert into employees (company_id, id, name, role, user_id, active)
			 values ($1, $2, $3, $4, $5, true)
			 on conflict (company_id, id) do update
			   set user_id = excluded.user_id,
			       name = excluded.name,
			       deleted_at = null,
                   role = excluded.role
               where employees.user_id = excluded.user_id
			 returning id, name, role, user_id`,
			[auth.companyId, id, name, effectiveRole, auth.userId],
		)
		if (!rows[0]) throw Errors.forbidden('Сотрудник уже связан с другой учётной записью')
		reply.code(200)
		return { ok: true, employee: rows[0] }
	})

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
