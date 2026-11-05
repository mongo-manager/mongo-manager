// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SecretBox } from '../crypto/secret-box'
import { spend, type ByteBudget } from './budget'

/**
 * Items users save per collection — pipelines (phase 2a) and favourite finds (phase 2c): a name
 * and tags in the clear, the content sealed with the secret key (AAD: id, connection, namespace),
 * private or shared. Owner `null` is the single user of local mode.
 */
export interface SealedItemKey {
  id: string
  connection_id: string
  db: string
  coll: string
}

export interface SealedItemRow {
  id: string
  ownerId: string | null
  ownerName: string | null
  connectionId: string
  db: string
  coll: string
  name: string
  tags: string[]
  /** The content, canonical EJSON text. */
  text: string
  shared: boolean
  createdAt: number
  updatedAt: number
}

interface RawRow extends SealedItemKey {
  owner_id: string | null
  owner_name: string | null
  name: string
  tags: string
  content: string
  shared: number
  created_at: number
  updated_at: number
}

export interface SealedItemTable {
  table: 'saved_pipelines' | 'saved_queries'
  /** The sealed column. */
  column: 'pipeline' | 'query'
  /** Sealing context of a row. */
  context: (key: SealedItemKey) => string
}

const tagsOf = (text: string): string[] => {
  try {
    const value = JSON.parse(text) as unknown
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

export class SealedItemRepo {
  private readonly select: string

  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
    private readonly t: SealedItemTable,
  ) {
    this.select = `SELECT p.id, p.owner_id, u.username AS owner_name, p.connection_id, p.db, p.coll, p.name,
      p.tags, p.${t.column} AS content, p.shared, p.created_at, p.updated_at
      FROM ${t.table} p LEFT JOIN users u ON u.id = p.owner_id`
  }

  private toRow(raw: RawRow): SealedItemRow | null {
    let text: string
    try {
      text = this.box.open(raw.content, this.t.context(raw))
    } catch {
      return null // A row that does not open is never shown.
    }
    return {
      id: raw.id,
      ownerId: raw.owner_id,
      ownerName: raw.owner_name,
      connectionId: raw.connection_id,
      db: raw.db,
      coll: raw.coll,
      name: raw.name,
      tags: tagsOf(raw.tags),
      text,
      shared: raw.shared === 1,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }
  }

  /**
   * The items a user may see: their own and the shared ones, in one collection or (without db and
   * coll) the whole connection. Ownerless items (saved in local mode) are listed when `ownerless`
   * is set: to the connection admins of team mode.
   */
  list(filter: {
    ownerId: string | null
    connectionId: string
    db?: string
    coll?: string
    ownerless?: boolean
    limit?: number
    /** Newest first instead of by name (the library keeps the newest when it stops early). */
    order?: 'name' | 'recent'
    /** Collections whose rows are not even opened (credential namespaces for non-admins). */
    excludeColls?: readonly string[]
    /** Databases whose rows are not even opened (the local database for non-admins). */
    excludeDbs?: readonly string[]
    /** Sealed bytes this listing may open; rows past it stay closed. */
    budget?: ByteBudget
  }): SealedItemRow[] {
    const where = ['p.connection_id = ?']
    const params: Array<string | number | null> = [filter.connectionId]
    if (filter.db !== undefined) {
      where.push('p.db = ?')
      params.push(filter.db)
    }
    if (filter.coll !== undefined) {
      where.push('p.coll = ?')
      params.push(filter.coll)
    }
    if (filter.excludeColls?.length) {
      where.push(`p.coll NOT IN (${filter.excludeColls.map(() => '?').join(', ')})`)
      params.push(...filter.excludeColls)
    }
    if (filter.excludeDbs?.length) {
      where.push(`p.db NOT IN (${filter.excludeDbs.map(() => '?').join(', ')})`)
      params.push(...filter.excludeDbs)
    }
    where.push('(p.owner_id IS ? OR p.shared = 1 OR (? = 1 AND p.owner_id IS NULL))')
    params.push(filter.ownerId, filter.ownerless ? 1 : 0)
    const order =
      filter.order === 'recent' ? 'p.updated_at DESC, p.rowid DESC' : 'p.name COLLATE NOCASE, p.created_at'
    const rows = this.db
      .prepare(
        `${this.select} WHERE ${where.join(' AND ')} ORDER BY ${order}${filter.limit !== undefined ? ' LIMIT ?' : ''}`,
      )
      .all(...params, ...(filter.limit !== undefined ? [filter.limit] : [])) as unknown as RawRow[]
    const out: SealedItemRow[] = []
    for (const raw of rows) {
      if (!spend(filter.budget, raw.content.length)) break
      const row = this.toRow(raw)
      if (row) out.push(row)
    }
    return out
  }

  get(id: string): SealedItemRow | null {
    const raw = this.db.prepare(`${this.select} WHERE p.id = ?`).get(id) as RawRow | undefined
    return raw ? this.toRow(raw) : null
  }

  countFor(ownerId: string | null, connectionId: string, db: string, coll: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${this.t.table} WHERE owner_id IS ? AND connection_id = ? AND db = ? AND coll = ?`,
        )
        .get(ownerId, connectionId, db, coll) as { n: number }
    ).n
  }

  create(input: {
    ownerId: string | null
    connectionId: string
    db: string
    coll: string
    name: string
    text: string
    shared: boolean
    tags?: string[]
  }): SealedItemRow {
    const key: SealedItemKey = {
      id: randomUUID(),
      connection_id: input.connectionId,
      db: input.db,
      coll: input.coll,
    }
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO ${this.t.table} (id, owner_id, connection_id, db, coll, name, tags, ${this.t.column}, shared, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key.id,
        input.ownerId,
        input.connectionId,
        input.db,
        input.coll,
        input.name,
        JSON.stringify(input.tags ?? []),
        this.box.seal(input.text, this.t.context(key)),
        input.shared ? 1 : 0,
        at,
        at,
      )
    return this.get(key.id)!
  }

  update(
    id: string,
    input: { name: string; text: string; shared: boolean; tags?: string[] },
  ): SealedItemRow | null {
    const current = this.get(id)
    if (!current) return null
    const key: SealedItemKey = { id, connection_id: current.connectionId, db: current.db, coll: current.coll }
    this.db
      .prepare(
        `UPDATE ${this.t.table} SET name = ?, tags = ?, ${this.t.column} = ?, shared = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.name,
        JSON.stringify(input.tags ?? current.tags),
        this.box.seal(input.text, this.t.context(key)),
        input.shared ? 1 : 0,
        this.now(),
        id,
      )
    return this.get(id)
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.t.table} WHERE id = ?`).run(id).changes > 0
  }
}
