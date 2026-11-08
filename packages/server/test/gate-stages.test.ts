// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { Document } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import { newCtx, type GateDeps } from '../src/masking/gate/context'
import { guardStages, sourceShape } from '../src/masking/gate/pipeline'
import { guardValue } from '../src/masking/gate/expression'
import { Shape } from '../src/masking/gate/shape'
import { guardAny, typeGuard } from '../src/masking/gate/guard'
import { guardFind } from '../src/masking/gate'

/** Phase 3c §3.2-3.7: every stage and find option the gate models, with its abuse cases. */
const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
  { db: 'geo', coll: 'places', field: 'loc' },
])
const deps: GateDeps = {
  masker,
  view: async () => null,
  indexes: async () => [
    { name: 'wild', key: { '$**': 1 } },
    { name: 'name_1', key: { name: 1 } },
  ],
}
async function guard(coll: string, stages: Document[], db = 'crm') {
  const gc = newCtx(deps, db)
  const shape = await sourceShape(db, coll, gc)
  const out = await guardStages(stages, shape, gc)
  return { ...out, output: shape.output() }
}
async function reason(p: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    if (!(e instanceof AppError)) throw e
    return (e.details as { reason?: unknown } | undefined)?.reason ?? e.code
  }
  return 'allowed'
}
const users = () => new Shape('crm.users', masker.forNs('crm', 'users').patterns)
const ctx = () => newCtx(deps, 'crm')

