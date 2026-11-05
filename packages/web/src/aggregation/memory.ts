// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { PreviewStageResult } from '@mongo-manager/shared/browser'
import type { DocumentItem } from '@/api/documents'

/**
 * UI redesign R1 review ("her seferinde yeniden çalışıyor"): what Aggregations had on screen, kept
 * with the tab while other sections are looked at — never re-asked while the pipeline and the sample
 * are the same. It lives in the tab's view state, so closing the tab or signing out forgets it.
 */
export interface PreviewMemory {
  /** The stages (as text) and sample the answers are for. */
  stages: string[]
  sample: string
  byIndex: Array<PreviewStageResult | null>
  failedAt: number
  results: Record<string, PreviewStageResult>
  sampleDocs: { documents: DocumentItem[]; count: number; truncated?: boolean } | null
  masked: string[][]
}

export interface RunMemory {
  /** The stages (as text) the run was for: shown again only for the same pipeline. */
  stages: string
  state: 'done' | 'stopped' | 'error'
  items: DocumentItem[]
  end: { count: number; truncated: boolean } | null
  error: string | null
  elapsed: number
  total: number | null
  /** The limit the run used (reviewer C I4). */
  limit: number
}

export interface AggregationMemory {
  preview: PreviewMemory | null
  run: RunMemory | null
}
