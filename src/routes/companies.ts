import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { AcceptInvitationBody, acceptInvitation, invitationHash } from '../services/invitations.js'
import { requirePermission } from '../lib/permissions.js'
import { Errors } from '../lib/errors.js'

const CreateCompanyBody = z.object({
	name: z.string().min(1).max(200),
	userName: z.string().max(200).optional(),
})

const InviteBody = z.object({
	email: z.string().email().max(254),
	role: z.enum(['admin', 'manager', 'stock', 'courier']).default('stock'),
	name: z.string().max(200).optional(),
})

const RoleBody = z.object({ role: z.enum(['admin', 'manager', 'stock', 'courier']) })
const InviteIdParam = z.object({ id: z.string().uuid() })
const UserIdParam = z.object({ userId: z.string().uuid() })

export function registerCompanyRoutes(app: FastifyInstance, pool: DbPool) {
	// Создание компании: любой залогиненный пользователь, максимум 5 компаний
	// на пользователя (анти-спам без ручной модерации).
	app.post('/v1/companies', { preHandler: app.authenticateUser }, async (request, reply) => {
		const parsed = CreateCompanyBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { name, userName } = parsed.data
		const userId = request.auth.userId

		const company = await withTransaction(pool, async client => {
			// Advisory-lock per-user: две одновременные вставки не обходят лимит.
			// (hashtext(uuid) даёт стабильный int для pg_advisory_xact_lock.)
			await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [userId])
			const { rows: cnt } = await client.query(`select count(*)::int as n from memberships where user_id = $1`, [
				userId,
			])
			if ((cnt[0]?.n ?? 0) >= 5) throw Errors.forbidden('Достигнут лимит компаний на пользователя')

			const { rows } = await client.query(`insert into companies (name) values ($1) returning id, name`, [name])
			const c = rows[0]
			await client.query(
				`insert into memberships (user_id, company_id, role, name)
				 values ($1, $2, 'admin', coalesce($3, (select name from users where id = $1), 'Администратор'))`,
				[userId, c.id, userName ?? null],
			)
			return c
		})

		app.invalidateMembershipCache(userId)
		reply.code(201)
		return { company: { id: company.id, name: company.name }, role: 'admin' }
	})

	app.get('/v1/memberships', { preHandler: app.authenticateUser }, async request => {
		const { rows } = await pool.query(
			`select m.company_id, m.role, m.name, c.name as company_name
			 from memberships m join companies c on c.id = m.company_id
			 where m.user_id = $1 and m.active
			 order by m.created_at asc`,
			[request.auth.userId],
		)
		return {
			memberships: rows.map(r => ({
				companyId: r.company_id,
				role: r.role,
				name: r.name,
				companyName: r.company_name,
			})),
		}
	})

	app.post('/v1/invitations', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		requirePermission(auth.role, 'invite')

		const parsed = InviteBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { email, role, name } = parsed.data
		if (role === 'admin') requirePermission(auth.role, 'manageRoles')

		// Return the bearer secret only once; persist its SHA-256 digest.
		const token = randomBytes(24).toString('base64url')
		const { rows } = await pool.query(
			`insert into invitations (company_id, email, role, name, created_by, secret_hash, expires_at)
			 values ($1, $2, $3, $4, $5, $6, now() + interval '7 days')
			 returning id`,
			[auth.companyId, email, role, name ?? null, auth.userId, invitationHash(token)],
		)
		reply.code(201)
		return { ok: true, id: rows[0].id, token }
	})

	// Пользователь уже зарегистрирован и получил приглашение позже.
	app.post('/v1/invitations/accept', { preHandler: app.authenticateUser }, async request => {
        const parsed = AcceptInvitationBody.safeParse(request.body)
        if (!parsed.success) throw Errors.validation([{message:'Требуется секрет приглашения'}])
        const result = await withTransaction(pool, client => acceptInvitation(client,request.auth.userId,parsed.data.token))
        app.invalidateMembershipCache(request.auth.userId)
        return result
	})

	// ── Админ-панель: приглашения ──────────────────────────────────────────
	// Только admin/manager могут читать список и отменять приглашения.
	app.get('/v1/invitations', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden('Список приглашений — только админу/менеджеру')
		const { rows } = await pool.query(
			`select id, email, role, name, created_at, expires_at, accepted_at, revoked_at, requires_reissue from invitations
			 where company_id = $1 order by created_at desc`,
			[auth.companyId],
		)
		return {
			invitations: rows.map(r => ({
				id: r.id, email: r.email, role: r.role, name: r.name, createdAt: r.created_at, expiresAt:r.expires_at, acceptedAt:r.accepted_at, revokedAt:r.revoked_at, requiresReissue:r.requires_reissue,
			})),
		}
	})

	app.delete('/v1/invitations/:id', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden('Отменять приглашения — только админу/менеджеру')
		const parsed = InviteIdParam.safeParse(request.params)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		// Матчим и id, и company_id — иначе кросс-компанийная отмена возможна.
		const { rowCount } = await pool.query(
			`update invitations set revoked_at=coalesce(revoked_at,now()) where id=$1 and company_id=$2 and accepted_at is null`,
			[parsed.data.id, auth.companyId],
		)
		if (!rowCount) throw Errors.notFound('Приглашение')
		reply.code(200)
		return { ok: true }
	})

	// ── Участники: смена роли ─────────────────────────────────────────────
	// Только admin. Себе поменять роль нельзя (иначе можно случайно понизить
	// себя и остаться без админа в компании).
	app.patch('/v1/memberships/:userId', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (auth.role !== 'admin') throw Errors.forbidden('Роль участника меняет только админ')
		const params = UserIdParam.safeParse(request.params)
		if (!params.success) throw Errors.validation(params.error.issues)
		const body = RoleBody.safeParse(request.body)
		if (!body.success) throw Errors.validation(body.error.issues)
		if (params.data.userId === auth.userId) throw Errors.forbidden('Нельзя менять роль самому себе')

		const { rowCount } = await pool.query(
			`update memberships set role = $3 where user_id = $1 and company_id = $2`,
			[params.data.userId, auth.companyId, body.data.role],
		)
		if (!rowCount) throw Errors.notFound('Участник')
		app.invalidateMembershipCache(params.data.userId)
		return { ok: true }
	})

	// ── Удаление участника из компании ────────────────────────────────────
	// Только admin. Себя удалить нельзя. Последнего активного админа удалить нельзя.
	app.delete('/v1/memberships/:userId', { preHandler: app.authenticate }, async request => {
		const auth = request.auth
		if (auth.role !== 'admin') throw Errors.forbidden('Удаляет участника только админ')
		const params = UserIdParam.safeParse(request.params)
		if (!params.success) throw Errors.validation(params.error.issues)
		const targetId = params.data.userId
		if (targetId === auth.userId) throw Errors.forbidden('Нельзя удалить самого себя из компании')

		await withTransaction(pool, async client => {
			// FOR UPDATE — чтобы два одновременных удаления не оставили без админа.
			const { rows } = await client.query(
				`select user_id, role from memberships
				 where company_id = $1 and active
				 for update`,
				[auth.companyId],
			)
			const target = rows.find(r => r.user_id === targetId)
			if (!target) throw Errors.notFound('Участник')
			// Проверка «последнего админа»: если удаляемый — admin, и он один такой.
			if (target.role === 'admin') {
				const admins = rows.filter(r => r.role === 'admin').length
				if (admins <= 1) throw Errors.forbidden('Нельзя удалить последнего админа компании')
			}
			await client.query(`delete from memberships where user_id = $1 and company_id = $2`, [
				targetId,
				auth.companyId,
			])
		})
		app.invalidateMembershipCache(targetId)
		return { ok: true }
	})

	// Расширенный /v1/memberships — админам возвращаем ВСЕХ участников компании,
	// не только свои membership'ы. Для этого добавляем ?scope=company (иначе старая
	// семантика — все компании текущего пользователя).
	app.get('/v1/companies/members', { preHandler: app.authenticate }, async request => {
		const { rows } = await pool.query(
			`select m.user_id, m.role, m.name, m.active, m.created_at, u.email
			 from memberships m join users u on u.id = m.user_id
			 where m.company_id = $1
			 order by m.created_at asc`,
			[request.auth.companyId],
		)
		return {
			members: rows.map(r => ({
				userId: r.user_id, email: r.email, role: r.role, name: r.name,
				active: r.active, createdAt: r.created_at, expiresAt:r.expires_at, acceptedAt:r.accepted_at, revokedAt:r.revoked_at, requiresReissue:r.requires_reissue,
			})),
		}
	})
}
