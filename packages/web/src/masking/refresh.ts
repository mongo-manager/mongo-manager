// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { QueryClient } from '@tanstack/vue-query'

/**
 * Personal-data rules were added to a target (by a restore, a copy or a live sync). In local mode
 * they hide values from the local user there too: every view is read again, never left showing what
 * is hidden now (review 2026-10-13, minor 6).
 */
export const afterRulesAdded = (client: QueryClient): Promise<void> => client.invalidateQueries()
