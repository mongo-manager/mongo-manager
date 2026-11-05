// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { EJSON, Timestamp } from 'bson'
import {
  FINAL_STATES,
  LIVE_SYNC_LIMITS,
  RUNNING_STATES,
  ZERO_COUNTERS,
  type ErrorPolicy,
  type LiveSyncCounters,
  type LiveSyncEvent,
  type LiveSyncReason,
  type LiveSyncState,
  type LiveSyncVerify,
  type StartMode,
} from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'
import type { DeploymentId } from '../transfer/same-deployment'

/** A cluster time as text, "t.i": stored and compared without BSON. */
export const tsText = (ts: Timestamp): string => `${ts.t}.${ts.i}`
/**
 * Final review I4: the cluster time a resume token stands for ("t.i"), or null. MongoDB's `_data`
 * starts with the timestamp's KeyString: "82", then t and i as 8 hex digits each.
 */
export function tokenTime(token: unknown): string | null {
  const data = (token as { _data?: unknown } | null)?._data
  if (typeof data !== 'string' || !/^82[0-9A-Fa-f]{16}/.test(data)) return null
  return `${parseInt(data.slice(2, 10), 16)}.${parseInt(data.slice(10, 18), 16)}`
}
export function tsFrom(text: string): Timestamp {
  const [t, i] = text.split('.').map(Number)
  return new Timestamp({ t: t ?? 0, i: i ?? 0 })
}
export function tsCompare(a: string, b: string): number {
  const [at, ai] = a.split('.').map(Number) as [number, number]
  const [bt, bi] = b.split('.').map(Number) as [number, number]
  return at !== bt ? at - bt : ai - bi
}

export interface LiveSyncOptions {
  startMode: StartMode
  errorPolicy: ErrorPolicy
  followNew: boolean
  anonymous: boolean
  /** Written masked: the owner was restricted on the source at create, or it is anonymous. */
  masked: boolean
  /** [source, target] collection names; a database sync of "all" lists those at create, and followed ones join. */
  pairs: Array<[string, string]>
  /** New source collections not followed (encrypted, a validator running JavaScript, a time series). */
  ignored?: string[]
  /** W4.6: a filtered collection sync's filter, as checked at its plan (canonical EJSON). */
  filter?: Record<string, unknown>
  /**
   * W4.6: one direction of a two-way sync — its partner (the other direction), which side it is,
   * the session ids its writes carried (their echoes are skipped), and the changes that lost
   * (a hash of the `_id` → the change's wall time; bounded) so a batch read again does not revive them.
   */
  twoWay?: { partner: string; side: 'forward' | 'reverse'; echo: string[]; lost: Record<string, number> }
  /** W4.6: a scheduled sync's start (ms), and what its owner confirmed for it at create. */
  scheduledAt?: number
  confirmed?: {
    confirmOverwrite: boolean
    confirmOplog: boolean
    confirmTtl: boolean
    confirmPersonal: boolean
    confirmTarget?: string
  }
}

/** What the owner confirmed: rule versions, connection settings hashes, the deployments. */
export interface LiveSyncStamps {
  versions: { source: number; target: number }
  settings: { source: string; target: string }
  /** Both sides' deployments (final review I6: compared as deployments, never as text). */
  deployments: { source: DeploymentId; target: DeploymentId }
  /** Final review I9: each target collection's UUID once seen ("db.coll" → hex): a drop is noticed. */
  targets?: Record<string, string>
}

export interface LiveSyncRecord {
  id: string
  owner: string
  name: string
  source: { connectionId: string; db: string; coll: string | null; collections: string[] | null }
  target: { connectionId: string; db: string; coll: string | null }
  options: LiveSyncOptions
  stamps: LiveSyncStamps
  state: LiveSyncState
  reason: LiveSyncReason | null
  detail: string | null
  pausedBy: string | null
  /** Spec §1.3: the source's cluster time before the copy ("t.i"). */
  startAt: string | null
  /** The cluster time of the last change applied ("t.i"). */
  placeTime: string | null
  copyJobId: string | null
  /** When the initial copy finished: a sync with a copy job and none never resumes (plan ruling 1). */
  copiedAt: number | null
  counters: LiveSyncCounters
  /**
   * Plan ruling 11: the document a write error stopped on (`armed: false`), or one to skip once
   * (`armed: true`), by `_id` (canonical EJSON text) and cluster time.
   */
  skip: { id: string; at: string; armed: boolean; ns?: string } | null
  verify: LiveSyncVerify | null
  /** Spec §1.6: the cutover's moment (cluster time and wall clock) and whether it verifies. */
  finish: { t1: string; at: number; verify: boolean } | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

export type NewLiveSync = Pick<
  LiveSyncRecord,
  'owner' | 'name' | 'source' | 'target' | 'options' | 'stamps' | 'state' | 'startAt' | 'copyJobId'
>

interface Row {
  id: string
  owner: string
  name: string
  source_connection_id: string
  source_db: string
  source_coll: string | null
  source_collections: string | null
  target_connection_id: string
  target_db: string
  target_coll: string | null
  options: string
  stamps: string
  state: LiveSyncState
  reason: LiveSyncReason | null
  detail: string | null
  paused_by: string | null
  start_at: string | null
  place: string | null
  place_time: string | null
  copy_job_id: string | null
  copied_at: number | null
  counters: string
  skip: string | null
  verify: string | null
  finish: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

const json = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T))

