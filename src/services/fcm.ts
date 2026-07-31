import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getApps, initializeApp, cert, type App } from 'firebase-admin/app'
import { getMessaging, type Messaging } from 'firebase-admin/messaging'
import type { Config } from '../config.js'

/**
 * Тонкая обёртка над firebase-admin. Инициализируется лениво:
 * FIREBASE_CREDENTIALS пусто → `available === false`, отправка no-op.
 * Так и SMTP, и FCM в тестах/CI отключаются одной пустой env.
 */
export type Fcm = {
	available: boolean
	send: (
		tokens: string[],
		payload: { title: string; body: string; data?: Record<string, string> },
	) => Promise<{ ok: boolean; invalidTokens: string[]; error?: string }>
}

let cached: { app: App; messaging: Messaging } | null = null

function initFirebase(config: Config): { app: App; messaging: Messaging } | null {
	if (cached) return cached
	if (!config.FIREBASE_CREDENTIALS) return null
	const abs = path.isAbsolute(config.FIREBASE_CREDENTIALS)
		? config.FIREBASE_CREDENTIALS
		: path.resolve(process.cwd(), config.FIREBASE_CREDENTIALS)
	let json: unknown
	try {
		json = JSON.parse(readFileSync(abs, 'utf8'))
	} catch (e) {
		console.warn('[fcm] не удалось прочитать service-account:', e instanceof Error ? e.message : e)
		return null
	}
	// Не переиспользуем default-app, если он уже создан кем-то (тесты).
	const app = getApps().length ? getApps()[0]! : initializeApp({ credential: cert(json as never) }, 'skladpro')
	cached = { app, messaging: getMessaging(app) }
	return cached
}

export function makeFcm(config: Config): Fcm {
	const inst = initFirebase(config)
	if (!inst) return { available: false, send: async () => ({ ok: false, invalidTokens: [], error: 'FCM_DISABLED' }) }

	return {
		available: true,
		send: async (tokens, payload) => {
			if (!tokens.length) return { ok: true, invalidTokens: [] }
			// sendEachForMulticast возвращает per-token результат — мы фильтруем
			// UNREGISTERED / INVALID_ARGUMENT / SENDER_ID_MISMATCH: эти токены
			// мёртвые, воркер удалит их из БД. Прочие ошибки — транзиент, ретрай.
			try {
				// webpush-блок нужен именно для web-токенов (браузерных): FCM
				// требует, чтобы notification был в webpush.notification, а не
				// в верхнеуровневом. Верхнеуровневый работает для android/ios,
				// web-токен без webpush-блока приходит без title/body.
				// Аналогично apns для iOS-native (у нас пока не используется).
				const res = await inst.messaging.sendEachForMulticast({
					tokens,
					notification: { title: payload.title, body: payload.body },
					data: payload.data,
					android: { priority: 'high' },
					webpush: {
						notification: {
							title: payload.title,
							body: payload.body,
							icon: '/favicon.svg',
						},
					},
				})
				const invalid: string[] = []
				res.responses.forEach((r, i) => {
					if (r.success) return
					const code = r.error?.code || ''
					if (
						code === 'messaging/registration-token-not-registered' ||
						code === 'messaging/invalid-argument' ||
						code === 'messaging/invalid-registration-token'
					) {
						invalid.push(tokens[i]!)
					}
				})
				return { ok: true, invalidTokens: invalid }
			} catch (e) {
				return {
					ok: false,
					invalidTokens: [],
					error: e instanceof Error ? e.message : 'FCM send failed',
				}
			}
		},
	}
}
