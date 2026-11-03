import type { DatabaseSync } from 'node:sqlite'

/**
 * User review 2026-10-09: what a user arranges for themselves (the Overview dashboard), one JSON value
 * per key. The owner is the user's id, or `'local'` in local mode (no foreign key for that reason: the
 * users route removes a user's rows with the user).
 */
export class PreferencesRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  /** The value kept, or null (none, or a value that is not JSON any more). */
  get(owner: string, key: string): unknown {
    const row = this.db
      .prepare('SELECT value FROM user_preferences WHERE owner = ? AND key = ?')
      .get(owner, key) as { value: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value) as unknown
    } catch {
      return null
    }
  }

  set(owner: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO user_preferences (owner, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(owner, key, JSON.stringify(value), this.now())
  }

  remove(owner: string, key: string): void {
    this.db.prepare('DELETE FROM user_preferences WHERE owner = ? AND key = ?').run(owner, key)
  }

  /** A key of every owner (W1 review: a deleted connection's pins). */
  removeKeyForAll(key: string): number {
    return Number(this.db.prepare('DELETE FROM user_preferences WHERE key = ?').run(key).changes)
  }

  removeAll(owner: string): number {
    return Number(this.db.prepare('DELETE FROM user_preferences WHERE owner = ?').run(owner).changes)
  }
}
