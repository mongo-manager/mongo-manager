// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { PluginAdminView, PluginRuntimeView } from '@mongo-manager/shared/browser'
import { api, path } from './client'

/** Phase 4b §2–3: the plugins that run, and their management by administrators. */
export interface PluginsManage {
  /** False when the server turned plugins off (MM_PLUGINS=0). */
  enabled: boolean
  /** Installing from GitHub releases (off unless MM_PLUGINS_GITHUB=1). */
  github?: boolean
  plugins: PluginAdminView[]
}

export interface FrameTicket {
  /** Relative to the app's base: `plugin-frame/<ticket>/`. */
  base: string
  entry: string
  expiresAt: number
}

export const pluginKeys = {
  runtime: ['plugins', 'runtime'] as const,
  manage: ['plugins', 'manage'] as const,
}

export const pluginsApi = {
  runtime: () => api.get<PluginRuntimeView[]>('plugins'),
  manage: () => api.get<PluginsManage>('plugins/manage'),
  /** User request 2026-10-10: a plugin's README for its details page (null: it has none). */
  readme: (id: string, lang: string) =>
    api.get<{ text: string | null; truncated: boolean }>(
      `${path`plugins/${id}/readme`}?lang=${/^[a-z]{2}$/.test(lang) ? lang : 'en'}`,
    ),
  scan: () => api.post<PluginsManage>('plugins/scan'),
  /** User request 2026-10-11: a plugin from a public GitHub repository's release. */
  installGithub: (url: string) => api.post<PluginAdminView>('plugins/github', { url }),
  upload: (file: Blob) => api.putBytes<PluginAdminView>('plugins', file),
  /** `acceptRisk`: its id, typed, when its scan found high risks (user request 2026-10-11). */
  approve: (id: string, digest: string, acceptRisk?: string) =>
    api.post<PluginAdminView>(path`plugins/${id}/approve`, acceptRisk ? { digest, acceptRisk } : { digest }),
  disable: (id: string) => api.post<PluginAdminView>(path`plugins/${id}/disable`),
  settings: (id: string, values: Record<string, string | boolean>) =>
    api.put<PluginAdminView>(path`plugins/${id}/settings`, { values }),
  remove: (id: string) => api.delete<void>(path`plugins/${id}`),
  ticket: (id: string) => api.get<FrameTicket>(path`plugins/${id}/ticket`),
}
