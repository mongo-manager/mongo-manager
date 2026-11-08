// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { parseQueryObject } from '@mongo-manager/shared/browser'
import { fromFilter, toFilter, type Condition, type FilterGroup } from '../src/documents/filterModel'

let n = 0
const c = (
  field: string,
  op: Condition['op'],
  value = '',
  type: Condition['type'] = 'string',
): Condition => ({
  id: String(++n),
  field,
  op,
  value,
  type,
})
const text = (group: FilterGroup) => {
  const out = toFilter(group)
  if (!out.ok) throw new Error(`invalid ${out.id}: ${out.reason}`)
  return out.text
}

describe('the filter builder writes MQL (UI redesign R1 review: a more detailed filter)', () => {
  it('writes the user’s example: refunded orders over 1200 euro', () => {
    expect(
      text({
        mode: 'and',
        conditions: [
          c('total', 'gt', '1200', 'number'),
          c('status', 'eq', 'refunded'),
          c('currency', 'eq', 'EUR'),
        ],
      }),
    ).toBe('{ total: { $gt: 1200 }, status: "refunded", currency: "EUR" }')
  })

  it('joins conditions on one field, and uses $or for Any', () => {
    expect(
      text({
        mode: 'and',
        conditions: [c('total', 'gte', '10', 'number'), c('total', 'lt', '20.5', 'number')],
      }),
    ).toBe('{ total: { $gte: 10, $lt: 20.5 } }')
    expect(text({ mode: 'or', conditions: [c('status', 'eq', 'paid'), c('status', 'eq', 'shipped')] })).toBe(
      '{ $or: [{ status: "paid" }, { status: "shipped" }] }',
    )
  })

  it('writes lists, presence, text matches, dates, ids, booleans and null', () => {
    expect(text({ mode: 'and', conditions: [c('status', 'in', 'paid, shipped')] })).toBe(
      '{ status: { $in: ["paid", "shipped"] } }',
    )
    expect(text({ mode: 'and', conditions: [c('note', 'exists'), c('paidAt', 'missing')] })).toBe(
      '{ note: { $exists: true }, paidAt: { $exists: false } }',
    )
    expect(text({ mode: 'and', conditions: [c('customer.name', 'contains', 'a.b')] })).toBe(
      '{ "customer.name": { $regex: "a\\\\.b", $options: "i" } }',
    )
    expect(text({ mode: 'and', conditions: [c('orderNo', 'starts', 'ORD-1')] })).toBe(
      '{ orderNo: { $regex: "^ORD-1", $options: "i" } }',
    )
    expect(text({ mode: 'and', conditions: [c('createdAt', 'gte', '2026-09-01', 'date')] })).toBe(
      '{ createdAt: { $gte: ISODate("2026-09-01T00:00:00.000Z") } }',
    )
    expect(text({ mode: 'and', conditions: [c('_id', 'eq', '6ac6162560c1340796d5182a', 'objectId')] })).toBe(
      '{ _id: ObjectId("6ac6162560c1340796d5182a") }',
    )
    expect(
      text({ mode: 'and', conditions: [c('active', 'eq', 'true', 'boolean'), c('x', 'eq', '', 'null')] }),
    ).toBe('{ active: true, x: null }')
  })

  it('says which condition has a value of the wrong kind, and writes nothing', () => {
    const bad = c('total', 'gt', 'lots', 'number')
    expect(toFilter({ mode: 'and', conditions: [c('a', 'eq', 'x'), bad] })).toMatchObject({
      ok: false,
      id: bad.id,
      reason: 'number',
    })
    expect(toFilter({ mode: 'and', conditions: [c('_id', 'eq', 'zz', 'objectId')] })).toMatchObject({
      ok: false,
      reason: 'objectId',
    })
  })

  it('leaves out conditions without a field, and an empty builder is an empty filter', () => {
    expect(text({ mode: 'and', conditions: [c('', 'eq', 'x')] })).toBe('')
    expect(text({ mode: 'and', conditions: [] })).toBe('')
  })
})

