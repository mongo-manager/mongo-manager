import { estimatePasswordBits } from '@mongo-manager/shared/browser'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** 24 base58 characters (about 140 bits) in groups of four: easy to read aloud, nothing ambiguous. */
export function generatePassword(): string {
  const chars: string[] = []
  // Rejection sampling: 58 does not divide 256, so bytes past the last whole multiple are dropped.
  const limit = 256 - (256 % ALPHABET.length)
  while (chars.length < 24)
    for (const b of crypto.getRandomValues(new Uint8Array(32)))
      if (b < limit && chars.length < 24) chars.push(ALPHABET[b % ALPHABET.length]!)
  return chars.join('').match(/.{4}/g)!.join('-')
}

/**
 * The guessing cost in bits — the account password meter's estimate (password strength final review
 * M8: one judgement of patterns in the product) — against a backup's higher bar: it is attacked offline.
 */
export function passwordStrength(p: string): 'weak' | 'fair' | 'strong' {
  const bits = estimatePasswordBits(p)
  return bits >= 100 ? 'strong' : bits >= 60 ? 'fair' : 'weak'
}
