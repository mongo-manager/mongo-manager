// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type {
  ExplainRequest,
  ExplainResult,
  ValidationSaved,
  ValidationState,
  ValidationTestResult,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'
import type { CollectionTarget } from './documents'

const base = (t: CollectionTarget) =>
  path`connections/${t.connectionId}/databases/${t.db}/collections/${t.coll}`

/** Phase 2b: explain a query or a pipeline. */
export const explainApi = {
  explain: (t: CollectionTarget, body: ExplainRequest, signal?: AbortSignal) =>
    api.post<ExplainResult>(`${base(t)}/explain`, body, signal ? { signal } : undefined),
}

/** Phase 2b: a collection's validation rules. */
export const validationApi = {
  get: (t: CollectionTarget) => api.get<ValidationState>(`${base(t)}/validation`),
  set: (
    t: CollectionTarget,
    body: {
      validator: Record<string, unknown> | null
      validationLevel: ValidationState['validationLevel']
      validationAction: ValidationState['validationAction']
      /** The version the draft started from: the server refuses rules changed since. */
      expected?: string
    },
  ) => api.put<ValidationSaved>(`${base(t)}/validation`, body),
  test: (t: CollectionTarget, validator: Record<string, unknown>, signal?: AbortSignal) =>
    api.post<ValidationTestResult>(
      `${base(t)}/validation/test`,
      { validator },
      signal ? { signal } : undefined,
    ),
}

export const validationKeys = {
  state: (t: CollectionTarget) =>
    ['connections', t.connectionId, 'databases', t.db, 'collections', t.coll, 'validation'] as const,
}
