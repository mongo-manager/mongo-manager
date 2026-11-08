// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { namedIn, namedOf } from '../src/ai/labels'

/**
 * Fourth review of the connection names (M-A, M-B): which connections an answer names. A miss is the
 * unsafe side — the turn would travel where the connection's policy no longer allows its name.
 */
describe('the connections an answer names', () => {
  it('matches Turkish letters in any case: İ, I, ı and i meet', () => {
    expect(namedIn('prod-ist is empty', [{ id: 'x', label: 'PROD-IST', name: 'PROD-IST' }])).toEqual(['x'])
    expect(namedIn('İSTANBUL is empty', [{ id: 'y', label: 'Istanbul', name: 'Istanbul' }])).toEqual(['y'])
    expect(namedIn('ıstanbul is empty', [{ id: 'y', label: 'İstanbul', name: 'İstanbul' }])).toEqual(['y'])
    expect(namedIn('Şube Ödeme hazır', [{ id: 'z', label: 'sube odeme', name: 'sube odeme' }])).toEqual(['z'])
  })

  it('matches a connection by its bare name, though its label carries a suffix', () => {
    expect(
      namedIn('Secret has no collections', [{ id: 'x', label: 'Secret · team', name: 'Secret' }]),
    ).toEqual(['x'])
  })

  // Fifth review (M1): a short name matches only as a word — "db" is not named by "mongodb".
  it('matches a short name only as a whole word', () => {
    const db = [{ id: 'd', label: 'db', name: 'db' }]
    expect(namedIn('mongodb is up', db)).toEqual([])
    expect(namedIn('the db connection', db)).toEqual(['d'])
    expect(namedIn('DB: empty', db)).toEqual(['d'])
    // A longer one anywhere: missing it would let it travel.
    expect(namedIn('ShopMongo', [{ id: 's', label: 'Mongo', name: 'Mongo' }])).toEqual(['s'])
  })

  // Sixth review: a script written without spaces has no words — a short name there matches anywhere.
  it('matches a short name in a script written without spaces', () => {
    expect(namedIn('本番環境は空です', [{ id: 'j', label: '本番', name: '本番' }])).toEqual(['j'])
    expect(namedIn('DB-2 is up', [{ id: 'n', label: 'db', name: 'db' }])).toEqual(['n'])
    expect(namedIn('db2 is up', [{ id: 'n', label: 'db', name: 'db' }])).toEqual([])
    // Inside a word first, then as one: named.
    expect(namedIn('mongodb, then db', [{ id: 'n', label: 'db', name: 'db' }])).toEqual(['n'])
    // Characters a pattern would read are plain here.
    expect(namedIn('a (b) here', [{ id: 'p', label: '(b)', name: '(b)' }])).toEqual(['p'])
    expect(namedIn('x [ y', [{ id: 'q', label: '[', name: '[' }])).toEqual(['q'])
  })

  // Seventh review (I1): the word check reads its neighbours in constant time — a long answer of
  // hits inside words took seconds, the server held — and reads a surrogate pair whole.
  it('checks a short name in a long text quickly, neighbours read whole', () => {
    const db = [{ id: 'n', label: 'db', name: 'db' }]
    const a = [{ id: 'a', label: 'a', name: 'a' }]
    const started = performance.now()
    expect(namedIn('mongodb://'.repeat(7200), db)).toEqual([])
    expect(namedIn('a'.repeat(72 * 1024), a)).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
    // A CJK ideograph beyond the first plane: no word around it.
    expect(namedIn('\u{20000}db', db)).toEqual(['n'])
    // A lone surrogate at either side is no letter: the name stands alone.
    expect(namedIn('\uD800db', db)).toEqual(['n'])
    expect(namedIn('db\uDC00', db)).toEqual(['n'])
    // A digit beyond the first plane, left as it is by folding (Aegean number one): part of the word.
    expect(namedIn('\u{10107}db', db)).toEqual([])
    expect(namedIn('db\u{10107}', db)).toEqual([])
  })

  // Fifth review (M2): spaces, hyphens, underscores and line breaks meet.
  it('matches a name written with hyphens, underscores or a line break', () => {
    const sales = [{ id: 'o', label: 'Sales Mongo', name: 'Sales Mongo' }]
    for (const text of ['Sales-Mongo', 'sales_mongo', 'Sales\nMongo', 'Sales   Mongo'])
      expect(namedIn(`${text} has nothing`, sales)).toEqual(['o'])
    expect(namedIn('Sales_Mongo', [{ id: 'u', label: 'Sales-Mongo', name: 'Sales-Mongo' }])).toEqual(['u'])
  })

  // Ninth review: a name of separators only is still a name.
  it('matches a name of separators only as it is', () => {
    expect(namedIn('see -- here', [{ id: 's', label: '--', name: '--' }])).toEqual(['s'])
    // Tenth review: as the folding treats them — full-width, underscores, spaces of any kind.
    expect(namedIn('see -- here', [{ id: 'w', label: '－－', name: '－－' }])).toEqual(['w'])
    expect(namedIn('see __ here', [{ id: 'u', label: '--', name: '--' }])).toEqual(['u'])
    expect(namedIn('see -   - here', [{ id: 'm', label: '- -', name: '- -' }])).toEqual(['m'])
    expect(namedIn('see - - here', [{ id: 'n', label: '-\u00a0-', name: '-\u00a0-' }])).toEqual(['n'])
  })

  it('names none it does not name', () => {
    expect(namedIn('nothing here', [{ id: 'x', label: 'Secret', name: 'Secret' }])).toEqual([])
  })

  it('records as named what the answer and the history name, a source never (it is checked as one)', () => {
    const candidates = [
      { id: 'x', label: 'Secret', name: 'Secret' },
      { id: 's', label: 'Shop', name: 'Shop' },
    ]
    expect(namedOf('Secret and Shop', candidates, ['h', 's'], new Map([['s', 1]]))).toEqual({
      named: ['h', 'x'],
    })
    expect(namedOf('nothing', candidates, [], new Map())).toEqual({})
  })
})
