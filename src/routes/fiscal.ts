import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { withTransaction, type DbPool } from '../db.js'
import { decryptSecret, encryptSecret } from '../lib/crypto-aes.js'
import { ApiError, Errors } from '../lib/errors.js'
import { makeAtolClient, type AtolClient, type AtolConfig } from '../lib/fiscal/atol.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'

/**
 * Фискализация 54-ФЗ. POS шлёт нам продажу через POST /v1/fiscal/receipts;
 * мы сохраняем в fiscal_receipts, синхронно вызываем АТОЛ (получаем uuid),
 * ставим processing. Воркер fiscal-worker раз в 30 сек забирает processing
 * и вызывает getReport → апдейт FN/FD/FP + SSE 'fiscal_ready' клиенту.
 *
 * Идемпотентность: POST /v1/fiscal/receipts с Idempotency-Key `fiscal-{saleId}`.
 * Плюс unique-индекс fiscal_receipts_sale_unique — если POS двоит, первый
 * пройдёт, второй → 23505 → 409 DUPLICATE (клиент увидит и подтянет свой
 * существующий).
 */

const ReceiptItemSchema = z.object({
	name: z.string().min(1).max(128),
	price: z.number().nonnegative(),
	quantity: z.number().positive(),
	sum: z.number().nonnegative(),
	paymentMethod: z.enum(['full_prepayment', 'prepayment', 'advance', 'full_payment', 'partial_payment', 'credit', 'credit_payment']).default('full_payment'),
	paymentObject: z.enum(['commodity', 'excise', 'job', 'service', 'gambling_bet', 'gambling_prize', 'lottery', 'lottery_prize', 'intellectual_activity', 'payment', 'agent_commission', 'composite', 'another']).default('commodity'),
	vat: z.object({
		type: z.enum(['none', 'vat0', 'vat10', 'vat20', 'vat110', 'vat120']).default('none'),
		sum: z.number().optional(),
	}).default({ type: 'none' }),
	measurementUnit: z.string().optional(),
})

const CreateReceiptBody = z.object({
	saleId: z.string().uuid(),
	client: z.object({
		email: z.string().email().optional(),
		phone: z.string().optional(),
	}).default({}),
	items: z.array(ReceiptItemSchema).min(1).max(100),
	payments: z.array(z.object({
		type: z.number().int().min(0).max(4),  // 0=нал, 1=безнал, ...
		sum: z.number().positive(),
	})).min(1),
	total: z.number().positive(),
})

const ConfigBody = z.object({
	login: z.string().min(1).max(200),
	// Пароль ККТ. Если пустой — не меняем существующий (для обновления только не-секретных полей).
	password: z.string().max(200).optional(),
	groupCode: z.string().min(1).max(100),
	inn: z.string().regex(/^\d{10,12}$/),
	paymentAddress: z.string().min(1).max(500),
	organizationName: z.string().max(500).optional(),
	sno: z.enum(['osn', 'usn_income', 'usn_income_outcome', 'envd', 'esn', 'patent']).default('usn_income'),
	defaultVat: z.enum(['none', 'vat0', 'vat10', 'vat20', 'vat110', 'vat120']).default('none'),
	senderEmail: z.string().email().max(200).optional(),
	active: z.boolean().default(true),
})

