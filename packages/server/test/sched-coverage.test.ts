// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it, vi } from 'vitest'
import { ConnectionSettingsSchema, RETENTION_PRESETS, type Cadence } from '@mongo-manager/shared'
import { teamApp } from './support/schedules'
import { Scheduler } from '../src/backup/schedules/scheduler'
import { executeRun } from '../src/backup/schedules/run'
import { waitForJob } from '../src/backup/schedules/wait'
import type { JobRunner } from '../src/jobs/runner'

const daily: Cadence = { kind: 'daily', times: ['02:00'] }
const HOUR = 3_600_000

async function setup(overrides: object = {}) {
  const h = await teamApp(overrides as never)
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
  const ran: string[] = []
  const gates = new Map<string, () => void>()
  const logged: unknown[] = []
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
    log: (e) => logged.push(e),
  })
  h.ctx.backup.scheduler = scheduler
  const schedule = (nextRunAt: number | null = null) =>
    h.ctx.backup.schedules.create({
      owner: u.id,
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
      cadence: daily,
      timeZone: 'UTC',
      destinations: [],
      keepOnServer: false,
      retention: RETENTION_PRESETS.standard,
      nextRunAt,
    })
  const release = (runId: string) => gates.get(runId)!()
  return { ...h, scheduler, ran, schedule, release, logged }
}

describe('waiting for a job (plan ruling 12)', () => {
  it('rejects for a job that is gone, and answers at once for one already finished', async () => {
    const off = vi.fn()
    const runner = (job: unknown) => ({ onChange: () => off, get: () => job }) as unknown as JobRunner
    await expect(waitForJob(runner(undefined), 'j')).rejects.toThrow('The job is gone')
    await expect(waitForJob(runner({ id: 'j', state: 'done' }), 'j')).resolves.toMatchObject({
      state: 'done',
    })
    expect(off).toHaveBeenCalledTimes(2)
  })
})

describe('the scheduler’s queue, beyond the main paths', () => {
  it('starts by recovering what a stopped process queued, skipping one that waited too long', async () => {
    const { t, ctx, scheduler, schedule } = await setup()
    try {
      const s = schedule()
      const old = ctx.backup.runs.insert({
        scheduleId: s.id,
        dueAt: ctx.now() - 7 * HOUR,
        kind: 'scheduled',
      })!
      scheduler.start()
      await scheduler.tick()
      expect(ctx.backup.runs.get(old.id)).toMatchObject({ outcome: 'skipped', reason: 'queue_timeout' })
      scheduler.stop()
    } finally {
      await t.close()
    }
  })

  it('skips a queued run whose schedule is gone or paused, passes over a finished one, and idles', async () => {
    const { t, ctx, scheduler, schedule, ran, release } = await setup()
    try {
      const paused = schedule()
      ctx.backup.schedules.pause(paused.id, 'owner', 'owner')
      const due = ctx.backup.runs.insert({
        scheduleId: paused.id,
        dueAt: ctx.now() - 1000,
        kind: 'scheduled',
      })!
      const gone = schedule()
      const orphan = ctx.backup.runs.insert({
        scheduleId: gone.id,
        dueAt: ctx.now() - 900,
        kind: 'scheduled',
      })!
      const done = schedule()
      const finished = ctx.backup.runs.insert({
        scheduleId: done.id,
        dueAt: ctx.now() - 800,
        kind: 'scheduled',
      })!
      scheduler.recover()
      ctx.backup.runs.finish(finished.id, 'succeeded', null, {})
      const get = ctx.backup.schedules.get.bind(ctx.backup.schedules)
      const spy = vi
        .spyOn(ctx.backup.schedules, 'get')
        .mockImplementation((id) => (id === gone.id ? undefined : get(id)))
      await scheduler.tick()
      spy.mockRestore()
      expect(ctx.backup.runs.get(due.id)).toMatchObject({ outcome: 'skipped', reason: 'paused' })
      expect(ctx.backup.runs.get(orphan.id)).toMatchObject({ outcome: 'skipped', reason: 'schedule_gone' })
      expect(ctx.backup.runs.get(finished.id)).toMatchObject({ outcome: 'succeeded' })
      // Run now on a paused schedule still runs (spec §1.5); idle resolves once it ends.
      const now = scheduler.runNow(paused.id)
      expect(ran).toEqual([now.id])
      const idle = scheduler.idle()
      release(now.id)
      await idle
      expect(ctx.backup.runs.get(now.id)!.outcome).toBe('succeeded')
    } finally {
      await t.close()
    }
  })

  it('logs what failed in a pass and goes on', async () => {
    const { t, ctx, scheduler, logged } = await setup()
    try {
      const sweep = vi.spyOn(ctx.backup.keys, 'sweepPending').mockImplementation(() => {
        throw new Error('sweep failed')
      })
      await expect(scheduler.tick()).resolves.toBeUndefined()
      sweep.mockRestore()
      expect(logged).toEqual([expect.objectContaining({ message: 'sweep failed' })])
    } finally {
      await t.close()
    }
  })
})

describe('a scheduled run’s early exits', () => {
  it('leaves a finished run alone, and skips one whose schedule is gone', async () => {
    const { t, ctx, schedule } = await setup()
    try {
      const s = schedule()
      const done = ctx.backup.runs.insert({ scheduleId: s.id, dueAt: 1, kind: 'manual' })!
      ctx.backup.runs.finish(done.id, 'succeeded', null, {})
      await executeRun(ctx, done.id)
      expect(ctx.backup.runs.get(done.id)!.outcome).toBe('succeeded')
      const orphan = ctx.backup.runs.insert({ scheduleId: s.id, dueAt: 2, kind: 'manual' })!
      const spy = vi.spyOn(ctx.backup.schedules, 'get').mockReturnValue(undefined)
      await executeRun(ctx, orphan.id)
      spy.mockRestore()
      expect(ctx.backup.runs.get(orphan.id)).toMatchObject({ outcome: 'skipped', reason: 'schedule_gone' })
    } finally {
      await t.close()
    }
  })
})
