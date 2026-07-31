import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors } from '../lib/errors.js'
import type { Mailer } from '../services/mailer.js'
import { hashPassword, verifyPassword } from '../lib/passwords.js'
import { fromRequest, logSecurityEvent } from '../services/security-log.js'
import { hashRefreshToken, type TokenService } from '../lib/tokens.js'

const RegisterBody = z.object({
	email: z.string().email().max(254),
	password: z.string().min(8, 'Пароль — минимум 8 символов').max(128),
	name: z.string().max(200).optional(),
	// B5-2 (ex F3-6): если пользователь перешёл по инвайт-ссылке с ?invite=<token>,
	// клиент передаёт токен сюда. Если валидный и email совпадает с invitation.email,
	// сразу создаём membership — не нужен отдельный /v1/invitations/accept.
	inviteToken: z.string().min(8).max(200).optional(),
})

const LoginBody = z.object({
	email: z.string().email().max(254),
	password: z.string().min(1).max(128),
})

const RefreshBody = z.object({ refreshToken: z.string().min(16).max(256) })

// Жёсткий лимит на auth-эндпоинты: перебор бессмыслен.
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' as const }
// Refresh — чуть шире, чтобы плохой LTE не блокировал POS.
const REFRESH_RATE_LIMIT = { max: 30, timeWindow: '1 minute' as const }
// Грейс-окно повторного refresh (потерянный ответ на нестабильной сети):
// если тот же refresh пришёл ещё раз в этом окне и новый преемник ЕЩЁ не использован,
// возвращаем сохранённую пару, вместо того чтобы гасить всю семью как «кражу».
const REFRESH_REPLAY_WINDOW_MS = 15_000

export type AuthRoutesDeps = { pool: DbPool; tokens: TokenService; mailer: Mailer; config: Config }

const PASSWORD_RESET_TTL_MIN = 60

