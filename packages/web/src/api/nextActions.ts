// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { NextActionsRankRequest, NextActionsRanked } from '@mongo-manager/shared/browser'
import { api } from './client'

/** completion W6.2: the Overview's next steps, put in order by the AI (when the user asks). */
export const nextActionsKeys = {
  rank: (signature: string) => ['me', 'next-actions', 'rank', signature] as const,
}

export const nextActionsApi = {
  rank: (request: NextActionsRankRequest) => api.post<NextActionsRanked>('me/next-actions/rank', request),
}
