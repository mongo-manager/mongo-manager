import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { slow } from './support/slowness'

/**
 * Review of the CI fixes (minor 4): a time series whose buckets read as none while it holds
 * measurements was read in the wrong place (a server that keeps them elsewhere than its version
 * says, as a viewless 8.3 does with system.buckets): the backup stops, never keeps it empty.
 * The wrong place is a collection that does not exist: MongoDB 9.0 refuses any read of a
 * system.buckets namespace, where the others read an absent one as empty.
 */
vi.mock('../src/backup/series', async (original) => ({
  ...(await original<typeof import('../src/backup/series')>()),
  seriesAccess: () => ({ coll: 'nowhere', options: {} }),
}))

let a: TestMongo
let b: TestMongo
let ca: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await ca.db('shop').dropDatabase()
  await ca.db('shop').createCollection('ts', { timeseries: { timeField: 't' } })
  await ca
    .db('shop')
    .collection('ts')
    .insertMany([{ t: new Date(0) }, { t: new Date(1) }])
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop()])
})

describe('a time series whose buckets read as none', () => {
  it('stops the backup instead of keeping it empty', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'gzip' }
      const base = `/api/connections/${h.ids.A}/backup`
      const plan = (await u.call('POST', `${base}/plan`, body)).json()
      const res = await u.call('POST', base, { ...body, planHash: plan.planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/shop\.ts read as empty though it holds data/)
      // Nothing is kept of it.
      expect(h.ctx.backup.store.list(u.id, {})).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
