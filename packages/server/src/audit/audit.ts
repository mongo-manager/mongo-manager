// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { AuditAction } from '@mongo-manager/shared'
import { SettingsRepo } from '../store/settings'
import { transaction } from '../store/db'

const safeEqualText = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const DAY = 86_400_000
/** Phase 4c §2: how long the log is kept; null: for ever (the default). */
const Days = z.number().int().min(30).max(3650).nullable()
/** A change asked for: shortening asks the password in team mode (review I4). */
export const AuditRetentionBody = z.strictObject({ days: Days, password: z.string().max(1024).optional() })
/**
 * As kept: the days, when they take effect (fewer days wait a day — review I4: time to take it back
 * or export first), and the days in force until then.
 */
const StoredRetention = z.strictObject({
  days: Days,
  effectiveAt: z.number().nullable(),
  before: Days.optional(),
})
type StoredRetention = z.infer<typeof StoredRetention>
export interface AuditRetention {
  days: number | null
  effectiveAt: number | null
}
const RETENTION_KEY = 'audit.retention'
/** Fewer days than those in force take effect this long after the change. */
export const RETENTION_GRACE_MS = DAY
/** A purge removes this many entries per transaction, letting other work run between them. */
const PURGE_BATCH = 5000
/** An export reads this many entries at a time (no read cursor held open across a slow download). */
const EXPORT_PAGE = 1000
/** Fewer: null (for ever) is the most. */
const fewer = (a: number | null, b: number | null) => a !== null && (b === null || a < b)

/** The filters of the audit view (and of an export). */
export interface AuditFilter {
  action?: string
  userId?: string
  connectionId?: string
  /** Milliseconds since the epoch, inclusive. */
  from?: number
  to?: number
  /**
   * Design 2026-10-25 (B6): one assistant turn's entries — its tool calls and answers (`ai.*` rows
   * naming the run) and the routes' own rows its calls made (`agent.run`).
   */
  run?: string
}

export type AuditOutcome = 'success' | 'failure' | 'denied'

export interface AuditInput {
  action: AuditAction
  outcome: AuditOutcome
  userId?: string | null
  username?: string | null
  ip?: string | null
  connectionId?: string | null
  namespace?: string | null
  details?: unknown
}

export interface AuditEntry {
  id: number
  at: number
  userId: string | null
  username: string | null
  ip: string | null
  action: string
  connectionId: string | null
  namespace: string | null
  outcome: AuditOutcome
  details: unknown
}

interface Row {
  id: number
  at: number
  user_id: string | null
  username: string | null
  ip: string | null
  action: string
  connection_id: string | null
  namespace: string | null
  outcome: AuditOutcome
  details: string | null
}

const SECRET_KEY = /pass(word)?|secret|token|api.?key|uri|authorization|cookie|private.?key|passphrase|^kit$/i
const MAX_LIMIT = 500

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : redactSecrets(v)]),
    )
  }
  return value
}

const toEntry = (r: Row): AuditEntry => ({
  id: r.id,
  at: r.at,
  userId: r.user_id,
  username: r.username,
  ip: r.ip,
  action: r.action,
  connectionId: r.connection_id,
  namespace: r.namespace,
  outcome: r.outcome,
  details: r.details === null ? null : JSON.parse(r.details),
})

/** The filters as SQL conditions and their values (always bound). */
function where(filter: AuditFilter): { sql: string[]; params: Array<string | number> } {
  const sql: string[] = []
  const params: Array<string | number> = []
  if (filter.action !== undefined) {
    sql.push('action = ?')
    params.push(filter.action)
  }
  if (filter.userId !== undefined) {
    sql.push('user_id = ?')
    params.push(filter.userId)
  }
  if (filter.connectionId !== undefined) {
    sql.push('connection_id = ?')
    params.push(filter.connectionId)
  }
  if (filter.from !== undefined) {
    sql.push('at >= ?')
    params.push(filter.from)
  }
  if (filter.to !== undefined) {
    sql.push('at <= ?')
    params.push(filter.to)
  }
  if (filter.run !== undefined) {
    sql.push(
      "(json_extract(details, '$.agent.run') = ? OR (action LIKE 'ai.%' AND json_extract(details, '$.run') = ?))",
    )
    params.push(filter.run, filter.run)
  }
  return { sql, params }
}

