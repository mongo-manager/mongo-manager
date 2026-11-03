import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { JobRepo } from '../src/jobs/repo'
import type { JobRecord } from '../src/jobs/types'
import { toView } from '../src/jobs/visibility'
import type { BackupMeta } from '../src/backup/store'
import { DestinationError, type DestinationAdapter } from '../src/backup/destinations/types'
import { buildManifest, remoteKeyFor } from '../src/backup/destinations/layout'
import { sweepStaleCopies } from '../src/backup/send-job'
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

const nowhere: TestMongo = { host: '127.0.0.1', port: 1, stop: async () => undefined }
let base: string
const root = () => join(base, 'root')
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mm-backup-final-'))
  mkdirSync(root())
})
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})
afterEach(() => hooks.wrap.clear())

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
const harness = (backup: Record<string, unknown> = {}) =>
  backupHarness(nowhere, nowhere, {
    backup: { folderRoots: [root()], privateNetworks: ['127.0.0.1/32'], ...backup },
  } as never)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
let seq = 0
const unique = (name: string) => `${name}-${++seq}`

const metaOf = (over: Partial<BackupMeta> = {}): BackupMeta => ({
  scope: { kind: 'database', db: 'shop', views: true },
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

function keep(h: H, owner: string, over: Partial<BackupMeta> = {}, bytes = randomBytes(200_000)) {
  const { row, path } = h.ctx.backup.store.reserveBackup({
    owner,
    jobId: 'seed',
    connectionId: h.ids.A,
    name: 'shop.mmbak',
    meta: metaOf(over),
  })
  writeFileSync(path, bytes)
  h.ctx.backup.store.completeBackup(row.id, { size: bytes.length, sha256: sha(bytes), finishedAt: 1 })
  return { id: row.id, bytes, path }
}

async function folder(admin: U, name: string, wrap?: Wrap, policy = { encryptedOnly: false }) {
  if (wrap) hooks.wrap.set(name, wrap)
  const r = await admin.call('POST', '/api/backup-destinations', {
    type: 'folder',
    name,
    config: { path: join(root(), name) },
    policy,
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}
const remotePath = (name: string, key: string) => join(root(), name, ...key.split('/'))
const send = (u: U, backupId: string, destinationIds: string[], deleteLocal = false) =>
  u.call('POST', `/api/backups/${backupId}/send`, { destinationIds, deleteLocal })
async function sent(h: H, u: U, backupId: string, destinationIds: string[], deleteLocal = false) {
  const res = await send(u, backupId, destinationIds, deleteLocal)
  expect(res.statusCode, res.body).toBe(202)
  return waitJob(h.t, res.json().job.id, 30_000)
}
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
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const runningRecord = (h: H, kind: 'backup.send' | 'backup.fetch'): JobRecord => ({
  id: randomUUID(),
  kind,
  userId: null,
  connectionId: h.ids.A,
  targetConnectionId: null,
  db: '*',
  coll: '*',
  target: 'x',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  staging: null,
  stagingConnectionId: null,
  stagingDb: null,
  startedAt: h.t.clock.now,
  finishedAt: null,
})
/** An object in a destination's layout, as another installation left it. */
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
  return { key, bytes, path }
}

describe('a restart cuts a send off (final review B1)', () => {
  it('fails the copies it was sending, keeps their resume state, and Retry and Discard then work', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const seen: unknown[] = []
      const resumed = await folder(admin, unique('resumed'), (real) => ({
        put: async (key, file, resume, io, signal) => {
          seen.push(resume)
          return real.put(key, file, resume, io, signal)
        },
      }))
      const discarded = await folder(admin, unique('discarded'))
      const b = keep(h, admin.id)
      const copyOn = (destinationId: string) => {
        const c = h.ctx.backup.copies.create({
          destinationId,
          backupId: b.id,
          remoteKey: remoteKeyFor('', 'mmbak', b.id, Date.UTC(2026, 0, 1)),
          owner: admin.id,
          connectionId: h.ids.A,
          meta: metaOf(),
          format: 'mmbak',
          size: b.bytes.length,
          sha256: sha(b.bytes),
          md5: null,
        })
        h.ctx.backup.copies.setResume(c.id, { key: c.remoteKey, part: 3 })
        return c
      }
      const one = copyOn(resumed)
      const two = copyOn(discarded)
      // The previous process left its send job running; this one settles it at start.
      new JobRepo(h.ctx.store.db).insert(runningRecord(h, 'backup.send'))
      h.ctx.jobs.recover(h.ctx.jobKinds)
      for (const c of [one, two]) {
        expect(h.ctx.backup.copies.get(c.id)).toMatchObject({ state: 'failed' })
        expect(h.ctx.backup.copies.resume(c.id)).toEqual({ key: c.remoteKey, part: 3 })
      }
      const retry = await admin.call('POST', `/api/backup-copies/${one.id}/retry`)
      expect(retry.statusCode, retry.body).toBe(202)
      expect((await waitJob(h.t, retry.json().job.id)).state).toBe('done')
      expect(seen).toEqual([{ key: one.remoteKey, part: 3 }])
      expect((await admin.call('DELETE', `/api/backup-copies/${two.id}`)).statusCode).toBe(204)
      expect(h.ctx.backup.copies.get(two.id)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })

  it('leaves a copy that a running send is still sending', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const hold = gate()
      const dest = await folder(admin, unique('busy'), (real) => ({
        put: async (key, file, resume, io, signal) => {
          await hold.wait(signal)
          return real.put(key, file, resume, io, signal)
        },
      }))
      const b = keep(h, admin.id)
      const res = await send(admin, b.id, [dest])
      await until(() => h.ctx.backup.copies.forBackupOn(b.id, dest)?.state === 'sending')
      h.ctx.jobs.recover(h.ctx.jobKinds)
      expect(h.ctx.backup.copies.forBackupOn(b.id, dest)!.state).toBe('sending')
      hold.open()
      expect((await waitJob(h.t, res.json().job.id)).state).toBe('done')
    } finally {
      await h.t.close()
    }
  })
})

describe('an object left at the key (final review B2)', () => {
  it('a retry after a failed manifest write re-verifies the object there and completes', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      let manifestFails = true
      const reads: number[] = []
      const name = unique('left')
      const dest = await folder(admin, name, (real) => ({
        get: (...a) => (reads.push(a[1]), real.get(...a)),
        putSmall: async (...a) => {
          if (manifestFails) throw new DestinationError('quota', 'The destination is full')
          return real.putSmall(...a)
        },
      }))
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [dest])).state).toBe('failed')
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      expect(existsSync(remotePath(name, copy.remoteKey))).toBe(true)
      manifestFails = false
      reads.length = 0
      const retry = await admin.call('POST', `/api/backup-copies/${copy.id}/retry`)
      expect(retry.statusCode, retry.body).toBe(202)
      const job = await waitJob(h.t, retry.json().job.id)
      expect([job.state, job.error]).toEqual(['done', null])
      expect(reads).toEqual([0])
      expect(h.ctx.backup.copies.get(copy.id)!.state).toBe('complete')
      expect(existsSync(`${remotePath(name, copy.remoteKey)}.json`)).toBe(true)
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('reads a left object back even where the destination does not, and refuses one that differs', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      let manifestFails = true
      const name = unique('swapped')
      const dest = await folder(admin, name, (real) => ({
        readBack: false,
        putSmall: async (...a) => {
          if (manifestFails) throw new DestinationError('quota', 'The destination is full')
          return real.putSmall(...a)
        },
      }))
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [dest])).state).toBe('failed')
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      // Someone swaps the object for another of the same size.
      const path = remotePath(name, copy.remoteKey)
      writeFileSync(path, randomBytes(b.bytes.length))
      manifestFails = false
      const retry = await admin.call('POST', `/api/backup-copies/${copy.id}/retry`)
      const job = await waitJob(h.t, retry.json().job.id)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/read back differs/)
      expect(existsSync(`${path}.json`)).toBe(false)
      // The object that failed was removed: the next retry writes the real one.
      const again = await admin.call('POST', `/api/backup-copies/${copy.id}/retry`)
      expect((await waitJob(h.t, again.json().job.id)).state).toBe('done')
      expect(sha(readFileSync(path))).toBe(sha(b.bytes))
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('a discarded copy can be sent again to the same key', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      let manifestFails = true
      const name = unique('discard-again')
      const dest = await folder(admin, name, (real) => ({
        putSmall: async (...a) => {
          if (manifestFails) throw new DestinationError('quota', 'The destination is full')
          return real.putSmall(...a)
        },
      }))
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [dest])).state).toBe('failed')
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      expect((await admin.call('DELETE', `/api/backup-copies/${copy.id}`)).statusCode).toBe(204)
      manifestFails = false
      const job = await sent(h, admin, b.id, [dest])
      expect([job.state, job.error]).toEqual(['done', null])
      expect(h.ctx.backup.copies.forBackupOn(b.id, dest)!.state).toBe('complete')
    } finally {
      await h.t.close()
    }
  }, 90_000)
})

