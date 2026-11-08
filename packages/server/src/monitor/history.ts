// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync } from 'node:sqlite'
import type { MongoClient } from 'mongodb'
import { LENIENT } from '../data/mongo-errors'
import { redactUris } from '../connections/errors'
import { readStatus } from './hub'
import { rawFrom, sampleFrom, type RawStatus, type ServerSample } from './sampler'

/** Phase 3b spec §6. */
export const HISTORY_INTERVAL_MS = 60_000
export const HISTORY_BACKOFF_MS = 5 * 60_000
export const HISTORY_KEEP_MS = 7 * 24 * 3600_000
export const MAX_HISTORY_CONNECTIONS = 50
const PRUNE_EVERY_MS = 3600_000

const OPS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const
type OpName = (typeof OPS)[number]

/** One point of a stored range: averages over its step; a rate is null where nothing measured it. */
export interface HistoryPoint {
  t: number
  ops: Record<OpName, number | null>
  network: { inPerSec: number | null; outPerSec: number | null }
  connections: { current: number; available: number }
  memory: { residentMb: number; virtualMb: number }
  cache: { usedBytes: number; dirtyBytes: number; maxBytes: number } | null
  queues: { readers: number; writers: number }
  restarted: boolean
  /** Widgets wave 2: averaged as the others; null where none was measured in the step. */
  targeting: ServerSample['targeting']
  latency: ServerSample['latency']
  cursors: ServerSample['cursors']
  transactions: ServerSample['transactions']
  errors: ServerSample['errors']
}

/** Widgets wave 2: the columns of the new metrics, and where each sits in a sample. */
const WAVE2: ReadonlyArray<[column: string, read: (s: ServerSample) => number | null]> = [
  ['qt_keys', (s) => s.targeting.keysPerReturned],
  ['qt_docs', (s) => s.targeting.docsPerReturned],
  ['lat_reads', (s) => s.latency.readsMs],
  ['lat_writes', (s) => s.latency.writesMs],
  ['lat_commands', (s) => s.latency.commandsMs],
  ['cur_open', (s) => s.cursors?.open ?? null],
  ['cur_no_timeout', (s) => s.cursors?.noTimeout ?? null],
  ['tx_committed', (s) => s.transactions.committedPerSec],
  ['tx_aborted', (s) => s.transactions.abortedPerSec],
  ['err_regular', (s) => s.errors.regularPerSec],
  ['err_user', (s) => s.errors.userPerSec],
  ['err_msg', (s) => s.errors.msgPerSec],
  ['err_cursor_timeouts', (s) => s.errors.cursorTimeoutsPerSec],
]

type PointRow = Record<string, number | null> & {
  bucket: number
  restarted: number
  ops_insert: number | null
  ops_query: number | null
  ops_update: number | null
  ops_delete: number | null
  ops_getmore: number | null
  ops_command: number | null
  net_in: number | null
  net_out: number | null
  conn_current: number
  conn_available: number
  mem_resident: number
  mem_virtual: number
  cache_used: number | null
  cache_dirty: number | null
  cache_max: number | null
  q_readers: number
  q_writers: number
}

/** Which connections record history, and their samples (numbers only, no names, no hosts). */
export class HistoryRepo {
  constructor(private readonly db: DatabaseSync) {}

  enabled(): string[] {
    return (
      this.db
        .prepare('SELECT connection_id FROM metric_history WHERE enabled = 1 ORDER BY connection_id')
        .all() as Array<{
        connection_id: string
      }>
    ).map((r) => r.connection_id)
  }

  isEnabled(connectionId: string): boolean {
    const row = this.db
      .prepare('SELECT enabled FROM metric_history WHERE connection_id = ?')
      .get(connectionId) as { enabled: number } | undefined
    return row?.enabled === 1
  }

