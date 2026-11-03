import { MIN_DB_PASSWORD, estimatePasswordBits } from '@mongo-manager/shared/browser'

/**
 * W3.1: a MongoDB user's password, made in the administrator's browser from the operating system's
 * random source (crypto.getRandomValues). Letters and digits without look-alikes (0/O, 1/l/I) and
 * the symbols a connection string never needs escaped, every class present. The server never makes
 * or keeps it.
 */
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '-_.~'
const ALL = LOWER + UPPER + DIGITS + SYMBOLS
export const GENERATED_LENGTH = 24

/** An unbiased index below `n` (rejection sampling). */
function pick(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n
  const buffer = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buffer)
    if (buffer[0]! < limit) return buffer[0]! % n
  }
}

export function generatePassword(length = GENERATED_LENGTH): string {
  const chars = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => set[pick(set.length)]!)
  while (chars.length < length) chars.push(ALL[pick(ALL.length)]!)
  // Fisher–Yates: the guaranteed classes are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = pick(i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}

export type PasswordStrength = 'tooShort' | 'weak' | 'fair' | 'strong'

/** A rough rating for the editor's hint: length and variety, not a cracking estimate. */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < MIN_DB_PASSWORD) return 'tooShort'
  // Password strength final review M8: what the account meter calls predictable is weak here too.
  if (estimatePasswordBits(password) < 30) return 'weak'
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length
  const distinct = new Set(password).size
  if (distinct < 5 || classes < 2) return 'weak'
  if (password.length >= 16 && classes >= 3) return 'strong'
  return 'fair'
}
