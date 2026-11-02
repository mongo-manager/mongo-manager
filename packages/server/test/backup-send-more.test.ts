import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Principal } from '../src/http/context'
import { JobRepo } from '../src/jobs/repo'
import type { JobRecord } from '../src/jobs/types'
import type { BackupMeta } from '../src/backup/store'
import { DestinationError, type DestinationAdapter } from '../src/backup/destinations/types'
import type { DestinationRecord } from '../src/backup/destinations/repo'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import { assertSendable, startSend, sweepStaleCopies, toCopyView } from '../src/backup/send-job'
import { assertBackupRoom } from '../src/backup/room'
import { MAX_BACKUP_JOBS } from '../src/backup/limits'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import type { TestMongo } from './support/mongo'

type Wrap = (real: DestinationAdapter) => Partial<DestinationAdapter>

/**
 * Fault injection: the real adapter (a folder in a temp root) does the work; a test may replace
 * any of its methods for one destination, by name, to play a provider that lies or breaks.
 */
const hooks = vi.hoisted(() => ({ wrap: new Map<string, Wrap>(), stall: new Set<string>() }))
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

// Short names review 13 (M-7): a local file whose read never ends, until the job is stopped.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const { Readable } = await import('node:stream')
  return {
    ...real,
    createReadStream: ((path: string, options?: { signal?: AbortSignal }) =>
      hooks.stall.has(String(path))
        ? new Readable({ read() {}, signal: options?.signal })
        : real.createReadStream(path, options as never)) as typeof real.createReadStream,
  }
})

// Sends never open a MongoDB connection: the harness only needs addresses for its connections.
const nowhere: TestMongo = { host: '127.0.0.1', port: 1, stop: async () => undefined }
let base: string
const root = () => join(base, 'root')
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mm-send-more-'))
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