/**
 * Security audit 2026-10-16: the chain. An entry's `chain` is an HMAC (the audit-chain key, see
 * crypto/app-keys) over the chain of the entry before it and the entry's own columns, so an entry
 * changed, removed from the middle or added with the database file in hand no longer checks. The
 * retention purge removes from the oldest end and keeps the chain of the last entry it removed as
 * the anchor the first remaining entry follows. Removing the newest entries, or the oldest along
 * with the anchor, is beyond what a chain kept in the same file can show.
 */
const CHAIN_FN = 'mm_audit_chain'
let chainFns = 0
const ANCHOR_KEY = 'audit_chain_anchor'
/** Where the chain began: `<last entry before it>.<HMAC>` (review of the audit fixes, important 4). */
const CHAIN_START_KEY = 'audit_chain_start'
/** Entries checked between yields to other work (some 10 ms each). */
const CHAIN_PAGE = 500
/** verify() looks at the whole chain again this long after it last did (between, what is new). */
const FULL_CHECK_MS = 3600_000

type ChainColumns = [
  at: number,
  userId: string | null,
  username: string | null,
  ip: string | null,
  action: string,
  connectionId: string | null,
  namespace: string | null,
  outcome: string,
  details: string | null,
]

function chainOf(key: Buffer, prev: string, columns: ChainColumns): string {
  return createHmac('sha256', key)
    .update(`${prev}\n${JSON.stringify(columns)}`)
    .digest('base64url')
}

/** What a check of the chain found: where it broke first, if it did. */
export interface ChainState {
  ok: boolean
  /** The first entry that does not check (changed, or following a removed or added one). */
  brokenAt: { id: number; at: number } | null
  /** Entries checked by this look. */
  checked: number
  /** Entries from before the chain existed (kept as they are). */
  legacy: number
}

interface ChainCursor {
  /** The last entry checked, and its chain. */
  id: number
  prev: string
  legacy: number
  brokenAt: { id: number; at: number } | null
}

