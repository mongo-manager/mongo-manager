// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { useTabsStore } from '@/stores/tabs'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { connectionsApi } from '@/api/connections'
import { describeError } from '@/api/errors'
import { openCollectionTab } from '@/workspace/openTabs'
import { cardsFromStages } from './stages'

type Translate = (key: string, values?: Record<string, unknown>) => string

export interface ViewRef {
  connectionId: string
  db: string
  /** The view. */
  name: string
}

/**
 * W2.2 (2026-10-16): a view's pipeline opened in its source's aggregation builder, to change it
 * with previews of each stage, then write it back to the view (Update view). A pipeline with a stage
 * that cannot be read is not opened: saving it back would drop that stage. Stages already in the
 * source's builder are replaced only when the user says so.
 *
 * Re-review (minor 3): the definition is read as stored (GET .../view), not taken from the
 * collections listing, which promotes values: a double 1.0 stays a double, a Long a Long.
 */
export async function editViewPipeline(view: ViewRef, t: Translate): Promise<boolean> {
  const toasts = useToastStore()
  let definition: { viewOn: string; pipeline: unknown[] }
  try {
    definition = await connectionsApi.viewDefinition(view.connectionId, view.db, view.name)
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
    return false
  }
  const { cards, unreadable } = cardsFromStages(definition.pipeline)
  if (unreadable > 0) {
    toasts.push({ kind: 'error', message: t('aggregation.viewEdit.unreadable', { view: view.name }) })
    return false
  }
  const tabId = openCollectionTab(useTabsStore(), view.connectionId, view.db, definition.viewOn)
  const state = useCollectionViewsStore().stateFor(tabId)
  const agg = state.aggregation
  // Already being edited there: back to it, its changes kept.
  if (agg.editingView?.name === view.name) {
    state.section = 'aggregations'
    return true
  }
  if (agg.cards.length > 0 || (agg.textMode && agg.text.trim() !== '')) {
    const ok = await useDialogStore().confirm({
      title: t('library.replaceTitle'),
      message: t('aggregation.viewEdit.replaceMessage', {
        view: view.name,
        ns: `${view.db}.${definition.viewOn}`,
      }),
      confirmLabel: t('library.replace'),
    })
    if (!ok) return false
  }
  agg.cards = cards
  agg.textMode = false
  agg.saved = null
  agg.steps = []
  agg.stepAt = null
  agg.intent = null
  agg.aiThread = null
  agg.pane = 'pipeline'
  // The definition the edit starts from: an update made meanwhile is not overwritten (review I1).
  agg.editingView = { name: view.name, base: { viewOn: definition.viewOn, pipeline: definition.pipeline } }
  state.section = 'aggregations'
  return true
}
