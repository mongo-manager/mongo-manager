// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DestinationAdapter } from '../src/backup/destinations/types'
import { buildManifest, remoteKeyFor } from '../src/backup/destinations/layout'
import type { BackupMeta } from '../src/backup/store'
import { MANIFEST_READS_PER_PAGE } from '../src/routes/destinations'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import type { TestMongo } from './support/mongo'
import { startFakeS3, type FakeS3 } from './support/fake-s3'
import { installDrive, startFakeGoogle, type FakeGoogle } from './support/fake-google'
import { ADMIN_PASSWORD, givePassword } from './helpers'

type Wrap = (real: DestinationAdapter) => Partial<DestinationAdapter>
const hooks = vi.hoisted(() => ({ wrap: new Map<string, Wrap>() }))
vi.mock('../src/backup/destinations/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/backup/destinations/registry')>()
  return {
    ...real,
    adapterFor: (...args: Parameters<typeof real.adapterFor>) => {
      const adapter = real.adapterFor(...args)
      const wrap = hooks.wrap.get(args[0].name)
      return wrap ? { ...adapter, ...wrap(adapter) } : adapter
    },
  }
})

const nowhere: TestMongo = { host: '127.0.0.1', port: 1, stop: async () => undefined }
let s3: FakeS3
let g: FakeGoogle
let base: string
const root = () => join(base, 'root')
beforeAll(async () => {
  ;[s3, g] = await Promise.all([startFakeS3(), startFakeGoogle()])
  installDrive(g)
  base = mkdtempSync(join(tmpdir(), 'mm-dest-final-'))
  mkdirSync(root())
})
afterAll(async () => {
  await Promise.all([s3?.close(), g?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})
beforeEach(() => {
  g.device.answers.length = 0
})
afterEach(() => hooks.wrap.clear())

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
const harness = async () => {
  const h = await backupHarness(nowhere, nowhere, {
    backup: { folderRoots: [root()], privateNetworks: ['127.0.0.1/32'] },
  } as never)
  h.ctx.backup.googleHosts = g.hosts
  return h
}
let seq = 0
const unique = (name: string) => `${name}-${++seq}`
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const CLIENT = 'client-id-0001.apps.googleusercontent.com'
const s3Body = (name: string, over: object = {}) => ({
  type: 's3',
  name,
  config: {
    preset: 'minio',
    endpoint: s3.url,
    region: 'us-east-1',
    bucket: 'mm-test',
    prefix: unique('p'),
    pathStyle: true,
    caPem: s3.caPem,
    ...over,
  },
  secrets: { ...s3.credentials },
})
async function created(admin: U, body: object) {
  const r = await admin.call('POST', '/api/backup-destinations', body)
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}
async function folder(admin: U, name: string, wrap?: Wrap) {
  if (wrap) hooks.wrap.set(name, wrap)
  return created(admin, {
    type: 'folder',
    name,
    config: { path: join(root(), name) },
    policy: { encryptedOnly: false },
  })
}
async function approvedFlow(admin: U, clientId = CLIENT) {
  const start = await admin.call('POST', '/api/backup-destinations/google/device', {
    clientId,
    clientSecret: 'client-secret-1',
  })
  expect(start.statusCode, start.body).toBe(200)
  const flowId = start.json().flowId as string
  g.device.answers.push('approved')
  expect((await admin.get(`/api/backup-destinations/google/device/${flowId}`)).json().state).toBe('approved')
  return flowId
}
const metaOf = (over: Partial<BackupMeta> = {}): BackupMeta => ({
  scope: { kind: 'database', db: 'secret_shop', views: true },
  engine: 'builtin',
  format: 'mmbak',
  masked: false,
  anonymous: false,
  namespaces: 1,
  startedAt: 0,
  finishedAt: null,
  rulesVersion: 0,
  ...over,
})
function gate() {
  let open!: () => void
  const opened = new Promise<void>((r) => (open = r))
  const wait = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      void opened.then(resolve)
    })
  return { open: () => open(), wait }
}
function keep(h: H, owner: string) {
  const bytes = randomBytes(50_000)
  const { row, path } = h.ctx.backup.store.reserveBackup({
    owner,
    jobId: 'seed',
    connectionId: h.ids.A,
    name: 'shop.mmbak',
    meta: metaOf({ scope: { kind: 'database', db: 'shop', views: true } }),
  })
  writeFileSync(path, bytes)
  h.ctx.backup.store.completeBackup(row.id, { size: bytes.length, sha256: sha(bytes), finishedAt: 1 })
  return row.id
}
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('editing a destination’s config (final review B10, B20)', () => {
  it('removes an optional field sent as null, also inside an object, and checks the result again', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = await created(
        admin,
        s3Body(unique('nulls'), { sse: { kind: 'aws:kms', keyId: 'arn:aws:kms:us-east-1:1:key/abc' } }),
      )
      // A CA certificate is part of what the credentials are bound to: they come along.
      const res = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        config: { caPem: null, sse: { kind: 'aws:kms', keyId: null } },
        secrets: { ...s3.credentials },
      })
      expect(res.statusCode, res.body).toBe(200)
      const config = h.ctx.backup.destinations.get(id)!.config
      expect(config).not.toHaveProperty('caPem')
      expect(config.sse).toEqual({ kind: 'aws:kms' })
      // A field left out keeps its value; a required one cannot be removed.
      expect(config.bucket).toBe('mm-test')
      const required = await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        config: { bucket: null },
      })
      expect(required.statusCode).toBe(400)
      expect(h.ctx.backup.destinations.get(id)!.config.bucket).toBe('mm-test')
    } finally {
      await h.t.close()
    }
  })

  it('checks new credentials against their type’s rules, never echoing them', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = await created(admin, s3Body(unique('creds')))
      for (const secrets of [{ accessKeyId: 'has space' }, { secretAccessKey: 'short' }]) {
        const res = await admin.call('PATCH', `/api/backup-destinations/${id}`, { secrets })
        expect([res.statusCode, res.json().details?.reason], JSON.stringify(secrets)).toEqual([
          400,
          'secrets_invalid',
        ])
        expect(res.body).not.toMatch(/has space|"short"/)
      }
      expect(h.ctx.backup.destinations.secrets(id)).toEqual(s3.credentials)
    } finally {
      await h.t.close()
    }
  })
})

