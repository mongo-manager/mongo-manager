// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Collection, Document } from 'mongodb'
import {
  stageOperator,
  type PreviewResponse,
  type PreviewStageResult,
  type Sample,
} from '@mongo-manager/shared'
import { AppError } from '../errors'
import { READ_OPTIONS, type DocumentItem } from '../data/ejson-io'
import { toAppError } from '../data/mongo-errors'
import { previewKey, type PreviewCache } from './cache'
import { FIRST_STAGES } from './first-stages'

/** At most this many prefixes run at once for one preview request (spec §3.3). */
export const PREVIEW_CONCURRENCY = 4
/** A stage's preview is cut at this much encoded output (final review 2a, I4). */
export const STAGE_PREVIEW_BYTES = 4 * 1024 * 1024
export { FIRST_STAGES }

export interface PreviewInput {
  collection: Collection
  stages: Document[]
  sample: Sample
  perStage: number
  maxTimeMS: number
  from: number
  comment: string
  cache: PreviewCache
  scope: {
    userId: string | null
    connectionId: string
    db: string
    coll: string
    epoch?: string
    /** Masked or full results (phase 3c §4.8): never served from each other's entries. */
    view: string
  }
  /** True once the client has gone: no further prefix is started (final review 2a, I5). */
  gone?: () => boolean
  /** How a document is shown: pinned with the server key, masked for a restricted user (phase 3c). */
  present: (doc: Document) => DocumentItem
  /** Phase 3c §3.4: the stages as the gate rewrote them, and where each user stage ends among them. */
  guarded?: { stages: Document[]; ends: number[] }
  /**
   * Eleventh review of explain masking (I1): the gate's order, before the sample's $limit draws the
   * first documents (else it draws them in a hidden value's order: clustered by a hidden _id, a
   * time series by a hidden field).
   */
  ordered?: Document[]
  /** How a MongoDB error is shown (phase 3c §4.7: codes only for a restricted user). */
  describe?: (e: AppError) => AppError
}

/** Runs `tasks` with at most `limit` in flight, keeping their order in the result. */
async function pooled<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  stop: () => boolean = () => false,
): Promise<Array<T | undefined>> {
  const results = new Array<T | undefined>(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length && !stop()) {
      const i = next++
      results[i] = await tasks[i]!()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

/**
 * Phase 2a spec §3.2: each stage's output on a sample, from one request. Stage i runs as
 * `[sample, ...stages[0..i], $limit perStage]`; the prefixes run in parallel (at most 4) and are
 * cached for 60 s, so an edit at stage k recomputes only k and after. Write stages never run.
 */
export async function runPreview(input: PreviewInput): Promise<PreviewResponse> {
  const { stages, sample, perStage } = input
  const head: Document =
    sample.mode === 'sample' ? { $sample: { size: sample.size } } : { $limit: sample.size }
  const writeAt = stages.findIndex((s) => {
    const op = stageOperator(s)
    return op === '$out' || op === '$merge'
  })

  const first = FIRST_STAGES.has(stageOperator(stages[0]) ?? '')
  /** The pipeline of a prefix: the sample first, unless stage 0 must come first. */
  const drawn = sample.mode === 'sample' ? [head] : [...(input.ordered ?? []), head]
  // A stage that must come first ($geoNear) is followed by the gate's tie order: the sample comes
  // after all of it (twelfth review, I-1). Where that order is random, each stage's preview draws
  // its own sample (twelfth review, M-1: a documented limit).
  const firstEnds = input.guarded?.ends[0] ?? 1
  const pipelineOf = (prefix: Document[]) =>
    first && prefix.length > 0
      ? [...prefix.slice(0, firstEnds), head, ...prefix.slice(firstEnds)]
      : [...drawn, ...prefix]

  /** The stages that run for the first k user stages: the gate's rewrite when there is one. */
  const executed = (k: number): Document[] =>
    input.guarded
      ? input.guarded.stages.slice(0, k === 0 ? 0 : input.guarded.ends[k - 1])
      : stages.slice(0, k)

  const run = async (k: number): Promise<PreviewStageResult> => {
    const prefix = executed(k)
    const key = previewKey({ ...input.scope, sample, perStage, stages: stages.slice(0, k) })
    const cached = input.cache.get(key)
    if (cached) return cached
    try {
      // Security review 2026-10-13 (M3): read one by one, kept up to the byte cap and only counted
      // after it — never the whole stage (50 documents of up to 16 MB) at once.
      const cursor = input.collection.aggregate([...pipelineOf(prefix), { $limit: perStage }], {
        ...READ_OPTIONS,
        allowDiskUse: true,
        maxTimeMS: input.maxTimeMS,
        comment: input.comment,
      })
      const documents = []
      let bytes = 0
      let truncated = false
      let count = 0
      try {
        for await (const doc of cursor) {
          count++
          if (truncated) continue
          const item = input.present(doc)
          const size = JSON.stringify(item).length
          if (bytes + size > STAGE_PREVIEW_BYTES) {
            truncated = true
            continue
          }
          bytes += size
          documents.push(item)
        }
      } finally {
        await cursor.close().catch(() => undefined)
      }
      const result: PreviewStageResult = {
        documents,
        count,
        ...(truncated ? { truncated } : {}),
      }
      input.cache.set(key, result, bytes)
      return result
    } catch (e) {
      const error = toAppError(e)
      // Not a MongoDB answer: a bug, reported as one.
      if (!(error instanceof AppError)) throw e
      const shown = input.describe ? input.describe(error) : error
      return { error: { code: shown.code, message: shown.message } }
    }
  }

  const wanted: number[] = []
  for (let i = input.from; i < stages.length; i++) if (writeAt === -1 || i < writeAt) wanted.push(i)
  const tasks: Array<() => Promise<PreviewStageResult>> = wanted.map((i) => () => run(i + 1))
  if (input.from === 0) tasks.unshift(() => run(0))
  const results = await pooled(tasks, PREVIEW_CONCURRENCY, input.gone)
  const sampleResult = input.from === 0 ? results.shift()! : null

  const out: Array<PreviewStageResult | null> = stages.map(() => null)
  wanted.forEach((i, k) => (out[i] = results[k] ?? null))
  if (writeAt !== -1)
    for (let i = Math.max(writeAt, input.from); i < stages.length; i++) out[i] = { skipped: 'write' }
  // A stage that fails makes every later prefix fail the same way: those say why instead.
  const failed = out.findIndex((r) => r !== null && 'error' in r)
  if (failed !== -1)
    for (let i = failed + 1; i < out.length; i++) if (out[i]) out[i] = { skipped: 'previous' }
  return {
    sample: sampleResult && 'documents' in sampleResult ? sampleResult : null,
    stages: out,
  }
}
