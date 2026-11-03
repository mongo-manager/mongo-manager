import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
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
  base = mkdtempSync(join(tmpdir(), 'mm-send-'))
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
    .insertMany([{ email: 'a@x' }, { email: 'b@x' }])
  s3.objects.clear()
  s3.uploads.clear()
})

type H = Awaited<ReturnType<typeof backupHarness>>
const harness = () =>
  backupHarness(a, b, { backup: { folderRoots: [root()], privateNetworks: ['127.0.0.1/32'] } } as never)
async function dump(
  h: H,
  u: ReturnType<H['user']>,
  extra: object = { format: 'mmbak', password: 'correct horse battery' },
) {
  const body = { scope: { kind: 'database', db: 'shop' }, ...extra }
  const { password: _p, ...plan } = body as { password?: string }
  const p = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, plan)).json()
  const res = await u.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: p.planHash })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  expect(job.state).toBe('done')
  return (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId as string
}
async function folder(h: H, admin: ReturnType<H['user']>, name: string, policy = { encryptedOnly: true }) {
  const r = await admin.call('POST', '/api/backup-destinations', {
    type: 'folder',
    name,
    config: { path: join(root(), name) },
    policy,
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}
async function send(
  h: H,
  u: ReturnType<H['user']>,
  backupId: string,
  destinationIds: string[],
  deleteLocal = false,
) {
  const r = await u.call('POST', `/api/backups/${backupId}/send`, { destinationIds, deleteLocal })
  return r
}

describe('sending backups (phase 3d-3b spec §1.2, §4.2, §4.3, D8, D9, D12)', () => {
  it('sends to a folder, verifies, writes the manifest last, and shows the copy', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      const dest = await folder(h, admin, 'disk1')
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [{ userId: u.id, level: 'send' }],
      })
      const id = await dump(h, u)
      const res = await send(h, u, id, [dest])
      expect(res.statusCode, res.body).toBe(202)
      expect((await waitJob(h.t, res.json().job.id, 60_000)).state).toBe('done')
      const [view] = (await u.get('/api/backups')).json()
      expect(view.copies).toEqual([
        expect.objectContaining({
          destinationId: dest,
          destinationName: 'disk1',
          state: 'complete',
          error: null,
        }),
      ])
      const copy = h.ctx.backup.copies.byBackup(id)[0]!
      const remote = join(root(), 'disk1', ...copy.remoteKey.split('/'))
      expect(createHash('sha256').update(readFileSync(remote)).digest('hex')).toBe(view.sha256)
      const manifest = JSON.parse(readFileSync(`${remote}.json`, 'utf8'))
      expect(manifest).toMatchObject({ v: 1, id, format: 'mmbak', sha256: view.sha256 })
      // D13: no database or collection name in the remote name or the manifest.
      expect(copy.remoteKey + JSON.stringify(manifest)).not.toMatch(/shop|orders/)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('sends a backup once per destination', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(h, admin, 'disk2')
      const id = await dump(h, admin)
      for (let i = 0; i < 2; i++)
        expect((await waitJob(h.t, (await send(h, admin, id, [dest])).json().job.id, 60_000)).state).toBe(
          'done',
        )
      expect(h.ctx.backup.copies.byBackup(id)).toHaveLength(1)
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('refuses what a destination does not accept (D9)', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const strict = await folder(h, admin, 'disk3')
      const loose = await folder(h, admin, 'disk4', { encryptedOnly: false })
      const plain = await dump(h, admin, { format: 'gzip' })
      expect((await send(h, admin, plain, [strict])).json().details?.reason).toBe(
        'destination_encrypted_only',
      )
      expect((await send(h, admin, plain, [loose])).statusCode).toBe(202)
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }] as never)
      const personal = await dump(h, admin, { format: 'gzip' })
      expect((await send(h, admin, personal, [loose])).json().details?.reason).toBe(
        'destination_personal_plain',
      )
      const anonymous = await dump(h, admin, { format: 'gzip', anonymous: true })
      expect((await send(h, admin, anonymous, [loose])).statusCode).toBe(202)
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('keeps destinations and backups to those allowed (D7, D8)', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      const dest = await folder(h, admin, 'disk5')
      const id = await dump(h, u)
      expect((await send(h, u, id, [dest])).statusCode).toBe(404)
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [{ userId: u.id, level: 'send' }],
      })
      expect((await send(h, admin, id, [dest])).statusCode).toBe(404)
      h.ctx.grants.setMasked(h.ids.A, u.id, true)
      expect((await send(h, u, id, [dest])).statusCode).toBe(410)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('deletes the local copy only after every destination verified, and names the one that failed', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const ok = await folder(h, admin, 'disk6')
      const broken = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 's3',
          name: 'Broken',
          config: {
            preset: 'minio',
            endpoint: s3.url,
            region: 'us-east-1',
            bucket: 'nope',
            pathStyle: true,
            caPem: s3.caPem,
          },
          secrets: s3.credentials,
        })
      ).json().id
      const id = await dump(h, admin)
      const job = await waitJob(h.t, (await send(h, admin, id, [ok, broken], true)).json().job.id, 60_000)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/Broken/)
      expect(h.ctx.backup.store.byId(id)).toBeDefined()
      const id2 = await dump(h, admin)
      expect((await waitJob(h.t, (await send(h, admin, id2, [ok], true)).json().job.id, 60_000)).state).toBe(
        'done',
      )
      expect(h.ctx.backup.store.byId(id2)).toBeUndefined()
      expect(h.ctx.backup.copies.byBackup(id2)).toEqual([])
      expect(h.ctx.backup.copies.byDestination(ok).some((c) => c.backupId === null)).toBe(true)
    } finally {
      await h.t.close()
    }
  }, 300_000)

  it('retries a failed copy from where it stopped, and discards one', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 's3',
          name: 'Flaky',
          config: {
            preset: 'minio',
            endpoint: s3.url,
            region: 'us-east-1',
            bucket: 'mm-test',
            pathStyle: true,
            caPem: s3.caPem,
          },
          secrets: s3.credentials,
        })
      ).json().id
      const id = await dump(h, admin)
      // One request and its three retries: the send fails; the retry's request then succeeds.
      s3.failNext(4, 500)
      expect((await waitJob(h.t, (await send(h, admin, id, [dest])).json().job.id, 120_000)).state).toBe(
        'failed',
      )
      const copy = h.ctx.backup.copies.byBackup(id)[0]!
      expect(copy.state).toBe('failed')
      const retried = await admin.call('POST', `/api/backup-copies/${copy.id}/retry`)
      expect(retried.statusCode, retried.body).toBe(202)
      expect((await waitJob(h.t, retried.json().job.id, 60_000)).state).toBe('done')
      expect(h.ctx.backup.copies.get(copy.id)!.state).toBe('complete')
      const other = h.user({ role: 'admin' })
      expect((await other.call('POST', `/api/backup-copies/${copy.id}/retry`)).statusCode).toBe(404)
      expect((await admin.call('DELETE', `/api/backup-copies/${copy.id}`)).statusCode).toBe(409)
    } finally {
      await h.t.close()
    }
  }, 300_000)
})
