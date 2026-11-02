import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { rawSeries } from '../src/backup/series'
import { slow } from './support/slowness'

/**
 * Second review of the CI fixes (minor 8a): mongorestore must read the archive's layout as well as
 * write the target's, so the newer of the two versions sets how new it must be: tools 100.15 are too
 * old for an 8.3 archive into an 8.0 target, and for an 8.0 archive into an 8.3 target, and enough
 * where both are older. The tools are said to be 100.15; nothing runs them.
 */
vi.mock('../src/backup/tools', async (original) => ({
  ...(await original<typeof import('../src/backup/tools')>()),
  findTools: async () => ({ dump: '/tools/mongodump', restore: '/tools/mongorestore', version: '100.15.0' }),
}))

describe.runIf(rawSeries(process.env.MONGOMS_VERSION))('how new mongorestore must be for a restore', () => {
  let fresh: TestMongo
  let old: TestMongo
  let older: TestMongo
  let cf: MongoClient
  let co: MongoClient
  beforeAll(async () => {
    ;[fresh, old, older] = await Promise.all([
      startMongo(),
      startMongo({ version: '8.0.32' }),
      startMongo({ version: '8.0.32' }),
    ])
    cf = await new MongoClient(`mongodb://127.0.0.1:${fresh.port}`).connect()
    co = await new MongoClient(`mongodb://127.0.0.1:${old.port}`).connect()
  }, slow(180_000))
  afterAll(async () => {
    await Promise.all([cf?.close(), co?.close()])
    await Promise.all([fresh?.stop(), old?.stop(), older?.stop()])
  })
  beforeEach(async () => {
    for (const c of [cf, co]) {
      await c.db('shop').dropDatabase()
      await c.db('shop').collection('orders').insertOne({ a: 1 })
    }
  })

  /** The reason the tools engine is refused for a backup of `from` restored into `to`, or null. */
  async function reason(from: TestMongo, to: TestMongo): Promise<string | null> {
    const h = await backupHarness(from, to)
    try {
      const u = h.user({ role: 'admin' })
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'gzip' }
      const base = `/api/connections/${h.ids.A}/backup`
      const plan = (await u.call('POST', `${base}/plan`, body)).json()
      const res = await u.call('POST', base, { ...body, planHash: plan.planHash })
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state, job.error ?? '').toBe('done')
      const backupId = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId
      const restore = (
        await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
          source: { kind: 'backup', backupId },
          engine: 'tools',
          mapping: [{ from: { db: 'shop', coll: 'orders' }, to: { db: 'shop2', coll: 'orders' } }],
        })
      ).json()
      const tools = restore.checks.find((c: { key: string }) => c.key === 'tools')
      return tools?.level === 'block' ? String(tools.params.reason) : null
    } finally {
      await h.t.close()
    }
  }

  it('is set by the archive or the target, whichever is 8.3 or later', async () => {
    expect(await reason(fresh, old)).toBe('old')
    expect(await reason(old, fresh)).toBe('old')
    expect(await reason(old, older)).not.toBe('old')
  }, 240_000)
})
