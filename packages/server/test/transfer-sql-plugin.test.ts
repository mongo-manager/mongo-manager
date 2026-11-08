// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { runSqlPlugin } from './support/sql-plugin'
import { slow } from './support/slowness'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})

const refused = { reason: 'sql_plugin_off' }

// User request 2026-11-02: SQL import and export come with the SQL → MongoDB plugin; while it does
// not run, its pages are not offered and the server refuses their routes too.
describe('SQL import and export follow the SQL → MongoDB plugin', () => {
  it('are refused while the plugin does not run, and offered once it does', async () => {
    const h = await dataHarness(mongo)
    const calls = [
      () => h.call('POST', `/databases/shop/import-sql`, { uploadId: 'x' }),
      () => h.call('POST', `/databases/shop/export-sql`, {}),
      () => h.call('POST', `/transfer/uploads/x/sql-preview`, {}),
    ]
    for (const call of calls) {
      const res = await call()
      expect(res.statusCode, res.payload).toBe(403)
      expect(res.json().details).toMatchObject(refused)
    }
    runSqlPlugin(h.t.app)
    for (const call of calls) {
      const res = await call()
      expect(res.json().details?.reason, res.payload).not.toBe(refused.reason)
    }
  })

  // Review of 1.0.1 (I1): a collection's own export takes the format too — SQL there is the plugin's.
  it('refuses a collection exported as SQL, never another format', async () => {
    const h = await dataHarness(mongo)
    const exportAs = (format: string) =>
      h.call('POST', `/databases/shop/collections/orders/export`, { source: { kind: 'collection' }, format })
    const sql = await exportAs('sql')
    expect(sql.statusCode, sql.payload).toBe(403)
    expect(sql.json().details).toMatchObject(refused)
    const json = await exportAs('json')
    expect(json.statusCode, json.payload).toBe(202)
    runSqlPlugin(h.t.app)
    expect((await exportAs('sql')).statusCode).toBe(202)
  })

  // Review of 1.0.1 (M2): a row turned off, or one whose files changed since it was approved.
  it.each([
    ['turned off', { enabled: false }],
    ['changed since approved', { approvedDigest: 'b'.repeat(64) }],
  ])('refuses them while the plugin is %s', async (_, over) => {
    const h = await dataHarness(mongo)
    runSqlPlugin(h.t.app, over)
    const res = await h.call('POST', `/databases/shop/export-sql`, {})
    expect(res.statusCode, res.payload).toBe(403)
    expect(res.json().details).toMatchObject(refused)
  })
})
