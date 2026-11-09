// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { buildManifest, remoteKeyFor } from '../src/backup/destinations/layout'
import { startFakeS3, type FakeS3 } from './support/fake-s3'
import { slow } from './support/slowness'

let a: TestMongo
let b: TestMongo
let s3: FakeS3
let ca: MongoClient
let base: string
const root = () => join(base, 'root')
beforeAll(async () => {
  ;[a, b, s3] = await Promise.all([startMongo(), startMongo(), startFakeS3()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  base = mkdtempSync(join(tmpdir(), 'mm-fetch-'))
  mkdirSync(root())
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop(), s3?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})
beforeEach(async () => {
  await ca.db('shop').dropDatabase()
  await ca
    .db('shop')
    .collection('orders')
    .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }])
})

type H = Awaited<ReturnType<typeof backupHarness>>
const harness = () =>
  backupHarness(a, b, { backup: { folderRoots: [root()], privateNetworks: ['127.0.0.1/32'] } } as never)
async function sentCopy(h: H, u: ReturnType<H['user']>, dest: string) {
  const body = { scope: { kind: 'database', db: 'shop' }, format: 'gzip', destinations: [dest] }
  const plan = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
  const res = await u.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: plan.planHash })
  expect(res.statusCode, res.body).toBe(202)
  await waitJob(h.t, res.json().job.id, 60_000)
  const report = (await u.get(`/api/transfer/jobs/${res.json().job.id}/report`)).json()
  expect((await waitJob(h.t, report.sendJobId, 60_000)).state).toBe('done')
  return h.ctx.backup.copies.byBackup(report.backupId)[0]!
}
const folderDest = async (admin: ReturnType<H['user']>, name: string) =>
  (
    await admin.call('POST', '/api/backup-destinations', {
      type: 'folder',
      name,
      config: { path: join(root(), name) },
      policy: { encryptedOnly: false },
    })
  ).json().id as string

