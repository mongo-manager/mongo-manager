// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { AiHistoryContent, AiHistoryItem, AiResult } from '@mongo-manager/shared/browser'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCollectionPresence } from '@/connections/presence'
import { useTabsStore } from '@/stores/tabs'
import { openCollectionTab } from '@/workspace/openTabs'
import { insertResult } from '@/ai/insert'

/** A query or pipeline a request wrote, as the AI panel would insert it; null when it wrote neither. */
export function reopenableResult(
  item: AiHistoryItem,
  content: AiHistoryContent | null | undefined,
): AiResult | null {
  const result = (content?.result ?? null) as AiResult | null
  return item.connectionId && item.namespace && (result?.kind === 'query' || result?.kind === 'pipeline')
    ? result
    : null
}

/** User review 2026-10-09: a request's query or pipeline opens again in its collection. */
export function useReopen() {
  const { t } = useI18n()
  const tabs = useTabsStore()
  return async (item: AiHistoryItem, result: AiResult): Promise<void> => {
    const ns = item.namespace!
    const dot = ns.indexOf('.')
    const tabId = openCollectionTab(tabs, item.connectionId!, ns.slice(0, dot), ns.slice(dot + 1))
    await insertResult(tabId, result, t)
  }
}

/**
 * User review 2026-10-09 ("bir bağlantı ya da collection silindiyse ne oluyor"): whether a request's
 * collection is still there to open — its connection the user's, the collection in its database.
 */
export function useRequestPlace(item: () => Pick<AiHistoryItem, 'connectionId' | 'namespace'> | null) {
  const parts = () => {
    const ns = item()?.namespace ?? ''
    const dot = ns.indexOf('.')
    return dot < 0 ? null : { db: ns.slice(0, dot), coll: ns.slice(dot + 1) }
  }
  const { presence, settled } = useCollectionPresence(
    () => item()?.connectionId ?? null,
    () => parts()?.db ?? null,
    () => parts()?.coll ?? null,
  )
  const gone = computed(() => presence.value === 'noConnection' || presence.value === 'noCollection')
  /** Opening it is offered once it is known there (or cannot be known: the lists unreadable). */
  const openable = computed(() => settled.value && !gone.value && parts() !== null)
  return { presence, gone, openable }
}
