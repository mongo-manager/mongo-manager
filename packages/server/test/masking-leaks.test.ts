import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { compileRules, maskCommand, redactSecrets } from '../src/masking'

/**
 * Phase 3b final review (C1-C6, M5): the command shapes MongoDB really reports — profile and log
 * statements, truncated commands, explain, positional paths, variables, joins — must never carry a
 * personal value to a restricted user. Each case plants a sentinel under a personal path.
 */
const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'ssn' },
  { db: 'crm', coll: 'users', field: 'address.zip' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
  { db: 'crm', coll: 'users', field: 'contacts.email' },
])
const SECRET = 'alice@x.com'
const out = (cmd: object, coll = 'users', db = 'crm') => JSON.stringify(maskCommand(cmd, db, coll, masker))
const leaks = (cmd: object, coll = 'users', db = 'crm', secret = SECRET) =>
  out(cmd, coll, db).includes(secret)

describe('profile and log statements (final review C1)', () => {
  it('masks an update or delete statement as MongoDB stores it', () => {
    expect(leaks({ q: { email: SECRET }, u: { $set: { n: 1 } }, multi: false, upsert: false })).toBe(false)
    expect(leaks({ q: { email: SECRET }, limit: 1 })).toBe(false)
    expect(leaks({ q: { n: 1 }, u: { email: SECRET } })).toBe(false)
  })
})

describe('commands the engine cannot read (final review C2)', () => {
  it('masks a truncated command whole', () => {
    expect(
      leaks({ $truncated: `{ find: "users", filter: { email: { $in: [ "${SECRET}" ] } } }`, comment: 'x' }),
    ).toBe(false)
  })

  it('masks the command inside explain', () => {
    expect(leaks({ explain: { find: 'users', filter: { email: SECRET } }, verbosity: 'queryPlanner' })).toBe(
      false,
    )
  })

  it('masks commands without a collection name when any rule exists', () => {
    expect(leaks({ applyOps: [{ op: 'i', ns: 'crm.users', o: { email: SECRET } }] }, '')).toBe(false)
    expect(
      leaks(
        { bulkWrite: 1, ops: [{ insert: 0, document: { email: SECRET } }], nsInfo: [{ ns: 'crm.users' }] },
        '',
        'admin',
      ),
    ).toBe(false)
    expect(leaks({ aggregate: 1, pipeline: [{ $documents: [{ email: SECRET }] }] }, '')).toBe(false)
  })
})

describe('expressions (final review C3)', () => {
  const match = (expr: object) => ({ find: 'users', filter: { $expr: expr } })
  it('masks literals anywhere in an expression that reads a personal field', () => {
    expect(leaks(match({ $in: ['$email', [SECRET]] }))).toBe(false)
    expect(leaks(match({ $eq: [{ $toLower: '$email' }, SECRET] }))).toBe(false)
    expect(leaks(match({ $cond: [{ $eq: [{ $substr: ['$email', 0, 3] }, SECRET] }, 1, 0] }))).toBe(false)
    expect(leaks(match({ $eq: ['$ssn', { $numberInt: '123456789' }] }), 'users', 'crm', '123456789')).toBe(
      false,
    )
    expect(leaks(match({ $eq: [{ $getField: 'email' }, SECRET] }))).toBe(false)
  })

  it('masks personal values an output stage writes', () => {
    const agg = (stage: object) => ({ aggregate: 'users', pipeline: [stage] })
    expect(leaks(agg({ $replaceWith: { email: SECRET } }))).toBe(false)
    expect(leaks(agg({ $replaceRoot: { newRoot: { email: SECRET } } }))).toBe(false)
    expect(leaks(agg({ $group: { _id: { $cond: [{ $eq: ['$email', SECRET] }, 1, 0] } } }))).toBe(false)
    expect(leaks(agg({ $sortByCount: { $cond: [{ $eq: ['$email', SECRET] }, 1, 0] } }))).toBe(false)
    expect(
      leaks(
        { update: 'users', updates: [{ q: {}, u: [{ $set: { address: { zip: '34000' } } }] }] },
        'users',
        'crm',
        '34000',
      ),
    ).toBe(false)
  })

  it('keeps literals of expressions on fields that are not personal', () => {
    expect(out(match({ $gt: ['$age', 30] }))).toContain('30')
    expect(out({ find: 'users', filter: { age: { $gt: 30 } } })).toContain('30')
  })
})

describe('array paths (final review C4)', () => {
  const card = '4111111111111111'
  it('masks numeric and positional segments, arrayFilters, $each and mixed conditions', () => {
    expect(leaks({ find: 'users', filter: { 'items.0.cardNo': card } }, 'users', 'crm', card)).toBe(false)
    for (const path of ['items.$.cardNo', 'items.$[].cardNo'])
      expect(
        leaks({ update: 'users', updates: [{ q: {}, u: { $set: { [path]: card } } }] }, 'users', 'crm', card),
      ).toBe(false)
    expect(
      leaks(
        {
          update: 'users',
          updates: [{ q: {}, u: { $set: { 'items.$[e].x': 1 } }, arrayFilters: [{ 'e.cardNo': card }] }],
        },
        'users',
        'crm',
        card,
      ),
    ).toBe(false)
    expect(
      leaks({
        update: 'users',
        updates: [{ q: {}, u: { $push: { contacts: { $each: [{ email: SECRET }] } } } }],
      }),
    ).toBe(false)
    expect(
      leaks({ find: 'users', filter: { address: { $exists: true, zip: '34000' } } }, 'users', 'crm', '34000'),
    ).toBe(false)
    expect(
      leaks(
        { find: 'users', filter: { items: { $all: [{ $elemMatch: { cardNo: card } }] } } },
        'users',
        'crm',
        card,
      ),
    ).toBe(false)
  })
})

