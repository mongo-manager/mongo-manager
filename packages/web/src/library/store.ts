// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { LibraryItem } from '@mongo-manager/shared/browser'

export type LibraryTypeFilter = LibraryItem['type'] | 'all'

/**
 * Phase 2c: which connection the Library searches. User request 2026-10-10: the Library is the
 * Queries page; opening it from a connection's place searches that connection. Review M4: what the
 * page searched is kept here, so it is there again when the page shows again.
 */
export const useLibraryStore = defineStore('library', () => {
  const connectionId = ref<string | null>(null)
  /** The collection the page was last opened from, offered in its collection filter. */
  const origin = ref<{ db: string; coll: string } | null>(null)
  const filters = reactive({
    q: '',
    type: 'all' as LibraryTypeFilter,
    tag: null as string | null,
    /** '' is every collection; otherwise db and coll, joined by a NUL. */
    scope: '',
    /** The collections the items were about, from searches over every collection. */
    namespaces: [] as string[],
    /** The connection the tag, the collection and the namespaces belong to. */
    connectionId: null as string | null,
  })

  function show(connection: string | null, from?: { db?: string; coll?: string }): void {
    if (connection) connectionId.value = connection
    if (connection && from?.db && from.coll) origin.value = { db: from.db, coll: from.coll }
  }

  return { connectionId, origin, filters, show }
})