/** A complete kept backup of connection A, written straight into the store. */
function keep(h: H, owner: string, over: Partial<BackupMeta> = {}, bytes = randomBytes(300_000)) {
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

async function folder(admin: U, name: string, wrap?: Wrap, policy = { encryptedOnly: true }) {
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
/** A gate a fake provider waits on; it also gives way when the job is cancelled. */
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

describe('what a destination accepts (phase 3d-3b spec §4.3, D9, plan ruling 4)', () => {
  const record = (encryptedOnly: boolean) =>
    ({ name: 'Disk', policy: { encryptedOnly } }) as unknown as DestinationRecord

  it('takes an encrypted backup anywhere, even one with personal data', () => {
    expect(() => assertSendable(record(true), metaOf({ format: 'mmbak', personal: true }))).not.toThrow()
  })

  it('refuses a plain backup where only encrypted ones are accepted', () => {
    expect(() => assertSendable(record(true), metaOf({ format: 'gzip', masked: true }))).toThrow(
      expect.objectContaining({ statusCode: 409, details: { reason: 'destination_encrypted_only' } }),
    )
  })

  it('counts an old plain backup without the personal flag as personal', () => {
    const old = metaOf({ format: 'archive' })
    delete old.personal
    expect(() => assertSendable(record(false), old)).toThrow(
      expect.objectContaining({ details: { reason: 'destination_personal_plain' } }),
    )
    expect(() => assertSendable(record(false), metaOf({ format: 'gzip', personal: true }))).toThrow(
      expect.objectContaining({ details: { reason: 'destination_personal_plain' } }),
    )
  })

  it('lets a plain backup out when it holds no personal values', () => {
    for (const over of [{ personal: false }, { masked: true }, { anonymous: true }])
      expect(
        () => assertSendable(record(false), metaOf({ format: 'gzip', ...over })),
        JSON.stringify(over),
      ).not.toThrow()
  })
})

describe('sending: verification, manifest and the local copy (phase 3d-3b spec §4.2, D12)', () => {
  it('uploads, checks the size, reads the file back, then writes the manifest last', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const calls: string[] = []
      const name = unique('order')
      const dest = await folder(admin, name, (real) => ({
        put: (...a) => (calls.push('put'), real.put(...a)),
        stat: (...a) => (calls.push('stat'), real.stat(...a)),
        get: (...a) => (calls.push(`get@${a[1]}`), real.get(...a)),
        putSmall: (key, ...rest) => (
          calls.push(`putSmall ${key.endsWith('.json')}`),
          real.putSmall(key, ...rest)
        ),
      }))
      const b = keep(h, admin.id)
      const job = await sent(h, admin, b.id, [dest])
      expect(job.state).toBe('done')
      expect(calls).toEqual(['put', 'stat', 'get@0', 'putSmall true'])
      expect(job.progress).toEqual({ done: b.bytes.length, total: b.bytes.length })
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      expect(copy).toMatchObject({
        state: 'complete',
        sent: b.bytes.length,
        error: null,
        sha256: sha(b.bytes),
      })
      expect(copy.md5).toBe(createHash('md5').update(b.bytes).digest('hex'))
      expect(sha(readFileSync(remotePath(name, copy.remoteKey)))).toBe(sha(b.bytes))
      expect(h.ctx.backup.transfers.size).toBe(0)
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('fails each destination whose upload does not verify, writes no manifest for it, and keeps the local backup', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const names = {
        gone: unique('gone'),
        short: unique('short'),
        garbled: unique('garbled'),
        fine: unique('fine'),
      }
      const gone = await folder(admin, names.gone, () => ({ stat: async () => null }))
      const short = await folder(admin, names.short, (real) => ({
        stat: async (k, s) => ({ ...(await real.stat(k, s))!, size: 1 }),
      }))
      const garbled = await folder(admin, names.garbled, () => ({
        get: async (k, o) => {
          const body = readFileSync(remotePath(names.garbled, k))
          body[body.length - 1] = body[body.length - 1]! ^ 0xff
          return Readable.from([body.subarray(o)])
        },
      }))
      const fine = await folder(admin, names.fine)
      const b = keep(h, admin.id)
      // deleteLocal: the local copy goes only when every destination completed and verified.
      const job = await sent(h, admin, b.id, [gone, short, garbled, fine], true)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(new RegExp(`${names.gone}: The uploaded size does not match`))
      expect(job.error).toMatch(new RegExp(`${names.short}: The uploaded size does not match`))
      expect(job.error).toMatch(new RegExp(`${names.garbled}: The file read back differs`))
      expect(job.error).not.toMatch(new RegExp(names.fine))
      for (const [id, name] of [
        [gone, names.gone],
        [short, names.short],
        [garbled, names.garbled],
      ] as const) {
        const copy = h.ctx.backup.copies.forBackupOn(b.id, id)!
        expect(copy.state, name).toBe('failed')
        expect(copy.error, name).toMatch(/size does not match|read back differs/)
        expect(existsSync(`${remotePath(name, copy.remoteKey)}.json`), name).toBe(false)
      }
      const ok = h.ctx.backup.copies.forBackupOn(b.id, fine)!
      expect(ok.state).toBe('complete')
      expect(existsSync(`${remotePath(names.fine, ok.remoteKey)}.json`)).toBe(true)
      expect(h.ctx.backup.store.byId(b.id)).toMatchObject({ complete: true })
      expect(existsSync(b.path)).toBe(true)
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('trusts the checksums a provider reports only when they match the backup', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const b = keep(h, admin.id)
      const md5 = createHash('md5').update(b.bytes).digest('hex')
      const n = {
        shaBad: unique('sha-bad'),
        md5Bad: unique('md5-bad'),
        md5Ok: unique('md5-ok'),
        statSha: unique('stat-sha'),
      }
      const ids = {
        shaBad: await folder(admin, n.shaBad, (real) => ({
          put: async (...a) => ({ ...(await real.put(...a)), checksums: { sha256: 'e'.repeat(64), md5 } }),
        })),
        md5Bad: await folder(admin, n.md5Bad, (real) => ({
          put: async (...a) => ({ ...(await real.put(...a)), checksums: { md5: '0'.repeat(32) } }),
        })),
        md5Ok: await folder(admin, n.md5Ok, (real) => ({
          put: async (...a) => ({ ...(await real.put(...a)), checksums: { md5 }, ref: 'object-ref-1' }),
        })),
        statSha: await folder(admin, n.statSha, (real) => ({
          stat: async (k, s) => ({ ...(await real.stat(k, s))!, sha256: sha(b.bytes), ref: 'stat-ref' }),
        })),
      }
      const job = await sent(h, admin, b.id, Object.values(ids))
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(new RegExp(`${n.shaBad}: The destination holds a different file`))
      expect(job.error).toMatch(new RegExp(`${n.md5Bad}: The destination holds a different file`))
      const state = (id: string) => h.ctx.backup.copies.forBackupOn(b.id, id)!
      expect([state(ids.shaBad).state, state(ids.md5Bad).state]).toEqual(['failed', 'failed'])
      expect(state(ids.md5Ok)).toMatchObject({ state: 'complete', remoteRef: 'object-ref-1' })
      expect(state(ids.statSha)).toMatchObject({ state: 'complete', remoteRef: 'stat-ref' })
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('fails the copy when the manifest cannot be written, so it never lists as complete', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('no-manifest')
      const dest = await folder(admin, name, () => ({
        putSmall: async () => {
          throw new DestinationError('quota', 'The destination is full')
        },
      }))
      const b = keep(h, admin.id)
      const job = await sent(h, admin, b.id, [dest], true)
      expect(job.state).toBe('failed')
      expect(job.error).toBe(
        `Not sent — ${name}: The destination is full. The local copy was kept for 7 days.`,
      )
      expect(h.ctx.backup.copies.forBackupOn(b.id, dest)).toMatchObject({
        state: 'failed',
        error: 'The destination is full',
        completedAt: null,
      })
      expect(h.ctx.backup.store.byId(b.id)).toBeDefined()
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('marks a destination for sign-in again on a reconnect failure, and keeps provider secrets out of every message', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const names = { gate: unique('reconnect'), leak: unique('leak') }
      const reconnect = await folder(admin, names.gate, () => ({
        put: async () => {
          throw new DestinationError('reconnect', 'The account must be signed in again')
        },
      }))
      const leak = await folder(admin, names.leak, () => ({
        put: async () => {
          throw new DestinationError(
            'provider',
            'Refused https://bucket.example/obj?X-Amz-Signature=deadbeefcafe password=hunter2',
          )
        },
      }))
      const b = keep(h, admin.id)
      h.t.clock.now += 5_000
      const job = await sent(h, admin, b.id, [reconnect, leak])
      expect(job.state).toBe('failed')
      expect(h.ctx.backup.destinations.get(reconnect)!.status).toMatchObject({
        state: 'reconnect',
        reason: 'reconnect',
        checkedAt: h.t.clock.now,
      })
      expect(h.ctx.backup.destinations.get(leak)!.status.state).not.toBe('reconnect')
      const copyError = h.ctx.backup.copies.forBackupOn(b.id, leak)!.error!
      for (const text of [job.error!, copyError]) {
        expect(text).not.toMatch(/deadbeefcafe|hunter2/)
        expect(text).toMatch(/https:\/\/bucket\.example\/obj/)
      }
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('says a destination deleted while the send was queued failed, and that a backup gone from the server cannot be sent', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('deleted')
      const dest = await folder(admin, name)
      const b = keep(h, admin.id)
      expect((await admin.call('DELETE', `/api/backup-destinations/${dest}`)).statusCode).toBe(204)
      const start = (backupId: string, destinationIds: string[]) =>
        h.ctx.jobs.start(
          h.ctx.jobKinds['backup.send'],
          { userId: admin.id, connectionId: h.ids.A, db: 'shop', coll: '*', target: 'x' },
          { owner: admin.id, userId: admin.id, backupId, destinationIds, deleteLocal: true },
        )
      const deleted = await waitJob(h.t, start(b.id, [dest]).id)
      expect([deleted.state, deleted.error]).toEqual([
        'failed',
        'Not sent — A deleted destination: The destination was deleted. The local copy was kept for 7 days.',
      ])
      expect(h.ctx.backup.copies.byBackup(b.id)).toEqual([])
      expect(h.ctx.backup.store.byId(b.id)).toBeDefined()
      // A backup still being written, and one that no longer exists.
      const other = await folder(admin, unique('other'))
      const { row } = h.ctx.backup.store.reserveBackup({
        owner: admin.id,
        jobId: 'j',
        connectionId: h.ids.A,
        name: 'x',
        meta: metaOf(),
      })
      for (const id of [row.id, '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6']) {
        const job = await waitJob(h.t, start(id, [other]).id)
        expect([job.state, job.error]).toEqual(['failed', 'The backup is no longer on the server'])
      }
      expect(h.ctx.backup.copies.byDestination(other)).toEqual([])
      expect(h.ctx.backup.transfers.size).toBe(0)
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

// Short names review 10 (M-5): a local backup file that cannot be read is said as this server's,
// not a destination's (it was "The destination failed").
describe('a local backup file that cannot be read', () => {
  it('fails the send as this server’s file, before any destination is asked', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      let asked = 0
      const dest = await folder(admin, unique('unread'), () => ({
        stat: async () => {
          asked++
          return null
        },
      }))
      const b = keep(h, admin.id)
      rmSync(b.path, { force: true })
      mkdirSync(b.path)
      const job = await sent(h, admin, b.id, [dest], true)
      expect(job.state).toBe('failed')
      expect(job.error).toContain('The backup file could not be read on this server')
      expect(asked).toBe(0)
      expect(h.ctx.backup.copies.byBackup(b.id)).toEqual([])
      // Short names review 11 (M-1): said like any other failure — the job's notes say why per
      // destination, in the reader's language, and the only copy is kept for a retry.
      const view = (await admin.get(`/api/jobs/${job.id}`)).json().job
      expect(view).toMatchObject({ failures: [{ reason: 'body' }], localKept: true })
      expect(h.ctx.backup.store.byId(b.id)!.expiresAt).toBeGreaterThan(h.ctx.now() + 86_400_000)
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('a local backup file that cannot be read, beside copies that need none', () => {
  // Short names review 12 (I-1, M-1): a copy complete and still there is not failed for a local
  // file it does not need, and a deleted destination is said as one.
  it('keeps a complete copy complete, and says a deleted destination as deleted', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const d1 = await folder(admin, unique('done'))
      const d2 = await folder(admin, unique('new'))
      const gone = await folder(admin, unique('removed'))
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [d1])).state).toBe('done')
      const before = h.ctx.backup.copies.forBackupOn(b.id, d1)!
      expect(before.state).toBe('complete')
      expect((await admin.call('DELETE', `/api/backup-destinations/${gone}`)).statusCode).toBe(204)
      rmSync(b.path, { force: true })
      mkdirSync(b.path)
      // As a queued send meets them: the route refuses a deleted destination up front.
      const job = await waitJob(
        h.t,
        h.ctx.jobs.start(
          h.ctx.jobKinds['backup.send'],
          { userId: admin.id, connectionId: h.ids.A, db: 'shop', coll: '*', target: 'x' },
          {
            owner: admin.id,
            userId: admin.id,
            backupId: b.id,
            destinationIds: [d1, d2, gone],
            deleteLocal: false,
          },
        ).id,
      )
      expect(job.state).toBe('failed')
      expect(h.ctx.backup.copies.forBackupOn(b.id, d1)!.state).toBe('complete')
      expect(job.error).toContain('The backup file could not be read on this server')
      expect(job.error).toContain('A deleted destination: The destination was deleted')
      const view = (await admin.get(`/api/jobs/${job.id}`)).json().job
      expect(view.failures.map((f: { reason: string }) => f.reason).sort()).toEqual([
        'body',
        'destination_deleted',
      ])
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('a complete copy a later send cannot look at', () => {
  // Short names review 12 (I-1): a destination that does not answer while a complete copy is
  // looked at again does not undo the copy — it was verified, and nothing says it is gone.
  it('stays complete', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const name = unique('flaky')
      const dest = await folder(admin, name)
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [dest])).state).toBe('done')
      hooks.wrap.set(name, () => ({
        stat: async () => {
          throw new DestinationError('connect', 'The server cannot be reached')
        },
      }))
      expect((await sent(h, admin, b.id, [dest])).state).toBe('failed')
      expect(h.ctx.backup.copies.forBackupOn(b.id, dest)!.state).toBe('complete')
    } finally {
      await h.t.close()
    }
  }, 90_000)
})

describe('a destination deleted while a send to it runs', () => {
  // Short names review 15 (M1): its copy is said as deleted, the send's others as cancelled.
  it('says the deleted one as deleted, the others as cancelled', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const hold = gate()
      const slow = (real: DestinationAdapter) => ({
        put: async (...args: Parameters<DestinationAdapter['put']>) => {
          await hold.wait(args[4])
          return real.put(...args)
        },
      })
      const kept = await folder(admin, unique('kept'), slow)
      const goneName = unique('gone')
      const gone = await folder(admin, goneName, slow)
      const res = await send(admin, keep(h, admin.id).id, [kept, gone])
      expect(res.statusCode, res.body).toBe(202)
      const id = res.json().job.id as string
      await until(() => h.ctx.backup.copies.byDestination(gone).some((c) => c.state === 'sending'))
      expect((await admin.call('DELETE', `/api/backup-destinations/${gone}`)).statusCode).toBe(204)
      await waitJob(h.t, id)
      const failures = (await admin.get(`/api/jobs/${id}`)).json().job.failures as Array<{
        destination: string
        reason: string
      }>
      expect(Object.fromEntries(failures.map((f) => [f.destination, f.reason]))).toEqual({
        [h.ctx.backup.destinations.get(kept)!.name]: 'cancelled',
        [goneName]: 'destination_deleted',
      })
    } finally {
      await h.t.close()
    }
  })
})

describe('a send whose only destination is deleted while it runs', () => {
  // Review of 8942485b: the job ends cancelled, says the destination was deleted, and keeps the
  // only local copy under "delete the local copy".
  it('is cancelled, says why, and keeps the local copy', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const hold = gate()
      const name = unique('only')
      const dest = await folder(admin, name, (real) => ({
        put: async (...args: Parameters<DestinationAdapter['put']>) => {
          await hold.wait(args[4])
          return real.put(...args)
        },
      }))
      const b = keep(h, admin.id)
      const res = await send(admin, b.id, [dest], true)
      expect(res.statusCode, res.body).toBe(202)
      const id = res.json().job.id as string
      await until(() => h.ctx.backup.copies.byDestination(dest).some((c) => c.state === 'sending'))
      expect((await admin.call('DELETE', `/api/backup-destinations/${dest}`)).statusCode).toBe(204)
      expect((await waitJob(h.t, id)).state).toBe('cancelled')
      const view = (await admin.get(`/api/jobs/${id}`)).json().job
      expect(view).toMatchObject({
        failures: [{ destination: name, reason: 'destination_deleted' }],
        localKept: true,
      })
      expect(h.ctx.backup.store.byId(b.id)!.expiresAt).toBeGreaterThan(h.ctx.now() + 86_400_000)
    } finally {
      await h.t.close()
    }
  })
})

describe('a send stopped while it reads the local file', () => {
  // Short names review 13 (M-7): under "delete the local copy", the only copy is kept, as a send
  // stopped later keeps it.
  it('keeps the only local copy for a retry', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(admin, unique('stopped'))
      const b = keep(h, admin.id)
      hooks.stall.add(b.path)
      const res = await send(admin, b.id, [dest], true)
      expect(res.statusCode, res.body).toBe(202)
      const id = res.json().job.id as string
      await until(() => h.ctx.backup.transfers.has(id))
      expect(await h.ctx.jobs.cancel(id)).toBe('cancelled')
      await waitJob(h.t, id)
      expect(h.ctx.backup.store.byId(b.id)!.expiresAt).toBeGreaterThan(h.ctx.now() + 86_400_000)
      expect((await admin.get(`/api/jobs/${id}`)).json().job.localKept).toBe(true)
    } finally {
      hooks.stall.clear()
      await h.t.close()
    }
  })
})

describe('a local backup file gone before the send reads it', () => {
  // Short names review 11 (M-2): its file deleted meanwhile is a backup gone, not one unreadable.
  it('says the backup is no longer on the server', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(admin, unique('gone'))
      const b = keep(h, admin.id)
      rmSync(b.path, { force: true })
      const job = await sent(h, admin, b.id, [dest])
      expect([job.state, job.error]).toEqual(['failed', 'The backup is no longer on the server'])
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('resuming and progress (phase 3d-3b spec §4.2)', () => {
  it('resumes a failed copy at the same key with its saved state, and skips a complete one', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const seen: Array<{ key: string; resume: unknown }> = []
      let attempts = 0
      const flaky = await folder(admin, unique('flaky'), (real) => ({
        put: async (key, file, resume, io, signal) => {
          seen.push({ key, resume })
          if (++attempts === 1) {
            io.saveResume({ key, part: 1 })
            throw new DestinationError('network', 'The connection dropped')
          }
          return real.put(key, file, resume, io, signal)
        },
      }))
      const steady = await folder(admin, unique('steady'))
      const b = keep(h, admin.id)
      const first = await sent(h, admin, b.id, [flaky, steady])
      expect(first.state).toBe('failed')
      const failed = h.ctx.backup.copies.forBackupOn(b.id, flaky)!
      expect(failed).toMatchObject({ state: 'failed', error: 'The connection dropped' })
      // The resume state is sealed at rest: the provider's handle is not readable in the row.
      const raw = h.ctx.store.db
        .prepare('SELECT resume FROM backup_remote_copies WHERE id = ?')
        .get(failed.id) as {
        resume: string
      }
      expect(raw.resume).not.toContain('part')
      expect(h.ctx.backup.copies.resume(failed.id)).toEqual({ key: failed.remoteKey, part: 1 })
      const steadyCopy = h.ctx.backup.copies.forBackupOn(b.id, steady)!
      expect(steadyCopy.state).toBe('complete')

      const retried = await admin.call('POST', `/api/backup-copies/${failed.id}/retry`)
      expect(retried.statusCode, retried.body).toBe(202)
      expect((await waitJob(h.t, retried.json().job.id)).state).toBe('done')
      expect(seen).toEqual([
        { key: failed.remoteKey, resume: null },
        { key: failed.remoteKey, resume: { key: failed.remoteKey, part: 1 } },
      ])
      expect(h.ctx.backup.copies.get(failed.id)).toMatchObject({ state: 'complete', error: null })
      expect(h.ctx.backup.copies.resume(failed.id)).toBeNull()

      // Sending to both again uploads nothing: both copies are complete, and count as sent.
      const again = await sent(h, admin, b.id, [flaky, steady])
      expect(again.state).toBe('done')
      expect(again.progress).toEqual({ done: 2 * b.bytes.length, total: 2 * b.bytes.length })
      expect(seen).toHaveLength(2)
      expect(h.ctx.backup.copies.get(steadyCopy.id)!.completedAt).toBe(steadyCopy.completedAt)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('records the bytes sent at most once a second', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const recorded: number[] = []
      let copyId = ''
      const dest = await folder(admin, unique('progress'), (real) => ({
        put: async (key, file, resume, io, signal) => {
          copyId = h.ctx.backup.copies.byKey(dest, key)!.id
          const look = () => recorded.push(h.ctx.backup.copies.get(copyId)!.sent)
          io.progress(10)
          look()
          io.progress(20)
          look()
          h.t.clock.now += 1_000
          io.progress(30)
          look()
          return real.put(key, file, resume, { ...io, progress: () => undefined }, signal)
        },
      }))
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [dest])).state).toBe('done')
      expect(recorded).toEqual([10, 10, 30])
      expect(h.ctx.backup.copies.get(copyId)!.sent).toBe(b.bytes.length)
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('can send again after a copy failed verification', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      let lies = true
      const dest = await folder(admin, unique('reverify'), (real) => ({
        stat: async (k, s) => {
          const st = await real.stat(k, s)
          return lies && st ? { ...st, size: st.size + 1 } : st
        },
      }))
      const b = keep(h, admin.id)
      expect((await sent(h, admin, b.id, [dest])).state).toBe('failed')
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      expect(copy.state).toBe('failed')
      lies = false
      const retried = await admin.call('POST', `/api/backup-copies/${copy.id}/retry`)
      expect(retried.statusCode, retried.body).toBe(202)
      const job = await waitJob(h.t, retried.json().job.id)
      // An unverified object left at the key must not block every later attempt.
      expect([job.state, job.error]).toEqual(['done', null])
      expect(h.ctx.backup.copies.get(copy.id)!.state).toBe('complete')
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('starting a send (phase 3d-3b spec §1.2, §7.6, D7, D8)', () => {
  it('refuses an inaccessible destination before anything happens, and sends to a repeated one once', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      const granted = await folder(admin, unique('granted'))
      const hidden = await folder(admin, unique('hidden'))
      await admin.call('PUT', `/api/backup-destinations/${granted}/grants`, {
        grants: [{ userId: u.id, level: 'send' }],
      })
      const b = keep(h, u.id)
      const expiresAt = h.ctx.backup.store.byId(b.id)!.expiresAt
      const jobs = h.ctx.jobs.list({}).length
      const refused = await send(u, b.id, [granted, hidden])
      expect(refused.statusCode).toBe(404)
      expect(h.ctx.jobs.list({}).length).toBe(jobs)
      expect(h.ctx.backup.copies.byBackup(b.id)).toEqual([])
      expect(h.ctx.backup.store.byId(b.id)!.expiresAt).toBe(expiresAt)

      const job = await sent(h, u, b.id, [granted, granted])
      expect(job.state).toBe('done')
      expect(job.progress).toEqual({ done: b.bytes.length, total: b.bytes.length })
      expect(h.ctx.backup.copies.byBackup(b.id)).toHaveLength(1)
      const [view] = (await u.get('/api/backups')).json()
      expect(view.copies).toEqual([
        expect.objectContaining({ destinationId: granted, state: 'complete', sent: b.bytes.length }),
      ])
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it(`allows ${MAX_BACKUP_JOBS} running backup jobs per user, then refuses; other users and cancelled jobs free nothing they should not`, async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      const v = h.user({ on: { A: 'editor' } })
      const hold = gate()
      const slow = await folder(admin, unique('slow'), (real) => ({
        put: async (key, file, resume, io, signal) => {
          await hold.wait(signal)
          return real.put(key, file, resume, io, signal)
        },
      }))
      const quick = await folder(admin, unique('quick'))
      for (const id of [slow, quick])
        await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
          grants: [
            { userId: u.id, level: 'send' },
            { userId: v.id, level: 'send' },
          ],
        })
      const running = []
      for (let i = 0; i < MAX_BACKUP_JOBS; i++) {
        const r = await send(u, keep(h, u.id).id, [slow])
        expect(r.statusCode, r.body).toBe(202)
        running.push(r.json().job.id as string)
      }
      const busy = await send(u, keep(h, u.id).id, [quick])
      expect([busy.statusCode, busy.json().details?.reason]).toEqual([409, 'backup_busy'])
      // The room is counted per user: another user, and the local owner, still have theirs.
      expect((await sent(h, v, keep(h, v.id).id, [quick])).state).toBe('done')
      const local: Principal = {
        kind: 'local',
        userId: 'local',
        username: 'owner',
        role: 'admin',
        csrfToken: 'x',
      }
      expect(() => assertBackupRoom(h.ctx, local)).not.toThrow()
      expect(() => assertBackupRoom(h.ctx, { kind: 'user', userId: u.id } as unknown as Principal)).toThrow(
        expect.objectContaining({ details: { reason: 'backup_busy' } }),
      )
      // A cancelled send frees its place, leaves no copy "sending", and keeps the local backup.
      await until(() => h.ctx.backup.copies.byDestination(slow).length === MAX_BACKUP_JOBS)
      expect(await h.ctx.jobs.cancel(running[0]!)).toBe('cancelled')
      const cancelled = h.ctx.jobs.get(running[0]!)!
      expect(cancelled.state).toBe('cancelled')
      const copies = h.ctx.backup.copies.byDestination(slow)
      expect(copies.map((c) => c.state).sort()).toEqual(['failed', 'sending'])
      const dead = copies.find((c) => c.state === 'failed')!
      // Short names review 14 (M1): said as cancelled, not as a stopped test or a provider refusal.
      expect(dead.reason).toBe('cancelled')
      expect(h.ctx.backup.store.byId(dead.backupId!)).toBeDefined()
      expect(existsSync(remotePath(h.ctx.backup.destinations.get(slow)!.name, dead.remoteKey))).toBe(false)
      expect([...h.ctx.backup.transfers.keys()]).toEqual([running[1]])
      const freed = await send(u, keep(h, u.id).id, [quick])
      expect(freed.statusCode, freed.body).toBe(202)
      hold.open()
      expect((await waitJob(h.t, running[1]!)).state).toBe('done')
      expect((await waitJob(h.t, freed.json().job.id)).state).toBe('done')
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('runs a send for the local owner with no user, and names the scope in the job', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(admin, unique('local'))
      const local: Principal = {
        kind: 'local',
        userId: 'local',
        username: 'owner',
        role: 'admin',
        csrfToken: 'x',
      }
      const server = keep(h, 'local', { scope: { kind: 'server' } })
      const coll = keep(h, 'local', { scope: { kind: 'collection', db: 'shop', coll: 'orders' } })
      const row = (id: string) => h.ctx.backup.store.byId(id)!
      const j1 = startSend(h.ctx, local, row(server.id), [dest], false)
      expect(j1).toMatchObject({ userId: null, db: '*', coll: '*', target: 'shop.mmbak' })
      expect((await waitJob(h.t, j1.id)).state).toBe('done')
      const j2 = startSend(h.ctx, local, row(coll.id), [dest], true)
      expect(j2).toMatchObject({ userId: null, db: 'shop', coll: 'orders' })
      expect((await waitJob(h.t, j2.id)).state).toBe('done')
      expect(h.ctx.backup.copies.byDestination(dest).map((c) => c.owner)).toEqual(['local', 'local'])
      // deleteLocal after a verified send: the local file goes, its copy stays, detached.
      expect(h.ctx.backup.store.byId(coll.id)).toBeUndefined()
      expect(existsSync(coll.path)).toBe(false)
      expect(h.ctx.backup.copies.byDestination(dest).filter((c) => c.backupId === null)).toHaveLength(1)
    } finally {
      await h.t.close()
    }
  }, 60_000)
})

describe('copies outlive their backups, and belong to their sender (phase 3d-3b spec §4.1, D8)', () => {
  it('detaches the copies when the backup is deleted or its owner is disabled, and a retry then asks for a new backup', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      let fail = true
      const dest = await folder(admin, unique('outlive'), (real) => ({
        put: async (...a) => {
          if (fail) throw new DestinationError('provider', 'Nope')
          return real.put(...a)
        },
      }))
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [{ userId: u.id, level: 'send' }],
      })
      const b1 = keep(h, u.id)
      expect((await sent(h, u, b1.id, [dest])).state).toBe('failed')
      const failed = h.ctx.backup.copies.forBackupOn(b1.id, dest)!
      fail = false
      const b2 = keep(h, u.id)
      expect((await sent(h, u, b2.id, [dest])).state).toBe('done')
      const done = h.ctx.backup.copies.forBackupOn(b2.id, dest)!

      expect((await u.call('DELETE', `/api/backups/${b1.id}`)).statusCode).toBe(204)
      expect(h.ctx.backup.copies.get(failed.id)).toMatchObject({ backupId: null, state: 'failed' })
      expect(existsSync(b1.path)).toBe(false)
      const retry = await u.call('POST', `/api/backup-copies/${failed.id}/retry`)
      expect([retry.statusCode, retry.json().details?.reason]).toEqual([409, 'local_gone'])

      expect((await admin.call('PATCH', `/api/users/${u.id}`, { disabled: true })).statusCode).toBe(200)
      expect(h.ctx.backup.store.byId(b2.id)).toBeUndefined()
      expect(h.ctx.backup.copies.get(done.id)).toMatchObject({
        backupId: null,
        state: 'complete',
        owner: u.id,
      })
      const items = (await admin.get(`/api/backup-destinations/${dest}/backups`)).json().items
      expect(items).toEqual([expect.objectContaining({ copyId: done.id, state: 'complete' })])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('lets a send-level user retry and discard only their own copies', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      const v = h.user({ on: { A: 'editor' } })
      const dest = await folder(admin, unique('mine'), () => ({
        put: async () => {
          throw new DestinationError('provider', 'Nope')
        },
      }))
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [
          { userId: u.id, level: 'send' },
          { userId: v.id, level: 'send' },
        ],
      })
      const b = keep(h, u.id)
      expect((await sent(h, u, b.id, [dest])).state).toBe('failed')
      const copy = h.ctx.backup.copies.forBackupOn(b.id, dest)!
      // v holds the same level on the same destination, but the copy is u's.
      expect((await v.call('POST', `/api/backup-copies/${copy.id}/retry`)).statusCode).toBe(404)
      expect((await v.call('DELETE', `/api/backup-copies/${copy.id}`)).statusCode).toBe(404)
      expect((await send(v, b.id, [dest])).statusCode).toBe(404)
      expect(h.ctx.backup.copies.get(copy.id)).toBeDefined()
      // Losing the grant hides the copy from its own sender too.
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [{ userId: v.id, level: 'send' }],
      })
      expect((await u.call('DELETE', `/api/backup-copies/${copy.id}`)).statusCode).toBe(404)
      await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
        grants: [{ userId: u.id, level: 'send' }],
      })
      expect((await u.call('DELETE', `/api/backup-copies/${copy.id}`)).statusCode).toBe(204)
      expect(h.ctx.backup.copies.get(copy.id)).toBeUndefined()
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('shows a copy whose destination is unknown with no name rather than failing', async () => {
    const h = await harness()
    try {
      const view = toCopyView(h.ctx, {
        id: 'c',
        destinationId: '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6',
        backupId: null,
        remoteKey: 'k',
        remoteRef: null,
        owner: 'o',
        connectionId: null,
        meta: null,
        format: 'mmbak',
        size: 3,
        sha256: 'a'.repeat(64),
        md5: null,
        state: 'failed',
        sent: 1,
        error: 'x',
        createdAt: 0,
        completedAt: null,
        scheduleId: null,
        origin: null,
      })
      expect(view).toEqual({
        id: 'c',
        destinationId: '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6',
        destinationName: '',
        state: 'failed',
        sent: 1,
        size: 3,
        error: 'x',
        reason: null,
        completedAt: null,
      })
    } finally {
      await h.t.close()
    }
  })
})

