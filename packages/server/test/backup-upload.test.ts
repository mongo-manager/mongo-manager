import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { fixture } from './support/mongo-tools'
import { slow } from './support/slowness'

let a: TestMongo
let b: TestMongo
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
}, slow(180_000))
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop()])
})

describe('resumable uploads and inspection (plan rulings 2, 4, 5; U4; B9; B13)', () => {
  it('resumes an interrupted upload and inspects while it grows (Review Focus 3)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const file = fixture('shop.archive')
      const created = await u.call('POST', '/api/backups/uploads', {
        name: 'shop.archive',
        size: file.length,
      })
      expect(created.statusCode, created.body).toBe(201)
      const id = created.json().uploadId
      const inspect = () =>
        u.call('POST', '/api/backups/inspect', { source: { kind: 'upload', uploadId: id } })
      expect((await inspect()).json()).toMatchObject({ state: 'waiting', received: 0, size: file.length })
      let end = 4
      while (file.readInt32LE(end) !== -1) end += file.readInt32LE(end)
      end += 4
      expect(
        (await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file.subarray(0, end))).json(),
      ).toEqual({
        received: end,
        complete: false,
      })
      // The client lost its place: the server says where to resume.
      const wrong = await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file.subarray(0, 10))
      expect(wrong.statusCode).toBe(409)
      expect(wrong.json().details).toMatchObject({ reason: 'upload_offset', received: end })
      expect((await u.get(`/api/backups/uploads/${id}`)).json()).toMatchObject({
        received: end,
        size: file.length,
        complete: false,
      })
      expect((await inspect()).json()).toMatchObject({ state: 'ready' })
      expect(
        (await u.raw('PUT', `/api/backups/uploads/${id}?offset=${end}`, file.subarray(end))).json(),
      ).toEqual({ received: file.length, complete: true })
      const ready = (await inspect()).json()
      expect(ready.summary.namespaces.map((n: { coll: string }) => n.coll).sort()).toEqual([
        'capped',
        'empty',
        'orders',
        'ts',
        'v',
      ])
      expect((await u.call('DELETE', `/api/backups/uploads/${id}`)).statusCode).toBe(204)
      expect((await u.get(`/api/backups/uploads/${id}`)).statusCode).toBe(404)
    } finally {
      await h.t.close()
    }
  })

  it('audits what an inspection found, not each poll while it waits (final review minor 6)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const file = fixture('shop.archive')
      const id = (await u.call('POST', '/api/backups/uploads', { name: 'x', size: file.length })).json()
        .uploadId
      const inspect = () =>
        u.call('POST', '/api/backups/inspect', { source: { kind: 'upload', uploadId: id } })
      const rows = () =>
        h.ctx.store.db
          .prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'backup.inspect'")
          .get() as {
          n: number
        }
      for (let i = 0; i < 3; i++) expect((await inspect()).json().state).toBe('waiting')
      expect(rows().n).toBe(0)
      await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
      expect((await inspect()).json().state).toBe('ready')
      expect(rows().n).toBe(1)
    } finally {
      await h.t.close()
    }
  })

  it('takes many parts in a minute (a resumable upload is not throttled like 3d-1 uploads)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const id = (await u.call('POST', '/api/backups/uploads', { name: 'x', size: 30 })).json().uploadId
      for (let i = 0; i < 30; i++) {
        const r = await u.raw('PUT', `/api/backups/uploads/${id}?offset=${i}`, Buffer.from([i]))
        expect(r.statusCode, r.body).toBe(200)
      }
    } finally {
      await h.t.close()
    }
  })

  it('keeps uploads to their owner and to users who can restore somewhere (B9, ruling 4)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const id = (await u.call('POST', '/api/backups/uploads', { name: 'x', size: 10 })).json().uploadId
      const other = h.user()
      expect(
        (await other.raw('PUT', `/api/backups/uploads/${id}?offset=0`, Buffer.alloc(10))).statusCode,
      ).toBe(404)
      expect(
        (await other.call('POST', '/api/backups/inspect', { source: { kind: 'upload', uploadId: id } }))
          .statusCode,
      ).toBe(404)
      const viewer = h.user({ role: 'viewer' })
      expect((await viewer.call('POST', '/api/backups/uploads', { name: 'x', size: 10 })).statusCode).toBe(
        403,
      )
      expect(
        (await u.call('POST', '/api/backups/uploads', { name: 'x', size: 10 * 1024 ** 4 })).statusCode,
      ).toBe(400)
    } finally {
      await h.t.close()
    }
  })

  it('throttles wrong passwords and never records them (B13)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shop').collection('t').insertOne({ a: 1 })
      await ca.close()
      const body = { scope: { kind: 'collection', db: 'shop', coll: 't' }, format: 'mmbak' }
      const plan = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const start = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: plan.planHash,
        password: 'correct horse battery',
      })
      const job = await waitJob(h.t, start.json().job.id, 60_000)
      const backupId = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId
      const inspect = (password?: string) =>
        u.call('POST', '/api/backups/inspect', {
          source: { kind: 'backup', backupId },
          ...(password ? { password } : {}),
        })
      expect((await inspect()).json()).toEqual({ state: 'password' })
      expect((await inspect('correct horse battery')).json()).toMatchObject({ state: 'ready' })
      for (let i = 0; i < 10; i++) expect((await inspect(`wrong-${i}`)).statusCode).toBe(400)
      expect((await inspect('correct horse battery')).statusCode).toBe(429)
      const rows = JSON.stringify(h.ctx.store.db.prepare('SELECT * FROM audit_log').all())
      expect(rows).not.toMatch(/wrong-\d|correct horse battery/)
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
