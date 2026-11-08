// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type {
  AiChatCollectionTurnBody,
  AiChatLine,
  AiChatSummary,
  AiChatTurnBody,
  AiChatView,
} from '@mongo-manager/shared'
import { readNdjson } from '@/aggregation/ndjson'
import { api, path } from './client'
import type { CollectionTarget } from './documents'

export const aiChatKeys = { list: ['ai', 'chats'] as const }

/** Phase 4a-2 spec §2.5. */
export const aiChatApi = {
  list: () => api.get<AiChatSummary[]>('ai/chats'),
  get: (id: string) => api.get<AiChatView>(path`ai/chats/${id}`),
  rename: (id: string, title: string) =>
    api.patch<{ id: string; title: string }>(path`ai/chats/${id}`, { title }),
  remove: (id: string) => api.delete<void>(path`ai/chats/${id}`),
  removeAll: () => api.delete<{ removed: number }>('ai/chats'),
  /** One turn — about a collection, or general — its lines handed over a network chunk at a time. */
  async send(
    target: CollectionTarget | null,
    body: AiChatTurnBody | AiChatCollectionTurnBody,
    onLine: (line: AiChatLine) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const stream = await api.stream(
      target
        ? path`connections/${target.connectionId}/databases/${target.db}/collections/${target.coll}/ai/chat`
        : 'ai/chat',
      body,
      { signal },
    )
    await readNdjson(stream, (lines) => lines.forEach((l) => onLine(l as AiChatLine)), undefined, signal)
  },
}
