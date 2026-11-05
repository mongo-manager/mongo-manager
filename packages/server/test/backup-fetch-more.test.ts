// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { DestinationError, type DestinationAdapter } from '../src/backup/destinations/types'
import { buildManifest, remoteKeyFor } from '../src/backup/destinations/layout'
import { CopyRepo, DestinationRepo } from '../src/backup/destinations/repo'
import { BackupStore, type BackupMeta } from '../src/backup/store'
import { backupLimits } from '../src/backup/limits'
import { resolveConfig } from '../src/config'
import { createSecretBox } from '../src/crypto/secret-box'
import { EgressError } from '../src/net/egress'
import { Errors } from '../src/errors'
import { openStore, type Store } from '../src/store/db'
import { MAX_BACKUP_JOBS } from '../src/backup/limits'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import type { TestMongo } from './support/mongo'

type Wrap = (real: DestinationAdapter) => Partial<DestinationAdapter>

/** Fault injection on the real folder adapter, per destination name (see backup-send-more). */
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

// A fetch never opens a MongoDB connection: the harness only needs addresses for its connections.
const nowhere: TestMongo = { host: '127.0.0.1', port: 1, stop: async () => undefined }
let base: string
const root = () => join(base, 'root')
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mm-fetch-more-'))
  mkdirSync(root())
})
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})
afterEach(() => hooks.wrap.clear())

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
const harness = () =>
  backupHarness(nowhere, nowhere, {
    backup: { folderRoots: [root()], privateNetworks: ['127.0.0.1/32'] },
  } as never)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
let seq = 0
const unique = (name: string) => `${name}-${++seq}`
const remotePath = (name: string, key: string) => join(root(), name, ...key.split('/'))

async function folder(admin: U, name: string, wrap?: Wrap) {
  if (wrap) hooks.wrap.set(name, wrap)
  const r = await admin.call('POST', '/api/backup-destinations', {
    type: 'folder',
    name,
    config: { path: join(root(), name) },
    policy: { encryptedOnly: false },
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}
/** An object in a destination's layout, as another installation (or an earlier send) left it. */
function place(name: string, bytes = randomBytes(200_000), manifest = false) {
  const id = randomUUID()
  const key = remoteKeyFor('', 'gzip', id, Date.UTC(2026, 0, 2))
  const path = remotePath(name, key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  if (manifest)
    writeFileSync(
      `${path}.json`,
      buildManifest({
        id,
        format: 'gzip',
        size: bytes.length,
        sha256: sha(bytes),
        createdAt: Date.UTC(2026, 0, 2),
        tool: { name: 'mongo-manager', version: '2.0.0' },
      }),
    )
  return { key, bytes }
}
/** What the fetch route does once its checks passed: a growing upload, and the job filling it. */
function fetch(
  h: H,
  owner: string,
  destinationId: string,
  key: string,
  size: number,
  expectSha256: string | null,
) {
  const upload = h.ctx.backup.store.createUpload({ owner, name: 'fetched', size, awaitingVerify: true })
  const job = h.ctx.jobs.start(
    h.ctx.jobKinds['backup.fetch'],
    { userId: owner, connectionId: h.ids.B, db: '*', coll: '*', target: 'fetched' },
    { owner, userId: owner, destinationId, key, uploadId: upload.id, expectSha256, size },
  )
  return { upload, job, path: h.ctx.backup.store.pathOf(upload) }
}
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 10))
  }
}
/** A provider stream that sends `head`, then nothing until the job is cancelled. */
function stalled(head: Buffer, signal: AbortSignal) {
  const s = new Readable({ read() {} })
  s.push(head)
  // The fetch may have let go of the stream before the abort lands (seen under coverage load): the
  // error is still the stream's, never an unhandled one ending the test run.
  s.on('error', () => undefined)
  signal.addEventListener('abort', () => s.destroy(new Error('aborted')), { once: true })
  return s
}