describe('complete copies are checked before they are trusted (final review B7, B30)', () => {
  it('sends again when a complete copy is no longer at the destination, before deleting the local copy', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('vanished')
      const dest = await folder(admin, name)
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [dest])).state).toBe('done')
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      unlinkSync(remotePath(name, copy.remoteKey))
      const job = await sent(h, admin, b.id, [dest], true)
      expect(job.state).toBe('done')
      expect(sha(readFileSync(remotePath(name, copy.remoteKey)))).toBe(sha(b.bytes))
      expect(h.ctx.backup.store.byId(b.id)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('forgets the copies of a destination that now points elsewhere, so nothing trusts or retries them', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      let fail = false
      const name = unique('moved')
      const dest = await folder(admin, name, (real) => ({
        put: async (...a) => {
          if (fail) throw new DestinationError('provider', 'Nope')
          return real.put(...a)
        },
      }))
      const b1 = keep(h, admin.id)
      expect((await sent(h, admin, b1.id, [dest])).state).toBe('done')
      fail = true
      const b2 = keep(h, admin.id)
      expect((await sent(h, admin, b2.id, [dest])).state).toBe('failed')
      const failed = h.ctx.backup.copies.forBackupOn(b2.id, dest)!
      const moved = await admin.call('PATCH', `/api/backup-destinations/${dest}`, {
        config: { path: join(root(), unique('elsewhere')) },
      })
      expect(moved.statusCode, moved.body).toBe(200)
      expect(h.ctx.backup.copies.byDestination(dest)).toEqual([])
      const views = (await admin.get('/api/backups')).json() as Array<{ id: string; copies: unknown[] }>
      expect(views.find((v) => v.id === b1.id)!.copies).toEqual([])
      // B30: a retry of a copy made where the destination no longer points is refused cleanly.
      const retry = await admin.call('POST', `/api/backup-copies/${failed.id}/retry`)
      expect(retry.statusCode).toBe(404)
      // Sending again goes to the new place, with deleteLocal only after it verified there.
      fail = false
      expect((await sent(h, admin, b1.id, [dest], true)).state).toBe('done')
      expect(h.ctx.backup.store.byId(b1.id)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 120_000)

  it('forgets copies when an S3 prefix changes, even with the same address', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const created = await admin.call('POST', '/api/backup-destinations', {
        type: 's3',
        name: unique('bucket'),
        config: {
          preset: 'aws',
          endpoint: 'https://s3.eu-west-1.amazonaws.com',
          region: 'eu-west-1',
          bucket: 'mm-test',
          prefix: 'one',
        },
        secrets: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-secret' },
      })
      expect(created.statusCode, created.body).toBe(201)
      const dest = created.json().id as string
      const b = keep(h, admin.id)
      const c = h.ctx.backup.copies.create({
        destinationId: dest,
        backupId: b.id,
        remoteKey: remoteKeyFor('one', 'mmbak', b.id, Date.UTC(2026, 0, 1)),
        owner: admin.id,
        connectionId: h.ids.A,
        meta: metaOf(),
        format: 'mmbak',
        size: b.bytes.length,
        sha256: sha(b.bytes),
        md5: null,
      })
      h.ctx.backup.copies.complete(c.id, null)
      const same = await admin.call('PATCH', `/api/backup-destinations/${dest}`, { name: unique('renamed') })
      expect(same.statusCode).toBe(200)
      expect(h.ctx.backup.copies.get(c.id)).toBeDefined()
      const moved = await admin.call('PATCH', `/api/backup-destinations/${dest}`, {
        config: { prefix: 'two' },
      })
      expect(moved.statusCode, moved.body).toBe(200)
      expect(h.ctx.backup.copies.get(c.id)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })
})