export class AuditRepo {
  private readonly settings: SettingsRepo
  /** How far verify() has checked (an incremental look); null until the first. */
  private cursor: ChainCursor | null = null
  /** When verify() last looked at the whole chain. */
  private cursorFrom = 0
  /** One look at a time: a second caller waits for the one running (review of the audit fixes, I5). */
  private looking: Promise<ChainState> | null = null

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    /** The audit-chain key (crypto/app-keys). */
    private readonly key: Buffer,
    /** The key was made by this start: the chain begins now, after the entries already kept. */
    opts: { keyCreated?: boolean } = {},
  ) {
    this.settings = new SettingsRepo(db, now)
    // The insert computes its chain inside one statement, under the write lock: an admin command
    // writing beside the server never forks the chain. A name of its own: another repo on the same
    // connection never swaps the key under this one.
    this.chainFn = `${CHAIN_FN}_${++chainFns}`
    db.function(this.chainFn, { deterministic: true, varargs: true }, (...args) =>
      chainOf(this.key, String(args[0] ?? ''), args.slice(1) as unknown as ChainColumns),
    )
    // Review of the audit fixes (important 4): where the chain began, kept under the key — entries up
    // to it are from before the chain; an unchained one after it is a break, whatever else is NULL.
    // Made with the key, or for an empty log; never again for a log the key already chained.
    if (!this.chainStart.read()) {
      const max = (db.prepare('SELECT MAX(id) AS id FROM audit_log').get() as { id: number | null }).id ?? 0
      if (max === 0 || opts.keyCreated) this.chainStart.write(max)
      else {
        // Second review (minor 1): a key made by a build before this record (or a record lost). It is
        // made once, where the chain does begin — before its first chained entry — and the log says
        // so; an unchained entry after it is still a break.
        const first = (
          db.prepare('SELECT MIN(id) AS id FROM audit_log WHERE chain IS NOT NULL').get() as {
            id: number | null
          }
        ).id
        const legacyMax = first === null ? max : first - 1
        this.chainStart.write(legacyMax)
        this.append({
          action: 'audit.chain.started',
          outcome: 'success',
          details: { legacyMax, reason: 'record_missing' },
        })
      }
    }
  }

  /** Bumped by every purge: a look that yielded meanwhile starts again (second review, N1). */
  private generation = 0

  private readonly chainFn: string

  private readonly chainStart = {
    mac: (id: number) => createHmac('sha256', this.key).update(`chain-start|${id}`).digest('base64url'),
    read: (): string | undefined =>
      (
        this.db.prepare('SELECT value FROM settings WHERE key = ?').get(CHAIN_START_KEY) as
          { value: string } | undefined
      )?.value,
    write: (id: number) =>
      this.db
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run(CHAIN_START_KEY, `${id}.${this.chainStart.mac(id)}`),
    /** The last entry from before the chain, or null when the record is missing or not ours. */
    legacyMax: (): number | null => {
      const [id, mac] = (this.chainStart.read() ?? '').split('.')
      const n = Number(id)
      return Number.isInteger(n) && n >= 0 && mac && safeEqualText(mac, this.chainStart.mac(n)) ? n : null
    },
  }

  private anchor(): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(ANCHOR_KEY) as
      { value: string } | undefined
    return row?.value ?? ''
  }

  /**
   * Checks entries after the cursor (all of them the first time), oldest first, a page at a time,
   * letting other work run between pages (review of the audit fixes, important 5).
   */
  private async walk(from: ChainCursor): Promise<ChainCursor & { checked: number; generation: number }> {
    let generation = this.generation
    let state = { ...from, checked: 0, generation }
    const legacyMax = this.chainStart.legacyMax()
    const page = this.db.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id LIMIT ?')
    for (;;) {
      // Second review (N1): the purge removed entries while this look let other work run — the next
      // entry may follow one now gone: the look starts again from the anchor the purge kept.
      if (generation !== this.generation) {
        generation = this.generation
        state = { ...this.start(), checked: 0, generation }
      }
      const rows = page.all(state.id, CHAIN_PAGE) as unknown as Array<Row & { chain: string | null }>
      for (const r of rows) {
        state.checked++
        state.id = r.id
        if (state.brokenAt) continue
        // Without the record of where the chain began, nothing can be told apart: a break.
        if (legacyMax === null) {
          state.brokenAt = { id: r.id, at: r.at }
          continue
        }
        if (r.chain === null) {
          // Before the chain: taken as it is — but never after where it began.
          if (r.id > legacyMax) state.brokenAt = { id: r.id, at: r.at }
          else {
            state.legacy++
            state.prev = ''
          }
          continue
        }
        const expected = chainOf(this.key, state.prev, [
          r.at,
          r.user_id,
          r.username,
          r.ip,
          r.action,
          r.connection_id,
          r.namespace,
          r.outcome,
          r.details,
        ])
        if (!safeEqualText(expected, r.chain)) state.brokenAt = { id: r.id, at: r.at }
        state.prev = r.chain
      }
      if (rows.length < CHAIN_PAGE) return state
      await new Promise((r) => setImmediate(r))
    }
  }

  private start(): ChainCursor {
    return { id: 0, prev: this.anchor(), legacy: 0, brokenAt: null }
  }

  /** The whole chain, from the oldest entry (tests, and verify() once an hour). */
  async verifyAll(): Promise<ChainState> {
    const s = await this.walk(this.start())
    return { ok: s.brokenAt === null, brokenAt: s.brokenAt, checked: s.checked, legacy: s.legacy }
  }

  /**
   * The chain as far as it is new since the last look (the audit page and every export ask), and
   * the whole of it again at most once an hour; a break, once found, is kept until the purge removes
   * entries (review of the audit fixes, minor 5). One look at a time: callers meanwhile share it, so
   * asking often never costs more than one walk (important 5).
   */
  verify(): Promise<ChainState> {
    this.looking ??= this.look().finally(() => (this.looking = null))
    return this.looking
  }

  private async look(): Promise<ChainState> {
    const fresh = this.cursor && this.now() - this.cursorFrom < FULL_CHECK_MS
    if (!fresh) this.cursorFrom = this.now()
    const startedAt = this.generation
    const s = await this.walk(fresh ? this.cursor! : this.start())
    // A break kept from before a purge that came meanwhile is not kept (second review, N1).
    const kept = fresh && s.generation === startedAt ? (this.cursor?.brokenAt ?? null) : null
    const brokenAt = kept ?? s.brokenAt
    // Saved only for the log as it is now: a purge since the walk ended leaves it to the next look.
    if (s.generation === this.generation) this.cursor = { id: s.id, prev: s.prev, legacy: s.legacy, brokenAt }
    return { ok: brokenAt === null, brokenAt, checked: s.checked, legacy: s.legacy }
  }

  private stored(): StoredRetention {
    return this.settings.get(RETENTION_KEY, StoredRetention, { days: null, effectiveAt: null })
  }

  retention(): AuditRetention {
    const { days, effectiveAt } = this.stored()
    return { days, effectiveAt }
  }

  /** The days the purge uses now: the new ones once in effect, those before until then. */
  private inForce(): number | null {
    const s = this.stored()
    return s.effectiveAt !== null && this.now() < s.effectiveAt ? (s.before ?? null) : s.days
  }

  /** Whether these days are fewer than those in force (asks the password; waits a day). */
  shortens(days: number | null): boolean {
    return fewer(days, this.inForce())
  }

  setRetention(days: number | null): AuditRetention {
    const inForce = this.inForce()
    const next: StoredRetention = fewer(days, inForce)
      ? { days, effectiveAt: this.now() + RETENTION_GRACE_MS, before: inForce }
      : { days, effectiveAt: days === null ? null : this.now() }
    this.settings.set(RETENTION_KEY, next)
    return this.retention()
  }

  /** How many entries are older than these days (asked before shortening). */
  countOlderThan(days: number): number {
    const before = this.now() - days * DAY
    return (this.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE at < ?').get(before) as { n: number })
      .n
  }

  /**
   * Phase 4c §2: removes the entries past the days kept, through the gate the delete trigger
   * allows (opened and closed within one transaction); the purge is itself kept. How many went.
   */
  async sweep(): Promise<number> {
    const days = this.inForce()
    if (days === null) return 0
    const before = this.now() - days * DAY
    // Security audit 2026-10-16: from the oldest end only (the entries before the first one still
    // kept), so the chain stays whole; the chain of the last entry removed becomes its anchor. An
    // older entry behind a newer one (a clock set back) waits for the next purge.
    const first = this.db
      .prepare('SELECT id FROM audit_log WHERE at >= ? ORDER BY id LIMIT 1')
      .get(before) as { id: number } | undefined
    // Review of the audit fixes (minor 4): with everything past its days, up to the newest entry now
    // — never one written while the purge runs.
    const newest = (this.db.prepare('SELECT MAX(id) AS id FROM audit_log').get() as { id: number | null }).id
    const cut = first?.id ?? (newest ?? 0) + 1
    // Review M2: in batches, each its own gated transaction, other work running between them.
    let removed = 0
    for (;;) {
      // Second review (N1): a look under way starts again (it yields between pages, as this does).
      this.generation++
      const n = transaction(this.db, () => {
        const batch = this.db
          .prepare('SELECT id, chain FROM audit_log WHERE id < ? ORDER BY id LIMIT ?')
          .all(cut, PURGE_BATCH) as Array<{ id: number; chain: string | null }>
        const last = batch.at(-1)
        if (!last) return 0
        this.db.prepare('DELETE FROM audit_purge').run()
        this.db.prepare('INSERT INTO audit_purge (before) VALUES (?)').run(before)
        const changes = Number(this.db.prepare('DELETE FROM audit_log WHERE id <= ?').run(last.id).changes)
        this.db.prepare('DELETE FROM audit_purge').run()
        this.db
          .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
          .run(ANCHOR_KEY, last.chain ?? '')
        return changes
      })
      removed += n
      if (n < PURGE_BATCH) break
      await new Promise((r) => setImmediate(r))
    }
    // Review of the audit fixes (minor 5): the next look starts again from the anchor.
    if (removed > 0) this.cursor = null
    if (removed > 0)
      this.append({
        action: 'audit.retention',
        outcome: 'success',
        details: { removed, before: new Date(before).toISOString(), days },
      })
    return removed
  }

  /**
   * Phase 4c §1: every entry matching the filters, oldest first, a page at a time (review M3: no read
   * cursor stays open across a slow download).
   */
  *each(filter: AuditFilter): Generator<AuditEntry> {
    const w = where(filter)
    const sql = `SELECT * FROM audit_log WHERE ${[...w.sql, 'id > ?'].join(' AND ')} ORDER BY id LIMIT ?`
    let after = 0
    for (;;) {
      const rows = this.db.prepare(sql).all(...w.params, after, EXPORT_PAGE) as unknown as Row[]
      for (const r of rows) yield toEntry(r)
      if (rows.length < EXPORT_PAGE) return
      after = rows.at(-1)!.id
    }
  }

  /**
   * An entry written with the user's id alone (by a background job) still says who it was about: an
   * export, read without the users table, names them (found by the e2e of the 4c export).
   */
  private usernameOf(userId: string | null | undefined): string | null {
    if (!userId) return null
    const row = this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as
      { username: string } | undefined
    return row?.username ?? null
  }

  append(input: AuditInput): void {
    // The chain of the newest entry ('' for one from before the chain); with none left, the anchor
    // the purge kept.
    this.db
      .prepare(
        `INSERT INTO audit_log (at, user_id, username, ip, action, connection_id, namespace, outcome, details, chain)
         SELECT :at, :user, :name, :ip, :action, :conn, :ns, :outcome, :details,
           ${this.chainFn}(
             COALESCE(
               (SELECT COALESCE(chain, '') FROM audit_log ORDER BY id DESC LIMIT 1),
               (SELECT value FROM settings WHERE key = '${ANCHOR_KEY}'),
               ''),
             :at, :user, :name, :ip, :action, :conn, :ns, :outcome, :details)`,
      )
      .run({
        at: this.now(),
        user: input.userId ?? null,
        name: input.username ?? this.usernameOf(input.userId),
        ip: input.ip ?? null,
        action: input.action,
        conn: input.connectionId ?? null,
        ns: input.namespace ?? null,
        outcome: input.outcome,
        details: input.details === undefined ? null : JSON.stringify(redactSecrets(input.details)),
      })
  }

  list(filter: AuditFilter & { limit?: number; beforeId?: number }): AuditEntry[] {
    const w = where(filter)
    if (filter.beforeId !== undefined) {
      w.sql.unshift('id < ?')
      w.params.unshift(filter.beforeId)
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), MAX_LIMIT)
    const sql = `SELECT * FROM audit_log ${w.sql.length ? `WHERE ${w.sql.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    return (this.db.prepare(sql).all(...w.params, limit) as unknown as Row[]).map(toEntry)
  }
}
