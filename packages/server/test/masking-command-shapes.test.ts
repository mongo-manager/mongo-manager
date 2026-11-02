import { describe, expect, it } from 'vitest'
import { compileRules, maskCommand, MASK } from '../src/masking'

/**
 * Phase 3b §2.3: what each command, stage and update operator keeps and hides — so a value is
 * hidden only where it may be personal, and structure stays readable.
 */
const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'address.zip' },
])
const none = compileRules([])
const m = (cmd: unknown, coll = 'users', db = 'crm', with_ = masker) =>
  JSON.parse(JSON.stringify(maskCommand(cmd, db, coll, with_))) as unknown
const agg = (stage: object, coll = 'users') =>
  (m({ aggregate: coll, pipeline: [stage] }, coll) as { pipeline: unknown[] }).pipeline[0]

describe('stages', () => {
  it('reads $set, $addFields and $project field by field', () => {
    expect(agg({ $set: { email: 'x', note: 'n', 'address.zip': '1', copy: '$email' } })).toEqual({
      $set: { email: MASK, note: 'n', 'address.zip': MASK, copy: '$email' },
    })
    expect(agg({ $addFields: { address: { zip: '1', city: 'c' } } })).toEqual({
      $addFields: { address: { zip: MASK, city: 'c' } },
    })
    expect(
      agg({ $project: { email: 1, n: 0, items: { $elemMatch: { email: 'x' } }, s: { $slice: 2 } } }),
    ).toEqual({
      $project: { email: 1, n: 0, items: { $elemMatch: { email: 'x' } }, s: { $slice: 2 } },
    })
    expect(agg({ $project: { email: { $elemMatch: { a: 1 } } } })).toEqual({ $project: { email: MASK } })
  })

  it('reads $replaceRoot, $bucket, $redact and $geoNear', () => {
    expect(agg({ $replaceRoot: { newRoot: { email: 'x', n: 1 } } })).toEqual({
      $replaceRoot: { newRoot: { email: MASK, n: 1 } },
    })
    expect(agg({ $replaceRoot: { newRoot: '$sub' } })).toEqual({ $replaceRoot: { newRoot: '$sub' } })
    expect(agg({ $replaceRoot: 'x' })).toEqual({ $replaceRoot: MASK })
    expect(agg({ $bucket: { groupBy: '$email', boundaries: ['a', 'm'] } })).toEqual({
      $bucket: { groupBy: '$email', boundaries: [MASK, MASK] },
    })
    expect(agg({ $bucket: { groupBy: '$n', boundaries: [0, 10] } })).toEqual({
      $bucket: { groupBy: '$n', boundaries: [0, 10] },
    })
    expect(agg({ $redact: { $cond: [{ $eq: ['$email', 'x'] }, '$$PRUNE', '$$KEEP'] } })).toEqual({
      $redact: { $cond: [{ $eq: ['$email', MASK] }, '$$PRUNE', '$$KEEP'] },
    })
    expect(agg({ $geoNear: { near: [1, 2], query: { email: 'x' }, distanceField: 'd' } })).toEqual({
      $geoNear: { near: MASK, query: { email: MASK }, distanceField: 'd' },
    })
    expect(agg({ $geoNear: 'x' })).toEqual({ $geoNear: MASK })
    expect(agg({ $group: 'x' })).toEqual({ $group: MASK })
  })

  it('keeps value-free stages and masks stages it does not model', () => {
    for (const stage of [
      { $limit: 5 },
      { $skip: 1 },
      { $sort: { email: 1 } },
      { $count: 'n' },
      { $unset: 'email' },
      { $sample: { size: 3 } },
    ])
      expect(agg(stage)).toEqual(stage)
    expect(agg({ $densify: { field: 'email', range: { step: 1 } } })).toEqual({ $densify: MASK })
    expect(m({ aggregate: 'users', pipeline: ['x', { $match: {}, $limit: 1 }] })).toEqual({
      aggregate: 'users',
      pipeline: [MASK, MASK],
    })
    expect(m({ aggregate: 'users', pipeline: 'x' })).toEqual({ aggregate: 'users', pipeline: MASK })
  })

  it('follows $facet, $graphLookup and $unionWith', () => {
    expect(agg({ $facet: { a: [{ $match: { email: 'x' } }], b: [{ $limit: 1 }] } })).toEqual({
      $facet: { a: [{ $match: { email: MASK } }], b: [{ $limit: 1 }] },
    })
    expect(agg({ $facet: 'x' })).toEqual({ $facet: MASK })
    expect(
      agg(
        {
          $graphLookup: {
            from: 'users',
            startWith: '$m',
            connectFromField: 'a',
            connectToField: 'b',
            as: 'g',
            restrictSearchWithMatch: { email: 'x' },
          },
        },
        'orders',
      ),
    ).toEqual({
      $graphLookup: {
        from: 'users',
        startWith: '$m',
        connectFromField: 'a',
        connectToField: 'b',
        as: 'g',
        restrictSearchWithMatch: { email: MASK },
      },
    })
    expect(agg({ $graphLookup: { from: 3 } }, 'orders')).toEqual({ $graphLookup: MASK })
    expect(agg({ $unionWith: { coll: 'users', pipeline: [{ $match: { email: 'x' } }] } }, 'orders')).toEqual({
      $unionWith: { coll: 'users', pipeline: [{ $match: { email: MASK } }] },
    })
    expect(agg({ $unionWith: { pipeline: [] } }, 'orders')).toEqual({ $unionWith: MASK })
    expect(agg({ $lookup: 'x' }, 'orders')).toEqual({ $lookup: MASK })
  })

  it('leaves every stage alone when no rule exists', () => {
    const cmd = {
      aggregate: 'users',
      pipeline: [
        { $lookup: { from: 3 } },
        { $unionWith: 5 },
        { $graphLookup: 1 },
        { $documents: [{ a: 1 }] },
      ],
    }
    expect(m(cmd, 'users', 'crm', none)).toEqual(cmd)
  })

  it('masks $documents of a collection aggregate', () => {
    expect(agg({ $documents: [{ n: 1 }] })).toEqual({ $documents: [{ n: MASK }] })
  })
})

