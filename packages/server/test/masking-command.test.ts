import { describe, expect, it } from 'vitest'
import { compileRules, maskCommand, MASK } from '../src/masking'

const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'address.city' },
  { db: 'crm', coll: 'contacts', field: 'phone' },
])
const mask = (cmd: object, coll = 'users') => maskCommand(cmd, 'crm', coll, masker)

describe('maskCommand (phase 3b §2.3)', () => {
  it('masks filter values under personal paths through logical operators and $elemMatch', () => {
    expect(
      mask({
        find: 'users',
        filter: {
          email: { $in: ['a@x', 'b@x'] },
          $or: [{ 'address.city': 'Ankara' }, { age: { $gt: 30 } }],
          address: { city: 'İzmir' },
          tags: { $elemMatch: { email: 'c@x' } },
        },
        sort: { email: 1 },
        projection: { email: 1 },
      }),
    ).toEqual({
      find: 'users',
      filter: {
        email: { $in: MASK },
        $or: [{ 'address.city': MASK }, { age: { $gt: 30 } }],
        address: { city: MASK },
        tags: { $elemMatch: { email: 'c@x' } },
      },
      sort: { email: 1 },
      projection: { email: 1 },
    })
  })

  it('masks update values, replacement documents and inserted documents', () => {
    expect(
      mask({
        update: 'users',
        updates: [
          { q: { email: 'a@x' }, u: { $set: { email: 'b@x', name: 'N' }, $inc: { n: 1 } } },
          { q: { _id: 1 }, u: { email: 'c@x', address: { city: 'X' } } },
          { q: { _id: 2 }, u: [{ $set: { email: { $concat: ['$email', '.old'] } } }] },
        ],
      }),
    ).toEqual({
      update: 'users',
      updates: [
        { q: { email: MASK }, u: { $set: { email: MASK, name: 'N' }, $inc: { n: 1 } } },
        { q: { _id: 1 }, u: { email: MASK, address: { city: MASK } } },
        { q: { _id: 2 }, u: [{ $set: { email: MASK } }] },
      ],
    })
    expect(mask({ insert: 'users', documents: [{ email: 'a@x', n: 1 }] })).toEqual({
      insert: 'users',
      documents: [{ email: MASK, n: 1 }],
    })
  })

  it('masks literals compared with a personal field in expressions, and follows $lookup', () => {
    expect(
      mask({
        aggregate: 'users',
        pipeline: [
          { $match: { $expr: { $eq: ['$email', 'a@x'] } } },
          { $group: { _id: '$address.city', n: { $sum: 1 } } },
          { $lookup: { from: 'contacts', pipeline: [{ $match: { phone: '555' } }], as: 'c' } },
          { $limit: 5 },
        ],
      }),
    ).toEqual({
      aggregate: 'users',
      pipeline: [
        { $match: { $expr: { $eq: ['$email', MASK] } } },
        { $group: { _id: '$address.city', n: { $sum: 1 } } },
        { $lookup: { from: 'contacts', pipeline: [{ $match: { phone: MASK } }], as: 'c' } },
        { $limit: 5 },
      ],
    })
  })

  it('masks literals it cannot attribute (variables, unknown stages, $where) (review focus 1)', () => {
    const out = mask({
      aggregate: 'users',
      pipeline: [
        { $match: { $expr: { $let: { vars: { e: '$email' }, in: { $eq: ['$$e', 'a@x'] } } } } },
        { $setWindowFields: { output: { x: { $sum: 7 } } } },
        { $match: { $where: "this.email == 'a@x'" } },
      ],
    }) as { pipeline: unknown[] }
    expect(JSON.stringify(out)).not.toContain('a@x')
    expect(out.pipeline[1]).toEqual({ $setWindowFields: MASK })
  })

  it('keeps a command on a namespace without rules as it is', () => {
    const cmd = { find: 'orders', filter: { email: 'a@x' } }
    expect(mask(cmd, 'orders')).toEqual(cmd)
  })

  it('masks every literal of a command it does not know', () => {
    expect(mask({ mapReduce: 'users', query: { email: 'a@x' }, out: 'o' })).toEqual({
      mapReduce: 'users',
      query: MASK,
      out: MASK,
    })
  })
})