describe('testing a saved destination with unsaved changes (cross-area contract, B10, B15)', () => {
  it('tests the merged draft and saves nothing; without a body it records the status', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = await created(admin, s3Body(unique('draft')))
      const before = h.ctx.backup.destinations.get(id)!
      const ok = (r: { json(): { steps: Array<{ ok: boolean; step: string; reason?: string }> } }) =>
        r.json().steps.every((s) => s.ok || s.reason === 'skipped')
      // A wrong secret in the draft fails the sign-in; the stored one is untouched.
      const wrong = await admin.call('POST', `/api/backup-destinations/${id}/test`, {
        secrets: { secretAccessKey: 'definitely-wrong-1' },
      })
      expect(wrong.statusCode, wrong.body).toBe(200)
      expect(ok(wrong)).toBe(false)
      // The CA certificate removed in the draft: the TLS step fails (the fake S3 has a test CA).
      const noCa = await admin.call('POST', `/api/backup-destinations/${id}/test`, {
        config: { caPem: null },
        secrets: { ...s3.credentials },
      })
      expect(noCa.statusCode, noCa.body).toBe(200)
      expect(ok(noCa)).toBe(false)
      const after = h.ctx.backup.destinations.get(id)!
      expect(after.status).toEqual(before.status)
      expect(after.config).toEqual(before.config)
      expect(h.ctx.backup.destinations.secrets(id)).toEqual(s3.credentials)
      // Another address needs every credential again, as an edit would.
      const moved = await admin.call('POST', `/api/backup-destinations/${id}/test`, {
        config: { bucket: 'other-bucket' },
      })
      expect([moved.statusCode, moved.json().details?.reason]).toEqual([400, 'secrets_required'])
      // An empty body is a test of the saved destination, recorded.
      const saved = await admin.call('POST', `/api/backup-destinations/${id}/test`, {})
      expect(ok(saved)).toBe(true)
      expect(h.ctx.backup.destinations.get(id)!.status.state).toBe('ok')
    } finally {
      await h.t.close()
    }
  })

  it('clears the reason of an earlier failure once a test passes', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const id = await created(admin, {
        ...s3Body(unique('reason')),
        secrets: { ...s3.credentials, secretAccessKey: 'definitely-wrong-1' },
      })
      await admin.call('POST', `/api/backup-destinations/${id}/test`)
      expect(h.ctx.backup.destinations.get(id)!.status).toMatchObject({ state: 'failed', reason: 'auth' })
      await admin.call('PATCH', `/api/backup-destinations/${id}`, {
        secrets: { secretAccessKey: s3.credentials.secretAccessKey },
      })
      await admin.call('POST', `/api/backup-destinations/${id}/test`)
      const status = h.ctx.backup.destinations.get(id)!.status
      expect(status.state).toBe('ok')
      expect(status).not.toHaveProperty('reason')
    } finally {
      await h.t.close()
    }
  })
})

