import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { slow } from './support/slowness'

/**
 * CI fixes, sixth to eighth reviews: namespace metadata past what the app's reader takes in all is
 * refused in the plan whichever engine would write the archive — the app reads mongodump's back too
 * (restore, inspect, drill). The limit stands in small here.
 */
vi.mock('../src/backup/limits', async (original) => ({
  ...(await original<typeof import('../src/backup/limits')>()),
  MAX_METADATA_BYTES: 1_100,
}))

let a: TestMongo
let b: TestMongo
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  const c = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await c.db('shop').dropDatabase()
  for (const name of ['orders', 'users']) await c.db('shop').collection(name).insertOne({ a: 1 })
  await c.close()
}, slow(180_000))
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop()])
})

describe('namespace metadata past the reader', () => {
  it('is refused for the built-in engine and for mongodump', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      for (const engine of ['builtin', 'tools']) {
        const plan = (
          await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, {
            scope: { kind: 'database', db: 'shop' },
            format: 'gzip',
            engine,
          })
        ).json()
        expect(plan.refusals, engine).toContain('metadata_too_large')
      }
    } finally {
      await h.t.close()
    }
  })
})
