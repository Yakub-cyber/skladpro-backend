import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { jwtVerify, SignJWT, type JWTPayload } from 'jose'
import type { Config } from '../config.js'

const AUDIENCE = 'skladpro'

export type AccessClaims = {
	sub: string
	email: string
	name: string | null
}

export function makeTokenService(config: Config) {
	const secret = new TextEncoder().encode(config.JWT_SECRET)

	return {
		async signAccessToken(claims: AccessClaims): Promise<string> {
			return new SignJWT({ email: claims.email, name: claims.name, typ: 'access' })
				.setProtectedHeader({ alg: 'HS256' })
				.setSubject(claims.sub)
				.setAudience(AUDIENCE)
				.setIssuedAt()
				.setExpirationTime(`${config.ACCESS_TOKEN_TTL_MIN}m`)
				.setJti(randomUUID())
				.sign(secret)
		},

		async verifyAccessToken(token: string): Promise<JWTPayload> {
			const { payload } = await jwtVerify(token, secret, { audience: AUDIENCE })
			if (payload.typ !== 'access') throw new Error('not an access token')
			return payload
		},

		/**
		 * Refresh-токен — 256 бит случайности, отдаётся клиенту один раз;
		 * в БД хранится только sha256-хэш.
		 */
		newRefreshToken(): { token: string; tokenHash: string } {
			const token = randomBytes(32).toString('base64url')
			return { token, tokenHash: hashRefreshToken(token) }
		},

		refreshExpiry(): Date {
			return new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
		},
	}
}

export function hashRefreshToken(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

export type TokenService = ReturnType<typeof makeTokenService>
