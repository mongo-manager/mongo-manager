// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { DBRef, ObjectId, type Document } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import type { GateDeps } from '../src/masking/gate/context'
import {
  NOT_A_DOCUMENT,
  guardBulkUpdate,
  guardDocumentUpdate,
  guardIndexBuild,
  guardValidator,
  restoreReplacement,
} from '../src/masking/gate/write'

/** Phase 3c-2 final review: the write gate's holes, each pinned by a test. */
const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
])
const deps = (indexes: Document[] = []): GateDeps => ({
  masker,
  view: async () => null,
  indexes: async () => indexes,
})
async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    if (!(e instanceof AppError)) throw e
    return (e.details as { reason?: unknown }).reason
  }
  return 'allowed'
}
const stored: Document = {
  _id: 1,
  email: 'a@x',
  name: 'Ali',
  customer: { phone: '1', city: 'Izmir' },
  items: [
    { cardNo: 'c1', qty: 1 },
    { cardNo: 'c2', qty: 2 },
  ],
}
const update = (set: Document, unset: string[] = [], d = deps()) =>
  guardDocumentUpdate('crm', 'users', stored, set, unset, d)
const bulk = (u: Document | Document[], d = deps()) => guardBulkUpdate('crm', 'users', { name: 'Ali' }, u, d)

