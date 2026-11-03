import { describe, expect, it } from 'vitest'
import { badKeyIn, keyError, keysOf, noKeyIn } from '../src/transfer/keyText'

// Seventeenth review of explain masking (M-4): the form says it before anything is sent.
describe('key fields typed in a copy or a restore', () => {
  it('splits them by commas', () => {
    expect(keysOf(' _id , code ,, ')).toEqual(['_id', 'code'])
  })

  it('names the first the server would refuse', () => {
    expect(badKeyIn('_id, a.b, c$')).toBeUndefined()
    expect(badKeyIn('code, $expr')).toBe('$expr')
    expect(badKeyIn('a.$where')).toBe('a.$where')
    expect(badKeyIn('tags[0]')).toBe('tags[0]')
    expect(badKeyIn('a..b')).toBe('a..b')
    expect(badKeyIn(Array.from({ length: 33 }, () => 'a').join('.'))).toBeDefined()
    expect(badKeyIn('a'.repeat(1025))).toBeDefined()
    expect(badKeyIn('a\0b')).toBe('a\0b')
  })

  // Nineteenth review of explain masking (M-3): no key at all is said too.
  it('says no key, then the first refused, in the user’s words', () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ''}`
    expect(noKeyIn(' , ')).toBe(true)
    expect(keyError(' , ', t)).toBe('dataTransfer.noKey')
    expect(keyError('code, $x', t)).toBe('dataTransfer.badKey{"key":"$x"}')
    expect(keyError('code', t)).toBeUndefined()
    // More than 32 keys, which the server refuses (twentieth review, nit).
    expect(keyError(Array.from({ length: 33 }, (_, i) => `k${i}`).join(','), t)).toBe(
      'dataTransfer.tooManyKeys{"max":32}',
    )
  })
})
