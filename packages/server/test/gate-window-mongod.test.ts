import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Document } from 'mongodb'
import { compileRules } from '../src/masking/match'
import { newCtx } from '../src/masking/gate/context'
import { guardStages, sourceShape } from '../src/masking/gate/pipeline'
import { maskDocument } from '../src/masking/document'
import { startMongo, type TestMongo } from './support/mongo'
import { slow } from './support/slowness'

/**
 * W5: the window, fill, densify and redact stages a restricted user may now run, proven on a real
 * server: what the gate lets through, with the output masker applied as the routes apply it,
 * carries no personal value. And the MongoDB behaviour the gate's refusals rest on.
 */
const SENTINEL = 'S3NT1N3L'
const SECRET_PAY = 987_654
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  await client
    .db('w')
    .collection('staff')
    .insertMany([
      {
        _id: 1 as never,
        dept: 'ops',
        hours: 10,
        day: 1,
        salary: SECRET_PAY,
        email: SENTINEL,
        customer: { phone: SENTINEL, city: 'x', tags: [SENTINEL] },
        tags: ['public'],
      },
      { _id: 2 as never, dept: 'ops', hours: null, day: 4, salary: SECRET_PAY + 1, email: SENTINEL },
      {
        _id: 3 as never,
        dept: 'dev',
        hours: 30,
        day: 6,
        salary: SECRET_PAY + 2,
        email: SENTINEL,
        customer: { phone: SENTINEL },
      },
    ])
}, slow(120_000))
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})

const masker = compileRules([
  { db: 'w', coll: 'staff', field: 'email' },
  { db: 'w', coll: 'staff', field: 'salary' },
  { db: 'w', coll: 'staff', field: 'customer.phone' },
  { db: 'w', coll: 'staff', field: 'customer.tags' },
])
const deps = { masker, view: async () => null, indexes: async () => [] }

/** The pipeline as the gate lets a restricted user run it, its results masked as a route masks them. */
async function asRestricted(stages: Document[]): Promise<unknown[]> {
  const gc = newCtx(deps, 'w')
  const shape = await sourceShape('w', 'staff', gc)
  const guarded = await guardStages(stages, shape, gc)
  const out = shape.output()
  const docs = await client.db('w').collection('staff').aggregate(guarded.stages).toArray()
  return docs.map((d) => maskDocument(d, out))
}
const leaks = (docs: unknown[]) => {
  const text = JSON.stringify(docs)
  return text.includes(SENTINEL) || text.includes(String(SECRET_PAY).slice(0, 4))
}

describe('window stages on a real server, for a restricted user (W5)', () => {
  it('window functions over clean and may-hold fields reach no personal value', async () => {
    const docs = await asRestricted([
      {
        $setWindowFields: {
          partitionBy: '$customer',
          sortBy: { customer: 1 },
          output: {
            total: { $sum: '$hours', window: { documents: ['unbounded', 'current'] } },
            seen: { $addToSet: '$customer' },
            prev: { $push: '$customer', window: { documents: [-1, 0] } },
            shifted: { $shift: { output: '$customer', by: -1, default: null } },
            rank: { $rank: {} },
          },
        },
      },
      { $project: { email: 0, salary: 0 } },
    ])
    expect(docs).toHaveLength(3)
    expect(leaks(docs)).toBe(false)
    // The clean results are still computed.
    for (const d of docs) expect(typeof (d as { total: unknown }).total).toBe('number')
  })

  it('fills and densifies clean fields, with no personal value in the result', async () => {
    const filled = await asRestricted([
      { $fill: { sortBy: { day: 1 }, output: { hours: { method: 'linear' } } } },
      { $sort: { day: 1 } },
    ])
    expect(filled.map((d) => (d as { hours: number }).hours)).toEqual([10, 22, 30])
    expect(leaks(filled)).toBe(false)
    const dense = await asRestricted([
      { $project: { day: 1, dept: 1 } },
      { $densify: { field: 'day', range: { step: 1, bounds: 'full' } } },
    ])
    expect(dense).toHaveLength(6)
    expect(leaks(dense)).toBe(false)
  })

  it('MongoDB refuses to densify a field holding a document, so a may-hold field gives no value away', async () => {
    const error = await asRestricted([
      { $densify: { field: 'customer', range: { step: 1, bounds: 'full' } } },
    ]).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).not.toContain(SENTINEL)
  })

  it('$redact over $$ROOT paths reads the top-level document at every level', async () => {
    const docs = await asRestricted([
      { $redact: { $cond: [{ $eq: ['$$ROOT.dept', 'ops'] }, '$$DESCEND', '$$PRUNE'] } },
    ])
    expect(docs.map((d) => (d as { _id: number })._id).sort()).toEqual([1, 2])
    expect(leaks(docs)).toBe(false)
    // Review (minor): $$ROOT kept the nested level (DESCEND there too), its hidden field masked.
    const first = docs.find((d) => (d as { _id: number })._id === 1) as { customer?: Record<string, unknown> }
    expect(first.customer).toMatchObject({ city: 'x', phone: '***' })
  })

  // Review (minor): ranks over a key that may hold personal data cannot tell hidden values apart.
  it('ranks documents whose key holds a hidden field as ties', async () => {
    const docs = (await asRestricted([
      { $setWindowFields: { sortBy: { customer: 1 }, output: { r: { $denseRank: {} } } } },
      { $project: { r: 1 } },
    ])) as Array<{ _id: number; r: number }>
    const rank = (id: number) => docs.find((d) => d._id === id)!.r
    // Documents 1 and 3 hold different customers (and phones): the same rank all the same.
    expect(rank(1)).toBe(rank(3))
    expect(rank(2)).not.toBe(rank(1))
  })

  it('keeps values a window carries over or moves masked: locf, $shift and $first of $$ROOT', async () => {
    const docs = await asRestricted([
      {
        $setWindowFields: {
          sortBy: { day: 1 },
          output: {
            carried: { $locf: '$customer' },
            before: { $shift: { output: '$customer', by: -1, default: null } },
            whole: { $first: '$$ROOT', window: { documents: ['unbounded', 'current'] } },
          },
        },
      },
      { $project: { email: 0, salary: 0 } },
    ])
    expect(docs).toHaveLength(3)
    expect(leaks(docs)).toBe(false)
    const last = docs.find((d) => (d as { _id: number })._id === 3) as {
      whole: { email: unknown; customer: { phone: unknown } }
    }
    expect(last.whole).toMatchObject({ email: '***', customer: { phone: '***' } })
  })

  it('a relative "$field" in $redact reads each nested level: why the gate refuses it where rules apply', async () => {
    // Unguarded, as the gate would never run it: "$tags" at the level customer reads customer.tags.
    const probe = await client
      .db('w')
      .collection('staff')
      .aggregate([
        { $match: { _id: 1 } },
        {
          $redact: {
            $cond: [{ $in: [SENTINEL, { $ifNull: ['$tags', []] }] }, '$$PRUNE', '$$DESCEND'],
          },
        },
      ])
      .toArray()
    // customer was pruned because its own (masked) tags held the sentinel: an oracle on a masked value.
    expect(probe[0]).not.toHaveProperty('customer')
    expect(probe[0]).toHaveProperty('dept', 'ops')
    await expect(
      asRestricted([
        { $redact: { $cond: [{ $in: [SENTINEL, { $ifNull: ['$tags', []] }] }, '$$PRUNE', '$$DESCEND'] } },
      ]),
    ).rejects.toThrow(/not available while personal data is hidden/)
  })
})
