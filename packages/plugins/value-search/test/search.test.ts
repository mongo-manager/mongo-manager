// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  buildSearch,
  dateRange,
  facetsOf,
  isRisky,
  matchedIn,
  matchingNames,
  previewOf,
  searchPaths,
} from '../src/search'

const re = (pattern: string, options: string) => ({ $regularExpression: { pattern, options } })
/** A number whose digits hold the pattern, in a field or in any item of an array there. */
const digits = (path: string, pattern: string) => ({
  $expr: {
    $anyElementTrue: [
      {
        $map: {
          input: { $cond: [{ $isArray: `$${path}` }, `$${path}`, [`$${path}`]] },
          as: 'v',
          in: {
            $and: [{ $isNumber: '$$v' }, { $regexMatch: { input: { $toString: '$$v' }, regex: pattern } }],
          },
        },
      },
    ],
  },
})

describe('where to look (value search)', () => {
  it('lists every field path of a sample, nested ones and those inside arrays, values only', () => {
    expect(
      searchPaths([
        { _id: { $oid: 'a'.repeat(24) }, name: 'Ada', address: { city: 'Izmir', geo: { lat: 1 } } },
        { name: 'Bob', items: [{ sku: 'x' }, { sku: 'y', qty: { $numberInt: '2' } }], tags: ['a', 'b'] },
      ]),
    ).toEqual(['_id', 'name', 'address.city', 'address.geo.lat', 'items.sku', 'items.qty', 'tags'])
  })

  it('looks at no more than the cap of paths', () => {
    const wide = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`f${i}`, i]))
    expect(searchPaths([wide], 100)).toHaveLength(100)
  })
})

describe('the query (value search)', () => {
  it('finds text anywhere in a value, escaped, ignoring case on request', () => {
    expect(
      buildSearch({ term: 'a.b (x)', mode: 'contains', ignoreCase: true, paths: ['name', 'tags'] }),
    ).toEqual({
      filter: { $or: [{ name: re('a\\.b \\(x\\)', 'i') }, { tags: re('a\\.b \\(x\\)', 'i') }] },
    })
  })

  it('finds a whole value: equality, or an anchored pattern when the case is ignored', () => {
    expect(buildSearch({ term: 'Ada', mode: 'exact', ignoreCase: false, paths: ['name'] })).toEqual({
      filter: { $or: [{ name: { $eq: 'Ada' } }] },
    })
    expect(buildSearch({ term: 'Ada', mode: 'exact', ignoreCase: true, paths: ['name'] })).toEqual({
      filter: { $or: [{ name: re('^Ada\\z', 'i') }] },
    })
  })

  it('also finds a number, and an ObjectId, by equality', () => {
    expect(buildSearch({ term: '42', mode: 'contains', ignoreCase: true, paths: ['n'] })).toEqual({
      filter: { $or: [{ n: re('42', 'i') }, { n: { $eq: { $numberDouble: '42' } } }, digits('n', '42')] },
    })
    const oid = '65a1b2c3d4e5f60718293a4b'
    expect(buildSearch({ term: oid, mode: 'exact', ignoreCase: false, paths: ['_id'] })).toEqual({
      filter: { $or: [{ _id: { $eq: oid } }, { _id: { $eq: { $oid: oid } } }] },
    })
  })

  it('takes a regular expression as written — the server (PCRE) says whether it is valid — refusing one too long', () => {
    expect(buildSearch({ term: '^A.+z$', mode: 'regex', ignoreCase: false, paths: ['name'] })).toEqual({
      filter: { $or: [{ name: re('^A.+z$', '') }] },
    })
    // PCRE syntax JavaScript does not read is the server's to judge (review M8).
    expect(buildSearch({ term: '(?i)abc', mode: 'regex', ignoreCase: false, paths: ['name'] })).toEqual({
      filter: { $or: [{ name: re('(?i)abc', '') }] },
    })
    expect(buildSearch({ term: 'a'.repeat(201), mode: 'regex', ignoreCase: false, paths: ['n'] })).toEqual({
      error: 'tooLong',
    })
    expect(buildSearch({ term: '   ', mode: 'contains', ignoreCase: false, paths: ['n'] })).toEqual({
      error: 'empty',
    })
    expect(buildSearch({ term: 'x', mode: 'contains', ignoreCase: false, paths: [] })).toEqual({
      error: 'noPaths',
    })
  })

  it('never takes a path that is no field', () => {
    expect(
      buildSearch({ term: 'x', mode: 'contains', ignoreCase: false, paths: ['$where', 'a..b', 'ok'] }),
    ).toEqual({
      filter: { $or: [{ ok: re('x', '') }] },
    })
  })
})

