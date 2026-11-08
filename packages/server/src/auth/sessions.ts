// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** The idle time when an administrator has chosen none (session lifetime, 2026-10-29). */
export const SESSION_IDLE_MS = 30 * 60_000
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000
export const TOUCH_INTERVAL_MS = 60_000
/** Renewals remembered at most (the oldest go first). */
const MAX_SUCCESSORS = 10_000

export interface Session {
  idHash: string
  userId: string
  csrfToken: string
  createdAt: number
  lastSeenAt: number
}

interface Row {
  id_hash: string
  user_id: string
  csrf_token: string
  created_at: number
  last_seen_at: number
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('base64url')
}

/** A live session as an administrator sees it (panel access, 2026-10-30). */
export interface ActiveSession {
  idHash: string
  userId: string
  username: string
  ip: string | null
  userAgent: string | null
  createdAt: number
  lastSeenAt: number
}

/** A session ended by sign-out (idHash) or all of a user's sessions ended at once (userId). */
export type SessionRevocation = { idHash: string } | { userId: string }

export class SessionRepo {
  private readonly revokeListeners = new Set<(r: SessionRevocation) => void>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    /** How long a session lasts without a request, as an administrator chose it. */
    private idleMs = SESSION_IDLE_MS,
  ) {}

  /** A new idle time holds for every session at once: one idle longer than it ends. */
  setIdleMs(ms: number): void {
    this.idleMs = ms
  }

  create(userId: string, meta: { ip?: string; userAgent?: string }): { sessionId: string; session: Session } {
    const sessionId = randomBytes(32).toString('base64url')
    const session: Session = {
      idHash: hashSessionId(sessionId),
      userId,
      csrfToken: randomBytes(32).toString('base64url'),
      createdAt: this.now(),
      lastSeenAt: this.now(),
    }
    this.db
      .prepare(
        'INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        session.idHash,
        userId,
        session.csrfToken,
        session.createdAt,
        session.lastSeenAt,
        meta.ip ?? null,
        meta.userAgent ?? null,
      )
    return { sessionId, session }
  }

  get(sessionId: string): Session | undefined {
    const idHash = hashSessionId(sessionId)
    const row = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as unknown as
      Row | undefined
    if (!row) return undefined
    const t = this.now()
    if (t - row.last_seen_at > this.idleMs || t - row.created_at > SESSION_ABSOLUTE_MS) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash)
      return undefined
    }
    let lastSeenAt = row.last_seen_at
    if (t - row.last_seen_at >= TOUCH_INTERVAL_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(t, idHash)
      lastSeenAt = t
    }
    return { idHash, userId: row.user_id, csrfToken: row.csrf_token, createdAt: row.created_at, lastSeenAt }
  }

  revoke(sessionId: string): void {
    const idHash = hashSessionId(sessionId)
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash)
    this.announce({ idHash })
  }

  revokeAllForUser(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    this.announce({ userId })
  }

  /** Panel access (2026-10-30): every live session, with who it is and where it signed in from. */
  listActive(): ActiveSession[] {
    const t = this.now()
    const rows = this.db
      .prepare(
        `SELECT s.id_hash, s.user_id, u.username, s.ip, s.user_agent, s.created_at, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.last_seen_at >= ? AND s.created_at >= ? ORDER BY s.last_seen_at DESC`,
      )
      .all(t - this.idleMs, t - SESSION_ABSOLUTE_MS) as Array<{
      id_hash: string
      user_id: string
      username: string
      ip: string | null
      user_agent: string | null
      created_at: number
      last_seen_at: number
    }>
    return rows.map((r) => ({
      idHash: r.id_hash,
      userId: r.user_id,
      username: r.username,
      ip: r.ip,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    }))
  }

  /** Ends one session by its hash, its sockets with it. */
  revokeHash(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash)
    this.announce({ idHash })
  }

  /** Called after a session is revoked, so long-lived sockets of it close at once (phase 1h). */
  onRevoke(listener: (r: SessionRevocation) => void): () => void {
    this.revokeListeners.add(listener)
    return () => this.revokeListeners.delete(listener)
  }

  /**
   * The session behind a hash, if it is still valid, without counting as activity: an open socket
   * must not keep an idle session alive.
   */
  peekHash(idHash: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as unknown as
      Row | undefined
    if (!row) return undefined
    const t = this.now()
    if (t - row.last_seen_at > this.idleMs || t - row.created_at > SESSION_ABSOLUTE_MS) return undefined
    return {
      idHash,
      userId: row.user_id,
      csrfToken: row.csrf_token,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }
  }

  /**
   * Review of the security pass 2026-10-16 (I5): a session renewed in place (a sign-in in another tab
   * of the same browser, a password change) by the same user. What named the old one — a plugin
   * frame's ticket — follows it to the new one; a sign-out leaves no successor. Kept in memory only,
   * for a session's whole life at most.
   */
  private readonly successors = new Map<string, { next: string; at: number }>()

  renewed(previousHash: string, nextHash: string): void {
    const t = this.now()
    for (const [hash, s] of this.successors) {
      if (t - s.at <= SESSION_ABSOLUTE_MS && this.successors.size < MAX_SUCCESSORS) break
      this.successors.delete(hash)
    }
    this.successors.set(previousHash, { next: nextHash, at: t })
  }

  /** The live session a hash names, or the one it was renewed into (at most 8 renewals on), unchanged. */
  peekRenewed(idHash: string): Session | undefined {
    let at = idHash
    for (let hop = 0; hop <= 8; hop++) {
      const live = this.peekHash(at)
      if (live) return live
      const next = this.successors.get(at)
      if (!next || this.now() - next.at > SESSION_ABSOLUTE_MS) return undefined
      at = next.next
    }
    return undefined
  }

  private announce(r: SessionRevocation): void {
    for (const listener of this.revokeListeners) {
      try {
        listener(r)
      } catch {
        // A listener's failure must not undo or block the sign-out.
      }
    }
  }

  pruneExpired(): number {
    const t = this.now()
    const result = this.db
      .prepare('DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?')
      .run(t - this.idleMs, t - SESSION_ABSOLUTE_MS)
    return Number(result.changes)
  }
}