describe('one send per backup and destination (final review B8)', () => {
  it('refuses a second send of the same backup to a destination while the first runs', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const hold = gate()
      const slow = await folder(admin, unique('double'), (real) => ({
        put: async (key, file, resume, io, signal) => {
          await hold.wait(signal)
          return real.put(key, file, resume, io, signal)
        },
      }))
      const other = await folder(admin, unique('other'))
      const b = keep(h, admin.id)
      const first = await send(admin, b.id, [slow])
      expect(first.statusCode).toBe(202)
      const second = await send(admin, b.id, [other, slow])
      expect([second.statusCode, second.json().details?.reason]).toEqual([409, 'copy_sending'])
      // Another destination, or another backup, is fine.
      expect((await sent(h, admin, b.id, [other])).state).toBe('done')
      hold.open()
      expect((await waitJob(h.t, first.json().job.id)).state).toBe('done')
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('the job time limit and the sweeper (final review B9)', () => {
  it('stops a send that runs longer than MM_BACKUP_MAX_JOB_HOURS allows', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(admin, unique('forever'), () => ({
        put: (_k, _f, _r, _io, signal) =>
          new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      }))
      const b = keep(h, admin.id)
      h.ctx.backup.limits.maxJobMs = 300
      const job = await sent(h, admin, b.id, [dest], true)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/longer than allowed/)
      expect(h.ctx.backup.copies.forBackupOn(b.id, dest)!.state).toBe('failed')
      expect(h.ctx.backup.store.byId(b.id)).toBeDefined()
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('stops a fetch that runs longer than allowed', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('slow-fetch')
      const dest = await folder(admin, name, () => ({
        get: async (_k, _o, signal) => {
          const s = new Readable({ read() {} })
          s.push(Buffer.alloc(10))
          signal.addEventListener('abort', () => s.destroy(new Error('aborted')), { once: true })
          return s
        },
      }))
      const placed = place(name)
      h.ctx.backup.limits.maxJobMs = 300
      const res = await admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
        connectionId: h.ids.B,
        key: placed.key,
      })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/longer than allowed/)
    } finally {
      await h.t.close()
    }
  })

  it('never sweeps the backup a send reads, nor the upload a fetch writes, while they run', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const hold = gate()
      const name = unique('pinned')
      const dest = await folder(admin, name, (real) => ({
        put: async (key, file, resume, io, signal) => {
          await hold.wait(signal)
          return real.put(key, file, resume, io, signal)
        },
        get: async (key, offset, signal) => {
          await hold.wait(signal)
          return real.get(key, offset, signal)
        },
      }))
      const b = keep(h, admin.id)
      const s = await send(admin, b.id, [dest])
      const placed = place(name)
      const f = await admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
        connectionId: h.ids.B,
        key: placed.key,
      })
      expect(f.statusCode, f.body).toBe(202)
      await until(() => h.ctx.backup.transfers.size === 2)
      h.t.clock.now += 100 * 3600_000
      h.ctx.backup.store.sweep()
      expect(h.ctx.backup.store.byId(b.id)).toBeDefined()
      expect(h.ctx.backup.store.byId(f.json().uploadId)).toBeDefined()
      hold.open()
      expect((await waitJob(h.t, s.json().job.id)).state).toBe('done')
      expect((await waitJob(h.t, f.json().job.id)).state).toBe('done')
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('what a send or fetch job says (final review B11, B12, B29)', () => {
  it('shows "waiting for the destination" while every transfer slot is taken', async () => {
    const h = await harness({ destTransfers: 1 })
    try {
      const admin = h.user({ role: 'admin' })
      const hold = gate()
      const name = unique('one-slot')
      const dest = await folder(admin, name, (real) => ({
        put: async (key, file, resume, io, signal) => {
          await hold.wait(signal)
          return real.put(key, file, resume, io, signal)
        },
      }))
      const first = await send(admin, keep(h, admin.id).id, [dest])
      await until(() => h.ctx.backup.slots.inUse(dest) === 1)
      const second = await send(admin, keep(h, admin.id).id, [dest])
      const viewOf = (id: string) =>
        toView(h.ctx, { kind: 'user', userId: admin.id, role: 'admin' } as never, h.ctx.jobs.get(id)!)
      await until(() => (viewOf(second.json().job.id).waitingFor ?? []).length > 0)
      expect(viewOf(second.json().job.id).waitingFor).toEqual([name])
      expect(viewOf(first.json().job.id).waitingFor).toBeUndefined()
      // The waiting state reaches the REST view too.
      expect((await admin.get(`/api/jobs/${second.json().job.id}`)).json().job.waitingFor).toEqual([name])
      hold.open()
      await waitJob(h.t, first.json().job.id)
      await waitJob(h.t, second.json().job.id)
      expect(viewOf(second.json().job.id).waitingFor).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('says the local copy was kept when a destination failed under "delete the local copy"', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const bad = await folder(admin, unique('bad'), () => ({
        put: async () => {
          throw new DestinationError('provider', 'Nope')
        },
      }))
      const good = await folder(admin, unique('good'))
      const b = keep(h, admin.id)
      const job = await sent(h, admin, b.id, [bad, good], true)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/The local copy was kept for 7 days/)
      const view = (await admin.get(`/api/jobs/${job.id}`)).json().job
      expect(view.localKept).toBe(true)
      // Backup review M12: kept for as long as the send can be retried — it was the only copy, and
      // the normal time to live (a day) deleted it while the destination still had nothing.
      const row = h.ctx.backup.store.get(admin.id, b.id)!
      expect(row.expiresAt).toBeGreaterThanOrEqual(h.ctx.now() + 7 * 86_400_000 - 60_000)
      // Without "delete the local copy" there is nothing to say.
      const plain = await sent(h, admin, keep(h, admin.id).id, [bad])
      expect(plain.error).not.toMatch(/local copy/)
      expect((await admin.get(`/api/jobs/${plain.id}`)).json().job.localKept).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('tells whether a fetched file can be verified (a foreign file without a manifest cannot)', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('verified')
      const dest = await folder(admin, name)
      const foreign = place(name)
      const signed = place(name, randomBytes(1000), true)
      const start = (key: string) =>
        admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, { connectionId: h.ids.B, key })
      const a = await start(foreign.key)
      const b = await start(signed.key)
      expect([a.statusCode, b.statusCode]).toEqual([202, 202])
      expect([a.json().verified, b.json().verified]).toEqual([false, true])
      await waitJob(h.t, a.json().job.id)
      await waitJob(h.t, b.json().job.id)
      expect((await admin.get(`/api/jobs/${a.json().job.id}`)).json().job.verified).toBe(false)
      expect((await admin.get(`/api/jobs/${b.json().job.id}`)).json().job.verified).toBe(true)
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('cancel and retry (final review B13, B14)', () => {
  it('a send cancelled during its read-back neither completes nor deletes the local copy', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      let reading = false
      const dest = await folder(admin, unique('read-cancel'), (real) => ({
        // A stream that does not stop by itself when the job is cancelled.
        get: async (key, offset, signal) => {
          const all: Buffer[] = []
          for await (const c of await real.get(key, offset, signal)) all.push(c as Buffer)
          const body = Buffer.concat(all)
          reading = true
          return Readable.from(
            (async function* () {
              yield body.subarray(0, 1000)
              await new Promise((r) => signal.addEventListener('abort', r, { once: true }))
              yield body.subarray(1000)
            })(),
          )
        },
      }))
      const b = keep(h, admin.id)
      const res = await send(admin, b.id, [dest], true)
      await until(() => reading)
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      await h.ctx.jobs.cancel(res.json().job.id)
      const job = await waitJob(h.t, res.json().job.id)
      expect(job.state).toBe('cancelled')
      expect(h.ctx.backup.copies.get(copy.id)!.state).not.toBe('complete')
      expect(h.ctx.backup.store.byId(b.id)).toBeDefined()
      expect(existsSync(b.path)).toBe(true)
    } finally {
      await h.t.close()
    }
  })

  it('a retry keeps the original send’s "delete the local copy", once every destination of it is complete', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      let fail = true
      const flaky = await folder(admin, unique('flaky'), (real) => ({
        put: async (...a) => {
          if (fail) throw new DestinationError('network', 'The connection dropped')
          return real.put(...a)
        },
      }))
      const steady = await folder(admin, unique('steady'))
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [flaky, steady], true)).state).toBe('failed')
      expect(h.ctx.backup.store.byId(b.id)).toBeDefined()
      fail = false
      const copy = h.ctx.backup.copies.forBackupOn(b.id, flaky)!
      const retry = await admin.call('POST', `/api/backup-copies/${copy.id}/retry`)
      expect(retry.statusCode, retry.body).toBe(202)
      expect((await waitJob(h.t, retry.json().job.id)).state).toBe('done')
      expect(h.ctx.backup.store.byId(b.id)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('policy changes reach running sends (final review B21, B6)', () => {
  it('turning encrypted-only on stops a plain send there and lets the others finish', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const hold = gate()
      const strict = await folder(admin, unique('strict'), (real) => ({
        put: async (key, file, resume, io, signal) => {
          await hold.wait(signal)
          return real.put(key, file, resume, io, signal)
        },
      }))
      const open = await folder(admin, unique('open'))
      const b = keep(h, admin.id, { format: 'gzip', personal: false })
      const res = await send(admin, b.id, [strict, open])
      await until(() => h.ctx.backup.copies.forBackupOn(b.id, open)?.state === 'complete')
      const patch = await admin.call('PATCH', `/api/backup-destinations/${strict}`, {
        policy: { encryptedOnly: true },
      })
      expect(patch.statusCode, patch.body).toBe(200)
      const job = await waitJob(h.t, res.json().job.id)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/encrypted backups only/)
      expect(h.ctx.backup.copies.forBackupOn(b.id, strict)!.state).toBe('failed')
      expect(h.ctx.backup.copies.forBackupOn(b.id, open)!.state).toBe('complete')
    } finally {
      await h.t.close()
    }
  })

  it('counts a plain unmasked backup as personal once the rules moved since it was made', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(admin, unique('rules'))
      const version = h.ctx.personalFields.get(h.ids.A).version
      const b = keep(h, admin.id, { format: 'gzip', personal: false, rulesVersion: version })
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const res = await send(admin, b.id, [dest])
      expect([res.statusCode, res.json().details?.reason]).toEqual([409, 'destination_personal_plain'])
      // A masked one is the 3d-3a withdrawal's business; an encrypted one goes anywhere.
      const enc = keep(h, admin.id, { format: 'mmbak', personal: false, rulesVersion: version })
      expect((await sent(h, admin, enc.id, [dest])).state).toBe('done')
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('fetch refusals, failures and resumes (final review B24, B26)', () => {
  it('refuses to fetch a copy that is still sending or failed', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      // The object is there, its manifest is not: the copy failed after the upload.
      const dest = await folder(admin, unique('incomplete'), () => ({
        putSmall: async () => {
          throw new DestinationError('quota', 'The destination is full')
        },
      }))
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [dest])).state).toBe('failed')
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      const res = await admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
        connectionId: h.ids.B,
        key: copy.remoteKey,
      })
      expect([res.statusCode, res.json().details?.reason]).toEqual([409, 'copy_incomplete'])
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('keeps a failed download, and a new fetch of the same file by the same user resumes it', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const other = h.user({ role: 'admin' })
      const name = unique('resume-fetch')
      const offsets: number[] = []
      let broken = true
      const dest = await folder(admin, name, (real) => ({
        get: async (key, offset, signal) => {
          offsets.push(offset)
          if (!broken) return real.get(key, offset, signal)
          if (offset > 0) throw new DestinationError('forbidden', 'Access was withdrawn')
          const all: Buffer[] = []
          for await (const c of await real.get(key, offset, signal)) all.push(c as Buffer)
          return Readable.from(
            (async function* () {
              yield Buffer.concat(all).subarray(0, 50_000)
              await new Promise((r) => setTimeout(r, 50))
              throw new DestinationError('network', 'The connection dropped')
            })(),
          )
        },
      }))
      const placed = place(name, randomBytes(200_000), true)
      const start = (u: U) =>
        u.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
          connectionId: h.ids.B,
          key: placed.key,
        })
      const first = await start(admin)
      expect(first.statusCode, first.body).toBe(202)
      expect((await waitJob(h.t, first.json().job.id)).state).toBe('failed')
      const kept = h.ctx.backup.store.byId(first.json().uploadId)!
      expect(kept).toMatchObject({ complete: false, awaitingVerify: true })
      expect(kept.size).toBeGreaterThan(0)
      broken = false
      // Another user starts afresh; the same user resumes from the bytes already here.
      const theirs = await start(other)
      expect(theirs.json().uploadId).not.toBe(first.json().uploadId)
      await waitJob(h.t, theirs.json().job.id)
      offsets.length = 0
      const again = await start(admin)
      expect(again.statusCode, again.body).toBe(202)
      expect(again.json().uploadId).toBe(first.json().uploadId)
      expect((await waitJob(h.t, again.json().job.id)).state).toBe('done')
      expect(offsets).toEqual([kept.size])
      expect(h.ctx.backup.store.byId(first.json().uploadId)).toMatchObject({ complete: true })
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('still removes a download whose digest differs', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('removed')
      const dest = await folder(admin, name, (real) => ({
        get: async (key, offset, signal) => {
          if (key.includes('stall')) return real.get(key, offset, signal)
          const all: Buffer[] = []
          for await (const c of await real.get(key, offset, signal)) all.push(c as Buffer)
          const body = Buffer.concat(all)
          body[0] = body[0]! ^ 0xff
          return Readable.from([body])
        },
      }))
      const placed = place(name, randomBytes(1000), true)
      const res = await admin.call('POST', `/api/backup-destinations/${dest}/backups/fetch`, {
        connectionId: h.ids.B,
        key: placed.key,
      })
      expect((await waitJob(h.t, res.json().job.id)).state).toBe('failed')
      expect(h.ctx.backup.store.byId(res.json().uploadId)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })
})