describe('stages (phase 3c §3.5)', () => {
  it('re-roots nested outputs of $addFields and $set, and guards computed ones', async () => {
    const { stages, output } = await guard('users', [
      { $addFields: { a: { b: '$customer' } } },
      { $set: { n: { $size: '$items' } } },
    ])
    expect(output.matches(['a', 'b', 'phone'])).toBe(true)
    expect(stages[1]).toEqual({ $set: { n: { $size: typeGuard('$items') } } })
  })

  it('guards group keys of $bucket, $bucketAuto and $sortByCount, and their accumulators', async () => {
    const { stages } = await guard('users', [
      {
        $bucket: {
          groupBy: '$customer',
          boundaries: [0, 10],
          default: 'other',
          output: { names: { $push: '$name' } },
        },
      },
    ])
    expect(stages[0]).toMatchObject({ $bucket: { groupBy: typeGuard('$customer') } })
    expect((await guard('users', [{ $bucketAuto: { groupBy: '$name', buckets: 2 } }])).stages[0]).toEqual({
      $bucketAuto: { groupBy: '$name', buckets: 2 },
    })
    expect((await guard('users', [{ $sortByCount: '$customer' }])).stages[0]).toEqual({
      $sortByCount: typeGuard('$customer'),
    })
    expect(await reason(guard('users', [{ $sortByCount: '$email' }]))).toBe('personal_field')
    expect(await reason(guard('users', [{ $bucket: 'x' }]))).toBe('VALIDATION_ERROR')
  })

  it('moves $replaceRoot and $replaceWith subtrees, or guards computed roots', async () => {
    const moved = await guard('users', [{ $replaceRoot: { newRoot: '$customer' } }])
    expect(moved.output.matches(['phone'])).toBe(true)
    const built = await guard('users', [{ $replaceWith: { c: '$customer', n: '$name' } }])
    expect(built.output.matches(['c', 'phone'])).toBe(true)
    const computed = await guard('users', [{ $replaceWith: { $mergeObjects: ['$customer'] } }])
    expect(computed.stages[0]).toEqual({ $replaceWith: { $mergeObjects: [typeGuard('$customer')] } })
    expect(await reason(guard('users', [{ $replaceRoot: { newRoot: '$email' } }]))).toBe('personal_field')
  })

  it('handles accumulators that move, sort or run code', async () => {
    const top = await guard('users', [
      { $group: { _id: null, last: { $top: { sortBy: { name: 1 }, output: ['$customer', '$name'] } } } },
    ])
    expect(top.output.matches(['last', 'phone'])).toBe(true)
    expect(
      await reason(
        guard('users', [{ $group: { _id: null, t: { $top: { sortBy: { email: 1 }, output: '$name' } } } }]),
      ),
    ).toBe('personal_field')
    expect(
      await reason(
        guard('users', [
          { $group: { _id: null, t: { $bottom: { sortBy: { customer: 1 }, output: '$name' } } } },
        ]),
      ),
    ).toBe('masking_unsupported')
    const firstN = await guard('users', [
      { $group: { _id: null, f: { $firstN: { input: '$customer', n: 2 } } } },
    ])
    expect(firstN.output.matches(['f', 'phone'])).toBe(true)
    const computed = await guard('users', [{ $group: { _id: null, f: { $first: { $size: '$items' } } } }])
    expect(computed.stages[0]).toEqual({
      $group: { _id: null, f: { $first: { $size: typeGuard('$items') } } },
    })
    expect(
      await reason(guard('users', [{ $group: { _id: null, a: { $accumulator: { init: 'x' } } } }])),
    ).toBe('masking_unsupported')
    expect(await reason(guard('users', [{ $group: { _id: null, a: { $top: 'x' } } }]))).toBe(
      'masking_unsupported',
    )
    expect(await reason(guard('users', [{ $group: { _id: null, a: 1 } }]))).toBe('VALIDATION_ERROR')
    expect(await reason(guard('users', [{ $group: 'x' }]))).toBe('VALIDATION_ERROR')
  })

  it('joins with let variables and a sub-pipeline, from the same or another database', async () => {
    const { stages, output } = await guard('orders', [
      {
        $lookup: {
          from: { db: 'crm', coll: 'users' },
          let: { b: '$buyer' },
          pipeline: [{ $match: { $expr: { $eq: ['$name', '$$b'] } } }, { $project: { email: 1 } }],
          as: 'u',
        },
      },
    ])
    expect(stages[0]).toMatchObject({ $lookup: { let: { b: '$buyer' } } })
    expect(output.matches(['u', 'email'])).toBe(true)
    expect(
      await reason(
        guard('orders', [{ $lookup: { from: 'users', let: { mm_x: 1 }, pipeline: [], as: 'u' } }]),
      ),
    ).toBe('masking_unsupported')
    expect(
      await reason(
        guard('orders', [{ $lookup: { from: 'users', pipeline: [{ $match: { email: 'x' } }], as: 'u' } }]),
      ),
    ).toBe('personal_field')
    expect(await reason(guard('orders', [{ $lookup: { from: 'users' } }]))).toBe('VALIDATION_ERROR')
    const docs = await guard('orders', [{ $lookup: { pipeline: [{ $documents: [{ a: 1 }] }], as: 'd' } }])
    expect(docs.stages).toHaveLength(1)
  })

  it('unions a collection or documents, with the foreign rules at the root', async () => {
    const named = await guard('orders', [{ $unionWith: 'users' }])
    expect(named.output.matches(['email'])).toBe(true)
    const piped = await guard('orders', [
      { $unionWith: { coll: 'users', pipeline: [{ $project: { name: 1 } }] } },
    ])
    expect(piped.output.matches(['email'])).toBe(true)
    const literal = await guard('orders', [{ $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }])
    expect(literal.stages).toHaveLength(1)
    expect(await reason(guard('orders', [{ $unionWith: 3 }]))).toBe('VALIDATION_ERROR')
    expect(
      await reason(guard('orders', [{ $unionWith: { coll: 'users', pipeline: [{ $sort: { email: 1 } }] } }])),
    ).toBe('personal_field')
  })

  it('follows a graph only over fields that cannot hold personal data', async () => {
    const ok = await guard('users', [
      {
        $graphLookup: {
          from: 'users',
          startWith: '$name',
          connectFromField: 'name',
          connectToField: 'boss',
          as: 'chain',
          restrictSearchWithMatch: { name: { $ne: 'x' } },
        },
      },
    ])
    expect(ok.output.matches(['chain', 'email'])).toBe(true)
    const graph = (from: string, to: string) =>
      guard('users', [
        {
          $graphLookup: {
            from: 'users',
            startWith: '$name',
            connectFromField: from,
            connectToField: to,
            as: 'g',
          },
        },
      ])
    expect(await reason(graph('email', 'name'))).toBe('personal_field')
    expect(await reason(graph('name', 'customer'))).toBe('masking_unsupported')
    expect(await reason(guard('users', [{ $graphLookup: { from: 'users' } }]))).toBe('VALIDATION_ERROR')
  })

  it('merges facets, and refuses malformed ones', async () => {
    expect(await reason(guard('users', [{ $facet: 'x' }]))).toBe('VALIDATION_ERROR')
    expect(await reason(guard('users', [{ $facet: { a: 'x' } }]))).toBe('VALIDATION_ERROR')
    expect(await reason(guard('users', [{ $facet: { a: [{ $match: { email: 'x' } }] } }]))).toBe(
      'personal_field',
    )
  })

  it('allows $geoNear only on a clean key, with its query guarded', async () => {
    const near = { near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'd' }
    expect(await reason(guard('places', [{ $geoNear: { ...near, key: 'loc' } }], 'geo'))).toBe(
      'personal_field',
    )
    expect(await reason(guard('places', [{ $geoNear: near }], 'geo'))).toBe('masking_unsupported')
    const ok = await guard('users', [{ $geoNear: { ...near, key: 'where', query: { name: 'a' } } }])
    expect(ok.stages).toHaveLength(1)
    expect(await reason(guard('users', [{ $geoNear: 'x' }]))).toBe('VALIDATION_ERROR')
    expect((await guard('notes', [{ $geoNear: near }])).stages).toHaveLength(1)
  })

  it('keeps literal documents, stats stages, and writes out of namespaces without rules', async () => {
    expect((await guard('users', [{ $documents: [{ a: 1 }] }])).stages).toEqual([{ $documents: [{ a: 1 }] }])
    expect((await guard('users', [{ $documents: { $literal: [] } }])).stages).toHaveLength(1)
    // Each loses the server's address (twelfth review of explain masking, Minor 3).
    expect((await guard('users', [{ $collStats: {} }, { $indexStats: {} }])).stages).toEqual([
      { $collStats: {} },
      { $unset: ['host'] },
      { $indexStats: {} },
      { $unset: ['spec.partialFilterExpression', 'host'] },
    ])
    expect(await reason(guard('notes', [{ $merge: 'copy' }]))).toBe('allowed')
    expect(
      await reason(guard('notes', [{ $lookup: { from: 'users', pipeline: [], as: 'u' } }, { $merge: 'x' }])),
    ).toBe('masking_unsupported')
  })

  it('refuses malformed stages and specifications', async () => {
    expect(await reason(guard('users', [{ $match: {}, $limit: 1 }]))).toBe('VALIDATION_ERROR')
    expect(await reason(guard('users', ['x' as unknown as Document]))).toBe('VALIDATION_ERROR')
    expect(await reason(guard('users', [{ $project: 'x' }]))).toBe('VALIDATION_ERROR')
    expect(await reason(guard('users', [{ $sort: 'x' }]))).toBe('VALIDATION_ERROR')
    expect(await reason(guard('users', [{ $sort: { score: { $meta: 'textScore' } } }]))).toBe('allowed')
  })
})

