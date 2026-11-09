// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionSettingsSchema, RETENTION_PRESETS, type Cadence } from '@mongo-manager/shared'
import { confirmedKey, teamApp } from './support/schedules'
import { nextRunOf, type NewSchedule } from '../src/backup/schedules/repo'
import { toRunView, toScheduleView } from '../src/backup/schedules/views'
import { previewRemovals } from '../src/backup/schedules/retention-run'
import { removeRemoteCopy } from '../src/backup/destinations/remove'
import type { Principal } from '../src/http/context'

const DAY = 86_400_000
const daily: Cadence = { kind: 'daily', times: ['02:00'] }
async function setup(overrides = {}) {
  const h = await teamApp(overrides)
  const connectionId = h.ctx.connections.create(
    {
      name: 'Shop',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  ).id
  const u = h.user()
  const input = (over: Partial<NewSchedule> = {}): NewSchedule => ({
    owner: u.id,
    connectionId,
    name: 'Nightly',
    dump: {
      scope: { kind: 'database', db: 'shop', views: true },
      engine: 'builtin',
      indexes: true,
      options: true,
      anonymous: false,
    },
    format: 'mmbak',
    keyId: null,
    cadence: daily,
    timeZone: 'UTC',
    destinations: [],
    keepOnServer: false,
    retention: RETENTION_PRESETS.standard,
    nextRunAt: null,
    ...over,
  })
  const principal: Principal = {
    kind: 'user',
    userId: u.id,
    username: u.username,
    role: 'editor',
    csrfToken: '',
    sessionId: '',
    sessionIdHash: '',
  }
  return { ...h, connectionId, u, input, principal }
}

describe('schedules at rest (phase 3d-3c spec §3.1)', () => {
  it('creates, updates, pauses, resumes and finds due schedules', async () => {
    const { t, ctx, input } = await setup()
    try {
      const repo = ctx.backup.schedules
      const s = repo.create(input({ nextRunAt: nextRunOf({ cadence: daily, timeZone: 'UTC' }, ctx.now()) }))
      expect(s).toMatchObject({ state: 'active', nextRunAt: Date.UTC(2026, 0, 1, 2), pauseReason: null })
      expect(repo.update(s.id, { name: 'Nightly shop' }).name).toBe('Nightly shop')
      expect(repo.dueIds(Date.UTC(2026, 0, 1, 1))).toEqual([])
      expect(repo.dueIds(Date.UTC(2026, 0, 1, 2))).toEqual([s.id])
      repo.pause(s.id, 'admin', 'admin:root')
      expect(repo.get(s.id)).toMatchObject({
        state: 'paused',
        pauseReason: 'admin',
        pausedBy: 'admin:root',
        nextRunAt: null,
      })
      expect(repo.dueIds(Date.UTC(2030, 0, 1))).toEqual([])
      repo.resume(s.id, null)
      expect(repo.missingNext().map((x) => x.id)).toEqual([s.id])
      expect(repo.countFor(s.owner)).toBe(1)
    } finally {
      await t.close()
    }
  })

  it('records one run per due time, keeps the last 200, and knows queued and unfinished ones (D4, D8)', async () => {
    const { t, ctx, input } = await setup()
    try {
      const s = ctx.backup.schedules.create(input())
      const runs = ctx.backup.runs
      const first = runs.insert({ scheduleId: s.id, dueAt: 1000, kind: 'scheduled' })!
      expect(runs.insert({ scheduleId: s.id, dueAt: 1000, kind: 'catchup' })).toBeNull()
      expect(runs.queued().map((r) => r.id)).toEqual([first.id])
      runs.start(first.id)
      expect(runs.unfinished().map((r) => r.id)).toEqual([first.id])
      runs.finish(first.id, 'succeeded', null, { size: 10 })
      expect(runs.get(first.id)).toMatchObject({ outcome: 'succeeded', details: { size: 10 } })
      for (let i = 0; i < 205; i++)
        runs.insert({ scheduleId: s.id, dueAt: 2000 + i, kind: 'scheduled', outcome: 'missed' })
      expect(runs.list(s.id)).toHaveLength(200)
      expect(runs.list(s.id)[0]!.dueAt).toBe(2204)
      expect(runs.last(s.id, 14).map((r) => r.dueAt)[0]).toBe(2204)
    } finally {
      await t.close()
    }
  })

  it('goes with its connection and its owner, and leaves its backups detached (spec §3.1)', async () => {
    const { t, ctx, input, connectionId } = await setup()
    try {
      const s = ctx.backup.schedules.create(input())
      ctx.backup.runs.insert({ scheduleId: s.id, dueAt: 1, kind: 'manual' })
      ctx.store.db
        .prepare(
          "INSERT INTO backups (id, owner, kind, name, size, complete, meta, created_at, expires_at, schedule_id) VALUES (?, ?, 'backup', 'b', 1, 1, '{}', 1, 2, ?)",
        )
        .run(randomUUID(), s.owner, s.id)
      ctx.connections.delete(connectionId)
      expect(ctx.backup.schedules.get(s.id)).toBeUndefined()
      expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM backup_schedule_runs').get()).toEqual({ n: 0 })
      expect(ctx.store.db.prepare('SELECT schedule_id FROM backups').get()).toEqual({ schedule_id: null })
    } finally {
      await t.close()
    }
  })

  it('shows a schedule with its key, its pause and its last runs in order', async () => {
    const { t, ctx, input, u, principal } = await setup()
    try {
      const key = await confirmedKey(u)
      const s = ctx.backup.schedules.create(input({ keyId: key.id, nextRunAt: 5 }))
      for (const [dueAt, outcome] of [
        [1, 'succeeded'],
        [2, 'failed'],
      ] as const)
        ctx.backup.runs.finish(
          ctx.backup.runs.insert({ scheduleId: s.id, dueAt, kind: 'scheduled' })!.id,
          outcome,
          outcome === 'failed' ? 'connection' : null,
          {},
        )
      ctx.backup.runs.insert({ scheduleId: s.id, dueAt: 3, kind: 'manual' })
      const view = toScheduleView(ctx, principal, ctx.backup.schedules.get(s.id)!)
      expect(view).toMatchObject({
        mine: true,
        owner: { id: u.id, username: u.username },
        connectionName: 'Shop',
        key: { id: key.id, fingerprint: key.fingerprint, state: 'active' },
        nextRunAt: 5,
        pause: null,
      })
      expect(view.lastRuns.map((r) => r.outcome)).toEqual(['succeeded', 'failed', 'queued'])
      // Final review I4: the card says why the last run failed.
      expect(view.lastRuns.map((r) => r.reason)).toEqual([null, 'connection', null])
      ctx.backup.schedules.pause(s.id, 'admin', 'admin:root')
      expect(toScheduleView(ctx, principal, ctx.backup.schedules.get(s.id)!)).toMatchObject({
        state: 'paused',
        nextRunAt: null,
        pause: { reason: 'admin', by: 'admin', byName: 'root' },
      })
      const run = ctx.backup.runs.insert({
        scheduleId: s.id,
        dueAt: 9,
        kind: 'scheduled',
        outcome: 'missed',
        reason: 'server_down',
        details: { missed: 3, missedMore: false },
      })!
      expect(toRunView(ctx, principal, s.connectionId, run)).toMatchObject({
        outcome: 'missed',
        reason: 'server_down',
        missed: 3,
        copies: [],
      })
    } finally {
      await t.close()
    }
  })

  it('previews what a policy removes per location, from the schedule’s own complete copies only', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mm-sched-repo-'))
    const { t, ctx, input, u } = await setup({ backup: { folderRoots: [base] } })
    try {
      const dest = ctx.backup.destinations.create({
        name: 'Disk',
        type: 'folder',
        config: { path: join(base, 'disk') },
        secrets: {},
        policy: { encryptedOnly: true },
        createdBy: null,
      })
      const s = ctx.backup.schedules.create(
        input({ destinations: [dest.id], retention: { last: 2, daily: 0, weekly: 0, monthly: 0 } }),
      )
      const copy = (scheduleId: string | null, ago: number, state = 'complete') => {
        const id = randomUUID()
        const at = ctx.now() - ago * DAY
        ctx.store.db
          .prepare(
            `INSERT INTO backup_remote_copies (id, destination_id, backup_id, remote_key, owner, connection_id, meta, format,
              size, sha256, state, created_at, completed_at, schedule_id) VALUES (?, ?, NULL, ?, ?, NULL, ?, 'mmbak', 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            dest.id,
            `mongo-manager/2026/01/mm-20260101-020000-${id.slice(0, 8)}.mmbak`,
            u.id,
            JSON.stringify({ startedAt: at, send: { origin: id } }),
            'a'.repeat(64),
            state,
            at,
            at,
            scheduleId,
          )
        return id
      }
      for (let i = 0; i < 5; i++) copy(s.id, i)
      copy(null, 9)
      copy(s.id, 10, 'failed')
      expect(previewRemovals(ctx, s)).toEqual([{ location: dest.id, name: 'Disk', count: 3 }])
      expect(previewRemovals(ctx, { ...s, retention: RETENTION_PRESETS.long })).toEqual([
        { location: dest.id, name: 'Disk', count: 0 },
      ])
    } finally {
      await t.close()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('removes a remote copy — manifest, object, row — and again without failing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mm-sched-remove-'))
    const { t, ctx, u } = await setup({ backup: { folderRoots: [base] } })
    try {
      mkdirSync(join(base, 'disk', 'mongo-manager', '2026', '01'), { recursive: true })
      const dest = ctx.backup.destinations.create({
        name: 'Disk',
        type: 'folder',
        config: { path: join(base, 'disk') },
        secrets: {},
        policy: { encryptedOnly: true },
        createdBy: null,
      })
      const key = 'mongo-manager/2026/01/mm-20260101-020000-aaaaaaaa.mmbak'
      const file = join(base, 'disk', ...key.split('/'))
      writeFileSync(file, 'x')
      writeFileSync(`${file}.json`, '{}')
      const copy = ctx.backup.copies.create({
        destinationId: dest.id,
        backupId: null,
        remoteKey: key,
        owner: u.id,
        connectionId: null,
        meta: null,
        format: 'mmbak',
        size: 1,
        sha256: 'a'.repeat(64),
        md5: null,
      })
      await removeRemoteCopy(ctx, copy, AbortSignal.timeout(10_000))
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.json`)).toBe(false)
      expect(ctx.backup.copies.get(copy.id)).toBeUndefined()
      await removeRemoteCopy(ctx, copy, AbortSignal.timeout(10_000))
    } finally {
      await t.close()
      rmSync(base, { recursive: true, force: true })
    }
  })
})