describe('the stale-copy sweep (final review B25)', () => {
  const copyRow = (h: H, destinationId: string, owner: string) =>
    h.ctx.backup.copies.create({
      destinationId,
      backupId: null,
      remoteKey: remoteKeyFor('', 'mmbak', randomUUID(), Date.UTC(2026, 0, 1)),
      owner,
      connectionId: h.ids.A,
      meta: metaOf(),
      format: 'mmbak',
      size: 10,
      sha256: 'a'.repeat(64),
      md5: null,
    })

  it('ages a copy by its last attempt, not by when it was first made', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(admin, unique('aged'))
      const c = copyRow(h, dest, admin.id)
      h.ctx.backup.copies.fail(c.id, 'x')
      h.t.clock.now += 6 * 86_400_000
      h.ctx.backup.copies.restart(c.id)
      h.ctx.backup.copies.fail(c.id, 'again')
      h.t.clock.now += 2 * 86_400_000
      await sweepStaleCopies(h.ctx)
      expect(h.ctx.backup.copies.get(c.id)).toBeDefined()
      h.t.clock.now += 6 * 86_400_000
      await sweepStaleCopies(h.ctx)
      expect(h.ctx.backup.copies.get(c.id)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })

  it('looks at running transfers afresh for every copy', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const later = await folder(admin, unique('later'))
      const first = await folder(admin, unique('first'), () => ({
        abandon: async () => {
          // A send to the other destination starts while this abort is under way.
          h.ctx.backup.transfers.set('started-meanwhile', { userId: null, destinationIds: [later] })
        },
      }))
      const a = copyRow(h, first, admin.id)
      h.ctx.backup.copies.setResume(a.id, { key: a.remoteKey })
      const b = copyRow(h, later, admin.id)
      h.t.clock.now += 8 * 86_400_000
      await sweepStaleCopies(h.ctx)
      expect(h.ctx.backup.copies.get(a.id)).toBeUndefined()
      expect(h.ctx.backup.copies.get(b.id)).toBeDefined()
    } finally {
      h.ctx.backup.transfers.clear()
      await h.t.close()
    }
  })

  it('removes the object a swept copy left without a manifest, and keeps one with a manifest', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('orphans')
      const dest = await folder(admin, name)
      const bare = copyRow(h, dest, admin.id)
      const bareObject = remotePath(name, bare.remoteKey)
      mkdirSync(dirname(bareObject), { recursive: true })
      writeFileSync(bareObject, 'half a backup')
      const signed = copyRow(h, dest, admin.id)
      const signedObject = remotePath(name, signed.remoteKey)
      writeFileSync(signedObject, 'a whole backup')
      writeFileSync(`${signedObject}.json`, '{}')
      h.t.clock.now += 8 * 86_400_000
      await sweepStaleCopies(h.ctx)
      expect(h.ctx.backup.copies.byDestination(dest)).toEqual([])
      expect(existsSync(bareObject)).toBe(false)
      expect(existsSync(signedObject)).toBe(true)
    } finally {
      await h.t.close()
    }
  })
})

