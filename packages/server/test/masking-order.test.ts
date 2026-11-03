import { describe, expect, it } from 'vitest'
import { DBRef, Decimal128, Long, ObjectId, type Document } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import {
  guardAggregate,
  guardFilterFor,
  guardFind,
  guardOrder,
  isOrderRefusal,
  seriesStoredByHidden,
  type GateDeps,
} from '../src/masking/gate'

/**
 * Twelfth review of explain masking: a restricted user's results come in no hidden value's order,
 * and only where an index could give one is the order changed.
 */
const PHONE_INDEX = { name: 'name_phone', key: { name: 1, 'customer.phone': 1 } }
const ID_INDEX = { name: '_id_', key: { _id: 1 } }
function depsOf(
  rules: Parameters<typeof compileRules>[0],
  indexes: Document[] = [ID_INDEX, PHONE_INDEX],
  views: Record<string, { viewOn: string; pipeline: Document[]; collation?: Document }> = {},
  kinds: Record<string, 'timeseries' | 'collection'> = {},
  storage: Record<string, Awaited<ReturnType<NonNullable<GateDeps['storage']>>>> = {},
): GateDeps {
  return {
    masker: compileRules(rules),
    view: async (_db, coll) => views[coll] ?? null,
    indexes: async (_db, coll) => (views[coll] ? [] : indexes),
    kind: async (_db, coll) => (views[coll] ? 'view' : (kinds[coll] ?? 'collection')),
    storage: async (_db, coll) => storage[coll] ?? { clustered: false },
  }
}
const PHONE = [{ db: 'crm', coll: 'users', field: 'customer.phone' }]
const CLUSTERED = { name: '_id_', key: { _id: 1 }, unique: true, clustered: true }
const find = (deps: GateDeps, query: Document = {}, coll = 'users') =>
  guardFind('crm', coll, { filter: { name: 'Ali' }, ...query }, deps)
const run = (deps: GateDeps, stages: Document[], coll = 'users') => guardAggregate('crm', coll, stages, deps)
/** A pipeline's stages with our nonce-named fields made plain. */
const plain = (stages: Document[]) =>
  JSON.parse(JSON.stringify(stages).replace(/__mm_([a-z])\d*_[0-9a-f]+/g, '$1'))
async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return ((e as AppError).details as { reason?: unknown }).reason
  }
  return 'allowed'
}

describe('where no index holds what rules hide', () => {
  it('leaves a find and a pipeline in their own order', async () => {
    const deps = depsOf(PHONE, [ID_INDEX, { name: 'name_1', key: { name: 1 } }])
    const guarded = await find(deps, { sort: { name: 1 } })
    expect(guarded.sort).toEqual({ name: 1 })
    expect(guarded.hint).toBeUndefined()
    expect((await run(deps, [{ $match: { name: 'Ali' } }])).stages).toEqual([{ $match: { name: 'Ali' } }])
  })

  it('still breaks ties by _id where the indexes cannot be read', async () => {
    expect((await find(depsOf(PHONE, []))).sort).toEqual({ _id: 1 })
  })

  it('counts a wildcard, a text or a hashed index on what is hidden as one that orders by it', async () => {
    for (const index of [
      { name: 'all', key: { '$**': 1 } },
      { name: 'customer', key: { 'customer.$**': 1 } },
      { name: 'text', key: { _fts: 'text', _ftsx: 1 } },
      { name: 'hashed', key: { 'customer.phone': 'hashed' } },
      { name: 'whole', key: { customer: 1 } },
    ])
      expect((await find(depsOf(PHONE, [ID_INDEX, index]))).sort, index.name).toEqual({ _id: 1 })
  })
})

describe('where _id cannot break ties', () => {
  const ID_HIDDEN = [...PHONE, { db: 'crm', coll: 'users', field: '_id' }]

  it('reads a find in natural order, never sorting by a hidden _id (C1)', async () => {
    const guarded = await find(depsOf(ID_HIDDEN), { sort: { name: 1 } })
    expect(guarded.sort).toEqual({ name: 1 })
    expect(guarded.hint).toEqual({ $natural: 1 })
    expect((await find(depsOf(ID_HIDDEN))).sort).toBeUndefined()
  })

  it('reads a pipeline in a random order instead', async () => {
    const { stages, ends } = await run(depsOf(ID_HIDDEN), [{ $match: { name: 'Ali' } }, { $limit: 5 }])
    expect(plain(stages)).toEqual([
      { $match: { name: 'Ali' } },
      { $addFields: { r: { $rand: {} } } },
      { $sort: { r: 1 } },
      { $unset: ['r'] },
      { $limit: 5 },
    ])
    expect(ends).toEqual([4, 5])
  })

  it('reads a view that drops _id in natural order (I2)', async () => {
    const views = { slim: { viewOn: 'users', pipeline: [{ $project: { _id: 0, name: 1 } }] } }
    const deps = depsOf(PHONE, [ID_INDEX, PHONE_INDEX], views)
    expect((await find(deps, {}, 'slim')).hint).toEqual({ $natural: 1 })
    // A view that keeps each document's _id breaks ties by it.
    const kept = depsOf(PHONE, [ID_INDEX, PHONE_INDEX], {
      ali: { viewOn: 'users', pipeline: [{ $match: { name: 'Ali' } }, { $set: { n: 1 } }] },
    })
    const guarded = await find(kept, {}, 'ali')
    expect(guarded.sort).toEqual({ _id: 1 })
    expect(guarded.hint).toBeUndefined()
  })

  it('reads a find whose sort has MongoDB’s 32 keys in natural order', async () => {
    const sort = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, 1]))
    const guarded = await find(depsOf(PHONE), { sort })
    expect(guarded.sort).toEqual(sort)
    expect(guarded.hint).toEqual({ $natural: 1 })
  })
})

