import { describe, expect, it } from 'vitest'
import { Long, ObjectId } from 'mongodb'
import { queryShape } from '../src/monitor/query-shape'
import { fromProfile, parseSlowLog } from '../src/monitor/slow-queries'

/**
 * Index advice gaps (2026-10-27, wave 4 #6): a slow query's shape — what it asks, never a value —
 * so the slow queries of one kind are counted together.
 */
describe('a query’s shape', () => {
  it('keeps the keys and operators of a find, and none of its values', () => {
    const a = queryShape({
      find: 'people',
      filter: { email: 'ada@example.com', age: { $gt: 40 }, _id: new ObjectId() },
      sort: { created: -1 },
      projection: { name: 1, email: 0 },
      limit: 10,
    })
    expect(a).toBe(
      'find {"filter":{"email":"?","age":{"$gt":"?"},"_id":"?"},"sort":{"created":-1},"projection":{"name":1,"email":0}}',
    )
    expect(a).not.toContain('ada@example.com')
    expect(a).not.toContain('40')
    // The same query of other values: the same shape.
    expect(
      queryShape({
        find: 'people',
        filter: { email: 'bob@example.com', age: { $gt: Long.fromNumber(7) }, _id: new ObjectId() },
        sort: { created: -1 },
        projection: { name: 1, email: 0 },
      }),
    ).toBe(a)
  })

  it('folds a list of values into one, and keeps a list of conditions', () => {
    expect(queryShape({ find: 'c', filter: { s: { $in: [1, 2, 3] } } })).toBe(
      queryShape({ find: 'c', filter: { s: { $in: ['x'] } } }),
    )
    expect(queryShape({ find: 'c', filter: { $or: [{ a: 1 }, { b: { $exists: true } }] } })).toBe(
      'find {"filter":{"$or":[{"a":"?"},{"b":{"$exists":"?"}}]}}',
    )
  })

  it('reads aggregates, counts, distincts, updates, deletes and statements', () => {
    expect(
      queryShape({
        aggregate: 'orders',
        pipeline: [
          { $match: { status: 'paid' } },
          { $sort: { at: 1 } },
          { $limit: 5 },
          { $project: { a: 1 } },
        ],
      }),
    ).toBe(
      'aggregate {"pipeline":[{"$match":{"status":"?"}},{"$sort":{"at":1}},{"$limit":"?"},{"$project":{"a":1}}]}',
    )
    expect(queryShape({ count: 'c', query: { a: 'x' } })).toBe('count {"query":{"a":"?"}}')
    expect(queryShape({ distinct: 'c', key: 'city', query: { a: 2 } })).toBe(
      'distinct {"key":"city","query":{"a":"?"}}',
    )
    expect(queryShape({ update: 'c', updates: [{ q: { a: 1 }, u: { $set: { b: 'secret' } } }] })).toBe(
      'update {"q":{"a":"?"}}',
    )
    expect(queryShape({ delete: 'c', deletes: [{ q: { a: 'x' }, limit: 1 }] })).toBe('delete {"q":{"a":"?"}}')
    expect(queryShape({ q: { a: 'x' }, u: { $set: { b: 1 } } })).toBe('update {"q":{"a":"?"}}')
    expect(
      queryShape({ findAndModify: 'c', query: { a: 1 }, sort: { b: 1 }, update: { $set: { c: 'v' } } }),
    ).toBe('findAndModify {"query":{"a":"?"},"sort":{"b":1}}')
    expect(queryShape({ getMore: Long.fromNumber(5), collection: 'c' })).toBe('getMore')
    expect(queryShape({ hello: 1 })).toBe('hello')
    expect(queryShape(null)).toBe('')
  })

  it('keeps a projection’s own choices, never a number deeper in it', () => {
    const shape = queryShape({
      aggregate: 'c',
      pipeline: [{ $project: { a: 1, old: { $cond: [{ $gt: ['$age', 40] }, 1, 0] } } }],
    })
    expect(shape).toContain('"a":1')
    expect(shape).not.toContain('40')
    expect(queryShape({ aggregate: 'c', pipeline: [{ $project: { a: { $literal: 5 } } }] })).not.toContain(
      '5',
    )
  })

  // Final review I2: a sort's or a projection's values are kept where they are one — the command's
  // own, a $sort's or a $project's — never under a field a user named "sort" or "projection".
  it('keeps directions by position, never under a field named sort or projection', () => {
    const find = queryShape({
      find: 'c',
      filter: { sort: { $gt: 1000 }, projection: { x: true } },
      sort: { a: 1 },
      projection: { b: 0 },
    })
    expect(find).toBe(
      'find {"filter":{"sort":{"$gt":"?"},"projection":{"x":"?"}},"sort":{"a":1},"projection":{"b":0}}',
    )
    const pipeline = queryShape({
      aggregate: 'c',
      pipeline: [
        { $match: { sort: { $gt: 1000 } } },
        { $addFields: { projection: { $literal: true }, $sort: 7 } },
        { $facet: { top: [{ $sort: { at: -1 } }, { $match: { $sort: 9 } }] } },
      ],
    })
    expect(pipeline).not.toMatch(/1000|true|7|9/)
    expect(pipeline).toContain('{"$sort":{"at":-1}}')
  })

  // Final review Minor 16: a getMore is the query whose cursor it reads.
  it('names a getMore by the query it continues', () => {
    expect(
      queryShape({ getMore: Long.fromNumber(5), collection: 'c' }, { find: 'c', filter: { a: 'x' } }),
    ).toBe('getMore find {"filter":{"a":"?"}}')
    const profiled = fromProfile({
      ns: 'a.b',
      millis: 3,
      command: { getMore: Long.fromNumber(5), collection: 'b' },
      originatingCommand: { find: 'b', filter: { k: 1 } },
    })
    expect(queryShape(profiled.command, profiled.origin)).toBe('getMore find {"filter":{"k":"?"}}')
    const line = JSON.stringify({
      t: { $date: '2026-10-27T10:00:00.000Z' },
      id: 51803,
      attr: {
        ns: 'a.b',
        durationMillis: 120,
        command: { getMore: 5, collection: 'b' },
        originatingCommand: { aggregate: 'b', pipeline: [] },
      },
    })
    const logged = parseSlowLog([line])[0]!
    expect(queryShape(logged.command, logged.origin)).toBe('getMore aggregate {"pipeline":[]}')
  })

  it('is cut to a bounded size', () => {
    const filter = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`field_${i}`, i]))
    expect(queryShape({ find: 'c', filter }).length).toBeLessThanOrEqual(2001)
  })
})

describe('a slow query’s shape hash (MongoDB 8.0+)', () => {
  const hash = 'A'.repeat(64)
  it('is read from the log and the profiler, and only when it is a hash', () => {
    const line = JSON.stringify({
      t: { $date: '2026-10-27T10:00:00.000Z' },
      id: 51803,
      attr: { ns: 'a.b', durationMillis: 120, command: { find: 'b', filter: {} }, queryShapeHash: hash },
    })
    expect(parseSlowLog([line])[0]!.shapeHash).toBe(hash)
    const odd = line.replace(hash, 'not a hash')
    expect(parseSlowLog([odd])[0]!.shapeHash).toBeUndefined()
    expect(
      fromProfile({ ns: 'a.b', millis: 3, command: { find: 'b' }, queryShapeHash: hash }).shapeHash,
    ).toBe(hash)
  })
})
