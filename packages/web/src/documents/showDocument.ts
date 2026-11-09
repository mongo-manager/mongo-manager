// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { useCollectionViewsStore } from '@/stores/collectionViews'
import { buildQuery } from './queryBuild'
import { bsonTypeOf } from '@mongo-manager/shared/browser'
import { decodeValue, toShell } from './values'

type ViewState = ReturnType<ReturnType<typeof useCollectionViewsStore>['stateFor']>

/**
 * Whether a value (canonical EJSON) names one document: a value of any BSON type, never an object
 * whose `$` keys MongoDB would read as an operator (a plugin's `{ $regex: … }`, 4b review M4).
 */
export function isDocumentId(id: unknown): boolean {
  if (id === undefined) return false
  let decoded: unknown
  try {
    decoded = decodeValue(id)
  } catch {
    return false
  }
  const dollar = (v: unknown): boolean =>
    bsonTypeOf(v) === 'object' &&
    Object.entries(v as Record<string, unknown>).some(([k, x]) => k.startsWith('$') || dollar(x))
  // A regular expression as the whole filter value matches by pattern, not by equality.
  return bsonTypeOf(decoded) !== 'regex' && !dollar(decoded)
}

/**
 * Phase 4b §3: shows one document by its `_id` (canonical EJSON, as a plugin names it) — the
 * collection's documents filtered to it, wherever it is in the list. False when the id is not one.
 */
export function showDocumentById(state: ViewState, id: unknown): boolean {
  if (!isDocumentId(id)) return false
  let decoded: unknown
  try {
    decoded = decodeValue(id)
  } catch {
    return false
  }
  const draft = { ...state.draft, filter: toShell({ _id: decoded }, 0) }
  const built = buildQuery(draft)
  if (!built.ok) return false
  state.draft = draft
  state.query = built.query
  state.page = 0
  return true
}