describe('fetching from a destination (phase 3d-3b spec §4.2, plan ruling 3, D12)', () => {
  it('resumes from the bytes already on disk when the stream breaks, and completes once the digest matched', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('broken-stream')
      const offsets: number[] = []
      const dest = await folder(admin, name, (real) => ({
        get: async (key, offset, signal) => {
          offsets.push(offset)
          if (offsets.length > 1) return real.get(key, offset, signal)
          const all = await real.get(key, offset, signal)
          const head: Buffer[] = []
          for await (const c of all) head.push(c as Buffer)
          return Readable.from(
            (async function* () {
              yield Buffer.concat(head).subarray(0, 64 * 1024)
              await new Promise((r) => setTimeout(r, 50))
              throw new EgressError('network', 'The connection was reset')
            })(),
          )
        },
      }))
      const { key, bytes } = place(name)
      const { upload, job } = fetch(h, admin.id, dest, key, bytes.length, sha(bytes))
      const done = await waitJob(h.t, job.id)
      expect([done.state, done.error]).toEqual(['done', null])
      expect(offsets).toHaveLength(2)
      expect(offsets[0]).toBe(0)
      expect(offsets[1]).toBeGreaterThan(0)
      expect(offsets[1]).toBeLessThanOrEqual(64 * 1024)
      expect(h.ctx.backup.store.byId(upload.id)).toMatchObject({
        complete: true,
        awaitingVerify: false,
        size: bytes.length,
        sha256: sha(bytes),
      })
      expect(done.progress).toEqual({ done: bytes.length, total: bytes.length })
      expect(h.ctx.backup.transfers.size).toBe(0)
      expect(h.ctx.backup.slots.inUse(dest)).toBe(0)
    } finally {
      await h.t.close()
    }
  })

  it('gives up on a provider that stops sending, and keeps what it received for a later fetch to resume', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('stops')
      let calls = 0
      const dest = await folder(admin, name, () => ({
        get: async (_key, offset) => {
          calls++
          return Readable.from(offset === 0 ? [Buffer.alloc(1000, 7)] : [])
        },
      }))
      const { key, bytes } = place(name)
      const { upload, job, path } = fetch(h, admin.id, dest, key, bytes.length, sha(bytes))
      const done = await waitJob(h.t, job.id)
      expect([done.state, done.error]).toEqual(['failed', 'The destination stopped sending the file'])
      // One answer with bytes, then three retries that bring nothing, then the fourth gives up.
      expect(calls).toBe(5)
      // Final review B26: the bytes received stay (unrestorable, awaiting verification) for a resume.
      expect(h.ctx.backup.store.byId(upload.id)).toMatchObject({
        size: 1000,
        complete: false,
        awaitingVerify: true,
      })
      expect(existsSync(path)).toBe(true)
    } finally {
      await h.t.close()
    }
  })

  // Short names review 6 (M-4): a folder whose name Windows cannot use is refused like any other
  // folder refusal (path): what was received is no part of a later fetch, and is thrown away.
  it('throws away what it received when the folder is refused for its name', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('named')
      const dest = await folder(admin, name, () => ({
        get: async (_key, offset) => {
          if (offset > 0) throw new DestinationError('path_name', 'Windows cannot use "nul" as a folder name')
          return Readable.from([Buffer.alloc(1000, 7)])
        },
      }))
      const { key, bytes } = place(name)
      const { upload, job, path } = fetch(h, admin.id, dest, key, bytes.length, sha(bytes))
      const done = await waitJob(h.t, job.id)
      expect(done.state).toBe('failed')
      expect(h.ctx.backup.store.byId(upload.id)).toBeUndefined()
      expect(existsSync(path)).toBe(false)
    } finally {
      await h.t.close()
    }
  })

  it('does not retry a refusal, and reports it in the provider’s words without its secrets', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const names = { denied: unique('denied'), refused: unique('refused') }
      let calls = 0
      const denied = await folder(admin, names.denied, () => ({
        get: async () => {
          calls++
          throw new DestinationError(
            'forbidden',
            'Denied https://bucket.example/o?X-Amz-Signature=deadbeefcafe password=hunter2',
          )
        },
      }))
      const refused = await folder(admin, names.refused, () => ({
        get: async () => {
          throw new EgressError('address_refused', 'The address is not one the server may reach')
        },
      }))
      const a = place(names.denied)
      const one = fetch(h, admin.id, denied, a.key, a.bytes.length, null)
      const done = await waitJob(h.t, one.job.id)
      expect(done.state).toBe('failed')
      expect(done.error).toMatch(/^Denied https:\/\/bucket\.example\/o/)
      expect(done.error).not.toMatch(/deadbeefcafe|hunter2/)
      expect(calls).toBe(1)
      expect(h.ctx.backup.store.byId(one.upload.id)).toBeUndefined()
      const b = place(names.refused)
      const two = fetch(h, admin.id, refused, b.key, b.bytes.length, null)
      expect(await waitJob(h.t, two.job.id)).toMatchObject({
        state: 'failed',
        error: 'The address is not one the server may reach',
      })
      expect(h.ctx.backup.store.byId(two.upload.id)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('cancels a fetch: the job ends cancelled, the partial upload and its file go, the slot is freed', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('cancel')
      let hang = true
      const dest = await folder(admin, name, (real) => ({
        get: async (key, offset, signal) =>
          hang ? stalled(Buffer.alloc(4096, 1), signal) : real.get(key, offset, signal),
      }))
      const { key, bytes } = place(name)
      const { upload, job, path } = fetch(h, admin.id, dest, key, bytes.length, sha(bytes))
      await until(() => (h.ctx.jobs.get(job.id)!.progress?.done ?? 0) >= 4096)
      expect(h.ctx.backup.store.byId(upload.id)).toMatchObject({ complete: false, awaitingVerify: true })
      expect(await h.ctx.jobs.cancel(job.id)).toBe('cancelled')
      expect(h.ctx.jobs.get(job.id)!.state).toBe('cancelled')
      expect(h.ctx.backup.store.byId(upload.id)).toBeUndefined()
      expect(existsSync(path)).toBe(false)
      expect(h.ctx.backup.transfers.has(job.id)).toBe(false)
      expect(h.ctx.backup.slots.inUse(dest)).toBe(0)
      hang = false
      const again = fetch(h, admin.id, dest, key, bytes.length, sha(bytes))
      expect((await waitJob(h.t, again.job.id)).state).toBe('done')
    } finally {
      await h.t.close()
    }
  })

  // Full server run, 2026-10-20 (an unhandled "aborted" ended the run): the store does not read a
  // part at once (it first removes an empty part's file), and may refuse one unread. A provider
  // stream that failed meanwhile was an uncaught error, which ends the server, and a refused part
  // left the provider's stream open. The attempt fails as any broken one does, and is tried again.
  it('a provider stream that fails before the store reads it fails that attempt only', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('early')
      let first = true
      const dest = await folder(admin, name, (real) => ({
        get: async (key, offset, signal) => {
          if (!first) return real.get(key, offset, signal)
          first = false
          const s = new Readable({ read() {} })
          // Before the store's pipeline is there: it is still removing the empty part's file.
          setImmediate(() => s.destroy(new EgressError('network', 'The connection was reset')))
          return s
        },
      }))
      const { key, bytes } = place(name)
      const { job } = fetch(h, admin.id, dest, key, bytes.length, sha(bytes))
      expect((await waitJob(h.t, job.id)).state).toBe('done')
    } finally {
      await h.t.close()
    }
  })

  it('lets go of the provider stream of a part the store refused unread', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('refused-part')
      const streams: Readable[] = []
      const dest = await folder(admin, name, (real) => ({
        get: async (key, offset, signal) => {
          const s = await real.get(key, offset, signal)
          streams.push(s)
          return s
        },
      }))
      const append = h.ctx.backup.store.appendUpload.bind(h.ctx.backup.store)
      let refuse = true
      vi.spyOn(h.ctx.backup.store, 'appendUpload').mockImplementation(async (input) => {
        if (!refuse) return append(input)
        refuse = false
        throw Errors.conflict('A part of this upload is still being received', { reason: 'upload_busy' })
      })
      const { key, bytes } = place(name)
      const { job } = fetch(h, admin.id, dest, key, bytes.length, sha(bytes))
      await waitJob(h.t, job.id)
      expect(streams.length).toBeGreaterThan(0)
      expect(streams[0]!.destroyed).toBe(true)
    } finally {
      vi.restoreAllMocks()
      await h.t.close()
    }
  })

  it('removes a download whose digest differs, and completes an unverified one with the digest it computed', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('digest')
      const dest = await folder(admin, name)
      const { key, bytes } = place(name)
      const bad = fetch(h, admin.id, dest, key, bytes.length, 'f'.repeat(64))
      expect(await waitJob(h.t, bad.job.id)).toMatchObject({
        state: 'failed',
        error: 'The downloaded file differs from the one that was sent; it was removed',
      })
      expect(h.ctx.backup.store.byId(bad.upload.id)).toBeUndefined()
      expect(existsSync(bad.path)).toBe(false)
      const free = fetch(h, admin.id, dest, key, bytes.length, null)
      expect((await waitJob(h.t, free.job.id)).state).toBe('done')
      expect(h.ctx.backup.store.byId(free.upload.id)).toMatchObject({
        complete: true,
        awaitingVerify: false,
        sha256: sha(bytes),
      })
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('stops when the user discards the download while it is being fetched', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('discard')
      let uploadId = ''
      let calls = 0
      const dest = await folder(admin, name, () => ({
        get: async () => {
          calls++
          return Readable.from(
            (async function* () {
              yield Buffer.alloc(1000, 3)
              const r = await admin.call('DELETE', `/api/backups/uploads/${uploadId}`)
              expect(r.statusCode).toBe(204)
            })(),
          )
        },
      }))
      const { key, bytes } = place(name)
      const { upload, job, path } = fetch(h, admin.id, dest, key, bytes.length, sha(bytes))
      uploadId = upload.id
      expect(await waitJob(h.t, job.id)).toMatchObject({
        state: 'failed',
        error: 'The download was discarded',
      })
      expect(calls).toBe(1)
      expect(h.ctx.backup.store.byId(upload.id)).toBeUndefined()
      // A file still open when it was discarded (Windows) is the sweep's to remove.
      h.ctx.backup.store.sweep()
      expect(existsSync(path)).toBe(false)
    } finally {
      await h.t.close()
    }
  })

  it('fails at once when the destination was deleted or the download discarded', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('vanish')
      const dest = await folder(admin, name)
      const { key, bytes } = place(name)
      expect((await admin.call('DELETE', `/api/backup-destinations/${dest}`)).statusCode).toBe(204)
      const orphan = fetch(h, admin.id, dest, key, bytes.length, null)
      expect(await waitJob(h.t, orphan.job.id)).toMatchObject({
        state: 'failed',
        error: 'The destination was deleted',
      })
      expect(h.ctx.backup.store.byId(orphan.upload.id)).toBeUndefined()

      const live = await folder(admin, unique('live'))
      const upload = h.ctx.backup.store.createUpload({
        owner: admin.id,
        name: 'x',
        size: 10,
        awaitingVerify: true,
      })
      h.ctx.backup.store.delete(admin.id, upload.id)
      const job = h.ctx.jobs.start(
        h.ctx.jobKinds['backup.fetch'],
        { userId: admin.id, connectionId: h.ids.B, db: '*', coll: '*', target: 'x' },
        {
          owner: admin.id,
          userId: admin.id,
          destinationId: live,
          key,
          uploadId: upload.id,
          expectSha256: null,
          size: 10,
        },
      )
      expect(await waitJob(h.t, job.id)).toMatchObject({
        state: 'failed',
        error: 'The download was discarded',
      })
      expect(h.ctx.backup.slots.inUse(live)).toBe(0)
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('who may fetch what (phase 3d-3b spec §4.3, §7.6, D8)', () => {
  it('lets a send-level user fetch only the copies they sent', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor', B: 'editor' } })
      const v = h.user({ on: { A: 'editor', B: 'editor' } })
      const name = unique('send-level')
      const dest = await folder(admin, name)
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [
          { userId: u.id, level: 'send' },
          { userId: v.id, level: 'send' },
        ],
      })
      // u's backup, sent by u.
      const meta: BackupMeta = {
        scope: { kind: 'database', db: 'shop', views: true },
        engine: 'builtin',
        format: 'mmbak',
        masked: false,
        anonymous: false,
        namespaces: 1,
        startedAt: 0,
        finishedAt: null,
        rulesVersion: 0,
      }
      const { row, path } = h.ctx.backup.store.reserveBackup({
        owner: u.id,
        jobId: 'seed',
        connectionId: h.ids.A,
        name: 'shop.mmbak',
        meta,
      })
      const bytes = randomBytes(50_000)
      writeFileSync(path, bytes)
      h.ctx.backup.store.completeBackup(row.id, { size: bytes.length, sha256: sha(bytes), finishedAt: 1 })
      const res = await u.call('POST', `/api/backups/${row.id}/send`, { destinationIds: [dest] })
      expect(res.statusCode, res.body).toBe(202)
      expect((await waitJob(h.t, res.json().job.id)).state).toBe('done')
      const copy = h.ctx.backup.copies.forBackupOn(row.id, dest)!
      const foreign = place(name, randomBytes(1000), true)

      const ask = (who: U, key: string) =>
        who.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, { connectionId: h.ids.B, key })
      const usage = () => h.ctx.backup.store.usage(v.id)
      expect((await ask(v, copy.remoteKey)).statusCode).toBe(404)
      expect((await ask(v, foreign.key)).statusCode).toBe(404)
      expect((await ask(u, foreign.key)).statusCode).toBe(404)
      expect(usage()).toBe(0)
      const mine = await ask(u, copy.remoteKey)
      expect(mine.statusCode, mine.body).toBe(202)
      expect((await waitJob(h.t, mine.json().job.id)).state).toBe('done')
      expect(h.ctx.backup.store.byId(mine.json().uploadId)).toMatchObject({
        owner: u.id,
        complete: true,
        sha256: copy.sha256,
      })
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it(`refuses a fetch past ${MAX_BACKUP_JOBS} running backup jobs, before any space is reserved`, async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('busy')
      const dest = await folder(admin, name, () => ({
        get: async (_key, _offset, signal) => stalled(Buffer.alloc(10, 1), signal),
      }))
      const ask = (key: string) =>
        admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, { connectionId: h.ids.B, key })
      const jobs: string[] = []
      for (let i = 0; i < MAX_BACKUP_JOBS; i++) {
        const r = await ask(place(name, randomBytes(1000), true).key)
        expect(r.statusCode, r.body).toBe(202)
        jobs.push(r.json().job.id)
      }
      const reserved = h.ctx.backup.store.usage(admin.id)
      const busy = await ask(place(name, randomBytes(1000), true).key)
      expect([busy.statusCode, busy.json().details?.reason]).toEqual([409, 'backup_busy'])
      expect(h.ctx.backup.store.usage(admin.id)).toBe(reserved)
      for (const id of jobs) expect(await h.ctx.jobs.cancel(id)).toBe('cancelled')
      expect(h.ctx.backup.store.usage(admin.id)).toBe(0)
    } finally {
      await h.t.close()
    }
  })
})

