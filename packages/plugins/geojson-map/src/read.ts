// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/** Phase 4b §4: what the map reads, through the bridge. */

import { AskError } from '../../kit/src/client'

/** A failure the app answered with, its code kept: the bridge client's own, so a code is never missed. */
export { AskError }

export type Ask = <T>(method: string, params?: unknown) => Promise<T>

/** At most this many documents are drawn; read in pages of at most this many. */
export const MAX_DOCUMENTS = 1000
const PAGE = 250

/**
 * The documents of the current query, in pages by `_id`. User report 2026-11-07: each page is asked
 * to fit one answer of the bridge (1 MB) — large documents come as many as fit, the answer says there
 * are more, and the next page goes on after the last one received. Before, a page too large was asked
 * again at half the size (4b map review I3), each refused page a read of the minute's 60 for nothing.
 * A document over 1 MB on its own is still too_large.
 */
export async function readDocuments(
  ask: Ask,
  filter: Record<string, unknown>,
): Promise<{ documents: Record<string, unknown>[]; more: boolean }> {
  const documents: Record<string, unknown>[] = []
  let last: unknown
  for (;;) {
    const limit = Math.min(PAGE, MAX_DOCUMENTS - documents.length)
    const after = last === undefined ? filter : { $and: [filter, { _id: { $gt: last } }] }
    const found = await ask<{ documents: Record<string, unknown>[]; hasMore: boolean }>('documents.find', {
      filter: after,
      sort: { _id: 1 },
      limit,
      fit: true,
    })
    documents.push(...found.documents)
    if (!found.hasMore || !found.documents.length) return { documents, more: false }
    if (documents.length >= MAX_DOCUMENTS) return { documents, more: true }
    last = found.documents.at(-1)!._id
  }
}
