// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema, RETENTION_PRESETS, type Cadence } from '@mongo-manager/shared'
import { teamApp, confirmedKey } from './support/schedules'
import { Scheduler } from '../src/backup/schedules/scheduler'

const daily: Cadence = { kind: 'daily', times: ['02:00'] }
const at = (d: number, h: number, m = 0, s = 0) => Date.UTC(2026, 0, d, h, m, s)

async function setup(overrides: object = {}) {
  const h = await teamApp(overrides as never)
  const connectionId = h.ctx.connections.create(
    {
      name: 'Shop',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port: 1 }],
        serverSelectionTimeoutMS: 500,
      }),
    },
    null,
  ).id
  const u = h.user()
  const ran: string[] = []
  const gates = new Map<string, () => void>()
  const scheduler = new Scheduler({
    ctx: () => h.ctx,
    execute: (runId) =>
      new Promise<void>((resolve) => {
        ran.push(runId)
        h.ctx.backup.runs.start(runId)
        gates.set(runId, () => {
          h.ctx.backup.runs.finish(runId, 'succeeded', null, {})
          resolve()
        })
      }),
  })
  // The routes use the context's scheduler: this one, with its scripted runs.
  h.ctx.backup.scheduler = scheduler
  const schedule = (cadence: Cadence, nextRunAt: number | null, owner = u.id) =>
    h.ctx.backup.schedules.create({
      owner,
      connectionId,
      name: 'S',
      dump: {
        scope: { kind: 'database', db: 'shop', views: true },
        engine: 'builtin',
        indexes: true,
        options: true,
        anonymous: false,
      },
      format: 'gzip',
      keyId: null,
      cadence,
      timeZone: 'UTC',
      destinations: [],
      keepOnServer: false,
      retention: RETENTION_PRESETS.standard,
      nextRunAt,
    })
  const release = async (runId: string) => {
    gates.get(runId)!()
    gates.delete(runId)
    await new Promise((r) => setImmediate(r))
  }
  const runOf = (id: string) => h.ctx.backup.runs.get(id)!
  const tickAt = async (t: number) => {
    h.t.clock.now = t
    await scheduler.tick()
  }
  return { ...h, u, connectionId, scheduler, ran, schedule, release, runOf, tickAt }
}