describe('the filter builder reads MQL back', () => {
  const read = (t: string) => fromFilter(parseQueryObject(t))

  it('reads what it writes', () => {
    for (const t of [
      '{ total: { $gt: 1200 }, status: "refunded", currency: "EUR" }',
      '{ total: { $gte: 10, $lt: 20.5 } }',
      '{ $or: [{ status: "paid" }, { status: "shipped" }] }',
      '{ status: { $in: ["paid", "shipped"] } }',
      '{ note: { $exists: true }, paidAt: { $exists: false } }',
      '{ orderNo: { $regex: "^ORD-1", $options: "i" } }',
      '{ createdAt: { $gte: ISODate("2026-09-01T00:00:00.000Z") } }',
      '{ _id: ObjectId("6ac6162560c1340796d5182a") }',
      '{ active: true, x: null }',
    ]) {
      const group = read(t)
      expect(group, t).not.toBeNull()
      expect(text(group!), t).toBe(t)
    }
  })

  it('gives each value its type', () => {
    expect(read('{ total: { $gt: 1200 }, status: "refunded" }')!.conditions).toMatchObject([
      { field: 'total', op: 'gt', value: '1200', type: 'number' },
      { field: 'status', op: 'eq', value: 'refunded', type: 'string' },
    ])
  })

  it('declines what it cannot show, rather than losing part of it', () => {
    expect(read('{ $expr: { $gt: ["$a", "$b"] } }')).toBeNull()
    expect(read('{ items: { $elemMatch: { qty: 1 } } }')).toBeNull()
    expect(read('{ customer: { name: "Ada" } }')).toBeNull()
    expect(read('{ $or: [{ a: 1, b: 2 }, { c: 3 }] }')).toBeNull()
    expect(read('{ name: { $regex: "a" } }')).toBeNull()
  })
})

describe('the builder never changes a filter it reads (reviewer B I4)', () => {
  const read = (t: string) => fromFilter(parseQueryObject(t))
  /** Read, then written back: the same filter, or not read at all. */
  const roundTrip = (t: string) => {
    const group = read(t)
    if (!group) return null
    const out = toFilter(group)
    if (!out.ok) throw new Error(`invalid ${out.id}: ${out.reason}`)
    return JSON.stringify(parseQueryObject(out.text))
  }

  it('writes back what it read', () => {
    for (const t of [
      '{ status: "paid", total: { $gt: 1200 } }',
      '{ tags: { $in: ["a", "b"] } }',
      '{ name: { $regex: "^Ada", $options: "i" } }',
      '{ name: { $regex: "a\\\\.b", $options: "i" } }',
      '{ $or: [{ status: "paid" }, { status: "new" }] }',
      '{ when: { $gte: ISODate("2026-01-01T00:00:00.000Z") } }',
    ])
      expect(roundTrip(t), t).toBe(JSON.stringify(parseQueryObject(t)))
  })

  it('leaves to the text what it would change', () => {
    for (const t of [
      // Decimal128 and Long compare exactly; a double would not match the same documents.
      '{ price: NumberDecimal("19.99") }',
      '{ n: NumberLong("9007199254740993") }',
      '{ n: { $gt: NumberLong("5") } }',
      // A comma or edge spaces inside an item would split or trim it.
      '{ tags: { $in: ["a,b"] } }',
      '{ tags: { $in: [" a"] } }',
      // Regex escapes the builder does not write (\d), and bare anchors inside.
      '{ code: { $regex: "^A\\\\d", $options: "i" } }',
      '{ code: { $regex: "a$b", $options: "i" } }',
      '{ code: { $regex: "a^b", $options: "i" } }',
      // A number that is not finite.
      '{ x: Infinity }',
    ])
      expect(read(t), t).toBeNull()
  })
})