describe('Google sign-ins are not wasted (final review B16, B17)', () => {
  it('keeps an approved sign-in when a save is refused for another reason', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const taken = unique('taken')
      await folder(admin, taken)
      const flowId = await approvedFlow(admin)
      const body = (name: string) => ({
        type: 'gdrive',
        name,
        config: { auth: 'oauth', clientId: CLIENT },
        deviceFlowId: flowId,
      })
      const clash = await admin.call('POST', '/api/backup-destinations', body(taken))
      expect([clash.statusCode, clash.json().details?.reason]).toEqual([409, 'name_taken'])
      const drive = await created(admin, body(unique('drive')))
      // An edit refused for its name does not spend a new sign-in either.
      const again = await approvedFlow(admin)
      const refused = await admin.call('PATCH', `/api/backup-destinations/${drive}`, {
        name: taken,
        deviceFlowId: again,
      })
      expect([refused.statusCode, refused.json().details?.reason]).toEqual([409, 'name_taken'])
      const fine = await admin.call('PATCH', `/api/backup-destinations/${drive}`, { deviceFlowId: again })
      expect(fine.statusCode, fine.body).toBe(200)
    } finally {
      await h.t.close()
    }
  })

  it('asks Google once when two polls arrive together, and never undoes an approval', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const flowId = (
        await admin.call('POST', '/api/backup-destinations/google/device', {
          clientId: CLIENT,
          clientSecret: 'client-secret-1',
        })
      ).json().flowId
      const polls = () => g.requests.filter((r) => r === 'POST /token').length
      const before = polls()
      g.device.answers.push('approved', 'expired_token')
      const poll = () => admin.get(`/api/backup-destinations/google/device/${flowId}`)
      const answers = await Promise.all([poll(), poll()])
      expect(polls()).toBe(before + 1)
      expect(answers.map((a) => a.json().state).sort()).toEqual(['approved', 'pending'])
      expect(h.ctx.backup.deviceFlows.get(admin.id, flowId)!.state).toBe('approved')
    } finally {
      g.device.answers.length = 0
      await h.t.close()
    }
  })
})

