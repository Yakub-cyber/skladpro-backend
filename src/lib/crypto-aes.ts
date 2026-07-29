import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

/**
 * AES-GCM для секретов уровня «пароль АТОЛ», «webhook secret» и т.п.
 * Ключ читается из окружения (FISCAL_KMS_KEY, WEBHOOK_KMS_KEY). Если ключ
 * пуст, encrypt бросает — мы не хотим тихо писать plain в БД, пусть падает
 * при первом обращении.
 *
 * Формат: 12-байтный IV + ciphertext + 16-байтный auth-tag, всё склеено в
 * один Buffer. Хранится в bytea. Для ротации ключа: делаем decrypt старым +
 * encrypt новым (внешний скрипт).
 *
 * Ключ может быть любой длины (SHA-256 нормализует до 32 байт), но в prod
 * рекомендуется 32-байтная случайная строка base64 (см. .env.example).
 */
const IV_LEN = 12
const TAG_LEN = 16
const ALG = 'aes-256-gcm'

function keyBuffer(secret: string): Buffer {
	// SHA-256 нормализует любой строковый секрет до 32 байт — не нужно
	// требовать точную длину.
	return createHash('sha256').update(secret, 'utf8').digest()
}

export function encryptSecret(plain: string, secret: string): Buffer {
	if (!secret) throw new Error('AES key is empty (FISCAL_KMS_KEY missing)')
	const iv = randomBytes(IV_LEN)
	const cipher = createCipheriv(ALG, keyBuffer(secret), iv)
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
	const tag = cipher.getAuthTag()
	return Buffer.concat([iv, ct, tag])
}

export function decryptSecret(payload: Buffer, secret: string): string {
	if (!secret) throw new Error('AES key is empty (FISCAL_KMS_KEY missing)')
	if (payload.length < IV_LEN + TAG_LEN) throw new Error('Ciphertext too short')
	const iv = payload.subarray(0, IV_LEN)
	const tag = payload.subarray(payload.length - TAG_LEN)
	const ct = payload.subarray(IV_LEN, payload.length - TAG_LEN)
	const decipher = createDecipheriv(ALG, keyBuffer(secret), iv)
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
