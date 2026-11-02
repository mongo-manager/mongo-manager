import { z } from 'zod'
import type { QueryOrigin } from './shell'

/** Phase 3b spec §4: the operation kinds the list filters by. */
export const OPERATION_KINDS = ['query', 'insert', 'update', 'remove', 'getmore', 'command'] as const
export type OperationKind = (typeof OPERATION_KINDS)[number]

const flag = z.enum(['true', 'false']).transform((v) => v === 'true')
const noNul = (v: string): boolean => !v.includes(String.fromCharCode(0))
const kinds = z
  .string()
  .max(200)
  .transform((v) => v.split(','))
  .pipe(z.array(z.enum(OPERATION_KINDS)).min(1).max(OPERATION_KINDS.length))

/** Query-string filters of GET /server/operations. */
export const OperationsQuerySchema = z.strictObject({
  ns: z.string().min(1).max(255).refine(noNul, 'NUL is not allowed').optional(),
  op: kinds.optional(),
  minSecs: z.coerce.number().min(0).max(86_400).optional(),
  waitingForLock: flag.optional(),
  idle: flag.optional(),
  own: flag.optional(),
  /** Third review of B3 (M8): one operation by its opid (a number, or a shard's "shard:123"). */
  opid: z
    .string()
    // Fifth review of B3 (I1): a number, or a shard's "name:number" (Atlas's names hold hyphens).
    .regex(/^(-?\d{1,20}|[A-Za-z0-9_.-]{1,42}:-?\d{1,20})$/)
    .optional(),
})
export type OperationsQuery = z.infer<typeof OperationsQuerySchema>

/** Phase 3b spec §3.1: a profiler change. Level 2 needs confirm (the UI warns first). */
export const ProfilerChangeSchema = z
  .strictObject({
    level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    slowms: z.number().int().min(0).max(3_600_000),
    sampleRate: z.number().min(0).max(1),
    confirm: z.boolean().optional(),
  })
  .refine((c) => c.level !== 2 || c.confirm === true, {
    message: 'Level 2 must be confirmed',
    path: ['confirm'],
  })
export type ProfilerChange = z.infer<typeof ProfilerChangeSchema>