function toRecord(r: Row): LiveSyncRecord {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    source: {
      connectionId: r.source_connection_id,
      db: r.source_db,
      coll: r.source_coll,
      collections: json<string[]>(r.source_collections),
    },
    target: { connectionId: r.target_connection_id, db: r.target_db, coll: r.target_coll },
    options: JSON.parse(r.options) as LiveSyncOptions,
    stamps: JSON.parse(r.stamps) as LiveSyncStamps,
    state: r.state,
    reason: r.reason,
    detail: r.detail,
    pausedBy: r.paused_by,
    startAt: r.start_at,
    placeTime: r.place_time,
    copyJobId: r.copy_job_id,
    copiedAt: r.copied_at,
    counters: { ...ZERO_COUNTERS, ...(JSON.parse(r.counters) as Partial<LiveSyncCounters>) },
    skip: json(r.skip),
    verify: json(r.verify),
    finish: json(r.finish),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  }
}

/** The seal's context: a place opens only as its own sync's (key rotation re-seals with it). */
export const placeContext = (id: string) => `live-sync:${id}`

/** Phase 3e-2 spec §2.2: live syncs, their sealed place and their activity log. */
export class LiveSyncRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  create(input: NewLiveSync): LiveSyncRecord {
    const id = randomUUID()
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO live_syncs (id, owner, name, source_connection_id, source_db, source_coll,
          source_collections, target_connection_id, target_db, target_coll, options, stamps, state,
          start_at, copy_job_id, counters, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.owner,
        input.name,
        input.source.connectionId,
        input.source.db,
        input.source.coll,
        input.source.collections === null ? null : JSON.stringify(input.source.collections),
        input.target.connectionId,
        input.target.db,
        input.target.coll,
        JSON.stringify(input.options),
        JSON.stringify(input.stamps),
        input.state,
        input.startAt,
        input.copyJobId,
        JSON.stringify(ZERO_COUNTERS),
        at,
        at,
      )
    return this.get(id)!
  }

  get(id: string): LiveSyncRecord | undefined {
    const row = this.db.prepare('SELECT * FROM live_syncs WHERE id = ?').get(id) as Row | undefined
    return row ? toRecord(row) : undefined
  }

  /** One owner's syncs, or every sync; newest first. */
  list(owner?: string): LiveSyncRecord[] {
    const rows = (owner === undefined
      ? this.db.prepare('SELECT * FROM live_syncs ORDER BY created_at DESC').all()
      : this.db
          .prepare('SELECT * FROM live_syncs WHERE owner = ? ORDER BY created_at DESC')
          .all(owner)) as unknown as Row[]
    return rows.map(toRecord)
  }

  listRunning(): LiveSyncRecord[] {
    const marks = RUNNING_STATES.map(() => '?').join(', ')
    return (
      this.db
        .prepare(`SELECT * FROM live_syncs WHERE state IN (${marks})`)
        .all(...RUNNING_STATES) as unknown as Row[]
    ).map(toRecord)
  }

  /** Plan ruling 5: syncs that are not final, of one owner or of the server. */
  countActive(owner?: string): number {
    const marks = FINAL_STATES.map(() => '?').join(', ')
    const row = (
      owner === undefined
        ? this.db
            .prepare(`SELECT COUNT(*) AS n FROM live_syncs WHERE state NOT IN (${marks})`)
            .get(...FINAL_STATES)
        : this.db
            .prepare(`SELECT COUNT(*) AS n FROM live_syncs WHERE owner = ? AND state NOT IN (${marks})`)
            .get(owner, ...FINAL_STATES)
    ) as { n: number }
    return row.n
  }

  setState(
    id: string,
    state: LiveSyncState,
    reason: LiveSyncReason | null = null,
    detail: string | null = null,
    pausedBy: string | null = null,
  ): LiveSyncRecord {
    const at = this.now()
    const final = (FINAL_STATES as readonly string[]).includes(state)
    this.db
      .prepare(
        `UPDATE live_syncs SET state = ?, reason = ?, detail = ?, paused_by = ?, updated_at = ?,
          finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`,
      )
      .run(state, reason, detail === null ? null : detail.slice(0, 500), pausedBy, at, final ? 1 : 0, at, id)
    return this.get(id)!
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        LiveSyncRecord,
        | 'copyJobId'
        | 'copiedAt'
        | 'startAt'
        | 'skip'
        | 'verify'
        | 'finish'
        | 'stamps'
        | 'counters'
        | 'options'
      >
    >,
  ): LiveSyncRecord {
    const columns: Record<string, string> = {
      copyJobId: 'copy_job_id',
      copiedAt: 'copied_at',
      startAt: 'start_at',
      skip: 'skip',
      verify: 'verify',
      finish: 'finish',
      stamps: 'stamps',
      counters: 'counters',
      options: 'options',
    }
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key]!
      const text =
        value === null || typeof value === 'number' || typeof value === 'string'
          ? value
          : JSON.stringify(value)
      this.db
        .prepare(`UPDATE live_syncs SET ${column} = ?, updated_at = ? WHERE id = ?`)
        .run(text, this.now(), id)
    }
    return this.get(id)!
  }

  /** Spec §1.4: the place after a batch the target acknowledged, sealed (S7), with the counters. */
  savePlace(id: string, place: { token: unknown; time: string }, counters: LiveSyncCounters): void {
    const sealed = this.box.seal(EJSON.stringify(place.token, { relaxed: false }), placeContext(id))
    this.db
      .prepare('UPDATE live_syncs SET place = ?, place_time = ?, counters = ?, updated_at = ? WHERE id = ?')
      .run(sealed, place.time, JSON.stringify(counters), this.now(), id)
  }

  place(id: string): { token: unknown; time: string } | null {
    const row = this.db.prepare('SELECT place, place_time FROM live_syncs WHERE id = ?').get(id) as
      { place: string | null; place_time: string | null } | undefined
    if (!row?.place || !row.place_time) return null
    return {
      token: EJSON.parse(this.box.open(row.place, placeContext(id)), { relaxed: false }),
      time: row.place_time,
    }
  }

  /** The activity log: the last LIVE_SYNC_LIMITS.logRows events per sync. */
  log(id: string, event: LiveSyncEvent): void {
    this.db
      .prepare('INSERT INTO live_sync_events (sync_id, at, data) VALUES (?, ?, ?)')
      .run(id, event.at, JSON.stringify(event))
    this.db
      .prepare(
        `DELETE FROM live_sync_events WHERE sync_id = ? AND id NOT IN
          (SELECT id FROM live_sync_events WHERE sync_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(id, id, LIVE_SYNC_LIMITS.logRows)
  }

  events(id: string): LiveSyncEvent[] {
    return (
      this.db.prepare('SELECT data FROM live_sync_events WHERE sync_id = ? ORDER BY id').all(id) as Array<{
        data: string
      }>
    ).map((r) => JSON.parse(r.data) as LiveSyncEvent)
  }

  /**
   * W4.6: the lag history — the largest lag of each 10 s bucket, a day back at most (8,640 rows a
   * sync), so a chart survives a reload and a restart.
   */
  sampleLag(id: string, at: number, lagMs: number): void {
    const bucket = Math.floor(at / LAG_BUCKET_MS) * LAG_BUCKET_MS
    this.db
      .prepare(
        `INSERT INTO live_sync_lag (sync_id, at, lag_ms) VALUES (?, ?, ?)
         ON CONFLICT (sync_id, at) DO UPDATE SET lag_ms = MAX(lag_ms, excluded.lag_ms)`,
      )
      .run(id, bucket, Math.max(0, Math.round(lagMs)))
    this.db.prepare('DELETE FROM live_sync_lag WHERE sync_id = ? AND at <= ?').run(id, bucket - LAG_KEPT_MS)
  }

  /** The lag since `since`, merged into at most `points` spans (each keeps its largest lag). */
  lagHistory(id: string, since: number, points = 360): Array<{ at: number; lag: number }> {
    const rows = this.db
      .prepare('SELECT at, lag_ms FROM live_sync_lag WHERE sync_id = ? AND at >= ? ORDER BY at')
      .all(id, since) as Array<{ at: number; lag_ms: number }>
    if (rows.length <= points) return rows.map((r) => ({ at: r.at, lag: r.lag_ms }))
    const first = rows[0]!.at
    const span = Math.ceil((rows.at(-1)!.at - first + LAG_BUCKET_MS) / points)
    const out: Array<{ at: number; lag: number }> = []
    for (const r of rows) {
      const at = first + Math.floor((r.at - first) / span) * span
      const last = out.at(-1)
      if (last?.at === at) last.lag = Math.max(last.lag, r.lag_ms)
      else out.push({ at, lag: r.lag_ms })
    }
    return out
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM live_syncs WHERE id = ?').run(id)
  }
}

/** W4.6: the lag history's buckets and how long they are kept. */
export const LAG_BUCKET_MS = 10_000
export const LAG_KEPT_MS = 24 * 3600_000
