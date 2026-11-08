// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { connectionsApi, queryKeys } from '@/api/connections'

/**
 * User review 2026-10-09 ("olmayan bir collection adı girdim, varmış gibi davrandı"): whether a
 * collection is there — its connection among the user's, the collection in its database's list.
 * MongoDB answers a read of a missing collection with nothing, so only the list can tell.
 *
 * - `unknown`: not known yet, or the lists cannot be read (nothing is said missing then);
 * - `present`: there (a system collection, left out of the plain list, is taken as there);
 * - `noConnection`: the connection is gone (deleted, or no longer the user's);
 * - `noCollection`: the database has no collection (nor view) of that name — said only after the
 *   list was read again, so one made a moment ago is never taken as missing.
 */
export type Presence = 'unknown' | 'present' | 'noConnection' | 'noCollection'

export function useCollectionPresence(
  connectionId: MaybeRefOrGetter<string | null>,
  db: MaybeRefOrGetter<string | null>,
  coll: MaybeRefOrGetter<string | null>,
) {
  const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
  const connection = computed(() => {
    const id = toValue(connectionId)
    return id ? connections.data.value?.find((c) => c.id === id) : undefined
  })
  const collections = useQuery({
    queryKey: computed(() => queryKeys.collections(toValue(connectionId) ?? '', toValue(db) ?? '')),
    queryFn: () => connectionsApi.collections(toValue(connectionId)!, toValue(db)!),
    enabled: computed(() => !!connection.value && !!toValue(db)),
  })
  const listed = computed(() => {
    const name = toValue(coll)
    return collections.data.value?.some((c) => c.name === name)
  })
  /** The place the list was read again for, before it may be said missing. */
  const confirmed = ref<string | null>(null)
  const key = computed(() => `${toValue(connectionId)}\u0000${toValue(db)}\u0000${toValue(coll)}`)
  watch(
    [listed, key],
    async ([isListed, k]) => {
      if (isListed !== false || confirmed.value === k) return
      await collections.refetch()
      confirmed.value = k
    },
    { immediate: true },
  )
  const presence = computed<Presence>(() => {
    if (!toValue(connectionId)) return 'unknown'
    if (connections.data.value && !connection.value) return 'noConnection'
    if (!connection.value) return 'unknown'
    const name = toValue(coll)
    if (!toValue(db) || !name || name.startsWith('system.')) return 'present'
    if (collections.isError.value || listed.value === undefined) return 'unknown'
    if (listed.value) return 'present'
    return confirmed.value === key.value ? 'noCollection' : 'unknown'
  })
  /** Known — or not to be known (a list that cannot be read): the place may be shown as it is. */
  const settled = computed(
    () =>
      presence.value !== 'unknown' ||
      !toValue(connectionId) ||
      connections.isError.value ||
      collections.isError.value,
  )
  return { presence, settled, connection, collections }
}