describe('final review, the write gate (phase 3c-2)', () => {
  it('C1: a positional target over elements that may hold personal data is refused', async () => {
    expect(await reason(update({ 'items.$[]': 5 }))).toBe('personal_write')
    expect(await reason(update({}, ['items.$[]']))).toBe('personal_write')
    expect(await reason(update({ 'items.$[e]': 5 }))).toBe('personal_write')
    expect(await reason(update({ 'items.$[].qty': 3 }))).toBe('allowed')
    expect(await reason(bulk({ $set: { 'items.$[]': 7 } }))).toBe('personal_write')
    expect(await reason(bulk({ $set: { 'items.$': 9 } }))).toBe('personal_write')
    const fine = await bulk({ $set: { 'items.$[].qty': 1, 'items.0.qty': 2 } })
    expect(fine.filter).toEqual({ name: 'Ali' })
    const indexed = await bulk({ $set: { 'items.0': 3 } })
    expect(indexed.filter).toEqual({ $and: [{ name: 'Ali' }, { 'items.0': NOT_A_DOCUMENT }] })
  })

  it('C2: $push and $addToSet may only add to an array that may hold personal data', async () => {
    expect(await reason(bulk({ $push: { items: { $each: [], $slice: 0 } } }))).toBe('personal_write')
    expect(await reason(bulk({ $push: { items: { $each: [], $sort: { cardNo: 1 } } } }))).toBe(
      'personal_write',
    )
    expect(await reason(bulk({ $push: { items: { $each: [{ qty: 1 }], $position: 0 } } }))).toBe('allowed')
    expect(await reason(bulk({ $push: { tags: { $each: ['a'], $slice: 3, $sort: 1 } } }))).toBe('allowed')
  })

  it('C3: a leafless object literal in an update pipeline counts as a write to its own path', async () => {
    const out = await bulk([{ $set: { customer: {} } }])
    expect(out.filter).toEqual({ $and: [{ name: 'Ali' }, { customer: NOT_A_DOCUMENT }] })
    // customer.inner holds no personal data, and a literal merges into customer: nothing to guard.
    const nested = await bulk([{ $set: { customer: { inner: {} } } }])
    expect(nested.filter).toEqual({ name: 'Ali' })
    const empty = await bulk([{ $set: { 'items.0': {} } }])
    expect(empty.filter).toEqual({ $and: [{ name: 'Ali' }, { 'items.0': NOT_A_DOCUMENT }] })
  })

  it('C4: a validator for a ruled namespace may not compute ($expr), nor name a personal field', async () => {
    expect(await reason(guardValidator('crm', 'users', { $expr: { $eq: ['$name', 'x'] } }, deps()))).toBe(
      'masking_unsupported',
    )
    expect(await reason(guardValidator('crm', 'users', { email: { $exists: true } }, deps()))).toBe(
      'personal_field',
    )
    expect(await reason(guardValidator('crm', 'users', { name: { $type: 'string' } }, deps()))).toBe(
      'allowed',
    )
    expect(await reason(guardValidator('crm', 'notes', { $expr: { $eq: ['$a', 1] } }, deps()))).toBe(
      'allowed',
    )
  })

  it('I1 and M4: no TTL and no special index type on fields that may hold personal data', async () => {
    const build = (key: Document, options: Document = {}) =>
      guardIndexBuild('crm', 'users', key, options, deps())
    expect(await reason(build({ customer: 1 }, { expireAfterSeconds: 10 }))).toBe('personal_write')
    expect(await reason(build({ email: 1 }, { expireAfterSeconds: 10 }))).toBe('personal_write')
    expect(await reason(build({ created: 1 }, { expireAfterSeconds: 10 }))).toBe('allowed')
    expect(await reason(build({ email: '2dsphere' }))).toBe('personal_write')
    expect(await reason(build({ customer: 'hashed' }))).toBe('personal_write')
    expect(await reason(build({ name: 'hashed' }))).toBe('allowed')
    expect(await reason(build({ email: 1 }))).toBe('allowed')
    // A wildcard or text key spans every field, personal ones included.
    expect(await reason(build({ '$**': 'text' }))).toBe('personal_write')
    expect(await reason(build({ name: 'text' }))).toBe('allowed')
  })

  it('M3: a partial filter the gate would have to rewrite is refused', async () => {
    const build = (filter: Document) =>
      guardIndexBuild('crm', 'users', { name: 1 }, { partialFilterExpression: filter }, deps())
    expect(await reason(build({ name: { $exists: true } }))).toBe('allowed')
    expect(await reason(build({ customer: { $type: 'object' } }))).toBe('allowed')
    expect(await reason(build({ $expr: { $eq: ['$customer', 1] } }))).toBe('masking_unsupported')
  })

  it('I2: no write to a field of a unique index over personal data', async () => {
    const unique = deps([
      { name: 'email_1_name_1', key: { email: 1, name: 1 }, unique: true },
      {
        name: 'name_partial',
        key: { code: 1 },
        unique: true,
        partialFilterExpression: { email: { $exists: true } },
      },
      { name: 'city_1', key: { 'customer.city': 1 }, unique: false },
    ])
    expect(await reason(update({ name: 'Bea' }, [], unique))).toBe('masking_unsupported')
    expect(await reason(update({ code: 7 }, [], unique))).toBe('masking_unsupported')
    expect(await reason(update({ 'customer.city': 'Ankara' }, [], unique))).toBe('allowed')
    expect(await reason(bulk({ $set: { name: 'Bea' } }, unique))).toBe('masking_unsupported')
    expect(await reason(bulk([{ $set: { name: 'Bea' } }], unique))).toBe('masking_unsupported')
    const masked: Document = {
      ...stored,
      email: '***',
      customer: { phone: '***', city: 'Izmir' },
      items: [
        { cardNo: '***', qty: 1 },
        { cardNo: '***', qty: 2 },
      ],
    }
    const { _id: _i, ...sent } = masked
    expect(await reason(restoreReplacement('crm', 'users', stored, { ...sent, name: 'Bea' }, unique))).toBe(
      'masking_unsupported',
    )
    expect(await reason(restoreReplacement('crm', 'users', stored, { ...sent, note: 'n' }, unique))).toBe(
      'allowed',
    )
  })

  it('I3: a replacement keeps BSON values such as DBRef intact', async () => {
    const ref = new DBRef('orders', new ObjectId())
    const withRef = { ...stored, ref }
    const { _id: _i, ...sent }: Document = {
      ...withRef,
      email: '***',
      customer: { phone: '***', city: 'Izmir' },
      items: [
        { cardNo: '***', qty: 1 },
        { cardNo: '***', qty: 2 },
      ],
    }
    const out = await restoreReplacement('crm', 'users', withRef, sent, deps())
    expect(out.ref).toBeInstanceOf(DBRef)
  })

  it('M1: under a ** rule, a document whose _id is a scalar can be replaced', async () => {
    const wild = compileRules([{ db: 'crm', coll: 'users', field: '**.phone' }])
    const wildDeps: GateDeps = { masker: wild, view: async () => null, indexes: async () => [] }
    expect(await reason(restoreReplacement('crm', 'users', { _id: 1, n: 1 }, { n: 2 }, wildDeps))).toBe(
      'allowed',
    )
    expect(
      await reason(restoreReplacement('crm', 'users', { _id: { phone: '1' }, n: 1 }, { n: 2 }, wildDeps)),
    ).toBe('personal_write')
  })

  it('M2: no known value renamed or moved into a place that may hold personal data', async () => {
    expect(await reason(bulk({ $rename: { other: 'customer' } }))).toBe('personal_write')
    expect(await reason(bulk([{ $set: { customer: '$other' } }]))).toBe('personal_write')
    expect(await reason(bulk({ $rename: { a: 'b' } }))).toBe('allowed')
  })
})