describe('where _id may be a document that holds what is hidden', () => {
  const WILD = [{ db: 'crm', coll: 'users', field: '**.phone' }]

  it('sorts a page by _id, so an index serves its filter, and a job reads in natural order (fourteenth review, I-E)', async () => {
    const guarded = await find(depsOf(WILD), { projection: { name: 1 } })
    expect(guarded.sort).toEqual({ _id: 1 })
    expect(guarded.hint).toBeUndefined()
    expect(() => guarded.finish([{ _id: { phone: '555' }, name: 'Ali' }])).toThrow()
    const job = await guardFind('crm', 'users', { filter: { name: 'Ali' } }, depsOf(WILD), {
      order: 'always',
    })
    expect(job.hint).toEqual({ $natural: 1 })
    expect(job.finish([{ _id: { phone: '555' }, name: 'Ali' }])).toHaveLength(1)
  })

  it('refuses a page with such a document _id where only _id can order, and keeps the _id the user sees', async () => {
    const deps = depsOf(WILD, [CLUSTERED, PHONE_INDEX])
    const guarded = await find(deps, { projection: { name: 1 } })
    expect(guarded.sort).toEqual({ _id: 1 })
    expect(guarded.projection).toEqual({ name: 1 })
    expect(guarded.finish([{ _id: 1, name: 'Ali' }])).toEqual([{ _id: 1, name: 'Ali' }])
    expect(() => guarded.finish([{ _id: { region: 'eu' }, name: 'Ali' }])).toThrow()
    const hiddenId = await find(deps, { projection: { _id: 0, name: 1 } })
    expect(hiddenId.projection).toEqual({ name: 1 })
    expect(hiddenId.finish([{ _id: 1, name: 'Ali' }])).toEqual([{ name: 'Ali' }])
  })

  it('sorts a pipeline by a guarded copy of _id, such ids in a random order', async () => {
    const { stages } = await run(depsOf(WILD), [{ $match: { name: 'Ali' } }])
    expect(plain(stages).slice(1, 3)).toEqual([
      {
        $addFields: {
          o: {
            $switch: {
              branches: [
                { case: { $eq: [{ $type: '$_id' }, 'object'] }, then: { $literal: '***' } },
                expect.anything(),
              ],
              default: '$_id',
            },
          },
          r: { $rand: {} },
        },
      },
      { $sort: { o: 1, r: 1 } },
    ])
  })
})

describe('a user’s own order', () => {
  it('keeps a hint of the user’s own, which the gate has checked', async () => {
    const guarded = await find(depsOf(PHONE, [ID_INDEX, PHONE_INDEX, { name: 'name_1', key: { name: 1 } }]), {
      hint: 'name_1',
    })
    expect(guarded.sort).toBeUndefined()
    expect(guarded.hint).toBe('name_1')
  })

  it('puts _id into the first sort, its guarded copies included (review Minor 1)', async () => {
    const { stages } = await run(depsOf(PHONE), [{ $sort: { customer: 1 } }])
    const sorts = plain(stages).filter((s: Document) => '$sort' in s)
    expect(sorts).toEqual([{ $sort: { s: 1, _id: 1 } }])
  })

  it('leaves what a counted pipeline joins unordered too (I5)', async () => {
    const stages = [{ $unionWith: 'users' }, { $count: 'n' }]
    expect((await guardAggregate('crm', 'notes', stages, depsOf(PHONE), { order: false })).stages).toEqual([
      { $unionWith: { coll: 'users' } },
      { $count: 'n' },
    ])
  })

  it('leaves a count unordered (I5)', async () => {
    const stages = [{ $match: { name: 'Ali' } }, { $count: 'n' }]
    expect((await guardAggregate('crm', 'users', stages, depsOf(PHONE), { order: false })).stages).toEqual(
      stages,
    )
  })
})

describe('joined documents come in no hidden order either (I1)', () => {
  const deps = depsOf(PHONE)

  it('orders a $unionWith’s documents', async () => {
    const { stages } = await run(
      deps,
      [{ $unionWith: { coll: 'users', pipeline: [{ $match: { name: 'Ali' } }] } }],
      'notes',
    )
    expect(stages).toEqual([
      { $unionWith: { coll: 'users', pipeline: [{ $match: { name: 'Ali' } }, { $sort: { _id: 1 } }] } },
    ])
    expect((await run(deps, [{ $unionWith: 'users' }], 'notes')).stages).toEqual([
      { $unionWith: { coll: 'users', pipeline: [{ $sort: { _id: 1 } }] } },
    ])
    // A collection no rule applies to is joined as it is.
    expect((await run(deps, [{ $unionWith: 'notes' }], 'notes')).stages).toEqual([
      { $unionWith: { coll: 'notes' } },
    ])
  })

  it('orders a $lookup’s array', async () => {
    const lookup = { from: 'users', localField: 'author', foreignField: 'name', as: 'by' }
    expect((await run(deps, [{ $lookup: lookup }], 'notes')).stages).toEqual([
      { $lookup: { ...lookup, pipeline: [{ $sort: { _id: 1 } }] } },
    ])
    expect(await reason(run(deps, [{ $lookup: lookup }], 'notes'))).toBe('allowed')
  })
})