  countEnabled(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM metric_history WHERE enabled = 1').get() as { n: number }
    ).n
  }

  setEnabled(connectionId: string, on: boolean): void {
    this.db
      .prepare(
        `INSERT INTO metric_history (connection_id, enabled) VALUES (?, ?)
         ON CONFLICT (connection_id) DO UPDATE SET enabled = excluded.enabled,
           last_error = CASE WHEN excluded.enabled = 1 THEN last_error ELSE NULL END`,
      )
      .run(connectionId, on ? 1 : 0)
  }

  add(connectionId: string, s: ServerSample): void {
    const rate = (v: number) => (s.baseline ? null : v)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO metric_samples (connection_id, ts, restarted,
           ops_insert, ops_query, ops_update, ops_delete, ops_getmore, ops_command, net_in, net_out,
           conn_current, conn_available, mem_resident, mem_virtual, cache_used, cache_dirty, cache_max,
           q_readers, q_writers, ${WAVE2.map(([c]) => c).join(', ')})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${WAVE2.map(() => '?').join(', ')})`,
      )
      .run(
        connectionId,
        s.t,
        s.restarted ? 1 : 0,
        ...OPS.map((op) => rate(s.ops[op])),
        rate(s.network.inPerSec),
        rate(s.network.outPerSec),
        s.connections.current,
        s.connections.available,
        s.memory.residentMb,
        s.memory.virtualMb,
        s.cache?.usedBytes ?? null,
        s.cache?.dirtyBytes ?? null,
        s.cache?.maxBytes ?? null,
        s.queues.readers,
        s.queues.writers,
        ...WAVE2.map(([, read]) => read(s)),
      )
  }

  /** A sample could not be taken; the error (no connection string) is kept for the settings view. */
  failed(connectionId: string, error: string, at: number): void {
    this.db
      .prepare('UPDATE metric_history SET last_error = ?, last_error_at = ? WHERE connection_id = ?')
      .run(redactUris(error).slice(0, 500), at, connectionId)
  }

  /** A sample was taken: the last error is over. */
  recovered(connectionId: string): void {
    this.db
      .prepare('UPDATE metric_history SET last_error = NULL, last_error_at = NULL WHERE connection_id = ?')
      .run(connectionId)
  }

  status(connectionId: string): {
    enabled: boolean
    lastError: string | null
    lastErrorAt: number | null
    samples: number
  } {
    const row = this.db
      .prepare('SELECT enabled, last_error, last_error_at FROM metric_history WHERE connection_id = ?')
      .get(connectionId) as
      { enabled: number; last_error: string | null; last_error_at: number | null } | undefined
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM metric_samples WHERE connection_id = ?')
      .get(connectionId) as { n: number }
    return {
      enabled: row?.enabled === 1,
      lastError: row?.last_error ?? null,
      lastErrorAt: row?.last_error_at ?? null,
      samples: n,
    }
  }

  clear(connectionId: string): void {
    this.db.prepare('DELETE FROM metric_samples WHERE connection_id = ?').run(connectionId)
  }

  /** Deletes samples taken before `before`; answers how many. */
  prune(before: number): number {
    return Number(this.db.prepare('DELETE FROM metric_samples WHERE ts < ?').run(before).changes)
  }

  /** Averages per step of the samples in [from, to); a step without samples is left out (a gap). */
  points(connectionId: string, from: number, to: number, stepMs: number): HistoryPoint[] {
    const rows = this.db
      .prepare(
        `SELECT CAST(ts / ? AS INTEGER) * ? AS bucket, MAX(restarted) AS restarted,
           AVG(ops_insert) AS ops_insert, AVG(ops_query) AS ops_query, AVG(ops_update) AS ops_update,
           AVG(ops_delete) AS ops_delete, AVG(ops_getmore) AS ops_getmore, AVG(ops_command) AS ops_command,
           AVG(net_in) AS net_in, AVG(net_out) AS net_out,
           AVG(conn_current) AS conn_current, AVG(conn_available) AS conn_available,
           AVG(mem_resident) AS mem_resident, AVG(mem_virtual) AS mem_virtual,
           AVG(cache_used) AS cache_used, AVG(cache_dirty) AS cache_dirty, AVG(cache_max) AS cache_max,
           AVG(q_readers) AS q_readers, AVG(q_writers) AS q_writers,
           ${WAVE2.map(([c]) => `AVG(${c}) AS ${c}`).join(', ')}
         FROM metric_samples WHERE connection_id = ? AND ts >= ? AND ts < ?
         GROUP BY CAST(ts / ? AS INTEGER) ORDER BY bucket`,
      )
      .all(stepMs, stepMs, connectionId, from, to, stepMs) as unknown as PointRow[]
    return rows.map((r) => ({
      t: r.bucket,
      ops: {
        insert: r.ops_insert,
        query: r.ops_query,
        update: r.ops_update,
        delete: r.ops_delete,
        getmore: r.ops_getmore,
        command: r.ops_command,
      },
      network: { inPerSec: r.net_in, outPerSec: r.net_out },
      connections: { current: r.conn_current, available: r.conn_available },
      memory: { residentMb: r.mem_resident, virtualMb: r.mem_virtual },
      cache:
        r.cache_max === null
          ? null
          : { usedBytes: r.cache_used ?? 0, dirtyBytes: r.cache_dirty ?? 0, maxBytes: r.cache_max },
      queues: { readers: r.q_readers, writers: r.q_writers },
      restarted: r.restarted === 1,
      targeting: { keysPerReturned: r.qt_keys ?? null, docsPerReturned: r.qt_docs ?? null },
      latency: {
        readsMs: r.lat_reads ?? null,
        writesMs: r.lat_writes ?? null,
        commandsMs: r.lat_commands ?? null,
      },
      cursors:
        r.cur_open === null || r.cur_open === undefined
          ? null
          : { open: r.cur_open, noTimeout: r.cur_no_timeout ?? 0 },
      transactions: { committedPerSec: r.tx_committed ?? null, abortedPerSec: r.tx_aborted ?? null },
      errors: {
        regularPerSec: r.err_regular ?? null,
        userPerSec: r.err_user ?? null,
        msgPerSec: r.err_msg ?? null,
        cursorTimeoutsPerSec: r.err_cursor_timeouts ?? null,
      },
    }))
  }
}

export interface RecorderDeps {
  repo: HistoryRepo
  client: (connectionId: string) => Promise<MongoClient>
  hold: (connectionId: string) => () => void
  now: () => number
  intervalMs?: number
  /** How long one sample may take before it counts as failed; tests shorten it. */
  timeoutMs?: number
  /** Starts a repeating timer; tests replace it. */
  setTimer?: (fn: () => void, ms: number) => { stop(): void }
  /** Runs once after a delay; tests replace it. */
  later?: (fn: () => void, ms: number) => { stop(): void }
  /**
   * W3.3: connections sampled for alerts besides those recording history (their samples are not
   * stored unless history is on there too), and where each sample goes.
   */
  extra?: () => readonly string[]
  onSample?: (connectionId: string, sample: ServerSample, client: MongoClient) => void
}

/** A sample that takes longer fails: a hung server must not hold its connection forever (I4). */
const SAMPLE_TIMEOUT_MS = 10_000

const realTimer = (fn: () => void, ms: number) => {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

const realLater = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { stop: () => clearTimeout(timer) }
}

/** `work`, or a rejection once `ms` have passed. */
async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`serverStatus timed out after ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Phase 3b spec §6: samples every connection whose history is on, once a minute, with the same
 * serverStatus as the live charts. Timers exist only for enabled connections (sync() after every
 * toggle, delete and start-up), so the server never connects on its own to any other. After a
 * failure a connection is left alone for 5 minutes; turning history off and on keeps both that
 * wait and the one-minute pace (final review M2).
 */