const DB_NAME = /^[^/\\. "$*<>:|?]{1,64}$/

/** Phase 3b spec §3.2: query-string filters of GET /server/slow-queries. */
export const SlowQueriesQuerySchema = z
  .strictObject({
    db: z
      .string()
      .refine((v) => DB_NAME.test(v) && noNul(v), 'Not a database name')
      .optional(),
    coll: z.string().min(1).max(255).refine(noNul, 'NUL is not allowed').optional(),
    op: kinds.optional(),
    minMs: z.coerce.number().int().min(0).max(3_600_000).optional(),
    source: z.enum(['profile', 'log', 'both']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  // A collection is named inside its database (final review M7).
  .refine((q) => q.coll === undefined || q.db !== undefined, { message: 'coll needs db', path: ['coll'] })
export type SlowQueriesQuery = z.infer<typeof SlowQueriesQuerySchema>

/** One slow operation, from the profiler or the server log. */
export interface SlowQuery {
  source: 'profile' | 'log'
  ts: string
  ns: string
  op: string
  durationMs: number
  planSummary?: string
  keysExamined?: number
  docsExamined?: number
  nreturned?: number
  /** Secrets always hidden; personal values masked for a restricted user. */
  command: string
  /**
   * Index advice gaps (2026-10-27): the command's name and the structure of what it asked, every
   * value replaced by "?"; and MongoDB's hash of its shape (8.0+), when it gave one.
   */
  shape: string
  shapeHash?: string
  /** For "Open in Explain"; never sent to a restricted user. */
  origin?: QueryOrigin
}

/** Phase 3b spec §6: the ranges of stored metric history. */
export const HISTORY_RANGES = ['1h', '24h', '7d'] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]
export const HistoryQuerySchema = z.strictObject({ range: z.enum(HISTORY_RANGES) })
export const HistorySettingsSchema = z.strictObject({ enabled: z.boolean() })

/** Phase 3b spec §5: the sharding overview's filter, and the collection a detail is for. */
export const ShardingQuerySchema = z.strictObject({
  ns: z.string().min(1).max(255).refine(noNul, 'NUL is not allowed').optional(),
})
export const ShardingDetailQuerySchema = z.strictObject({
  ns: z
    .string()
    .min(3)
    .max(255)
    .refine((v) => noNul(v) && v.indexOf('.') > 0 && v.indexOf('.') < v.length - 1, 'Not a namespace'),
})

export interface ShardingView {
  shards: Array<{
    id: string
    hosts: string
    draining: boolean
    tags: string[]
    collections: number
    chunks: number
  }>
  balancer: {
    mode: string
    inRound: boolean
    rounds: number | null
    window: { start: string; stop: string } | null
  } | null
  mongos: Array<{
    host: string
    version: string | null
    upSeconds: number | null
    ping: string | null
    stale: boolean
  }>
  collections: Array<{
    ns: string
    key: Record<string, number | string>
    unique: boolean
    balancing: boolean
    chunks: Record<string, number>
    imbalance: number
    jumbo: number
  }>
  more: boolean
  refused: Partial<Record<'shards' | 'balancer' | 'mongos' | 'collections' | 'chunks', string>>
}

export interface ShardingDetail {
  ns: string
  shards: Array<{ shard: string; size: number | null; count: number | null }>
  /** Chunk bounds as canonical EJSON; personal values masked for a restricted user. */
  jumbo: Array<{ shard: string; min: unknown; max: unknown }>
  refused: Partial<Record<'stats' | 'jumbo', string>>
  /** The sizes are null: rules hide personal data in this collection from the caller. */
  sizesHidden?: true
}

/** Phase 3b spec §6a: index suggestions for one database's slow queries. */
export const IndexAdviceQuerySchema = z.strictObject({
  db: z.string().refine((v) => DB_NAME.test(v) && noNul(v), 'Not a database name'),
})

export interface IndexAdvice {
  /** Field names and directions only: the answer never holds a value. */
  suggestions: Array<{
    ns: string
    key: Array<[string, 1 | -1]>
    count: number
    totalMs: number
    avgMs: number
    /** Documents examined per document returned, on average; null when unknown. */
    ratio: number | null
    reason: { equality: string[]; sort: string[]; range: string[] }
  }>
  unneeded: Array<{
    ns: string
    name: string
    key: Record<string, unknown>
    /** 2026-10-27: `duplicate` — another index of the same key serves it whole. */
    reason: 'unused' | 'prefix' | 'duplicate'
    of?: string
    /** Its operations since the server started; null when MongoDB did not say. */
    ops: number | null
    /** Its size on disk; null when hidden from the caller (personal data rules) or not known. */
    sizeBytes: number | null
    /** The size is hidden (personal data rules), not merely unknown. */
    sizeHidden?: true
  }>
  /** Unneeded indexes past the 200 listed. */
  moreUnneeded?: number
  /** Collections whose indexes were not read: at most 200 are, those of slow queries first. */
  skipped: number
  refused: Partial<Record<'profile' | 'log' | 'indexes', string>>
}

/** Widgets wave 2 (2026-10-27): one kind of operation on a collection, from $collStats latencyStats. */
export interface LatencyOfKind {
  ops: number
  /** Milliseconds per operation; null without operations. */
  avgMs: number | null
  /** The lower bound (ms) of the histogram bucket the 95th percentile falls in; null without any. */
  p95Ms: number | null
}

/** Widgets wave 2: a busy collection's latency (Atlas Namespace Insights); null where MongoDB refused. */
export interface CollectionLatency {
  ns: string
  reads: LatencyOfKind | null
  writes: LatencyOfKind | null
  commands: LatencyOfKind | null
}

/**
 * Widgets wave 2: a server's facts and start-up warnings (mongosh's banner) — never its host name, an
 * address or a path; a fact MongoDB refused is null, and named in `refused`.
 */
export interface ServerFacts {
  version: string | null
  fcv: string | null
  storageEngine: string | null
  cores: number | null
  memoryMb: number | null
  os: { type: string | null; name: string | null } | null
  warnings: string[] | null
  refused: Array<'buildInfo' | 'hostInfo' | 'fcv' | 'warnings' | 'status'>
}