describe('the second review of the order', () => {
  const ID_HIDDEN = [...PHONE, { db: 'crm', coll: 'users', field: '_id' }]
  const WILD = [{ db: 'crm', coll: 'users', field: '**.phone' }]

  it('refuses a hint on a view but _id’s, which is checked as _id (I1)', async () => {
    const views = { v: { viewOn: 'users', pipeline: [{ $match: { name: 'Ali' } }] } }
    const deps = depsOf(PHONE, [ID_INDEX, PHONE_INDEX], views)
    for (const hint of ['name_phone', { name: 1 }, { 'customer.phone': 1 }])
      expect(await reason(find(deps, { hint }, 'v')), JSON.stringify(hint)).toBe('masking_unsupported')
    for (const hint of ['_id_', { _id: 1 }, { $natural: 1 }])
      expect(await reason(find(deps, { hint }, 'v')), JSON.stringify(hint)).toBe('allowed')
    const hidden = depsOf(ID_HIDDEN, [ID_INDEX, PHONE_INDEX], views)
    expect(await reason(find(hidden, { hint: '_id_' }, 'v'))).toBe('personal_field')
  })

  it('refuses a find of a collection stored in a hidden _id’s order, and randomises a pipeline (I2)', async () => {
    const plain_ = { name: 'name_1', key: { name: 1 } }
    const deps = depsOf(ID_HIDDEN, [CLUSTERED, plain_])
    expect(await reason(find(deps))).toBe('masking_unsupported')
    expect(await reason(find(deps, { hint: { $natural: 1 } }))).toBe('masking_unsupported')
    expect(plain((await run(deps, [{ $match: { name: 'Ali' } }])).stages)).toEqual([
      { $match: { name: 'Ali' } },
      { $addFields: { r: { $rand: {} } } },
      { $sort: { r: 1 } },
      { $unset: ['r'] },
    ])
    // An _id that may hold what is hidden is checked, whatever the indexes.
    expect((await find(depsOf(WILD, [CLUSTERED]))).sort).toEqual({ _id: 1 })
    // Clustered by an _id that is shown, the indexes are weighed as anywhere.
    expect((await find(depsOf(PHONE, [CLUSTERED, plain_]))).sort).toBeUndefined()
  })

  it('leaves a $near find in distance order (I6)', async () => {
    const at = { $near: { $geometry: { type: 'Point', coordinates: [0, 0] } } }
    for (const deps of [depsOf(PHONE), depsOf(ID_HIDDEN)]) {
      const guarded = await find(deps, { filter: { loc: at } })
      expect(guarded.sort).toBeUndefined()
      expect(guarded.hint).toBeUndefined()
      expect(
        (await find(deps, { filter: { $and: [{ loc: { $nearSphere: [0, 0] } }] } })).hint,
      ).toBeUndefined()
    }
    // A $near only quoted as a value orders nothing.
    expect((await find(depsOf(PHONE), { filter: { name: { $eq: { $near: 1 } } } })).sort).toEqual({ _id: 1 })
  })

  it('takes no index listed as unknown, a time series’ too (thirteenth review, M3), and skips a hidden index', async () => {
    const series = depsOf(PHONE, [], {}, { users: 'timeseries' })
    expect((await find(series)).sort).toEqual({ _id: 1 })
    const hiddenIndex = depsOf(PHONE, [ID_INDEX, { ...PHONE_INDEX, hidden: true }])
    expect((await find(hiddenIndex)).sort).toBeUndefined()
  })

  it('orders a job’s read whatever the indexes are (M2)', async () => {
    const deps = depsOf(PHONE, [ID_INDEX])
    expect((await find(deps)).sort).toBeUndefined()
    const all = await guardFind('crm', 'users', { filter: {} }, deps, { order: 'always' })
    // Everything is read: the natural order, which tells nothing, costs no sort (thirteenth review, M7).
    expect(all.sort).toBeUndefined()
    expect(all.hint).toEqual({ $natural: 1 })
    const some = await guardFind('crm', 'users', { filter: { name: 'Ali' } }, deps, { order: 'always' })
    expect(some.sort).toEqual({ _id: 1 })
  })

  it('leaves a view that orders by itself its order', async () => {
    const near = {
      $geoNear: { near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'd', key: 'loc' },
    }
    const deps = depsOf(PHONE, [ID_INDEX, PHONE_INDEX], { close: { viewOn: 'users', pipeline: [near] } })
    const guarded = await find(deps, {}, 'close')
    expect(guarded.sort).toBeUndefined()
    expect(guarded.hint).toBeUndefined()
  })

  it('sorts once: the user’s keys, then the random order’s (M5)', async () => {
    const { stages, ends } = await run(depsOf(ID_HIDDEN), [
      { $match: { name: 'Ali' } },
      { $sort: { name: 1 } },
    ])
    expect(plain(stages)).toEqual([
      { $match: { name: 'Ali' } },
      { $addFields: { r: { $rand: {} } } },
      { $sort: { name: 1, r: 1 } },
      { $unset: ['r'] },
    ])
    expect(ends).toEqual([1, 4])
  })

  it('refuses no backup page for an _id document (I5): a collection’s whole read is in natural order', async () => {
    const guarded = await guardFind('crm', 'users', { filter: {} }, depsOf(WILD), { order: 'always' })
    expect(guarded.hint).toEqual({ $natural: 1 })
    expect(guarded.finish([{ _id: { owner: { phone: '555' } } }])).toHaveLength(1)
  })

  it('reads a Decimal128 projection flag as its number', async () => {
    const guarded = await find(depsOf([{ db: 'crm', coll: 'users', field: '**.phone' }], [CLUSTERED]), {
      projection: { _id: Decimal128.fromString('0'), name: 1 },
    })
    expect(guarded.projection).toEqual({ name: 1 })
    expect(guarded.finish([{ _id: 1, name: 'Ali' }])).toEqual([{ name: 'Ali' }])
  })
})

