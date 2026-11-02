import { api, path } from './client'

/** Phase 3a-1: the connection's shell command history, for the terminal. */
export interface ShellHistoryEntry {
  id: string
  code: string
  usedAt: number
  count: number
}

export const shellApi = {
  history: (connectionId: string) =>
    api.get<{ entries: ShellHistoryEntry[] }>(path`connections/${connectionId}/shell/history`),
  clearHistory: (connectionId: string) => api.delete<void>(path`connections/${connectionId}/shell/history`),
}