describe('fetched uploads in the store (phase 3d-3b plan ruling 3)', () => {
  let dir: string
  let db: Store
  let store: BackupStore
  let now = 1_000_000
  const limits = () => ({
    ...backupLimits(resolveConfig({ cli: { dataDir: dir } })),
    quota: 1 << 20,
    totalQuota: 1 << 21,
  })
  const body = (n: number, fill = 1) => Readable.from([Buffer.alloc(n, fill)])
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mm-fetch-store-'))
    db = await openStore(join(dir, 'mm.db'))
    store = new BackupStore(db.db, join(dir, 'backups'), limits(), () => now)
    store.init()
  })
  afterEach(() => {
    store.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('takes parts of a fetched upload from its job only, and completes it only once the digest matched', async () => {
    const up = store.createUpload({ owner: 'u1', name: 'f', size: 10, awaitingVerify: true })
    await expect(
      store.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(10) }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'upload_fetching' },
    })
    await expect(
      store.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(10), byJob: true }),
    ).resolves.toEqual({ received: 10, complete: false })
    expect(store.byId(up.id)).toMatchObject({ complete: false, awaitingVerify: true, sha256: null })
    const woke = store.waitForGrowth(up.id, new AbortController().signal, 5_000)
    now += 1_000
    store.finishFetched(up.id, 'a'.repeat(64))
    await expect(woke).resolves.toBe(true)
    expect(store.byId(up.id)).toMatchObject({
      complete: true,
      awaitingVerify: false,
      sha256: 'a'.repeat(64),
      expiresAt: now + limits().ttlMs,
    })
    await expect(
      store.appendUpload({ owner: 'u1', id: up.id, offset: 10, body: body(1), byJob: true }),
    ).rejects.toMatchObject({ details: { reason: 'upload_complete' } })
  })

  it('accepts the first bytes at offset 0 after a first part that carried none', async () => {
    const up = store.createUpload({ owner: 'u1', name: 'f', size: 10 })
    await expect(store.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(0) })).resolves.toEqual({
      received: 0,
      complete: false,
    })
    await expect(store.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(10) })).resolves.toEqual({
      received: 10,
      complete: true,
    })
  })

  it('lets a client resume at offset 0 after its first part broke before any byte arrived', async () => {
    const up = store.createUpload({ owner: 'u1', name: 'f', size: 10 })
    const broken = new Readable({ read() {} })
    setTimeout(() => broken.destroy(new Error('client went away')), 10)
    await expect(
      store.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: broken }),
    ).rejects.toMatchObject({
      details: { reason: 'upload_aborted' },
    })
    expect(store.byId(up.id)!.size).toBe(0)
    await expect(store.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(10) })).resolves.toEqual({
      received: 10,
      complete: true,
    })
  })

  // CI 2026-10-21 (Windows, full server run): a first part clears its empty file before it reads, and
  // a body that broke in that gap had no one listening for its error — an uncaught error, which ends
  // the server. The store listens from the moment it is handed the body.
  it('a body that breaks before the store reads it is a part that did not complete, not an uncaught error', async () => {
    const up = store.createUpload({ owner: 'u1', name: 'f', size: 10 })
    const broken = new Readable({ read() {} })
    const part = store.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: broken })
    broken.destroy(new Error('client went away'))
    await expect(part).rejects.toMatchObject({ details: { reason: 'upload_aborted' } })
    expect(store.byId(up.id)!.size).toBe(0)
  })

  it('keeps the bytes of a part that broke midway, so the client resumes after them', async () => {
    const up = store.createUpload({ owner: 'u1', name: 'f', size: 100 })
    // Full server run, 2026-10-21: a fixed 20 ms was not always enough, under load, for the 40
    // bytes to reach the file (bytes not yet written are not kept, and the client resumes before
    // them). It breaks once they are on disk.
    const path = store.pathOf(store.byId(up.id)!)
    const broken = Readable.from(
      (async function* () {
        yield Buffer.alloc(40, 1)
        for (let i = 0; i < 500; i++) {
          if (existsSync(path) && statSync(path).size >= 40) break
          await new Promise((r) => setTimeout(r, 10))
        }
        throw new Error('client went away')
      })(),
    )
    await expect(
      store.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: broken }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { reason: 'upload_aborted' },
    })
    expect(store.byId(up.id)!.size, 'the 40 bytes on disk before the break').toBe(40)
    await expect(
      store.appendUpload({ owner: 'u1', id: up.id, offset: 40, body: body(60, 2) }),
    ).resolves.toEqual({ received: 100, complete: true })
  })

  it('finds nothing by a malformed id, and never builds a path from one', async () => {
    const up = store.createUpload({ owner: 'u1', name: 'f', size: 10 })
    for (const id of ['../u2/x', `${up.id}/../../x`, ''])
      await expect(store.appendUpload({ owner: 'u1', id, offset: 0, body: body(1) })).rejects.toMatchObject({
        statusCode: 404,
      })
    expect(store.get('u1', '..')).toBeUndefined()
    expect(() => store.pathOf({ ...up, id: '../../etc/passwd' })).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    )
    // A kept backup is not an upload: no part goes into it.
    const { row } = store.reserveBackup({ owner: 'u1', jobId: 'j', connectionId: 'c', name: 'b', meta: null })
    await expect(
      store.appendUpload({ owner: 'u1', id: row.id, offset: 0, body: body(1) }),
    ).rejects.toMatchObject({
      statusCode: 404,
    })
    await expect(store.openRead(row)).rejects.toMatchObject({ statusCode: 404 })
    // Completing a row that is gone changes nothing.
    store.completeBackup(randomUUID(), { size: 1, sha256: 'a'.repeat(64), finishedAt: 1 })
    expect(store.list('u1', {})).toEqual([])
  })

  it('gives a display name only, never empty and never with control characters', () => {
    expect(store.createUpload({ owner: 'u1', name: '\u0000\u001f\u007f', size: 1 }).name).toBe('backup')
    expect(store.createUpload({ owner: 'u1', name: 'a\nb\tc', size: 1 }).name).toBe('abc')
    expect(store.createUpload({ owner: 'u1', name: 'x'.repeat(400), size: 1 }).name).toHaveLength(255)
  })

  it('detaches the copies of every backup of an owner it deletes, and leaves other owners alone', () => {
    const box = createSecretBox(randomBytes(32))
    const destinations = new DestinationRepo(db.db, box, () => now)
    const copies = new CopyRepo(db.db, box, () => now)
    const dest = destinations.create({
      name: 'd',
      type: 'folder',
      config: { path: join(dir, 'x') },
      secrets: {},
      policy: { encryptedOnly: true } as never,
      createdBy: null,
    })
    const backup = (owner: string) => {
      const { row, path } = store.reserveBackup({
        owner,
        jobId: 'j',
        connectionId: 'c',
        name: 'b',
        meta: null,
      })
      writeFileSync(path, 'x')
      store.completeBackup(row.id, { size: 1, sha256: 'a'.repeat(64), finishedAt: 1 })
      const copy = copies.create({
        destinationId: dest.id,
        backupId: row.id,
        remoteKey: remoteKeyFor('', 'mmbak', row.id, now),
        owner,
        connectionId: 'c',
        meta: null,
        format: 'mmbak',
        size: 1,
        sha256: 'a'.repeat(64),
        md5: null,
      })
      return { row, path, copy }
    }
    const mine = [backup('u1'), backup('u1')]
    const theirs = backup('u2')
    const upload = store.createUpload({ owner: 'u1', name: 'f', size: 10 })
    store.deleteAllFor('u1')
    for (const m of mine) {
      expect(store.byId(m.row.id)).toBeUndefined()
      expect(existsSync(m.path)).toBe(false)
      expect(copies.get(m.copy.id)).toMatchObject({ backupId: null, owner: 'u1' })
    }
    expect(store.byId(upload.id)).toBeUndefined()
    expect(store.byId(theirs.row.id)).toBeDefined()
    expect(copies.get(theirs.copy.id)!.backupId).toBe(theirs.row.id)
  })

  it('sweeps owner directories that are not safe names, and stray entries at the root', () => {
    const kept = store.createUpload({ owner: 'u1', name: 'f', size: 10 })
    mkdirSync(join(dir, 'backups', 'bad owner'))
    writeFileSync(join(dir, 'backups', 'bad owner', `${randomUUID()}.upload`), 'x')
    writeFileSync(join(dir, 'backups', 'stray-file'), 'x')
    writeFileSync(join(dir, 'backups', 'u1', `${randomUUID()}.upload`), 'orphan')
    store.sweep()
    expect(readdirSync(join(dir, 'backups')).sort()).toEqual(['u1'])
    expect(readdirSync(join(dir, 'backups', 'u1'))).toEqual([])
    expect(store.byId(kept.id)).toBeDefined()
    // A store whose root is gone sweeps rows and stops there.
    rmSync(join(dir, 'backups'), { recursive: true, force: true })
    now += 365 * 86_400_000
    expect(() => store.sweep()).not.toThrow()
    expect(store.byId(kept.id)).toBeUndefined()
  })
})
