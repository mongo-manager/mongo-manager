// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document, MongoClient } from 'mongodb'
import { ALERT_CLEAR_RATIO, type AlertEvent } from '@mongo-manager/shared'
import type { ServerSample } from '../monitor/sampler'
import { LENIENT } from '../data/mongo-errors'
import { OWN_READ } from '../monitor/slow-queries'
import type { AlertRepo, EventRow, RuleRow } from './repo'
import type { AlertNotifier } from './notifier'

/** What a sample alone does not hold; read only when a rule asks for it. */
export interface ExtraValues {
  replicationLag?: number | null
  diskUse?: number | null
  /** By the rule's seconds; a plain number counts for every rule (tests). */
  slowOps?: Record<number, number> | number | null
}

const EXTRA_MS = 5_000
const OWN = { comment: `${OWN_READ}:alerts` }

/** The most a secondary is behind its primary, in seconds; null outside a replica set. */
async function replicationLag(client: MongoClient): Promise<number | null> {
  const status = await client
    .db('admin')
    .command({ replSetGetStatus: 1 }, { ...LENIENT, readPreference: 'primaryPreferred', timeoutMS: EXTRA_MS })
  const members = (status.members ?? []) as Document[]
  const primary = members.find((m) => m.stateStr === 'PRIMARY')
  const at = (m: Document) => (m.optimeDate instanceof Date ? m.optimeDate.getTime() : null)
  const top = primary ? at(primary) : null
  if (top === null) return null
  let lag = 0
  for (const m of members) {
    if (m.stateStr !== 'SECONDARY') continue
    const t = at(m)
    if (t !== null) lag = Math.max(lag, (top - t) / 1000)
  }
  return lag
}

/** Percent of the data files' disk in use (dbStats fsUsedSize/fsTotalSize, MongoDB 4.4+). */
async function diskUse(client: MongoClient): Promise<number | null> {
  const stats = await client.db('admin').command({ dbStats: 1 }, { timeoutMS: EXTRA_MS })
  const used = Number(stats.fsUsedSize)
  const total = Number(stats.fsTotalSize)
  return Number.isFinite(used) && Number.isFinite(total) && total > 0
    ? Math.round((used / total) * 1000) / 10
    : null
}

/** Active operations running at least `seconds`, not the app's own monitoring reads. */
async function slowOps(client: MongoClient, seconds: number): Promise<number> {
  const [row] = await client
    .db('admin')
    .aggregate(
      [
        { $currentOp: { allUsers: true, idleConnections: false } },
        {
          $match: {
            active: true,
            op: { $ne: 'none' },
            secs_running: { $gte: seconds },
            'command.comment': { $ne: OWN.comment },
          },
        },
        { $count: 'n' },
      ],
      { ...OWN, maxTimeMS: EXTRA_MS },
    )
    .toArray()
  return Number(row?.n ?? 0)
}

/** Reads what the enabled rules need beyond the sample; a refused or failed read is null (no change). */
export async function readExtras(client: MongoClient, rules: readonly RuleRow[]): Promise<ExtraValues> {
  const out: ExtraValues = {}
  const want = new Set(rules.map((r) => r.metric))
  if (want.has('replicationLag')) out.replicationLag = await replicationLag(client).catch(() => null)
  if (want.has('diskUse')) out.diskUse = await diskUse(client).catch(() => null)
  const seconds = [...new Set(rules.filter((r) => r.metric === 'slowOps').map((r) => r.slowOpSeconds ?? 5))]
  if (seconds.length) {
    const counts: Record<number, number> = {}
    for (const s of seconds.slice(0, 5)) {
      try {
        counts[s] = await slowOps(client, s)
      } catch {
        // Refused (inprog needs clusterMonitor): this rule reads nothing this time.
      }
    }
    out.slowOps = counts
  }
  return out
}

export function metricValue(rule: RuleRow, s: ServerSample, extra: ExtraValues): number | null {
  switch (rule.metric) {
    case 'connections':
      return s.connections.current
    case 'opcounters':
      // A rate needs a previous reading: a baseline sample measures none.
      return s.baseline ? null : Object.values(s.ops).reduce((a, b) => a + b, 0)
    case 'cacheFill':
      return s.cache && s.cache.maxBytes > 0
        ? Math.round((s.cache.usedBytes / s.cache.maxBytes) * 1000) / 10
        : null
    case 'replicationLag':
      return extra.replicationLag ?? null
    case 'diskUse':
      return extra.diskUse ?? null
    case 'slowOps': {
      const v = extra.slowOps
      if (v === null || v === undefined) return null
      return typeof v === 'number' ? v : (v[rule.slowOpSeconds ?? 5] ?? null)
    }
    default:
      return null
  }
}

