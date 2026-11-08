// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type {
  AiLine,
  AiModelsRequest,
  AiModelsResult,
  AiProviderInputBody,
  AiProviderPatchBody,
  AiProviderView,
  AiRequestBody,
  AiStatus,
} from '@mongo-manager/shared'
import { readNdjson } from '@/aggregation/ndjson'
import { api, path } from './client'
import type { CollectionTarget } from './documents'

export const aiKeys = {
  status: ['ai', 'status'] as const,
  providers: ['ai', 'providers'] as const,
}

/** Phase 4a-1 spec §3.4. */
export const aiApi = {
  status: () => api.get<AiStatus>('ai/status'),
  providers: () => api.get<AiProviderView[]>('ai/providers'),
  create: (body: AiProviderInputBody) => api.post<AiProviderView>('ai/providers', body),
  update: (id: string, body: AiProviderPatchBody) =>
    api.patch<AiProviderView>(path`ai/providers/${id}`, body),
  remove: (id: string) => api.delete<void>(path`ai/providers/${id}`),
  /** User review 2026-10-09: the models a provider offers (a saved key stays on the server). */
  models: (body: AiModelsRequest) => api.post<AiModelsResult>('ai/models', body),
  test: (id: string) =>
    api.post<{ outcome: string; local: boolean | null; ms: number }>(path`ai/providers/${id}/test`),
  /** One action, its lines handed over as they arrive. */
  async ask(
    target: CollectionTarget,
    body: AiRequestBody,
    onLine: (line: AiLine) => void,
    signal: AbortSignal,
  ) {
    const stream = await api.stream(
      path`connections/${target.connectionId}/databases/${target.db}/collections/${target.coll}/ai`,
      body,
      { signal },
    )
    // Final review minor 6: a network chunk's lines at once (the default batch), not one by one.
    await readNdjson(stream, (lines) => lines.forEach((l) => onLine(l as AiLine)), undefined, signal)
  },
}
