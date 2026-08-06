/**
 * Единый формат ошибок API: { error: { code, message, details? } }.
 * Коды стабильны — клиенты матчатся по ним, не по тексту.
 */
export class ApiError extends Error {
	statusCode: number
	code: string
	details?: unknown

	constructor(statusCode: number, code: string, message: string, details?: unknown) {
		super(message)
		this.statusCode = statusCode
		this.code = code
		this.details = details
	}
}

export const Errors = {
	unauthorized: (msg = 'Требуется авторизация') => new ApiError(401, 'UNAUTHORIZED', msg),
	forbidden: (msg = 'Недостаточно прав') => new ApiError(403, 'FORBIDDEN', msg),
	noCompany: () => new ApiError(403, 'NO_COMPANY', 'Пользователь не состоит ни в одной компании'),
	notFound: (what: string) => new ApiError(404, 'NOT_FOUND', `${what} не найден`),
	validation: (details: unknown) => new ApiError(400, 'VALIDATION_ERROR', 'Некорректные данные запроса', details),
	insufficientStock: (productId: string, available: number, requested: number) =>
		new ApiError(409, 'INSUFFICIENT_STOCK', 'Недостаточно остатка', { productId, available, requested }),
	duplicate: (what: string) => new ApiError(409, 'DUPLICATE', `${what} уже существует`),
	inProgress: () => new ApiError(409, 'IN_PROGRESS', 'Запрос с этим Idempotency-Key ещё обрабатывается, повторите позже'),
	idempotencyMismatch: (was: string, now: string) =>
		new ApiError(409, 'IDEMPOTENCY_MISMATCH', 'Этот Idempotency-Key уже использован для другой операции', { was, now }),
	pinInvalid: () => new ApiError(401, 'PIN_INVALID', 'Неверный PIN'),
	// Лимит текущего тарифа исчерпан (B2). 402 Payment Required — семантически
	// точный код: клиент должен апгрейднуть подписку.
	subscriptionLimit: (feature: string, limit: number, current: number, plan: string) =>
		new ApiError(402, 'SUBSCRIPTION_LIMIT_EXCEEDED', `Лимит плана «${plan}» на ${feature} исчерпан (${current}/${limit}).`, { feature, limit, current, plan }),
	subscriptionExpired: () =>
		new ApiError(402, 'SUBSCRIPTION_EXPIRED', 'Подписка истекла. Продлите тариф для продолжения работы.'),
}

const PG_ERROR_MAP: Record<string, (msg: string) => ApiError> = {
	P0001: (msg) => new ApiError(409, 'INSUFFICIENT_STOCK', msg),
	P0002: (msg) => new ApiError(404, 'DOC_NOT_FOUND', msg),
	P0003: (msg) => new ApiError(409, 'DOC_ALREADY_POSTED', msg),
	P0004: (msg) => new ApiError(400, 'UNKNOWN_DOC_TYPE', msg),
	P0005: (msg) => new ApiError(400, 'INVALID_QTY', msg),
	P0006: (msg) => new ApiError(400, 'MISSING_PARTY', msg),
	P0007: (msg) => new ApiError(400, 'MISSING_ACCOUNT', msg),
	P0008: (msg) => new ApiError(409, 'DOC_NOT_POSTED', msg),
	P0009: (msg) => new ApiError(500, 'LEDGER_GUARD', msg),
}

export function mapPgError(err: unknown): Error {
	if (err && typeof err === 'object' && 'code' in err && typeof (err as any).code === 'string') {
		const pgCode = (err as any).code as string
		const factory = PG_ERROR_MAP[pgCode]
		if (factory) return factory((err as any).message ?? pgCode)
	}
	if (err instanceof Error) return err
	return new Error(String(err))
}
