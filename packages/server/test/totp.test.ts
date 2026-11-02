import { describe, expect, it } from 'vitest'
import { generateTotpSecret, totpCode, totpUri, verifyTotp } from '../src/auth/totp'

// RFC 6238 Appendix B, SHA-1, secret "12345678901234567890"
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ]
    for (const [t, code] of vectors) expect(totpCode(RFC_SECRET, t * 1000, 8)).toBe(code)
    expect(totpCode(RFC_SECRET, 59_000)).toBe('287082')
  })

  it('generates 32-character base32 secrets', () => {
    const s = generateTotpSecret()
    expect(s).toMatch(/^[A-Z2-7]{32}$/)
    expect(generateTotpSecret()).not.toBe(s)
  })

  it('accepts the current and adjacent steps and returns the step', () => {
    const now = 1_700_000_000_000
    const step = Math.floor(now / 30_000)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), now)).toBe(step)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30_000), now)).toBe(step - 1)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30_000), now)).toBe(step + 1)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 90_000), now)).toBeNull()
  })

  it('rejects replays of an already used step and malformed codes', () => {
    const now = 1_700_000_000_000
    const code = totpCode(RFC_SECRET, now)
    const step = verifyTotp(RFC_SECRET, code, now)!
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull()
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456'])
      expect(verifyTotp(RFC_SECRET, bad, now)).toBeNull()
  })

  it('builds an otpauth URI', () => {
    expect(totpUri('ABC', 'alice')).toBe(
      'otpauth://totp/Mongo%20Manager:alice?secret=ABC&issuer=Mongo%20Manager&algorithm=SHA1&digits=6&period=30',
    )
  })
})
