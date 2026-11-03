import type { Document } from 'mongodb'

/** Phase 2b spec §2.1: one stage of a query plan, whatever engine or version produced it. */
export interface PlanNode {
  stage: string
  indexName?: string
  keyPattern?: Document
  direction?: string
  isMultiKey?: boolean
  /** The stage's filter as shell text, cut at 500 characters. */
  filter?: string
  nReturned?: number
  docsExamined?: number
  keysExamined?: number
  executionTimeMillisEstimate?: number
  /** Joins pushed into the query plan (EQ_LOOKUP). */
  foreignCollection?: string
  foreignField?: string
  children: PlanNode[]
}

export interface ExplainSummary {
  nReturned?: number
  /** An aggregation: what the query (the cursor) returned, before the later stages. */
  queryReturned?: number
  /** The plan came from the plan cache. */
  planCacheUsed?: boolean
  executionTimeMillis?: number
  totalKeysExamined?: number
  totalDocsExamined?: number
}

export interface PipelineStage {
  stage: string
  nReturned?: number
  executionTimeMillisEstimate?: number
  /** $lookup stages left in the pipeline: what they join. */
  from?: string
  foreignField?: string
}

export interface ExplainView {
  summary: ExplainSummary
  /** Null when no plan could be read: the raw output is still there. */
  winning: PlanNode | null
  rejected: PlanNode[]
  /** Aggregations: the stages that run after the query (the cursor). */
  pipeline: PipelineStage[]
  shards?: Array<{ shard: string; summary: ExplainSummary; winning: PlanNode | null }>
  engine: 'classic' | 'sbe'
  /**
   * The run stopped early (its time limit, code 50, or another failure): the numbers are partial.
   * `planOnly`: it stopped at its limit before MongoDB gave anything, and this is the plan alone,
   * without numbers.
   */
  incomplete?: { code?: number; message?: string; planOnly?: true }
  raw: Document
}

export type WarningCode =
  | 'COLLSCAN'
  | 'IN_MEMORY_SORT'
  | 'LOW_SELECTIVITY'
  | 'FETCH_FILTER'
  | 'SLOW_STAGE'
  | 'UNINDEXED_LOOKUP'
  | 'INCOMPLETE'

export interface Warning {
  code: WarningCode
  stage?: string
  detail?: Record<string, unknown>
}

export interface IndexSuggestion {
  key: Array<[string, 1 | -1]>
  reason: { equality: string[]; sort: string[]; range: string[]; inWithSort?: true }
}
