// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { confirmedKey } from './support/schedules'
import { executeRun } from '../src/backup/schedules/run'
import { RETAINED } from '../src/backup/store'
import { applyRetention } from '../src/backup/schedules/retention-run'
import { slow } from './support/slowness'

const DAY = 86_400_000
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
    .insertMany([{ n: 1 }, { n: 2 }])
  base = mkdtempSync(join(tmpdir(), 'mm-sched-ret-'))
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
const tight = { last: 2, daily: 0, weekly: 0, monthly: 0 }

async function setup(
  h: H,
  opts: { s3?: boolean; keepOnServer?: boolean; retention?: object; path?: string } = {},
) {
  const admin = h.user({ role: 'admin' })
  const u = h.user({ on: { A: 'editor' } })
  const path = opts.path ?? join(root(), randomUUID())
  const folder = (
    await admin.call('POST', '/api/backup-destinations', {
      type: 'folder',
      name: `disk-${randomUUID().slice(0, 6)}`,
      config: { path },
    })
  ).json()
  const ids = [folder.id as string]
  if (opts.s3)
    ids.push(
      (
        await admin.call('POST', '/api/backup-destinations', {
          type: 's3',
          name: `nowhere-${randomUUID().slice(0, 6)}`,
          config: {
            preset: 'custom',
            endpoint: 'https://192.0.2.10',
            region: 'us-east-1',
            bucket: 'acme-backups',
          },
          secrets: { accessKeyId: 'AKIAEXAMPLE0001', secretAccessKey: 'secret-secret-secret' },
        })
      ).json().id,
    )
  for (const id of ids)
    await admin.call('PUT', `/api/backup-destinations/${id}/grants`, {
      grants: [{ userId: u.id, level: 'send' }],
    })
  await confirmedKey(u)
  const make = async (name: string) =>
    (
      await u.call('POST', '/api/backup-schedules', {
        name,
        connectionId: h.ids.A,
        dump: { scope: { kind: 'database', db: 'shop' } },
        cadence: { kind: 'daily', times: ['02:00'] },
        timeZone: 'UTC',
        destinations: ids,
        keepOnServer: opts.keepOnServer ?? false,
        retention: opts.retention ?? tight,
      })
    ).json().id as string
  return { u, folder, path, ids, id: await make('Nightly'), make }
}
/** A run a day after the previous one (retention counts days in the schedule's zone). */
async function nextDay(h: H, scheduleId: string) {
  h.t.clock.now += DAY
  const run = h.ctx.backup.runs.insert({ scheduleId, dueAt: h.ctx.now(), kind: 'scheduled' })!
  await executeRun(h.ctx, run.id)
  return h.ctx.backup.runs.get(run.id)!
}
/** A complete copy row the schedule (or none) made `ago` days back, at a layout key, with or without a file. */
function fakeCopy(h: H, destinationId: string, owner: string, scheduleId: string | null, ago: number) {
  const id = randomUUID()
  const at = h.ctx.now() - ago * DAY
  const key = `mongo-manager/2025/12/mm-20251201-020000-${id.slice(0, 8)}.mmbak`
  h.ctx.store.db
    .prepare(
      `INSERT INTO backup_remote_copies (id, destination_id, backup_id, remote_key, owner, connection_id, meta, format,
        size, sha256, state, created_at, completed_at, schedule_id) VALUES (?, ?, NULL, ?, ?, NULL, ?, 'mmbak', 1, ?, 'complete', ?, ?, ?)`,
    )
    .run(id, destinationId, key, owner, JSON.stringify({ startedAt: at }), 'a'.repeat(64), at, at, scheduleId)
  return { id, key }
}
const files = (dir: string) =>
  existsSync(dir)
    ? (
        readdirSync(dir, { recursive: true, withFileTypes: true }) as Array<{
          isFile(): boolean
          name: string
        }>
      )
        .filter((e) => e.isFile() && e.name.endsWith('.mmbak'))
        .map((e) => e.name)
    : []

