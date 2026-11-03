import type {
  PipelineAssistant,
  PreviewResponse,
  Sample,
  SavedPipelineView,
  WritePreview,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'
import type { CollectionTarget } from './documents'

const base = (t: CollectionTarget) =>
  path`connections/${t.connectionId}/databases/${t.db}/collections/${t.coll}`

export interface PreviewBody {
  stages: Record<string, unknown>[]
  sample: Sample
  from: number
  perStage?: number
}

export interface RunBody {
  stages: Record<string, unknown>[]
  limit?: number
  allowDiskUse?: boolean
  maxTimeMS?: number
  /** Design 2026-10-25 (B5): false for a run the person did not write (an agent step's): no recent pipeline. */
  remember?: boolean
}

/** Phase 2a: the aggregation builder's routes. Stages are canonical EJSON. */
export const aggregateApi = {
  preview: (t: CollectionTarget, body: PreviewBody, signal?: AbortSignal) =>
    api.post<PreviewResponse>(`${base(t)}/aggregate/preview`, body, signal ? { signal } : undefined),
  /** The pipeline's output as NDJSON lines (RunLine), read with readNdjson. */
  run: (t: CollectionTarget, body: RunBody, signal?: AbortSignal) =>
    api.stream(`${base(t)}/aggregate/run`, body, signal ? { signal } : undefined),
  count: (t: CollectionTarget, stages: Record<string, unknown>[], signal?: AbortSignal) =>
    api.post<{ count: number }>(`${base(t)}/aggregate/count`, { stages }, signal ? { signal } : undefined),
  writePreview: (t: CollectionTarget, stages: Record<string, unknown>[]) =>
    api.post<WritePreview>(`${base(t)}/aggregate/write-preview`, { stages }),
  write: (t: CollectionTarget, stages: Record<string, unknown>[], token: string, confirm?: string) =>
    api.post<{ ok: true; target: { db: string; coll: string } }>(`${base(t)}/aggregate/write`, {
      stages,
      token,
      ...(confirm ? { confirm } : {}),
    }),
  pipelines: {
    list: (t: CollectionTarget) => api.get<{ pipelines: SavedPipelineView[] }>(`${base(t)}/pipelines`),
    create: (
      t: CollectionTarget,
      body: {
        name: string
        stages: unknown[]
        shared: boolean
        tags?: string[]
        /** UI redesign R1 review: the assistant's steps, kept with the pipeline for its owner. */
        assistant?: PipelineAssistant
      },
    ) => api.post<SavedPipelineView>(`${base(t)}/pipelines`, body),
    update: (
      t: CollectionTarget,
      id: string,
      body: {
        name: string
        stages: unknown[]
        shared: boolean
        tags?: string[]
        /** UI redesign R1 review: the assistant's steps, kept with the pipeline for its owner. */
        assistant?: PipelineAssistant
      },
    ) => api.put<SavedPipelineView>(`${base(t)}/pipelines/${encodeURIComponent(id)}`, body),
    remove: (t: CollectionTarget, id: string) =>
      api.delete<void>(`${base(t)}/pipelines/${encodeURIComponent(id)}`),
  },
}

export const aggregateKeys = {
  pipelines: (t: CollectionTarget) =>
    ['connections', t.connectionId, 'databases', t.db, 'collections', t.coll, 'pipelines'] as const,
}
