// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { SnippetBody, SnippetView } from '@mongo-manager/shared/browser'
import { api, path } from './client'

const base = (connectionId: string) => path`connections/${connectionId}/snippets`

/** Phase 3a-2 spec §3.5: a connection's shell snippets (own and shared). */
export const snippetsApi = {
  /** `truncated`: some were left out to keep the answer bounded. */
  list: (connectionId: string) =>
    api.get<{ snippets: SnippetView[]; truncated?: boolean }>(base(connectionId)),
  get: (connectionId: string, id: string) =>
    api.get<SnippetView>(`${base(connectionId)}/${encodeURIComponent(id)}`),
  create: (connectionId: string, body: SnippetBody) => api.post<SnippetView>(base(connectionId), body),
  update: (connectionId: string, id: string, body: SnippetBody) =>
    api.put<SnippetView>(`${base(connectionId)}/${encodeURIComponent(id)}`, body),
  remove: (connectionId: string, id: string) =>
    api.delete<void>(`${base(connectionId)}/${encodeURIComponent(id)}`),
}
