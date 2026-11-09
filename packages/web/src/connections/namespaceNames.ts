// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { connectionsApi, queryKeys } from '@/api/connections'

/**
 * User report 2026-10-30: where a connection is picked, its databases (and the chosen database's
 * collections) are offered by name — read as the tree reads them (the same query), so a list already
 * read is not read again. A connection that cannot be read offers nothing: the name is typed.
 */
export function useDatabaseNames(
  connectionId: MaybeRefOrGetter<string | null | undefined>,
): ComputedRef<string[]> {
  const id = computed(() => toValue(connectionId) ?? '')
  const { data } = useQuery({
    queryKey: computed(() => queryKeys.databases(id.value)),
    queryFn: () => connectionsApi.databases(id.value),
    enabled: computed(() => id.value !== ''),
    staleTime: 30_000,
    // As the connection's screens (reachability.ts): when to read again is the connection's — a row
    // of fields mounted later does not read an unreachable server again (review M2).
    refetchOnMount: false,
    retryOnMount: false,
  })
  return computed(() => (id.value === '' ? [] : (data.value?.databases ?? []).map((d) => d.name)))
}

export function useCollectionNames(
  connectionId: MaybeRefOrGetter<string | null | undefined>,
  db: MaybeRefOrGetter<string | null | undefined>,
  options: { views?: boolean } = {},
): ComputedRef<string[]> {
  const id = computed(() => toValue(connectionId) ?? '')
  const name = computed(() => (toValue(db) ?? '').trim())
  // Only a database the connection has: a name being typed (or a new one) asks the server nothing.
  const databases = useDatabaseNames(id)
  const known = computed(() => name.value !== '' && databases.value.includes(name.value))
  const { data } = useQuery({
    queryKey: computed(() => queryKeys.collections(id.value, name.value)),
    queryFn: () => connectionsApi.collections(id.value, name.value),
    enabled: known,
    staleTime: 30_000,
  })
  return computed(() =>
    !known.value
      ? []
      : (data.value ?? [])
          .filter((c) => !c.name.startsWith('system.') && (options.views !== false || c.type !== 'view'))
          .map((c) => c.name)
          .sort((a, b) => a.localeCompare(b)),
  )
}

/**
 * A "database or database.collection" field: the databases, and once a database is typed with its
 * dot, its collections (and views) as `db.collection`.
 */
export function useNamespaceNames(
  connectionId: MaybeRefOrGetter<string | null | undefined>,
  text: MaybeRefOrGetter<string>,
): ComputedRef<string[]> {
  const databases = useDatabaseNames(connectionId)
  const db = computed(() => {
    const typed = toValue(text).trim()
    const dot = typed.indexOf('.')
    return dot > 0 ? typed.slice(0, dot) : ''
  })
  const collections = useCollectionNames(connectionId, db, { views: true })
  return computed(() => [...databases.value, ...collections.value.map((c) => `${db.value}.${c}`)])
}
