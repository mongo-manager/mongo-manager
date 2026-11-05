// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Long, ObjectId } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import { Shape } from '../src/masking/gate/shape'
import { newCtx, type GateCtx } from '../src/masking/gate/context'
import { filterPaths, guardFilter } from '../src/masking/gate/filter'
import { typeGuard } from '../src/masking/gate/guard'

const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
])
const deps = { masker, view: async () => null, indexes: async () => [] }
const shape = () => new Shape('crm.users', masker.forNs('crm', 'users').patterns)
const ctx = (over: Partial<GateCtx> = {}): GateCtx => ({ ...newCtx(deps, 'crm'), ...over })

function reason(f: () => unknown): unknown {
  try {
    f()
  } catch (e) {
    return ((e as AppError).details as { reason?: unknown }).reason
  }
  return 'allowed'
}

describe('filters (phase 3c §3.1)', () => {
  it.each([
    [{ email: 'x' }],
    [{ email: { $exists: true } }],
    [{ email: { $regex: '^a' } }],
    [{ 'customer.phone': { $in: ['1'] } }],
    [{ 'items.0.cardNo': 'x' }],
    [{ 'items.$[].cardNo': 'x' }],
    [{ items: { $elemMatch: { cardNo: 'x' } } }],
    [{ $or: [{ name: 'a' }, { email: 'b' }] }],
    [{ customer: { phone: 'x', city: 'y' } }],
    [{ customer: { $in: [{ phone: 'x' }] } }],
    [{ $expr: { $eq: ['$email', 'x'] } }],
    [{ customer: { $near: [0, 0] } }],
  ])('refuses %j', (filter) => {
    expect(reason(() => guardFilter(filter, shape(), ctx()))).toBe('personal_field')
  })

  it.each([
    [{ $where: 'true' }],
    [{ $jsonSchema: { required: ['email'] } }],
    [{ $text: { $search: 'x' } }],
    [{ name: { $unknownOp: 1 } }],
  ])('refuses %j as unsupported', (filter) => {
    expect(reason(() => guardFilter(filter, shape(), ctx()))).toBe('masking_unsupported')
  })

  it('lets scalars, structure operators and decoded EJSON through on a path that may hold personal data (review focus 4)', () => {
    const f = {
      customer: { $exists: true, $type: 'object' },
      items: { $size: 2 },
      name: { $regex: '^A' },
      _id: new ObjectId(),
      n: Long.fromNumber(5),
      created: { $gt: new Date(0) },
      'customer.city': 'Izmir',
    }
    expect(guardFilter(f, shape(), ctx())).toEqual(f)
    expect(guardFilter({ customer: new ObjectId() }, shape(), ctx())).toBeTruthy()
  })

  it('guards $expr references that may hold personal data', () => {
    expect(guardFilter({ $expr: { $eq: ['$customer', 1] } }, shape(), ctx())).toEqual({
      $expr: { $eq: [typeGuard('$customer'), 1] },
    })
  })

  it('allows $text and $jsonSchema where no rule applies', () => {
    const none = new Shape('crm.notes')
    expect(guardFilter({ $text: { $search: 'x' } }, none, ctx())).toEqual({ $text: { $search: 'x' } })
  })

  it('lists the paths a filter names', () => {
    expect(filterPaths({ a: 1, $or: [{ 'b.c': 2 }], d: { $elemMatch: { e: 1 } } })).toEqual([
      ['a'],
      ['b', 'c'],
      ['d'],
      ['d', 'e'],
    ])
  })
})
