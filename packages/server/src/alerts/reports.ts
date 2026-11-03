import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Document, MongoClient } from 'mongodb'
import {
  compileCadence,
  deserializeValue,
  findServerJs,
  nextRunAfter,
  serializeValue,
  type AlertChannels,
  type Cadence,
  type ReportInput,
  type ReportMeasure,
  type ReportPatch,
  type ReportValue,
  type ReportView,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { MASKING_UNSUPPORTED, PERSONAL_FIELD, PERSONAL_INDEX } from '../masking/gate/refusal'
import type { ConnectionManager } from '../connections/manager'
import { SYSTEM_DATABASES, isDrillScratch, isEncryptionNamespace } from '../connections/access'
import { compileRules } from '../masking/match'
import { gateDepsFor } from '../masking/restricted'
import { guardCount } from '../masking/gate'
import { keySorted } from '../masking/gate/write'
import type { PersonalFieldsRepo } from '../masking/repo'
import type { AlertService } from './service'
import type { RuleRow } from './repo'

/** Design 2026-10-25 (C7): at most this many reports, each a run a minute at most often (an hour). */
export const MAX_REPORTS = 100
/** A count past this is said as "at least" (a bounded count: one that never runs on for ever). */
export const REPORT_COUNT_BOUND = 1_000_000
/** Each measure's count has this long. */
export const REPORT_COUNT_MS = 15_000
/** How often the runner looks for reports due. */
export const REPORT_TICK_MS = 30_000
/** Review of C7a (M4): how long a count's collection kind may take to read. */
const REPORT_LIST_MS = 5_000
/** Review of C7a (M7): each report's last runs kept in the alert history. */
export const REPORT_RUNS_KEPT = 30

interface ReportDb {
  id: string
  connection_id: string
  name: string
  measures: string
  cadence: string
  time_zone: string
  enabled: number
  channels: string
  next_run_at: number | null
  last_run: string | null
  created_by: string | null
  created_at: number
  updated_at: number
}

export interface ReportRow {
  id: string
  connectionId: string
  name: string
  measures: ReportMeasure[]
  cadence: Cadence
  timeZone: string
  enabled: boolean
  channels: AlertChannels
  nextRunAt: number | null
  lastRun: { at: number; values: ReportValue[] } | null
  createdAt: number
}

const parse = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
const toRow = (r: ReportDb): ReportRow => ({
  id: r.id,
  connectionId: r.connection_id,
  name: r.name,
  measures: parse<ReportMeasure[]>(r.measures, []),
  cadence: parse<Cadence>(r.cadence, { kind: 'daily', times: ['09:00'] }),
  timeZone: r.time_zone,
  enabled: r.enabled === 1,
  channels: parse<AlertChannels>(r.channels, { inApp: true, email: false, webhooks: [] }),
  nextRunAt: r.next_run_at,
  lastRun: parse<ReportRow['lastRun']>(r.last_run, null),
  createdAt: r.created_at,
})

export const reportView = (r: ReportRow): ReportView => ({
  id: r.id,
  connectionId: r.connectionId,
  name: r.name,
  measures: r.measures,
  cadence: r.cadence,
  timeZone: r.timeZone,
  enabled: r.enabled,
  channels: r.channels,
  nextRunAt: r.nextRunAt,
  lastRun: r.lastRun,
  createdAt: r.createdAt,
})

/** The next run of a report after `after`, none when its cadence never runs. */
const nextOf = (cadence: Cadence, zone: string, after: number): number | null =>
  nextRunAfter(compileCadence(cadence), zone, after)

/** Design 2026-10-25 (C7): scheduled reports, each a few counts on a cadence. */
export class ReportRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  list(): ReportRow[] {
    return (
      this.db.prepare('SELECT * FROM alert_reports ORDER BY created_at').all() as unknown as ReportDb[]
    ).map(toRow)
  }

  get(id: string): ReportRow | undefined {
    const row = this.db.prepare('SELECT * FROM alert_reports WHERE id = ?').get(id) as ReportDb | undefined
    return row ? toRow(row) : undefined
  }

  create(input: ReportInput, createdBy: string | null): ReportRow {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM alert_reports').get() as { n: number }
    if (n >= MAX_REPORTS)
      throw Errors.conflict(`At most ${MAX_REPORTS} reports`, { reason: 'too_many_reports' })
    const id = randomUUID()
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO alert_reports (id, connection_id, name, measures, cadence, time_zone, enabled, channels,
           next_run_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.connectionId,
        input.name,
        JSON.stringify(input.measures),
        JSON.stringify(input.cadence),
        input.timeZone,
        input.enabled ? 1 : 0,
        JSON.stringify(input.channels),
        nextOf(input.cadence, input.timeZone, at),
        createdBy,
        at,
        at,
      )
    return this.get(id)!
  }

  patch(id: string, p: ReportPatch): ReportRow | undefined {
    const before = this.get(id)
    if (!before) return undefined
    const next = { ...before, ...p }
    const at = this.now()
    // A new cadence or zone, or one turned on, runs next from now.
    const timing =
      p.cadence !== undefined || p.timeZone !== undefined || (p.enabled === true && !before.enabled)
    this.db
      .prepare(
        `UPDATE alert_reports SET name = ?, measures = ?, cadence = ?, time_zone = ?, enabled = ?, channels = ?,
           next_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        JSON.stringify(next.measures),
        JSON.stringify(next.cadence),
        next.timeZone,
        next.enabled ? 1 : 0,
        JSON.stringify(next.channels),
        timing ? nextOf(next.cadence, next.timeZone, at) : before.nextRunAt,
        at,
        id,
      )
    return this.get(id)
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM alert_reports WHERE id = ?').run(id).changes) > 0
  }

  /** Reports on and due by `now`. */
  due(now: number): ReportRow[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM alert_reports WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
        )
        .all(now) as unknown as ReportDb[]
    ).map(toRow)
  }

  /** Review of C7a (I1): turned off, its last run saying why (its next run cannot be worked out). */
  stop(id: string, at: number, values: ReportValue[]): void {
    this.db
      .prepare('UPDATE alert_reports SET enabled = 0, next_run_at = NULL, last_run = ? WHERE id = ?')
      .run(JSON.stringify({ at, values }), id)
  }

  /** A run's values kept; its next run (scheduled ones only move it). */
  ran(id: string, at: number, values: ReportValue[], next?: number | null): void {
    this.db
      .prepare(
        next === undefined
          ? 'UPDATE alert_reports SET last_run = ? WHERE id = ?'
          : 'UPDATE alert_reports SET last_run = ?, next_run_at = ? WHERE id = ?',
      )
      .run(
        ...(next === undefined
          ? [JSON.stringify({ at, values }), id]
          : [JSON.stringify({ at, values }), next, id]),
      )
  }
}

export interface ReportRunnerDeps {
  db: DatabaseSync
  now: () => number
  manager: ConnectionManager
  personalFields: PersonalFieldsRepo
  alerts: AlertService
  connectionName: (id: string) => string | null
  /** Review of C7a (nit): client-side encryption on the connection (a filter would match nothing). */
  encrypted: (id: string) => boolean
  warn: (fields: Record<string, unknown>, message: string) => void
}

/** Re-review of C7 (I1): a run cut off by the server stopping. */
class Stopped extends Error {}

/** Why a measure cannot be in a report (a code the web says), or null. */
export function measureProblem(m: ReportMeasure): string | null {
  if (SYSTEM_DATABASES.has(m.db) || isDrillScratch(m.db) || m.coll.startsWith('system.'))
    return 'system_namespace'
  if (isEncryptionNamespace(m.db, m.coll)) return 'system_namespace'
  if (m.filter && findServerJs(m.filter)) return 'server_js'
  return null
}

/**
 * Design 2026-10-25 (C7): runs scheduled reports — each measure counted as the connection's own
 * credentials (no person is behind a report), its filter checked by the personal-data gate for everyone
 * first (one that names a personal field, or one the gate would read otherwise, is refused: a count by
 * one tells of its values) — and says them through the alert channels as an event, numbers only.
 */
export class ReportRunner {
  readonly repo: ReportRepo
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private readonly running = new Set<string>()

  constructor(private readonly d: ReportRunnerDeps) {
    this.repo = new ReportRepo(d.db, d.now)
  }

  start(): void {
    if (this.timer) return
    // Review of C7a (I1): a tick never rejects (its own guard), and never takes the process down.
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => this.d.warn({ err }, 'reports: a tick failed'))
    }, REPORT_TICK_MS)
    this.timer.unref?.()
  }

  /** The loop stopped; a tick in flight ends first. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.current
  }

  /**
   * Re-review of C7 (I1): stopping — a run cut off by it saves and sends nothing (it stays due, so it
   * runs once the server is back).
   */
  private stopped = false

  private current: Promise<void> = Promise.resolve()

  /**
   * Each report due runs once (one missed while the server was down too), then its next is set.
   * Review of C7a (I1, M3, M6): each is read again before it runs (deleted, turned off or moved since
   * the tick began, it does not); a run that fails says so on each count, its next still set; one whose
   * next run cannot be worked out (a zone or a cron this build no longer takes) is turned off, said why.
   */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return
    this.ticking = true
    // Re-review of C7 (I1): the promise stop() waits on is the tick's that runs, set once it starts.
    let done!: () => void
    this.current = new Promise<void>((r) => (done = r))
    try {
      const due = this.repo.due(this.d.now()).map((r) => r.id)
      for (const id of due) {
        if (this.stopped) break
        const report = this.repo.get(id)
        const now = this.d.now()
        if (!report?.enabled || report.nextRunAt === null || report.nextRunAt > now) continue
        if (this.running.has(id)) continue
        let next: number | null
        try {
          next = nextOf(report.cadence, report.timeZone, now)
        } catch {
          next = null
        }
        if (next === null) {
          this.repo.stop(
            id,
            now,
            report.measures.map((m) => ({ label: m.label, count: null, reason: 'invalid_cadence' })),
          )
          continue
        }
        try {
          await this.run(report, next)
        } catch (err) {
          if (err instanceof Stopped) break
          this.d.warn({ err, report: id }, 'reports: a run failed')
          try {
            this.repo.ran(
              id,
              now,
              report.measures.map((m) => ({ label: m.label, count: null, reason: 'failed' })),
              next,
            )
          } catch (err2) {
            this.d.warn({ err: err2, report: id }, 'reports: a failed run could not be kept')
          }
        }
      }
    } catch (err) {
      this.d.warn({ err }, 'reports: looking for reports due failed')
    } finally {
      this.ticking = false
      done()
    }
  }

  /**
   * Whether a report's measures may be counted: none of MongoDB's own namespaces, no server JavaScript,
   * a connection that does not sign in per person, and each filter as the gate takes it for everyone.
   * A code (and the measure's place) when not.
   */
  async problem(input: {
    connectionId: string
    measures: ReportMeasure[]
  }): Promise<{ reason: string; measure?: number } | null> {
    for (const [i, m] of input.measures.entries()) {
      const p = measureProblem(m)
      if (p) return { reason: p, measure: i }
    }
    if (this.d.manager.perPerson(input.connectionId)) return { reason: 'per_person' }
    if (this.d.encrypted(input.connectionId)) {
      const i = input.measures.findIndex((m) => !!m.filter)
      if (i >= 0) return { reason: 'encrypted_filter', measure: i }
    }
    const rules = this.d.personalFields.get(input.connectionId).rules
    const release = this.d.manager.hold(input.connectionId)
    try {
      let client: MongoClient
      try {
        client = await this.d.manager.getClient(input.connectionId)
      } catch {
        return { reason: 'unreachable' }
      }
      for (const [i, m] of input.measures.entries()) {
        const reason = (await this.viewProblem(client, m)) ?? (await this.gate(client, rules, m))
        if (reason) return { reason, measure: i }
      }
      return null
    } finally {
      release()
    }
  }

  /**
   * A view or a time series is not counted: its own pipeline may pick by a personal field (and can be
   * changed after the report is saved), and its count runs that pipeline over all it reads.
   */
  private async viewProblem(client: MongoClient, m: ReportMeasure): Promise<string | null> {
    try {
      const [info] = await client
        .db(m.db)
        .listCollections(
          { name: m.coll },
          { nameOnly: true, authorizedCollections: true, maxTimeMS: REPORT_LIST_MS },
        )
        .toArray()
      return info && info.type !== 'collection' ? 'measure_view' : null
    } catch {
      // Review of C7a (M4): not read (rights, time): not counted, said why.
      return 'failed'
    }
  }

  /** The gate for everyone: a filter on a personal field, or one it would rewrite, is refused. */
  private async gate(
    client: MongoClient,
    rules: ReturnType<PersonalFieldsRepo['get']>['rules'],
    m: ReportMeasure,
  ): Promise<string | null> {
    if (!m.filter || !rules.length) return null
    const filter = deserializeValue<Document>(m.filter)
    try {
      const g = await guardCount(m.db, m.coll, filter, undefined, gateDepsFor(compileRules(rules), client))
      // Final review of wave C (minor 3): the gate rebuilds $let, $map and the like in its own key
      // order — compared whatever the order of their keys.
      const same = (v: unknown) => JSON.stringify(keySorted(serializeValue(v)))
      return same(g.filter) !== same(filter) ? 'personal_field' : null
    } catch (e) {
      // Review of C7a (M5): by the gate's own reason — a personal field, a filter it cannot follow, or
      // a check that could not finish.
      const reason =
        e instanceof AppError ? (e.details as { reason?: unknown } | undefined)?.reason : undefined
      if (reason === PERSONAL_FIELD || reason === PERSONAL_INDEX) return 'personal_field'
      if (reason === MASKING_UNSUPPORTED) return 'not_supported'
      return 'failed'
    }
  }

  /**
   * A report's run: each measure counted (none past REPORT_COUNT_BOUND exactly: "at least"), the values
   * kept and sent through the report's channels as a report.ready event. `scheduled` moves its next run.
   */
  async run(report: ReportRow, next?: number): Promise<ReportValue[]> {
    if (this.running.has(report.id))
      throw Errors.conflict('The report is running', { reason: 'report_running' })
    this.running.add(report.id)
    const at = this.d.now()
    try {
      const values = await this.values(report)
      if (this.stopped) throw new Stopped()
      this.repo.ran(report.id, at, values, next)
      // Re-review of C7 (minor 4): the counts are kept; saying them never makes the run a failure.
      try {
        this.announce(report, values, at)
      } catch (err) {
        this.d.warn({ err, report: report.id }, 'reports: a run could not be said')
      }
      return values
    } finally {
      this.running.delete(report.id)
    }
  }

  private async values(report: ReportRow): Promise<ReportValue[]> {
    const none = (reason: string) => report.measures.map((m) => ({ label: m.label, count: null, reason }))
    if (this.d.manager.perPerson(report.connectionId)) return none('per_person')
    const rules = this.d.personalFields.get(report.connectionId).rules
    const release = this.d.manager.hold(report.connectionId)
    try {
      let client: MongoClient
      try {
        client = await this.d.manager.getClient(report.connectionId)
      } catch {
        return none('unreachable')
      }
      const out: ReportValue[] = []
      for (const m of report.measures) {
        // Final review of wave C (minor 2): stopping, no count more (the run is thrown away).
        if (this.stopped) throw new Stopped()
        const problem =
          measureProblem(m) ??
          (m.filter && this.d.encrypted(report.connectionId) ? 'encrypted_filter' : null) ??
          (await this.viewProblem(client, m)) ??
          (await this.gate(client, rules, m))
        if (problem) {
          out.push({ label: m.label, count: null, reason: problem })
          continue
        }
        const coll = client.db(m.db).collection(m.coll)
        try {
          if (!m.filter) {
            out.push({
              label: m.label,
              count: await coll.estimatedDocumentCount({ maxTimeMS: REPORT_COUNT_MS }),
            })
            continue
          }
          const n = await coll.countDocuments(deserializeValue<Document>(m.filter), {
            maxTimeMS: REPORT_COUNT_MS,
            limit: REPORT_COUNT_BOUND + 1,
          })
          out.push(
            n > REPORT_COUNT_BOUND
              ? { label: m.label, count: REPORT_COUNT_BOUND, atLeast: true }
              : { label: m.label, count: n },
          )
        } catch (err) {
          const code = (err as { code?: unknown }).code
          out.push({ label: m.label, count: null, reason: code === 50 ? 'timeout' : 'failed' })
        }
      }
      return out
    } finally {
      release()
    }
  }

  /** The run as an alert event: in the bell (those who may watch the connection), mail, webhooks. */
  private announce(report: ReportRow, values: ReportValue[], at: number): void {
    const alerts = this.d.alerts
    if (!alerts.enabled) return
    const detail: Record<string, string | number | boolean | null> = {
      report: report.name,
      reportId: report.id,
    }
    for (const v of values)
      Object.defineProperty(detail, v.label, {
        value: v.count === null ? null : v.atLeast ? `≥${v.count}` : v.count,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    const row = alerts.repo.insertEvent({
      ruleId: null,
      connectionId: report.connectionId,
      connectionName: this.d.connectionName(report.connectionId),
      metric: null,
      event: 'report.ready',
      state: 'event',
      value: null,
      threshold: null,
      startedAt: at,
      detail,
      snoozed: false,
    })
    alerts.notifier.notify(row, { channels: report.channels, snoozedUntil: null } as RuleRow, 'event')
    // Review of C7a (M7): a report's runs never crowd the history out: its last ones are kept.
    alerts.repo.pruneReport(report.id, REPORT_RUNS_KEPT)
  }
}