describe('the third review of the order', () => {
  const ID_HIDDEN = [...PHONE, { db: 'crm', coll: 'users', field: '_id' }]

  it('refuses an empty hint, a { $hint } and a name no listed index has (C1, M3)', async () => {
    const deps = depsOf(PHONE)
    for (const hint of [{}, { $hint: 'name_phone' }, { $natural: 1, name: 1 }, 'nowhere'])
      expect(await reason(find(deps, { hint })), JSON.stringify(hint)).toBe('masking_unsupported')
    // Where no rule applies, MongoDB answers for a name it does not know.
    expect(await reason(find(deps, { hint: 'nowhere' }, 'notes'))).toBe('allowed')
  })

  it('checks a hint whatever number type names its direction, and a text index’s weights (M4)', async () => {
    const partial = {
      name: 'name_p',
      key: { name: 1 },
      partialFilterExpression: { 'customer.phone': { $exists: true } },
    }
    const text = { name: 'body_text', key: { _fts: 'text', _ftsx: 1 }, weights: { 'customer.phone': 1 } }
    const deps = depsOf(PHONE, [ID_INDEX, partial, text])
    expect(await reason(find(deps, { hint: { name: Long.fromNumber(1) } }))).toBe('personal_field')
    expect(await reason(find(deps, { hint: 'body_text' }))).toBe('personal_field')
  })

  it('hints a job’s read by its index’s key, so an index made again under the name is not used (M6)', async () => {
    const deps = depsOf(PHONE, [ID_INDEX, PHONE_INDEX, { name: 'name_1', key: { name: 1 } }])
    const job = await guardFind('crm', 'users', { filter: { name: 'Ali' }, hint: 'name_1' }, deps, {
      order: 'always',
    })
    expect(job.hint).toEqual({ name: 1 })
    expect((await find(deps, { hint: 'name_1' })).hint).toBe('name_1')
  })

  it('reads a time series ordered by a hidden field by _id, and refuses one whose _id is hidden too (I3)', async () => {
    const SERIES = [{ db: 'crm', coll: 'users', field: 'meta.email' }]
    const storage = { users: { clustered: false, timeseries: { timeField: 'at', metaField: 'meta' } } }
    const deps = depsOf(SERIES, [], {}, { users: 'timeseries' }, storage)
    expect((await find(deps)).sort).toEqual({ _id: 1 })
    expect((await find(deps, { hint: { $natural: 1 } })).sort).toEqual({ _id: 1 })
    expect(await reason(find(deps, { sort: { $natural: 1 } }))).toBe('masking_unsupported')
    const hidden = depsOf([...SERIES, { db: 'crm', coll: 'users', field: '_id' }], [], {}, {}, storage)
    expect(await reason(find(hidden))).toBe('masking_unsupported')
    expect(JSON.stringify((await run(hidden, [{ $match: {} }])).stages)).toContain('$rand')
  })

  it('knows a clustered collection from its listing when its indexes cannot be read (M3)', async () => {
    const deps = depsOf(ID_HIDDEN, [], {}, {}, { users: { clustered: true } })
    expect(await reason(find(deps))).toBe('masking_unsupported')
  })

  it('refuses a $near find, and puts a $geoNear’s ties in order, where a geo index holds a hidden key (I4)', async () => {
    const geo = { name: 'loc_phone', key: { loc: '2dsphere', 'customer.phone': 1 } }
    const deps = depsOf(PHONE, [ID_INDEX, geo])
    const at = { $near: { $geometry: { type: 'Point', coordinates: [0, 0] } } }
    expect(await reason(find(deps, { filter: { loc: at } }))).toBe('masking_unsupported')
    const geoNear = {
      $geoNear: { near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'd', key: 'loc' },
    }
    const { stages, ends } = await run(deps, [geoNear, { $limit: 3 }])
    expect(stages).toEqual([geoNear, { $sort: { d: 1, _id: 1 } }, { $limit: 3 }])
    expect(ends).toEqual([2, 3])
    // A geo index holding nothing hidden besides its location leaves both alone.
    const plainGeo = depsOf(PHONE, [ID_INDEX, PHONE_INDEX, { name: 'loc', key: { loc: '2dsphere' } }])
    expect((await find(plainGeo, { filter: { loc: at } })).sort).toBeUndefined()
    expect((await run(plainGeo, [geoNear])).stages).toEqual([geoNear])
    // An order needed whatever the indexes (a job's read, a view to store) puts the ties in order
    // though no geo index holds a hidden key today (review of the agent's gate, M-A).
    // A find's $near is read once, as it runs: judged by today's geo indexes, under 'always' too.
    expect(
      (await guardFind('crm', 'users', { filter: { loc: at } }, plainGeo, { order: 'always' })).filter,
    ).toEqual({ loc: at })
    const always = await guardAggregate('crm', 'users', [geoNear, { $limit: 3 }], plainGeo, {
      order: 'always',
    })
    expect(always.stages.slice(0, 2)).toEqual([geoNear, { $sort: { d: 1, _id: 1 } }])
  })

  it('takes { a: { x: 1, $near } } for the literal it is (M2)', async () => {
    expect((await find(depsOf(PHONE), { filter: { loc: { x: 1, $near: [0, 0] } } })).sort).toEqual({ _id: 1 })
  })

  it('adds _id to a user’s hint where the natural order follows a hidden value', async () => {
    const deps = depsOf(
      [{ db: 'crm', coll: 'users', field: '_id.phone' }],
      [CLUSTERED, { name: 'name_1', key: { name: 1 } }],
    )
    const guarded = await find(deps, { hint: 'name_1' })
    expect(guarded.sort).toEqual({ _id: 1 })
    expect(guarded.hint).toBe('name_1')
    expect(await reason(find(depsOf(ID_HIDDEN, [CLUSTERED]), { hint: { $natural: 1 } }))).toBe(
      'masking_unsupported',
    )
  })

  it('never refuses a find whose filter or output alone is used (M5)', async () => {
    const deps = depsOf(ID_HIDDEN, [CLUSTERED])
    expect(await reason(guardFind('crm', 'users', { filter: {} }, deps, { order: false }))).toBe('allowed')
  })

  it('gives the stages that order what a guarded $match matched (I1)', async () => {
    expect(await guardOrder('crm', 'users', depsOf(PHONE))).toEqual([{ $sort: { _id: 1 } }])
    expect(await guardOrder('crm', 'notes', depsOf(PHONE))).toEqual([])
    expect(JSON.stringify(await guardOrder('crm', 'users', depsOf(ID_HIDDEN)))).toContain('$rand')
  })
})