describe('update operators', () => {
  const u = (update: unknown) =>
    (m({ update: 'users', updates: [{ q: {}, u: update }] }) as { updates: Array<{ u: unknown }> })
      .updates[0]!.u
  it('keeps names, masks values of personal paths, walks $push modifiers', () => {
    expect(u({ $unset: { email: '' }, $rename: { email: 'mail' }, $currentDate: { at: true } })).toEqual({
      $unset: { email: '' },
      $rename: { email: 'mail' },
      $currentDate: { at: true },
    })
    expect(u({ $set: 'x' })).toEqual({ $set: MASK })
    expect(u('x')).toEqual(MASK)
    expect(u({ $pull: { email: 'x', tags: 'y' } })).toEqual({ $pull: { email: MASK, tags: 'y' } })
    expect(
      u({ $push: { address: { $each: [{ zip: '1' }], $position: 0, $slice: 5, $sort: { zip: 1 }, $x: 1 } } }),
    ).toEqual({
      $push: { address: { $each: [{ zip: MASK }], $position: 0, $slice: 5, $sort: { zip: 1 }, $x: MASK } },
    })
    expect(u({ $addToSet: { address: { $each: 'x' } } })).toEqual({ $addToSet: { address: { $each: MASK } } })
    expect(u({ $set: { address: { zip: '1', c: 2 } } })).toEqual({ $set: { address: { zip: MASK, c: 2 } } })
  })

  it('leaves updates alone on a collection without rules', () => {
    const cmd = { update: 'orders', updates: [{ q: { email: 'x' }, u: { $set: { email: 'y' } } }] }
    expect(m(cmd, 'orders')).toEqual(cmd)
  })
})

