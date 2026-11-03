import { describe, expect, it } from 'vitest'
import { generatePassword, passwordStrength } from '../src/dbaccess/password'

/**
 * W3.1: a database user's password generated in the administrator's browser (never by the server,
 * never stored): from the operating system's random source, long, every class present, nothing a
 * connection string would need escaped.
 */
describe('generated MongoDB passwords', () => {
  it('are 24 characters of letters, digits and URI-safe symbols, every class present', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword()
      expect(p).toHaveLength(24)
      expect(p).toMatch(/^[A-Za-z0-9_.~-]+$/)
      expect(p).toMatch(/[a-z]/)
      expect(p).toMatch(/[A-Z]/)
      expect(p).toMatch(/[0-9]/)
      expect(p).toMatch(/[_.~-]/)
      // No look-alikes: 0/O, 1/l/I.
      expect(p).not.toMatch(/[0O1lI]/)
    }
  })

  it('do not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()))
    expect(seen.size).toBe(500)
  })

  it('rates a typed password', () => {
    expect(passwordStrength('short')).toBe('tooShort')
    expect(passwordStrength('aaaaaaaaaaaa')).toBe('weak')
    expect(passwordStrength('correct horse battery')).toBe('fair')
    // Password strength final review M8: the patterns the account meter knows are weak here too.
    expect(passwordStrength('Password1234!')).toBe('weak')
    expect(passwordStrength('qwertyuiopasdf')).toBe('weak')
    expect(passwordStrength(generatePassword())).toBe('strong')
  })
})