describe('the fourth review of the order', () => {
  const ID_HIDDEN = [...PHONE, { db: 'crm', coll: 'users', field: '_id' }]
  const geoNear = (extra: Document = {}) => ({
    $geoNear: { near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'd', ...extra },
  })
  const at = { $near: { $geometry: { type: 'Point', coordinates: [0, 0] } } }

  it('puts a geo query’s ties in order where the natural order follows a hidden _id (I-C)', async () => {
    const deps = depsOf(ID_HIDDEN, [CLUSTERED, { name: 'loc', key: { loc: '2dsphere' } }])
    const { stages } = await run(deps, [geoNear({ key: 'loc' })])
    expect(plain(stages)).toEqual([
      geoNear({ key: 'loc' }),
      { $addFields: { r: { $rand: {} } } },
      { $sort: { d: 1, r: 1 } },
      { $unset: ['r'] },
    ])
    const may = depsOf(
      [{ db: 'crm', coll: 'users', field: '_id.email' }],
      [CLUSTERED, { name: 'loc', key: { loc: '2dsphere' } }],
    )
    expect(await reason(find(may, { filter: { loc: at } }))).toBe('masking_unsupported')
  })

  it('takes a view over a time series to be ordered by what its rules hide (I-D)', async () => {
    const views = { v: { viewOn: 'series', pipeline: [{ $match: {} }] } }
    const storage = { series: { clustered: false, timeseries: { timeField: 'at' } } }
    const deps: GateDeps = {
      ...depsOf(
        [{ db: 'crm', coll: 'v', field: 'at' }],
        [{ name: 'x_1', key: { x: 1 } }],
        views,
        {},
        storage,
      ),
      indexes: async () => [{ name: 'x_1', key: { x: 1 } }],
    }
    const guarded = await find(deps, { sort: { $natural: 1 } }, 'v').catch((e: AppError) => e)
    expect((guarded as AppError).details).toMatchObject({ reason: 'masking_unsupported' })
    expect((await find(deps, {}, 'v')).sort).toEqual({ _id: 1 })
  })

  it('refuses an empty or a $-hint only where rules apply, and a wildcard where they hide anything (Minor 2)', async () => {
    const deps = depsOf(PHONE, [ID_INDEX, PHONE_INDEX, { name: 'all', key: { '$**': 1 } }])
    for (const hint of [{}, { '$**': 1 }])
      expect(await reason(find(deps, { hint }, 'notes')), JSON.stringify(hint)).toBe('allowed')
    expect(await reason(find(deps, { hint: { '$**': 1 } }))).toBe('personal_field')
  })

  it('refuses a DBRef or a number for a hint where rules apply (Minor 7)', async () => {
    const deps = depsOf(PHONE)
    for (const hint of [new DBRef('users', new ObjectId()), Long.fromNumber(1)])
      expect(await reason(find(deps, { hint: hint as never }))).toBe('masking_unsupported')
  })

  it('breaks a time series’ _id ties at random in a pipeline (Minor 4)', async () => {
    const storage = { users: { clustered: false, timeseries: { timeField: 'at', metaField: 'meta' } } }
    const deps = depsOf([{ db: 'crm', coll: 'users', field: 'meta.email' }], [], {}, {}, storage)
    expect(plain((await run(deps, [{ $match: {} }])).stages)).toEqual([
      { $match: {} },
      { $addFields: { r: { $rand: {} } } },
      { $sort: { _id: 1, r: 1 } },
      { $unset: ['r'] },
    ])
  })

  it('weighs a $near by the geo index of its own field (nit)', async () => {
    const deps = depsOf(PHONE, [
      ID_INDEX,
      { name: 'b', key: { b: '2dsphere', 'customer.phone': 1 } },
      { name: 'a', key: { a: '2dsphere' } },
    ])
    expect((await find(deps, { filter: { a: at } })).sort).toBeUndefined()
    expect(await reason(find(deps, { filter: { b: at } }))).toBe('masking_unsupported')
    expect((await run(deps, [geoNear({ key: 'a' })])).stages).toEqual([geoNear({ key: 'a' })])
    expect((await run(deps, [geoNear({ key: 'b' })])).stages).toHaveLength(2)
  })

  it('refuses a $natural sort with other keys, and breaks a distance written over _id at random (nits)', async () => {
    expect(await reason(find(depsOf(PHONE), { sort: { $natural: 1, name: 1 } }))).toBe('masking_unsupported')
    const deps = depsOf(PHONE, [ID_INDEX, { name: 'b', key: { b: '2dsphere', 'customer.phone': 1 } }])
    const { stages } = await run(deps, [geoNear({ key: 'b', distanceField: '_id' })])
    expect(plain(stages).slice(1, 3)).toEqual([
      { $addFields: { r: { $rand: {} } } },
      { $sort: { _id: 1, r: 1 } },
    ])
  })

  it('checks every index a hint names, a partial one on what may be hidden too (nits)', async () => {
    const plainName = { name: 'name_1', key: { name: 1 } }
    const partial = {
      name: 'name_p',
      key: { name: 1 },
      partialFilterExpression: { 'customer.phone': { $exists: true } },
    }
    const deps = depsOf(PHONE, [ID_INDEX, plainName, partial])
    expect(await reason(find(deps, { hint: { name: 1 } }))).toBe('personal_field')
    expect(await reason(find(deps, { hint: 'name_p' }))).toBe('personal_field')
    // A partial filter the gate allows (whether a customer is there) is no refusal (fifteenth review, nit).
    const shown = { ...partial, name: 'name_c', partialFilterExpression: { customer: { $exists: true } } }
    expect(await reason(find(depsOf(PHONE, [ID_INDEX, shown]), { hint: 'name_c' }))).toBe('allowed')
  })

  it('marks an order refusal as such (I-B)', async () => {
    const e = await find(depsOf(ID_HIDDEN, [CLUSTERED])).catch((err: AppError) => err)
    expect(isOrderRefusal(e)).toBe(true)
    expect(
      isOrderRefusal(await find(depsOf(PHONE), { sort: { 'customer.phone': 1 } }).catch((err) => err)),
    ).toBe(false)
  })
})

