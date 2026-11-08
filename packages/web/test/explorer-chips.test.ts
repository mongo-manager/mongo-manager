// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { serializeValue } from '@mongo-manager/shared/browser'
import { filterChips, withoutChip } from '../src/documents/filterChips'

// W1 (completion §2): one removable chip per top-level condition of the filter run.
const canonical = (v: Record<string, unknown>) => serializeValue(v) as Record<string, unknown>

describe('filterChips', () => {
  it('names each top-level condition in a short form', () => {
    const chips = filterChips(
      canonical({
        status: 'A',
        qty: { $lt: 30 },
        price: { $gte: 1, $lte: 9 },
        tags: { $in: ['a', 'b'] },
        deleted: { $exists: false },
      }),
    )
    expect(chips.map((c) => c.label)).toEqual([
      'status = "A"',
      'qty < 30',
      'price: { $gte: 1, $lte: 9 }',
      'tags in ["a", "b"]',
      'deleted exists false',
    ])
    expect(new Set(chips.map((c) => c.id)).size).toBe(5)
  })

  it('gives each member of a top-level $and a chip, and other operators one each', () => {
    const chips = filterChips(canonical({ $and: [{ a: 1 }, { b: { $ne: 2 } }], $or: [{ c: 1 }, { d: 1 }] }))
    expect(chips.map((c) => c.label)).toEqual(['a = 1', 'b ≠ 2', '$or: [{ c: 1 }, { d: 1 }]'])
  })

  it('cuts a long condition short in its label, never in what it removes', () => {
    const long = 'x'.repeat(300)
    const [chip] = filterChips(canonical({ note: long }))
    expect(chip!.label.length).toBeLessThanOrEqual(81)
    expect(chip!.label.endsWith('…')).toBe(true)
    expect(chip!.title).toContain(long)
  })

  // W1 review (minor 14): operators, regular expressions and typed values read as the shell writes them.
  it('names $or, $expr, a regular expression (as ~) and typed values', () => {
    const chips = filterChips({
      name: { $regularExpression: { pattern: '^a', options: 'i' } },
      code: { $regex: '^x' },
      _id: { $oid: '64b7f0c2a1b2c3d4e5f60718' },
      at: { $gte: { $date: '2026-01-02T00:00:00Z' } },
      $expr: { $gt: ['$a', '$b'] },
      $or: [{ a: { $numberLong: '1' } }, { b: null }],
    })
    expect(chips.map((c) => c.label)).toEqual([
      'name ~ /^a/i',
      'code ~ /^x/',
      '_id = ObjectId("64b7f0c2a1b2c3d4e5f60718")',
      'at ≥ ISODate("2026-01-02T00:00:00.000Z")',
      '$expr: { $gt: ["$a", "$b"] }',
      '$or: [{ a: NumberLong("1") }, { b: null }]',
    ])
  })

  it('has none for an empty filter', () => {
    expect(filterChips({})).toEqual([])
  })
})

describe('withoutChip', () => {
  it('removes one top-level condition and keeps the canonical form of the rest', () => {
    const filter = canonical({ status: 'A', qty: { $lt: 30 } })
    const [status] = filterChips(filter)
    expect(withoutChip(filter, status!)).toEqual({ qty: { $lt: { $numberInt: '30' } } })
  })

  it('removes an $and member, unwrapping the last one when nothing else holds its fields', () => {
    const filter = canonical({ $and: [{ a: 1 }, { b: 2 }, { c: 3 }] })
    const chips = filterChips(filter)
    expect(withoutChip(filter, chips[1]!)).toEqual(canonical({ $and: [{ a: 1 }, { c: 3 }] }))
    const two = canonical({ $and: [{ a: 1 }, { b: 2 }], z: 9 })
    expect(withoutChip(two, filterChips(two)[0]!)).toEqual(canonical({ z: 9, b: 2 }))
    // The last member names a field the filter already has: it stays in $and.
    const clash = canonical({ $and: [{ a: 1 }, { z: { $gt: 1 } }], z: 9 })
    expect(withoutChip(clash, filterChips(clash)[0]!)).toEqual(canonical({ $and: [{ z: { $gt: 1 } }], z: 9 }))
  })

  it('leaves the filter as it is for a chip it no longer has', () => {
    const filter = canonical({ a: 1 })
    expect(withoutChip(filter, { id: 'field:b', label: '', title: '', path: ['b'] })).toEqual(filter)
    expect(withoutChip(filter, { id: 'and:4', label: '', title: '', path: ['$and', 4] })).toEqual(filter)
  })
})
