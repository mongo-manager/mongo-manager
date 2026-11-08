// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Db, MongoClient, type Document } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { slow } from './support/slowness'

/**
 * Review of the CI fixes (minor 4): where a time series keeps its buckets depends on the server's
 * version (series.ts). A server that does not say its version is never guessed at: the backup leaves
 * the series out and says why, a restore or a drill of one stops before writing it.
 */
let a: TestMongo
let b: TestMongo
let ca: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  await ca.db('shop').dropDatabase()
  await ca.db('shop').createCollection('ts', { timeseries: { timeField: 't' } })
  await ca
    .db('shop')
    .collection('ts')
    .insertMany([{ t: new Date(0) }, { t: new Date(1) }])
  await ca.db('shop').collection('plain').insertOne({ a: 1 })
})
afterEach(() => vi.restoreAllMocks())

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
const body = { scope: { kind: 'database', db: 'shop' }, format: 'gzip' }
async function backup(h: H, u: U) {
  const base = `/api/connections/${h.ids.A}/backup`
  const plan = (await u.call('POST', `${base}/plan`, body)).json()
  const res = await u.call('POST', base, { ...body, planHash: plan.planHash })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  return { plan, job, report: (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() }
}
/** Every server answers buildInfo without a version mongo-tools could read. */
const noVersion = () => {
  const command = Db.prototype.command
  vi.spyOn(Db.prototype, 'command').mockImplementation(function (this: Db, cmd: Document, opts?: never) {
    // A version the connection takes (6.0 and later) that mongo-tools cannot read.
    if (cmd.buildInfo) return Promise.resolve({ ok: 1, version: '8.3' })
    return command.call(this, cmd, opts)
  } as never)
}

describe('a time series where the server does not say its version', () => {
  it('is left out of a backup, which says why, and the rest is backed up', async () => {
    const h = await backupHarness(a, b)
    try {
      noVersion()
      const u = h.user({ role: 'admin' })
      const { plan, job } = await backup(h, u)
      expect(job.state, job.error ?? '').toBe('done')
      const ts = plan.namespaces.find((n: { coll: string }) => n.coll === 'ts')
      expect(ts.skipped).toMatch(/does not say its version/)
      // Said as that, never as a series with personal fields (second review, minor 3).
      const keys = plan.checks.map((c: { key: string }) => c.key)
      expect(keys).toContain('timeseries_version')
      expect(keys).not.toContain('timeseries')
      expect(plan.checks.find((c: { key: string }) => c.key === 'timeseries_version').params).toEqual({
        names: 'shop.ts',
      })
      expect(plan.namespaces.find((n: { coll: string }) => n.coll === 'plain').skipped).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('refuses a restore in its plan, and stops a drill before either writes it', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const { report } = await backup(h, u)
      noVersion()
      const restoreBody = {
        source: { kind: 'backup', backupId: report.backupId },
        mapping: [{ from: { db: 'shop', coll: 'ts' }, to: { db: 'shop2', coll: 'ts' } }],
      }
      const base = `/api/connections/${h.ids.B}/restore`
      const plan = await u.call('POST', `${base}/plan`, restoreBody)
      expect(plan.statusCode, plan.body).toBe(200)
      // Second review (minor 7): in the plan, not first in the job.
      expect(plan.json().refusals).toContain('series_version')
      const res = await u.call('POST', base, { ...restoreBody, planHash: plan.json().planHash })
      expect(res.statusCode).not.toBe(202)
      const drill = h.ctx.jobs.start(
        h.ctx.jobKinds['backup.drill'],
        { userId: u.id, connectionId: h.ids.A, db: 'shop', coll: '*', target: 'drill backup' },
        { owner: u.id, backupId: report.backupId, schedule: null },
      )
      const drilled = await waitJob(h.t, drill.id, 60_000)
      expect(drilled.state).toBe('failed')
      expect(drilled.error).toMatch(/does not say its version/)
      // Nothing was written (second review, minor 8b): no target, and no scratch database left.
      const cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
      try {
        expect(await cb.db('shop2').listCollections().toArray()).toEqual([])
      } finally {
        await cb.close()
      }
      const dbs = (await ca.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(
        (d) => d.name,
      )
      expect(dbs.filter((n) => n.startsWith('mm_drill_'))).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 180_000)
})
