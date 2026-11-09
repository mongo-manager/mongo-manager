// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { MATCH_LIMIT, fieldPlace, searchDocument, textMatches } from '@/documents/page/search'

// User request 2026-11-04: a value inside a reservation's payments is found in the document itself,
// not with the browser's Ctrl+F (document page design §6.7).
const reservation = {
  guest: { name: 'Ada Lin' },
  payments: [
    { method: 'card', amount: 350, card: 'S3NT1N3L' },
    { method: 'transfer', amount: 120 },
  ],
}
const none = () => false
const at = (m: { path: readonly string[]; part: string }) => [m.path.join('.'), m.part]

describe('searching inside a document', () => {
  it('finds keys and values in document order', () => {
    const { matches } = searchDocument(reservation, 'card', 'both', none)
    expect(matches.map(at)).toEqual([
      ['payments.0.method', 'value'],
      ['payments.0.card', 'key'],
    ])
  })

  it('looks only where the scope says', () => {
    expect(searchDocument(reservation, 'card', 'keys', none).matches.map(at)).toEqual([
      ['payments.0.card', 'key'],
    ])
    expect(searchDocument(reservation, 'card', 'values', none).matches.map(at)).toEqual([
      ['payments.0.method', 'value'],
    ])
  })

  it('says where in the text a match is, without minding case', () => {
    const [amount] = searchDocument(reservation, '35', 'values', none).matches
    expect(amount).toEqual({ path: ['payments', '0', 'amount'], part: 'value', start: 0, end: 2 })
    expect(searchDocument(reservation, 'ADA', 'both', none).matches.map(at)).toEqual([
      ['guest.name', 'value'],
    ])
  })

  it('never finds a hidden value, only the *** shown for it', () => {
    const masked = (path: readonly string[]) => path.join('.') === 'payments.0.card'
    expect(searchDocument(reservation, 'S3NT', 'both', masked).matches).toEqual([])
    expect(searchDocument(reservation, '***', 'values', masked).matches.map(at)).toEqual([
      ['payments.0.card', 'value'],
    ])
  })

  it('finds nothing for an empty search', () => {
    expect(searchDocument(reservation, '', 'both', none)).toEqual({ matches: [], capped: false })
  })

  it('stops counting at the limit and says so', () => {
    const many = { items: Array.from({ length: 20_000 }, () => 'x') }
    const found = searchDocument(many, 'x', 'values', none)
    expect(found.matches).toHaveLength(MATCH_LIMIT)
    expect(found.capped).toBe(true)
  })

  it('searches a large document quickly', () => {
    const fields = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, `value ${i}`]))
    const big = { items: Array.from({ length: 5_000 }, () => ({ ...fields })) }
    const started = performance.now()
    searchDocument(big, 'value 9', 'both', none)
    // Some 20 ms here; the bound is wide so a loaded CI runner never fails it by chance.
    expect(performance.now() - started).toBeLessThan(1_000)
    // Text that is not ASCII is folded letter by letter: still quick.
    const turkish = {
      items: Array.from({ length: 5_000 }, (_, i) => ({ şehir: `İstanbul Şişli ${i}`, ...fields })),
    }
    const again = performance.now()
    searchDocument(turkish, 'sisli 4999', 'both', none)
    expect(performance.now() - again).toBeLessThan(1_000)
  })

  it('finds every place in a text', () => {
    expect(textMatches('abcabc', 'BC')).toEqual({
      ranges: [
        [1, 3],
        [4, 6],
      ],
      capped: false,
    })
    expect(textMatches('abc', '')).toEqual({ ranges: [], capped: false })
    expect(textMatches('aaaa', 'a', 'both', 2)).toEqual({
      ranges: [
        [0, 1],
        [1, 2],
      ],
      capped: true,
    })
  })

  // Review 2026-11-07: "İ".toLowerCase() is two characters, so every İ before a match moved it one
  // to the right — the tree marked "erkez", and the edit view selected (and typing replaced) the
  // wrong characters.
  describe('in Turkish and other languages with accents', () => {
    const city = { city: 'İstanbul merkez' }
    const shownAt = (text: string, m: { start: number; end: number }) => text.slice(m.start, m.end)

    it('marks the very characters it found, whatever dotted İ comes before them', () => {
      const [m] = searchDocument(city, 'merkez', 'values', none).matches
      expect(shownAt(city.city, m!)).toBe('merkez')
      const text = '{ "a": "İİİ hello" }'
      const [range] = textMatches(text, 'hello').ranges
      expect(text.slice(...range!)).toBe('hello')
    })

    it('finds İstanbul by istanbul and IŞIK by ışık, as a Turkish reader writes them', () => {
      const [m] = searchDocument(city, 'istanbul', 'values', none).matches
      expect(shownAt(city.city, m!)).toBe('İstanbul')
      const [n] = searchDocument({ sign: 'IŞIK' }, 'ışık', 'values', none).matches
      expect(shownAt('IŞIK', n!)).toBe('IŞIK')
      expect(searchDocument({ sign: 'ışık' }, 'IŞIK', 'values', none).matches).toHaveLength(1)
      // ...and the same in the JSON and edit views.
      const text = '{ "city": "İstanbul", "sign": "IŞIK" }'
      expect(textMatches(text, 'istanbul').ranges.map((r) => text.slice(...r))).toEqual(['İstanbul'])
      expect(textMatches(text, 'ışık').ranges.map((r) => text.slice(...r))).toEqual(['IŞIK'])
    })

    it('finds a word without its accents, but keeps the letters of scripts where a mark makes another letter', () => {
      const text = 'Café Şişli'
      expect(textMatches(text, 'cafe sisli').ranges.map((r) => text.slice(...r))).toEqual(['Café Şişli'])
      // A decomposed é (e + combining accent) is one letter: the match takes both characters.
      const decomposed = 'café au lait'
      expect(textMatches(decomposed, 'café').ranges.map((r) => decomposed.slice(...r))).toEqual(['café'])
      // Japanese: が (ga) is not か (ka).
      expect(textMatches('がっこう', 'かっこう').ranges).toEqual([])
    })
  })

  // Review 2026-11-07: the Keys / Values choice did nothing in the JSON and edit views.
  describe('in the JSON and edit views, where the scope says', () => {
    const text = '{\n  "status": "status: open",\n  status2: 1,\n  "note": "the status"\n}'
    const found = (scope: 'both' | 'keys' | 'values') =>
      textMatches(text, 'status', scope).ranges.map(([a]) => a)

    it('finds keys only, quoted or not', () => {
      expect(found('keys')).toEqual([text.indexOf('status'), text.indexOf('status2')])
    })

    it('finds values only', () => {
      expect(found('values')).toEqual([text.indexOf('status: open'), text.indexOf('the status') + 4])
    })

    it('finds both by default', () => {
      expect(found('both')).toHaveLength(4)
    })
  })

  // Final review minor: a hidden value is found by what the view shows for it.
  it('finds a hidden value by the text shown for it', () => {
    const masked = (path: readonly string[]) => path.join('.') === 'payments.0.card'
    const found = searchDocument(reservation, 'hidd', 'values', masked, 'hidden')
    expect(found.matches.map(at)).toEqual([['payments.0.card', 'value']])
    expect(searchDocument(reservation, '***', 'values', masked, 'hidden').matches).toEqual([])
  })

  // Review 2026-11-07: "edit in text" selects the field's value, found by following its path
  // through the text's objects and arrays — before, it skipped array positions (payments.1 was
  // payments.0), took a key of the same name at any depth, and selected from the opening quote.
  describe('the place of a field in the text', () => {
    const at = (text: string, path: string[]) => {
      const place = fieldPlace(text, path)
      return place && text.slice(...place)
    }
    const doc = [
      '{',
      '  "note": "see status: x",',
      '  "guest": { "status": "x" },',
      '  "payments": [',
      '    { "method": "card", "receipt": BinData(0, "AAE=") },',
      '    { "method": "transfer", "receipt": BinData(0, "AgM=") }',
      '  ],',
      '  "status": "pending"',
      '}',
    ].join('\n')

    it('follows the path through arrays', () => {
      expect(at(doc, ['payments', '1', 'receipt'])).toBe('BinData(0, "AgM=")')
      expect(at(doc, ['payments', '0', 'receipt'])).toBe('BinData(0, "AAE=")')
      expect(at(doc, ['payments', '1'])).toBe('{ "method": "transfer", "receipt": BinData(0, "AgM=") }')
    })

    it('takes the key at its own level, never one of the same name deeper or a word in a value', () => {
      expect(at(doc, ['status'])).toBe('"pending"')
      expect(at(doc, ['guest', 'status'])).toBe('"x"')
      expect(at('{ a: { b: 1 }, b: BinData(0, "AA==") }', ['b'])).toBe('BinData(0, "AA==")')
    })

    it('reads keys as the shell writes them: quoted either way, bare, holding a dot', () => {
      expect(at('{ "a.b": 1, \'c\': 2, d: [3, 4] }', ['a.b'])).toBe('1')
      expect(at('{ "a.b": 1, \'c\': 2, d: [3, 4] }', ['c'])).toBe('2')
      expect(at('{ "a.b": 1, \'c\': 2, d: [3, 4] }', ['d', '1'])).toBe('4')
      expect(at('{ "q\\"uote": 5 }', ['q"uote'])).toBe('5')
    })

    it('is not misled by commas and brackets inside strings, calls, regular expressions and comments', () => {
      const text = '{ a: [ "x, ]", Timestamp({ t: 1, i: 2 }), /[,\\]]+/i, // ], b\n 7 ], b: 8 }'
      expect(at(text, ['a', '0'])).toBe('"x, ]"')
      expect(at(text, ['a', '1'])).toBe('Timestamp({ t: 1, i: 2 })')
      expect(at(text, ['a', '2'])).toBe('/[,\\]]+/i')
      expect(at(text, ['a', '3'])).toBe('7')
      expect(at(text, ['b'])).toBe('8')
    })

    it('finds nothing in a text that does not reach the field, or no such field', () => {
      expect(fieldPlace('{ a: [1, 2', ['b'])).toBeNull()
      expect(fieldPlace(doc, ['payments', '5'])).toBeNull()
      expect(fieldPlace(doc, ['missing'])).toBeNull()
    })
  })
})
