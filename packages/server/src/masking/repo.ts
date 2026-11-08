// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { PersonalRulesBodySchema, type PersonalRule } from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'

/** The AAD of a connection's sealed rule list: a row copied to another connection does not open. */
export const personalFieldsContext = (connectionId: string): string =>
  `personal-fields:${JSON.stringify([connectionId])}`

/** Phase 3b spec §2.1: one sealed rule list per connection. */
export class PersonalFieldsRepo {
  /** How many rules a connection has, at a version: read without opening the rules again. */
  private readonly counts = new Map<string, { version: number; count: number }>()
  /** Read on every request of the local user: prepared once (review 2026-10-13, M8). */
  private localRow?: StatementSync
  /** Read on every request of a team member: prepared once. */
  private selfRow?: StatementSync
  /**
   * W4 review C1: rules a restore drill gives its scratch database while it exists, by connection
   * and scratch database. Kept in memory, never stored: the rules page shows what the admins set, and
   * the rules' version (which masked backups, live syncs and AI turns are bound to) does not move —
   * these rules only cover a scratch database no one may open anyway.
   */
  private readonly scratch = new Map<string, Map<string, PersonalRule[]>>()
  /**
   * W4 re-review C1: moves on every change of a connection's scratch rules, so a compiled masker
   * (cached by the rules' version, which these rules leave alone) is compiled again.
   */
  private scratchGeneration = 0

  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  /**
   * The rules and their version: when they last changed, strictly increasing on every save (so a
   * compiled masker is never reused across two saves in one millisecond); 0 when never set. A row
   * that does not open throws.
   */
  get(connectionId: string): { rules: PersonalRule[]; version: number; scratch: number } {
    const own = this.stored(connectionId)
    const extra = this.scratch.get(connectionId)
    return {
      rules: extra ? [...own.rules, ...[...extra.values()].flat()] : own.rules,
      version: own.version,
      scratch: this.scratchGeneration,
    }
  }

  /** The rules the admins set (no scratch database's): what the rules page shows and edits. */
  stored(connectionId: string): { rules: PersonalRule[]; version: number } {
    const row = this.db
      .prepare('SELECT rules, updated_at FROM personal_fields WHERE connection_id = ?')
      .get(connectionId) as { rules: string; updated_at: number } | undefined
    if (!row) return { rules: [], version: 0 }
    const parsed = PersonalRulesBodySchema.parse({
      rules: JSON.parse(this.box.open(row.rules, personalFieldsContext(connectionId))) as unknown,
    })
    return { rules: parsed.rules, version: row.updated_at }
  }

  /**
   * User request 2026-10-13: whether the local user (local mode) sees a connection's personal data
   * hidden — it has rules. User request 2026-10-24: one person uses local mode, so there is no
   * switch to show them (a choice the old switch stored is not read). Read on every request: the
   * rules are opened again only when they changed.
   */
  hiddenLocally(connectionId: string): boolean {
    this.localRow ??= this.db.prepare('SELECT updated_at FROM personal_fields WHERE connection_id = ?')
    const row = this.localRow.get(connectionId) as { updated_at: number } | undefined
    return row ? this.hasRules(connectionId, row.updated_at) : false
  }

  /**
   * User request 2026-10-24: whether a team member said to hide a connection's personal data from
   * themselves too, and it has rules (with none there is nothing to hide).
   */
  hiddenFromSelf(connectionId: string, userId: string): boolean {
    this.selfRow ??= this.db.prepare(
      `SELECT f.updated_at FROM personal_hidden_from_self h
         JOIN personal_fields f ON f.connection_id = h.connection_id
         WHERE h.connection_id = ? AND h.user_id = ?`,
    )
    const row = this.selfRow.get(connectionId, userId) as { updated_at: number } | undefined
    return row ? this.hasRules(connectionId, row.updated_at) : false
  }

  /** A team member's choice to hide (or show again) a connection's personal data from themselves. */
  setHiddenFromSelf(connectionId: string, userId: string, hidden: boolean): void {
    // Never the rules' row: the version masked backups, live syncs and AI turns are bound to stays.
    if (hidden)
      this.db
        .prepare('INSERT OR IGNORE INTO personal_hidden_from_self (connection_id, user_id) VALUES (?, ?)')
        .run(connectionId, userId)
    else
      this.db
        .prepare('DELETE FROM personal_hidden_from_self WHERE connection_id = ? AND user_id = ?')
        .run(connectionId, userId)
  }

  /** Whether a team member chose to hide a connection's personal data from themselves. */
  hidesFromSelf(connectionId: string, userId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM personal_hidden_from_self WHERE connection_id = ? AND user_id = ?')
        .get(connectionId, userId) !== undefined
    )
  }

  /** The team members who chose to hide a connection's personal data from themselves. */
  usersHidingFromSelf(connectionId: string): string[] {
    return (
      this.db
        .prepare('SELECT user_id FROM personal_hidden_from_self WHERE connection_id = ? ORDER BY user_id')
        .all(connectionId) as Array<{ user_id: string }>
    ).map((r) => r.user_id)
  }

  /** Whether a connection has rules, at a version: the rules are opened again only when it moved. */
  private hasRules(connectionId: string, version: number): boolean {
    let hit = this.counts.get(connectionId)
    if (!hit || hit.version !== version) {
      let count: number
      try {
        count = this.stored(connectionId).rules.length
      } catch {
        // Rules that do not open (another key, tampered): in doubt, hide (review 2026-10-13, M7).
        return true
      }
      hit = { version, count }
      if (this.counts.size >= 1000) this.counts.clear()
      this.counts.set(connectionId, hit)
    }
    return hit.count > 0
  }

  /** W4 review C1: a drill's scratch database covered by the rules of what it restores. */
  addScratchRules(connectionId: string, scratchDb: string, rules: readonly PersonalRule[]): void {
    let byDb = this.scratch.get(connectionId)
    if (!byDb) this.scratch.set(connectionId, (byDb = new Map()))
    const have = byDb.get(scratchDb) ?? []
    const key = (r: PersonalRule) => JSON.stringify([r.db, r.coll, r.field])
    const known = new Set(have.map(key))
    byDb.set(scratchDb, [
      ...have,
      ...rules.filter((r) => r.db === scratchDb && !known.has(key(r)) && known.add(key(r))),
    ])
    this.scratchGeneration++
  }

  /** W4 review C1: the scratch database is gone — its rules with it. */
  dropScratchRules(connectionId: string, scratchDb: string): void {
    const byDb = this.scratch.get(connectionId)
    byDb?.delete(scratchDb)
    if (byDb && byDb.size === 0) this.scratch.delete(connectionId)
    this.scratchGeneration++
  }

  set(connectionId: string, rules: PersonalRule[]): void {
    // W4 review C1: a scratch database's rules are never stored (they came back through get()).
    rules = rules.filter((r) => !this.isScratchRule(connectionId, r))
    this.db
      .prepare(
        `INSERT INTO personal_fields (connection_id, rules, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (connection_id) DO UPDATE SET rules = excluded.rules,
           updated_at = MAX(excluded.updated_at, personal_fields.updated_at + 1)`,
      )
      .run(
        connectionId,
        this.box.seal(JSON.stringify(rules), personalFieldsContext(connectionId)),
        this.now(),
      )
  }

  private isScratchRule(connectionId: string, r: PersonalRule): boolean {
    return this.scratch.get(connectionId)?.has(r.db) ?? false
  }
}
