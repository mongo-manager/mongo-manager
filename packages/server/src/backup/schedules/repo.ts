import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  MAX_SCHEDULE_RUNS_KEPT,
  compileCadence,
  nextRunAfter,
  DrillSettingSchema,
  type BackupFormat,
  type DrillOutcome,
  type DrillSetting,
  type Cadence,
  type PauseReason,
  type RetentionPolicy,
  type RunKind,
  type RunOutcome,
  type ScheduleDump,
  type ScheduleRunView,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'

/** Phase 3d-3c spec §1.2, §3.1. */
export interface ScheduleRecord {
  id: string
  owner: string
  connectionId: string
  name: string
  dump: ScheduleDump
  format: BackupFormat
  keyId: string | null
  cadence: Cadence
  timeZone: string
  destinations: string[]
  keepOnServer: boolean
  retention: RetentionPolicy
  /** W4.4: a restore drill every N runs (kept in the `request` JSON with the dump options). */
  drill: DrillSetting | null
  state: 'active' | 'paused'
  pauseReason: PauseReason | null
  /** 'owner', 'admin:<username>' or 'system'. */
  pausedBy: string | null
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}
export type NewSchedule = Omit<
  ScheduleRecord,
  'id' | 'state' | 'pauseReason' | 'pausedBy' | 'createdAt' | 'updatedAt' | 'drill'
> & { drill?: DrillSetting | null }
type Editable = Partial<
  Pick<
    ScheduleRecord,
    | 'name'
    | 'dump'
    | 'format'
    | 'keyId'
    | 'cadence'
    | 'timeZone'
    | 'destinations'
    | 'keepOnServer'
    | 'retention'
    | 'drill'
    | 'nextRunAt'
  >
>

interface Row {
  id: string
  owner: string
  connection_id: string
  name: string
  request: string
  format: BackupFormat
  key_id: string | null
  cadence: string
  time_zone: string
  destinations: string
  keep_on_server: number
  retention: string
  state: 'active' | 'paused'
  pause_reason: PauseReason | null
  paused_by: string | null
  next_run_at: number | null
  created_at: number
  updated_at: number
}

/**
 * W4.4: the `request` column holds the dump options and, beside them, the drill setting (no new
 * column: a schedule stored before drills existed reads as "no drill").
 */
const packRequest = (dump: ScheduleDump, drill: DrillSetting | null): string =>
  JSON.stringify(drill ? { ...dump, drill } : dump)
function unpackRequest(text: string): { dump: ScheduleDump; drill: DrillSetting | null } {
  const { drill, ...dump } = JSON.parse(text) as ScheduleDump & { drill?: unknown }
  const parsed = DrillSettingSchema.safeParse(drill)
  return { dump: dump as ScheduleDump, drill: parsed.success ? parsed.data : null }
}