describe('commands', () => {
  it('masks count, distinct, insert, delete and findAndModify', () => {
    expect(m({ count: 'users', query: { email: 'x' } })).toEqual({ count: 'users', query: { email: MASK } })
    expect(m({ distinct: 'users', key: 'email', query: { email: 'x' } })).toEqual({
      distinct: 'users',
      key: 'email',
      query: { email: MASK },
    })
    expect(m({ insert: 'users', documents: 'x' })).toEqual({ insert: 'users', documents: MASK })
    expect(m({ delete: 'users', deletes: [{ q: { email: 'x' }, limit: 1 }, 'x'] })).toEqual({
      delete: 'users',
      deletes: [{ q: { email: MASK }, limit: 1 }, MASK],
    })
    expect(
      m({
        findAndModify: 'users',
        query: { email: 'x' },
        update: { $set: { n: 1 } },
        fields: { email: 1 },
        arrayFilters: [{}],
        sort: { n: 1 },
      }),
    ).toEqual({
      findAndModify: 'users',
      query: { email: MASK },
      update: { $set: { n: 1 } },
      fields: { email: 1 },
      arrayFilters: MASK,
      sort: { n: 1 },
    })
  })

  it('keeps getMore and killCursors, and own comments', () => {
    expect(m({ getMore: { $numberLong: '5' }, collection: 'users' })).toEqual({
      getMore: { $numberLong: '5' },
      collection: 'users',
    })
    expect(m({ killCursors: 'users', cursors: [] })).toEqual({ killCursors: 'users', cursors: [] })
    expect(m({ find: 'users', filter: {}, comment: 'mm-monitor' })).toEqual({
      find: 'users',
      filter: {},
      comment: 'mm-monitor',
    })
    expect(m({ find: 'users', filter: {}, comment: 'free text' })).toEqual({
      find: 'users',
      filter: {},
      comment: MASK,
    })
  })

  it('masks what it cannot read, and nothing when no rule exists', () => {
    expect(m('text')).toBe(MASK)
    expect(m('text', 'users', 'crm', none)).toBe('text')
    expect(m(5)).toBe(5)
    expect(m({})).toEqual({})
    expect(m({ $truncated: 'x' }, 'users', 'crm', none)).toEqual({ $truncated: 'x' })
    expect(m({ aggregate: 1, pipeline: [{ $documents: [{ n: 1 }] }] }, '', 'crm', none)).toEqual({
      aggregate: 1,
      pipeline: [{ $documents: [{ n: 1 }] }],
    })
    expect(m({ aggregate: 1, pipeline: [], let: { a: 1 } }, '')).toEqual({
      aggregate: 1,
      pipeline: [],
      let: MASK,
    })
    expect(m({ mapReduce: 'orders', query: { a: 1 } }, 'orders')).toEqual({
      mapReduce: 'orders',
      query: { a: 1 },
    })
    expect(m({ applyOps: [], x: 1 }, '', 'crm', none)).toEqual({ applyOps: [], x: 1 })
  })

  it('masks filter operators it cannot read on a path with personal parts below', () => {
    expect(
      m({ find: 'users', filter: { address: { $in: [{ zip: '1' }] }, $comment: 'c', $and: 'x' } }),
    ).toEqual({
      find: 'users',
      filter: { address: { $in: MASK }, $comment: MASK, $and: MASK },
    })
    expect(
      m({ find: 'users', filter: { email: { $exists: true, $type: 'string', $size: 1, $eq: 'x' } } }),
    ).toEqual({
      find: 'users',
      filter: { email: { $exists: true, $type: 'string', $size: 1, $eq: MASK } },
    })
    expect(m({ find: 'users', filter: { address: { $not: { zip: '1' }, $exists: true } } })).toEqual({
      find: 'users',
      filter: { address: { $not: { zip: MASK }, $exists: true } },
    })
  })
})