describe('why a copy failed, in codes (final review B32, B33)', () => {
  it('keeps the reason code with a failed copy and in the failed send job, and clears it on success', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      let full = true
      const name = unique('full')
      const dest = await folder(admin, name, (real) => ({
        put: async (...a) => {
          if (full) throw new DestinationError('quota', 'The destination is full')
          return real.put(...a)
        },
      }))
      const fine = await folder(admin, unique('fine'))
      const b = keep(h, admin.id)
      const job = await sent(h, admin, b.id, [dest, fine])
      expect(job.state).toBe('failed')
      const copies = async () =>
        (
          (await admin.get('/api/backups')).json() as Array<{
            id: string
            copies: Array<Record<string, unknown>>
          }>
        ).find((v) => v.id === b.id)!.copies
      expect(await copies()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ destinationId: dest, state: 'failed', reason: 'quota' }),
          expect.objectContaining({ destinationId: fine, state: 'complete', reason: null }),
        ]),
      )
      expect((await admin.get(`/api/jobs/${job.id}`)).json().job.failures).toEqual([
        { destination: name, reason: 'quota' },
      ])
      full = false
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      const retry = await admin.call('POST', `/api/backup-copies/${copy.id}/retry`)
      const done = await waitJob(h.t, retry.json().job.id)
      expect(done.state).toBe('done')
      expect((await admin.get(`/api/jobs/${done.id}`)).json().job.failures).toBeUndefined()
      expect((await copies()).find((c) => c.destinationId === dest)).toMatchObject({
        state: 'complete',
        reason: null,
      })
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('names our own refusals by their codes too: a policy, an interrupted send', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const hold = gate()
      const strict = await folder(admin, unique('strict'), (real) => ({
        put: async (key, file, resume, io, signal) => {
          await hold.wait(signal)
          return real.put(key, file, resume, io, signal)
        },
      }))
      const b = keep(h, admin.id, { format: 'gzip', personal: false })
      const res = await send(admin, b.id, [strict])
      await until(() => h.ctx.backup.copies.forBackupOn(b.id, strict)?.state === 'sending')
      await admin.call('PATCH', `/api/backup-destinations/${strict}`, { policy: { encryptedOnly: true } })
      await waitJob(h.t, res.json().job.id)
      expect(h.ctx.backup.copies.forBackupOn(b.id, strict)!.reason).toBe('destination_encrypted_only')
      // A copy a restart cut off.
      const c = h.ctx.backup.copies.create({
        destinationId: strict,
        backupId: null,
        remoteKey: remoteKeyFor('', 'mmbak', randomUUID(), Date.UTC(2026, 0, 1)),
        owner: admin.id,
        connectionId: h.ids.A,
        meta: metaOf(),
        format: 'mmbak',
        size: 1,
        sha256: 'a'.repeat(64),
        md5: null,
      })
      new JobRepo(h.ctx.store.db).insert(runningRecord(h, 'backup.send'))
      h.ctx.jobs.recover(h.ctx.jobKinds)
      expect(h.ctx.backup.copies.get(c.id)!.reason).toBe('interrupted')
    } finally {
      await h.t.close()
    }
  })
})