const toRecord = (r: Row): ScheduleRecord => ({
  id: r.id,
  owner: r.owner,
  connectionId: r.connection_id,
  name: r.name,
  ...unpackRequest(r.request),
  format: r.format,
  keyId: r.key_id,
  cadence: JSON.parse(r.cadence) as Cadence,
  timeZone: r.time_zone,
  destinations: JSON.parse(r.destinations) as string[],
  keepOnServer: r.keep_on_server === 1,
  retention: JSON.parse(r.retention) as RetentionPolicy,
  state: r.state,
  pauseReason: r.pause_reason,
  pausedBy: r.paused_by,
  nextRunAt: r.next_run_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** The run after `after`, an hour at least from `lastRun` (spec §1.3). */
export const nextRunOf = (
  s: Pick<ScheduleRecord, 'cadence' | 'timeZone'>,
  after: number,
  lastRun?: number,
): number | null => nextRunAfter(compileCadence(s.cadence), s.timeZone, after, lastRun)

/** Phase 3d-3c spec §3.1: schedules; due ones are read from `next_run_at`, never from memory alone. */
export class ScheduleRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  /** Final review I2: a row this build cannot read (damaged JSON) is left out, never failing the list. */
  private many(sql: string, ...args: Array<string | number | null>): ScheduleRecord[] {
    const out: ScheduleRecord[] = []
    for (const r of this.db.prepare(sql).all(...args) as unknown as Row[])
      try {
        out.push(toRecord(r))
      } catch {
        // The scheduler pauses it by its id (see dueIds).
      }
    return out
  }

  /** Final review I2: the ids alone, so the scheduler reads (and can pause) each schedule on its own. */
  dueIds(now: number, limit = 100): string[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM backup_schedules WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?",
        )
        .all(now, limit) as Array<{ id: string }>
    ).map((r) => r.id)
  }

  missingNextIds(): string[] {
    return (
      this.db
        .prepare("SELECT id FROM backup_schedules WHERE state = 'active' AND next_run_at IS NULL")
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
  }

  /** One owner's schedules, or everyone's (administrators). */
  list(owner?: string): ScheduleRecord[] {
    return owner === undefined
      ? this.many('SELECT * FROM backup_schedules ORDER BY name COLLATE NOCASE, created_at')
      : this.many(
          'SELECT * FROM backup_schedules WHERE owner = ? ORDER BY name COLLATE NOCASE, created_at',
          owner,
        )
  }

  get(id: string): ScheduleRecord | undefined {
    const r = this.db.prepare('SELECT * FROM backup_schedules WHERE id = ?').get(id) as Row | undefined
    return r && toRecord(r)
  }

  countFor(owner: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM backup_schedules WHERE owner = ?').get(owner) as {
        n: number
      }
    ).n
  }

  create(input: NewSchedule): ScheduleRecord {
    const id = randomUUID()
    const t = this.now()
    this.db
      .prepare(
        `INSERT INTO backup_schedules (id, owner, connection_id, name, request, format, key_id, cadence, time_zone,
          destinations, keep_on_server, retention, state, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        input.owner,
        input.connectionId,
        input.name,
        packRequest(input.dump, input.drill ?? null),
        input.format,
        input.keyId,
        JSON.stringify(input.cadence),
        input.timeZone,
        JSON.stringify(input.destinations),
        input.keepOnServer ? 1 : 0,
        JSON.stringify(input.retention),
        input.nextRunAt,
        t,
        t,
      )
    return this.get(id)!
  }

  update(id: string, patch: Editable): ScheduleRecord {
    const before = this.get(id)
    if (!before) throw Errors.notFound('Schedule not found')
    const s = { ...before, ...patch }
    this.db
      .prepare(
        `UPDATE backup_schedules SET name = ?, request = ?, format = ?, key_id = ?, cadence = ?, time_zone = ?,
          destinations = ?, keep_on_server = ?, retention = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        s.name,
        packRequest(s.dump, s.drill),
        s.format,
        s.keyId,
        JSON.stringify(s.cadence),
        s.timeZone,
        JSON.stringify(s.destinations),
        s.keepOnServer ? 1 : 0,
        JSON.stringify(s.retention),
        s.nextRunAt,
        this.now(),
        id,
      )
    return this.get(id)!
  }

  setNext(id: string, t: number | null): void {
    this.db.prepare('UPDATE backup_schedules SET next_run_at = ? WHERE id = ?').run(t, id)
  }

  pause(id: string, reason: PauseReason, by: string): void {
    this.db
      .prepare(
        "UPDATE backup_schedules SET state = 'paused', pause_reason = ?, paused_by = ?, next_run_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(reason, by, this.now(), id)
  }

  /** Active again; a null next run is computed by the scheduler's next tick. */
  resume(id: string, nextRunAt: number | null): void {
    this.db
      .prepare(
        "UPDATE backup_schedules SET state = 'active', pause_reason = NULL, paused_by = NULL, next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(nextRunAt, this.now(), id)
  }

  missingNext(): ScheduleRecord[] {
    return this.many("SELECT * FROM backup_schedules WHERE state = 'active' AND next_run_at IS NULL")
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM backup_schedules WHERE id = ?').run(id).changes > 0
  }

  deleteAllFor(owner: string): void {
    this.db.prepare('DELETE FROM backup_schedules WHERE owner = ?').run(owner)
  }

  /** A disabled owner's schedules pause at once (D5); their runs check again anyway. */
  pauseAllFor(owner: string, reason: PauseReason): string[] {
    const ids = this.many("SELECT * FROM backup_schedules WHERE owner = ? AND state = 'active'", owner).map(
      (s) => s.id,
    )
    for (const id of ids) this.pause(id, reason, 'system')
    return ids
  }
}

/** Plan ruling 18: what a run did, kept as JSON in the run's `removed` column. */
export interface RunDetails {
  message?: string
  size?: number
  copies?: ScheduleRunView['copies']
  removals?: ScheduleRunView['removals']
  missed?: number
  missedMore?: boolean
  keyFingerprint?: string
  /** W4.4: the run's restore drill, when one was due. */
  drill?: DrillOutcome
}

export interface RunRecord {
  id: string
  scheduleId: string
  dueAt: number
  kind: RunKind
  startedAt: number | null
  finishedAt: number | null
  outcome: RunOutcome | null
  reason: string | null
  backupId: string | null
  dumpJobId: string | null
  sendJobId: string | null
  details: RunDetails
}

interface RunRow {
  id: string
  schedule_id: string
  due_at: number
  kind: RunKind
  started_at: number | null
  finished_at: number | null
  outcome: RunOutcome | null
  reason: string | null
  backup_id: string | null
  dump_job_id: string | null
  send_job_id: string | null
  removed: string | null
}

const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  scheduleId: r.schedule_id,
  dueAt: r.due_at,
  kind: r.kind,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  outcome: r.outcome,
  reason: r.reason,
  backupId: r.backup_id,
  dumpJobId: r.dump_job_id,
  sendJobId: r.send_job_id,
  details: r.removed ? (JSON.parse(r.removed) as RunDetails) : {},
})

