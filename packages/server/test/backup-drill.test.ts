// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type AppEvent, type DrillReport } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { confirmedKey } from './support/schedules'
import { waitJob } from './support/jobs'
import { executeRun } from '../src/backup/schedules/run'
import { DRILL_STAGING, drillKind, freeSpace, mayDropDatabases } from '../src/backup/drill-job'
import { maskerForPrincipal } from '../src/masking/request'
import { dropLeftoverStaging } from '../src/jobs/duplicate'
import { slow } from './support/slowness'

/**
 * W4 item 4 (completion design §2 W4.4): scheduled restore drills — a backup restored into a
 * scratch database, its counts and contents verified against the backup, the database dropped, the
 * outcome reported and announced (app events).
 */
let a: TestMongo
let b: TestMongo
let ca: MongoClient
let base: string
const root = () => join(base, 'root')
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  await ca.db('drill').dropDatabase()
  await ca
    .db('drill')
    .collection('orders')
    .insertMany(Array.from({ length: 25 }, (_, i) => ({ _id: i as never, n: i, at: new Date(i) })))
  await ca
    .db('drill')
    .collection('users')
    .insertMany([{ name: 'a' }, { name: 'b' }])
  await ca.db('drill').createCollection('v', { viewOn: 'orders', pipeline: [] })
  base = mkdtempSync(join(tmpdir(), 'mm-drill-'))
  mkdirSync(root())
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop()])
  if (base) rmSync(base, { recursive: true, force: true })
})

type H = Awaited<ReturnType<typeof backupHarness>>
const harness = () =>
  backupHarness(a, b, { backup: { folderRoots: [root()], privateNetworks: ['127.0.0.1/32'] } } as never)
const scratchDbs = async () =>
  (await ca.db('admin').admin().listDatabases({ nameOnly: true })).databases
    .map((d) => d.name)
    .filter((n) => n.startsWith('mm_drill_'))
const events = (h: H) => {
  const got: AppEvent[] = []
  h.ctx.events.on((e) => void got.push(e))
  return got
}

async function keptBackup(h: H, u: ReturnType<H['user']>): Promise<string> {
  const body = { scope: { kind: 'database', db: 'drill' }, format: 'gzip' }
  const plan = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
  const res = await u.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: plan.planHash })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  expect(job.state, job.error ?? '').toBe('done')
  return (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId as string
}

