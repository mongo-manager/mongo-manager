// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync } from 'node:sqlite'
import { RUNNING_STATES, type AlertEvent, type AppEvent, type AppEventKind } from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'
import { createEgress, type SocketEgress } from '../net/egress'
import type { JobRecord } from '../jobs/types'
import type { LiveSyncRecord } from '../livesync/repo'
import { AlertRepo, type EventRow } from './repo'
import { AlertNotifier } from './notifier'
import { AlertEngine } from './engine'

/** Job kinds whose failure is a backup's (the rest are "a job failed"). */
const BACKUP_JOBS = new Set(['backup.dump', 'backup.send', 'backup.fetch'])
/**
 * W4 review I4: job kinds whose failure is told by an app event instead (a restore drill's says what
 * failed: backup.drillFailed) — one alert, not two.
 */
const TOLD_BY_EVENTS = new Set(['backup.drill'])
/**
 * W4 review I4: the app events that are alerts (docs/app-events.md); a drill that passed is history
 * only, and a live sync that stopped is told by its own record (onLiveSync), never twice.
 */
export const ALERT_OF_APP_EVENT: Partial<Record<AppEventKind, AlertEvent>> = {
  'backup.drill.failed': 'backup.drillFailed',
  'liveSync.conflicts': 'liveSync.conflicts',
  'watch.matched': 'watch.matched',
}
/** Live sync states worth an alert, unless a person put it there. */
const SYNC_ALERT_STATES = new Set(['failed', 'stopped', 'attention'])
const RUNNING = new Set<string>(RUNNING_STATES)
const BY_A_PERSON = new Set(['owner', 'admin'])
const SEEN_MAX = 2000
const GONE_MAX = 500

export interface AlertServiceDeps {
  db: DatabaseSync
  box: SecretBox
  now: () => number
  enabled: boolean
  privateNetworks: readonly string[]
  /** A connection's name; null once it is gone. */
  connectionName: (id: string) => string | null
  warn: (fields: Record<string, unknown>, message: string) => void
  retryMs?: readonly number[]
}

/**
 * W3.3: alerts as one service — the rules and history, the evaluation, the channels, and the
 * app's events turned into alerts. Its own egress client (MM_ALERTS_PRIVATE_NETWORKS): what alerts
 * may reach is decided apart from backups and the AI assistant.
 */
export class AlertService {
  readonly repo: AlertRepo
  readonly notifier: AlertNotifier
  readonly engine: AlertEngine
  readonly egress: SocketEgress
  readonly enabled: boolean
  /** Jobs already turned into an event (repeats of one change come throttled). */
  private readonly seen = new Set<string>()
  /** Each live sync's last alerted state and reason, until it runs again (W3 review I4). */
  private readonly syncs = new Map<string, string>()
  /** Names of connections deleted lately (W3 review I1). */
  private readonly gone = new Map<string, string>()

  constructor(private readonly d: AlertServiceDeps) {
    this.enabled = d.enabled
    this.repo = new AlertRepo(d.db, d.box, d.now)
    this.egress = createEgress({ networks: d.privateNetworks, networksSetting: 'MM_ALERTS_PRIVATE_NETWORKS' })
    this.notifier = new AlertNotifier({
      repo: this.repo,
      egress: this.egress,
      now: d.now,
      warn: d.warn,
      enabled: d.enabled,
      ...(d.retryMs ? { retryMs: d.retryMs } : {}),
    })
    this.engine = new AlertEngine({
      repo: this.repo,
      notifier: this.notifier,
      connectionName: (id) => d.connectionName(id) ?? this.gone.get(id) ?? null,
      now: d.now,
      enabled: d.enabled,
    })
  }

  /** Connections whose metric rules need samples (none while alerts are off). */
  sampled(): string[] {
    return this.enabled ? this.repo.metricConnections() : []
  }

  /**
   * W3 review (I1): a connection about to be deleted. Its name is kept a while, so the events its
   * deletion causes (a live sync stopping) still say where; they store no id (it is gone).
   */
  remember(connectionId: string, name: string): void {
    if (this.gone.size >= GONE_MAX) this.gone.clear()
    this.gone.set(connectionId, name)
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false
    if (this.seen.size >= SEEN_MAX) this.seen.clear()
    this.seen.add(key)
    return true
  }

  /**
   * One of the app's events. W3 review (I1): never throws — it runs inside the jobs' and live
   * syncs' listeners (a timer among them), where a failure would break what they do next or end
   * the process; it is logged instead. A connection that is gone is named, not referenced.
   */
  event(input: { event: AlertEvent; connectionId: string | null; detail: EventRow['detail'] }): void {
    try {
      const exists = input.connectionId !== null && this.d.connectionName(input.connectionId) !== null
      this.engine.event({
        ...input,
        connectionId: exists ? input.connectionId : null,
        connectionName: input.connectionId
          ? (this.d.connectionName(input.connectionId) ?? this.gone.get(input.connectionId) ?? null)
          : null,
        ruleConnectionId: input.connectionId,
      })
    } catch (err) {
      this.d.warn({ err, event: input.event }, 'alerts: an event could not be recorded')
    }
  }

  /** A job that failed: its kind and namespace go, never its error text (it can quote values). */
  onJob(job: JobRecord): void {
    try {
      if (job.state !== 'failed' || TOLD_BY_EVENTS.has(job.kind) || !this.once(`job:${job.id}`)) return
      const namespace = job.db ? (job.coll ? `${job.db}.${job.coll}` : job.db) : null
      this.event({
        event: BACKUP_JOBS.has(job.kind) ? 'backup.failed' : 'job.failed',
        connectionId: job.connectionId,
        detail: { job: job.id, kind: job.kind, namespace },
      })
    } catch (err) {
      this.d.warn({ err }, 'alerts: a job change could not be read')
    }
  }

  /**
   * W4 review I4: an app event that is an alert — its details, with its severity, summary and
   * namespace (ids, names, counts and codes only: the emitters never put a document value there).
   */
  onAppEvent(e: AppEvent): void {
    try {
      const event = ALERT_OF_APP_EVENT[e.kind]
      if (!event) return
      this.event({
        event,
        connectionId: e.connectionId,
        detail: { ...e.details, severity: e.severity, summary: e.summary, namespace: e.namespace },
      })
    } catch (err) {
      this.d.warn({ err }, 'alerts: an app event could not be read')
    }
  }

  /**
   * A live sync that stopped, failed or needs attention on its own (not one a person stopped).
   * W3 review (I4): a sync that runs again forgets what it alerted, so failing again alerts again.
   */
  onLiveSync(r: LiveSyncRecord): void {
    try {
      if (RUNNING.has(r.state)) {
        this.syncs.delete(r.id)
        return
      }
      if (!SYNC_ALERT_STATES.has(r.state) || (r.reason && BY_A_PERSON.has(r.reason))) return
      const key = `${r.state}:${r.reason ?? ''}`
      if (this.syncs.get(r.id) === key) return
      if (this.syncs.size >= SEEN_MAX) this.syncs.clear()
      this.syncs.set(r.id, key)
      this.event({
        event: 'liveSync.stopped',
        connectionId: r.source.connectionId,
        detail: {
          sync: r.id,
          name: r.name,
          state: r.state,
          reason: r.reason,
          namespace: r.source.coll ? `${r.source.db}.${r.source.coll}` : r.source.db,
        },
      })
    } catch (err) {
      this.d.warn({ err }, 'alerts: a live sync change could not be read')
    }
  }
}
