import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { startFakeS3, type FakeS3 } from './support/fake-s3'
import { startHttpsServer } from './support/https-server'
import { slow } from './support/slowness'

let a: TestMongo
let b: TestMongo
let s3: FakeS3
let ca: MongoClient
let base: string
beforeAll(async () => {
  ;[a, b, s3] = await Promise.all([startMongo(), startMongo(), startFakeS3()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await ca
    .db('shop')
    .collection('orders')
    .insertMany([{ email: 'a@x' }])
  base = mkdtempSync(join(tmpdir(), 'mm-dsec-'))
  mkdirSync(join(base, 'root'))
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop(), s3?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})
const SENTINEL = 'SENTINEL-d4-secret-value'
const harness = (networks = ['127.0.0.1/32'], extra = {}) =>
  backupHarness(
    a,
    b,
    { backup: { folderRoots: [join(base, 'root')], privateNetworks: networks } } as never,
    extra,
  )
const s3Body = (over: object = {}) => ({
  type: 's3',
  name: `S3-${Math.random()}`,
  config: {
    preset: 'minio',
    endpoint: s3.url,
    region: 'us-east-1',
    bucket: 'mm-test',
    pathStyle: true,
    caPem: s3.caPem,
    ...over,
  },
  secrets: s3.credentials,
})

describe('backup destinations threat model (phase 3d-3b spec §5)', () => {
  it('D1: the test route refuses metadata, loopback and rebinding targets by reason', async () => {
    const h = await harness([])
    try {
      const admin = h.user({ role: 'admin' })
      for (const endpoint of [
        'https://169.254.169.254',
        'https://[::ffff:169.254.169.254]',
        'https://127.0.0.1:9',
        'https://2130706433',
        'http://10.0.0.1',
      ])
        expect(
          (await admin.call('POST', '/api/backup-destinations/test', s3Body({ endpoint }))).json().steps[0],
          endpoint,
        ).toMatchObject({ step: 'resolve', ok: false })
    } finally {
      await h.t.close()
    }
  }) // [break: classifyAddress returns ok for metadata]

  it('D2: a hostile provider cannot exhaust memory with an endless answer', async () => {
    const endless = await startHttpsServer((req, res) => {
      // HEAD (the connect probe) answers; every body the client reads never ends.
      if (req.method === 'HEAD') return res.end()
      res.writeHead(403, { 'content-type': 'application/xml' })
      const t = setInterval(() => res.write('<a>'.repeat(10_000)), 1)
      res.on('close', () => clearInterval(t))
    })
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const out = (
        await admin.call(
          'POST',
          '/api/backup-destinations/test',
          s3Body({ endpoint: endless.url, caPem: endless.caPem }),
        )
      ).json()
      expect(out.steps.find((s: { ok: boolean }) => !s.ok)).toBeDefined()
    } finally {
      await h.t.close()
      await endless.close()
    }
  }) // [break: readSmall without its limit]

  it('D4: no secret reaches DTOs, audit, jobs or the log', async () => {
    const logFile = join(base, `log-${Math.random()}.log`)
    const h = await backupHarness(
      a,
      b,
      {
        logLevel: 'trace',
        logFile,
        backup: { folderRoots: [join(base, 'root')], privateNetworks: ['127.0.0.1/32'] },
      } as never,
      { logger: true },
    )
    try {
      const admin = h.user({ role: 'admin' })
      const created = await admin.call('POST', '/api/backup-destinations', {
        ...s3Body(),
        secrets: { accessKeyId: s3.credentials.accessKeyId, secretAccessKey: SENTINEL },
      })
      const id = created.json().id
      await admin.call('POST', `/api/backup-destinations/${id}/test`)
      const surfaces = [
        created.body,
        (await admin.get('/api/backup-destinations/all')).body,
        JSON.stringify(h.ctx.store.db.prepare('SELECT * FROM audit_log').all()),
        JSON.stringify(h.ctx.store.db.prepare('SELECT * FROM jobs').all()),
        JSON.stringify(h.ctx.store.db.prepare('SELECT * FROM backup_destinations').all()),
      ]
      await h.t.close()
      surfaces.push(readFileSync(logFile, 'utf8'))
      for (const s of surfaces) expect(s).not.toContain(SENTINEL)
    } finally {
      await h.t.close().catch(() => undefined)
    }
  }) // [break: toDestinationView returns repo().secrets(id)]

  it('D5: Basic authentication never goes over plain http to a public address', async () => {
    const h = await harness([])
    try {
      const admin = h.user({ role: 'admin' })
      const out = (
        await admin.call('POST', '/api/backup-destinations/test', {
          type: 'webdav',
          name: 'dav',
          config: { preset: 'generic', url: 'http://1.1.1.1/dav', username: 'u' },
          secrets: { password: SENTINEL },
        })
      ).json()
      expect(out.steps[0]).toMatchObject({ ok: false, reason: 'http_refused' })
    } finally {
      await h.t.close()
    }
  }) // [break: judge() ignores plainHttp]

  it('D7: non-administrators manage nothing and see no ungranted destination', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const editor = h.user({ role: 'editor' })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body())).json().id
      for (const [m, u, body] of [
        ['PATCH', `/api/backup-destinations/${id}`, { name: 'x' }],
        ['DELETE', `/api/backup-destinations/${id}`, undefined],
        ['POST', `/api/backup-destinations/${id}/test`, undefined],
        ['PUT', `/api/backup-destinations/${id}/grants`, { grants: [] }],
        ['GET', '/api/backup-destinations/all', undefined],
      ] as const)
        expect((await editor.call(m, u, body)).statusCode, `${m} ${u}`).toBe(403)
      expect((await editor.get(`/api/backup-destinations/${id}/backups`)).statusCode).toBe(404)
    } finally {
      await h.t.close()
    }
  }) // [break: requireLevel returns 'send' for anyone]

  it('D8: fetching one’s own copy repeats the download checks after access changes', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor', B: 'editor' } })
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: 'D8',
          config: { path: join(base, 'root', 'd8') },
        })
      ).json().id
      await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
        grants: [{ userId: u.id, level: 'send' }],
      })
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'mmbak', destinations: [id] }
      const plan = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dumped = await waitJob(
        h.t,
        (
          await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
            ...body,
            planHash: plan.planHash,
            password: 'correct horse battery',
          })
        ).json().job.id,
        60_000,
      )
      const report = (await u.get(`/api/transfer/jobs/${dumped.id}/report`)).json()
      await waitJob(h.t, report.sendJobId, 60_000)
      const copy = h.ctx.backup.copies.byBackup(report.backupId)[0]!
      h.ctx.grants.setMasked(h.ids.A, u.id, true)
      const res = await u.call('POST', `/api/backup-destinations/${id}/backups/fetch`, {
        connectionId: h.ids.B,
        key: copy.remoteKey,
      })
      expect(res.statusCode).toBe(410)
    } finally {
      await h.t.close()
    }
  }, 180_000) // [break: assertCopyAccess returns at once]

  it('D10: revoking a grant or deleting the destination cancels running transfers', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      const slowS3 = await startHttpsServer(async (req, res) => {
        for await (const _ of req) await new Promise((r) => setTimeout(r, 50))
        res.end()
      })
      const id = (
        await admin.call(
          'POST',
          '/api/backup-destinations',
          s3Body({ endpoint: slowS3.url, caPem: slowS3.caPem }),
        )
      ).json().id
      await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
        grants: [{ userId: u.id, level: 'send' }],
      })
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'mmbak' }
      const plan = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dumped = await waitJob(
        h.t,
        (
          await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
            ...body,
            planHash: plan.planHash,
            password: 'correct horse battery',
          })
        ).json().job.id,
        60_000,
      )
      const backupId = (await u.get(`/api/transfer/jobs/${dumped.id}/report`)).json().backupId
      const send = (await u.call('POST', `/api/backups/${backupId}/send`, { destinationIds: [id] })).json()
        .job.id
      await admin.call('PUT', `/api/backup-destinations/${id}/grants`, { grants: [] })
      expect((await waitJob(h.t, send, 30_000)).state).toBe('cancelled')
      await slowS3.close()
    } finally {
      await h.t.close()
    }
  }, 120_000) // [break: setGrants returns lost: []]

  it('D11: folder destinations stay inside their roots', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const outside = join(base, 'outside')
      mkdirSync(outside, { recursive: true })
      symlinkSync(outside, join(base, 'root', 'jump'), process.platform === 'win32' ? 'junction' : 'dir')
      for (const path of [
        join(base, 'outside'),
        join(base, 'root', 'jump', 'x'),
        join(base, 'root', '..', 'outside'),
        h.t.dir,
        '\\\\server\\share',
      ])
        expect(
          (
            await admin.call('POST', '/api/backup-destinations', {
              type: 'folder',
              name: `F${Math.random()}`,
              config: { path },
            })
          ).json().details?.reason,
          path,
        ).toBe('path')
      // Short names review 7 (I-1): and which folder refusal it is.
      const why = async (path: string) =>
        (
          await admin.call('POST', '/api/backup-destinations', {
            type: 'folder',
            name: `F${Math.random()}`,
            config: { path },
          })
        ).json().details?.why
      expect(await why(join(base, 'outside'))).toBe('roots')
      expect(await why('\\\\server\\share')).toBe('network')
      expect(await why(join(base, 'root', 'jump', 'x'))).toBe('link')
      // Short names review 6 (I-1): a name refusal says which name, for the editor to show.
      const named = await admin.call('POST', '/api/backup-destinations', {
        type: 'folder',
        name: `F${Math.random()}`,
        config: { path: join(base, 'root', 'a\u0000b') },
      })
      expect([named.statusCode, named.json().details]).toEqual([
        400,
        { reason: 'path_name', name: '"a\\u0000b"' },
      ])
    } finally {
      await h.t.close()
    }
  }) // [break: resolveFolder skips the walk]

  // Short names review 7 (I-1): a test step of a folder refusal says which it is.
  it('a test of a folder that became a file says which refusal it is', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const at = join(base, 'root', `became-a-file-${Math.random()}`)
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: `F${Math.random()}`,
          config: { path: at },
          policy: { encryptedOnly: false },
        })
      ).json().id
      rmSync(at, { recursive: true, force: true })
      writeFileSync(at, 'x')
      const steps = (await admin.call('POST', `/api/backup-destinations/${id}/test`)).json().steps
      expect(steps.find((s: { ok: boolean }) => !s.ok)).toMatchObject({ reason: 'path', why: 'not_folder' })
      // Short names review 8 (M-6): and the card's status says which, until a test passes again.
      const status = () =>
        (
          admin.get('/api/backup-destinations/all') as Promise<{
            json(): Array<{ id: string; status: object }>
          }>
        ).then((r) => r.json().find((d) => d.id === id)!.status)
      expect(await status()).toMatchObject({ state: 'failed', reason: 'path', why: 'not_folder' })
      rmSync(at, { force: true })
      await admin.call('POST', `/api/backup-destinations/${id}/test`)
      expect(await status()).not.toHaveProperty('why')
    } finally {
      await h.t.close()
    }
  })

  // Short names review 6 (I-1): a saved folder that is gone, and whose name Windows tools cannot
  // use, is tested to a step that says which name.
  it.runIf(process.platform === 'win32')('a test of a folder refused for its name says which', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const aux = join(base, 'root', 'aux')
      mkdirSync(aux, { recursive: true })
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: `F${Math.random()}`,
          config: { path: aux },
          policy: { encryptedOnly: false },
        })
      ).json().id
      rmSync(aux, { recursive: true, force: true })
      const steps = (await admin.call('POST', `/api/backup-destinations/${id}/test`)).json().steps
      expect(steps.find((s: { ok: boolean }) => !s.ok)).toMatchObject({
        reason: 'path_name',
        name: '"aux"',
      })
    } finally {
      await h.t.close()
    }
  })

  it('D12: an unfinished copy is listed as incomplete, never as complete', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: 'D12',
          config: { path: join(base, 'root', 'd12') },
          policy: { encryptedOnly: false },
        })
      ).json().id
      const copy = h.ctx.backup.copies.create({
        destinationId: id,
        backupId: null,
        remoteKey: 'mongo-manager/2026/10/mm-20261003-000000-aaaaaaaa.archive',
        owner: admin.id,
        connectionId: h.ids.A,
        meta: null,
        format: 'archive',
        size: 1,
        sha256: 'a'.repeat(64),
        md5: null,
      })
      const dir = join(base, 'root', 'd12', 'mongo-manager', '2026', '10')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'mm-20261003-000000-aaaaaaaa.archive'), 'x')
      const items = (await admin.get(`/api/backup-destinations/${id}/backups`)).json().items
      expect(items).toEqual([expect.objectContaining({ copyId: copy.id, state: 'incomplete' })])
    } finally {
      await h.t.close()
    }
  }) // [break: state maps every copy to 'complete']

  it('D14: a lying manifest or a listing outside the layout is never trusted', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = (await admin.call('POST', '/api/backup-destinations', s3Body({ prefix: '' }))).json().id
      const key = 'mongo-manager/2026/10/mm-20261003-000000-bbbbbbbb.archive'
      s3.objects.set(key, { body: Buffer.from('12345'), storageClass: 'STANDARD' })
      s3.objects.set(`${key}.json`, {
        body: Buffer.from(
          JSON.stringify({
            v: 1,
            id: '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6',
            format: 'archive',
            size: 99,
            sha256: 'c'.repeat(64),
            createdAt: 1,
            tool: { name: 'x', version: '1' },
          }),
        ),
        storageClass: 'STANDARD',
      })
      s3.objects.set('mongo-manager/2026/10/../../evil', { body: Buffer.from('x'), storageClass: 'STANDARD' })
      const items = (await admin.get(`/api/backup-destinations/${id}/backups`)).json().items
      expect(items.map((i: { key: string }) => i.key)).toEqual([key])
      const res = await admin.call('POST', `/api/backup-destinations/${id}/backups/fetch`, {
        connectionId: h.ids.B,
        key,
      })
      expect([res.statusCode, res.json().details?.reason]).toEqual([409, 'verify'])
    } finally {
      await h.t.close()
    }
  }) // [break: the manifest/size comparison in the fetch route]
})
