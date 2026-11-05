// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/** Phase 4b §4: what the map reads, through the bridge. */

import { AskError } from '../../kit/src/client'

/** A failure the app answered with, its code kept: the bridge client's own, so a code is never missed. */
export { AskError }

export type Ask = <T>(method: string, params?: unknown) => Promise<T>

/** At most this many documents are drawn; read in pages small enough for the bridge's 1 MB. */
export const MAX_DOCUMENTS = 1000
const FIRST_PAGE = 250
const SMALLEST_PAGE = 10

/**
 * The documents of the current query, in pages by `_id`: a page too large for the bridge is asked
 * again at half the size (4b map review I3).
 */
export async function readDocuments(
  ask: Ask,
  filter: Record<string, unknown>,
): Promise<{ documents: Record<string, unknown>[]; more: boolean }> {
  const documents: Record<string, unknown>[] = []
  let limit = FIRST_PAGE
  let last: unknown
  for (;;) {
    const page = Math.min(limit, MAX_DOCUMENTS - documents.length)
    const after = last === undefined ? filter : { $and: [filter, { _id: { $gt: last } }] }
    let found: { documents: Record<string, unknown>[]; hasMore: boolean }
    try {
      found = await ask('documents.find', { filter: after, sort: { _id: 1 }, limit: page })
    } catch (e) {
      if (e instanceof AskError && e.code === 'too_large' && limit > SMALLEST_PAGE) {
        limit = Math.floor(limit / 2)
        continue
      }
      throw e
    }
    documents.push(...found.documents)
    if (!found.hasMore || !found.documents.length) return { documents, more: false }
    if (documents.length >= MAX_DOCUMENTS) return { documents, more: true }
    last = found.documents.at(-1)!._id
  }
}
