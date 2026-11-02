import { computed, type Ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { personalFieldKeys, personalFieldsApi } from '@/api/personalFields'

/** Where a tab is: a connection, a database, a collection, or a GridFS bucket. */
export interface HiddenScope {
  connectionId: string
  db?: string
  coll?: string
  bucket?: string
}

/**
 * User report 2026-10-27 and its review (M3): whether personal data is hidden from the user where
 * they are — as the server says (the rules there, through views, a $lookup's database, a bucket by
 * what it reads, the key vault). Never where they see the values (not restricted); until the server
 * says, said as hidden (the safe side). Read again often: rules change for everyone at once.
 */
export function useHiddenHere(scope: Ref<HiddenScope | null>, restricted: Ref<boolean>) {
  const where = computed(() => ({
    connectionId: scope.value?.connectionId ?? '',
    db: scope.value?.db ?? '',
    coll: scope.value?.bucket ? '' : (scope.value?.coll ?? ''),
    bucket: scope.value?.db ? (scope.value.bucket ?? '') : '',
  }))
  const applied = useQuery({
    queryKey: computed(() => personalFieldKeys.reach(where.value)),
    queryFn: () =>
      personalFieldsApi.applied(
        where.value.connectionId,
        where.value.db,
        where.value.coll,
        where.value.bucket,
      ),
    enabled: computed(() => restricted.value && where.value.connectionId !== ''),
    staleTime: 15_000,
  })
  return computed(() => {
    if (!restricted.value || !scope.value) return false
    return applied.data.value?.reaches ?? true
  })
}
