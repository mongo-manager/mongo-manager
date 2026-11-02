import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { startFakeGoogle, type FakeGoogle } from './support/fake-google'
import { installGcs } from './support/fake-gcs'
import { slow } from './support/slowness'

/**
 * W4 item 5: a Google Cloud Storage destination through the routes — created with a sealed service
 * account key, tested step by step, a backup sent and listed, then fetched back for a restore.
 */
let a: TestMongo
let b: TestMongo
let g: FakeGoogle
let gcs: ReturnType<typeof installGcs>
let ca: MongoClient
let base: string
beforeAll(async () => {
  ;[a, b, g] = await Promise.all([startMongo(), startMongo(), startFakeGoogle()])
  gcs = installGcs(g)
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await ca.db('gshop').dropDatabase()
  await ca
    .db('gshop')
    .collection('orders')
    .insertMany([{ n: 1 }, { n: 2 }])
  base = mkdtempSync(join(tmpdir(), 'mm-gcs-routes-'))
  mkdirSync(join(base, 'root'))
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop(), g?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})

const saKey = () => JSON.stringify({ type: 'service_account', ...g.serviceKey })

describe('a Google Cloud Storage destination (W4.5)', () => {
  it('is created with a sealed key, tested, sent to, listed and fetched from', async () => {
    const h = await backupHarness(a, b, {
      backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
    } as never)
    h.ctx.backup.googleHosts = { ...g.hosts, storage: g.url }
    try {
      const admin = h.user({ role: 'admin' })
      const created = await admin.call('POST', '/api/backup-destinations', {
        type: 'gcs',
        name: 'GCS',
        config: { bucket: gcs.bucket, prefix: 'mm', storageClass: 'NEARLINE' },
        secrets: { serviceAccountKey: saKey() },
        policy: { encryptedOnly: false },
      })
      expect(created.statusCode, created.body).toBe(201)
      const view = created.json()
      // The key never comes back: only that one is stored.
      expect(view.secrets).toEqual({ serviceAccountKey: true })
      expect(JSON.stringify(view)).not.toContain('PRIVATE KEY')
      const stored = h.ctx.store.db
        .prepare('SELECT secrets FROM backup_destinations WHERE id = ?')
        .get(view.id) as {
        secrets: string
      }
      expect(stored.secrets).not.toContain('PRIVATE KEY')
      const test = (await admin.call('POST', `/api/backup-destinations/${view.id}/test`, {})).json()
      expect(test.steps.map((s: { step: string; ok: boolean }) => [s.step, s.ok])).toEqual([
        ['resolve', true],
        ['connect', true],
        ['auth', true],
        ['write', true],
        ['read', true],
        ['delete', true],
      ])
      // A backup sent there, listed, then fetched for a restore.
      const body = { scope: { kind: 'database', db: 'gshop' }, format: 'gzip', destinations: [view.id] }
      const plan = (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const res = await admin.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: plan.planHash,
      })
      expect(res.statusCode, res.body).toBe(202)
      await waitJob(h.t, res.json().job.id, 60_000)
      const report = (await admin.get(`/api/transfer/jobs/${res.json().job.id}/report`)).json()
      const sent = await waitJob(h.t, report.sendJobId, 60_000)
      expect(sent.state, sent.error ?? '').toBe('done')
      const page = (await admin.get(`/api/backup-destinations/${view.id}/backups`)).json()
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ state: 'complete', format: 'gzip', archived: false })
      expect(page.items[0].key).toMatch(/^mm\/mongo-manager\//)
      expect([...gcs.objects.values()].some((o) => o.storageClass === 'NEARLINE')).toBe(true)
      const fetched = await admin.call('POST', `/api/backup-destinations/${view.id}/backups/fetch`, {
        connectionId: h.ids.B,
        key: page.items[0].key,
      })
      expect(fetched.statusCode, fetched.body).toBe(202)
      expect((await waitJob(h.t, fetched.json().job.id, 60_000)).state).toBe('done')
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('refuses a key that is not a service account, and asks for it again when the bucket changes', async () => {
    const h = await backupHarness(a, b, {
      backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
    } as never)
    h.ctx.backup.googleHosts = { ...g.hosts, storage: g.url }
    try {
      const admin = h.user({ role: 'admin' })
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'gcs',
          name: 'GCS 2',
          config: { bucket: gcs.bucket },
          secrets: { serviceAccountKey: saKey() },
        })
      ).json().id
      const moved = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        config: { bucket: 'another-bucket' },
      })
      expect([moved.statusCode, moved.json().details?.reason]).toEqual([400, 'secrets_required'])
      // A key that is not a service account's is refused before anything is stored or sent.
      const bad = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        secrets: { serviceAccountKey: '{"type":"user"}' },
      })
      expect(bad.statusCode).toBe(400)
      expect(JSON.stringify(bad.json())).not.toContain('"type":"user"')
    } finally {
      await h.t.close()
    }
  })
})