describe('remote listings (final review B19, B23)', () => {
  it('shows a copy’s scope and connection only to its sender, an administrator or a reader of that connection', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const sender = h.user({ on: { A: 'editor' } })
      const outsider = h.user({ on: { A: 'none', B: 'editor' } })
      const reader = h.user({ on: { A: 'viewer' } })
      const name = unique('scoped')
      const dest = await folder(admin, name)
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [
          { userId: sender.id, level: 'send' },
          { userId: outsider.id, level: 'browse' },
          { userId: reader.id, level: 'browse' },
        ],
      })
      const key = remoteKeyFor('', 'mmbak', randomUUID(), Date.UTC(2026, 0, 1))
      const path = join(root(), name, ...key.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'x')
      const c = h.ctx.backup.copies.create({
        destinationId: dest,
        backupId: null,
        remoteKey: key,
        owner: sender.id,
        connectionId: h.ids.A,
        meta: metaOf(),
        format: 'mmbak',
        size: 1,
        sha256: 'a'.repeat(64),
        md5: null,
      })
      h.ctx.backup.copies.complete(c.id, null)
      const itemFor = async (u: U) =>
        (await u.get(`/api/backup-destinations/${dest}/backups`)).json().items[0]
      const hidden = await itemFor(outsider)
      expect(hidden).toMatchObject({ copyId: c.id, scope: null, connectionId: null, masked: null })
      expect(JSON.stringify(hidden)).not.toContain('secret_shop')
      for (const u of [sender, admin, reader])
        expect(await itemFor(u)).toMatchObject({ scope: { db: 'secret_shop' }, connectionId: h.ids.A })
    } finally {
      await h.t.close()
    }
  })

  // Heavy on the disk by design (a page of manifests and more, read again and again): 3 s alone, but
  // it ran past 20 s twice while all packages' suites ran at once on Windows (phase 3d-3c gate).
  it('limits listings per user, and reads at most a page’s worth of manifests per request', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const other = h.user({ role: 'admin' })
      let manifestReads = 0
      const name = unique('many')
      const dest = await folder(admin, name, (real) => ({
        getSmall: (...a) => (manifestReads++, real.getSmall(...a)),
      }))
      const total = MANIFEST_READS_PER_PAGE + 20
      for (let i = 0; i < total; i++) {
        const id = randomUUID()
        const key = remoteKeyFor('', 'gzip', id, Date.UTC(2026, 0, 1) + i * 1000)
        const path = join(root(), name, ...key.split('/'))
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, 'x')
        writeFileSync(
          `${path}.json`,
          buildManifest({
            id,
            format: 'gzip',
            size: 1,
            sha256: 'b'.repeat(64),
            createdAt: 1,
            tool: { name: 'mongo-manager', version: '2.0.0' },
          }),
        )
      }
      const first = (await admin.get(`/api/backup-destinations/${dest}/backups`)).json()
      expect(first.items).toHaveLength(MANIFEST_READS_PER_PAGE)
      expect(manifestReads).toBe(MANIFEST_READS_PER_PAGE)
      expect(first.items.every((i: { state: string }) => i.state === 'complete')).toBe(true)
      const second = (
        await admin.get(`/api/backup-destinations/${dest}/backups?cursor=${encodeURIComponent(first.cursor)}`)
      ).json()
      expect(second.items).toHaveLength(20)
      expect(second.cursor).toBeNull()
      const keys = new Set([...first.items, ...second.items].map((i: { key: string }) => i.key))
      expect(keys.size).toBe(total)
      // 30 a minute per user; another user has their own.
      let limited = 0
      for (let i = 0; i < 30; i++)
        if ((await admin.get(`/api/backup-destinations/${dest}/backups`)).statusCode === 429) limited++
      expect(limited).toBeGreaterThan(0)
      expect((await other.get(`/api/backup-destinations/${dest}/backups`)).statusCode).toBe(200)
      h.t.clock.now += 61_000
      expect((await admin.get(`/api/backup-destinations/${dest}/backups`)).statusCode).toBe(200)
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('accounts that change stop their transfers (final review B21)', () => {
  it('cancels the sends of a user who is disabled, deleted, or no longer an administrator', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const hold = gate()
      const name = unique('held')
      const dest = await folder(admin, name, (real) => ({
        put: async (key, file, resume, io, signal) => {
          await hold.wait(signal)
          return real.put(key, file, resume, io, signal)
        },
      }))
      const start = async (u: U) => {
        const r = await u.call('POST', `/api/backups/${keep(h, u.id)}/send`, { destinationIds: [dest] })
        expect(r.statusCode, r.body).toBe(202)
        return r.json().job.id as string
      }
      const disabled = h.user({ role: 'admin', on: { A: 'editor' } })
      const deleted = h.user({ role: 'admin', on: { A: 'editor' } })
      const demoted = h.user({ role: 'admin', on: { A: 'editor' } })
      const kept = h.user({ role: 'admin', on: { A: 'editor' } })
      const jobs = {
        disabled: await start(disabled),
        deleted: await start(deleted),
        demoted: await start(demoted),
        kept: await start(kept),
      }
      await until(() => h.ctx.backup.transfers.size === 4)
      expect((await admin.call('PATCH', `/api/users/${disabled.id}`, { disabled: true })).statusCode).toBe(
        200,
      )
      expect((await admin.call('DELETE', `/api/users/${deleted.id}`)).statusCode).toBe(204)
      await givePassword(h.ctx, admin.id)
      const demote = await admin.call('PATCH', `/api/users/${demoted.id}`, {
        role: 'editor',
        currentPassword: ADMIN_PASSWORD,
      })
      expect(demote.statusCode).toBe(200)
      for (const id of [jobs.disabled, jobs.deleted, jobs.demoted])
        expect((await waitJob(h.t, id)).state, id).toBe('cancelled')
      expect(h.ctx.jobs.get(jobs.kept)!.state).toBe('running')
      hold.open()
      expect((await waitJob(h.t, jobs.kept)).state).toBe('done')
    } finally {
      await h.t.close()
    }
  }, 90_000)
})

