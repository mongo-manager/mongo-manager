import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { waitJob } from './support/jobs'
import { runVersion, versionAtLeast } from './support/run-version'
import { slow } from './support/slowness'

/**
 * Review of db45c424: a copy creates the target's collections and indexes from allowlists, by the
 * target's feature level as a restore does. Into MongoDB 6.0, a series with its own bucketing
 * cannot be made as it was, so it is skipped, saying why; an index of a later version (8.3 on build
 * 2dsphere 4) is built at the target's own.
 */
const run = runVersion()
const atLeast = versionAtLeast
let a: TestMongo
let six: TestMongo
let ca: MongoClient
let c6: MongoClient
beforeAll(async () => {
  ;[a, six] = await Promise.all([startMongo(), startMongo({ version: '6.0.29' })])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  c6 = await new MongoClient(`mongodb://127.0.0.1:${six.port}`).connect()
  await ca.db('shop').dropDatabase()
  await ca.db('shop').createCollection('geo')
  await ca.db('shop').collection('geo').createIndex({ loc: '2dsphere' })
  await ca
    .db('shop')
    .collection('geo')
    .insertOne({ loc: { type: 'Point', coordinates: [29, 41] } })
  if (atLeast(run, 6, 3)) {
    await ca.db('shop').createCollection('own', {
      timeseries: { timeField: 't', bucketMaxSpanSeconds: 600, bucketRoundingSeconds: 600 },
    })
    await ca
      .db('shop')
      .collection('own')
      .insertOne({ t: new Date(0) })
  }
}, slow(180_000))
afterAll(async () => {
  await Promise.all([ca?.close(), c6?.close()])
  await Promise.all([a?.stop(), six?.stop()])
})

describe('a copy into an older feature level', () => {
  it.runIf(atLeast(run, 6, 3))(
    'skips, saying why, a series whose own bucketing the target cannot have',
    async () => {
      const h = await transferHarness(a, six)
      try {
        const u = h.user()
        const body = {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'own' },
          mode: 'insert',
        }
        const plan = await u.call(
          'POST',
          `/api/connections/${h.ids.A}/databases/shop/collections/own/copy/plan`,
          body,
        )
        expect(JSON.stringify(plan.json())).toContain(
          'Its own bucketing (bucketRoundingSeconds) needs MongoDB 6.3 or later on the target',
        )
      } finally {
        await h.t.close()
      }
    },
  )

  it('builds a 2dsphere index at the target’s own version', async () => {
    const h = await transferHarness(a, six)
    try {
      await c6.db('copy').dropDatabase()
      const u = h.user()
      const base = `/api/connections/${h.ids.A}/databases/shop/collections/geo/copy`
      const body = {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'geo' },
        mode: 'insert',
      }
      const plan = await u.call('POST', `${base}/plan`, body)
      expect(plan.statusCode, plan.body).toBe(200)
      const res = await u.call('POST', base, { ...body, planHash: plan.json().planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state, job.error ?? '').toBe('done')
      const built = (await c6.db('copy').collection('geo').indexes()).find((i) => i.name === 'loc_2dsphere')
      expect(built?.['2dsphereIndexVersion']).toBe(3)
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