export class HistoryRecorder {
  private readonly timers = new Map<string, { stop(): void }>()
  private readonly previous = new Map<string, RawStatus>()
  private readonly waitUntil = new Map<string, number>()
  private readonly lastTick = new Map<string, number>()
  private readonly busy = new Set<string>()
  private pruner: { stop(): void } | null = null

  constructor(private readonly deps: RecorderDeps) {}

  private get every(): number {
    return this.deps.intervalMs ?? HISTORY_INTERVAL_MS
  }

  private timer(fn: () => void, ms: number): { stop(): void } {
    return (this.deps.setTimer ?? realTimer)(fn, ms)
  }

  start(): void {
    // Spread over one interval: fifty connections must not all be sampled in the same second.
    this.sync(true)
    this.prune()
    this.pruner = this.timer(() => this.prune(), PRUNE_EVERY_MS)
  }

  stop(): void {
    for (const t of this.timers.values()) t.stop()
    this.timers.clear()
    this.pruner?.stop()
    this.pruner = null
  }

  /** Connections sampled now: history on, or an alert rule on them (W3.3). */
  private wanted(): Set<string> {
    const on = new Set(this.deps.repo.enabled())
    for (const id of this.deps.extra?.() ?? []) on.add(id)
    return on
  }

  private isWanted(connectionId: string): boolean {
    return this.deps.repo.isEnabled(connectionId) || (this.deps.extra?.() ?? []).includes(connectionId)
  }

