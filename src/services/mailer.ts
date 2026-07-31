import nodemailer, { type Transporter } from 'nodemailer'
import type { Config } from '../config.js'

/**
 * Тонкая обёртка над nodemailer. Провайдер задаётся SMTP_URL:
 *   • smtp://user:pass@smtp.resend.com:465
 *   • smtps://apikey:...@smtp-relay.brevo.com:587
 *   • smtp://localhost:1025  (MailHog для dev)
 *
 * Если SMTP_URL не задан → mailer.available === false, эндпоинты работают,
 * но email не шлётся (для CI/тестов). Ошибку отправки НЕ пробрасываем в UI —
 * логируем и всё равно отвечаем 200 (иначе бы утекали существующие email'ы).
 */
export type Mailer = {
	available: boolean
	send: (opts: { to: string; subject: string; text: string; html?: string }) => Promise<{ ok: boolean; error?: string }>
}

export function makeMailer(config: Config): Mailer {
	const url = config.SMTP_URL
	if (!url) return { available: false, send: async () => ({ ok: false, error: 'SMTP не настроен' }) }

	let transporter: Transporter | null = null
	try {
		transporter = nodemailer.createTransport(url)
	} catch (e) {
		return {
			available: false,
			send: async () => ({ ok: false, error: e instanceof Error ? e.message : 'invalid SMTP_URL' }),
		}
	}
	const from = config.SMTP_FROM || 'SkladPro <no-reply@skladpro.local>'

	return {
		available: true,
		send: async ({ to, subject, text, html }) => {
			try {
				await transporter!.sendMail({ from, to, subject, text, html })
				return { ok: true }
			} catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : 'send failed' }
			}
		},
	}
}
