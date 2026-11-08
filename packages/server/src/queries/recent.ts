// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 1g-1 recent queries. Since phase 2c they live in the query history (queries/history.ts);
 * what remains here is the shape of a find and the sealing context the move needs.
 */

/** A query as the client sent it (canonical EJSON parts). */
export interface RecentQuery {
  filter: Record<string, unknown>
  projection?: Record<string, unknown>
  sort?: Record<string, unknown>
  collation?: Record<string, unknown>
  hint?: string | Record<string, unknown>
}

export interface RecentQueryEntry {
  query: RecentQuery
  usedAt: number
}

export interface RecentRow {
  id: string
  user_id: string | null
  connection_id: string
  db: string
  coll: string
}

/** Sealing context: a row copied or moved to another owner or collection no longer opens. */
export const recentContext = (r: RecentRow) =>
  `recent:${JSON.stringify([r.id, r.user_id, r.connection_id, r.db, r.coll])}`