// Backup review I6: under "delete the local copy" the local copy is the only one until a destination
// holds it: a send cut off by a restart, or one an earlier destination of it still waits on, keeps it
// for as long as the send can be retried.
describe('the only copy of a backup whose send did not finish (backup review I6)', () => {
  it('is kept for 7 days when a restart cut its send off', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(admin, unique('cut'))
      const b = keep(h, admin.id)
      const c = h.ctx.backup.copies.create({
        destinationId: dest,
        backupId: b.id,
        remoteKey: remoteKeyFor('', 'mmbak', randomUUID(), Date.UTC(2026, 0, 1)),
        owner: admin.id,
        connectionId: h.ids.A,
        meta: metaOf(),
        format: 'mmbak',
        size: 1,
        sha256: 'a'.repeat(64),
        md5: null,
        deleteLocal: true,
      })
      new JobRepo(h.ctx.store.db).insert(runningRecord(h, 'backup.send'))
      h.ctx.jobs.recover(h.ctx.jobKinds)
      expect(h.ctx.backup.copies.get(c.id)!.reason).toBe('interrupted')
      expect(h.ctx.backup.store.get(admin.id, b.id)!.expiresAt).toBeGreaterThanOrEqual(
        h.ctx.now() + 7 * 86_400_000,
      )
    } finally {
      await h.t.close()
    }
  })

  it('is kept for 7 days when an earlier destination of it has nothing yet', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const bad = await folder(admin, unique('bad'), () => ({
        put: async () => {
          throw new DestinationError('provider', 'Nope')
        },
      }))
      const good = await folder(admin, unique('good'))
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [bad], true)).state).toBe('failed')
      // Time passes; then another destination receives it, under the same choice.
      h.t.clock.now += 600_000
      const job = await sent(h, admin, b.id, [good], true)
      expect(job.state).toBe('done')
      expect((await admin.get(`/api/jobs/${job.id}`)).json().job.localKept).toBe(true)
      expect(h.ctx.backup.store.get(admin.id, b.id)!.expiresAt).toBeGreaterThanOrEqual(
        h.ctx.now() + 7 * 86_400_000,
      )
    } finally {
      await h.t.close()
    }
  }, 90_000)
})

describe('an object already at the key of a new copy (final review B2, with the adapters’ A5)', () => {
  it('is read back before it is trusted where the destination accepts it in place', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('in-place')
      const reads: number[] = []
      // Like a Nextcloud MOVE answered 412: a file of the right size already there is taken as is.
      const dest = await folder(admin, name, (real) => ({
        readBack: false,
        put: async (key, file, resume, io, signal) =>
          existsSync(remotePath(name, key)) ? {} : real.put(key, file, resume, io, signal),
        get: (...a) => (reads.push(a[1]), real.get(...a)),
      }))
      const b = keep(h, admin.id)
      const key = remoteKeyFor('', 'mmbak', b.id, h.ctx.backup.store.byId(b.id)!.createdAt)
      const path = remotePath(name, key)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, randomBytes(b.bytes.length))
      const job = await sent(h, admin, b.id, [dest], true)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/read back differs/)
      expect(h.ctx.backup.store.byId(b.id)).toBeDefined()
      expect(existsSync(`${path}.json`)).toBe(false)
      // A fresh send with nothing in the way is not read back (the destination does not need it).
      reads.length = 0
      const other = keep(h, admin.id)
      expect((await sent(h, admin, other.id, [dest])).state).toBe('done')
      expect(reads).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
