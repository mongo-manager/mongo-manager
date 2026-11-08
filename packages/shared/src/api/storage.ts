// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { CollectionNameSchema } from '../schemas'

/**
 * Plugins wave 4 (2026-10-27): what a database's collections take on disk, for the storage report —
 * sizes as MongoDB counts them, the space WiredTiger holds free for reuse (what `compact` could give
 * back), each index's share. A size the caller may not know (personal data rules there) is null.
 */
export interface StorageIndex {
  name: string
  size: number | null
  freeBytes: number | null
}
export interface StorageCollection {
  name: string
  type: 'collection' | 'timeseries'
  count: number | null
  size: number | null
  storageSize: number | null
  /** WiredTiger's "file bytes available for reuse" of the collection's own file. */
  freeBytes: number | null
  indexSize: number | null
  indexFreeBytes: number | null
  indexes: StorageIndex[]
  sizesHidden?: true
  /** MongoDB would not tell (a refused or failed read): every figure null. */
  unread?: true
}
export interface StorageReport {
  collections: StorageCollection[]
  /** More collections than one report reads (500, by name). */
  more: boolean
}

/** What `compact` with `dryRun` estimates (MongoDB 8.0+); why there is no estimate. */
export type CompactEstimate =
  | { available: true; estimatedBytes: number }
  | { available: false; reason: 'version' | 'mongos' | 'timeseries' }

/** Compact runs only when the user typed the collection's name in the app's own dialog. */
export const CompactBodySchema = z.strictObject({ confirm: CollectionNameSchema })

const KeyField = z
  .string()
  .min(1)
  .max(200)
  .refine(
    // Final review Minor 13: a name JavaScript reads as an integer would be moved first in the key.
    (f) => !f.startsWith('$') && !f.includes('\0') && !f.split('.').some((p) => p === '') && !/^\d+$/.test(f),
    'Not a field path',
  )

/** A candidate shard key: one to five fields, ascending or hashed (one hashed field at most). */
export const ShardKeyAnalysisBodySchema = z.strictObject({
  key: z
    .record(KeyField, z.union([z.literal(1), z.literal('hashed')]))
    .refine((k) => Object.keys(k).length >= 1 && Object.keys(k).length <= 5, 'One to five fields')
    .refine((k) => Object.values(k).filter((v) => v === 'hashed').length <= 1, 'At most one hashed field'),
})
export type ShardKeyAnalysisBody = z.infer<typeof ShardKeyAnalysisBodySchema>

/** What `analyzeShardKey` says of a candidate key (its key characteristics). */
export type ShardKeyAnalysis =
  | {
      available: true
      numDocsTotal: number | null
      numDocsSampled: number | null
      numDistinctValues: number | null
      avgDocSizeBytes: number | null
      isUnique: boolean | null
      /** The values held most often, as canonical EJSON, with how many sampled documents hold each. */
      mostCommonValues: Array<{ value: unknown; frequency: number }>
      monotonicity: 'monotonic' | 'not monotonic' | 'unknown'
    }
  | { available: false; reason: 'version' | 'standalone' | 'no_index' }
