import 'dotenv/config'
import { z } from 'zod'

const Env = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	PORT: z.coerce.number().int().min(1).max(65535).default(8787),
	HOST: z.string().default('0.0.0.0'),

	// Собственный Postgres (managed или свой). Никакого Supabase.
	DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен (см. .env.example)'),
	// disable — локальный PG; require — TLS без проверки CA; verify — TLS + CA (продакшен)
	DATABASE_SSL: z.enum(['disable', 'require', 'verify']).default('disable'),
	DATABASE_SSL_CA: z.string().optional(), // путь к CA-сертификату при verify

	// Секрет подписи access-токенов. Минимум 32 символа, сгенерировать:
	// node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
	JWT_SECRET: z.string().min(32, 'JWT_SECRET: минимум 32 символа'),
	ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(1).max(24 * 60).default(15),
	REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

	CORS_ORIGINS: z.string().default(''),
	RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
	TRUST_PROXY: z
		.string()
		.default('false')
		.transform(v => v === 'true' || v === '1'),

	// SMTP для password reset (и будущих системных email'ов).
	// Формат: smtp[s]://user:pass@host:port. Пусто = email отключён (dev/CI).
	SMTP_URL: z.string().optional().transform(v => (v === '' ? undefined : v)),
	// Отправитель: "Название <no-reply@ваш-домен>". По умолчанию — заглушка.
	SMTP_FROM: z.string().optional().transform(v => (v === '' ? undefined : v)),
	// URL, куда встраивается токен в письме сброса. По умолчанию — веб-версия.
	// В письме шлём {APP_URL}/#/reset?token={token}
	APP_URL: z.string().default('https://yakub-cyber.github.io/skladpro/'),

	// FCM для push-уведомлений на мобилку/POS. Путь к service-account JSON.
	// Пусто — воркер не запускается (нет ошибок).
	FIREBASE_CREDENTIALS: z.string().optional().transform(v => (v === '' ? undefined : v)),

	// Sentry DSN для мониторинга ошибок. Пусто — Sentry не инициализируется
	// (dev/CI/тесты). Формат: https://xxx@oXXX.ingest.sentry.io/YYY
	SENTRY_DSN: z.string().optional().transform(v => (v === '' ? undefined : v)),

	// ── AI-суппорт (провайдер-агностично, куда шлём тикеты клиентов) ────────
	// Имя переменных «AI_SUPPORT_*» — универсальные, не привязаны к n8n:
	// на другой стороне может быть Zapier, Make, cron-скрипт, что угодно
	// с тем же HMAC-контрактом.
	//
	// URL webhook'а, куда бэкенд шлёт созданный тикет. Пусто — тикеты
	// всё равно сохраняются в БД, но AI-пайплайн не запускается (dev/CI).
	AI_SUPPORT_WEBHOOK_URL: z.string().url().optional().transform(v => (v === '' ? undefined : v)),
	// Секрет HMAC-SHA256: подпись исходящих webhook'ов + проверка входящих
	// PATCH-callback'ов. Обязателен, если задан URL (см. loadConfig).
	AI_SUPPORT_HMAC_SECRET: z.string().min(16).optional().transform(v => (v === '' ? undefined : v)),

	// Deprecated aliases — были специфичны для n8n-only setup. Оставлены
	// для обратной совместимости на переходный период; loadConfig() зальёт
	// их значение в новые поля, если новые не заданы. Удалить в v0.2.
	N8N_SUPPORT_WEBHOOK_URL: z.string().url().optional().transform(v => (v === '' ? undefined : v)),
	N8N_WEBHOOK_SECRET: z.string().min(16).optional().transform(v => (v === '' ? undefined : v)),

	// ── /metrics endpoint для Prometheus ──────────────────────────────────
	// Пусто → эндпоинт есть, но открыт (годится для локальной разработки).
	// Продакшен — задать оба, доступ через HTTP-basic-auth.
	METRICS_USER: z.string().optional().transform(v => (v === '' ? undefined : v)),
	METRICS_PASS: z.string().optional().transform(v => (v === '' ? undefined : v)),

	// ── ЮKassa (подписки B2) ──────────────────────────────────────────────
	// SHOP_ID из личного кабинета ЮKassa (Настройки → Магазины).
	// SECRET_KEY — «Секретный ключ» для API (генерируется отдельно от тестового).
	// Если пусто — /v1/subscription/checkout вернёт 503 (билинг отключён);
	// enforcement лимитов при этом продолжает работать (полагается на БД).
	YOOKASSA_SHOP_ID: z.string().optional().transform(v => (v === '' ? undefined : v)),
	YOOKASSA_SECRET_KEY: z.string().optional().transform(v => (v === '' ? undefined : v)),
	// Страница, куда ЮKassa вернёт пользователя после оплаты.
	// Обычно — фронтенд-роут «Спасибо, платёж прошёл».
	YOOKASSA_RETURN_URL: z.string().url().optional().transform(v => (v === '' ? undefined : v)),
	// Опциональный whitelist IP-адресов ЮKassa для webhook (см. их доки).
	// Через запятую. Пусто = проверки нет (сервер полагается на unique
	// external_id и статус-мэппинг).
	YOOKASSA_WEBHOOK_IP_WHITELIST: z.string().optional().transform(v => (v === '' ? undefined : v)),

	// ── Fiscal / АТОЛ (B3) ────────────────────────────────────────────────
	// Ключ для шифрования пароля ККТ в БД (AES-GCM). Любая строка ≥ 32
	// символа (SHA-256 нормализует). Пусто = fiscal-эндпоинты возвращают 503
	// (админ не может сохранить креды, воркер не читает).
	// Сгенерировать: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
	FISCAL_KMS_KEY: z.string().optional().transform(v => (v === '' ? undefined : v)),
	// Базовый URL АТОЛ Онлайн. По умолчанию — прод. Для интеграционного
	// тестирования — https://testonline.atol.ru/possystem/v5
	FISCAL_ATOL_BASE_URL: z.string().url().optional().transform(v => (v === '' ? undefined : v)),
})

export type Config = z.infer<typeof Env>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const parsed = Env.safeParse(env)
	if (!parsed.success) {
		const details = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')
		throw new Error(`Некорректная конфигурация окружения:\n${details}`)
	}
	// Fallback со старых N8N_-имён на новые AI_SUPPORT_-имена. Работает
	// прозрачно: если задано новое — приоритет у него; если старое — берём его.
	const data = parsed.data
	if (!data.AI_SUPPORT_WEBHOOK_URL && data.N8N_SUPPORT_WEBHOOK_URL) {
		data.AI_SUPPORT_WEBHOOK_URL = data.N8N_SUPPORT_WEBHOOK_URL
	}
	if (!data.AI_SUPPORT_HMAC_SECRET && data.N8N_WEBHOOK_SECRET) {
		data.AI_SUPPORT_HMAC_SECRET = data.N8N_WEBHOOK_SECRET
	}
	// URL без секрета = дырка (не сможем подписать / проверить callback).
	if (data.AI_SUPPORT_WEBHOOK_URL && !data.AI_SUPPORT_HMAC_SECRET) {
		throw new Error('AI_SUPPORT_HMAC_SECRET обязателен, если задан AI_SUPPORT_WEBHOOK_URL')
	}
	return data
}

export function corsOrigins(config: Config): string[] {
	return config.CORS_ORIGINS.split(',')
		.map(s => s.trim())
		.filter(Boolean)
}
