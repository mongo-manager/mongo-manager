// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Dashboard } from '@mongo-manager/shared/browser'
import { api } from './client'

/** User review 2026-10-09: the signed-in user's own Overview dashboard. */
export const dashboardApi = {
  /** `newer`: saved by a newer version of the app, not readable (nor to be overwritten) here. */
  get: () => api.get<{ dashboard: Dashboard | null; newer?: true }>('me/dashboard'),
  /** `keepalive`: sent as the page goes away, the request outlives it. */
  save: (dashboard: Dashboard, init?: { keepalive?: boolean }) =>
    api.put<{ dashboard: Dashboard }>('me/dashboard', dashboard, init),
  reset: () => api.delete<void>('me/dashboard'),
}
