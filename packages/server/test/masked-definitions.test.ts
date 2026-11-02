import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EJSON } from 'bson'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { waitJob } from './support/jobs'
import { slow } from './support/slowness'

/**
 * Security audit 2026-10-16 (Important 3): a masked or anonymous copy leaves out every definition
 * that holds a value masking would change — a validator, an index's partial filter, a view's
 * pipeline — as a masked backup does (dump-plan), and says so in its plan. Values carry a sentinel.
 */
const S = 'D3F1N1T10N'
let a: TestMongo
let b: TestMongo
let ca: MongoClient
let cb: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ;[ca, cb] = await Promise.all([
    new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect(),
    new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect(),
  ])
}, slow(180_000))
afterAll(async () => {
  await Promise.all([ca?.close(), cb?.close()])
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  await Promise.all([ca.db('defs').dropDatabase(), cb.db('copydefs').dropDatabase()])
  const db = ca.db('defs')
  await db.createCollection('people', {
    validator: { $or: [{ email: { $ne: `${S}-validator` } }, { name: { $exists: true } }] },
  })
  await db
    .collection('people')
    .insertMany(Array.from({ length: 5 }, (_, i) => ({ _id: i as never, name: `n${i}`, email: `e${i}@x` })))
  await db
    .collection('people')
    .createIndex({ name: 1 }, { name: 'vip_name', partialFilterExpression: { email: `${S}-partial` } })
  await db.collection('people').createIndex({ name: -1 }, { name: 'plain' })
  await db.createCollection('vip', { viewOn: 'people', pipeline: [{ $match: { email: `${S}-view` } }] })
  // A view over a collection without personal fields: nothing in it would be masked.
  await db.collection('items').insertOne({ kind: 'x' })
  await db.createCollection('names', { viewOn: 'items', pipeline: [{ $match: { kind: 'x' } }] })
})

type H = Awaited<ReturnType<typeof transferHarness>>
type U = ReturnType<H['user']>
const RULES = [{ db: 'defs', coll: 'people', field: 'email' }]

async function copyDatabase(h: H, u: U, extra: object = {}) {
  const base = `/api/connections/${h.ids.A}/databases/defs/copy`
  const body = {
    target: { connectionId: h.ids.B, db: 'copydefs' },
    mode: 'insert',
    confirmPersonal: true,
    ...extra,
  }
  const planned = await u.call('POST', `${base}/plan`, body)
  expect(planned.statusCode, planned.body).toBe(200)
  const plan = planned.json()
  const res = await u.call('POST', base, { ...body, planHash: plan.planHash })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  expect(job.state, job.error ?? '').toBe('done')
  return plan
}

/** Everything the target database defines: options, views and indexes. */
async function definitions(): Promise<string> {
  const db = cb.db('copydefs')
  const infos = await db.listCollections({}, { nameOnly: false }).toArray()
  let out = EJSON.stringify(infos, { relaxed: false })
  for (const i of infos)
    if (i.type === 'collection')
      out += EJSON.stringify(await db.collection(i.name).indexes(), { relaxed: false })
  return out
}

describe('security audit 2026-10-16: masked copies leave out definitions holding masked values', () => {
  for (const who of ['restricted', 'anonymous'] as const)
    it(`a ${who} copy creates no validator, partial index or view that names a hidden value`, async () => {
      const h = await transferHarness(a, b)
      try {
        h.rules('A', RULES)
        const u =
          who === 'restricted' ? h.user({ masked: ['A'], on: { B: 'admin' } }) : h.user({ role: 'admin' })
        const plan = await copyDatabase(h, u, who === 'anonymous' ? { anonymous: true } : {})
        const people = plan.collections.find((c: { source: string }) => c.source === 'people')
        expect(people).toMatchObject({ validatorLeftOut: true, indexesLeftOut: ['vip_name'] })
        expect(plan.views).toEqual(['names'])
        expect(plan.viewsLeftOut).toEqual(['vip'])
        const defined = await definitions()
        expect(defined).not.toContain(S)
        const names = (await cb.db('copydefs').listCollections().toArray())
          .map((i) => i.name)
          .filter((n) => !n.startsWith('system.'))
          .sort()
        expect(names).toEqual(['items', 'names', 'people'])
        const indexes = (await cb.db('copydefs').collection('people').indexes()).map((i) => i.name)
        expect(indexes).toContain('plain')
        expect(indexes).not.toContain('vip_name')
        expect(await cb.db('copydefs').collection('people').countDocuments()).toBe(5)
      } finally {
        await h.t.close()
      }
    }, 90_000)

  it('an unmasked copy keeps every definition as it is', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', RULES)
      const plan = await copyDatabase(h, h.user({ role: 'admin' }))
      expect(plan.viewsLeftOut ?? []).toEqual([])
      expect(plan.collections.find((c: { source: string }) => c.source === 'people').validatorLeftOut).toBe(
        undefined,
      )
      const defined = await definitions()
      expect(defined).toContain(`${S}-validator`)
      expect(defined).toContain(`${S}-partial`)
      expect(defined).toContain(`${S}-view`)
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
