// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { createHash } from 'node:crypto'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { slow } from './support/slowness'

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
  await ca
    .db('shop')
    .collection('orders')
    .insertMany([{ email: 'a@x' }, { email: 'b@x' }])
})

type H = Awaited<ReturnType<typeof backupHarness>>
async function backup(h: H, u: ReturnType<H['user']>, extra: object = {}) {
  const body = { scope: { kind: 'database', db: 'shop' }, format: 'gzip', ...extra }
  const { password: _pw, ...planBody } = body as { password?: string }
  const base = `/api/connections/${h.ids.A}/backup`
  const plan = (await u.call('POST', `${base}/plan`, planBody)).json()
  const res = await u.call('POST', base, { ...body, planHash: plan.planHash })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  expect(job.state).toBe('done')
  return (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId as string
}

describe('kept backups (spec §3.3, §7.3, B9, B12)', () => {
  it("lists, downloads with the recorded SHA-256, and deletes only the owner's backups", async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const other = h.user()
      const id = await backup(h, u)
      const list = (await u.get('/api/backups')).json()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        id,
        connectionId: h.ids.A,
        format: 'gzip',
        masked: false,
        namespaces: 1,
      })
      expect((await u.get(`/api/backups?connectionId=${h.ids.B}`)).json()).toEqual([])
      expect((await other.get('/api/backups')).json()).toEqual([])
      const usage = (await u.get('/api/backups/usage')).json()
      expect(usage.used).toBe(list[0].size)
      expect(usage).toMatchObject({ quota: 20480 * 1024 * 1024, ttlHours: 24 })
      const dl = await u.get(`/api/backups/${id}/download`)
      expect(dl.statusCode).toBe(200)
      expect(dl.headers['content-disposition']).toMatch(
        /attachment; filename="shop-\d{8}-\d{6}\.archive\.gz"/,
      )
      expect(dl.headers['x-content-type-options']).toBe('nosniff')
      expect(createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(list[0].sha256)
      expect((await other.get(`/api/backups/${id}/download`)).statusCode).toBe(404)
      expect((await other.call('DELETE', `/api/backups/${id}`)).statusCode).toBe(404)
      expect((await u.call('DELETE', `/api/backups/${id}`)).statusCode).toBe(204)
      expect((await u.get('/api/backups')).json()).toEqual([])
      const audit = JSON.stringify(
        h.ctx.store.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'backup.%'").all(),
      )
      expect(audit).toContain('backup.download')
      expect(audit).toContain('backup.delete')
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('refuses to delete a backup that is still being written (final review minor 15)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const { row } = h.ctx.backup.store.reserveBackup({
        owner: u.id,
        jobId: 'running-job',
        connectionId: h.ids.A,
        name: 'shop.archive.gz',
        meta: {
          scope: { kind: 'database', db: 'shop', views: true },
          engine: 'builtin',
          format: 'gzip',
          masked: false,
          anonymous: false,
          namespaces: 1,
          startedAt: 1,
          finishedAt: null,
          rulesVersion: 0,
        },
      })
      const res = await u.call('DELETE', `/api/backups/${row.id}`)
      expect(res.statusCode).toBe(409)
      expect(res.json().details.reason).toBe('backup_running')
      expect(h.ctx.backup.store.get(u.id, row.id)).toBeTruthy()
    } finally {
      await h.t.close()
    }
  })

  it('withdraws a masked backup after a rule change, and any backup after lost access or a new restriction', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const u = h.user()
      const anon = await backup(h, u, { anonymous: true })
      const plain = await backup(h, u, { format: 'mmbak', password: 'correct horse battery' })
      h.rules('A', [
        { db: 'shop', coll: 'orders', field: 'email' },
        { db: 'shop', coll: 'orders', field: 'phone' },
      ])
      expect((await u.get(`/api/backups/${anon}/download`)).statusCode).toBe(410)
      expect((await u.get(`/api/backups/${plain}/download`)).statusCode).toBe(200)
      // The list leaves out what can no longer be downloaded.
      expect((await u.get('/api/backups')).json().map((x: { id: string }) => x.id)).toEqual([plain])
      h.ctx.grants.set(h.ids.A, u.id, 'editor')
      h.ctx.grants.setMasked(h.ids.A, u.id, true)
      expect((await u.get(`/api/backups/${plain}/download`)).statusCode).toBe(410)
      h.ctx.grants.setMasked(h.ids.A, u.id, false)
      h.ctx.grants.set(h.ids.A, u.id, 'none')
      expect((await u.get(`/api/backups/${plain}/download`)).statusCode).toBe(410)
    } finally {
      await h.t.close()
    }
  }, 180_000)
})
