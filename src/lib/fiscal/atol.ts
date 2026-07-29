/**
 * АТОЛ Онлайн Web API v5 — тонкая обёртка.
 * Полный SDK не берём: нам нужны 3 вызова (getToken, sell, getReport).
 *
 * Docs: https://online.atol.ru/possystem/v5/ (актуальная спецификация в
 * личном кабинете АТОЛ Онлайн).
 *
 * Base URL:
 *   prod: https://online.atol.ru/possystem/v5
 *   test: https://testonline.atol.ru/possystem/v5
 *
 * Аутентификация:
 *   POST /getToken { login, pass } → { token, timestamp, error }
 *   Токен живёт 24 часа. Кешируем в памяти (в кластере — на каждом инстансе
 *   свой; накладные расходы минимальные).
 *
 * Отправка чека:
 *   POST /{group_code}/sell { external_id, receipt, service, timestamp }
 *   HEADER: token
 *   → { uuid, status: 'wait', timestamp }
 *   uuid — идентификатор фискального документа. Используем для getReport.
 *
 * Проверка статуса:
 *   GET /{group_code}/report/{uuid} → { status, error, payload, callback_url }
 *   status: 'wait' | 'done' | 'fail'.
 *   payload.fn_number, payload.fiscal_document_number, payload.fiscal_document_attribute — FN/FD/FP.
 *   payload.ofd_receipt_url — ссылка на чек.
 */

export type AtolConfig = {
	login: string
	password: string
	groupCode: string
	inn: string
	paymentAddress: string
	organizationName?: string | null
	sno: string
	senderEmail?: string | null
	baseUrl?: string  // прод по умолчанию; testonline — для интеграционного окружения
}

export type AtolReceiptItem = {
	name: string
	price: number
	quantity: number
	sum: number
	paymentMethod: 'full_prepayment' | 'prepayment' | 'advance' | 'full_payment' | 'partial_payment' | 'credit' | 'credit_payment'
	paymentObject: 'commodity' | 'excise' | 'job' | 'service' | 'gambling_bet' | 'gambling_prize' | 'lottery' | 'lottery_prize' | 'intellectual_activity' | 'payment' | 'agent_commission' | 'composite' | 'another'
	vat: {
		type: 'none' | 'vat0' | 'vat10' | 'vat20' | 'vat110' | 'vat120'
		sum?: number
	}
	measurementUnit?: string
}

export type AtolSellRequest = {
	externalId: string
	receipt: {
		client: { email?: string; phone?: string }
		company: {
			email: string
			sno: string
			inn: string
			paymentAddress: string
		}
		items: AtolReceiptItem[]
		payments: Array<{ type: 0 | 1 | 2 | 3 | 4; sum: number }>  // 0=нал, 1=безнал, 2=аванс, 3=кредит, 4=иная
		total: number
	}
	// unix seconds
	timestamp?: number
}

export type AtolClientResult =
	| { ok: true; uuid: string; status: 'wait' | 'done' | 'fail' }
	| { ok: false; kind: 'RETRY_LATER' | 'FATAL_INVALID_DATA' | 'AUTH_FAIL' | 'NETWORK'; error: string; code?: number }

export type AtolReport =
	| { status: 'wait' }
	| { status: 'done'; fn: string; fd: string; fp: string; ofdUrl?: string; qr?: string; raw: unknown }
	| { status: 'fail'; error: string; code?: number; raw: unknown }

export type AtolClient = {
	sell: (config: AtolConfig, req: AtolSellRequest) => Promise<AtolClientResult>
	getReport: (config: AtolConfig, uuid: string) => Promise<AtolReport>
}

// Простой in-memory кеш токенов на процесс. Ключ — login (не по groupCode:
// один login — один токен, обычно у компании один set креденшилов).
type TokenEntry = { token: string; issuedAt: number }
const tokenCache = new Map<string, TokenEntry>()
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000  // АТОЛ выдаёт на 24ч, обновляем чуть раньше

async function getToken(config: AtolConfig): Promise<string> {
	const cached = tokenCache.get(config.login)
	if (cached && Date.now() - cached.issuedAt < TOKEN_TTL_MS) return cached.token
	const base = config.baseUrl ?? 'https://online.atol.ru/possystem/v5'
	const res = await fetch(`${base}/getToken`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ login: config.login, pass: config.password }),
	})
	if (!res.ok) throw new Error(`АТОЛ getToken HTTP ${res.status}`)
	const data = await res.json() as { token?: string; error?: { code: number; text: string } | null }
	if (data.error) throw Object.assign(new Error(`АТОЛ auth: ${data.error.text}`), { atolCode: data.error.code })
	if (!data.token) throw new Error('АТОЛ getToken: token отсутствует')
	tokenCache.set(config.login, { token: data.token, issuedAt: Date.now() })
	return data.token
}

