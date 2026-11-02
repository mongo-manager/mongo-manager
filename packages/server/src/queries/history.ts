import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SecretBox } from '../crypto/secret-box'
import { spend, type ByteBudget } from './budget'
import { recentContext, type RecentRow } from './recent'

/** Phase 2c spec §2.1 caps. */
export const MAX_HISTORY_PER_COLLECTION = 200
export const MAX_HISTORY_PER_OWNER = 2000
export const MAX_HISTORY_BYTES = 64 * 1024

export type HistoryKind = 'find' | 'aggregate'

export interface HistoryKey {
  id: string
  user_id: string | null
  connection_id: string
  db: string
  coll: string
  kind: string
}

/** Sealing context: a row copied to another owner, collection or kind no longer opens. */
export const historyContext = (r: HistoryKey) =>
  `history:${JSON.stringify([r.id, r.user_id, r.connection_id, r.db, r.coll, r.kind])}`

/** What finds a repeat: keyed with the secret key, per owner, so equal queries are not visible. */
export const historyHash = (box: SecretBox, r: Omit<HistoryKey, 'id'>, text: string) =>
  box.mac(JSON.stringify([r.user_id, r.connection_id, r.db, r.coll, r.kind, text]))

export interface HistoryEntry {
  id: string
  db: string
  coll: string
  kind: HistoryKind
  body: unknown
  usedAt: number
  count: number
}

const CLEAR_COLUMNS = new Set(['db', 'coll', 'kind'])

type Row = HistoryKey & { body: string; used_at: number; count: number }

/**
 * Phase 2c: every find and aggregation run a user made, owner-only. The body can hold personal
 * data, so it is sealed; repeats are found through a keyed hash. Owner null is local mode's user.
 */
