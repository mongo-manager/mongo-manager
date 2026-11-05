// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { MATCH_LIMIT, keyPlace, searchDocument, textMatches } from '@/documents/page/search'

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
    expect(textMatches('aaaa', 'a', 2)).toEqual({
      ranges: [
        [0, 1],
        [1, 2],
      ],
      capped: true,
    })
  })

  // Final review minor: a hidden value is found by what the view shows for it.
  it('finds a hidden value by the text shown for it', () => {
    const masked = (path: readonly string[]) => path.join('.') === 'payments.0.card'
    const found = searchDocument(reservation, 'hidd', 'values', masked, 'hidden')
    expect(found.matches.map(at)).toEqual([['payments.0.card', 'value']])
    expect(searchDocument(reservation, '***', 'values', masked, 'hidden').matches).toEqual([])
  })

  // Final review minor: "edit in text" finds a field by its key, not by a value holding the word.
  it('finds a field in the text by its key', () => {
    const text = '{ note: "status: see guest", guest: { status: "x" }, status: "pending" }'
    // The first key named status (in guest), never the word inside the note's value.
    expect(keyPlace(text, ['status'])).toBe(text.indexOf('status: "x"'))
    expect(keyPlace('{ "a.b": 1 }', ['a.b'])).toBe(2)
    expect(keyPlace(text, ['guest', 'status'])).toBe(text.indexOf('status: "x"'))
  })
})