describe('retention (phase 3d-3c spec §1.4, D6)', () => {
  it('removes what the policy no longer keeps after each run, and audits each removal by its file name', async () => {
    const h = await harness()
    try {
      const { folder, path, id } = await setup(h)
      for (let i = 0; i < 4; i++) await nextDay(h, id)
      const last = h.ctx.backup.runs.list(id)[0]!
      expect(last.details.removals).toEqual([
        { location: folder.id, name: folder.name, removed: 1, failed: 0, waiting: 0 },
      ])
      expect(h.ctx.backup.copies.forSchedule(id, folder.id)).toHaveLength(2)
      expect(files(path)).toHaveLength(2)
      const audit = h.ctx.store.db
        .prepare("SELECT details FROM audit_log WHERE action = 'backup.retention.delete'")
        .all() as Array<{ details: string }>
      expect(audit).toHaveLength(2)
      expect(JSON.parse(audit[0]!.details)).toMatchObject({
        schedule: id,
        destination: folder.id,
        name: expect.stringMatching(/^mm-.*\.mmbak$/),
      })
    } finally {
      await h.t.close()
    }
  })

  it('removes only where this run’s copy completed, and only the schedule’s own copies (D6)', async () => {
    const h = await harness()
    try {
      const { u, folder, path, ids, id, make } = await setup(h, { s3: true })
      const other = await make('Weekly')
      const manual = fakeCopy(h, folder.id, u.id, null, 30)
      const theirs = fakeCopy(h, folder.id, u.id, other, 30)
      const atS3 = fakeCopy(h, ids[1]!, u.id, id, 30)
      const foreign = join(path, 'mongo-manager', '2025', '11', 'mm-20251101-020000-ffffffff.mmbak')
      mkdirSync(join(foreign, '..'), { recursive: true })
      writeFileSync(foreign, 'not ours')
      for (let i = 0; i < 3; i++) expect((await nextDay(h, id)).outcome).toBe('partial')
      expect(h.ctx.backup.copies.forSchedule(id, folder.id)).toHaveLength(2)
      for (const kept of [manual, theirs, atS3]) expect(h.ctx.backup.copies.get(kept.id)).toBeDefined()
      expect(existsSync(foreign)).toBe(true)
      expect(h.ctx.backup.runs.list(id)[0]!.details.removals).toEqual([
        { location: folder.id, name: folder.name, removed: 1, failed: 0, waiting: 0 },
      ])
    } finally {
      await h.t.close()
    }
  })

  it('never removes after a failing run, never the newest, at most 100 a run, and keeps a failed removal for later', async () => {
    const h = await harness()
    try {
      const path = join(root(), randomUUID())
      const { u, folder, id } = await setup(h, {
        path,
        retention: { last: 1, daily: 0, weekly: 0, monthly: 0 },
      })
      const fakes = Array.from({ length: 105 }, (_, i) => fakeCopy(h, folder.id, u.id, id, i + 1))
      // The newest fake cannot be removed: a directory stands where its file would be.
      mkdirSync(join(path, ...fakes[0]!.key.split('/')), { recursive: true })
      // A failing run (the destination's folder is a file) removes nothing.
      const blocked = join(root(), randomUUID())
      writeFileSync(blocked, 'x')
      h.ctx.store.db
        .prepare('UPDATE backup_destinations SET config = ? WHERE id = ?')
        .run(JSON.stringify({ path: blocked }), folder.id)
      expect((await nextDay(h, id)).outcome).toBe('failed')
      expect(h.ctx.backup.copies.forSchedule(id, folder.id)).toHaveLength(105)
      h.ctx.store.db
        .prepare('UPDATE backup_destinations SET config = ? WHERE id = ?')
        .run(JSON.stringify({ path }), folder.id)
      const first = await nextDay(h, id)
      expect(first.outcome).toBe('succeeded')
      expect(first.details.removals).toEqual([
        { location: folder.id, name: folder.name, removed: 99, failed: 1, waiting: 5 },
      ])
      const newest = h.ctx.backup.copies.forRun(id, first.backupId!)[0]!
      expect(h.ctx.backup.copies.get(newest.id)).toBeDefined()
      const second = await nextDay(h, id)
      expect(second.details.removals).toEqual([
        { location: folder.id, name: folder.name, removed: 6, failed: 1, waiting: 0 },
      ])
      expect(h.ctx.backup.copies.get(fakes[0]!.id)).toBeDefined()
      expect(
        h.ctx.backup.copies
          .forSchedule(id, folder.id)
          .map((c) => c.id)
          .sort(),
      ).toEqual([fakes[0]!.id, h.ctx.backup.copies.forRun(id, second.backupId!)[0]!.id].sort())
    } finally {
      await h.t.close()
    }
  })

  it('keeps server copies under the same rule when the schedule keeps them', async () => {
    const h = await harness()
    try {
      const { id } = await setup(h, { keepOnServer: true })
      for (let i = 0; i < 3; i++) expect((await nextDay(h, id)).outcome).toBe('succeeded')
      const kept = h.ctx.backup.store.bySchedule(id)
      expect(kept).toHaveLength(2)
      for (const k of kept) expect(k.expiresAt).toBe(RETAINED)
      expect(h.ctx.backup.runs.list(id)[0]!.details.removals).toEqual(
        expect.arrayContaining([{ location: 'server', name: null, removed: 1, failed: 0, waiting: 0 }]),
      )
    } finally {
      await h.t.close()
    }
  })
})