describe('numbers and patterns as the server reads them (value search, review M8, M9)', () => {
  it('finds a whole number beyond 2^53 exactly, as a long', () => {
    expect(buildSearch({ term: '9007199254740993', mode: 'exact', ignoreCase: false, paths: ['n'] })).toEqual(
      {
        filter: {
          $or: [{ n: { $eq: '9007199254740993' } }, { n: { $eq: { $numberLong: '9007199254740993' } } }],
        },
      },
    )
    expect(buildSearch({ term: '1.5', mode: 'exact', ignoreCase: false, paths: ['n'] })).toEqual({
      filter: {
        $or: [
          { n: { $eq: '1.5' } },
          { n: { $eq: { $numberDouble: '1.5' } } },
          { n: { $eq: { $numberDecimal: '1.5' } } },
        ],
      },
    })
  })

  // User report 2026-10-15: 524 and 524.66 found no order whose total was a Decimal128 524.66.
  it('finds a decimal as written: Decimal128 524.66 is not the double nearest to it', () => {
    const { filter } = buildSearch({
      term: '524.66',
      mode: 'exact',
      ignoreCase: false,
      paths: ['total'],
    }) as {
      filter: { $or: unknown[] }
    }
    expect(filter.$or).toContainEqual({ total: { $eq: { $numberDecimal: '524.66' } } })
  })

  it('finds the digits typed inside a number when looking for what a value contains', () => {
    const { filter } = buildSearch({
      term: '524',
      mode: 'contains',
      ignoreCase: true,
      paths: ['total', 'items.price'],
    }) as {
      filter: { $or: unknown[] }
    }
    expect(filter.$or).toContainEqual(digits('total', '524'))
    expect(filter.$or).toContainEqual(digits('items.price', '524'))
    // A decimal point is a decimal point, not any character.
    const dotted = buildSearch({ term: '524.6', mode: 'contains', ignoreCase: false, paths: ['total'] }) as {
      filter: { $or: unknown[] }
    }
    expect(dotted.filter.$or).toContainEqual(digits('total', '524\\.6'))
  })

  it('looks for digits only in contains mode, and only on paths an expression can name', () => {
    const exact = buildSearch({ term: '524', mode: 'exact', ignoreCase: false, paths: ['total'] }) as {
      filter: { $or: unknown[] }
    }
    expect(JSON.stringify(exact.filter)).not.toContain('$expr')
    const odd = buildSearch({ term: '524', mode: 'contains', ignoreCase: false, paths: ['a$b'] }) as {
      filter: { $or: unknown[] }
    }
    expect(JSON.stringify(odd.filter)).not.toContain('$expr')
    const words = buildSearch({ term: 'abc', mode: 'contains', ignoreCase: false, paths: ['total'] }) as {
      filter: { $or: unknown[] }
    }
    expect(JSON.stringify(words.filter)).not.toContain('$expr')
  })

  it('says a decimal matched what was typed, as contained digits or as an equal number', () => {
    const doc = { total: { $numberDecimal: '524.66' } }
    expect(matchedIn(doc, { term: '524', mode: 'contains', ignoreCase: true })).toEqual([
      { path: 'total', value: '524.66' },
    ])
    expect(matchedIn(doc, { term: '524.660', mode: 'exact', ignoreCase: false })).toEqual([
      { path: 'total', value: '524.66' },
    ])
  })

  it('says which number matched, as the server compared it', () => {
    const doc = { n: { $numberDouble: '5.0' }, m: { $numberInt: '50' } }
    expect(matchedIn(doc, { term: '5', mode: 'exact', ignoreCase: false })).toEqual([
      { path: 'n', value: '5.0' },
    ])
  })

  it('never runs a pattern that may backtrack without end in the page, nor on long values', () => {
    expect(isRisky('(a+)+$')).toBe(true)
    expect(isRisky('(a*)*b')).toBe(true)
    expect(isRisky('(\\w+\\s?)+$')).toBe(true)
    expect(isRisky('(x|y)+')).toBe(false)
    // Review 2026-10-10: overlapping alternatives repeated, and many unbounded repeats in a row.
    expect(isRisky('(a|aa)+')).toBe(true)
    expect(isRisky('(ab|a)*c')).toBe(true)
    expect(isRisky('\\w*\\w*\\w*x')).toBe(true)
    expect(isRisky('a.*b.*c')).toBe(false)
    expect(isRisky('^\\d{4}-\\d{2}$')).toBe(false)
    expect(isRisky('[ab]+c')).toBe(false)
    expect(isRisky('^A.+z$')).toBe(false)
    const long = { v: 'a'.repeat(5000) + '!' }
    expect(matchedIn(long, { term: '(a+)+$', mode: 'regex', ignoreCase: false })).toEqual([])
    const started = Date.now()
    matchedIn(long, { term: 'a{1,9}!', mode: 'regex', ignoreCase: false })
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('what matched (value search)', () => {
  it('names the paths whose values matched, with the value', () => {
    const doc = {
      _id: { $oid: '65a1b2c3d4e5f60718293a4b' },
      name: 'Ada Lovelace',
      items: [{ sku: 'ADA-1' }, { sku: 'b' }],
      n: { $numberInt: '42' },
    }
    expect(matchedIn(doc, { term: 'ada', mode: 'contains', ignoreCase: true })).toEqual([
      { path: 'name', value: 'Ada Lovelace' },
      { path: 'items.sku', value: 'ADA-1' },
    ])
    expect(matchedIn(doc, { term: '42', mode: 'exact', ignoreCase: false })).toEqual([
      { path: 'n', value: '42' },
    ])
    expect(matchedIn(doc, { term: '[', mode: 'regex', ignoreCase: false })).toEqual([])
  })

  it('finds field names that match, in the sample', () => {
    expect(
      matchingNames(['email', 'address.city', 'contactEmail'], { term: 'mail', ignoreCase: true }),
    ).toEqual(['email', 'contactEmail'])
  })
})

const day = (iso: string) => ({ $date: { $numberLong: String(Date.parse(iso)) } })

describe('dates (plugin tabs redesign: a date was never found)', () => {
  it.each([
    ['2026-01-05', '2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z'],
    ['2026-01-05 10:30', '2026-01-05T10:30:00Z', '2026-01-05T10:31:00Z'],
    ['2026-01-05T10:30:15', '2026-01-05T10:30:15Z', '2026-01-05T10:30:16Z'],
    ['2026-01-05T10:30:15.250Z', '2026-01-05T10:30:15.250Z', '2026-01-05T10:30:15.251Z'],
  ])('reads %s as the span it names, in UTC', (term, from, to) => {
    expect(dateRange(term)).toEqual({ from: Date.parse(from), to: Date.parse(to) })
  })

  it.each(['2026-13-01', '2026-02-30', '2026', 'ankara', '2026-01-05x', '10:30'])(
    'takes %s as no date',
    (term) => {
      expect(dateRange(term)).toBeNull()
    },
  )

  it('looks for a date in every field, as a span, beside the text', () => {
    const built = buildSearch({ term: '2026-01-05', mode: 'contains', ignoreCase: true, paths: ['at'] })
    expect(built).toEqual({
      filter: {
        $or: [
          { at: re('2026-01-05', 'i') },
          { at: { $gte: day('2026-01-05T00:00:00Z'), $lt: day('2026-01-06T00:00:00Z') } },
        ],
      },
    })
  })

  it('takes the span’s first instant, not the next day’s', () => {
    const at = (iso: string) => ({ at: day(iso) })
    const spec = { term: '2026-01-05', mode: 'exact' as const, ignoreCase: false }
    expect(matchedIn(at('2026-01-05T00:00:00Z'), spec)).toHaveLength(1)
    expect(matchedIn(at('2026-01-05T23:59:59.999Z'), spec)).toHaveLength(1)
    expect(matchedIn(at('2026-01-06T00:00:00Z'), spec)).toHaveLength(0)
    expect(matchedIn(at('2026-01-04T23:59:59.999Z'), spec)).toHaveLength(0)
  })

  it('looks for no date in a regular expression', () => {
    const built = buildSearch({ term: '2026-01-05', mode: 'regex', ignoreCase: false, paths: ['at'] })
    expect(JSON.stringify(built)).not.toContain('$gte')
  })

  it('says a date field matched, as the app shows a date', () => {
    const doc = { _id: 1, at: day('2026-01-05T10:00:00Z'), other: day('2026-02-05T10:00:00Z') }
    expect(matchedIn(doc, { term: '2026-01-05', mode: 'contains', ignoreCase: true })).toEqual([
      { path: 'at', value: '2026-01-05 10:00:00' },
    ])
    expect(matchedIn(doc, { term: '2026-01-05', mode: 'exact', ignoreCase: false })).toEqual([
      { path: 'at', value: '2026-01-05 10:00:00' },
    ])
  })
})

describe('what a result shows (plugin tabs redesign)', () => {
  const spec = { term: 'ankara', mode: 'contains' as const, ignoreCase: true }
  it('counts the documents each field matched in, most first', () => {
    const docs = [
      { city: 'Ankara', note: 'to ankara' },
      { city: 'Ankara' },
      { address: { city: 'ANKARA' } },
      { city: 'Izmir' },
    ]
    expect(facetsOf(docs, spec)).toEqual([
      { path: 'city', count: 2 },
      { path: 'address.city', count: 1 },
      { path: 'note', count: 1 },
    ])
  })

  it('previews a document by its first fields, leaving out _id and what matched', () => {
    const doc = {
      _id: { $oid: 'a'.repeat(24) },
      orderNo: 1001,
      city: 'Ankara',
      status: 'paid',
      total: 5,
      more: 1,
    }
    expect(previewOf(doc, ['city'], 3)).toEqual([
      { key: 'orderNo', value: 1001 },
      { key: 'status', value: 'paid' },
      { key: 'total', value: 5 },
    ])
  })
})