export function makeAtolClient(): AtolClient {
	return {
		async sell(config, req) {
			const base = config.baseUrl ?? 'https://online.atol.ru/possystem/v5'
			let token: string
			try {
				token = await getToken(config)
			} catch (e) {
				const err = e as { atolCode?: number; message?: string }
				return { ok: false, kind: 'AUTH_FAIL', error: err.message ?? 'Ошибка авторизации АТОЛ', code: err.atolCode }
			}
			const timestamp = req.timestamp ?? Math.floor(Date.now() / 1000)
			const body = {
				external_id: req.externalId,
				timestamp: new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19),
				receipt: {
					client: req.receipt.client,
					company: {
						email: req.receipt.company.email,
						sno: req.receipt.company.sno,
						inn: req.receipt.company.inn,
						payment_address: req.receipt.company.paymentAddress,
					},
					items: req.receipt.items.map(it => ({
						name: it.name,
						price: it.price,
						quantity: it.quantity,
						sum: it.sum,
						payment_method: it.paymentMethod,
						payment_object: it.paymentObject,
						vat: it.vat,
						measurement_unit: it.measurementUnit,
					})),
					payments: req.receipt.payments,
					total: req.receipt.total,
				},
				service: { callback_url: '' },
			}
			try {
				const res = await fetch(`${base}/${encodeURIComponent(config.groupCode)}/sell`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json; charset=utf-8', Token: token },
					body: JSON.stringify(body),
				})
				const data = await res.json() as { uuid?: string; status?: string; error?: { code: number; text: string; type?: string } | null }
				// АТОЛ иногда возвращает 400 с error.code — не сетевая ошибка, обрабатываем как fatal/retry по типу
				if (data.error) {
					const kind = classifyAtolError(data.error.code, data.error.text)
					return { ok: false, kind, error: data.error.text, code: data.error.code }
				}
				if (!data.uuid) return { ok: false, kind: 'FATAL_INVALID_DATA', error: 'АТОЛ не вернула uuid' }
				return { ok: true, uuid: data.uuid, status: (data.status as 'wait' | 'done' | 'fail') ?? 'wait' }
			} catch (e) {
				return { ok: false, kind: 'NETWORK', error: e instanceof Error ? e.message : 'сеть' }
			}
		},

		async getReport(config, uuid) {
			const base = config.baseUrl ?? 'https://online.atol.ru/possystem/v5'
			const token = await getToken(config)
			const res = await fetch(`${base}/${encodeURIComponent(config.groupCode)}/report/${encodeURIComponent(uuid)}`, {
				headers: { Token: token },
			})
			// АТОЛ на wait иногда возвращает 202
			const raw = await res.json() as {
				status?: string
				error?: { code: number; text: string } | null
				payload?: {
					fn_number?: string
					fiscal_document_number?: number | string
					fiscal_document_attribute?: number | string
					ofd_receipt_url?: string
					fiscal_receipt_qr_code?: string
				}
			}
			if (raw.status === 'wait') return { status: 'wait' }
			if (raw.error) return { status: 'fail', error: raw.error.text, code: raw.error.code, raw }
			if (raw.status === 'done' && raw.payload?.fn_number) {
				return {
					status: 'done',
					fn: raw.payload.fn_number,
					fd: String(raw.payload.fiscal_document_number ?? ''),
					fp: String(raw.payload.fiscal_document_attribute ?? ''),
					ofdUrl: raw.payload.ofd_receipt_url,
					qr: raw.payload.fiscal_receipt_qr_code,
					raw,
				}
			}
			// Ветка достижима, только если status !== 'wait' / 'done' и error пуст:
			// это «unknown state» — АТОЛ вернул что-то нестандартное.
			return { status: 'fail', error: `unexpected status: ${raw.status ?? 'undefined'}`, raw }
		},
	}
}

// Классификация ошибок АТОЛ по коду. Основано на их доке:
// 20 — session expired (перевыпустить токен и попробовать ещё раз)
// 30 — нет соединения с ККТ (retry)
// 3, 5-х — некорректные данные чека (fatal)
// Полный список: см. АТОЛ docs. Здесь — упрощённая эвристика.
export function classifyAtolError(code: number, text: string): 'RETRY_LATER' | 'FATAL_INVALID_DATA' | 'AUTH_FAIL' {
	if (code === 20 || code === 21) return 'AUTH_FAIL'
	if (code === 30 || code === 31 || code === 32) return 'RETRY_LATER'
	if (text.toLowerCase().includes('таймаут') || text.toLowerCase().includes('нет связи')) return 'RETRY_LATER'
	return 'FATAL_INVALID_DATA'
}

// Служебный сброс кеша токенов — для тестов и на случай ротации креденшилов.
export function clearAtolTokenCache() {
	tokenCache.clear()
}
