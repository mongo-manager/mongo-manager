import { z } from 'zod'
import { EjsonObjectSchema } from './data'
import { TagsSchema } from './library'

/** The most stages an aggregation route takes (the AI agent bounds what the gate adds by it). */
export const MAX_STAGES = 100
/** Phase 2a spec §3: requests of the aggregation routes. Stages are canonical EJSON objects. */
const Stages = (min: number) => z.array(EjsonObjectSchema).min(min).max(MAX_STAGES)

export const SampleSchema = z.object({
  mode: z.enum(['limit', 'sample']).default('limit'),
  size: z.number().int().min(1).max(100_000).default(1000),
})
export type Sample = z.infer<typeof SampleSchema>

export const PreviewRequestSchema = z.object({
  stages: Stages(0),
  sample: SampleSchema.default({ mode: 'limit', size: 1000 }),
  perStage: z.number().int().min(1).max(50).default(20),
  maxTimeMS: z.number().int().min(100).max(60_000).default(10_000),
  /** The first stage index whose preview the client needs; earlier ones answer null. */
  from: z.number().int().min(0).max(100).default(0),
})
export type PreviewRequest = z.infer<typeof PreviewRequestSchema>

export const RunRequestSchema = z.object({
  stages: Stages(1),
  limit: z.number().int().min(1).max(10_000).default(1000),
  allowDiskUse: z.boolean().default(true),
  maxTimeMS: z.number().int().min(100).max(300_000).default(60_000),
  batchSize: z.number().int().min(1).max(1000).default(100),
  /** Write pipelines: the token from write-preview, and the target name when it is replaced. */
  token: z.string().max(2048).optional(),
  confirm: z.string().max(255).optional(),
  /** Plugins wave 1: false for a run the user did not write (a plugin's): it is no recent pipeline. */
  remember: z.boolean().default(true),
})
export type RunRequest = z.infer<typeof RunRequestSchema>

/**
 * A confirmed $out/$merge (final review 2a, I7): it may take long, and $merge is not atomic, so it
 * gets 30 minutes by default (24 hours at most) instead of a read's minute.
 */
export const WriteRequestSchema = z.object({
  stages: Stages(1),
  token: z.string().max(2048).optional(),
  confirm: z.string().max(255).optional(),
  allowDiskUse: z.boolean().default(true),
  maxTimeMS: z.number().int().min(1000).max(86_400_000).default(1_800_000),
})

export const AggregateCountRequestSchema = z.object({
  stages: Stages(0),
  maxTimeMS: z.number().int().min(100).max(300_000).default(30_000),
})

export const WritePreviewRequestSchema = z.object({ stages: Stages(1) })

/**
 * UI redesign R1 review: the assistant's steps that led to a saved pipeline — each request, the
 * assistant's reply, the stages it wrote and what changed — kept with it for its owner.
 */
export const PipelineAssistantSchema = z.object({
  steps: z
    .array(
      z.object({
        prompt: z.string().max(2000),
        reply: z.string().max(1000).default(''),
        stages: Stages(0),
        changes: z
          .array(
            z.object({
              kind: z.enum(['added', 'changed', 'removed']),
              operator: z.string().max(64),
              n: z.number().int().min(1).max(1000),
            }),
          )
          .max(100)
          .default([]),
      }),
    )
    .max(8),
})
export type PipelineAssistant = z.infer<typeof PipelineAssistantSchema>

export const SavedPipelineBodySchema = z.object({
  name: z
    .string()
    .max(100)
    .refine((s) => s.trim().length > 0, 'A name is required'),
  stages: Stages(0),
  tags: TagsSchema.default([]),
  shared: z.boolean().default(false),
  assistant: PipelineAssistantSchema.optional(),
})
export type SavedPipelineBody = z.infer<typeof SavedPipelineBodySchema>
/** A change: tags left out stay as they are (final review 2c, Minor 6). */
export const SavedPipelineUpdateSchema = SavedPipelineBodySchema.extend({ tags: TagsSchema.optional() })

/** One document as the server sends it: canonical EJSON plus its hash, or why it cannot be shown. */
export type WireDocumentItem =
  { document: unknown; hash: string } | { unsupported: { _id: unknown; reason: string } }

export type PreviewStageResult =
  | { documents: WireDocumentItem[]; count: number; truncated?: boolean }
  | { error: { code: string; message: string } }
  | { skipped: 'write' | 'previous' }

export interface PreviewResponse {
  /** What the pipeline starts from: the sample itself. */
  sample: { documents: WireDocumentItem[]; count: number } | null
  /** One entry per stage sent; null before `from`. */
  stages: Array<PreviewStageResult | null>
  /** Phase 3c §7: the output paths hidden from this user, as rule segments (restricted users only). */
  masked?: string[][]
}

export type RunLine =
  | { document: unknown; hash: string }
  | { unsupported: { _id: unknown; reason: string } }
  | { end: { count: number; truncated: boolean; bytes: number } }
  | { error: { code: string; message: string } }

export interface WritePreview {
  target: { db: string; coll: string }
  stage: '$out' | '$merge'
  exists: boolean
  estimatedCount: number | null
  token: string
  /** `$out` replaces an existing collection: its name must be typed. */
  confirmRequired: boolean
}

export interface SavedPipelineView {
  id: string
  name: string
  stages: unknown[]
  tags: string[]
  shared: boolean
  mine: boolean
  owner: string | null
  updatedAt: string
  /** The assistant's steps, to their owner only (they are the owner's own words). */
  assistant?: PipelineAssistant
}
