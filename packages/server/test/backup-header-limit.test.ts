// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { slow } from './support/slowness'

/**
 * Fourth review of the CI fixes (minor 5): a backup whose Mongo Manager header its own reader would
 * refuse (past its limits on masked paths or rules) is refused in its plan, never written to be
 * unreadable. The limits stand in here: the header schema refuses every header.
 */
vi.mock('@mongo-manager/shared', async (original) => {
  const real = await original<typeof import('@mongo-manager/shared')>()
  return {
    ...real,
    MongoManagerHeaderSchema: { ...real.MongoManagerHeaderSchema, safeParse: () => ({ success: false }) },
  }
})

let a: TestMongo
let b: TestMongo
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  const c = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await c.db('shop').dropDatabase()
  await c.db('shop').collection('orders').insertOne({ a: 1 })
  await c.close()
}, slow(180_000))
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop()])
})

describe('a backup header its reader would refuse', () => {
  it('refuses the backup in its plan', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const plan = (
        await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, {
          scope: { kind: 'database', db: 'shop' },
          format: 'gzip',
        })
      ).json()
      expect(plan.refusals).toContain('header_too_large')
      // Fifth review (nit 7): mongodump writes no Mongo Manager header.
      const tools = (
        await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, {
          scope: { kind: 'database', db: 'shop' },
          format: 'gzip',
          engine: 'tools',
        })
      ).json()
      expect(tools.refusals).not.toContain('header_too_large')
    } finally {
      await h.t.close()
    }
  })
})