describe('the scheduler (phase 3d-3c spec §3.2)', () => {
  it('runs what is due, once, and moves the next run', async () => {
    const { t, ctx, ran, schedule, release, runOf, tickAt } = await setup()
    try {
      const s = schedule(daily, at(1, 2))
      await tickAt(at(1, 1, 59))
      expect(ran).toEqual([])
      await tickAt(at(1, 2, 0, 10))
      expect(ran).toHaveLength(1)
      expect(runOf(ran[0]!)).toMatchObject({ kind: 'scheduled', dueAt: at(1, 2) })
      expect(ctx.backup.schedules.get(s.id)!.nextRunAt).toBe(at(2, 2))
      await tickAt(at(1, 2, 0, 40))
      expect(ran).toHaveLength(1)
      await release(ran[0]!)
    } finally {
      await t.close()
    }
  })

  it('catches up once after a stop and records what it missed (spec §1.3)', async () => {
    const { t, ctx, ran, schedule, release, runOf, tickAt } = await setup()
    try {
      const s = schedule(daily, at(1, 2))
      await tickAt(at(3, 20))
      expect(ran).toHaveLength(1)
      expect(runOf(ran[0]!)).toMatchObject({ kind: 'catchup', dueAt: at(3, 2) })
      expect(ctx.backup.runs.list(s.id).find((r) => r.outcome === 'missed')).toMatchObject({
        dueAt: at(1, 2),
        reason: 'server_down',
        details: { missed: 2 },
      })
      expect(ctx.backup.schedules.get(s.id)!.nextRunAt).toBe(at(4, 2))
      await release(ran[0]!)
    } finally {
      await t.close()
    }
  })

  it('never runs a due time twice when the clock goes back, and catches up once when it jumps ahead (D8)', async () => {
    const { t, ctx, ran, schedule, release, runOf, tickAt } = await setup()
    try {
      const s = schedule(daily, at(1, 2))
      await tickAt(at(1, 2, 0, 10))
      await release(ran[0]!)
      await tickAt(at(1, 1))
      expect(ran).toHaveLength(1)
      // A next run that went back with the clock: that due time is recorded already.
      ctx.backup.schedules.setNext(s.id, at(1, 2))
      await tickAt(at(1, 2, 0, 30))
      expect(ran).toHaveLength(1)
      await tickAt(at(20, 3))
      expect(ran).toHaveLength(2)
      expect(runOf(ran[1]!)).toMatchObject({ kind: 'catchup', dueAt: at(20, 2) })
      expect(ctx.backup.runs.list(s.id).filter((r) => r.outcome === 'missed')).toHaveLength(1)
      await release(ran[1]!)
    } finally {
      await t.close()
    }
  })

  it('skips a due run while the previous one still runs, and says so (spec §1.3 overlap)', async () => {
    const { t, ctx, ran, schedule, release, tickAt } = await setup()
    try {
      const s = schedule({ kind: 'hourly', every: 1, minute: 0 }, at(1, 10))
      await tickAt(at(1, 10, 0, 5))
      await tickAt(at(1, 11, 0, 5))
      expect(ran).toHaveLength(1)
      expect(ctx.backup.runs.list(s.id)[0]).toMatchObject({
        dueAt: at(1, 11),
        outcome: 'skipped',
        reason: 'overlap',
      })
      await release(ran[0]!)
    } finally {
      await t.close()
    }
  })

  it('runs at most the configured number at once; the rest wait in due order, up to six hours (D4)', async () => {
    const { t, ctx, ran, schedule, release, runOf, tickAt } = await setup({
      backup: { scheduleConcurrency: 1 },
    })
    try {
      const first = schedule(daily, at(1, 2))
      const second = schedule({ kind: 'daily', times: ['02:05'] }, at(1, 2, 5))
      await tickAt(at(1, 2, 6))
      expect(ran.map((id) => runOf(id).scheduleId)).toEqual([first.id])
      expect(ctx.backup.runs.list(second.id)[0]).toMatchObject({ outcome: null, startedAt: null })
      await release(ran[0]!)
      expect(ran.map((id) => runOf(id).scheduleId)).toEqual([first.id, second.id])
      await release(ran[1]!)
      // Out of the way for the second half: only the blocker and the late one are due next.
      ctx.backup.schedules.setNext(first.id, at(30, 2))
      ctx.backup.schedules.setNext(second.id, at(30, 2))
      const blocker = schedule({ kind: 'daily', times: ['02:59'] }, at(2, 2, 59))
      const late = schedule({ kind: 'daily', times: ['03:00'] }, at(2, 3))
      await tickAt(at(2, 3, 0, 10))
      expect(runOf(ran.at(-1)!).scheduleId).toBe(blocker.id)
      t.clock.now = at(2, 9, 1)
      await release(ran.at(-1)!)
      expect(ctx.backup.runs.list(late.id)[0]).toMatchObject({ outcome: 'skipped', reason: 'queue_timeout' })
    } finally {
      await t.close()
    }
  })

  it('gives an active schedule without a next run its next run, and recovers what a stop left', async () => {
    const { t, ctx, ran, schedule, release, scheduler, tickAt } = await setup()
    try {
      const s = schedule(daily, null)
      const cut = ctx.backup.runs.insert({ scheduleId: s.id, dueAt: at(1, 0), kind: 'manual' })!
      ctx.backup.runs.start(cut.id)
      const waiting = ctx.backup.runs.insert({ scheduleId: s.id, dueAt: t.clock.now - 1000, kind: 'manual' })!
      scheduler.recover()
      expect(ctx.backup.runs.get(cut.id)).toMatchObject({ outcome: 'failed', reason: 'interrupted' })
      await tickAt(t.clock.now)
      expect(ctx.backup.schedules.get(s.id)!.nextRunAt).toBe(at(1, 2))
      expect(ran).toEqual([waiting.id])
      await release(waiting.id)
    } finally {
      await t.close()
    }
  })

  it('runs now on request, without moving the next run, one at a time (spec §1.3 Run now)', async () => {
    const { t, ctx, u, user, ran, schedule, release } = await setup()
    try {
      const s = schedule(daily, at(1, 2))
      const res = await u.call('POST', `/api/backup-schedules/${s.id}/run`)
      expect(res.statusCode, res.body).toBe(202)
      expect(res.json().run).toMatchObject({ kind: 'manual', outcome: 'running' })
      expect(ctx.backup.schedules.get(s.id)!.nextRunAt).toBe(at(1, 2))
      const again = await u.call('POST', `/api/backup-schedules/${s.id}/run`)
      expect(again.statusCode).toBe(409)
      expect(again.json().details.reason).toBe('run_running')
      expect((await user().call('POST', `/api/backup-schedules/${s.id}/run`)).statusCode).toBe(404)
      await release(ran[0]!)
      expect((await user('admin').call('POST', `/api/backup-schedules/${s.id}/run`)).statusCode).toBe(202)
      await release(ran[1]!)
    } finally {
      await t.close()
    }
  })

  it('does nothing when MM_BACKUP_SCHEDULES=0, and says so', async () => {
    const { t, ran, schedule, scheduler, u, tickAt } = await setup({ backup: { schedules: false } })
    try {
      const s = schedule(daily, at(1, 2))
      // Asked first: the two hours the tick below moves the clock would end the idle session.
      expect((await u.get('/api/backup-schedules')).json()).toMatchObject({ enabled: false })
      await tickAt(at(1, 2, 0, 10))
      expect(ran).toEqual([])
      expect(() => scheduler.runNow(s.id)).toThrow(/turned off/)
    } finally {
      await t.close()
    }
  })

  it('pauses a disabled user’s schedules, and removes a deleted user’s schedules and keys (D5)', async () => {
    const { t, ctx, user, schedule } = await setup()
    try {
      const admin = user('admin')
      const owner = user()
      await confirmedKey(owner)
      const s = schedule(daily, at(1, 2), owner.id)
      expect((await admin.call('PATCH', `/api/users/${owner.id}`, { disabled: true })).statusCode).toBe(200)
      expect(ctx.backup.schedules.get(s.id)).toMatchObject({ state: 'paused', pauseReason: 'owner_disabled' })
      expect((await admin.call('DELETE', `/api/users/${owner.id}`)).statusCode).toBe(204)
      expect(ctx.backup.schedules.get(s.id)).toBeUndefined()
      expect(ctx.backup.keys.list(owner.id)).toEqual([])
    } finally {
      await t.close()
    }
  })

  // Final review minor 7: with scheduling off, runs a stopped process left showed "running" for ever.
  it('settles the runs a stopped process left even when scheduling is off', async () => {
    const { t, ctx, ran, schedule, scheduler } = await setup({ backup: { schedules: false } })
    try {
      const s = schedule(daily, null)
      const cut = ctx.backup.runs.insert({ scheduleId: s.id, dueAt: at(1, 0), kind: 'scheduled' })!
      ctx.backup.runs.start(cut.id)
      const waiting = ctx.backup.runs.insert({ scheduleId: s.id, dueAt: at(1, 0, 30), kind: 'manual' })!
      scheduler.start()
      expect(ctx.backup.runs.get(cut.id)).toMatchObject({ outcome: 'failed', reason: 'interrupted' })
      expect(ctx.backup.runs.get(waiting.id)).toMatchObject({ outcome: 'skipped', reason: 'schedules_off' })
      expect(ran).toEqual([])
      scheduler.stop()
    } finally {
      await t.close()
    }
  })

  // Final review minor 6: "the previous run was still running" was said of one only waiting its turn.
  it('says a due run was skipped because the previous one was still waiting, not running', async () => {
    const { t, ctx, ran, schedule, release, tickAt } = await setup({ backup: { scheduleConcurrency: 1 } })
    try {
      // The blocker takes the only slot at 09:30; the hourly one then waits behind it.
      schedule({ kind: 'daily', times: ['09:30'] }, at(1, 9, 30))
      const waiting = schedule({ kind: 'hourly', every: 1, minute: 0 }, at(1, 10))
      await tickAt(at(1, 10, 0, 5))
      expect(ran).toHaveLength(1)
      await tickAt(at(1, 11, 0, 5))
      expect(ctx.backup.runs.list(waiting.id)[0]).toMatchObject({
        dueAt: at(1, 11),
        outcome: 'skipped',
        reason: 'overlap_queued',
      })
      await release(ran[0]!)
      await release(ran[1]!)
    } finally {
      await t.close()
    }
  })

  // Final review I2: one unreadable schedule (a zone this ICU lacks, a damaged row) stopped every
  // schedule, and its unhandled rejection ended the server at each start.
  it('pauses a schedule it cannot read, keeps running the others, and never rejects a tick', async () => {
    const { t, ctx, user, ran, schedule, release, tickAt } = await setup()
    try {
      const good = schedule(daily, at(1, 2))
      const zone = schedule(daily, at(1, 2))
      const row = schedule(daily, null)
      ctx.store.db.prepare("UPDATE backup_schedules SET time_zone = 'Mars/Olympus' WHERE id = ?").run(zone.id)
      ctx.store.db.prepare("UPDATE backup_schedules SET cadence = '{not json' WHERE id = ?").run(row.id)
      await expect(tickAt(at(1, 2, 0, 10))).resolves.toBeUndefined()
      expect(ran.map((id) => ctx.backup.runs.get(id)!.scheduleId)).toEqual([good.id])
      const paused = (id: string) =>
        ctx.store.db.prepare('SELECT state, pause_reason FROM backup_schedules WHERE id = ?').get(id)
      expect(paused(zone.id)).toEqual({ state: 'paused', pause_reason: 'invalid_cadence' })
      expect(paused(row.id)).toEqual({ state: 'paused', pause_reason: 'invalid_cadence' })
      // Resuming one that still cannot be read says why instead of failing (signed in after the
      // clock moved: the earlier sessions are idle by now).
      const admin = user('admin')
      const again = await admin.call('POST', `/api/backup-schedules/${zone.id}/resume`)
      expect(again.statusCode).toBe(409)
      expect(again.json().details.reason).toBe('invalid_cadence')
      // The damaged row is left out of the list rather than failing it.
      const list = await admin.get('/api/backup-schedules')
      expect(list.statusCode).toBe(200)
      expect(list.json().schedules.map((s: { id: string }) => s.id)).not.toContain(row.id)
      await release(ran[0]!)
    } finally {
      await t.close()
    }
  })
})
