// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { EjsonObjectSchema } from './data'

/** Phase 2b spec §2.1: what to explain, and how much of it. */
const Common = {
  verbosity: z.enum(['queryPlanner', 'executionStats', 'allPlansExecution']).default('executionStats'),
  maxTimeMS: z.number().int().min(100).max(120_000).default(30_000),
}

export const ExplainRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('find'),
    filter: EjsonObjectSchema.default({}),
    projection: EjsonObjectSchema.optional(),
    sort: EjsonObjectSchema.optional(),
    collation: EjsonObjectSchema.optional(),
    hint: z.union([z.string().min(1).max(512), EjsonObjectSchema]).optional(),
    skip: z.number().int().min(0).max(1_000_000_000).optional(),
    limit: z.number().int().min(0).max(1_000_000).optional(),
    ...Common,
  }),
  z.object({
    kind: z.literal('aggregate'),
    stages: z.array(EjsonObjectSchema).max(100),
    ...Common,
  }),
])
export type ExplainRequest = z.input<typeof ExplainRequestSchema>
export type ExplainVerbosity = z.infer<typeof ExplainRequestSchema>['verbosity']

export interface ExplainPlanNode {
  stage: string
  indexName?: string
  keyPattern?: Record<string, unknown>
  direction?: string
  isMultiKey?: boolean
  filter?: string
  nReturned?: number
  docsExamined?: number
  keysExamined?: number
  executionTimeMillisEstimate?: number
  foreignCollection?: string
  foreignField?: string
  children: ExplainPlanNode[]
}

export interface ExplainSummary {
  nReturned?: number
  queryReturned?: number
  planCacheUsed?: boolean
  executionTimeMillis?: number
  totalKeysExamined?: number
  totalDocsExamined?: number
}

export type ExplainWarningCode =
  | 'COLLSCAN'
  | 'IN_MEMORY_SORT'
  | 'LOW_SELECTIVITY'
  | 'FETCH_FILTER'
  | 'SLOW_STAGE'
  | 'UNINDEXED_LOOKUP'
  | 'INCOMPLETE'

export interface ExplainResult {
  summary: ExplainSummary
  winning: ExplainPlanNode | null
  rejected: ExplainPlanNode[]
  pipeline: Array<{ stage: string; nReturned?: number; executionTimeMillisEstimate?: number }>
  shards?: Array<{ shard: string; summary: ExplainSummary; winning: ExplainPlanNode | null }>
  engine: 'classic' | 'sbe'
  incomplete?: { code?: number; message?: string; planOnly?: true }
  warnings: Array<{ code: ExplainWarningCode; stage?: string; detail?: Record<string, unknown> }>
  suggestion: {
    key: Array<[string, 1 | -1]>
    reason: { equality: string[]; sort: string[]; range: string[]; inWithSort?: true }
  } | null
  /** The explain output as MongoDB gave it, canonical EJSON. */
  raw: unknown
}
