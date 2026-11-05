// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SnippetParam } from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'
import { spend, type ByteBudget } from './budget'

/**
 * Phase 3a-2 spec §3.5: shell snippets per connection. Name and tags are in the clear for search;
 * the body — code and parameters, defaults included — is sealed with the secret key, bound to the
 * row's id and connection. Owner `null` is the single user of local mode. The sharing and listing
 * rules are those of favourites (SealedItemRepo).
 */
export const MAX_SNIPPETS_PER_CONNECTION = 200
/** All owners together, so many users cannot grow one connection's list without end (final review M8). */
export const MAX_SNIPPETS_TOTAL_PER_CONNECTION = 1000
export const MAX_SNIPPET_BYTES = 64 * 1024
/** How many sealed bytes one listing opens; the rest is left out and the listing says so. */
export const SNIPPET_LIST_BYTES = 8 * 1024 * 1024

export interface SnippetKey {
  id: string
  connection_id: string
}

export const snippetContext = (r: SnippetKey): string => `snippet:${JSON.stringify([r.id, r.connection_id])}`

export interface SnippetBodyStored {
  code: string
  params: SnippetParam[]
}

export interface SnippetRow {
  id: string
  ownerId: string | null
  ownerName: string | null
  connectionId: string
  name: string
  tags: string[]
  body: SnippetBodyStored
  shared: boolean
  createdAt: number
  updatedAt: number
}

interface RawRow extends SnippetKey {
  owner_id: string | null
  owner_name: string | null
  name: string
  tags: string
  body: string
  shared: number
  created_at: number
  updated_at: number
}

const SELECT = `SELECT s.id, s.owner_id, u.username AS owner_name, s.connection_id, s.name, s.tags, s.body,
  s.shared, s.created_at, s.updated_at FROM snippets s LEFT JOIN users u ON u.id = s.owner_id`

const tagsOf = (text: string): string[] => {
  try {
    const value = JSON.parse(text) as unknown
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

export class SnippetRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  private toRow(raw: RawRow): SnippetRow | null {
    let body: SnippetBodyStored
    try {
      body = JSON.parse(this.box.open(raw.body, snippetContext(raw))) as SnippetBodyStored
    } catch {
      return null // A row that does not open is never shown.
    }
    return {
      id: raw.id,
      ownerId: raw.owner_id,
      ownerName: raw.owner_name,
      connectionId: raw.connection_id,
      name: raw.name,
      tags: tagsOf(raw.tags),
      body,
      shared: raw.shared === 1,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }
  }

  /**
   * The snippets a user may see on a connection: their own and the shared ones. Ownerless snippets
   * (saved in local mode) are listed when `ownerless` is set: to the connection admins of team mode.
   */
  list(filter: {
    ownerId: string | null
    connectionId: string
    ownerless: boolean
    limit?: number
    order?: 'name' | 'recent'
    budget?: ByteBudget
  }): SnippetRow[] {
    const order =
      filter.order === 'recent' ? 's.updated_at DESC, s.rowid DESC' : 's.name COLLATE NOCASE, s.created_at'
    const rows = this.db
      .prepare(
        `${SELECT} WHERE s.connection_id = ? AND (s.owner_id IS ? OR s.shared = 1 OR (? = 1 AND s.owner_id IS NULL))
         ORDER BY ${order}${filter.limit !== undefined ? ' LIMIT ?' : ''}`,
      )
      .all(
        filter.connectionId,
        filter.ownerId,
        filter.ownerless ? 1 : 0,
        ...(filter.limit !== undefined ? [filter.limit] : []),
      ) as unknown as RawRow[]
    const out: SnippetRow[] = []
    for (const raw of rows) {
      if (!spend(filter.budget, raw.body.length)) break
      const row = this.toRow(raw)
      if (row) out.push(row)
    }
    return out
  }

  get(id: string): SnippetRow | null {
    const raw = this.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as RawRow | undefined
    return raw ? this.toRow(raw) : null
  }

  countFor(ownerId: string | null, connectionId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM snippets WHERE owner_id IS ? AND connection_id = ?')
        .get(ownerId, connectionId) as { n: number }
    ).n
  }

  countAll(connectionId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM snippets WHERE connection_id = ?').get(connectionId) as {
        n: number
      }
    ).n
  }

  create(input: {
    ownerId: string | null
    connectionId: string
    name: string
    tags: string[]
    body: SnippetBodyStored
    shared: boolean
  }): SnippetRow {
    const key: SnippetKey = { id: randomUUID(), connection_id: input.connectionId }
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO snippets (id, owner_id, connection_id, name, tags, body, shared, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key.id,
        input.ownerId,
        input.connectionId,
        input.name,
        JSON.stringify(input.tags),
        this.box.seal(JSON.stringify(input.body), snippetContext(key)),
        input.shared ? 1 : 0,
        at,
        at,
      )
    return this.get(key.id)!
  }

  update(
    id: string,
    input: { name: string; tags?: string[]; body: SnippetBodyStored; shared: boolean },
  ): SnippetRow | null {
    const current = this.get(id)
    if (!current) return null
    const key: SnippetKey = { id, connection_id: current.connectionId }
    this.db
      .prepare('UPDATE snippets SET name = ?, tags = ?, body = ?, shared = ?, updated_at = ? WHERE id = ?')
      .run(
        input.name,
        JSON.stringify(input.tags ?? current.tags),
        this.box.seal(JSON.stringify(input.body), snippetContext(key)),
        input.shared ? 1 : 0,
        this.now(),
        id,
      )
    return this.get(id)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM snippets WHERE id = ?').run(id).changes > 0
  }
}