export function registerFiscalRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
	const atol: AtolClient = makeAtolClient()

	function requireKmsOrThrow() {
		if (!config.FISCAL_KMS_KEY) {
			throw new ApiError(503, 'FISCAL_DISABLED', 'Фискализация не настроена: FISCAL_KMS_KEY не задан.')
		}
	}

	// ── Настройки ККТ ───────────────────────────────────────────────────
	// GET — админ видит конфиг без пароля (замаскирован).
	app.get('/v1/fiscal/config', { preHandler: app.authenticate }, async request => {
		requireKmsOrThrow()
		const { rows } = await pool.query(
			`select provider, login, group_code, inn, payment_address, organization_name,
			        sno, default_vat, sender_email, active, updated_at
			 from fiscal_configs where company_id = $1`,
			[request.auth.companyId],
		)
		const row = rows[0]
		if (!row) return { config: null }
		return {
			config: {
				provider: row.provider,
				login: row.login,
				password: row.login ? '***' : '',  // маска, не отдаём даже зашифровано
				groupCode: row.group_code,
				inn: row.inn,
				paymentAddress: row.payment_address,
				organizationName: row.organization_name,
				sno: row.sno,
				defaultVat: row.default_vat,
				senderEmail: row.sender_email,
				active: row.active,
				updatedAt: row.updated_at,
			},
		}
	})

	app.put('/v1/fiscal/config', { preHandler: app.authenticate }, async request => {
		requireKmsOrThrow()
		const auth = request.auth
		if (!['admin', 'manager'].includes(auth.role)) throw Errors.forbidden('Настройки ККТ меняет только админ или менеджер')
		const parsed = ConfigBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const p = parsed.data
		const encPassword = p.password ? encryptSecret(p.password, config.FISCAL_KMS_KEY!) : null
		if (encPassword) {
			await pool.query(
				`insert into fiscal_configs
				   (company_id, login, password_encrypted, group_code, inn, payment_address,
				    organization_name, sno, default_vat, sender_email, active)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
				 on conflict (company_id) do update set
				   login = excluded.login,
				   password_encrypted = excluded.password_encrypted,
				   group_code = excluded.group_code,
				   inn = excluded.inn,
				   payment_address = excluded.payment_address,
				   organization_name = excluded.organization_name,
				   sno = excluded.sno,
				   default_vat = excluded.default_vat,
				   sender_email = excluded.sender_email,
				   active = excluded.active`,
				[auth.companyId, p.login, encPassword, p.groupCode, p.inn, p.paymentAddress,
					p.organizationName ?? null, p.sno, p.defaultVat, p.senderEmail ?? null, p.active],
			)
		} else {
			// Пароль не пришёл — не трогаем password_encrypted (у существующей записи).
			await pool.query(
				`insert into fiscal_configs
				   (company_id, login, group_code, inn, payment_address,
				    organization_name, sno, default_vat, sender_email, active)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
				 on conflict (company_id) do update set
				   login = excluded.login,
				   group_code = excluded.group_code,
				   inn = excluded.inn,
				   payment_address = excluded.payment_address,
				   organization_name = excluded.organization_name,
				   sno = excluded.sno,
				   default_vat = excluded.default_vat,
				   sender_email = excluded.sender_email,
				   active = excluded.active`,
				[auth.companyId, p.login, p.groupCode, p.inn, p.paymentAddress,
					p.organizationName ?? null, p.sno, p.defaultVat, p.senderEmail ?? null, p.active],
			)
		}
		return { ok: true }
	})

	// ── Создать чек (POS вызывает при пробитии продажи) ─────────────────
	app.post('/v1/fiscal/receipts', { preHandler: app.authenticate }, async (request, reply) => {
		requireKmsOrThrow()
		const auth = request.auth
		const idemKey = request.headers['idempotency-key'] as string | undefined
		if (!idemKey) throw Errors.validation([{ message: 'Idempotency-Key обязателен' }])
		const parsed = CreateReceiptBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const body = parsed.data

		// Транзакция: claim ключа + запись pending fiscal_receipts. АТОЛ
		// вызываем ПОСЛЕ commit'а, потому что external HTTP-запрос может
		// висеть, а держать транзакцию открытой минутами — плохо.
		const prep = await withTransaction(pool, async client => {
			const claim = await claimIdempotencyKey(client, {
				key: idemKey,
				companyId: auth.companyId,
				endpoint: '/v1/fiscal/receipts',
			})
			if (claim.replay) return { kind: 'replay' as const, status: claim.status, response: claim.response }

			// Загружаем конфиг ККТ
			const { rows: cfgRows } = await client.query(
				`select login, password_encrypted, group_code, inn, payment_address,
				        organization_name, sno, sender_email, active
				 from fiscal_configs where company_id = $1`,
				[auth.companyId],
			)
			const cfg = cfgRows[0]
			if (!cfg || !cfg.active || !cfg.login || !cfg.password_encrypted) {
				throw new ApiError(412, 'FISCAL_NOT_CONFIGURED', 'Настройки ККТ не заполнены или отключены. Заполните /v1/fiscal/config.')
			}
			const receiptId = randomUUID()
			const externalId = receiptId
			const requestBody = {
				externalId,
				receipt: {
					client: body.client,
					company: {
						email: cfg.sender_email || 'noreply@skladpro.ru',
						sno: cfg.sno,
						inn: cfg.inn,
						paymentAddress: cfg.payment_address,
					},
					items: body.items,
					payments: body.payments,
					total: body.total,
				},
			}

			try {
				await client.query(
					`insert into fiscal_receipts
					   (company_id, id, sale_id, provider, external_id, status, request_body)
					 values ($1, $2, $3, 'atol', $4, 'pending', $5)`,
					[auth.companyId, receiptId, body.saleId, externalId, JSON.stringify(requestBody)],
				)
			} catch (e) {
				const err = e as { code?: string }
				if (err.code === '23505') {
					// Дубль по sale_id — вернём существующий чек, но сначала запишем в idempotency.
					const { rows: exist } = await client.query(
						`select id, status, fn, fd, fp, ofd_url, qr from fiscal_receipts
						 where company_id = $1 and sale_id = $2`,
						[auth.companyId, body.saleId],
					)
					const r = exist[0]
					const respBody = r
						? { receiptId: r.id, status: r.status, fn: r.fn, fd: r.fd, fp: r.fp, ofdUrl: r.ofd_url, qr: r.qr }
						: { receiptId: null }
					await storeIdempotentResponse(client, auth.companyId, idemKey, 200, respBody)
					return { kind: 'duplicate' as const, response: respBody }
				}
				throw e
			}

			const password = decryptSecret(cfg.password_encrypted as Buffer, config.FISCAL_KMS_KEY!)
			const atolCfg: AtolConfig = {
				login: cfg.login, password, groupCode: cfg.group_code, inn: cfg.inn,
				paymentAddress: cfg.payment_address, organizationName: cfg.organization_name,
				sno: cfg.sno, senderEmail: cfg.sender_email,
				baseUrl: config.FISCAL_ATOL_BASE_URL,
			}
			return { kind: 'created' as const, receiptId, requestBody, atolCfg }
		})

		if (prep.kind === 'replay') {
			reply.code(prep.status)
			return prep.response
		}
		if (prep.kind === 'duplicate') {
			reply.code(200)
			return prep.response
		}

		// Вызываем АТОЛ вне транзакции — external HTTP.
		const sellRes = await atol.sell(prep.atolCfg, prep.requestBody as never)
		if (sellRes.ok) {
			const respBody = { receiptId: prep.receiptId, status: 'processing', atolUuid: sellRes.uuid }
			await withTransaction(pool, async client => {
				await client.query(
					`update fiscal_receipts set status = 'processing',
					   external_id = $3, response_body = $4
					 where company_id = $1 and id = $2`,
					[auth.companyId, prep.receiptId, sellRes.uuid, JSON.stringify({ status: sellRes.status })],
				)
				await storeIdempotentResponse(client, auth.companyId, idemKey, 201, respBody)
			})
			reply.code(201)
			return respBody
		}
		const finalStatus = sellRes.kind === 'RETRY_LATER' ? 'pending' : 'failed'
		const respBody = { receiptId: prep.receiptId, status: finalStatus, error: { code: sellRes.kind, message: sellRes.error } }
		await withTransaction(pool, async client => {
			await client.query(
				`update fiscal_receipts set status = $3, error_code = $4, error_message = $5
				 where company_id = $1 and id = $2`,
				[auth.companyId, prep.receiptId, finalStatus, sellRes.kind, sellRes.error],
			)
			await storeIdempotentResponse(client, auth.companyId, idemKey, 202, respBody)
		})
		reply.code(202)
		return respBody
	})

	// ── Получить статус чека ─────────────────────────────────────────────
	app.get('/v1/fiscal/receipts/:id', { preHandler: app.authenticate }, async request => {
		const receiptId = (request.params as { id: string }).id
		const { rows } = await pool.query(
			`select id, sale_id, status, fn, fd, fp, ofd_url, qr,
			        error_code, error_message, retries, created_at, closed_at
			 from fiscal_receipts where company_id = $1 and id = $2`,
			[request.auth.companyId, receiptId],
		)
		const r = rows[0]
		if (!r) throw Errors.notFound('Чек')
		return {
			receipt: {
				id: r.id,
				saleId: r.sale_id,
				status: r.status,
				fn: r.fn,
				fd: r.fd,
				fp: r.fp,
				ofdUrl: r.ofd_url,
				qr: r.qr,
				error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
				retries: r.retries,
				createdAt: r.created_at,
				closedAt: r.closed_at,
			},
		}
	})

}