describe('retention at the moment of removal (final review minors 18, 19)', () => {
  // Minor 18: a grant revoked during a run still let retention delete there with the stored secrets.
  it('removes nothing at a destination its owner may no longer use', async () => {
    const h = await harness()
    try {
      const { u, folder, id } = await setup(h)
      const s = h.ctx.backup.schedules.get(id)!
      const old = [3, 4, 5].map((ago) => fakeCopy(h, folder.id, u.id, id, ago))
      const newest = fakeCopy(h, folder.id, u.id, id, 0)
      await h
        .user({ role: 'admin' })
        .call('PUT', `/api/backup-destinations/${folder.id}/grants`, { grants: [] })
      const out = await applyRetention(h.ctx, s, { id: folder.id, name: folder.name }, newest.id)
      expect(out.removed).toBe(0)
      for (const c of old) expect(h.ctx.backup.copies.get(c.id)).toBeDefined()
    } finally {
      await h.t.close()
    }
  })

  // Minor 19: a server copy a send is still reading was reported as a removal that failed.
  it('counts a server copy a send is still reading as waiting, not failed', async () => {
    const h = await harness()
    try {
      const { u, id } = await setup(h, { keepOnServer: true })
      const s = h.ctx.backup.schedules.get(id)!
      const row = (ago: number) => {
        const backup = randomUUID()
        h.ctx.store.db
          .prepare(
            "INSERT INTO backups (id, owner, kind, name, size, complete, meta, created_at, expires_at, schedule_id) VALUES (?, ?, 'backup', ?, 1, 1, ?, ?, ?, ?)",
          )
          .run(
            backup,
            u.id,
            `b-${ago}`,
            JSON.stringify({ startedAt: h.ctx.now() - ago * DAY }),
            h.ctx.now() - ago * DAY,
            RETAINED,
            id,
          )
        return backup
      }
      const busy = row(5)
      row(4)
      row(3)
      const newest = row(0)
      h.ctx.backup.transfers.set('reading', { kind: 'send', backupId: busy } as never)
      const out = await applyRetention(h.ctx, s, { id: 'server', name: null }, newest)
      expect(out.failed).toBe(0)
      expect(out.waiting).toBeGreaterThanOrEqual(1)
      expect(h.ctx.backup.store.byId(busy)).toBeDefined()
      h.ctx.backup.transfers.delete('reading')
    } finally {
      await h.t.close()
    }
  })
})