export interface EngineDeps {
  repo: AlertRepo
  notifier: AlertNotifier
  connectionName: (id: string) => string | null
  now: () => number
  enabled: boolean
}

/**
 * W3.3: evaluates metric rules on each sample the history recorder takes (one a minute) and turns
 * the app's events into alerts. Hysteresis: a rule fires once its value has been above the
 * threshold for `sustain` samples in a row, and resolves only once it has been at or below
 * ALERT_CLEAR_RATIO of it for as many — a value hovering at the line does not flap.
 */
export class AlertEngine {
  private readonly counters = new Map<string, { above: number; below: number }>()

  constructor(private readonly d: EngineDeps) {}

  private snoozed(rule: RuleRow): boolean {
    return rule.snoozedUntil !== null && rule.snoozedUntil > this.d.now()
  }

  async onSample(
    connectionId: string,
    sample: ServerSample,
    extra?: MongoClient | ExtraValues,
  ): Promise<void> {
    if (!this.d.enabled) return
    const rules = this.d.repo.listRules(connectionId).filter((r) => r.kind === 'metric' && r.enabled)
    if (!rules.length) return
    const values: ExtraValues =
      extra && typeof (extra as MongoClient).db === 'function'
        ? await readExtras(extra as MongoClient, rules)
        : ((extra as ExtraValues | undefined) ?? {})
    for (const rule of rules) {
      const value = metricValue(rule, sample, values)
      if (value === null || rule.threshold === null) continue
      this.evaluate(rule, value)
    }
  }

  private evaluate(rule: RuleRow, value: number): void {
    const threshold = rule.threshold!
    const c = this.counters.get(rule.id) ?? { above: 0, below: 0 }
    this.counters.set(rule.id, c)
    const open = this.d.repo.openFiring(rule.id)
    if (!open) {
      c.below = 0
      c.above = value > threshold ? c.above + 1 : 0
      if (c.above < rule.sustain) return
      c.above = 0
      const fired = this.d.repo.insertEvent({
        ruleId: rule.id,
        connectionId: rule.connectionId,
        connectionName: rule.connectionId ? this.d.connectionName(rule.connectionId) : null,
        metric: rule.metric,
        event: null,
        state: 'firing',
        value,
        threshold,
        startedAt: this.d.now(),
        detail: rule.metric === 'slowOps' ? { seconds: rule.slowOpSeconds ?? 5 } : {},
        snoozed: this.snoozed(rule),
      })
      this.d.notifier.notify(fired, rule, 'firing')
      return
    }
    c.above = 0
    if (value > threshold) this.d.repo.raise(open.id, value)
    c.below = value <= threshold * ALERT_CLEAR_RATIO ? c.below + 1 : 0
    if (c.below < rule.sustain) return
    c.below = 0
    const resolved = this.d.repo.resolve(open.id, null)
    if (resolved) this.d.notifier.notify({ ...resolved, snoozed: this.snoozed(rule) }, rule, 'resolved')
  }

  /** A rule changed or went: its counts start again; a disabled or deleted rule stops firing quietly. */
  ruleChanged(ruleId: string, rule: RuleRow | undefined, firing?: EventRow): void {
    this.counters.delete(ruleId)
    if ((!rule || !rule.enabled) && firing) this.d.repo.resolve(firing.id, null)
  }

  /** One of the app's events: an alert for each enabled rule that takes it on this connection. */
  event(input: {
    event: AlertEvent
    /** Stored with the event: null when the connection is gone (W3 review I1). */
    connectionId: string | null
    detail: EventRow['detail']
    /** The name to keep, when the caller knows it (a deleted connection's). */
    connectionName?: string | null
    /** The connection rules are matched against (it may be gone). */
    ruleConnectionId?: string | null
  }): void {
    if (!this.d.enabled) return
    const on = input.ruleConnectionId !== undefined ? input.ruleConnectionId : input.connectionId
    const rules = this.d.repo
      .listRules()
      .filter(
        (r) =>
          r.kind === 'event' &&
          r.enabled &&
          r.event === input.event &&
          (r.connectionId === null || r.connectionId === on),
      )
    const name =
      input.connectionName !== undefined
        ? input.connectionName
        : input.connectionId
          ? this.d.connectionName(input.connectionId)
          : null
    for (const rule of rules) {
      const row = this.d.repo.insertEvent({
        ruleId: rule.id,
        connectionId: input.connectionId,
        connectionName: name,
        metric: null,
        event: input.event,
        state: 'event',
        value: null,
        threshold: null,
        startedAt: this.d.now(),
        detail: input.detail,
        snoozed: this.snoozed(rule),
      })
      this.d.notifier.notify(row, rule, 'event')
    }
  }
}
