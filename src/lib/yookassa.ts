import type { Config } from '../config.js'

/**
 * Тонкая обёртка над ЮKassa REST API v3.
 * Полный SDK (npm пакет `yookassa`) не берём — здесь нам нужны только
 * два вызова (createPayment, cancelPayment), плюс типы. Меньше зависимостей.
 *
 * Docs: https://yookassa.ru/developers/api
 *
 * Инициализация ленивая: если YOOKASSA_SHOP_ID/SECRET_KEY пусто, клиент
 * невозможен (available=false). checkout-эндпоинт вернёт 503, а enforcement
 * лимитов при этом продолжает работать (сам факт наличия платёжной системы
 * не нужен для валидации).
 */

export type YooKassaPaymentReq = {
	amount: { value: string; currency: string }
	confirmation: { type: 'redirect'; return_url: string }
	description: string
	capture: boolean
	metadata: Record<string, string>
}

export type YooKassaPaymentRes = {
	id: string
	status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled'
	confirmation?: { type: string; confirmation_url?: string }
	amount: { value: string; currency: string }
	metadata?: Record<string, string>
	paid?: boolean
	created_at: string
}

export type YooKassaClient = {
	available: boolean
	createPayment: (payment: YooKassaPaymentReq, idempotencyKey: string) => Promise<YooKassaPaymentRes>
}

export function makeYooKassa(config: Config): YooKassaClient {
	if (!config.YOOKASSA_SHOP_ID || !config.YOOKASSA_SECRET_KEY) {
		return {
			available: false,
			createPayment: async () => { throw new Error('YOOKASSA_DISABLED') },
		}
	}
	const auth = Buffer.from(`${config.YOOKASSA_SHOP_ID}:${config.YOOKASSA_SECRET_KEY}`).toString('base64')
	const base = 'https://api.yookassa.ru/v3'
	return {
		available: true,
		async createPayment(payment, idempotencyKey) {
			const res = await fetch(`${base}/payments`, {
				method: 'POST',
				headers: {
					'Authorization': `Basic ${auth}`,
					'Content-Type': 'application/json',
					// Ключ идемпотентности ЮKassa (не путать с нашим Idempotency-Key).
					// Тот же ключ в течение 24ч → тот же платёж (без дубля списания).
					'Idempotence-Key': idempotencyKey,
				},
				body: JSON.stringify(payment),
			})
			if (!res.ok) {
				const text = await res.text().catch(() => '')
				throw new Error(`YooKassa createPayment ${res.status}: ${text.slice(0, 500)}`)
			}
			return await res.json() as YooKassaPaymentRes
		},
	}
}

// Цены в рублях за 1 месяц. Значения пойдут в CTA веб-клиента.
// Для «trial» и «free» цена не задаётся — checkout на эти планы не создаётся.
export const PLAN_PRICES_RUB: Partial<Record<'start' | 'business' | 'pro', number>> = {
	start: 990,
	business: 2990,
	pro: 7900,
}
