// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 3a-2 spec §3.3: the query a shell result came from, as the proxy saw it, so the collection
 * view or the aggregation builder can reopen it. Filter, projection, sort, collation, object hints
 * and pipelines are canonical EJSON.
 */
export type QueryOrigin =
  | {
      kind: 'find'
      db: string
      coll: string
      filter: Record<string, unknown>
      projection?: Record<string, unknown>
      sort?: Record<string, unknown>
      skip?: number
      limit?: number
      collation?: Record<string, unknown>
      hint?: string | Record<string, unknown>
    }
  | { kind: 'aggregate'; db: string; coll: string; pipeline: unknown[] }
