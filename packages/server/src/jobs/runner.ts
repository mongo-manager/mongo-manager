// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import { Errors } from '../errors'
import type { JobFilter, JobRepo } from './repo'
import type { JobContext, JobKind, JobKindName, JobRecord, JobTarget } from './types'
import { runAsJobOwner } from './identity'

/** Phase 1h spec §3. These jobs wait on MongoDB, not on this process's CPU. */
export const MAX_PER_CONNECTION = 4
export const MAX_PER_USER = 4
export const MAX_TOTAL = 16
export const KEEP_FINISHED_MS = 7 * 24 * 3600_000
export const MAX_ROWS = 500
/** Changes of one job reach listeners at most this often; the final state is never held back. */
export const COALESCE_MS = 500
const PRUNE_EVERY_MS = 3600_000

interface Live {
  record: JobRecord
  kind: JobKind<unknown>
  params: unknown
  ctx: JobContext
  controller: AbortController
  /** The kind's answer to a cancel under way: the run's outcome waits for it. */
  decision: Promise<void> | null
  /** The kind stopped the operation: however the run ends, the job ends cancelled. */
  cancelled: boolean
  /** Phase 3d-3c (plan ruling 13): started by a schedule, outside the owner's per-user cap. */
  scheduled: boolean
  done: Promise<void>
  lastEmit: number
  timer?: NodeJS.Timeout
}

export interface RunnerDeps {
  repo: JobRepo
  now: () => number
  /** Keeps the connection open while the job runs; returns the release. */
  hold: (connectionId: string) => () => void
  /** Turns a failure into the message stored and shown to the user. */
  describe: (e: unknown) => string
  /** How long a cancel request waits for the job to end before answering (default 5 s). */
  cancelGraceMs?: number
}

/**
 * - cancelled: the job ended cancelled.
 * - finished: it had ended, or ended on its own, before it could be stopped.
 * - pending: told to stop, but not ended within the grace period; it will end cancelled.
 * - not-stopped: it could not be stopped (its operation was not found or could not be killed) and
 *   is still running.
 */
export type CancelOutcome = 'cancelled' | 'finished' | 'pending' | 'not-stopped'

const copy = (r: JobRecord): JobRecord => ({
  ...r,
  progress: r.progress && { ...r.progress },
  ...(r.parts ? { parts: { ...r.parts, items: r.parts.items.map((i) => ({ ...i })) } } : {}),
})

/**
 * Runs background jobs (user request 2026-09-27: long builds and copies must not depend on one HTTP
 * request). The table holds the record of every job; this process holds the running ones.
 */
export class JobRunner {
  private readonly live = new Map<string, Live>()
  private readonly listeners = new Set<(job: JobRecord) => void>()
  private pruner?: NodeJS.Timeout
  /** After close the store may be gone: nothing is written or announced any more. */
  private closed = false

  constructor(private readonly deps: RunnerDeps) {}

  start<P>(kind: JobKind<P>, target: JobTarget, params: P, opts: { scheduled?: boolean } = {}): JobRecord {
    const running = [...this.live.values()].map((l) => l.record)
    // Phase 3d-2: a job on two connections counts on both.
    const connections = [...new Set([target.connectionId, target.targetConnectionId ?? target.connectionId])]
    const on = (id: string) =>
      running.filter((j) => j.connectionId === id || j.targetConnectionId === id).length
    if (connections.some((id) => on(id) >= MAX_PER_CONNECTION)) {
      throw Errors.conflict(
        `${MAX_PER_CONNECTION} jobs are already running on this connection; wait for one to finish`,
      )
    }
    // Phase 3d-3c (plan ruling 13): scheduled jobs neither count against nor are held by the owner's cap.
    const own = [...this.live.values()].filter((l) => !l.scheduled && l.record.userId === target.userId)
    if (!opts.scheduled && own.length >= MAX_PER_USER) {
      throw Errors.conflict(`You already have ${MAX_PER_USER} jobs running; wait for one to finish`)
    }
    if (running.length >= MAX_TOTAL) {
      throw Errors.conflict(`${MAX_TOTAL} jobs are already running on this server; wait for one to finish`)
    }
    const record: JobRecord = {
      id: randomUUID(),
      kind: kind.name,
      ...target,
      targetConnectionId: target.targetConnectionId ?? null,
      state: 'running',
      progress: null,
      estimate: null,
      error: null,
      staging: null,
      stagingConnectionId: null,
      stagingDb: null,
      startedAt: this.deps.now(),
      finishedAt: null,
    }
    this.deps.repo.insert(record)
    const controller = new AbortController()
    const live: Live = {
      record,
      kind: kind as JobKind<unknown>,
      params,
      controller,
      decision: null,
      cancelled: false,
      scheduled: opts.scheduled === true,
      done: Promise.resolve(),
      lastEmit: 0,
      ctx: {
        id: record.id,
        signal: controller.signal,
        comment: `mm-job:${record.id}`,
        target: { ...target, targetConnectionId: target.targetConnectionId ?? null },
        progress: (done, total) => {
          if (record.state !== 'running') return
          record.progress = { done, total }
          this.emit(live, false)
        },
        setStaging: (name, where) => {
          record.staging = name
          record.stagingConnectionId = name && where ? where.connectionId : null
          record.stagingDb = name && where ? where.db : null
          if (!this.closed) this.deps.repo.update(record)
        },
        setEstimate: (count) => {
          record.estimate = count
          if (!this.closed) this.deps.repo.update(record)
          this.emit(live, false)
        },
        setParts: (parts) => {
          if (record.state !== 'running') return
          record.parts = parts
          this.emit(live, false)
        },
      },
    }
    this.live.set(record.id, live)
    const releases = connections.map((id) => this.deps.hold(id))
    const release = () => releases.forEach((r) => r())
    this.emit(live, true)
    live.done = (async () => {
      let failure: { error: unknown } | null = null
      try {
        // W7: the job's own work uses its owner's sign-in (jobs/identity), and only that.
        await runAsJobOwner(record.userId ?? 'local', () => kind.run(live.ctx, params))
      } catch (error) {
        failure = { error }
      }
      try {
        // A build that completes just as its index is dropped reports success: the kind's answer decides.
        await live.decision
        if (live.cancelled) record.state = 'cancelled'
        else if (failure) {
          record.state = 'failed'
          record.error = this.deps.describe(failure.error)
        } else record.state = 'done'
      } finally {
        record.finishedAt = this.deps.now()
        this.live.delete(record.id)
        release()
        this.emit(live, true)
      }
    })()
    return copy(record)
  }