describe('the restore drill job', () => {
  it('restores into a scratch database, verifies every namespace, drops it, and announces it', async () => {
    const h = await harness()
    try {
      const u = h.user({ role: 'admin' })
      const backupId = await keptBackup(h, u)
      const got = events(h)
      const job = h.ctx.jobs.start(
        h.ctx.jobKinds['backup.drill'],
        { userId: u.id, connectionId: h.ids.A, db: 'drill', coll: '*', target: 'drill backup' },
        { owner: u.id, backupId, schedule: null },
      )
      const done = await waitJob(h.t, job.id, 60_000)
      expect(done.state, done.error ?? '').toBe('done')
      const report = h.ctx.transfer.reports.get(u.id, job.id) as DrillReport
      expect(report).toMatchObject({ kind: 'drill', ok: true, backupId })
      const orders = report.namespaces.find((n) => n.ns === 'drill.orders')!
      expect(orders).toMatchObject({ archived: 25, restored: 25, contents: 'match', crc: 'ok' })
      expect(report.namespaces.find((n) => n.ns === 'drill.v')).toMatchObject({ contents: 'skipped' })
      expect(await scratchDbs()).toEqual([])
      await new Promise((r) => setTimeout(r, 10))
      expect(got.map((e) => e.kind)).toEqual(['backup.drill.passed'])
      // No document value travels with the event.
      expect(JSON.stringify(got[0])).not.toMatch(/"name":"a"/)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  // W4 × W8 (merge review): a backup made before a connection named its key vault there (or one from
  // elsewhere) may hold data keys; a drill never copies them, not even into its scratch database.
  it('leaves a key vault some connection names out of the scratch copy', async () => {
    const h = await harness()
    try {
      await ca
        .db('drill')
        .collection('__vault')
        .insertOne({ keyAltNames: ['k'], keyMaterial: 'x' })
      const u = h.user({ role: 'admin' })
      const backupId = await keptBackup(h, u)
      h.ctx.connections.create(
        {
          name: 'vaulted',
          favorite: false,
          readOnly: false,
          settings: ConnectionSettingsSchema.parse({
            hosts: [{ host: '127.0.0.1', port: a.port }],
            encryption: {
              enabled: true,
              keyVaultNamespace: 'drill.__vault',
              kms: { local: { key: 'A'.repeat(128) } },
              library: 'mongocryptd',
            },
          }),
        },
        null,
      )
      const job = h.ctx.jobs.start(
        h.ctx.jobKinds['backup.drill'],
        { userId: u.id, connectionId: h.ids.A, db: 'drill', coll: '*', target: 'drill backup' },
        { owner: u.id, backupId, schedule: null },
      )
      const done = await waitJob(h.t, job.id, 60_000)
      expect(done.state, done.error ?? '').toBe('done')
      const report = h.ctx.transfer.reports.get(u.id, job.id) as DrillReport
      expect(report.namespaces.find((n) => n.ns === 'drill.__vault')).toMatchObject({ contents: 'skipped' })
      expect(report.namespaces.find((n) => n.ns === 'drill.orders')).toMatchObject({ contents: 'match' })
    } finally {
      await ca.db('drill').collection('__vault').drop()
      await h.t.close()
    }
  }, 180_000)

  it('fails when what came back differs, still drops the scratch database, and announces the failure', async () => {
    const h = await harness()
    try {
      const u = h.user({ role: 'admin' })
      const backupId = await keptBackup(h, u)
      const got = events(h)
      // A restore that lost a document on the way.
      const kind = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        afterLoad: async (client, scratch, names) => {
          const orders = names.find((n) => n.endsWith('orders'))!
          await client
            .db(scratch)
            .collection(orders)
            .deleteOne({ _id: 3 as never })
        },
      })
      const job = h.ctx.jobs.start(
        kind,
        { userId: u.id, connectionId: h.ids.A, db: 'drill', coll: '*', target: 'drill backup' },
        { owner: u.id, backupId, schedule: null },
      )
      const done = await waitJob(h.t, job.id, 60_000)
      expect(done.state).toBe('failed')
      const report = h.ctx.transfer.reports.get(u.id, job.id) as DrillReport
      expect(report.ok).toBe(false)
      expect(report.namespaces.find((n) => n.ns === 'drill.orders')).toMatchObject({
        archived: 25,
        restored: 24,
        contents: 'mismatch',
      })
      expect(await scratchDbs()).toEqual([])
      await new Promise((r) => setTimeout(r, 10))
      expect(got.map((e) => e.kind)).toEqual(['backup.drill.failed'])
      expect(got[0]).toMatchObject({ severity: 'critical', ownerId: u.id, connectionId: h.ids.A })
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('finds a document changed on the way, the count being right', async () => {
    const h = await harness()
    try {
      const u = h.user({ role: 'admin' })
      const backupId = await keptBackup(h, u)
      const kind = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        afterLoad: async (client, scratch, names) => {
          const orders = names.find((n) => n.endsWith('orders'))!
          await client
            .db(scratch)
            .collection(orders)
            .updateOne({ _id: 7 as never }, { $set: { n: 70 } })
        },
      })
      const job = h.ctx.jobs.start(
        kind,
        { userId: u.id, connectionId: h.ids.A, db: 'drill', coll: '*', target: 'drill backup' },
        { owner: u.id, backupId, schedule: null },
      )
      expect((await waitJob(h.t, job.id, 60_000)).state).toBe('failed')
      const report = h.ctx.transfer.reports.get(u.id, job.id) as DrillReport
      expect(report.namespaces.find((n) => n.ns === 'drill.orders')).toMatchObject({
        archived: 25,
        restored: 25,
        contents: 'mismatch',
      })
      expect(report.namespaces.find((n) => n.ns === 'drill.users')).toMatchObject({ contents: 'match' })
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('refuses a backup that is not its owner’s', async () => {
    const h = await harness()
    try {
      const u = h.user({ role: 'admin' })
      const other = h.user({ role: 'admin' })
      const backupId = await keptBackup(h, u)
      const job = h.ctx.jobs.start(
        h.ctx.jobKinds['backup.drill'],
        { userId: other.id, connectionId: h.ids.A, db: 'drill', coll: '*', target: 'x' },
        { owner: other.id, backupId, schedule: null },
      )
      expect((await waitJob(h.t, job.id, 60_000)).state).toBe('failed')
      expect(await scratchDbs()).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 180_000)
})

describe('a drill’s guards (W4 review I2)', () => {
  const run = async (h: H, u: ReturnType<H['user']>, kind: ReturnType<typeof drillKind>) => {
    const backupId = await keptBackup(h, u)
    const job = h.ctx.jobs.start(
      kind,
      { userId: u.id, connectionId: h.ids.A, db: 'drill', coll: '*', target: 'drill backup' },
      { owner: u.id, backupId, schedule: null },
    )
    const done = await waitJob(h.t, job.id, 60_000)
    return { done, report: h.ctx.transfer.reports.get(u.id, job.id) as DrillReport }
  }

  it('says when its scratch database could not be dropped: failed, with a warning event', async () => {
    const h = await harness()
    try {
      const u = h.user({ role: 'admin' })
      const got = events(h)
      let left = ''
      const kind = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        drop: async (db) => {
          left = db.databaseName
          throw new Error('not authorized on this database to drop it')
        },
      })
      const { done, report } = await run(h, u, kind)
      expect(done.state).toBe('failed')
      expect(report).toMatchObject({ ok: false, cleanup: 'failed', code: 'drill_cleanup', scratch: left })
      expect(report.namespaces.find((n) => n.ns === 'drill.orders')).toMatchObject({ contents: 'match' })
      await new Promise((r) => setTimeout(r, 10))
      expect(got.map((e) => [e.kind, e.severity])).toEqual([['backup.drill.failed', 'warning']])
      await ca.db(left).dropDatabase()
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('never restores into a database that is already there', async () => {
    const h = await harness()
    try {
      const u = h.user({ role: 'admin' })
      const taken = 'mm_drill_aaaaaaaaaaaa'
      await ca.db(taken).collection('keep').insertOne({ mine: true })
      const names = [taken, 'mm_drill_bbbbbbbbbbbb']
      const kind = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        scratchName: () => names.shift() ?? 'mm_drill_cccccccccccc',
      })
      const { done, report } = await run(h, u, kind)
      expect(done.state, done.error ?? '').toBe('done')
      expect(report.ok).toBe(true)
      expect(await ca.db(taken).collection('keep').countDocuments()).toBe(1)
      expect(await scratchDbs()).toEqual([taken])
      await ca.db(taken).dropDatabase()
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('stops before the server runs short of space', async () => {
    const h = await harness()
    try {
      const u = h.user({ role: 'admin' })
      const kind = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        freeBytes: async () => 600,
      })
      const { done, report } = await run(h, u, kind)
      expect(done.state).toBe('failed')
      expect(report).toMatchObject({ ok: false, code: 'drill_space' })
      expect(await scratchDbs()).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 180_000)

  // W4 re-review (minor): through mongos, the shard with the least room decides.
  it('reads the free space of the fullest shard behind a mongos', async () => {
    const asked: string[] = []
    const fake = (answer: unknown) =>
      ({
        db: (name: string) => (asked.push(name), { command: async () => answer }),
      }) as never
    expect(
      await freeSpace(
        fake({
          fsTotalSize: 3000,
          fsUsedSize: 1000,
          raw: {
            a: { fsTotalSize: 1000, fsUsedSize: 100 },
            b: { fsTotalSize: 1000, fsUsedSize: 800 },
            c: { fsTotalSize: 1000, fsUsedSize: 100 },
          },
        }),
      ),
    ).toBe(200)
    expect(await freeSpace(fake({ fsTotalSize: 1000, fsUsedSize: 400 }))).toBe(600)
    expect(await freeSpace(fake({ dataSize: 1 }))).toBeNull()
    // Asked of a data database: through a mongos, admin answers for the config servers.
    await freeSpace(fake({ fsTotalSize: 1, fsUsedSize: 0 }), 'shop')
    expect(asked.at(-1)).toBe('shop')
  })

  it('needs a size cap where the server does not say its free space, and a known right to drop', async () => {
    const h = await harness()
    try {
      const u = h.user({ role: 'admin' })
      const unknown = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        freeBytes: async () => null,
      })
      const { done, report } = await run(h, u, unknown)
      expect(done.state).toBe('failed')
      expect(report).toMatchObject({ ok: false, code: 'drill_space_unknown' })
      // With an explicit cap the drill goes on, within it.
      h.ctx.backup.limits.drillMaxBytes = 64 * 1024 * 1024
      const capped = await run(h, u, unknown)
      expect(capped.done.state, capped.done.error ?? '').toBe('done')
      h.ctx.backup.limits.drillMaxBytes = 1
      const tooBig = await run(h, u, unknown)
      expect(tooBig.report).toMatchObject({ ok: false, code: 'drill_space' })
      h.ctx.backup.limits.drillMaxBytes = null
      // Whether the user may drop cannot be read: refused, never assumed.
      const blind = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        connectionStatus: async () => null,
      })
      const refused = await run(h, u, blind)
      expect(refused.report).toMatchObject({ ok: false, code: 'drill_cleanup_rights' })
      expect(await scratchDbs()).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 600_000)

  it('knows whether the connection’s user may drop the scratch database', () => {
    const status = (privileges: unknown[], users = [{ user: 'u', db: 'admin' }]) => ({
      authInfo: { authenticatedUsers: users, authenticatedUserPrivileges: privileges },
    })
    const db = 'mm_drill_0123456789ab'
    expect(mayDropDatabases(status([], []), db)).toBe(true)
    expect(
      mayDropDatabases(status([{ resource: { db: '', collection: '' }, actions: ['dropDatabase'] }]), db),
    ).toBe(true)
    expect(
      mayDropDatabases(status([{ resource: { db, collection: '' }, actions: ['dropDatabase'] }]), db),
    ).toBe(true)
    expect(
      mayDropDatabases(status([{ resource: { db: 'shop', collection: '' }, actions: ['dropDatabase'] }]), db),
    ).toBe(false)
    expect(
      mayDropDatabases(status([{ resource: { db: '', collection: '' }, actions: ['insert', 'find'] }]), db),
    ).toBe(false)
    expect(
      mayDropDatabases(status([{ resource: { anyResource: true }, actions: ['dropDatabase'] }]), db),
    ).toBe(true)
  })
})

describe('a drill and personal data (W4 review C1)', () => {
  it('gives the scratch copy the backup’s rules and keeps it out of everyone’s reach while it runs', async () => {
    const h = await harness()
    try {
      // An unmasked backup of drill.users, whose names are personal data.
      h.rules('A', [{ db: 'drill', coll: 'users', field: 'name' }])
      const admin = h.user({ role: 'admin' })
      const backupId = await keptBackup(h, admin)
      // Rules taken off after the backup: the backup's own still cover its scratch copy.
      h.rules('A', [])
      const viewer = h.user({ role: 'viewer', masked: ['A'] })
      const seen: Record<string, unknown> = {}
      const kind = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        afterLoad: async (_client, scratch) => {
          seen.scratch = scratch
          seen.rules = h.ctx.personalFields.get(h.ids.A).rules
          seen.stored = (await admin.get(`/api/connections/${h.ids.A}/personal-fields`)).json().rules
          const names = async (u: typeof viewer) =>
            (
              (await u.get(`/api/connections/${h.ids.A}/databases`)).json().databases as Array<{
                name: string
              }>
            ).map((d) => d.name)
          seen.viewerList = await names(viewer)
          seen.adminList = await names(admin)
          const find = (u: typeof viewer) =>
            u.call('POST', `/api/connections/${h.ids.A}/databases/${scratch}/collections/drill.users/find`, {
              filter: {},
            })
          seen.viewerFind = (await find(viewer)).statusCode
          seen.adminFind = (await find(admin)).statusCode
        },
      })
      const job = h.ctx.jobs.start(
        kind,
        { userId: admin.id, connectionId: h.ids.A, db: 'drill', coll: '*', target: 'drill backup' },
        { owner: admin.id, backupId, schedule: null },
      )
      const done = await waitJob(h.t, job.id, 60_000)
      expect(done.state, done.error ?? '').toBe('done')
      const scratch = seen.scratch as string
      expect(seen.rules).toContainEqual({ db: scratch, coll: 'drill.users', field: 'name' })
      // Never stored: the rules page shows what the admins set, and the rules' version does not move.
      expect(seen.stored).toEqual([])
      expect(seen.viewerList).not.toContain(scratch)
      expect(seen.adminList).not.toContain(scratch)
      expect(seen.viewerFind).toBe(403)
      expect(seen.adminFind).toBe(403)
      // Gone with the scratch database.
      expect(h.ctx.personalFields.get(h.ids.A).rules).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 180_000)
})

// Re-review of W4 (C1): a scratch database named in a body (live sync, copy, compare) or seen on the
// Performance page, and a masker compiled before the drill began.
describe('a drill’s scratch database, every way in (W4 re-review C1)', () => {
  it('is refused as a source or a target, never shown, and masked by a masker made before', async () => {
    const h = await harness()
    try {
      h.rules('A', [{ db: 'drill', coll: 'users', field: 'name' }])
      const admin = h.user({ role: 'admin' })
      const backupId = await keptBackup(h, admin)
      const editor = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' }, masked: ['A'] })
      const principal = { kind: 'user', userId: editor.id, role: 'editor' } as never
      // Compiled before the drill: a cache keyed on the rules' version alone would keep it.
      maskerForPrincipal(h.ctx, principal, h.ids.A)
      const seen: Record<string, unknown> = {}
      const kind = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        afterLoad: async (_client, scratch) => {
          seen.scratch = scratch
          const masker = maskerForPrincipal(h.ctx, principal, h.ids.A)
          seen.masked = masker?.forNs(scratch, 'drill.users').matches(['name']) ?? false
          const A = `/api/connections/${h.ids.A}`
          seen.liveSync = (
            await editor.call('POST', `${A}/live-syncs/plan`, {
              source: { connectionId: h.ids.A, db: scratch, coll: 'drill.users' },
              target: { connectionId: h.ids.B, db: 'mine', coll: 'users' },
              startMode: 'copy',
              confirmOverwrite: true,
            })
          ).statusCode
          seen.copyInto = (
            await editor.call('POST', `${A}/databases/drill/collections/orders/copy/plan`, {
              target: { connectionId: h.ids.B, db: scratch, coll: 'x' },
              mode: 'insert',
            })
          ).statusCode
          seen.compareWith = (
            await editor.call('POST', `${A}/databases/drill/collections/orders/compare`, {
              target: { connectionId: h.ids.A, db: scratch, coll: 'drill.orders' },
            })
          ).statusCode
          seen.create = (
            await admin.call('POST', `${A}/databases`, { name: scratch.replace(/.$/, 'f'), collection: 'x' })
          ).statusCode
          const top = await editor.get(`${A}/server/top`)
          seen.top = JSON.stringify(top.json())
          const dbs = (await admin.get(`${A}/databases`)).json() as {
            databases: Array<{ sizeOnDisk: number }>
            totalSize: number
          }
          seen.total = [dbs.totalSize, dbs.databases.reduce((n, d) => n + d.sizeOnDisk, 0)]
        },
      })
      const job = h.ctx.jobs.start(
        kind,
        { userId: admin.id, connectionId: h.ids.A, db: 'drill', coll: '*', target: 'drill backup' },
        { owner: admin.id, backupId, schedule: null },
      )
      const done = await waitJob(h.t, job.id, 60_000)
      expect(done.state, done.error ?? '').toBe('done')
      const scratch = seen.scratch as string
      expect(seen.masked).toBe(true)
      expect([seen.liveSync, seen.copyInto, seen.compareWith, seen.create]).toEqual([403, 403, 403, 403])
      expect(seen.top).not.toContain(scratch)
      const [total, listed] = seen.total as [number, number]
      expect(total).toBe(listed)
    } finally {
      await h.t.close()
    }
  }, 180_000)
})

// W4 re-review (minor): a scratch database a drill could not drop is dropped from the app.
describe('dropping a drill’s leftover scratch database', () => {
  it('is for the connection’s admins, by its typed name, never while a drill runs, and audited', async () => {
    const h = await harness()
    try {
      const left = 'mm_drill_abcdefabcdef'
      await ca.db(left).collection('x').insertOne({ a: 1 })
      const admin = h.user({ role: 'admin' })
      const editor = h.user({ role: 'editor', on: { A: 'editor' } })
      const A = `/api/connections/${h.ids.A}/backup/drill-leftovers`
      const listed = await admin.get(A)
      expect(listed.statusCode, listed.body).toBe(200)
      expect(listed.json().databases.map((d: { name: string }) => d.name)).toContain(left)
      expect((await editor.get(A)).statusCode).toBe(403)
      const drop = (u: typeof admin, body: Record<string, unknown>) => u.call('POST', `${A}/drop`, body)
      expect((await drop(editor, { name: left, confirm: left })).statusCode).toBe(403)
      expect((await drop(admin, { name: left, confirm: 'nope' })).statusCode).toBe(400)
      // Only a drill's scratch name: never another database.
      await ca.db('keep_me').collection('x').insertOne({ a: 1 })
      expect((await drop(admin, { name: 'keep_me', confirm: 'keep_me' })).statusCode).toBe(400)
      // Not while a drill runs on the connection.
      const busy = h.ctx.jobs.list.bind(h.ctx.jobs)
      h.ctx.jobs.list = ((q?: { state?: string }) =>
        q?.state === 'running'
          ? [{ kind: 'backup.drill', connectionId: h.ids.A, state: 'running' }]
          : busy(q as never)) as never
      expect((await drop(admin, { name: left, confirm: left })).json().details?.reason).toBe('drill_running')
      // A drill on another connection (it may point at the same deployment) holds it too.
      h.ctx.jobs.list = ((q?: { state?: string }) =>
        q?.state === 'running'
          ? [{ kind: 'backup.drill', connectionId: h.ids.B, state: 'running' }]
          : busy(q as never)) as never
      expect((await drop(admin, { name: left, confirm: left })).json().details?.reason).toBe('drill_running')
      h.ctx.jobs.list = busy
      const ok = await drop(admin, { name: left, confirm: left })
      expect(ok.statusCode, ok.body).toBe(200)
      expect(await scratchDbs()).not.toContain(left)
      expect(await ca.db('keep_me').collection('x').countDocuments()).toBe(1)
      expect(h.ctx.audit.list({ limit: 20 }).some((r) => r.action === 'backup.drillCleanup')).toBe(true)
    } finally {
      await h.t.close()
    }
  })
})

describe('a scratch database left by a stopped server', () => {
  it('is dropped at the next open — and a database the job did not name as its scratch never is', async () => {
    const client = ca
    const scratch = `mm_drill_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    await client.db(scratch).collection('x').insertOne({ a: 1 })
    await client.db('drill_keep').collection('x').insertOne({ a: 1 })
    const forgotten: string[] = []
    const jobs = {
      withStaging: () => [
        { id: 'j1', db: 'drill', state: 'interrupted', staging: DRILL_STAGING, stagingDb: scratch },
        // A row naming another database as its scratch is never followed (abuse case).
        { id: 'j2', db: 'drill', state: 'interrupted', staging: DRILL_STAGING, stagingDb: 'drill_keep' },
      ],
      forgetStaging: (id: string) => void forgotten.push(id),
    }
    await dropLeftoverStaging(jobs, 'c1', client, { warn: () => undefined })
    expect(await scratchDbs()).not.toContain(scratch)
    expect(
      (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name),
    ).toContain('drill_keep')
    expect(forgotten).toEqual(['j1'])
    await client.db('drill_keep').dropDatabase()
  })
})

describe('scheduled drills', () => {
  async function schedule(h: H, everyRuns: number) {
    const admin = h.user({ role: 'admin' })
    const u = h.user({ on: { A: 'editor' } })
    const folder = (
      await admin.call('POST', '/api/backup-destinations', {
        type: 'folder',
        name: `disk-${randomUUID().slice(0, 6)}`,
        config: { path: join(root(), randomUUID()) },
        policy: { encryptedOnly: true },
      })
    ).json()
    await admin.call('PUT', `/api/backup-destinations/${folder.id}/grants`, {
      grants: [{ userId: u.id, level: 'send' }],
    })
    await confirmedKey(u)
    const res = await u.call('POST', '/api/backup-schedules', {
      name: 'Nightly drill',
      connectionId: h.ids.A,
      dump: { scope: { kind: 'database', db: 'drill' } },
      format: 'mmbak',
      cadence: { kind: 'daily', times: ['02:00'] },
      timeZone: 'UTC',
      destinations: [folder.id],
      drill: { everyRuns },
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().drill).toEqual({ everyRuns })
    return { u, id: res.json().id as string }
  }
  async function runNow(h: H, scheduleId: string, dueAt: number) {
    const run = h.ctx.backup.runs.insert({ scheduleId, dueAt, kind: 'manual' })!
    await executeRun(h.ctx, run.id)
    return h.ctx.backup.runs.get(run.id)!
  }

  it('drills every Nth run with the owner’s key, and lets the server copy go afterwards', async () => {
    const h = await harness()
    try {
      const got = events(h)
      const { id } = await schedule(h, 2)
      const first = await runNow(h, id, h.ctx.now())
      expect(first.outcome).toBe('succeeded')
      expect(first.details.drill).toBeUndefined()
      const second = await runNow(h, id, h.ctx.now() + 1)
      expect(second.outcome).toBe('succeeded')
      expect(second.details.drill).toMatchObject({ state: 'passed', namespaces: 3 })
      // The copy kept for the drill goes once every destination has its own.
      expect(h.ctx.backup.store.byId(second.backupId!)).toBeUndefined()
      expect(await scratchDbs()).toEqual([])
      await new Promise((r) => setTimeout(r, 10))
      expect(got.map((e) => e.kind)).toContain('backup.drill.passed')
      // The run's view says so.
      const runs = (await h.user({ role: 'admin' }).get(`/api/backup-schedules/${id}/runs`)).json() as Array<{
        drill: unknown
      }>
      expect(runs[0]!.drill).toMatchObject({ state: 'passed' })
    } finally {
      await h.t.close()
    }
  })

  it('skips the drill, never the backup, where the owner may not write (a read-only connection)', async () => {
    const h = await harness()
    try {
      const { id } = await schedule(h, 1)
      h.ctx.connections.update(h.ids.A, { readOnly: true } as never)
      const run = await runNow(h, id, h.ctx.now())
      expect(run.outcome).toBe('succeeded')
      expect(run.details.drill).toMatchObject({ state: 'skipped', reason: 'drill_rights' })
      expect(await scratchDbs()).toEqual([])
    } finally {
      await h.t.close()
    }
  })

  it('refuses a drill setting out of bounds', async () => {
    const h = await harness()
    try {
      const u = h.user({ on: { A: 'editor' } })
      const create = async (drill: unknown) =>
        (
          await u.call('POST', '/api/backup-schedules', {
            name: 'x',
            connectionId: h.ids.A,
            dump: { scope: { kind: 'database', db: 'drill' } },
            format: 'mmbak',
            cadence: { kind: 'daily', times: ['02:00'] },
            timeZone: 'UTC',
            destinations: [randomUUID()],
            drill,
          })
        ).json() as { code?: string; details?: { issues?: Array<{ path: string[] }> } }
      for (const drill of [{ everyRuns: 0 }, { everyRuns: 31 }, { everyRuns: 1.5 }, { everyRuns: 2, x: 1 }]) {
        const answer = await create(drill)
        expect(JSON.stringify(answer)).toMatch(/drill/)
      }
      // In bounds, the setting passes validation (the unknown destination is what is refused then).
      expect(JSON.stringify(await create({ everyRuns: 30 }))).not.toMatch(/drill/)
    } finally {
      await h.t.close()
    }
  })
})
