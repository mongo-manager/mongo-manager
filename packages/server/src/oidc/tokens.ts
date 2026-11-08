// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync } from 'node:sqlite'
import type { SecretBox } from '../crypto/secret-box'

/**
 * W7 (completion): a person's MONGODB-OIDC tokens for one connection. The tokens themselves are
 * sealed (key rotation re-seals them, crypto/rotate.ts); the issuer and client ID they came from are
 * not secret and stay readable, so a server that names another identity provider gets none of them.
 */
export interface OidcTokens {
  accessToken: string
  refreshToken?: string
  /** When the access token expires (ms); 0 or absent: unknown, used until the server refuses it. */
  expiresAt?: number
  /** Security review I6: who signed in (the ID token's subject and name), sealed with the tokens. */
  identity?: OidcIdentity
}

export interface OidcIdentity {
  subject: string
  /** preferred_username, or else email, as the identity provider says it. */
  name?: string
}

export interface OidcTokenRecord extends OidcTokens {
  connectionId: string
  user: string
  issuer: string
  clientId: string
  updatedAt: number
}

interface Row {
  connection_id: string
  user_key: string
  issuer: string
  client_id: string
  sealed: string
  expires_at: number | null
  updated_at: number
}

export const oidcTokenContext = (connectionId: string, user: string): string =>
  `oidc-token:${connectionId}:${user}`

export class OidcTokenRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  get(connectionId: string, user: string): OidcTokenRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM oidc_tokens WHERE connection_id = ? AND user_key = ?')
      .get(connectionId, user) as unknown as Row | undefined
    return row && this.record(row)
  }

  private record(row: Row): OidcTokenRecord | undefined {
    let tokens: OidcTokens
    try {
      tokens = JSON.parse(
        this.box.open(row.sealed, oidcTokenContext(row.connection_id, row.user_key)),
      ) as OidcTokens
    } catch {
      // Unreadable (another key): as good as none; the person signs in again.
      return undefined
    }
    return {
      ...tokens,
      connectionId: row.connection_id,
      user: row.user_key,
      issuer: row.issuer,
      clientId: row.client_id,
      updatedAt: row.updated_at,
    }
  }

  /** Every readable sign-in of a connection, or of a person (to revoke them: security review Minor 3). */
  records(of: { connectionId: string } | { user: string }): OidcTokenRecord[] {
    const rows = ('connectionId' in of
      ? this.db.prepare('SELECT * FROM oidc_tokens WHERE connection_id = ?').all(of.connectionId)
      : this.db.prepare('SELECT * FROM oidc_tokens WHERE user_key = ?').all(of.user)) as unknown as Row[]
    return rows.flatMap((r) => this.record(r) ?? [])
  }

  put(
    connectionId: string,
    user: string,
    idp: { issuer: string; clientId: string },
    tokens: OidcTokens,
  ): void {
    const t = this.now()
    const sealed = this.box.seal(
      JSON.stringify({
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
        ...(tokens.identity ? { identity: tokens.identity } : {}),
      }),
      oidcTokenContext(connectionId, user),
    )
    this.db
      .prepare(
        `INSERT INTO oidc_tokens (connection_id, user_key, issuer, client_id, sealed, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (connection_id, user_key) DO UPDATE SET issuer = excluded.issuer,
           client_id = excluded.client_id, sealed = excluded.sealed, expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(connectionId, user, idp.issuer, idp.clientId, sealed, tokens.expiresAt ?? null, t, t)
  }

  delete(connectionId: string, user: string): boolean {
    return (
      Number(
        this.db
          .prepare('DELETE FROM oidc_tokens WHERE connection_id = ? AND user_key = ?')
          .run(connectionId, user).changes,
      ) > 0
    )
  }

  deleteConnection(connectionId: string): number {
    return Number(
      this.db.prepare('DELETE FROM oidc_tokens WHERE connection_id = ?').run(connectionId).changes,
    )
  }

  deleteUser(user: string): number {
    return Number(this.db.prepare('DELETE FROM oidc_tokens WHERE user_key = ?').run(user).changes)
  }

  /**
   * Who is signed in on a connection (no tokens): for its administrators' revocation — with whom
   * each sign-in is at the identity provider (security review I6) when it can still be read.
   */
  people(
    connectionId: string,
  ): Array<{ user: string; issuer: string; updatedAt: number; identity?: OidcIdentity }> {
    return (
      this.db
        .prepare('SELECT * FROM oidc_tokens WHERE connection_id = ? ORDER BY updated_at DESC')
        .all(connectionId) as unknown as Row[]
    ).map((r) => {
      const identity = this.record(r)?.identity
      return {
        user: r.user_key,
        issuer: r.issuer,
        updatedAt: r.updated_at,
        ...(identity ? { identity } : {}),
      }
    })
  }
}