describe('the fifth review of the order', () => {
  const SERIES = [{ db: 'crm', coll: 'users', field: 'meta.email' }]
  const STORAGE = { users: { clustered: false, timeseries: { timeField: 'at', metaField: 'meta' } } }

  it('keeps the direction of the user’s own _id in a time series’ sort (I-2)', async () => {
    const deps = depsOf(SERIES, [], {}, {}, STORAGE)
    expect(plain((await run(deps, [{ $sort: { _id: -1 } }, { $limit: 10 }])).stages)).toEqual([
      { $addFields: { r: { $rand: {} } } },
      { $sort: { _id: -1, r: 1 } },
      { $unset: ['r'] },
      { $limit: 10 },
    ])
  })

  it('refuses a key hint no listed index has, where rules apply (Minor 3)', async () => {
    expect(await reason(find(depsOf(PHONE), { hint: { other: 1 } }))).toBe('masking_unsupported')
    expect(await reason(find(depsOf(PHONE), { hint: { other: 1 } }, 'notes'))).toBe('allowed')
  })

  it('reads a page refused for a document _id again in natural order, where that tells nothing (Minor 5)', async () => {
    const guarded = await find(depsOf([{ db: 'crm', coll: 'users', field: '**.phone' }]))
    expect(() => guarded.finish([{ _id: { k: 1 } }])).toThrow()
    expect(guarded.natural).toMatchObject({ hint: { $natural: 1 } })
    expect(guarded.natural!.finish([{ _id: { k: 1 } }])).toHaveLength(1)
    // Where only _id can order (clustered), there is no such read.
    expect(
      (await find(depsOf([{ db: 'crm', coll: 'users', field: '**.phone' }], [CLUSTERED]))).natural,
    ).toBeUndefined()
  })

  it('allows a hint on a view where no rule applies (Minor 8)', async () => {
    const views = { vn: { viewOn: 'notes', pipeline: [{ $match: {} }] } }
    expect(await reason(find(depsOf(PHONE, [ID_INDEX], views), { hint: 'any' }, 'vn'))).toBe('allowed')
  })

  it('refuses a $natural sort with other keys as malformed, not for its order (nit)', async () => {
    const e = await find(depsOf(PHONE), { sort: { $natural: 1, name: 1 } }).catch((err: unknown) => err)
    expect(isOrderRefusal(e)).toBe(false)
    expect((e as AppError).details).toMatchObject({ reason: 'masking_unsupported' })
  })

  it('names the order a page needs, not a sort the user never asked for (Minor 4)', async () => {
    const e = await find(depsOf([{ db: 'crm', coll: 'users', field: '**.phone' }]), {
      projection: { _id: { $toString: '$_id' } },
    }).catch((err: AppError) => err)
    expect((e as AppError).message).toContain('The _id order this page needs')
  })
})

