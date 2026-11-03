import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SecretBox } from '../crypto/secret-box'

/**
 * Phase 3a-1 spec §7: a per-user history of shell commands. The code can hold secrets, so it is
 * sealed; repeats are found through a keyed hash, like the query history. Owner null is local mode.
 */
export const MAX_SHELL_HISTORY_PER_CONNECTION = 1000
export const MAX_SHELL_HISTORY_PER_OWNER = 5000
export const MAX_SHELL_CODE_BYTES = 64 * 1024

export interface ShellHistoryKey {
  id: string
  user_id: string | null
  connection_id: string
}

export const shellHistoryContext = (r: ShellHistoryKey) =>
  `shell-history:${JSON.stringify([r.id, r.user_id, r.connection_id])}`

export const shellHistoryHash = (box: SecretBox, owner: string | null, connectionId: string, code: string) =>
  box.mac(JSON.stringify([owner, connectionId, code]))

export interface ShellHistoryEntry {
  id: string
  code: string
  usedAt: number
  count: number
}

type Row = ShellHistoryKey & { code: string; used_at: number; count: number }

export class ShellHistoryRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  private open(row: Row): string | undefined {
    try {
      return this.box.open(row.code, shellHistoryContext(row))
    } catch {
      return undefined
    }
  }

  record(owner: string | null, connectionId: string, code: string, at = this.now()): void {
    if (!code.trim()) return
    if (Buffer.byteLength(code) > MAX_SHELL_CODE_BYTES) return
    const hash = shellHistoryHash(this.box, owner, connectionId, code)
    this.db.exec('SAVEPOINT shell_history_record')
    try {
      const existing = this.db
        .prepare('SELECT id FROM shell_history WHERE user_id IS ? AND code_hash = ?')
        .get(owner, hash) as { id: string } | undefined
      const prevCount = existing
        ? (
            this.db.prepare('SELECT count FROM shell_history WHERE id = ?').get(existing.id) as {
              count: number
            }
          ).count
        : 0
      if (existing) this.db.prepare('DELETE FROM shell_history WHERE id = ?').run(existing.id)
      const row: ShellHistoryKey = { id: randomUUID(), user_id: owner, connection_id: connectionId }
      this.db
        .prepare(
          `INSERT INTO shell_history (id, user_id, connection_id, code, code_hash, used_at, count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          owner,
          connectionId,
          this.box.seal(code, shellHistoryContext(row)),
          hash,
          at,
          prevCount + 1,
        )
      this.db
        .prepare(
          `DELETE FROM shell_history WHERE id IN (
             SELECT id FROM shell_history WHERE user_id IS ? AND connection_id = ?
             ORDER BY used_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
        )
        .run(owner, connectionId, MAX_SHELL_HISTORY_PER_CONNECTION)
      this.db
        .prepare(
          `DELETE FROM shell_history WHERE id IN (
             SELECT id FROM shell_history WHERE user_id IS ? ORDER BY used_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
        )
        .run(owner, MAX_SHELL_HISTORY_PER_OWNER)
      this.db.exec('RELEASE shell_history_record')
    } catch (e) {
      this.db.exec('ROLLBACK TO shell_history_record')
      this.db.exec('RELEASE shell_history_record')
      throw e
    }
  }

  list(filter: { owner: string | null; connectionId: string; limit: number }): ShellHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, connection_id, code, used_at, count FROM shell_history
         WHERE user_id IS ? AND connection_id = ? ORDER BY used_at DESC, rowid DESC LIMIT ?`,
      )
      .all(filter.owner, filter.connectionId, filter.limit) as unknown as Row[]
    const out: ShellHistoryEntry[] = []
    for (const row of rows) {
      const code = this.open(row)
      if (code === undefined) continue
      out.push({ id: row.id, code, usedAt: row.used_at, count: row.count })
    }
    return out
  }

  clear(owner: string | null, connectionId: string): void {
    this.db
      .prepare('DELETE FROM shell_history WHERE user_id IS ? AND connection_id = ?')
      .run(owner, connectionId)
  }

  /** Team mode has no owner-less user: local mode's shell history goes when it starts. */
  forgetLocal(): number {
    return Number(this.db.prepare('DELETE FROM shell_history WHERE user_id IS NULL').run().changes)
  }
}
