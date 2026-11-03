import { describe, expect, it } from 'vitest'
import type { Document } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import { guardAggregate, guardFind, type GateDeps } from '../src/masking/gate'
import { sourcePlan } from '../src/transfer/source-plan'

/** Side channels around the gate (ninth review of explain masking): order, stats, addresses. */
const deps: GateDeps = {
  masker: compileRules([{ db: 'crm', coll: 'users', field: 'customer.phone' }]),
  view: async () => null,
  indexes: async () => [{ name: 'name_phone', key: { name: 1, 'customer.phone': 1 } }],
}
async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return ((e as AppError).details as { reason?: unknown }).reason
  }
  return 'allowed'
}

describe('a restricted user’s results never come in a personal index’s order', () => {
  it('sorts a find by _id after its own keys, where rules apply', async () => {
    const sort = async (s?: Document) =>
      (await guardFind('crm', 'users', { filter: { name: 'Ali' }, ...(s ? { sort: s } : {}) }, deps)).sort
    expect(await sort()).toEqual({ _id: 1 })
    expect(await sort({ name: 1 })).toEqual({ name: 1, _id: 1 })
    expect(await sort({ name: -1, _id: -1 })).toEqual({ name: -1, _id: -1 })
    expect(await sort({ $natural: 1 })).toEqual({ $natural: 1 })
    // Where no rule applies, the order is the user's.
    expect((await guardFind('crm', 'notes', { filter: {} }, deps)).sort).toBeUndefined()
  })

  it('sorts a pipeline by _id where its query reads, and says where each stage ends', async () => {
    const run = (stages: Document[], coll = 'users') => guardAggregate('crm', coll, stages, deps)
    expect(await run([{ $match: { name: 'Ali' } }])).toMatchObject({
      stages: [{ $match: { name: 'Ali' } }, { $sort: { _id: 1 } }],
      ends: [2],
    })
    expect((await run([{ $match: { name: 'Ali' } }, { $sort: { name: 1 } }])).stages).toEqual([
      { $match: { name: 'Ali' } },
      { $sort: { name: 1, _id: 1 } },
    ])
    expect(await run([{ $group: { _id: null, first: { $first: '$name' } } }])).toMatchObject({
      stages: [{ $sort: { _id: 1 } }, { $group: { _id: null, first: { $first: '$name' } } }],
      ends: [2],
    })
    // A stage that must come first, or orders by itself, is left alone.
    const near = {
      $geoNear: { near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'd', key: 'loc' },
    }
    expect((await run([near])).stages[0]).toEqual(near)
    expect((await run([{ $sample: { size: 3 } }])).stages).toEqual([{ $sample: { size: 3 } }])
    // Where no rule applies, the pipeline is the user's.
    expect((await run([{ $match: { a: 1 } }], 'notes')).stages).toEqual([{ $match: { a: 1 } }])
  })
})

describe('an export or a copy reads in the same order', () => {
  it('reads the whole collection in natural order, a query in _id order after the user’s own', async () => {
    const request = { server: { ctx: { config: { allowServerJs: false } } } } as never
    const plan = await sourcePlan(request, 'crm', 'users', { kind: 'query', filter: {}, skip: 0 }, deps)
    // Everything is read: the natural order tells nothing and costs no sort (thirteenth review, M7).
    expect(plan).toMatchObject({ kind: 'find', options: { hint: { $natural: 1 } } })
    expect((plan as { options: { sort?: unknown } }).options.sort).toBeUndefined()
    const sorted = await sourcePlan(
      request,
      'crm',
      'users',
      { kind: 'query', filter: {}, sort: { name: 1 }, skip: 0 } as never,
      deps,
    )
    expect(JSON.stringify((sorted as { options: { sort: unknown } }).options.sort)).toBe('{"name":1,"_id":1}')
  })
})

describe('a restricted user reads no size of what rules hide', () => {
  it('counts a collection with $collStats, and no more, where rules apply', async () => {
    for (const arg of [{ storageStats: {} }, { latencyStats: {} }, { queryExecStats: {} }])
      expect(
        await reason(guardAggregate('crm', 'users', [{ $collStats: arg }], deps)),
        JSON.stringify(arg),
      ).toBe('masking_unsupported')
    expect(await reason(guardAggregate('crm', 'users', [{ $collStats: { count: {} } }], deps))).toBe(
      'allowed',
    )
    expect(await reason(guardAggregate('crm', 'notes', [{ $collStats: { storageStats: {} } }], deps))).toBe(
      'allowed',
    )
    // Twelfth review (Minor 3): nor where the server is.
    expect((await guardAggregate('crm', 'users', [{ $collStats: { count: {} } }], deps)).stages).toEqual([
      { $collStats: { count: {} } },
      { $unset: ['host'] },
    ])
  })

  it('reads index statistics without the server’s address', async () => {
    expect((await guardAggregate('crm', 'users', [{ $indexStats: {} }], deps)).stages).toEqual([
      { $indexStats: {} },
      { $unset: ['spec.partialFilterExpression', 'host'] },
    ])
  })
})
