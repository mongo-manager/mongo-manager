import { describe, expect, it } from 'vitest'
import { maskShellSecrets } from '../src/shell/secrets'

describe('masking secrets in shell code (phase 3a-1 spec §8)', () => {
  it('hides a value kept under a secret-looking key, in every quote', () => {
    expect(maskShellSecrets(`const o = { password: 'hunter2', name: 'ada' }`)).toBe(
      `const o = { password: '***', name: 'ada' }`,
    )
    expect(maskShellSecrets('token = "abc"')).toBe('token = "***"')
    expect(maskShellSecrets('apikey: `abc`')).toBe('apikey: `***`')
    expect(maskShellSecrets(`$secret = 'x'`)).toBe(`$secret = '***'`)
  })

  it("hides a URI's password and db.auth's second argument", () => {
    expect(maskShellSecrets('connect("mongodb://ada:pw@host/db")')).toBe('connect("mongodb://ada:***@host/db")')
    expect(maskShellSecrets(`db.auth('ada', 'pw')`)).toBe(`db.auth('ada', '***')`)
  })

  // CodeQL 2026-11-01 (polynomial ReDoS): a key is matched from where a name begins, so a long run of
  // name characters is read once rather than from every one of its positions.
  it('stays fast on a long run of name characters', () => {
    for (const run of ['$'.repeat(50_000), 'a'.repeat(50_000), '$a'.repeat(25_000)]) {
      const started = performance.now()
      maskShellSecrets(run)
      expect(performance.now() - started).toBeLessThan(250)
    }
  })
})
