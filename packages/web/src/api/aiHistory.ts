import type {
  AiHistoryItem,
  AiHistoryPage,
  AiHistorySettings,
  AiHistorySharing,
  AiHistoryThread,
  AiUsage,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'

/** User review 2026-10-09: the AI history — the user's own requests, usage and the days kept. */
export interface AiHistoryFilter {
  action?: string
  outcome?: 'ok' | 'failed'
  q?: string
  /** User review 2026-10-09: what teammates shared with the asker, not their own. */
  shared?: '1'
}

const query = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v))
  const text = s.toString()
  return text ? `?${text}` : ''
}

export const aiHistoryKeys = {
  all: ['ai', 'history'] as const,
  page: (f: AiHistoryFilter) => ['ai', 'history', 'page', f] as const,
  item: (id: string) => ['ai', 'history', 'item', id] as const,
  thread: (thread: string) => ['ai', 'history', 'thread', thread] as const,
  usage: (days: number, all: boolean, tz?: number) =>
    ['ai', 'history', 'usage', days, all, tz ?? null] as const,
  settings: ['ai', 'history', 'settings'] as const,
  sharing: ['ai', 'history', 'sharing'] as const,
  /** The steps of the entry a request is in (a teammate's shared one too). */
  chain: (id: string) => ['ai', 'history', 'chain', id] as const,
}

export const aiHistoryApi = {
  page: (f: AiHistoryFilter, before?: string, limit = 50) =>
    api.get<AiHistoryPage>(`ai/history${query({ ...f, before, limit })}`),
  get: (id: string) => api.get<AiHistoryItem>(path`ai/history/${id}`),
  remove: (id: string) => api.delete<void>(path`ai/history/${id}`),
  removeAll: () => api.delete<void>('ai/history'),
  /** User review 2026-10-09: a pipeline's first request and its refinements, in order. */
  thread: (thread: string) => api.get<AiHistoryThread>(path`ai/history/threads/${thread}`),
  removeThread: (thread: string) => api.delete<void>(path`ai/history/threads/${thread}`),
  /** With `tz` (minutes east of UTC), the usage by day in that time zone too. */
  usage: (days: number, all: boolean, tz?: number) =>
    api.get<AiUsage>(`ai/usage${query({ days, all: all ? 1 : undefined, tz })}`),
  settings: () => api.get<AiHistorySettings>('ai/history/settings'),
  saveSettings: (body: AiHistorySettings) => api.put<AiHistorySettings>('ai/history/settings', body),
  /** User review 2026-10-09: sharing with the team — whether there is a team, and sharing an entry. */
  sharing: () => api.get<AiHistorySharing>('ai/history/sharing'),
  share: (id: string) => api.post<{ shared: boolean }>(path`ai/history/${id}/share`),
  unshare: (id: string) => api.delete<{ shared: boolean }>(path`ai/history/${id}/share`),
  chain: (id: string) => api.get<AiHistoryThread>(path`ai/history/${id}/chain`),
}