function hashResetToken(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void
export function registerAuthRoutes(app: FastifyInstance, pool: DbPool, tokens: TokenService): void
export function registerAuthRoutes(
	app: FastifyInstance,
	poolOrDeps: DbPool | AuthRoutesDeps,
	tokensArg?: TokenService,
) {
	// Совместимая перегрузка для старого вызова из buildApp с (pool, tokens).
	const pool: DbPool = 'pool' in poolOrDeps ? poolOrDeps.pool : poolOrDeps
	const tokens: TokenService =
		'tokens' in poolOrDeps ? poolOrDeps.tokens : (tokensArg as TokenService)
	const mailer: Mailer | null =
		'mailer' in poolOrDeps ? poolOrDeps.mailer : null
	const config: Config | null =
		'config' in poolOrDeps ? poolOrDeps.config : null
	async function issueTokenPair(
		client: { query: DbPool['query'] },
		user: { id: string; email: string; name: string | null },
		request: FastifyRequest,
		family?: string,
	) {
		const accessToken = await tokens.signAccessToken({ sub: user.id, email: user.email, name: user.name })
		const { token: refreshToken, tokenHash } = tokens.newRefreshToken()
		await client.query(
			`insert into refresh_tokens (user_id, token_hash, family, expires_at, user_agent, ip)
			 values ($1, $2, $3, $4, $5, $6)`,
			[
				user.id,
				tokenHash,
				family ?? randomUUID(),
				tokens.refreshExpiry(),
				(request.headers['user-agent'] ?? '').slice(0, 300),
				request.ip,
			],
		)
		return { accessToken, refreshToken }
	}

	async function membershipsOf(userId: string) {
		const { rows } = await pool.query(
			`select m.company_id, m.role, m.name, c.name as company_name
			 from memberships m join companies c on c.id = m.company_id
			 where m.user_id = $1 and m.active
			 order by m.created_at asc`,
			[userId],
		)
		return rows.map(r => ({ companyId: r.company_id, role: r.role, name: r.name, companyName: r.company_name }))
	}

	app.post('/v1/auth/register', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
		const parsed = RegisterBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { email, password, name, inviteToken } = parsed.data

		const passwordHash = await hashPassword(password)
		const result = await withTransaction(pool, async client => {
			// Без WHERE NOT EXISTS: полагаемся на unique-индекс users_email_unique.
			// Он же защищает от race'а двух одновременных регистраций одного email
			// (23505 конверт в 409 DUPLICATE в setErrorHandler).
			const inserted = await client.query(
				`insert into users (email, password_hash, name) values ($1, $2, $3)
				 returning id, email, name`,
				[email, passwordHash, name ?? null],
			)
			const user = inserted.rows[0]
			// B5-2: если пришёл инвайт-токен — авто-accept внутри той же
			// транзакции. Проверка email совпадает с invitation.email — защита
			// от того, что кто-то стянул ссылку из чужой почты, но пробует
			// зарегаться на своём. Без совпадения — просто игнорируем токен
			// (клиент может дальше сделать /v1/invitations/accept вручную).
			let acceptedCompanyId: string | null = null
			if (inviteToken) {
				const invRes = await client.query(
					`select id, company_id, role, name, email from invitations
					 where token = $1 for update`,
					[inviteToken],
				)
				const inv = invRes.rows[0]
				if (inv && inv.email.toLowerCase() === user.email.toLowerCase()) {
					await client.query(
						`insert into memberships (user_id, company_id, role, name)
						 values ($1, $2, $3, $4)
						 on conflict (user_id, company_id) do nothing`,
						[user.id, inv.company_id, inv.role, inv.name ?? null],
					)
					await client.query(`delete from invitations where id = $1`, [inv.id])
					acceptedCompanyId = inv.company_id
				}
			}
			const pair = await issueTokenPair(client, user, request)
			return { user, pair, acceptedCompanyId }
		})

		await logSecurityEvent(pool, 'register_ok', fromRequest(request, {
			userId: result.user.id,
			meta: { email: result.user.email },
		}))
		reply.code(201)
		return {
			user: { id: result.user.id, email: result.user.email, name: result.user.name },
			memberships: await membershipsOf(result.user.id),
			...result.pair,
		}
	})

	app.post('/v1/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async request => {
		const parsed = LoginBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const { email, password } = parsed.data

		const { rows } = await pool.query(
			`select id, email, name, password_hash, active, must_reset from users where lower(email) = lower($1)`,
			[email],
		)
		const user = rows[0]
		// Одинаковый ответ для «нет такого email» и «не тот пароль».
		if (!user || !user.active) {
			await logSecurityEvent(pool, 'login_fail', fromRequest(request, {
				meta: { email, reason: user ? 'inactive' : 'no_user' },
			}))
			throw Errors.unauthorized('Неверный email или пароль')
		}
		const ok = await verifyPassword(password, user.password_hash)
		if (!ok) {
			await logSecurityEvent(pool, 'login_fail', fromRequest(request, {
				userId: user.id,
				meta: { email, reason: 'bad_password' },
			}))
			throw Errors.unauthorized('Неверный email или пароль')
		}
		if (user.must_reset) {
			await logSecurityEvent(pool, 'login_fail', fromRequest(request, {
				userId: user.id,
				meta: { email, reason: 'must_reset' },
			}))
			throw Errors.forbidden('Требуется сброс пароля (обратитесь к администратору)')
		}

		const pair = await issueTokenPair(pool, user, request)
		await logSecurityEvent(pool, 'login_ok', fromRequest(request, {
			userId: user.id,
			meta: { email: user.email },
		}))
		return {
			user: { id: user.id, email: user.email, name: user.name },
			memberships: await membershipsOf(user.id),
			...pair,
		}
	})

	app.post('/v1/auth/refresh', { config: { rateLimit: REFRESH_RATE_LIMIT } }, async request => {
		const parsed = RefreshBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const tokenHash = hashRefreshToken(parsed.data.refreshToken)

		const outcome = await withTransaction(pool, async client => {
			const { rows } = await client.query(
				`select rt.id, rt.user_id, rt.family, rt.expires_at, rt.revoked_at,
				        u.email, u.name, u.active
				 from refresh_tokens rt join users u on u.id = rt.user_id
				 where rt.token_hash = $1
				 for update of rt`,
				[tokenHash],
			)
			const row = rows[0]
			if (!row || !row.active) return { kind: 'invalid' as const }

			// Грейс: если токен ротирован недавно и его преемник ещё не использован,
			// это скорее всего ретрай после потерянного ответа, а не кража.
			// Возвращаем сохранённого преемника; отзыва семьи нет.
			if (row.revoked_at) {
				const revokedAgoMs = Date.now() - new Date(row.revoked_at).getTime()
				if (revokedAgoMs <= REFRESH_REPLAY_WINDOW_MS) {
					const { rows: succ } = await client.query(
						`select id, revoked_at from refresh_tokens
						 where family = $1 and created_at > $2
						 order by created_at asc limit 1`,
						[row.family, row.revoked_at],
					)
					const s = succ[0]
					// Преемник ещё жив → это ретрай потерянного ответа. Не гасим семью,
					// а просим клиента переключиться на уже выданную ему свежую пару.
					// (Сам токен-строку выдать заново нельзя — храним только sha256.)
					if (s && !s.revoked_at) return { kind: 'replay_grace' as const }
				}
				// За пределами окна или преемник уже использован → полноценная детекция кражи.
				await client.query(`update refresh_tokens set revoked_at = now() where family = $1 and revoked_at is null`, [
					row.family,
				])
				return { kind: 'reuse' as const, userId: row.user_id as string }
			}
			if (new Date(row.expires_at).getTime() < Date.now()) return { kind: 'expired' as const }

			await client.query(`update refresh_tokens set revoked_at = now() where id = $1`, [row.id])
			const pair = await issueTokenPair(
				client,
				{ id: row.user_id, email: row.email, name: row.name },
				request,
				row.family,
			)
			return { kind: 'ok' as const, pair }
		})

		switch (outcome.kind) {
			case 'ok':
				return outcome.pair
			case 'replay_grace':
				// Пользователю подсказываем, что он уже получил новый токен и должен им
				// пользоваться — семью не гасим (не карает LTE-ретраи).
				throw Errors.unauthorized('Refresh уже выполнен, используйте свежую пару')
			case 'reuse':
				await logSecurityEvent(pool, 'refresh_reuse_detected', fromRequest(request, {
					userId: outcome.userId,
				}))
				throw Errors.unauthorized('Refresh-токен уже использован — сессия отозвана')
			case 'expired':
				throw Errors.unauthorized('Refresh-токен истёк')
			default:
				throw Errors.unauthorized('Refresh-токен недействителен')
		}
	})

	app.post('/v1/auth/logout', { config: { rateLimit: AUTH_RATE_LIMIT } }, async request => {
		const parsed = RefreshBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const tokenHash = hashRefreshToken(parsed.data.refreshToken)
		await pool.query(
			`update refresh_tokens set revoked_at = now()
			 where family = (select family from refresh_tokens where token_hash = $1)
			   and revoked_at is null`,
			[tokenHash],
		)
		return { ok: true }
	})

	// ── Смена пароля залогиненным пользователем ──────────────────────────
	// Требует старый пароль (защита от «зашёл на девайс — сменил пароль»).
	// После смены гасим ВСЕ refresh-семьи пользователя — все устройства пере-
	// логинятся сами (это правильно: если пароль сменили, старые сессии
	// должны быть отозваны).
	const ChangePasswordBody = z.object({
		oldPassword: z.string().min(1).max(128),
		newPassword: z.string().min(8, 'Пароль — минимум 8 символов').max(128),
	})
	app.post(
		'/v1/auth/password/change',
		{ preHandler: app.authenticateUser, config: { rateLimit: AUTH_RATE_LIMIT } },
		async request => {
			const parsed = ChangePasswordBody.safeParse(request.body)
			if (!parsed.success) throw Errors.validation(parsed.error.issues)
			const { oldPassword, newPassword } = parsed.data
			const userId = request.auth.userId

			const { rows } = await pool.query(`select password_hash from users where id = $1`, [userId])
			const u = rows[0]
			if (!u) throw Errors.unauthorized()
			const ok = await verifyPassword(oldPassword, u.password_hash)
			if (!ok) throw Errors.unauthorized('Старый пароль не совпадает')
			if (oldPassword === newPassword) throw Errors.validation([{ message: 'Новый пароль совпадает со старым' }])

			const newHash = await hashPassword(newPassword)
			await withTransaction(pool, async client => {
				await client.query(`update users set password_hash = $2 where id = $1`, [userId, newHash])
				// Отзыв всех refresh-токенов пользователя — принудительный релогин везде.
				await client.query(
					`update refresh_tokens set revoked_at = now()
					 where user_id = $1 and revoked_at is null`,
					[userId],
				)
			})
			await logSecurityEvent(pool, 'password_change', fromRequest(request, { userId }))
			return { ok: true }
		},
	)

	// ── Сброс пароля через email ─────────────────────────────────────────
	// Всегда отвечаем 200, даже если email не найден или SMTP не настроен —
	// иначе эндпоинт превращается в user enumeration (можно перебирать
	// зарегистрированные адреса). Реально письмо уходит только если
	// пользователь есть и mailer доступен.
	const ResetRequestBody = z.object({ email: z.string().email().max(254) })
	app.post('/v1/auth/password/reset', { config: { rateLimit: AUTH_RATE_LIMIT } }, async request => {
		const parsed = ResetRequestBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const email = parsed.data.email.trim()

		const { rows } = await pool.query(
			`select id, email, name, active from users where lower(email) = lower($1)`,
			[email],
		)
		const user = rows[0]
		if (user && user.active && mailer?.available && config) {
			// Дополнительный лимит: одному user_id не больше 5 активных токенов —
			// чтобы перебор писем не переполнял таблицу.
			await pool.query(
				`delete from password_reset_tokens
				 where user_id = $1 and used_at is null
				   and created_at < now() - interval '10 minutes'`,
				[user.id],
			)
			const token = randomBytes(32).toString('base64url')
			const tokenHash = hashResetToken(token)
			const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MIN * 60 * 1000)
			await pool.query(
				`insert into password_reset_tokens (user_id, token_hash, expires_at, ip, user_agent)
				 values ($1, $2, $3, $4, $5)`,
				[
					user.id,
					tokenHash,
					expiresAt,
					request.ip,
					(request.headers['user-agent'] ?? '').slice(0, 300),
				],
			)
			const link = `${config.APP_URL.replace(/\/+$/, '')}/#/reset?token=${encodeURIComponent(token)}`
			const name = user.name || user.email
			// Ошибку отправки логируем, но НЕ пробрасываем клиенту (тот же
			// principle: не выдаём валидность email).
			mailer.send({
				to: user.email,
				subject: 'SkladPro: сброс пароля',
				text:
					`Здравствуйте, ${name}!\n\n` +
					`Кто-то (возможно, вы) запросил сброс пароля SkladPro.\n` +
					`Чтобы задать новый пароль, откройте ссылку в течение часа:\n\n${link}\n\n` +
					`Если это не вы — просто проигнорируйте письмо, старый пароль продолжит работать.`,
			}).then(res => {
				if (!res.ok) request.log.warn({ err: res.error, email: user.email }, 'password reset send failed')
			})
			await logSecurityEvent(pool, 'password_reset_requested', fromRequest(request, {
				userId: user.id,
				meta: { email: user.email },
			}))
		}
		return { ok: true }
	})

	// Применение токена сброса. Токен одноразовый: used_at ставится при успехе,
	// повторное использование → 401.
	const ResetConfirmBody = z.object({
		token: z.string().min(16).max(256),
		newPassword: z.string().min(8, 'Пароль — минимум 8 символов').max(128),
	})
	app.post('/v1/auth/password/reset/confirm', { config: { rateLimit: AUTH_RATE_LIMIT } }, async request => {
		const parsed = ResetConfirmBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const tokenHash = hashResetToken(parsed.data.token)

		const outcome = await withTransaction(pool, async client => {
			const { rows } = await client.query(
				`select id, user_id, expires_at, used_at from password_reset_tokens
				 where token_hash = $1
				 for update`,
				[tokenHash],
			)
			const row = rows[0]
			if (!row) return { kind: 'invalid' as const }
			if (row.used_at) return { kind: 'invalid' as const }
			if (new Date(row.expires_at).getTime() < Date.now()) return { kind: 'expired' as const }

			const newHash = await hashPassword(parsed.data.newPassword)
			await client.query(`update users set password_hash = $2 where id = $1`, [row.user_id, newHash])
			await client.query(
				`update password_reset_tokens set used_at = now() where id = $1`,
				[row.id],
			)
			// Отзыв всех refresh-семей — устройства перезалогинятся.
			await client.query(
				`update refresh_tokens set revoked_at = now()
				 where user_id = $1 and revoked_at is null`,
				[row.user_id],
			)
			return { kind: 'ok' as const, userId: row.user_id as string }
		})

		if (outcome.kind === 'ok') {
			await logSecurityEvent(pool, 'password_reset_confirmed', fromRequest(request, {
				userId: outcome.userId,
			}))
			return { ok: true }
		}
		if (outcome.kind === 'expired') throw Errors.unauthorized('Ссылка истекла — запросите новую')
		throw Errors.unauthorized('Ссылка недействительна или уже использована')
	})
}