  /**
   * Cancels a running job. 'finished' when it had already ended, or the kind found its operation
   * gone: a finished index or copy is never undone (Review Focus 1). When the kind did stop it, the
   * job ends cancelled even if the run reported success meanwhile.
   */
  async cancel(id: string): Promise<CancelOutcome> {
    const live = this.live.get(id)
    if (!live) return 'finished'
    live.decision ??= (async () => {
      const stopped = await runAsJobOwner(live.ctx.target.userId ?? 'local', () =>
        live.kind.cancel(live.ctx, live.params),
      ).catch(() => false)
      if (stopped) {
        live.cancelled = true
        live.controller.abort()
      }
    })()
    await live.decision
    // Never hold the request for the rest of a long job (final review I3).
    let timer: NodeJS.Timeout | undefined
    const ended = await Promise.race([
      live.done.then(() => true),
      new Promise<false>(
        (resolve) => (timer = setTimeout(() => resolve(false), this.deps.cancelGraceMs ?? 5_000)),
      ),
    ])
    clearTimeout(timer)
    if (!ended) return live.cancelled ? 'pending' : 'not-stopped'
    return live.record.state === 'cancelled' ? 'cancelled' : 'finished'
  }

  get(id: string): JobRecord | undefined {
    const live = this.live.get(id)
    if (live) return copy(live.record)
    return this.deps.repo.get(id)
  }

  /** Newest first; running jobs show their latest progress even between coalesced writes. */
  list(filter: JobFilter = {}): JobRecord[] {
    return this.deps.repo.list(filter).map((r) => {
      const live = this.live.get(r.id)
      return live ? copy(live.record) : r
    })
  }

  /** The staging collection of a finished job was dropped: nothing is left to clean up. */
  forgetStaging(id: string): void {
    const record = this.deps.repo.get(id)
    if (!record || record.state === 'running' || this.closed) return
    record.staging = null
    record.stagingConnectionId = null
    record.stagingDb = null
    this.deps.repo.update(record)
  }

  /** Jobs whose staging collection lives on this connection (phase 3d-2). */
  withStaging(connectionId: string): JobRecord[] {
    return this.deps.repo.withStaging(connectionId)
  }

  runningCount(kind?: JobKindName): number {
    return [...this.live.values()].filter((l) => !kind || l.record.kind === kind).length
  }

  onChange(listener: (job: JobRecord) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Settles the jobs a previous process left running: nobody runs them any more. */
  recover(kinds: Record<JobKindName, JobKind<unknown>>): void {
    for (const record of this.deps.repo.list({ state: 'running' })) {
      if (this.live.has(record.id)) continue
      record.state = kinds[record.kind]?.recover(record) ?? 'interrupted'
      record.finishedAt = this.deps.now()
      this.deps.repo.update(record)
    }
  }

  prune(): void {
    this.deps.repo.prune(this.deps.now() - KEEP_FINISHED_MS, MAX_ROWS)
  }

  /** Prunes now and then hourly, until close(). */
  startMaintenance(): void {
    this.prune()
    this.pruner = setInterval(() => this.prune(), PRUNE_EVERY_MS)
    this.pruner.unref()
  }

  /**
   * Stops writing. Jobs still running keep their `running` row, which the next start settles through
   * `recover` (MongoDB may go on building an index; a copy dies with the client).
   */
  close(): void {
    this.closed = true
    clearInterval(this.pruner)
    for (const live of this.live.values()) clearTimeout(live.timer)
  }

  private emit(live: Live, force: boolean): void {
    if (this.closed) return
    const now = Date.now()
    if (!force && now - live.lastEmit < COALESCE_MS) {
      live.timer ??= setTimeout(
        () => {
          live.timer = undefined
          if (live.record.state === 'running') this.emit(live, true)
        },
        COALESCE_MS - (now - live.lastEmit),
      )
      return
    }
    clearTimeout(live.timer)
    live.timer = undefined
    live.lastEmit = now
    this.deps.repo.update(live.record)
    const snapshot = copy(live.record)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // A listener's bug must not stop the job or the other listeners.
      }
    }
  }
}