describe('expressions, more operators (phase 3c §3.2)', () => {
  it('guards $reduce over an array that may hold personal data, and refuses its personal fields', () => {
    const out = guardValue(
      { $reduce: { input: '$items', initialValue: 0, in: { $add: ['$$value', '$$this.qty'] } } },
      users(),
      ctx(),
    )
    expect(out).toEqual({
      $reduce: { input: '$items', initialValue: 0, in: { $add: ['$$value', '$$this.qty'] } },
    })
    expect(() =>
      guardValue({ $reduce: { input: '$items', initialValue: 0, in: '$$this.cardNo' } }, users(), ctx()),
    ).toThrow(AppError)
  })

  it('sorts arrays only by clean fields, and guards what it hands out', () => {
    expect(guardValue({ $sortArray: { input: '$items', sortBy: { qty: 1 } } }, users(), ctx())).toEqual(
      guardAny({ $sortArray: { input: '$items', sortBy: { qty: 1 } } }),
    )
    expect(() =>
      guardValue({ $sortArray: { input: '$items', sortBy: { cardNo: 1 } } }, users(), ctx()),
    ).toThrow(AppError)
    expect(() => guardValue({ $sortArray: { input: '$items', sortBy: 1 } }, users(), ctx())).toThrow(AppError)
    expect(guardValue({ $sortArray: { input: [3, 1], sortBy: 1 } }, users(), ctx())).toEqual({
      $sortArray: { input: [3, 1], sortBy: 1 },
    })
  })

  it('refuses unknown iterator keys, malformed iterators and malformed $let', () => {
    expect(() => guardValue({ $map: { input: '$items', in: 1, extra: 1 } }, users(), ctx())).toThrow(AppError)
    expect(() => guardValue({ $map: 'x' }, users(), ctx())).toThrow(AppError)
    expect(() => guardValue({ $let: { in: 1 } }, users(), ctx())).toThrow(AppError)
    expect(() =>
      guardValue({ $filter: { input: '$items', as: 'mm_i', cond: true } }, users(), ctx()),
    ).toThrow(AppError)
  })

  it('keeps a limited $filter and $getField with an explicit input', () => {
    expect(guardValue({ $filter: { input: [1, 2], cond: true, limit: 1 } }, users(), ctx())).toEqual({
      $filter: { input: [1, 2], cond: true, limit: 1 },
    })
    expect(guardValue({ $getField: { field: 'x', input: '$name' } }, users(), ctx())).toEqual({
      $getField: { field: 'x', input: '$name' },
    })
    expect(guardValue({ $meta: 'textScore' }, users(), ctx())).toEqual({ $meta: 'textScore' })
  })

  it('refuses $filter and $sortArray of a view that would need a guard', () => {
    const strict = { ...ctx(), strict: true }
    expect(() => guardValue({ $filter: { input: '$items', cond: true } }, users(), strict)).toThrow(AppError)
  })
})

