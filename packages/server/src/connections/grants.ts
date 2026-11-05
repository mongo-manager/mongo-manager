// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync } from 'node:sqlite'
import type { Role } from '@mongo-manager/shared'

export type GrantRole = Role | 'none'

export class GrantRepo {
  constructor(private readonly db: DatabaseSync) {}

  set(connectionId: string, userId: string, role: GrantRole | null): void {
    if (role === null) {
      this.db
        .prepare('DELETE FROM connection_grants WHERE connection_id = ? AND user_id = ?')
        .run(connectionId, userId)
      return
    }
    this.db
      .prepare(
        `INSERT INTO connection_grants (connection_id, user_id, role) VALUES (?, ?, ?)
         ON CONFLICT (connection_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(connectionId, userId, role)
    // Without access, the user's remembered queries and shell history on this connection go too.
    if (role === 'none') {
      this.db
        .prepare('DELETE FROM query_history WHERE connection_id = ? AND user_id = ?')
        .run(connectionId, userId)
      this.db
        .prepare('DELETE FROM shell_history WHERE connection_id = ? AND user_id = ?')
        .run(connectionId, userId)
    }
  }

  list(
    connectionId: string,
  ): Array<{ userId: string; role: GrantRole; shell: boolean; masked: boolean; export: boolean }> {
    const rows = this.db
      .prepare(
        'SELECT user_id, role, shell, masked, export FROM connection_grants WHERE connection_id = ? ORDER BY user_id',
      )
      .all(connectionId) as unknown as Array<{
      user_id: string
      role: GrantRole
      shell: number
      masked: number
      export: number
    }>
    return rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      shell: r.shell === 1,
      masked: r.masked === 1,
      export: r.export === 1,
    }))
  }

  roleFor(connectionId: string, userId: string): GrantRole | undefined {
    const row = this.db
      .prepare('SELECT role FROM connection_grants WHERE connection_id = ? AND user_id = ?')
      .get(connectionId, userId) as { role: GrantRole } | undefined
    return row?.role
  }

  /** Phase 3a-1: whether an editor was granted the advanced shell on this connection. */
  shellGrant(connectionId: string, userId: string): boolean {
    const row = this.db
      .prepare('SELECT shell FROM connection_grants WHERE connection_id = ? AND user_id = ?')
      .get(connectionId, userId) as { shell: number } | undefined
    return row?.shell === 1
  }

  /** Phase 3b spec §2.2: whether this user may not see the connection's personal data. */
  maskedGrant(connectionId: string, userId: string): boolean {
    const row = this.db
      .prepare('SELECT masked FROM connection_grants WHERE connection_id = ? AND user_id = ?')
      .get(connectionId, userId) as { masked: number } | undefined
    return row?.masked === 1
  }

  /** Set the restricted flag. The grant row must already exist (a role must be granted first). */
  setMasked(connectionId: string, userId: string, masked: boolean): void {
    this.db
      .prepare('UPDATE connection_grants SET masked = ? WHERE connection_id = ? AND user_id = ?')
      .run(masked ? 1 : 0, connectionId, userId)
  }

  /** Set the shell grant. The grant row must already exist (a role must be granted first). */
  setShell(connectionId: string, userId: string, allowed: boolean): void {
    this.db
      .prepare('UPDATE connection_grants SET shell = ? WHERE connection_id = ? AND user_id = ?')
      .run(allowed ? 1 : 0, connectionId, userId)
  }

  /** Phase 3d-1: whether a viewer was granted file export on this connection. */
  exportGrant(connectionId: string, userId: string): boolean {
    const row = this.db
      .prepare('SELECT export FROM connection_grants WHERE connection_id = ? AND user_id = ?')
      .get(connectionId, userId) as { export: number } | undefined
    return row?.export === 1
  }

  /** Set the export grant. The grant row must already exist (a role must be granted first). */
  setExport(connectionId: string, userId: string, on: boolean): void {
    this.db
      .prepare('UPDATE connection_grants SET export = ? WHERE connection_id = ? AND user_id = ?')
      .run(on ? 1 : 0, connectionId, userId)
  }
}
