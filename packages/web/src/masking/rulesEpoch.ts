// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, ref, type ComputedRef } from 'vue'
import { useQueryClient, type Query, type QueryClient, type keepPreviousData } from '@tanstack/vue-query'

/**
 * 2026-10-26 (known minors of the personal-data scrub): the personal data rules' changes, counted. A
 * request begun before a change answers what the rules hid then; an answer that would be kept (in the
 * cache, a draft, a value to put back, a page kept on screen) is let go when the count moved on since
 * it was asked for. A count, never a clock (as the Personal data card's refresh, review M4).
 */
const version = ref(0)

/** Where the rules stand: compare it before and after a request. Reactive. */
export const rulesEpoch = (): number => version.value

/** The rules changed: told by the Personal data card when every view follows them. */
export function rulesChanged(): void {
  version.value++
}

/** Each query of a client: the count when the read that brought its data began (-1: set by hand). */
const readFrom = new WeakMap<QueryClient, WeakMap<Query, number>>()
function tracked(client: QueryClient): WeakMap<Query, number> {
  const known = readFrom.get(client)
  if (known) return known
  const begun = new WeakMap<Query, number>()
  const landed = new WeakMap<Query, number>()
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return
    if (event.action.type === 'fetch') begun.set(event.query, version.value)
    else if (event.action.type === 'success')
      landed.set(event.query, event.action.manual ? -1 : (begun.get(event.query) ?? -1))
  })
  readFrom.set(client, landed)
  return landed
}

/** As TanStack's keepPreviousData, with the query the page is of (which TanStack passes too). */
export type KeepPrevious = <T>(previous: T, query?: Query) => T

/**
 * TanStack's keepPreviousData, but never a page asked for before the rules last changed (review
 * 2026-10-26, I2). A view on its way to its next page keeps the page it had (held by its watcher, out
 * of the cache's reach): offline, its values stayed until the network came back. A new function at
 * each change, so TanStack works the placeholder out again rather than keep the one it had. Before
 * any change this session, any page is kept, as before.
 */
export function keepPreviousShownFor(client: QueryClient): ComputedRef<typeof keepPreviousData> {
  const landed = tracked(client)
  return computed(() => {
    const now = version.value
    const keep: KeepPrevious = (previous, query) =>
      now === 0 || (query !== undefined && landed.get(query) === now)
        ? previous
        : (undefined as typeof previous)
    return keep
  })
}

/** keepPreviousShownFor the app's query client: in a component's setup. */
export const useKeepPreviousShown = (): ComputedRef<typeof keepPreviousData> =>
  keepPreviousShownFor(useQueryClient())