describe('the sixth review of the order', () => {
  const WILD = [{ db: 'crm', coll: 'users', field: '**.phone' }]
  const SERIES = [{ db: 'crm', coll: 'users', field: 'meta.email' }]
  const STORAGE = { users: { clustered: false, timeseries: { timeField: 'at', metaField: 'meta' } } }

  it('offers no natural read where the user’s own sort names _id (C1)', async () => {
    expect((await find(depsOf(WILD), { sort: { _id: 1 } })).natural).toBeUndefined()
    expect((await find(depsOf(WILD), { sort: { name: 1, _id: -1 } })).natural).toBeUndefined()
    expect((await find(depsOf(WILD), { sort: { name: 1 } })).natural).toBeDefined()
  })

  it('says where a time series’ _ids are to be asked about (seventeenth review, I1)', async () => {
    expect((await find(depsOf(SERIES, [], {}, {}, STORAGE))).repeats).toBe(true)
    expect((await find(depsOf(PHONE))).repeats).toBe(false)
    expect(
      (await guardFilterFor('crm', 'users', { _id: 1 }, depsOf(SERIES, [], {}, {}, STORAGE))).repeats,
    ).toBe(true)
    // Or a view over one that rebuilds _id (eighteenth review, Minor 5).
    const rebuilt = { v: { viewOn: 'users', pipeline: [{ $project: { _id: '$x', x: 1 } }] } }
    expect((await guardFilterFor('crm', 'v', {}, depsOf(SERIES, [], rebuilt, {}, STORAGE))).repeats).toBe(
      true,
    )
    expect(await reason(find(depsOf(SERIES, [], {}, {}, STORAGE), { projection: { '_id.a': 1 } }))).toBe(
      'masking_unsupported',
    )
  })

  it('reads the _id it looks for repeats in, whatever the projection (I1)', async () => {
    const hidden = await find(depsOf(SERIES, [], {}, {}, STORAGE), { projection: { _id: 0, x: 1 } })
    expect(hidden.projection).toEqual({ x: 1 })
    expect(
      hidden.finish([
        { _id: 1, x: 1 },
        { _id: 2, x: 2 },
      ]),
    ).toEqual([{ x: 1 }, { x: 2 }])
    expect(
      await reason(find(depsOf(SERIES, [], {}, {}, STORAGE), { projection: { _id: { $toString: '$x' } } })),
    ).toBe('masking_unsupported')
  })
})

