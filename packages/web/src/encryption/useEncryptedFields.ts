// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, type Ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { connectionsApi, queryKeys } from '@/api/connections'
import type { CollectionTarget } from '@/api/documents'

/**
 * W8: the encrypted fields of a collection, for the marks in the documents view — asked only where
 * the connection has client-side encryption set up (its paths only, never a value).
 */
export function useEncryptedFields(target: Ref<CollectionTarget>) {
  const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
  const enabled = computed(
    () =>
      connections.value?.find((c) => c.id === target.value.connectionId)?.settings?.encryption?.enabled ===
      true,
  )
  const fields = useQuery({
    queryKey: computed(
      () =>
        [
          'connections',
          target.value.connectionId,
          'databases',
          target.value.db,
          'collections',
          target.value.coll,
          'encrypted-fields',
        ] as const,
    ),
    queryFn: () =>
      connectionsApi.encryptedFields(target.value.connectionId, target.value.db, target.value.coll),
    enabled,
    retry: false,
  })
  return computed(() => new Set((fields.data.value?.fields ?? []).map((f) => f.path)))
}
