// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { QueryClient } from '@tanstack/vue-query'
import { connectionsApi, queryKeys, type ConnectionDto } from '@/api/connections'
import type { useTabsStore } from '@/stores/tabs'
import { openCollectionTab, openConnectionTab, openDatabaseTab } from '@/workspace/openTabs'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useTabSectionsStore } from '@/stores/tabSections'

/**
 * Phase 3d-3b final review C26: "Open in Backups" / "Manage backups" — the connection's tab, then its
 * Backups section scrolled into view. The connection list is read when nothing cached it yet, and the
 * section is waited for: a tab opened just now mounts (and lazy-loads) after this returns.
 */
export async function openBackupsSection(
  queryClient: QueryClient,
  tabs: ReturnType<typeof useTabsStore>,
  connectionId: string,
): Promise<boolean> {
  const list =
    queryClient.getQueryData<ConnectionDto[]>(queryKeys.connections) ??
    (await queryClient
      .fetchQuery({ queryKey: queryKeys.connections, queryFn: () => connectionsApi.list() })
      .catch(() => undefined))
  const connection = list?.find((c) => c.id === connectionId)
  if (!connection) return false
  // User request 2026-10-23: Backups is a section of the connection's tab.
  useTabSectionsStore().set(openConnectionTab(tabs, connection), 'backups')
  const id = `backups-${connectionId}`
  // Up to ~3 s for the tab (and its Backups card) to appear.
  for (let i = 0; i < 30; i++) {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return true
}

/**
 * User request 2026-10-30: a backup just started shows where it lands — a collection's in that
 * collection's Backups, a database's in the database's, the server's in the connection's.
 */
export async function openBackupsOf(
  queryClient: QueryClient,
  tabs: ReturnType<typeof useTabsStore>,
  connectionId: string,
  place: { db?: string; coll?: string },
): Promise<void> {
  if (place.db && place.coll) {
    const id = openCollectionTab(tabs, connectionId, place.db, place.coll)
    useCollectionViewsStore().stateFor(id).section = 'backups'
  } else if (place.db) useTabSectionsStore().set(openDatabaseTab(tabs, connectionId, place.db), 'backups')
  else await openBackupsSection(queryClient, tabs, connectionId)
}
