import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, DumpRequestSchema, type DumpReport } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { confirmedKey, teamApp } from './support/schedules'
import { planDump } from '../src/backup/dump-plan'
import { backupFileName } from '../src/backup/dump-job'
import { readMmbakHeader } from '../src/backup/mmbak'
import { RETAINED } from '../src/backup/store'
import { assertBackupRoom } from '../src/backup/room'
import { noteJob } from '../src/backup/send-job'
import { toView } from '../src/jobs/visibility'
import type { Principal } from '../src/http/context'
import type { JobKind } from '../src/jobs/types'
import { slow } from './support/slowness'

type H = Awaited<ReturnType<typeof backupHarness>>
const principalOf = (ctx: H['ctx'], id: string): Principal => {
  const u = ctx.users.findById(id)!
  return {
    kind: 'user',
    userId: u.id,
    username: u.username,
    role: u.role,
    csrfToken: '',
    sessionId: '',
    sessionIdHash: '',
  }
}

describe('scheduled dumps (phase 3d-3c spec §1.5 steps 3–4, plan rulings 11, 14, 15)', () => {
  let a: TestMongo
  let b: TestMongo
  let ca: MongoClient
  let base: string
  const root = () => join(base, 'root')
  beforeAll(async () => {
    ;[a, b] = await Promise.all([startMongo(), startMongo()])
    ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
    await ca.db('shop').dropDatabase()
    await ca
      .db('shop')
      .collection('orders')
      .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }])
    base = mkdtempSync(join(tmpdir(), 'mm-sched-dump-'))
    mkdirSync(root())
  }, slow(180_000))
  afterAll(async () => {
    await ca?.close()
    await Promise.all([a?.stop(), b?.stop()])
    if (base) rmSync(base, { recursive: true, force: true })
  })

  const harness = () => backupHarness(a, b, { backup: { folderRoots: [root()] } } as never)
  /** A schedule row for the foreign keys (Task 13 brings its repository). */
  function scheduleRow(h: H, owner: string): string {
    const id = randomUUID()
    h.ctx.store.db
      .prepare(
        `INSERT INTO backup_schedules (id, owner, connection_id, name, request, format, key_id, cadence, time_zone,
          destinations, keep_on_server, retention, state, created_at, updated_at)
         VALUES (?, ?, ?, 'Nightly', '{}', 'mmbak', NULL, '{}', 'UTC', '[]', 0, '{}', 'active', 1, 1)`,
      )
      .run(id, owner, h.ids.A)
    return id
  }
  async function setup(h: H) {
    const admin = h.user({ role: 'admin' })
    const u = h.user({ on: { A: 'editor' } })
    const dest = (
      await admin.call('POST', '/api/backup-destinations', {
        type: 'folder',
        name: `disk-${randomUUID().slice(0, 6)}`,
        config: { path: join(root(), randomUUID()) },
      })
    ).json()
    await admin.call('PUT', `/api/backup-destinations/${dest.id}/grants`, {
      grants: [{ userId: u.id, level: 'send' }],
    })
    return { u, dest, key: await confirmedKey(u) }
  }
  async function scheduledDump(
    h: H,
    userId: string,
    opts: { scheduleId: string; keep: boolean; destinations: string[]; key: { id: string; key: Buffer } },
  ) {
    const principal = principalOf(h.ctx, userId)
    const request = DumpRequestSchema.parse({
      scope: { kind: 'database', db: 'shop' },
      format: 'mmbak',
      destinations: opts.destinations,
      deleteLocal: !opts.keep,
    })
    const release = h.ctx.manager.hold(h.ids.A)
    try {
      const client = await h.ctx.manager.getClient(h.ids.A)
      const prepared = await planDump(
        { ctx: h.ctx, principal, connectionId: h.ids.A, client, comment: 'test' },
        request,
      )
      expect(prepared.plan.refusals).toEqual([])
      const fileName = backupFileName(request.scope, 'mmbak', h.ctx.now())
      return h.ctx.jobs.start(
        h.ctx.jobKinds['backup.dump'],
        { userId, connectionId: h.ids.A, db: 'shop', coll: '*', target: fileName },
        {
          owner: userId,
          request: { ...request, planHash: prepared.plan.planHash },
          password: null,
          serverKey: { keyId: opts.key.id, key: Buffer.from(opts.key.key) },
          prepared,
          fileName,
          sendAs: principal,
          schedule: { id: opts.scheduleId, name: 'Nightly', runId: randomUUID(), keep: opts.keep },
        },
        { scheduled: true },
      )
    } finally {
      release()
    }
  }

  it('plans a dump as a principal, without a request (plan ruling 11)', async () => {
    const h = await harness()
    try {
      const u = h.user({ on: { A: 'editor' } })
      const client = await h.ctx.manager.getClient(h.ids.A)
      const prepared = await planDump(
        { ctx: h.ctx, principal: principalOf(h.ctx, u.id), connectionId: h.ids.A, client, comment: 'test' },
        DumpRequestSchema.parse({ scope: { kind: 'database', db: 'shop' } }),
      )
      expect(prepared.plan.refusals).toEqual([])
      expect(prepared.plan.namespaces.map((n) => n.coll)).toEqual(['orders'])
    } finally {
      await h.t.close()
    }
  })

  it('writes the owner’s key slot, sends the dump, and marks the backup and its copy with the schedule', async () => {
    const h = await harness()
    try {
      const { u, dest, key } = await setup(h)
      const scheduleId = scheduleRow(h, u.id)
      const job = await scheduledDump(h, u.id, { scheduleId, keep: false, destinations: [dest.id], key })
      expect((await waitJob(h.t, job.id, 60_000)).state).toBe('done')
      const report = h.ctx.transfer.reports.get(u.id, job.id) as DumpReport
      expect(report.sendJobId).toBeTruthy()
      expect((await waitJob(h.t, report.sendJobId!, 60_000)).state).toBe('done')
      const [copy, ...more] = h.ctx.backup.copies.forRun(scheduleId, report.backupId!)
      expect(more).toEqual([])
      expect(copy).toMatchObject({ state: 'complete', scheduleId, origin: report.backupId })
      expect(copy!.meta?.keyId).toBe(key.id)
      // "Delete the local copy": the backup row is gone, the copy remembers where it came from.
      expect(h.ctx.backup.store.byId(report.backupId!)).toBeUndefined()
      expect(h.ctx.backup.copies.forSchedule(scheduleId, dest.id).map((c) => c.id)).toEqual([copy!.id])
      const remote = readFileSync(join(dest.config.path, ...copy!.remoteKey.split('/')))
      const header = readMmbakHeader(remote)
      if (header === 'more') throw new Error('incomplete header')
      expect(header.header.keySlots).toEqual([expect.objectContaining({ type: 'server', keyId: key.id })])
      const principal = principalOf(h.ctx, u.id)
      expect(toView(h.ctx, principal, h.ctx.jobs.get(job.id)!).scheduleName).toBe('Nightly')
      expect(toView(h.ctx, principal, h.ctx.jobs.get(report.sendJobId!)!).scheduleName).toBe('Nightly')
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('keeps a "keep on the server too" backup until its schedule goes (plan ruling 15)', async () => {
    const h = await harness()
    try {
      const { u, dest, key } = await setup(h)
      const scheduleId = scheduleRow(h, u.id)
      const job = await scheduledDump(h, u.id, { scheduleId, keep: true, destinations: [dest.id], key })
      expect((await waitJob(h.t, job.id, 60_000)).state).toBe('done')
      const report = h.ctx.transfer.reports.get(u.id, job.id) as DumpReport
      await waitJob(h.t, report.sendJobId!, 60_000)
      const kept = h.ctx.backup.store.byId(report.backupId!)!
      expect(kept).toMatchObject({ scheduleId, expiresAt: RETAINED })
      expect(h.ctx.backup.store.bySchedule(scheduleId).map((r) => r.id)).toEqual([kept.id])
      h.ctx.store.db.prepare('DELETE FROM backup_schedules WHERE id = ?').run(scheduleId)
      h.ctx.backup.store.sweep()
      expect(h.ctx.backup.store.byId(kept.id)).toMatchObject({
        scheduleId: null,
        expiresAt: h.ctx.now() + h.ctx.backup.limits.ttlMs,
      })
    } finally {
      await h.t.close()
    }
  }, 180_000)

  // Final review I3 (spec §1.4): "manual sends … are never candidates" for a schedule's retention.
  it('never marks a hand-made send of a scheduled backup with its schedule', async () => {
    const h = await harness()
    try {
      const { u, dest, key } = await setup(h)
      const admin = h.user({ role: 'admin' })
      const other = (
        await admin.call('POST', '/api/backup-destinations', {
          type: 'folder',
          name: `hand-${randomUUID().slice(0, 6)}`,
          config: { path: join(root(), randomUUID()) },
        })
      ).json()
      await admin.call('PUT', `/api/backup-destinations/${other.id}/grants`, {
        grants: [{ userId: u.id, level: 'send' }],
      })
      const scheduleId = scheduleRow(h, u.id)
      const job = await scheduledDump(h, u.id, { scheduleId, keep: true, destinations: [dest.id], key })
      expect((await waitJob(h.t, job.id, 60_000)).state).toBe('done')
      const report = h.ctx.transfer.reports.get(u.id, job.id) as DumpReport
      await waitJob(h.t, report.sendJobId!, 60_000)
      const send = await u.call('POST', `/api/backups/${report.backupId}/send`, {
        destinationIds: [other.id],
        deleteLocal: false,
      })
      expect(send.statusCode, send.body).toBe(202)
      await waitJob(h.t, send.json().job.id, 60_000)
      const byHand = h.ctx.backup.copies.byBackup(report.backupId!).find((c) => c.destinationId === other.id)
      expect(byHand).toMatchObject({ state: 'complete', scheduleId: null })
      expect(h.ctx.backup.copies.forSchedule(scheduleId, other.id)).toEqual([])
      // The schedule's own copy keeps its mark.
      expect(h.ctx.backup.copies.forSchedule(scheduleId, dest.id)).toHaveLength(1)
    } finally {
      await h.t.close()
    }
  }, 240_000)
})

describe('scheduled jobs and the owner’s limits (plan ruling 13)', () => {
  it('does not count scheduled jobs against the owner’s backup room or the runner’s per-user cap', async () => {
    const { t, ctx, user } = await teamApp()
    try {
      const u = user()
      const principal: Principal = {
        kind: 'user',
        userId: u.id,
        username: u.username,
        role: 'editor',
        csrfToken: '',
        sessionId: '',
        sessionIdHash: '',
      }
      const connections = Array.from(
        { length: 4 },
        (_, i) =>
          ctx.connections.create(
            {
              name: `C${i}`,
              favorite: false,
              readOnly: false,
              settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
            },
            null,
          ).id,
      )
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const blocking: JobKind<object> = {
        name: 'backup.dump',
        run: () => gate,
        cancel: async () => true,
        recover: () => 'interrupted',
      }
      const target = (connectionId: string) => ({
        userId: u.id,
        connectionId,
        db: 'shop',
        coll: '*',
        target: 'x',
      })
      const scheduled = Array.from({ length: 3 }, () =>
        ctx.jobs.start(blocking, target(connections[0]!), {}, { scheduled: true }),
      )
      for (const j of scheduled) noteJob(ctx, j.id, { schedule: { id: 's', name: 'Nightly' } })
      expect(() => assertBackupRoom(ctx, principal)).not.toThrow()
      const own = [1, 1, 2, 2].map((i) => ctx.jobs.start(blocking, target(connections[i]!), {}))
      expect(() => assertBackupRoom(ctx, principal)).toThrow(/backups or restores running/)
      expect(() => ctx.jobs.start(blocking, target(connections[3]!), {})).toThrow(/You already have 4 jobs/)
      release()
      await Promise.all([...scheduled, ...own].map((j) => waitJob(t, j.id)))
    } finally {
      await t.close()
    }
  }, 120_000)
})
