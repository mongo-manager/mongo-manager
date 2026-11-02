import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import type { DestinationAdapter } from '../src/backup/destinations/types'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { slow } from './support/slowness'

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

let a: TestMongo
let ca: MongoClient
let base: string
const nowhere: TestMongo = { host: '127.0.0.1', port: 1, stop: async () => undefined }
beforeAll(async () => {
  a = await startMongo()
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  base = mkdtempSync(join(tmpdir(), 'mm-dump-send-final-'))
  mkdirSync(join(base, 'root'))
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await a?.stop()
  if (base) rmSync(base, { recursive: true, force: true })
})
beforeEach(async () => {
  await ca.db('shop').dropDatabase()
  await ca
    .db('shop')
    .collection('orders')
    .insertMany([{ n: 1 }])
})
afterEach(() => hooks.wrap.clear())

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
let seq = 0
const unique = (name: string) => `${name}-${++seq}`
const harness = () => backupHarness(a, nowhere, { backup: { folderRoots: [join(base, 'root')] } } as never)
async function folder(admin: U, name: string, wrap?: Wrap) {
  if (wrap) hooks.wrap.set(name, wrap)
  const r = await admin.call('POST', '/api/backup-destinations', {
    type: 'folder',
    name,
    config: { path: join(base, 'root', name) },
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}
/** Starts a dump of shop with destinations; `meanwhile` runs as the backup is completed, before the send is queued. */
async function dump(h: H, u: U, destinations: string[], meanwhile?: () => void) {
  if (meanwhile) {
    const store = h.ctx.backup.store
    const complete = store.completeBackup.bind(store)
    store.completeBackup = (...args) => {
      meanwhile()
      return complete(...args)
    }
  }
  const body = { scope: { kind: 'database', db: 'shop' }, format: 'mmbak', destinations, deleteLocal: false }
  const plan = await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)
  expect(plan.statusCode, plan.body).toBe(200)
  const res = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
    ...body,
    planHash: plan.json().planHash,
    password: 'correct horse battery',
  })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  expect(job.state).toBe('done')
  // Read from the store: a disabled account cannot ask for it any more.
  const report = h.ctx.transfer.reports.get(u.id, job.id) as unknown as Record<string, unknown>
  return { job, report }
}
const audits = (h: H, action: string) =>
  (
    h.ctx.store.db
      .prepare('SELECT outcome, user_id, details FROM audit_log WHERE action = ?')
      .all(action) as Array<{
      outcome: string
      user_id: string | null
      details: string
    }>
  ).map((r) => ({ ...r, details: JSON.parse(r.details) as Record<string, unknown> }))

describe('the send a dump queues (final review B3, B4, B5)', () => {
  it('starts even while another backup job of the same user runs', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const u = h.user({ on: { A: 'editor' } })
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      const slowFolder = await folder(admin, unique('slow'), (real) => ({
        put: async (key, file, resume, io, signal) => {
          await held
          return real.put(key, file, resume, io, signal)
        },
      }))
      const quick = await folder(admin, unique('quick'))
      for (const id of [slowFolder, quick])
        await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
          grants: [{ userId: u.id, level: 'send' }],
        })
      // One backup job of u runs: a send held at its destination.
      const bytes = randomBytes(1000)
      const { row, path } = h.ctx.backup.store.reserveBackup({
        owner: u.id,
        jobId: 'seed',
        connectionId: h.ids.A,
        name: 'old.mmbak',
        meta: {
          scope: { kind: 'database', db: 'shop', views: true },
          engine: 'builtin',
          format: 'mmbak',
          masked: false,
          anonymous: false,
          namespaces: 1,
          startedAt: 0,
          finishedAt: null,
          rulesVersion: 0,
        },
      })
      writeFileSync(path, bytes)
      h.ctx.backup.store.completeBackup(row.id, {
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        finishedAt: 1,
      })
      const running = await u.call('POST', `/api/backups/${row.id}/send`, { destinationIds: [slowFolder] })
      expect(running.statusCode, running.body).toBe(202)
      const { report } = await dump(h, u, [quick])
      expect(report.sendError ?? null).toBeNull()
      expect(report.sendJobId).toEqual(expect.any(String))
      expect((await waitJob(h.t, report.sendJobId as string, 60_000)).state).toBe('done')
      release()
      await waitJob(h.t, running.json().job.id)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('sends as the account stands when the dump ends: not after a demotion, a disabling or lost access', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(admin, unique('checked'))
      const cases: Array<[string, (u: U) => void]> = [
        ['demoted', (u) => h.ctx.users.setRole(u.id, 'editor')],
        ['disabled', (u) => h.ctx.users.setDisabled(u.id, true)],
        ['lost access', (u) => h.ctx.grants.set(h.ids.A, u.id, 'none')],
      ]
      for (const [what, change] of cases) {
        // An administrator needs no grant on the destination; once demoted, they have none. The
        // editor has one, and loses the connection instead.
        const u = what === 'lost access' ? h.user({ on: { A: 'editor' } }) : h.user({ role: 'admin' })
        if (what === 'lost access')
          await admin.call('PUT', `/api/backup-destinations/${dest}/grants`, {
            grants: [{ userId: u.id, level: 'send' }],
          })
        const before = h.ctx.jobs.list({}).filter((j) => j.kind === 'backup.send').length
        const { report } = await dump(h, u, [dest], () => change(u))
        expect(report.sendJobId, what).toBeNull()
        expect(report.sendError, what).toEqual(expect.any(String))
        expect(h.ctx.jobs.list({}).filter((j) => j.kind === 'backup.send').length, what).toBe(before)
      }
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('audits the queued send, and the dump start names its destinations and the local-copy choice', async () => {
    const h = await harness()
    try {
      const admin = h.user({ role: 'admin' })
      const dest = await folder(admin, unique('audited'))
      const { job, report } = await dump(h, admin, [dest])
      const started = audits(h, 'backup.dump.start')
      expect(started.at(-1)!.details).toMatchObject({ destinations: [dest], deleteLocal: false })
      expect(audits(h, 'backup.send.start')).toEqual([
        {
          outcome: 'success',
          user_id: admin.id,
          details: expect.objectContaining({
            job: report.sendJobId,
            backup: report.backupId,
            destinations: [dest],
            deleteLocal: false,
            dump: job.id,
          }),
        },
      ])
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
