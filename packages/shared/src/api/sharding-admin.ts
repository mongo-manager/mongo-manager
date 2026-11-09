// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'

/**
 * W3 (completion §2 W3.2): sharding management on a mongos — shard a collection, zones and
 * their key ranges, the balancer. Changes need databases:admin; the overview stays server:monitor.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

export const NamespaceSchema = z
  .string()
  .min(3)
  .max(255)
  .refine(
    (v) => !CONTROL.test(v) && v.indexOf('.') > 0 && v.indexOf('.') < v.length - 1 && !v.includes('$'),
    'Not a namespace',
  )

/** A shard key field: a path of plain names, never an operator. */
export const ShardKeyFieldSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (v) => !CONTROL.test(v) && !v.startsWith('$') && !v.split('.').some((p) => p === '' || p.startsWith('$')),
    'Not a field path',
  )

export const MAX_SHARD_KEY_FIELDS = 8

/** Fields in order, each ranged (1) or hashed; at most one hashed field. */
export const ShardKeySchema = z
  .array(z.strictObject({ field: ShardKeyFieldSchema, kind: z.enum(['ranged', 'hashed']) }))
  .min(1)
  .max(MAX_SHARD_KEY_FIELDS)
  .refine((k) => k.filter((f) => f.kind === 'hashed').length <= 1, 'At most one hashed field')
  .refine((k) => new Set(k.map((f) => f.field)).size === k.length, 'A field appears twice')
export type ShardKey = z.infer<typeof ShardKeySchema>

export const ShardCollectionSchema = z
  .strictObject({
    ns: NamespaceSchema,
    key: ShardKeySchema,
    unique: z.boolean().default(false),
    /** Hashed keys on an empty collection: chunks made up front (MongoDB 6.0 and earlier). */
    numInitialChunks: z.number().int().min(1).max(8192).optional(),
    /** Hashed keys with zones defined: chunks made per zone up front (MongoDB 4.4+). */
    presplitHashedZones: z.boolean().optional(),
    /** Must be true: sharding a collection cannot be undone (only resharded). */
    confirm: z.literal(true),
  })
  .superRefine((b, ctx) => {
    const hashed = b.key.some((f) => f.kind === 'hashed')
    if (b.unique && hashed)
      ctx.addIssue({ code: 'custom', path: ['unique'], message: 'A hashed shard key cannot be unique' })
    if ((b.numInitialChunks !== undefined || b.presplitHashedZones) && !hashed)
      ctx.addIssue({
        code: 'custom',
        path: ['numInitialChunks'],
        message: 'Presplitting needs a hashed shard key',
      })
  })
export type ShardCollectionInput = z.infer<typeof ShardCollectionSchema>

/** The key picker's hints: counts from a sample, never the values themselves. */
export const KeyHintsQuerySchema = z.strictObject({
  ns: NamespaceSchema,
  fields: z
    .string()
    .max(2048)
    .transform((v) => v.split(','))
    .pipe(z.array(ShardKeyFieldSchema).min(1).max(MAX_SHARD_KEY_FIELDS)),
})

export interface FieldHint {
  field: string
  /** Sampled documents that hold the field. */
  present: number
  /** Distinct values among them. */
  distinct: number
  /** The most frequent value's share of the sample (0–1): high means hot chunks. */
  topShare: number
  /** Values grow with insertion order (ObjectId, dates): ranged keys send every insert to one shard. */
  monotonic: boolean
}

export interface KeyHints {
  ns: string
  sampled: number
  /** Documents in the collection (estimated). */
  documents: number | null
  fields: FieldHint[]
  /** Distinct combinations of all the fields in the sample. */
  combined: { distinct: number; topShare: number }
  /** An index starts with these fields (needed unless the collection is empty). */
  indexed: boolean
  /** Already sharded: its current key. */
  shardedKey: Record<string, number | string> | null
  verdict: 'good' | 'fair' | 'poor'
}

export const ZoneNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => !CONTROL.test(v), 'Not a zone name')
export const ShardIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => !CONTROL.test(v), 'Not a shard name')

export const ZoneShardSchema = z.strictObject({
  shard: ShardIdSchema,
  zone: ZoneNameSchema,
  action: z.enum(['add', 'remove']),
})

/**
 * A zone's key range: bounds as extended JSON objects of the shard key's fields (MinKey and MaxKey
 * as {"$minKey":1} / {"$maxKey":1}). `zone: null` removes the range.
 */
export const ZoneRangeSchema = z.strictObject({
  ns: NamespaceSchema,
  min: z
    .string()
    .min(2)
    .max(16 * 1024),
  max: z
    .string()
    .min(2)
    .max(16 * 1024),
  zone: ZoneNameSchema.nullable(),
})

export const BalancerActionSchema = z.strictObject({ action: z.enum(['start', 'stop']) })
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM')
export const BalancerWindowSchema = z.strictObject({
  window: z.strictObject({ start: HHMM, stop: HHMM }).nullable(),
})

export interface ZonesView {
  shards: Array<{ id: string; zones: string[] }>
  zones: string[]
  /** Bounds as canonical extended JSON text. */
  ranges: Array<{ ns: string; min: string; max: string; zone: string }>
  more: boolean
  refused: Partial<Record<'shards' | 'ranges', string>>
}
