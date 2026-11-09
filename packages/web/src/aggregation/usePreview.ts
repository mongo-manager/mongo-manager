// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { PreviewStageResult, Sample } from '@mongo-manager/shared/browser'
import { aggregateApi } from '@/api/aggregate'
import type { CollectionTarget, DocumentItem } from '@/api/documents'
import { toPipeline, type Card } from './stages'
import type { PreviewMemory } from './memory'

/** Phase 2a spec §4.4: previews wait this long after the last edit. */
export const PREVIEW_DEBOUNCE_MS = 400

/**
 * Previews of every enabled stage, from one request. Only the stages from the first one that
 * changed are asked for; a newer request aborts the older one, and a late answer to an old version
 * of the pipeline is dropped.
 */
export function usePreview(opts: {
  target: () => CollectionTarget
  cards: () => readonly Card[]
  sample: () => Sample
  /** Where the answers are kept between visits to the section (the tab's view state). */
  memory?: { load(): PreviewMemory | null; save(memory: PreviewMemory): void }
  /**
   * Plugins wave 1 review I2: stages (as text) not to preview while they are unchanged, and how to
   * let them go once they are not.
   */
  held?: () => string | null
  release?: () => void
}) {
  const built = computed(() => toPipeline(opts.cards()))
  /** Results by card id, from the last answer. */
  const results = ref<Record<string, PreviewStageResult>>({})
  const sample = ref<{
    documents: DocumentItem[]
    count: number
    truncated?: boolean
    more?: boolean
  } | null>(null)
  const pending = ref<ReadonlySet<string>>(new Set())
  const failure: Ref<unknown> = ref(null)
  /** Phase 3c §7: the output paths the server hides from this user, from the last answer. */
  const masked = ref<string[][]>([])

  /** What the last answer was for: the stages (as text) and the sample. */
  let sentStages: string[] = []
  let sentByIndex: Array<PreviewStageResult | null> = []
  let sentSample = ''
  /** The first stage of the last answer that failed: later stages depend on it. */
  let failedAt = -1
  let version = 0
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  // Back from another section: the last answers, so an unchanged pipeline is not asked for again.
  const kept = opts.memory?.load()
  if (kept) {
    sentStages = kept.stages
    sentSample = kept.sample
    sentByIndex = kept.byIndex
    failedAt = kept.failedAt
    results.value = kept.results
    sample.value = kept.sampleDocs
    masked.value = kept.masked
  }

  async function run(): Promise<void> {
    const pipeline = built.value
    // Spec §4.4: nothing is sent while a stage does not parse; the last previews stay.
    if (pipeline.error) return
    const held = opts.held?.() ?? null
    if (held !== null) {
      if (held === JSON.stringify(pipeline.stages)) return
      opts.release?.()
    }
    const texts = pipeline.stages.map((s) => JSON.stringify(s))
    const sampleKey = JSON.stringify(opts.sample())
    let from = 0
    if (sampleKey === sentSample)
      while (from < texts.length && from < sentStages.length && texts[from] === sentStages[from]) from++
    if (sampleKey === sentSample && from === texts.length && texts.length === sentStages.length) {
      // The same stages under new cards (Undo, a step gone back to, a saved pipeline): the answers
      // follow the stages, not the cards, so each card gets its own again without asking.
      const next: Record<string, PreviewStageResult> = {}
      pipeline.map.forEach((id, i) => {
        if (sentByIndex[i]) next[id] = sentByIndex[i]!
      })
      results.value = next
      return
    }
    // Stages after a failed one only say "skipped": ask from the failure so they keep saying why.
    if (failedAt >= 0 && failedAt < from) from = failedAt
    controller?.abort()
    const mine = new AbortController()
    controller = mine
    const current = ++version
    pending.value = new Set(pipeline.map.slice(from))
    try {
      const answer = await aggregateApi.preview(
        opts.target(),
        { stages: pipeline.stages, sample: opts.sample(), from },
        mine.signal,
      )
      if (current !== version) return
      const byIndex = pipeline.map.map((_, i) => answer.stages[i] ?? sentByIndex[i] ?? null)
      const next: Record<string, PreviewStageResult> = {}
      pipeline.map.forEach((id, i) => {
        if (byIndex[i]) next[id] = byIndex[i]!
      })
      results.value = next
      masked.value = answer.masked ?? []
      if (answer.sample)
        sample.value = answer.sample as {
          documents: DocumentItem[]
          count: number
          truncated?: boolean
          more?: boolean
        }
      sentStages = texts
      sentByIndex = byIndex
      failedAt = byIndex.findIndex((r) => r !== null && 'error' in r)
      sentSample = sampleKey
      failure.value = null
      opts.memory?.save({
        stages: sentStages,
        sample: sentSample,
        byIndex: sentByIndex,
        failedAt,
        results: next,
        sampleDocs: sample.value,
        masked: masked.value,
      })
    } catch (e) {
      if (current !== version) return
      failure.value = e
      // Asked again on the next edit: the answer never came.
      sentStages = []
      sentSample = ''
    } finally {
      if (current === version) pending.value = new Set()
    }
  }

  function schedule(): void {
    clearTimeout(timer)
    timer = setTimeout(() => void run(), PREVIEW_DEBOUNCE_MS)
  }

  watch(
    () => [JSON.stringify(built.value.stages), JSON.stringify(opts.sample()), opts.held?.() ?? null],
    schedule,
    { immediate: true },
  )
  onBeforeUnmount(() => {
    clearTimeout(timer)
    controller?.abort()
  })

  return { built, results, sample, pending, failure, masked }
}
