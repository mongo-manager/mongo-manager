// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { UpdateStatus } from '@mongo-manager/shared/browser'
import { api } from './client'

/** The updater (2026-11-03): the version, the check, its daily setting and the install. */
export const updatesApi = {
  status: () => api.get<UpdateStatus>('updates'),
  check: () => api.post<UpdateStatus>('updates/check'),
  setAuto: (auto: boolean) => api.put<UpdateStatus>('updates/settings', { auto }),
  install: (version: string, confirmJobs: boolean) =>
    api.post<UpdateStatus>('updates/install', confirmJobs ? { version, confirmJobs: true } : { version }),
}
