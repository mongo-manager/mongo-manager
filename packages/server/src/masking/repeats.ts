// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { calculateObjectSize } from 'bson'
import type { AggregateOptions, CollationOptions, Collection } from 'mongodb'
import { orderRefused } from './gate/refusal'

/**
 * Sixteenth to eighteenth reviews of explain masking (I1): where a time series is stored by a
 * hidden value and its _id may repeat, documents sharing an _id come in that storage order. MongoDB
 * itself is asked whether an _id repeats, by its own equality (numbers by value, the read's
 * collation), wherever in the collection the others are. Only by _id: the read's filter, asked a
 * second time, could answer otherwise ($rand, $$NOW, a write in between: eighteenth review, I-1),
 * so a twin the filter leaves out refuses too.
 */
export const repeatsRefused = (ns: string) => orderRefused('Reading documents whose _id repeats here', ns)

/** The $in a command can carry: well under MongoDB's 16 MB (eighteenth review, Minor 8). */
const CHUNK_BYTES = 4 * 1024 * 1024

/** Refuses where any of these _ids (a page's, a sample's) repeats in the collection. */
export async function refuseRepeats(
  collection: Collection,
  ids: readonly unknown[],
  options: { comment?: string; maxTimeMS?: number; collation?: CollationOptions } = {},
): Promise<void> {
  const chunks: unknown[][] = [[]]
  let bytes = 0
  for (const id of ids) {
    if (id === undefined) continue
    // An array sorts by its least element: it ties with others the group tells apart (nineteenth
    // review, Minor 5).
    if (Array.isArray(id)) throw repeatsRefused(collection.namespace)
    const size = calculateObjectSize({ id })
    if (bytes + size > CHUNK_BYTES && chunks.at(-1)!.length > 0) {
      chunks.push([])
      bytes = 0
    }
    chunks.at(-1)!.push(id)
    bytes += size
  }
  for (const chunk of chunks) {
    if (chunk.length === 0) continue
    const [repeat] = await collection
      .aggregate(
        [
          { $match: { _id: { $in: chunk } } },
          { $group: { _id: '$_id', n: { $sum: 1 } } },
          { $match: { n: { $gt: 1 } } },
          { $limit: 1 },
        ],
        options,
      )
      .toArray()
    if (repeat) throw repeatsRefused(collection.namespace)
  }
}

/**
 * A job's read (an export, a copy) asks once, before anything is read, whether any _id of the
 * collection repeats: what it writes (its file, its target, its rejected records) is then never
 * in a hidden order, and the question costs one pass (eighteenth review, Minor 3, Minor 4).
 */
export async function refuseAnyRepeat(
  collection: Collection,
  options: AggregateOptions = {},
  /** Document _ids the read refuses by itself: left out, so its own refusal comes first (nineteenth review, Minor 8). */
  skipDocumentIds = false,
): Promise<void> {
  const [repeat] = await collection
    .aggregate(
      [
        ...(skipDocumentIds ? [{ $match: { $expr: { $ne: [{ $type: '$_id' }, 'object'] } } }] : []),
        { $group: { _id: '$_id', n: { $sum: 1 } } },
        // An array _id ties with others by its least element (nineteenth review, Minor 5).
        { $match: { $or: [{ n: { $gt: 1 } }, { $expr: { $isArray: '$_id' } }] } },
        { $limit: 1 },
      ],
      { allowDiskUse: true, ...options },
    )
    .toArray()
  if (repeat) throw repeatsRefused(collection.namespace)
}
