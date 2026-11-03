import { describe, expect, it } from 'vitest'
import { MAX_PATH_SEGMENTS, matchesAny, underAny } from '../src'

describe('personal-path glob (phase 3c)', () => {
  const rules = [['email'], ['items', 'cardNo'], ['**', 'phone']]
  it('matches names, positions and ** at any depth', () => {
    expect(matchesAny(rules, ['email'])).toBe(true)
    expect(matchesAny(rules, ['items', '0', 'cardNo'])).toBe(true)
    expect(matchesAny(rules, ['items', '$[]', 'cardNo'])).toBe(true)
    expect(matchesAny(rules, ['a', 'b', 'phone'])).toBe(true)
    expect(matchesAny(rules, ['name'])).toBe(false)
  })
  it('tells whether something below a path may be personal', () => {
    expect(underAny([['customer', 'email']], ['customer'])).toBe(true)
    expect(underAny([['customer', 'email']], ['name'])).toBe(false)
    expect(underAny([['**', 'phone']], ['anything'])).toBe(true)
  })

  // Security review 2026-10-13 (C1): a value inside a personal sub-document or array is personal.
  it('matches a path below a personal field, never a sibling or a parent', () => {
    expect(matchesAny(rules, ['email', 'domain'])).toBe(true)
    expect(matchesAny(rules, ['items', '2', 'cardNo', 'last4'])).toBe(true)
    expect(matchesAny(rules, ['a', 'phone', 'country'])).toBe(true)
    expect(matchesAny([['address']], ['address', 'city'])).toBe(true)
    expect(matchesAny([['address', 'city']], ['address'])).toBe(false)
    expect(matchesAny([['address']], ['addresses', 'city'])).toBe(false)
  })

  // Review 2026-10-13 (I1): a prefix at a time made a long path cost its length squared.
  it('answers for a long path in one pass, and takes a path deeper than any field as personal', () => {
    const path = Array.from({ length: MAX_PATH_SEGMENTS }, () => 'a')
    const started = Date.now()
    for (let i = 0; i < 200; i++) {
      expect(
        matchesAny(
          [
            ['**', 'b'],
            ['a', 'a', 'x'],
          ],
          path,
        ),
      ).toBe(false)
      expect(matchesAny([['a', '**', 'a']], path)).toBe(true)
    }
    expect(Date.now() - started).toBeLessThan(500)
    const deeper = Array.from({ length: 40_000 }, () => 'a')
    expect(matchesAny([['x']], deeper)).toBe(true)
    expect(underAny([['x']], deeper)).toBe(true)
  })
})
