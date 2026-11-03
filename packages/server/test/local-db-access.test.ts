import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * Security review 2026-10-13 (M1): a viewer who is not the connection's admin read local.oplog.rs
 * (filtered on admin.system.users: the password hashes) through the data routes. The local database
 * is its admins' only, as through the shell.
 */
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('the local database through the data routes', () => {
  it('refuses a non-admin, and lets the connection admin in', async () => {
    const r = await restrictedApp(mongo, [])
    apps.push(r.t)
    const viewer = r.as('viewer')
    const editor = r.as('editor')
    for (const call of [viewer, editor]) {
      const find = await call('POST', '/databases/local/collections/oplog.rs/find', {
        filter: { ns: 'admin.system.users' },
        limit: 5,
      })
      expect(find.statusCode).toBe(403)
      const agg = await call('POST', '/databases/local/collections/startup_log/aggregate/run', {
        stages: [{ $match: {} }],
        limit: 5,
      })
      expect(agg.statusCode).toBe(403)
    }
    const admin = r.as('admin')
    const ok = await admin('POST', '/databases/local/collections/startup_log/find', { filter: {}, limit: 1 })
    expect(ok.statusCode).toBe(200)
  })
})
