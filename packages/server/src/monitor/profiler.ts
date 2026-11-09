// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync } from 'node:sqlite'
import type { MongoClient } from 'mongodb'
import type { AuditInput } from '../audit/audit'
import { redactUris } from '../connections/errors'

/** Phase 3b spec §3.1. */
export const REVERT_AFTER_MS = 30 * 60_000
export const RETRY_MS = 60_000
export const MAX_CHANGES_PER_MINUTE = 10

export interface ProfilerSettings {
  level: 0 | 1 | 2
  slowms: number
  sampleRate: number
}

export interface PendingRevert {
  connectionId: string
  db: string
  previous: ProfilerSettings
  deadline: number
  attempts: number
  lastError: string | null
  /** The replica-set member the change was made on (the profiler is per member); null on a standalone. */
  member: string | null
}

export async function readProfiler(client: MongoClient, db: string): Promise<ProfilerSettings> {
  const r = await client.db(db).command({ profile: -1 })
  const level = r.was === 1 || r.was === 2 ? r.was : 0
  return { level, slowms: Number(r.slowms ?? 100), sampleRate: Number(r.sampleRate ?? 1) }
}

export async function writeProfiler(client: MongoClient, db: string, s: ProfilerSettings): Promise<void> {
  await client.db(db).command({ profile: s.level, slowms: s.slowms, sampleRate: s.sampleRate })
}

/** The member a client talks to (hello.me), or null on a standalone. */
export async function memberOf(client: MongoClient): Promise<string | null> {
  const hello = await client.db('admin').command({ hello: 1 })
  return typeof hello.me === 'string' ? hello.me.slice(0, 256) : null
}

type Row = {
  connection_id: string
  db: string
  previous: string
  deadline: number
  attempts: number
  last_error: string | null
  member: string | null
}
const toPending = (r: Row): PendingRevert => ({
  connectionId: r.connection_id,
  db: r.db,
  previous: JSON.parse(r.previous) as ProfilerSettings,
  deadline: r.deadline,
  attempts: r.attempts,
  lastError: r.last_error,
  member: r.member,
})

/**
 * The reverts waiting to run, one per (connection, database); stored so a restart keeps them. The
 * route and the reverter change a database's profiler only inside `exclusive`, so a revert and a
 * manual change never overwrite each other (final review I3).
 */
export class ProfilerReverts {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly db: DatabaseSync) {}

  /** Runs `work` after every earlier piece of work on the same (connection, database). */
  exclusive<T>(connectionId: string, db: string, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([connectionId, db])
    const before = this.locks.get(key) ?? Promise.resolve()
    const run = before.then(work, work)
    const settled = run.catch(() => undefined)
    this.locks.set(key, settled)
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key)
    })
    return run
  }

  /** A second level 2 moves the deadline; the caller passes the settings from before the first. */
  schedule(
    connectionId: string,
    db: string,
    previous: ProfilerSettings,
    deadline: number,
    member: string | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO profiler_reverts (connection_id, db, previous, deadline, member) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (connection_id, db) DO UPDATE SET previous = excluded.previous,
           deadline = excluded.deadline, member = excluded.member, attempts = 0, last_error = NULL`,
      )
      .run(connectionId, db, JSON.stringify(previous), deadline, member)
  }

  /** Puts back a pending revert exactly as it was (a change that failed half-way). */
  restore(r: PendingRevert): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO profiler_reverts (connection_id, db, previous, deadline, attempts, last_error, member)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.connectionId, r.db, JSON.stringify(r.previous), r.deadline, r.attempts, r.lastError, r.member)
  }

  cancel(connectionId: string, db: string): void {
    this.db.prepare('DELETE FROM profiler_reverts WHERE connection_id = ? AND db = ?').run(connectionId, db)
  }

  get(connectionId: string, db: string): PendingRevert | null {
    const row = this.db
      .prepare('SELECT * FROM profiler_reverts WHERE connection_id = ? AND db = ?')
      .get(connectionId, db) as Row | undefined
    return row ? toPending(row) : null
  }

  due(now: number): PendingRevert[] {
    const rows = this.db
      .prepare('SELECT * FROM profiler_reverts WHERE deadline <= ? ORDER BY deadline')
      .all(now) as unknown as Row[]
    return rows.map(toPending)
  }

  pending(connectionId: string): PendingRevert[] {
    const rows = this.db
      .prepare('SELECT * FROM profiler_reverts WHERE connection_id = ? ORDER BY db')
      .all(connectionId) as unknown as Row[]
    return rows.map(toPending)
  }

  /** A revert that could not run: tried again at `next`. Connection strings never reach the row. */
  failed(connectionId: string, db: string, error: string, next: number): void {
    this.db
      .prepare(
        `UPDATE profiler_reverts SET attempts = attempts + 1, last_error = ?, deadline = ?
         WHERE connection_id = ? AND db = ?`,
      )
      .run(redactUris(error).slice(0, 500), next, connectionId, db)
  }
}

export interface ReverterDeps {
  reverts: ProfilerReverts
  client: (connectionId: string) => Promise<MongoClient>
  hold: (connectionId: string) => () => void
  audit: (entry: AuditInput) => void
  now: () => number
  intervalMs?: number
}

/**
 * Applies due reverts: once at start-up (a restart never leaves level 2 on) and then every
 * interval. A revert that fails stays pending and is tried again a minute later; one due on
 * another replica-set member than the one the connection now reaches waits (final review M4).
 */
export class ProfilerReverter {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(private readonly deps: ReverterDeps) {}

  start(): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? RETRY_MS)
    this.timer.unref?.()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const due of this.deps.reverts.due(this.deps.now()))
        await this.deps.reverts.exclusive(due.connectionId, due.db, () => this.revert(due))
    } finally {
      this.running = false
    }
  }

  private async revert(due: PendingRevert): Promise<void> {
    const { reverts } = this.deps
    // A manual change may have come first: only the revert still stored, unchanged, runs.
    const r = reverts.get(due.connectionId, due.db)
    if (!r || r.deadline !== due.deadline) return
    const release = this.deps.hold(r.connectionId)
    try {
      const client = await this.deps.client(r.connectionId)
      if (r.member) {
        const member = await memberOf(client)
        if (member !== r.member) {
          reverts.failed(
            r.connectionId,
            r.db,
            `waiting for member ${r.member} (the connection reaches ${member ?? 'a standalone'})`,
            this.deps.now() + RETRY_MS,
          )
          return
        }
      }
      await writeProfiler(client, r.db, r.previous)
      reverts.cancel(r.connectionId, r.db)
      this.deps.audit({
        action: 'server.profiler',
        outcome: 'success',
        userId: null,
        connectionId: r.connectionId,
        namespace: r.db,
        details: { db: r.db, next: r.previous, reason: 'auto-revert' },
      })
    } catch (e) {
      reverts.failed(
        r.connectionId,
        r.db,
        e instanceof Error ? e.message : String(e),
        this.deps.now() + RETRY_MS,
      )
    } finally {
      release()
    }
  }
}

/** At most MAX_CHANGES_PER_MINUTE changes per connection in any minute. */
export class ChangeLimiter {
  private readonly times = new Map<string, number[]>()

  constructor(private readonly now: () => number) {}

  take(connectionId: string): boolean {
    const now = this.now()
    const recent = (this.times.get(connectionId) ?? []).filter((t) => now - t < 60_000)
    const allowed = recent.length < MAX_CHANGES_PER_MINUTE
    if (allowed) recent.push(now)
    if (recent.length > 0) this.times.set(connectionId, recent)
    else this.times.delete(connectionId)
    return allowed
  }
}
