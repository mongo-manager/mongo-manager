import type { AgentVia } from '../../ai/agent/calls'
import { compileCadence, decideDue } from '@mongo-manager/shared'
import { Errors } from '../../errors'
import type { ServerContext } from '../../http/context'
import { nextRunOf, type RunRecord, type ScheduleRecord } from './repo'
import { executeRun } from './run'

/** Spec §3.2: the loop's period. */
export const TICK_MS = 30_000
/** Spec §3.2: a due run waits for a free slot this long, then is recorded as skipped. */
export const QUEUE_WAIT_MS = 6 * 3_600_000

interface Queued {
  runId: string
  scheduleId: string
  dueAt: number
  /** When it began to wait: the six hours count from here, so a late catch-up is not dropped at once. */
  since: number
}

/**
 * Phase 3d-3c spec §3.2: one loop per server process (the instance lock makes it one per data
 * directory). Due schedules come from `next_run_at`, never from memory alone; a due time is recorded
 * once (D8); at most `scheduleConcurrency` runs at once, the rest queued in due order up to six hours.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout
  private readonly queue: Queued[] = []
  private readonly active = new Map<string, Promise<void>>()
  /** Final review of wave B (M1): the agent's turn a run was started for, until the run takes it. */
  private readonly agents = new Map<string, AgentVia>()
  private ticking: Promise<void> | null = null
  private stopped = false

  constructor(
    private readonly deps: {
      ctx: () => ServerContext
      /** Tests script runs; the server executes them for real. */
      execute?: (runId: string) => Promise<void>
      /** Final review I2: what went wrong in the loop, for the server log (the loop itself goes on). */
      log?: (error: unknown) => void
    },
  ) {}

  /** Final review I2: the loop never throws; a failure is logged and the next tick tries again. */
  private guard(work: () => void): void {
    try {
      work()
    } catch (e) {
      this.deps.log?.(e)
    }
  }

  private get ctx(): ServerContext {
    return this.deps.ctx()
  }

  /** MM_BACKUP_SCHEDULES=0: nothing starts; the web says scheduling is off. */
  get enabled(): boolean {
    return this.ctx.backup.limits.schedules
  }

  start(): void {
    if (!this.enabled) {
      // Final review minor 7: nothing runs, but what a stopped process left is settled, not "running".
      this.guard(() => this.settle())
      return
    }
    this.guard(() => this.recover())
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
  }

  /** Scheduling off: runs a previous process started were cut off; queued ones never run. */
  private settle(): void {
    const { runs } = this.ctx.backup
    for (const r of runs.unfinished())
      runs.finish(r.id, 'failed', 'interrupted', { message: 'The server stopped during this run' })
    for (const r of runs.queued()) runs.finish(r.id, 'skipped', 'schedules_off', {})
  }

  /** What a previous process left: runs it had started were cut off; queued ones wait again. */
  recover(): void {
    const { runs } = this.ctx.backup
    for (const r of runs.unfinished())
      runs.finish(r.id, 'failed', 'interrupted', { message: 'The server stopped during this run' })
    for (const r of runs.queued())
      if (!this.queue.some((q) => q.runId === r.id))
        // Left by a stopped process: these waited since their due time (an old one is skipped).
        this.queue.push({ runId: r.id, scheduleId: r.scheduleId, dueAt: r.dueAt, since: r.dueAt })
    this.queue.sort((a, b) => a.dueAt - b.dueAt)
  }

  /** One pass (ticks never overlap). */
  tick(): Promise<void> {
    this.ticking ??= Promise.resolve()
      .then(() => this.pass())
      .catch((e: unknown) => this.deps.log?.(e))
      .finally(() => {
        this.ticking = null
      })
    return this.ticking
  }

  private pass(): void {
    const ctx = this.ctx
    if (!this.enabled || this.stopped) return
    const now = ctx.now()
    this.guard(() => ctx.backup.keys.sweepPending())
    const { schedules } = ctx.backup
    // An active schedule without a next run (saved, resumed, its key reactivated) gets one.
    for (const id of schedules.missingNextIds())
      this.each(id, (s) => schedules.setNext(s.id, nextRunOf(s, now)))
    for (const id of schedules.dueIds(now)) this.each(id, (s) => this.due(s, now))
    this.guard(() => this.pump())
  }

  /**
   * Final review I2: each schedule on its own. One this server cannot read (a time zone its ICU lacks,
   * a damaged row) is paused with that reason; the others run.
   */
  private each(id: string, work: (s: ScheduleRecord) => void): void {
    const { schedules } = this.ctx.backup
    try {
      const s = schedules.get(id)
      if (s) work(s)
    } catch (e) {
      this.deps.log?.(e)
      this.guard(() => schedules.pause(id, 'invalid_cadence', 'system'))
    }
  }

  /** Spec §1.3: scheduled, one catch-up, or missed; earlier due times become one missed row. */
  private due(s: ScheduleRecord, now: number): void {
    const { runs, schedules } = this.ctx.backup
    const d = decideDue(compileCadence(s.cadence), s.timeZone, s.nextRunAt!, now)
    const missed = d.kind === 'missed' ? d.earlier + 1 : d.earlier
    if (missed > 0)
      runs.insert({
        scheduleId: s.id,
        dueAt: d.kind === 'missed' ? d.dueAt : s.nextRunAt!,
        kind: 'scheduled',
        outcome: 'missed',
        reason: 'server_down',
        details: { missed, missedMore: d.more },
      })
    schedules.setNext(s.id, d.nextRunAt)
    if (d.kind === 'missed') return
    const run = runs.insert({ scheduleId: s.id, dueAt: d.dueAt, kind: d.kind })
    // D8: this due time was recorded already (the clock went back): nothing runs twice.
    if (!run) return
    if (this.busy(s.id)) {
      // Final review minor 6: running, or still waiting its turn — said as it is.
      runs.finish(run.id, 'skipped', this.active.has(s.id) ? 'overlap' : 'overlap_queued', {})
      return
    }
    this.enqueue(run)
  }

  private enqueue(run: RunRecord): void {
    this.queue.push({ runId: run.id, scheduleId: run.scheduleId, dueAt: run.dueAt, since: this.ctx.now() })
    this.queue.sort((a, b) => a.dueAt - b.dueAt)
  }

  /** A run of this schedule is running or waiting. */
  busy(scheduleId: string): boolean {
    return this.active.has(scheduleId) || this.queue.some((q) => q.scheduleId === scheduleId)
  }

  private pump(): void {
    const ctx = this.ctx
    const { runs, schedules, limits } = ctx.backup
    while (!this.stopped && this.active.size < limits.scheduleConcurrency && this.queue.length) {
      const next = this.queue.shift()!
      const run = runs.get(next.runId)
      if (!run || run.outcome) continue
      const s = schedules.get(next.scheduleId)
      if (!s) {
        runs.finish(run.id, 'skipped', 'schedule_gone', {})
        continue
      }
      // Spec §1.5: "skipped (paused while due)"; Run now on a paused schedule still runs.
      if (s.state === 'paused' && run.kind !== 'manual') {
        runs.finish(run.id, 'skipped', 'paused', {})
        continue
      }
      if (ctx.now() - next.since > QUEUE_WAIT_MS) {
        runs.finish(run.id, 'skipped', 'queue_timeout', {})
        continue
      }
      if (this.active.has(s.id)) {
        runs.finish(run.id, 'skipped', 'overlap', {})
        continue
      }
      const execute = this.deps.execute ?? ((id: string) => executeRun(this.ctx, id))
      const work = execute(run.id)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(s.id)
          this.guard(() => this.pump())
        })
      this.active.set(s.id, work)
    }
  }

  /** Spec §1.3 Run now: a run at once that does not move the next due time. */
  runNow(scheduleId: string, agent: AgentVia | null = null): RunRecord {
    const ctx = this.ctx
    if (!this.enabled)
      throw Errors.conflict('Scheduling is turned off on this server', { reason: 'schedules_off' })
    if (this.busy(scheduleId))
      throw Errors.conflict('This schedule is already running', { reason: 'run_running' })
    let dueAt = ctx.now()
    let run = ctx.backup.runs.insert({ scheduleId, dueAt, kind: 'manual' })
    // A due time is unique per schedule; two requests in one millisecond take the next one.
    while (!run) run = ctx.backup.runs.insert({ scheduleId, dueAt: ++dueAt, kind: 'manual' })
    if (agent) this.agents.set(run.id, agent)
    this.enqueue(run)
    this.pump()
    return ctx.backup.runs.get(run.id)!
  }

  /** The agent's turn a run was started for (once: the run takes it). */
  takeAgent(runId: string): AgentVia | null {
    const via = this.agents.get(runId) ?? null
    this.agents.delete(runId)
    return via
  }

  /** For tests and shutdown: resolves when no run is active. */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()])
  }
}
