// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document, MongoClient } from 'mongodb'
import { EXTERNAL_DB, type ConnectionSettings, type RoleRef } from '@mongo-manager/shared'

/** Who the connection signs in as, and every role that account holds (inherited ones too). */
export interface OwnAccount {
  user: string
  db: string
  roles: RoleRef[]
}

/** Mechanisms whose users live in $external; the others sign in against authSource. */
const EXTERNAL_MECHANISMS = new Set(['PLAIN', 'MONGODB-X509', 'MONGODB-AWS'])
const TTL_MS = 60_000
const COMMAND_MS = 5_000

/** The account as the settings name it: only when MongoDB cannot be asked. */
export function ownFromSettings(settings: ConnectionSettings): OwnAccount | null {
  const { auth } = settings
  if (auth.mechanism === 'none' || !auth.username) return null
  const db = EXTERNAL_MECHANISMS.has(auth.mechanism)
    ? EXTERNAL_DB
    : auth.authSource || settings.defaultDatabase || 'admin'
  return { user: auth.username, db, roles: [] }
}

const refs = (v: unknown): RoleRef[] =>
  (Array.isArray(v) ? v : [])
    .filter((r: Document) => typeof r?.role === 'string' && typeof r?.db === 'string')
    .slice(0, 500)
    .map((r: Document) => ({ role: String(r.role), db: String(r.db) }))

/**
 * W3 review (M2): the account the connection really signs in as, asked of MongoDB
 * (connectionStatus) — the settings can be wrong about it: an SRV record's authSource, an X.509
 * certificate's subject — with the roles it holds, inherited ones included (usersInfo). Only when
 * MongoDB cannot be asked do the settings answer.
 */
export async function resolveOwnAccount(
  client: MongoClient,
  settings: ConnectionSettings,
): Promise<OwnAccount | null> {
  let status: Document
  try {
    status = await client.db('admin').command({ connectionStatus: 1 }, { timeoutMS: COMMAND_MS })
  } catch {
    return ownFromSettings(settings)
  }
  const info = (status.authInfo ?? {}) as Document
  const first = (Array.isArray(info.authenticatedUsers) ? info.authenticatedUsers : [])[0] as
    Document | undefined
  if (!first || typeof first.user !== 'string' || typeof first.db !== 'string') return null
  const own: OwnAccount = { user: first.user, db: first.db, roles: refs(info.authenticatedUserRoles) }
  try {
    const answer = await client
      .db(own.db)
      .command({ usersInfo: { user: own.user, db: own.db } }, { timeoutMS: COMMAND_MS })
    const u = ((answer.users ?? []) as Document[])[0]
    if (u) {
      const all = [...own.roles, ...refs(u.roles), ...refs(u.inheritedRoles)]
      own.roles = [...new Map(all.map((r) => [`${r.role}@${r.db}`, r])).values()]
    }
  } catch {
    // Not allowed to read itself: its direct roles are what is known.
  }
  return own
}

/** A minute's memory of each connection's own account, forgotten after any change made here. */
export class OwnAccounts {
  private readonly cache = new Map<string, { at: number; key: string; value: OwnAccount | null }>()

  constructor(private readonly now: () => number) {}

  async get(
    connectionId: string,
    stamp: number,
    client: MongoClient,
    settings: ConnectionSettings,
  ): Promise<OwnAccount | null> {
    const key = `${connectionId}:${stamp}`
    const hit = this.cache.get(connectionId)
    if (hit && hit.key === key && this.now() - hit.at < TTL_MS) return hit.value
    const value = await resolveOwnAccount(client, settings)
    if (this.cache.size > 1000) this.cache.clear()
    this.cache.set(connectionId, { at: this.now(), key, value })
    return value
  }

  forget(connectionId: string): void {
    this.cache.delete(connectionId)
  }
}
