// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, type Ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useKeepPreviousShown } from '@/masking/rulesEpoch'
import { documentKeys, documentsApi, type CollectionTarget, type FindBody } from '@/api/documents'
import type { CollectionViewState } from '@/stores/collectionViews'
import { toRows } from './rows'

/**
 * The current page and its count. Changing the query or page cancels the running request
 * (the server kills it by comment) and keeps the previous rows on screen until the new ones arrive.
 */
export function useDocuments(target: Ref<CollectionTarget>, state: CollectionViewState) {
  const keepPreviousShown = useKeepPreviousShown()
  const body = computed<FindBody>(() => ({
    ...state.query,
    skip: state.query.skip + state.page * state.query.limit,
  }))
  const find = useQuery({
    queryKey: computed(() => documentKeys.page(target.value, body.value)),
    queryFn: async ({ signal }) => {
      const request = body.value
      // Remember which offset this page came from: while the next page loads, the old rows keep their numbers.
      return { ...(await documentsApi.find(target.value, request, signal)), skip: request.skip }
    },
    placeholderData: keepPreviousShown,
  })
  const countOptions = computed(() => ({
    ...(state.query.collation ? { collation: state.query.collation } : {}),
    ...(state.query.hint !== undefined ? { hint: state.query.hint } : {}),
  }))
  const count = useQuery({
    queryKey: computed(() => documentKeys.count(target.value, state.query.filter, countOptions.value)),
    queryFn: ({ signal }) => documentsApi.count(target.value, state.query.filter, countOptions.value, signal),
    placeholderData: keepPreviousShown,
  })
  const shownSkip = computed(() => find.data.value?.skip ?? body.value.skip)
  const rows = computed(() => toRows(find.data.value?.documents ?? [], shownSkip.value))
  return { find, count, rows, body, shownSkip }
}