describe('restoring from destinations (phase 3d-3b spec §1.2 step 4, §4.2, D7, D8, D12, D14)', () => {
  it('lists, fetches with verification, and restores a copy', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folderDest(admin, 'f1')
      const copy = await sentCopy(h, admin, dest)
      const page = (await admin.get(`/api/backup-destinations/${dest}/backups`)).json()
      expect(page.items).toEqual([
        expect.objectContaining({
          key: copy.remoteKey,
          state: 'complete',
          format: 'gzip',
          mine: true,
          copyId: copy.id,
          scope: { kind: 'database', db: 'shop', views: true },
        }),
      ])
      const fetched = await admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
        connectionId: h.ids.B,
        key: copy.remoteKey,
      })
      expect(fetched.statusCode, fetched.body).toBe(202)
      const { uploadId, job } = fetched.json()
      expect((await waitJob(h.t, job.id, 60_000)).state).toBe('done')
      expect(h.ctx.backup.store.byId(uploadId)).toMatchObject({
        complete: true,
        sha256: copy.sha256,
        awaitingVerify: false,
      })
      const mapping = [{ from: { db: 'shop', coll: 'orders' }, to: { db: 'shop2', coll: 'orders' } }]
      const restoreBody = { source: { kind: 'upload', uploadId }, mapping, mode: 'insert' }
      const plan = (await admin.call('POST', `/api/connections/${h.ids.B}/restore/plan`, restoreBody)).json()
      const restore = await admin.call('POST', `/api/connections/${h.ids.B}/restore`, {
        ...restoreBody,
        planHash: plan.planHash,
      })
      expect(restore.statusCode, restore.body).toBe(202)
      expect((await waitJob(h.t, restore.json().job.id, 60_000)).state).toBe('done')
      const cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
      expect(await cb.db('shop2').collection('orders').countDocuments()).toBe(3)
      await cb.close()
    } finally {
      await h.t.close()
    }
  }, 300_000)

  it('lets a browse-level user fetch a foreign file verified by its manifest', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { B: 'editor' } })
      const dest = await folderDest(admin, 'f2')
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [{ userId: u.id, level: 'browse' }],
      })
      // A file another installation wrote: a gzip archive and its manifest.
      const copy = await sentCopy(h, admin, dest)
      const body = readFileSync(join(root(), 'f2', ...copy.remoteKey.split('/')))
      const id = randomUUID()
      const key = remoteKeyFor('', 'gzip', id, Date.UTC(2026, 0, 2))
      const path = join(root(), 'f2', ...key.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
      writeFileSync(
        `${path}.json`,
        buildManifest({
          id,
          format: 'gzip',
          size: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
          createdAt: Date.UTC(2026, 0, 2),
          tool: { name: 'mongo-manager', version: '2.0.0' },
        }),
      )
      const items = (await u.get(`/api/backup-destinations/${dest}/backups`)).json().items
      expect(items.find((i: { key: string }) => i.key === key)).toMatchObject({
        state: 'complete',
        copyId: null,
        sender: null,
        mine: false,
      })
      const res = await u.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
        connectionId: h.ids.B,
        key,
      })
      expect(res.statusCode, res.body).toBe(202)
      expect((await waitJob(h.t, res.json().job.id, 60_000)).state).toBe('done')
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('removes a fetched file whose digest differs', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folderDest(admin, 'f3')
      const copy = await sentCopy(h, admin, dest)
      const path = join(root(), 'f3', ...copy.remoteKey.split('/'))
      const tampered = readFileSync(path)
      tampered[tampered.length - 5] = tampered[tampered.length - 5]! ^ 0xff
      writeFileSync(path, tampered)
      const res = await admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
        connectionId: h.ids.B,
        key: copy.remoteKey,
      })
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/differs/)
      expect(h.ctx.backup.store.byId(res.json().uploadId)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('stops a fetch that serves more than it declared', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folderDest(admin, 'f4')
      const copy = await sentCopy(h, admin, dest)
      // The job is told the object is 10 bytes shorter than the destination serves.
      const upload = h.ctx.backup.store.createUpload({
        owner: admin.id,
        name: 'x',
        size: copy.size - 10,
        awaitingVerify: true,
      })
      const job = h.ctx.jobs.start(
        h.ctx.jobKinds['backup.fetch'],
        { userId: admin.id, connectionId: h.ids.B, db: '*', coll: '*', target: 'x' },
        {
          owner: admin.id,
          userId: admin.id,
          destinationId: dest,
          key: copy.remoteKey,
          uploadId: upload.id,
          expectSha256: null,
          size: copy.size - 10,
        },
      )
      const done = await waitJob(h.t, job.id, 60_000)
      expect(done.state).toBe('failed')
      expect(h.ctx.backup.store.byId(upload.id)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('refuses archived objects, keys outside the layout, and parts for a fetching upload', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 's3',
          name: 'Cold',
          config: {
            preset: 'minio',
            endpoint: s3.url,
            region: 'us-east-1',
            bucket: 'mm-test',
            pathStyle: true,
            caPem: s3.caPem,
          },
          secrets: s3.credentials,
          policy: { encryptedOnly: false },
        })
      ).json().id
      const key = remoteKeyFor('', 'gzip', randomUUID(), Date.now())
      s3.objects.set(key, { body: Buffer.from('cold'), storageClass: 'DEEP_ARCHIVE' })
      const archived = await admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
        connectionId: h.ids.B,
        key,
      })
      expect([archived.statusCode, archived.json().details?.reason]).toEqual([409, 'archived'])
      const bad = await admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
        connectionId: h.ids.B,
        key: '../../etc/passwd',
      })
      expect([bad.statusCode, bad.json().details?.reason]).toEqual([400, 'path'])
      const upload = h.ctx.backup.store.createUpload({
        owner: admin.id,
        name: 'x',
        size: 10,
        awaitingVerify: true,
      })
      const part = await admin.raw('PUT', `/api/backups/uploads/${upload.id}?offset=0`, Buffer.alloc(10))
      expect([part.statusCode, part.json().details?.reason]).toEqual([409, 'upload_fetching'])
    } finally {
      await h.t.close()
    }
  })

  it('lets the sender or an administrator delete a remote copy, nobody else', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      const v = h.user({ on: { A: 'editor' } })
      const dest = await folderDest(admin, 'f5')
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [
          { userId: u.id, level: 'send' },
          { userId: v.id, level: 'browse' },
        ],
      })
      const copy = await sentCopy(h, u, dest)
      expect((await v.get(`/api/backup-destinations/${dest}/backups`)).json().items).toHaveLength(1)
      expect((await v.call('DELETE', `/api/backup-destinations/${dest}/backups/${copy.id}`)).statusCode).toBe(
        404,
      )
      expect((await u.call('DELETE', `/api/backup-destinations/${dest}/backups/${copy.id}`)).statusCode).toBe(
        204,
      )
      expect((await admin.get(`/api/backup-destinations/${dest}/backups`)).json().items).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 180_000)
})