  /** Timers exactly for the enabled connections (and those alerts watch). */
  sync(stagger = false): void {
    const on = this.wanted()
    for (const [id, t] of this.timers) {
      if (on.has(id)) continue
      t.stop()
      this.timers.delete(id)
      this.previous.delete(id)
    }
    const added = [...on].filter((id) => !this.timers.has(id))
    const gap = stagger && added.length > 1 ? Math.floor(this.every / added.length) : 0
    added.forEach((id, i) => this.schedule(id, i * gap))
  }

  /** A repeating sample for `id`, the first after `delayMs`. */
  private schedule(id: string, delayMs: number): void {
    if (delayMs <= 0) {
      this.timers.set(
        id,
        this.timer(() => void this.tick(id), this.every),
      )
      // The first sample at once when one is due: a history switched on shows something straight
      // away, but switching it off and on does not sample faster than once an interval.
      if (this.deps.now() - (this.lastTick.get(id) ?? -Infinity) >= this.every) void this.tick(id)
      return
    }
    let repeating: { stop(): void } | null = null
    const first = (this.deps.later ?? realLater)(() => {
      repeating = this.timer(() => void this.tick(id), this.every)
      void this.tick(id)
    }, delayMs)
    this.timers.set(id, {
      stop: () => {
        first.stop()
        repeating?.stop()
      },
    })
  }

  prune(): void {
    try {
      this.deps.repo.prune(this.deps.now() - HISTORY_KEEP_MS)
    } catch {
      // The store is closing: the next hourly prune catches up (final review M1).
    }
  }

  /** One sample; never rejects, since it runs from timers (final review M1). */
  async tick(connectionId: string): Promise<void> {
    try {
      await this.sample(connectionId)
    } catch {
      // The store itself failed (closing): the next tick tries again.
    }
  }

  private async sample(connectionId: string): Promise<void> {
    const now = this.deps.now()
    if (this.busy.has(connectionId) || !this.isWanted(connectionId)) return
    if ((this.waitUntil.get(connectionId) ?? 0) > now) return
    this.busy.add(connectionId)
    this.lastTick.set(connectionId, now)
    const release = this.deps.hold(connectionId)
    try {
      let client: MongoClient | undefined
      const raw = rawFrom(
        await deadline(
          (async () => {
            client = await this.deps.client(connectionId)
            return readStatus(client, { ...LENIENT, timeoutMS: SAMPLE_TIMEOUT_MS })
          })(),
          this.deps.timeoutMs ?? SAMPLE_TIMEOUT_MS,
        ),
        now,
      )
      // Turned off while MongoDB answered: nothing is stored.
      if (!this.isWanted(connectionId)) return
      const sample = sampleFrom(this.previous.get(connectionId) ?? null, raw)
      this.previous.set(connectionId, raw)
      if (this.deps.repo.isEnabled(connectionId)) {
        this.deps.repo.add(connectionId, sample)
        this.deps.repo.recovered(connectionId)
      }
      // W3.3: the alert rules read the same sample (never stored for them alone).
      if (client) this.deps.onSample?.(connectionId, sample, client)
    } catch (e) {
      this.previous.delete(connectionId)
      // Turned off (or deleted) meanwhile: no error to show, and no wait (final review M3).
      if (!this.isWanted(connectionId)) return
      if (this.deps.repo.isEnabled(connectionId))
        this.deps.repo.failed(connectionId, e instanceof Error ? e.message : String(e), now)
      this.waitUntil.set(connectionId, now + HISTORY_BACKOFF_MS)
    } finally {
      release()
      this.busy.delete(connectionId)
    }
  }
}