describe('reconnecting a saved Drive with its stored secret (final review B31)', () => {
  it('starts a sign-in with the stored client secret of that destination, never sending it back', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const drive = await created(admin, {
        type: 'gdrive',
        name: unique('drive'),
        config: { auth: 'oauth', clientId: CLIENT },
        deviceFlowId: await approvedFlow(admin),
      })
      const start = (body: object) => admin.call('POST', '/api/backup-destinations/google/device', body)
      const res = await start({ clientId: CLIENT, destinationId: drive })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.body).not.toContain('client-secret-1')
      // Google approves only with the right secret: the stored one was used.
      g.device.answers.push('approved')
      const polled = await admin.get(`/api/backup-destinations/google/device/${res.json().flowId}`)
      expect(polled.json().state).toBe('approved')
      const reconnect = await admin.call('PATCH', `/api/backup-destinations/${drive}`, {
        deviceFlowId: res.json().flowId,
      })
      expect(reconnect.statusCode, reconnect.body).toBe(200)
      expect(h.ctx.backup.destinations.secrets(drive).clientSecret).toBe('client-secret-1')
      // Another client id than the stored one: the stored secret is not for it.
      const other = await start({
        clientId: 'another-client-0002.apps.googleusercontent.com',
        destinationId: drive,
      })
      expect([other.statusCode, other.json().details?.reason]).toEqual([400, 'secrets_required'])
      // Not a Drive, or no destination at all: not found.
      const disk = await folder(admin, unique('disk'))
      for (const destinationId of [disk, randomUUID()])
        expect((await start({ clientId: CLIENT, destinationId })).statusCode).toBe(404)
      // An editor cannot use it either.
      const editor = h.user({ role: 'editor' })
      const refused = await editor.call('POST', '/api/backup-destinations/google/device', {
        clientId: CLIENT,
        destinationId: drive,
      })
      expect(refused.statusCode).toBe(403)
    } finally {
      await h.t.close()
    }
  })

  it('refuses a stored-secret sign-in for a Drive that keeps no client secret', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const drive = await created(admin, {
        type: 'gdrive',
        name: unique('service'),
        config: { auth: 'serviceAccount', sharedDriveId: '0ABCdefGHIjkl' },
        secrets: { serviceAccountKey: JSON.stringify({ type: 'service_account', ...g.serviceKey }) },
      })
      const res = await admin.call('POST', '/api/backup-destinations/google/device', {
        clientId: CLIENT,
        destinationId: drive,
      })
      expect([res.statusCode, res.json().details?.reason]).toEqual([400, 'secrets_required'])
    } finally {
      await h.t.close()
    }
  })
})

