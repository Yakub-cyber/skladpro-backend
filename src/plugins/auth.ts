import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DbPool } from '../db.js'
import { Errors } from '../lib/errors.js'
import type { TokenService } from '../lib/tokens.js'

export type AuthContext = {
	userId: string
	email: string | null
	companyId: string
	role: string
	memberName: string | null
	/** true, если users.is_super_admin. Устанавливается лениво (см. requireSuperAdmin). */
	isSuperAdmin: boolean
	/** Если запрос пришёл с X-API-Key — метаинформация о ключе (для scope-guards и аудита). */
	apiKey?: { id: string; prefix: string; scopes: string[] }
}

declare module 'fastify' {
	interface FastifyRequest {
		auth: AuthContext
	}
	interface FastifyInstance {
		/** Полная аутентификация: JWT + членство в компании. */
		authenticate: (request: FastifyRequest) => Promise<void>
		/** Только JWT, без требования компании (для /v1/companies, /v1/me и т.п.). */
		authenticateUser: (request: FastifyRequest) => Promise<void>
		/** Проверить users.is_super_admin. Идёт в БД, кэша нет (супер-права редки). */
		requireSuperAdmin: (request: FastifyRequest) => Promise<void>
		/**
		 * Публичный API-ключ. X-API-Key: sk_live_<prefix>_<secret>. Не требует
		 * X-Company-Id (компания зашита в ключ). Для scope-guard используйте
		 * request.auth.apiKey.scopes.
		 */
		authenticateApiKey: (request: FastifyRequest) => Promise<void>
	}
}

type MembershipRow = { company_id: string; role: string; name: string | null }
type CacheEntry = { memberships: MembershipRow[]; expiresAt: number }
const MEMBERSHIP_TTL_MS = 60_000

/**
 * Аутентификация: Bearer access-JWT (наша подпись) → пользователь;
 * компания — из заголовка X-Company-Id (или единственная/первая активная).
 * Membership кэшируется на 60 секунд.
 */
export function registerAuth(app: FastifyInstance, pool: DbPool, tokens: TokenService) {
	const cache = new Map<string, CacheEntry>()

	async function verifyBearer(request: FastifyRequest): Promise<{ userId: string; email: string | null }> {
		const header = request.headers.authorization
		if (!header || !header.startsWith('Bearer ')) throw Errors.unauthorized()
		try {
			const payload = await tokens.verifyAccessToken(header.slice('Bearer '.length))
			if (typeof payload.sub !== 'string') throw new Error('no sub')
			return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : null }
		} catch {
			throw Errors.unauthorized('Токен недействителен или истёк')
		}
	}

	async function loadMemberships(userId: string): Promise<MembershipRow[]> {
		const cached = cache.get(userId)
		if (cached && cached.expiresAt > Date.now()) return cached.memberships
		// join users: деактивация пользователя (users.active=false) немедленно
		// закрывает доступ (не позже TTL кэша — 60 сек).
		const { rows } = await pool.query(
			`select m.company_id, m.role, m.name from memberships m
			 join users u on u.id = m.user_id
			 where m.user_id = $1 and m.active and u.active
			 order by m.created_at asc`,
			[userId],
		)
		cache.set(userId, { memberships: rows, expiresAt: Date.now() + MEMBERSHIP_TTL_MS })
		return rows
	}

	app.decorate('authenticateUser', async (request: FastifyRequest) => {
		const { userId, email } = await verifyBearer(request)
		request.auth = { userId, email, companyId: '', role: '', memberName: null, isSuperAdmin: false }
	})

	// Отдельный шаг после authenticateUser: подтягивает users.is_super_admin.
	// Не гоним в загрузку каждого запроса — read лишний, а пользователей супер-
	// администраторов буквально 1-2 на всю платформу.
	app.decorate('requireSuperAdmin', async (request: FastifyRequest) => {
		const { rows } = await pool.query(
			`select is_super_admin from users where id = $1 and active`,
			[request.auth.userId],
		)
		if (!rows[0]?.is_super_admin) throw Errors.forbidden('Требуются права супер-администратора')
		request.auth.isSuperAdmin = true
	})

	app.decorate('authenticate', async (request: FastifyRequest) => {
		const { userId, email } = await verifyBearer(request)
		const memberships = await loadMemberships(userId)
		if (memberships.length === 0) throw Errors.noCompany()

		const requested = request.headers['x-company-id']
		let member: MembershipRow | undefined
		if (typeof requested === 'string' && requested.length > 0) {
			member = memberships.find(m => m.company_id === requested)
			if (!member) throw Errors.forbidden('Нет доступа к этой компании')
		} else {
			member = memberships[0]
		}

		request.auth = {
			userId,
			email,
			companyId: member!.company_id,
			role: member!.role ?? 'stock',
			memberName: member!.name ?? null,
			isSuperAdmin: false,
		}
	})

	// Сброс кэша после операций, меняющих членство (accept invitation и т.п.)
	app.decorate('invalidateMembershipCache', (userId: string) => cache.delete(userId))

	// ── B4: X-API-Key ────────────────────────────────────────────────────
	// Формат: sk_live_<8char prefix>_<32char secret>.
	// Проверка: (1) достаём ключ, (2) lookup api_keys.prefix,
	// (3) сверяем sha256(secret) == hash, (4) отдаём companyId в auth.
	// Rate-limit @fastify/rate-limit уже keyGenerator'ит по companyId.
	// last_used_at обновляем best-effort (не блокирует запрос).
	app.decorate('authenticateApiKey', async (request: FastifyRequest) => {
		const header = request.headers['x-api-key']
		if (typeof header !== 'string' || header.length < 20) throw Errors.unauthorized('X-API-Key обязателен')
		// Парсим: sk_live_<prefix>_<secret>. prefix — до последнего '_',
		// secret — после. Валидация формата (не crypto).
		const match = header.match(/^sk_live_([a-z0-9]{6,16})_(.+)$/i)
		if (!match) throw Errors.unauthorized('Некорректный формат X-API-Key')
		const [, prefix, secret] = match
		const hash = createHash('sha256').update(secret!).digest('hex')
		const { rows } = await pool.query(
			`select ak.company_id, ak.id, ak.scopes, ak.active, ak.revoked_at
			 from api_keys ak
			 where ak.prefix = $1 and ak.hash = $2`,
			[prefix, hash],
		)
		const row = rows[0]
		if (!row || !row.active || row.revoked_at) throw Errors.unauthorized('Ключ недействителен')
		// Обновление last_used_at — не критично, не ждём.
		pool.query(`update api_keys set last_used_at = now() where company_id = $1 and id = $2`, [row.company_id, row.id])
			.catch(() => { /* noop */ })
		request.auth = {
			userId: '',  // роботы, а не человек
			email: null,
			companyId: row.company_id,
			role: 'api',
			memberName: null,
			isSuperAdmin: false,
			apiKey: { id: row.id, prefix: prefix!, scopes: row.scopes ?? [] },
		}
	})
}

declare module 'fastify' {
	interface FastifyInstance {
		invalidateMembershipCache: (userId: string) => void
	}
}
