// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { CollectionTarget } from '@/api/documents'
import { cardsFromStages, toPipeline } from '@/aggregation/stages'
import { findParts } from '@/library/openItem'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useDialogStore } from '@/stores/dialogs'
import { useTabsStore } from '@/stores/tabs'
import { openCollectionTab } from '@/workspace/openTabs'

type Translate = (key: string, values?: Record<string, unknown>) => string

/**
 * Plugins wave 1 (`ui.useQuery`): a query a plugin made, put in the Documents section of its
 * collection's tab (opened or brought forward) — shown there as if the user had typed it.
 */
export function useQueryIn(target: CollectionTarget, body: Record<string, unknown>): void {
  const tabId = openCollectionTab(useTabsStore(), target.connectionId, target.db, target.coll)
  const state = useCollectionViewsStore().stateFor(tabId)
  // The page size stays the user's: a plugin's limit is no page size.
  const limit = state.draft.limit
  const parts = findParts(body, limit)
  state.section = 'documents'
  state.draft = { ...parts.draft, limit }
  // A query with {{parameters}} waits in the bar for their values (query parameters, 2026-10-28).
  if (parts.query === null) return
  state.query = { ...parts.query, limit }
  state.page = 0
}

/**
 * Research 2026-10-28 (`ui.suggestPersonalData`): fields a plugin suggests as personal data, listed
 * in its collection tab's Personal data section (opened or brought forward). Nothing is saved: an
 * administrator adds each there, with the section's own save.
 */
export function suggestPersonalIn(target: CollectionTarget, by: string, fields: string[]): void {
  const tabId = openCollectionTab(useTabsStore(), target.connectionId, target.db, target.coll)
  const state = useCollectionViewsStore().stateFor(tabId)
  state.personalSuggested = { by, fields }
  state.section = 'personalData'
}

/**
 * Plugins wave 1 (`ui.useAggregation`): stages a plugin made, put in the Aggregations section of
 * its collection's tab as cards, after asking (naming the plugin) when a pipeline is there already.
 * Nothing runs, not even a preview, until the user changes them or asks (review I2).
 */
export async function useAggregationIn(
  target: CollectionTarget,
  stages: Record<string, unknown>[],
  plugin: string,
  t: Translate,
  signal?: AbortSignal,
): Promise<boolean> {
  const tabId = openCollectionTab(useTabsStore(), target.connectionId, target.db, target.coll)
  const state = useCollectionViewsStore().stateFor(tabId)
  const agg = state.aggregation
  if (agg.cards.length > 0 || (agg.textMode && agg.text.trim() !== '')) {
    const ok = await useDialogStore().confirm({
      signal,
      title: t('library.replaceTitle'),
      message: t('plugins.bridge.replaceMessage', { plugin, ns: `${target.db}.${target.coll}` }),
      confirmLabel: t('library.replace'),
    })
    if (!ok) return false
  }
  const cards = cardsFromStages(stages).cards
  agg.cards = cards
  agg.textMode = false
  agg.saved = null
  agg.pane = 'pipeline'
  agg.handed = { by: plugin, stages: JSON.stringify(toPipeline(cards).stages) }
  state.section = 'aggregations'
  return true
}
