import type { DatabaseSync } from 'node:sqlite'
import type { ZodType } from 'zod'

/**
 * Settings an administrator changes in the app (user review 2026-10-09: the AI history's days). Each
 * is JSON under a key; a stored value that no longer reads as its schema falls back to the default.
 */
export class SettingsRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  get<T>(key: string, schema: ZodType<T>, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      { value: string } | undefined
    if (!row) return fallback
    try {
      const parsed = schema.safeParse(JSON.parse(row.value))
      return parsed.success ? parsed.data : fallback
    } catch {
      return fallback
    }
  }

  /** Whether a value is stored under the key, whether it reads or not. */
  has(key: string): boolean {
    return !!this.db.prepare('SELECT 1 AS one FROM app_settings WHERE key = ?').get(key)
  }

  set<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), this.now())
  }
}