describe('how a destination verifies a copy (final review B34)', () => {
  it('says it in the summary every user with a grant sees', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dav = (name: string, username: string, verifyReadBack: boolean) =>
        created(admin, {
          type: 'webdav',
          name,
          config: { preset: 'generic', url: 'https://dav.example.com/files', username, verifyReadBack },
          secrets: { password: 'pw-123456' },
        })
      const ids = {
        folder: await folder(admin, unique('disk')),
        s3: await created(admin, s3Body(unique('bucket'))),
        davSize: await dav(unique('dav'), 'ops', false),
        davRead: await dav(unique('dav-read'), 'ops2', true),
        drive: await created(admin, {
          type: 'gdrive',
          name: unique('drive'),
          config: { auth: 'serviceAccount', sharedDriveId: '0ABCdefGHIjkl' },
          secrets: { serviceAccountKey: JSON.stringify({ type: 'service_account', ...g.serviceKey }) },
        }),
      }
      const u = h.user({ on: { A: 'editor' } })
      for (const id of Object.values(ids))
        await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
          grants: [{ userId: u.id, level: 'send' }],
        })
      const list = (await u.get('/api/backup-destinations')).json() as Array<{ id: string; verify?: string }>
      const verify = (id: string) => list.find((d) => d.id === id)?.verify
      expect(verify(ids.folder)).toBe('readBack')
      expect(verify(ids.s3)).toBe('checksum')
      expect(verify(ids.davSize)).toBe('size')
      expect(verify(ids.davRead)).toBe('readBack')
      expect(verify(ids.drive)).toBe('checksum')
    } finally {
      await h.t.close()
    }
  })
})

describe('paging a listing through the provider’s pages (final review B23)', () => {
  it('goes from one provider page to the next with its own opaque cursor', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const keys = [1, 2, 3, 4, 5].map((n) => remoteKeyFor('', 'gzip', randomUUID(), Date.UTC(2026, 0, n)))
      const asked: Array<string | null> = []
      const name = unique('pages')
      const dest = await folder(admin, name, () => ({
        // A provider with pages of two and its own continuation token.
        list: async (cursor) => {
          asked.push(cursor)
          const from = cursor ? Number(cursor.replace('token-', '')) : 0
          return {
            items: keys
              .slice(from, from + 2)
              .map((key) => ({ key, size: 1, modifiedAt: 1, archived: false })),
            cursor: from + 2 < keys.length ? `token-${from + 2}` : null,
          }
        },
        getSmall: async () => null,
      }))
      const seen: string[] = []
      let cursor: string | null = null
      for (let pages = 0; pages < 5; pages++) {
        const res = await admin.get(
          `/api/backup-destinations/${dest}/backups${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        )
        expect(res.statusCode, res.body).toBe(200)
        const page = res.json() as { items: Array<{ key: string }>; cursor: string | null }
        seen.push(...page.items.map((i) => i.key))
        // The provider's token never reaches the client as written.
        if (page.cursor) expect(page.cursor).not.toMatch(/token-/)
        cursor = page.cursor
        if (!cursor) break
      }
      expect(seen).toEqual(keys)
      expect(asked).toEqual([null, 'token-2', 'token-4'])
      const forged = Buffer.from(JSON.stringify({ c: 'token-2', s: -1 })).toString('base64url')
      const refused = await admin.get(`/api/backup-destinations/${dest}/backups?cursor=${forged}`)
      expect([refused.statusCode, refused.json().details?.reason]).toEqual([400, 'cursor'])
    } finally {
      await h.t.close()
    }
  })
})