describe('a restart (phase 3d-3b spec §4.2)', () => {
  it('settles a send or fetch it cut off as interrupted, never as done', async () => {
    const h = await harness()
    try {
      const repo = new JobRepo(h.ctx.store.db)
      const left = (['backup.send', 'backup.fetch'] as const).map((kind) => {
        const record: JobRecord = {
          id: randomUUID(),
          kind,
          userId: null,
          connectionId: h.ids.A,
          targetConnectionId: null,
          db: '*',
          coll: '*',
          target: 'x',
          state: 'running',
          progress: { done: 5, total: 10 },
          estimate: null,
          error: null,
          staging: null,
          stagingConnectionId: null,
          stagingDb: null,
          startedAt: h.t.clock.now,
          finishedAt: null,
        }
        repo.insert(record)
        return record.id
      })
      h.t.clock.now += 1_000
      h.ctx.jobs.recover(h.ctx.jobKinds)
      for (const id of left)
        expect(h.ctx.jobs.get(id)).toMatchObject({ state: 'interrupted', finishedAt: h.t.clock.now })
    } finally {
      await h.t.close()
    }
  })
})

describe('abandoned uploads (phase 3d-3b spec §4.2: aborted after 7 days, copies forgotten)', () => {
  it('aborts and forgets stale unfinished copies, and leaves running, recent and complete ones', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const names = { idle: unique('idle'), busy: unique('busy'), broken: unique('broken') }
      const idle = await folder(admin, names.idle)
      const busy = await folder(admin, names.busy)
      const abandoned: unknown[] = []
      const broken = await folder(admin, names.broken, () => ({
        abandon: async (resume) => {
          abandoned.push(resume)
          throw new DestinationError('network', 'unreachable')
        },
      }))
      const copy = (destinationId: string) =>
        h.ctx.backup.copies.create({
          destinationId,
          backupId: null,
          remoteKey: remoteKeyFor('', 'mmbak', randomUUID(), Date.UTC(2026, 0, 1)),
          owner: admin.id,
          connectionId: h.ids.A,
          meta: metaOf(),
          format: 'mmbak',
          size: 10,
          sha256: 'a'.repeat(64),
          md5: null,
        })
      const partialOf = (name: string, key: string) => {
        const p = `${remotePath(name, key)}.partial`
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, 'half')
        return p
      }
      const stale = copy(idle)
      const stalePartial = partialOf(names.idle, stale.remoteKey)
      h.ctx.backup.copies.setResume(stale.id, { key: stale.remoteKey })
      const staleFailed = copy(idle)
      h.ctx.backup.copies.fail(staleFailed.id, 'x')
      const noResumePartial = partialOf(names.idle, staleFailed.remoteKey)
      const complete = copy(idle)
      h.ctx.backup.copies.complete(complete.id, null)
      const running = copy(busy)
      h.ctx.backup.copies.setResume(running.id, { key: running.remoteKey })
      const runningPartial = partialOf(names.busy, running.remoteKey)
      const unreachable = copy(broken)
      h.ctx.backup.copies.setResume(unreachable.id, { key: unreachable.remoteKey })
      h.ctx.backup.transfers.set('job-in-flight', { userId: null, destinationIds: [busy] })

      h.t.clock.now += 7 * 86_400_000 - 1
      await sweepStaleCopies(h.ctx)
      expect(h.ctx.backup.copies.byDestination(idle)).toHaveLength(3)

      const recent = copy(idle)
      h.t.clock.now += 2
      await sweepStaleCopies(h.ctx)
      const left = (id: string) => h.ctx.backup.copies.byDestination(id).map((c) => c.id)
      expect(left(idle).sort()).toEqual([complete.id, recent.id].sort())
      expect(existsSync(stalePartial)).toBe(false)
      // Without a resume state there is nothing to abort: the provider's own expiry applies.
      expect(existsSync(noResumePartial)).toBe(true)
      expect(left(busy)).toEqual([running.id])
      expect(existsSync(runningPartial)).toBe(true)
      // A provider that cannot be reached does not keep the copy forever.
      expect(abandoned).toEqual([{ key: unreachable.remoteKey }])
      expect(left(broken)).toEqual([])
    } finally {
      h.ctx.backup.transfers.clear()
      await h.t.close()
    }
  })
})