/** Spec §1.5, §3.1: runs, one per due time (D8), the last 200 per schedule (D4). */
export class RunRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  private many(sql: string, ...args: Array<string | number>): RunRecord[] {
    return (this.db.prepare(sql).all(...args) as unknown as RunRow[]).map(toRun)
  }

  /** A queued run, or a finished one (missed, skipped); null when this due time is already recorded. */
  insert(input: {
    scheduleId: string
    dueAt: number
    kind: RunKind
    outcome?: RunOutcome
    reason?: string | null
    details?: RunDetails
  }): RunRecord | null {
    const id = randomUUID()
    const done = input.outcome !== undefined
    const changes = this.db
      .prepare(
        `INSERT INTO backup_schedule_runs (id, schedule_id, due_at, kind, finished_at, outcome, reason, removed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (schedule_id, due_at) DO NOTHING`,
      )
      .run(
        id,
        input.scheduleId,
        input.dueAt,
        input.kind,
        done ? this.now() : null,
        input.outcome ?? null,
        input.reason ?? null,
        JSON.stringify(input.details ?? {}),
      ).changes
    if (!changes) return null
    this.prune(input.scheduleId)
    return this.get(id) ?? null
  }

  get(id: string): RunRecord | undefined {
    const r = this.db.prepare('SELECT * FROM backup_schedule_runs WHERE id = ?').get(id) as RunRow | undefined
    return r && toRun(r)
  }

  /** Newest first. */
  list(scheduleId: string, limit = MAX_SCHEDULE_RUNS_KEPT): RunRecord[] {
    return this.many(
      'SELECT * FROM backup_schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC LIMIT ?',
      scheduleId,
      limit,
    )
  }

  last(scheduleId: string, n: number): RunRecord[] {
    return this.list(scheduleId, n)
  }

  start(id: string): void {
    this.db.prepare('UPDATE backup_schedule_runs SET started_at = ? WHERE id = ?').run(this.now(), id)
  }

  setJobs(
    id: string,
    jobs: { backupId?: string | null; dumpJobId?: string | null; sendJobId?: string | null },
  ): void {
    const r = this.get(id)
    if (!r) return
    this.db
      .prepare('UPDATE backup_schedule_runs SET backup_id = ?, dump_job_id = ?, send_job_id = ? WHERE id = ?')
      .run(
        jobs.backupId !== undefined ? jobs.backupId : r.backupId,
        jobs.dumpJobId !== undefined ? jobs.dumpJobId : r.dumpJobId,
        jobs.sendJobId !== undefined ? jobs.sendJobId : r.sendJobId,
        id,
      )
  }

  finish(id: string, outcome: RunOutcome, reason: string | null, details: RunDetails): void {
    this.db
      .prepare(
        'UPDATE backup_schedule_runs SET finished_at = ?, outcome = ?, reason = ?, removed = ? WHERE id = ?',
      )
      .run(this.now(), outcome, reason, JSON.stringify(details), id)
  }

  /** Waiting to start, oldest due first. */
  queued(): RunRecord[] {
    return this.many(
      'SELECT * FROM backup_schedule_runs WHERE started_at IS NULL AND outcome IS NULL ORDER BY due_at',
    )
  }

  /** Started and never finished (a previous process stopped during them). */
  unfinished(): RunRecord[] {
    return this.many('SELECT * FROM backup_schedule_runs WHERE started_at IS NOT NULL AND outcome IS NULL')
  }

  prune(scheduleId: string): void {
    this.db
      .prepare(
        `DELETE FROM backup_schedule_runs WHERE schedule_id = ? AND id NOT IN
          (SELECT id FROM backup_schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC LIMIT ?)`,
      )
      .run(scheduleId, scheduleId, MAX_SCHEDULE_RUNS_KEPT)
  }
}