describe('find options (phase 3c §3.7)', () => {
  it('guards projection operators and expressions', async () => {
    const g = await guardFind(
      'crm',
      'users',
      {
        filter: {},
        projection: {
          items: { $elemMatch: { qty: 1 } },
          tags: { $slice: 2 },
          score: { $meta: 'textScore' },
          c: '$customer',
          n: { $size: '$items' },
        },
      },
      deps,
    )
    expect(g.projection).toMatchObject({ n: { $size: typeGuard('$items') } })
    expect(g.output.matches(['c', 'phone'])).toBe(true)
    expect(await reason(guardFind('crm', 'users', { filter: {}, projection: { e: '$email' } }, deps))).toBe(
      'personal_field',
    )
    expect(
      await reason(guardFind('crm', 'users', { filter: {}, projection: { s: { $meta: 'indexKey' } } }, deps)),
    ).toBe('masking_unsupported')
    expect(
      await reason(
        guardFind(
          'crm',
          'users',
          { filter: {}, projection: { items: { $elemMatch: { cardNo: 'x' } } } },
          deps,
        ),
      ),
    ).toBe('personal_field')
  })

  it('reads an excluded sort path for the check, then drops it; refuses colliding projections', async () => {
    const g = await guardFind(
      'crm',
      'users',
      { filter: {}, sort: { customer: 1 }, projection: { customer: 0 } },
      deps,
    )
    expect(g.projection).toEqual({})
    expect(g.finish([{ name: 'a', customer: 'x' }])).toEqual([{ name: 'a' }])
    expect(
      await reason(
        guardFind(
          'crm',
          'users',
          { filter: {}, sort: { customer: 1 }, projection: { 'customer.city': 1 } },
          deps,
        ),
      ),
    ).toBe('masking_unsupported')
    const meta = await guardFind('crm', 'users', { filter: {}, sort: { s: { $meta: 'textScore' } } }, deps)
    // Then _id, where rules apply (ninth review of explain masking).
    expect(meta.sort).toEqual({ s: { $meta: 'textScore' }, _id: 1 })
    const plain = await guardFind('crm', 'users', { filter: {}, sort: { customer: 1 } }, deps)
    expect(() => plain.finish([{ customer: [{ phone: '1' }] }])).toThrow(AppError)
  })

  it('refuses a wildcard index hint where rules apply, and allows a clean one', async () => {
    expect(await reason(guardFind('crm', 'users', { filter: {}, hint: 'wild' }, deps))).toBe('personal_field')
    expect(await reason(guardFind('crm', 'users', { filter: {}, hint: { name: 1 } }, deps))).toBe('allowed')
    // A name no listed index has is not taken on trust where rules apply (thirteenth review, M3).
    expect(await reason(guardFind('crm', 'users', { filter: {}, hint: 'unknown' }, deps))).toBe(
      'masking_unsupported',
    )
  })
})