describe('variables and options (final review C5)', () => {
  it('masks let, update constants, index bounds and projection conditions', () => {
    expect(leaks({ find: 'users', filter: { $expr: { $eq: ['$email', '$$t'] } }, let: { t: SECRET } })).toBe(
      false,
    )
    expect(leaks({ q: { $expr: { $eq: ['$email', '$$t'] } }, u: { $set: { n: 1 } }, c: { t: SECRET } })).toBe(
      false,
    )
    expect(leaks({ find: 'users', filter: {}, min: { email: SECRET }, max: { email: SECRET } })).toBe(false)
    expect(
      leaks(
        { find: 'users', filter: {}, projection: { items: { $elemMatch: { cardNo: '4111' } } } },
        'users',
        'crm',
        '4111',
      ),
    ).toBe(false)
    expect(
      leaks(
        {
          aggregate: 'orders',
          pipeline: [{ $lookup: { from: 'users', let: { v: SECRET }, pipeline: [], as: 'u' } }],
        },
        'orders',
      ),
    ).toBe(false)
  })
})

describe('joins (final review C6)', () => {
  it('masks later stages once a collection with rules has been joined', () => {
    expect(
      leaks(
        {
          aggregate: 'orders',
          pipeline: [
            { $lookup: { from: 'users', localField: 'u', foreignField: '_id', as: 'u' } },
            { $match: { 'u.email': SECRET } },
          ],
        },
        'orders',
      ),
    ).toBe(false)
    expect(
      leaks(
        { aggregate: 'orders', pipeline: [{ $unionWith: 'users' }, { $match: { email: SECRET } }] },
        'orders',
      ),
    ).toBe(false)
  })

  it('masks a join whose from is not a plain collection name', () => {
    expect(
      leaks(
        {
          aggregate: 'orders',
          pipeline: [
            {
              $lookup: {
                from: { db: 'crm', coll: 'users' },
                pipeline: [{ $match: { email: SECRET } }],
                as: 'u',
              },
            },
          ],
        },
        'orders',
      ),
    ).toBe(false)
  })
})

describe('over-masking (final review M5)', () => {
  it('keeps canonical inclusions in a projection and the key of distinct', () => {
    expect(out({ aggregate: 'users', pipeline: [{ $project: { email: { $numberInt: '1' } } }] })).toContain(
      '{"$project":{"email":{"$numberInt":"1"}}}',
    )
    expect(redactSecrets({ distinct: 'users', key: 'email', query: {} })).toEqual({
      distinct: 'users',
      key: 'email',
      query: {},
    })
  })
})

describe('generated command shapes never carry a personal value (final review C3, I4)', () => {
  const S = 'S3NT1N3L'
  const value = fc.constantFrom<unknown>(S, [S], { $numberLong: '0' }, [1, S])
  // A condition on a personal path, in the forms a filter can take.
  const condition = fc.oneof(
    value.map((v) => ({ email: v })),
    value.map((v) => ({ email: { $in: Array.isArray(v) ? v : [v, 'x'] } })),
    value.map((v) => ({ email: { $ne: v } })),
    value.map((v) => ({ address: { zip: v } })),
    value.map((v) => ({ 'address.zip': { $eq: v } })),
    value.map((v) => ({ items: { $elemMatch: { cardNo: v } } })),
    value.map((v) => ({ 'items.3.cardNo': v })),
    value.map((v) => ({ contacts: { $all: [{ $elemMatch: { email: v } }] } })),
    value.map((v) => ({ $expr: { $eq: [{ $toUpper: '$email' }, v] } })),
    value.map((v) => ({ $expr: { $in: ['$ssn', [v]] } })),
  )
  const filter = fc.letrec<{ f: object }>((tie) => ({
    f: fc.oneof(
      { depthSize: 'small' },
      condition,
      fc.array(tie('f'), { minLength: 1, maxLength: 3 }).map((fs) => ({ $and: fs })),
      fc.array(tie('f'), { minLength: 1, maxLength: 3 }).map((fs) => ({ $or: fs })),
      tie('f').map((f) => ({ $nor: [f] })),
    ),
  })).f
  const command = fc.oneof(
    filter.map((f) => ({ find: 'users', filter: f })),
    filter.map((f) => ({ count: 'users', query: f })),
    filter.map((f) => ({ q: f, u: { $set: { n: 1 } } })),
    filter.map((f) => ({ q: f, limit: 0 })),
    filter.map((f) => ({ update: 'users', updates: [{ q: f, u: { $inc: { n: 1 } } }] })),
    filter.map((f) => ({ delete: 'users', deletes: [{ q: f, limit: 1 }] })),
    filter.map((f) => ({ findAndModify: 'users', query: f, update: { $set: { n: 1 } } })),
    filter.map((f) => ({ aggregate: 'users', pipeline: [{ $match: f }, { $limit: 1 }] })),
    filter.map((f) => ({
      aggregate: 'orders',
      pipeline: [{ $lookup: { from: 'users', pipeline: [{ $match: f }], as: 'u' } }],
    })),
    filter.map((f) => ({ explain: { find: 'users', filter: f } })),
  )

  it('holds for random filters inside every command shape', () => {
    fc.assert(
      fc.property(command, (cmd) => {
        const coll = 'aggregate' in cmd && cmd.aggregate === 'orders' ? 'orders' : 'users'
        expect(out(cmd, coll)).not.toContain(S)
      }),
      { numRuns: 500 },
    )
  })
})
