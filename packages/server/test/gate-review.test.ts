// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { DBRef, ObjectId, type Document } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import { newCtx, type GateDeps } from '../src/masking/gate/context'
import { guardStages, sourceShape } from '../src/masking/gate/pipeline'
import { guardValue } from '../src/masking/gate/expression'
import { guardFilter } from '../src/masking/gate/filter'
import { Shape } from '../src/masking/gate/shape'
import { guardFind } from '../src/masking/gate'

/** Phase 3c-1 final review: the gate's holes, each pinned by a test. */
const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'contacts.phone' },
])
const deps: GateDeps = { masker, view: async () => null, indexes: async () => [] }
const users = () => new Shape('crm.users', masker.forNs('crm', 'users').patterns)
const ctx = () => newCtx(deps, 'crm')
async function reason(p: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    if (!(e instanceof AppError)) throw e
    return (e.details as { reason?: unknown } | undefined)?.reason ?? e.code
  }
  return 'allowed'
}
async function guard(coll: string, stages: Document[], db = 'crm') {
  const gc = newCtx(deps, db)
  const shape = await sourceShape(db, coll, gc)
  return guardStages(stages, shape, gc)
}

describe('final review, the gate (phase 3c-1)', () => {
  it('C1: refuses rebinding CURRENT or ROOT, and any variable name MongoDB reserves', async () => {
    for (const expr of [
      { $map: { input: '$contacts', as: 'CURRENT', in: '$phone' } },
      { $filter: { input: '$contacts', as: 'ROOT', cond: true } },
      { $let: { vars: { CURRENT: '$name' }, in: '$phone' } },
      { $map: { input: '$contacts', as: 'NOW', in: 1 } },
      { $map: { input: '$contacts', as: 'Item', in: 1 } },
    ])
      expect(await reason(() => guardValue(expr, users(), ctx())), JSON.stringify(expr)).toBe(
        'masking_unsupported',
      )
    expect(
      await reason(
        guard('orders', [{ $lookup: { from: 'users', let: { CURRENT: 1 }, pipeline: [], as: 'u' } }]),
      ),
    ).toBe('masking_unsupported')
  })

  it('C2: a find projection $slice in expression form is guarded, the classic forms are kept', async () => {
    const g = await guardFind(
      'crm',
      'users',
      { filter: {}, projection: { x: { $slice: ['$contacts', 5] } } },
      deps,
    )
    expect(JSON.stringify(g.projection)).toContain('$switch')
    const classic = await guardFind(
      'crm',
      'users',
      { filter: {}, projection: { tags: { $slice: 2 }, more: { $slice: [1, 2] } } },
      deps,
    )
    expect(classic.projection).toEqual({ tags: { $slice: 2 }, more: { $slice: [1, 2] } })
  })

  it('C4: refuses $out and $merge into a namespace with rules, even from one without', async () => {
    expect(await reason(guard('notes', [{ $out: 'users' }]))).toBe('masking_unsupported')
    expect(await reason(guard('notes', [{ $out: { db: 'crm', coll: 'users' } }]))).toBe('masking_unsupported')
    expect(await reason(guard('notes', [{ $merge: { into: 'users' } }]))).toBe('masking_unsupported')
    expect(await reason(guard('notes', [{ $merge: { into: { db: 'crm', coll: 'users' } } }]))).toBe(
      'masking_unsupported',
    )
    expect(await reason(guard('notes', [{ $merge: 'users' }]))).toBe('masking_unsupported')
    expect(await reason(guard('notes', [{ $merge: { into: 'archive' } }]))).toBe('allowed')
  })

  it('C6: refuses internal namespaces (buckets, profile, views, local, config) where rules exist', async () => {
    for (const [db, coll] of [
      ['crm', 'system.buckets.users'],
      ['crm', 'system.profile'],
      ['crm', 'system.views'],
      ['local', 'oplog.rs'],
      ['config', 'chunks'],
    ] as const)
      expect(await reason(guard(coll, [], db)), `${db}.${coll}`).toBe('masking_unsupported')
    expect(
      await reason(guard('orders', [{ $lookup: { from: 'system.profile', pipeline: [], as: 'p' } }])),
    ).toBe('masking_unsupported')
    const none: GateDeps = { masker: compileRules([]), view: async () => null, indexes: async () => [] }
    expect(await reason(sourceShape('local', 'oplog.rs', newCtx(none, 'local')))).toBe('allowed')
  })

  it('I1: refuses a sort on a may-hold key whose value the projection replaces', async () => {
    expect(
      await reason(
        guardFind(
          'crm',
          'users',
          { filter: {}, sort: { customer: -1 }, projection: { customer: { $literal: 'z' } } },
          deps,
        ),
      ),
    ).toBe('masking_unsupported')
    expect(
      await reason(
        guardFind(
          'crm',
          'users',
          { filter: {}, sort: { customer: 1 }, projection: { 'customer.city': '$name' } },
          deps,
        ),
      ),
    ).toBe('masking_unsupported')
    expect(
      await reason(
        guardFind('crm', 'users', { filter: {}, sort: { customer: 1 }, projection: { customer: 1 } }, deps),
      ),
    ).toBe('allowed')
  })

  it('I2: $indexStats never hands out a partial filter', async () => {
    const { stages } = await guard('users', [{ $indexStats: {} }])
    expect(stages).toEqual([{ $indexStats: {} }, { $unset: ['spec.partialFilterExpression', 'host'] }])
  })

  it('M2: a DBRef operand is compared as the sub-document it is stored as', async () => {
    expect(
      await reason(() => guardFilter({ customer: new DBRef('users', new ObjectId()) }, users(), ctx())),
    ).toBe('personal_field')
  })

  it('M3: temporary field names cannot be guessed by a query', async () => {
    const one = await guard('users', [{ $sort: { customer: 1 } }])
    const two = await guard('users', [{ $sort: { customer: 1 } }])
    const name = (s: Document[]) => Object.keys((s[0] as { $addFields: Document }).$addFields)[0]!
    expect(name(one.stages)).toMatch(/^__mm_s0_[0-9a-f]{12}$/)
    expect(name(one.stages)).not.toBe(name(two.stages))
  })

  it('M5: a page of dates or booleans is not refused; documents in it are', async () => {
    const g = await guardFind('crm', 'users', { filter: {}, sort: { customer: 1 } }, deps)
    expect(g.finish([{ customer: new Date(0) }, { customer: true }])).toHaveLength(2)
    expect(() => g.finish([{ customer: new Date(0) }, { customer: { phone: '1' } }])).toThrow(AppError)
  })
})