// Thirteenth and fourteenth reviews of explain masking (I-2, I-1, M-7): a collation that folds.
describe('under a collation that makes distinct _ids equal', () => {
  const CI = { locale: 'en', strength: 2 }
  it('asks about a page’s _ids where they break its ties, and only there', async () => {
    expect((await find(depsOf(PHONE), { collation: CI })).repeats).toBe(true)
    expect((await find(depsOf(PHONE), { collation: { locale: 'simple' } })).repeats).toBe(false)
    expect((await find(depsOf(PHONE))).repeats).toBe(false)
    // No index orders by what is hidden: nothing to ask.
    expect((await find(depsOf(PHONE, [ID_INDEX]), { collation: CI })).repeats).toBe(false)
    // Read in natural order: _id breaks no tie.
    const idHidden = [...PHONE, { db: 'crm', coll: 'users', field: '_id' }]
    expect((await find(depsOf(idHidden), { collation: CI })).repeats).toBe(false)
  })

  it('takes a view’s own collation as the read’s, and breaks a pipeline’s ties at random', async () => {
    const rules = [{ db: 'crm', coll: 'v', field: 'customer.phone' }]
    const folding = depsOf(rules, undefined, { v: { viewOn: 'users', pipeline: [], collation: CI } })
    const simple = depsOf(rules, undefined, { v: { viewOn: 'users', pipeline: [] } })
    expect((await find(folding, {}, 'v')).repeats).toBe(true)
    expect((await find(simple, {}, 'v')).repeats).toBe(false)
    expect(JSON.stringify((await run(folding, [{ $match: {} }], 'v')).stages)).toContain('$rand')
    expect(JSON.stringify((await run(simple, [{ $match: {} }], 'v')).stages)).not.toContain('$rand')
    expect((await guardFilterFor('crm', 'v', { _id: 'bob' }, folding)).repeats).toBe(true)
    expect((await guardFilterFor('crm', 'v', { _id: 'bob' }, simple)).repeats).toBe(false)
  })

  // Final reviews of explain masking (M-3, Minor 3c): whether an _id itself may repeat.
  it('says an _id may repeat only in a series stored by what is hidden, and judges a series to be', async () => {
    const SERIES_AT = { users: { clustered: false, timeseries: { timeField: 'at', metaField: 'meta' } } }
    const meta = [{ db: 'crm', coll: 'users', field: 'meta.email' }]
    const at = [{ db: 'crm', coll: 'users', field: 'at' }]
    const other = [{ db: 'crm', coll: 'users', field: 'v' }]
    const ask = (rules: typeof meta, storage: object) =>
      guardFilterFor(
        'crm',
        'users',
        {},
        depsOf(rules, undefined, {}, { users: 'timeseries' }, storage as never),
      )
    expect((await ask(meta, SERIES_AT)).idRepeats).toBe(true)
    expect((await ask(at, SERIES_AT)).idRepeats).toBe(true)
    expect((await ask(other, SERIES_AT)).idRepeats).toBe(false)
    // A clustered collection whose _id is hidden holds each once.
    const clustered = await guardFilterFor(
      'crm',
      'users',
      {},
      depsOf([{ db: 'crm', coll: 'users', field: '_id' }], [CLUSTERED]),
    )
    expect(clustered.repeats).toBe(true)
    expect(clustered.idRepeats).toBe(false)
    expect(
      seriesStoredByHidden(compileRules(meta), 'crm', 'users', { timeField: 'at', metaField: 'meta' }),
    ).toBe(true)
    expect(seriesStoredByHidden(compileRules(at), 'crm', 'users', { timeField: 'at' })).toBe(true)
    expect(
      seriesStoredByHidden(compileRules(other), 'crm', 'users', { timeField: 'at', metaField: 'meta' }),
    ).toBe(false)
  })

  // Final review of explain masking (nit): what $graphLookup gathers, at random where its order may
  // follow what is hidden.
  it('shuffles what $graphLookup gathers where the joined order may follow what is hidden', async () => {
    const stage = {
      $graphLookup: {
        from: 'users',
        startWith: '$name',
        connectFromField: 'name',
        connectToField: 'name',
        as: 'g',
      },
    }
    const ruled = plain((await run(depsOf(PHONE), [stage])).stages) as Document[]
    const at = ruled.findIndex((x) => '$graphLookup' in x)
    // Right after it, the gathered array put in a random order.
    expect(JSON.stringify(ruled[at + 1])).toContain('$sortArray')
    expect(JSON.stringify(ruled[at + 1])).toContain('$rand')
    // Whatever the indexes, where rules apply there (its order is MongoDB's own map, by the foreign
    // _id; final review, M-1); not where none does.
    const indexed = plain(
      (await run(depsOf(PHONE, [ID_INDEX, { name: 'name_1', key: { name: 1 } }]), [stage])).stages,
    )
    expect(JSON.stringify(indexed)).toContain('$sortArray')
    const open = plain((await run(depsOf([{ db: 'crm', coll: 'other', field: 'x' }]), [stage])).stages)
    expect(JSON.stringify(open)).not.toContain('$sortArray')
  })

  // Fifteenth review of explain masking (I-1, I-2).
  it('breaks the ties of a pipeline sorted by _id on a folding view, and of what it joins', async () => {
    const rules = [...PHONE, { db: 'crm', coll: 'v', field: 'customer.phone' }]
    const views = { v: { viewOn: 'users', pipeline: [], collation: CI } }
    const folding = depsOf(rules, undefined, views)
    const sorted = await run(folding, [{ $match: { name: 'Ali' } }, { $sort: { _id: 1 } }], 'v')
    expect(JSON.stringify(sorted.stages)).toContain('$rand')
    const joined = await run(
      folding,
      [{ $unionWith: { coll: 'users', pipeline: [{ $match: { name: 'Ali' } }] } }],
      'v',
    )
    const union = plain(joined.stages).find((s: Document) => '$unionWith' in s) as {
      $unionWith: { pipeline: Document[] }
    }
    expect(JSON.stringify(union.$unionWith.pipeline)).toContain('$rand')
    // On the collection itself, which keeps its _ids unique, no tie to break.
    const own = await run(depsOf(rules), [
      { $unionWith: { coll: 'users', pipeline: [{ $match: { name: 'Ali' } }] } },
    ])
    // Unless the collection's own collation makes them equal: its joins read under it (sixteenth
    // review, I-2; measured on 8.2); not its own order, nor a join into one with the same collation,
    // whose _ids that collation keeps unique (seventeenth review, I-1).
    const ordersRules = [...rules, { db: 'crm', coll: 'orders', field: 'customer.phone' }]
    const storage = { orders: { clustered: false, collation: CI }, users: { clustered: false } }
    const collated = await run(
      depsOf(ordersRules, undefined, {}, {}, storage),
      [
        { $match: { name: 'Ali' } },
        { $unionWith: { coll: 'users', pipeline: [{ $match: { name: 'Ali' } }] } },
      ],
      'orders',
    )
    const stages = plain(collated.stages) as Document[]
    const collatedUnion = stages.find((s: Document) => '$unionWith' in s) as {
      $unionWith: { pipeline: Document[] }
    }
    expect(JSON.stringify(collatedUnion.$unionWith.pipeline)).toContain('$rand')
    expect(JSON.stringify(stages.filter((s) => !('$unionWith' in s)))).not.toContain('$rand')
    expect(stages.filter((s) => !('$unionWith' in s))).toContainEqual({ $sort: { _id: 1 } })
    const same = await run(
      depsOf(
        ordersRules,
        undefined,
        {},
        {},
        { orders: storage.orders, users: { clustered: false, collation: CI } },
      ),
      [{ $unionWith: { coll: 'users', pipeline: [{ $match: { name: 'Ali' } }] } }],
      'orders',
    )
    expect(JSON.stringify(same.stages)).not.toContain('$rand')
    const plainUnion = plain(own.stages).find((s: Document) => '$unionWith' in s) as {
      $unionWith: { pipeline: Document[] }
    }
    expect(JSON.stringify(plainUnion.$unionWith.pipeline)).not.toContain('$rand')
  })
})