export class QueryHistoryRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  private open(row: Row): unknown {
    try {
      return JSON.parse(this.box.open(row.body, historyContext(row)))
    } catch {
      return undefined // A row that does not open is never shown.
    }
  }

  /** `at` is when it ran (the move keeps the time of each recent query). */
  record(
    owner: string | null,
    connectionId: string,
    dbName: string,
    coll: string,
    kind: HistoryKind,
    body: object,
    at = this.now(),
  ): void {
    const text = JSON.stringify(body)
    if (Buffer.byteLength(text) > MAX_HISTORY_BYTES) return
    const key = { user_id: owner, connection_id: connectionId, db: dbName, coll, kind }
    const hash = historyHash(this.box, key, text)
    // One unit: a failure half way never loses a repeat's row and count (final review 2c, Minor 1).
    // A savepoint also nests inside the move's transaction.
    this.db.exec('SAVEPOINT history_record')
    try {
      this.insert(owner, key, text, hash, at)
      this.db.exec('RELEASE history_record')
    } catch (e) {
      this.db.exec('ROLLBACK TO history_record')
      this.db.exec('RELEASE history_record')
      throw e
    }
  }

  private insert(
    owner: string | null,
    key: Omit<HistoryKey, 'id'>,
    text: string,
    hash: string,
    at: number,
  ): void {
    const { connection_id: connectionId, db: dbName, coll, kind } = key
    // A repeat moves to the top: its row goes and comes back last, keeping the count (the order
    // holds even when two runs share a millisecond).
    const existing = this.db
      .prepare('SELECT id, count FROM query_history WHERE user_id IS ? AND body_hash = ?')
      .get(owner, hash) as { id: string; count: number } | undefined
    if (existing) this.db.prepare('DELETE FROM query_history WHERE id = ?').run(existing.id)
    const row: HistoryKey = { id: randomUUID(), ...key }
    this.db
      .prepare(
        `INSERT INTO query_history (id, user_id, connection_id, db, coll, kind, body, body_hash, used_at, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        owner,
        connectionId,
        dbName,
        coll,
        kind,
        this.box.seal(text, historyContext(row)),
        hash,
        at,
        (existing?.count ?? 0) + 1,
      )
    this.db
      .prepare(
        `DELETE FROM query_history WHERE id IN (
           SELECT id FROM query_history WHERE user_id IS ? AND connection_id = ? AND db = ? AND coll = ?
           ORDER BY used_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
      )
      .run(owner, connectionId, dbName, coll, MAX_HISTORY_PER_COLLECTION)
    this.db
      .prepare(
        `DELETE FROM query_history WHERE id IN (
           SELECT id FROM query_history WHERE user_id IS ? ORDER BY used_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
      )
      .run(owner, MAX_HISTORY_PER_OWNER)
  }

  list(filter: {
    owner: string | null
    connectionId: string
    db?: string
    coll?: string
    kind?: HistoryKind
    limit: number
    /** Collections whose rows are not even opened (credential namespaces for non-admins). */
    excludeColls?: readonly string[]
    /** Databases whose rows are not even opened (the local database for non-admins). */
    excludeDbs?: readonly string[]
    /** Sealed bytes this listing may open; rows past it stay closed. */
    budget?: ByteBudget
  }): HistoryEntry[] {
    const where = ['user_id IS ?', 'connection_id = ?']
    const params: Array<string | number | null> = [filter.owner, filter.connectionId]
    for (const [column, value] of [
      ['db', filter.db],
      ['coll', filter.coll],
      ['kind', filter.kind],
    ] as const) {
      if (value !== undefined) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    if (filter.excludeColls?.length) {
      where.push(`coll NOT IN (${filter.excludeColls.map(() => '?').join(', ')})`)
      params.push(...filter.excludeColls)
    }
    if (filter.excludeDbs?.length) {
      where.push(`db NOT IN (${filter.excludeDbs.map(() => '?').join(', ')})`)
      params.push(...filter.excludeDbs)
    }
    params.push(filter.limit)
    const rows = this.db
      .prepare(
        `SELECT id, user_id, connection_id, db, coll, kind, body, used_at, count FROM query_history
         WHERE ${where.join(' AND ')} ORDER BY used_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as unknown as Row[]
    const out: HistoryEntry[] = []
    for (const row of rows) {
      if (!spend(filter.budget, row.body.length)) break
      const body = this.open(row)
      if (body === undefined) continue
      out.push({
        id: row.id,
        db: row.db,
        coll: row.coll,
        kind: row.kind as HistoryKind,
        body,
        usedAt: row.used_at,
        count: row.count,
      })
    }
    return out
  }

  remove(owner: string | null, id: string): boolean {
    return (
      this.db.prepare('DELETE FROM query_history WHERE id = ? AND user_id IS ?').run(id, owner).changes > 0
    )
  }

  clear(
    owner: string | null,
    connectionId: string,
    where: { db?: string; coll?: string; kind?: HistoryKind } = {},
  ): void {
    const parts = ['user_id IS ?', 'connection_id = ?']
    const params: Array<string | null> = [owner, connectionId]
    for (const [column, value] of Object.entries(where)) {
      // Column names are never taken from the caller (final review 2c, Minor 24).
      if (!CLEAR_COLUMNS.has(column)) throw new Error(`history cannot be cleared by ${column}`)
      if (value === undefined) continue
      parts.push(`${column} = ?`)
      params.push(value)
    }
    this.db.prepare(`DELETE FROM query_history WHERE ${parts.join(' AND ')}`).run(...params)
  }

  /**
   * Team mode has no owner-less user: nobody could see or clear local mode's history there, and it
   * may hold personal data, so it goes when team mode starts. Answers how many rows went.
   */
  forgetLocal(): number {
    return Number(this.db.prepare('DELETE FROM query_history WHERE user_id IS NULL').run().changes)
  }

  /**
   * Phase 2c spec §2.1: the recent queries of phase 1g-1 become history. Rows that open are moved
   * (re-sealed with the history context); rows that do not are dropped. All in one transaction:
   * the old table goes only when everything else succeeded.
   */
  moveRecent(): { moved: number; dropped: number } {
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recent_queries'")
      .get()
    if (!exists) return { moved: 0, dropped: 0 }
    const rows = this.db
      .prepare(
        'SELECT id, user_id, connection_id, db, coll, query, used_at FROM recent_queries ORDER BY used_at, rowid',
      )
      .all() as unknown as Array<RecentRow & { query: string; used_at: number }>
    let moved = 0
    let dropped = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        let body: unknown
        try {
          body = JSON.parse(this.box.open(row.query, recentContext(row)))
        } catch {
          dropped++
          continue
        }
        this.record(row.user_id, row.connection_id, row.db, row.coll, 'find', body as object, row.used_at)
        moved++
      }
      this.db.exec('DROP TABLE recent_queries')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return { moved, dropped }
  }
}
