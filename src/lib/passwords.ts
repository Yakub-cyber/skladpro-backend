import bcrypt from 'bcryptjs'

// 11 раундов ≈ 100–150 мс на проверку — тормозит перебор, не тормозит людей.
const ROUNDS = 11

export function hashPassword(plain: string): Promise<string> {
	return bcrypt.hash(plain, ROUNDS)
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
	return bcrypt.compare(plain, hash)
}

/** Хэши GoTrue (Supabase) — тоже bcrypt ($2a$…), совместимы при импорте. */
export function isBcryptHash(hash: string | null | undefined): boolean {
	return typeof hash === 'string' && /^\$2[aby]\$/.test(hash)
}
