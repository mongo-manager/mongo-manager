import { type MaybeRefOrGetter, toValue } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { connectionsApi, type ModuleStatus } from '@/api/connections'

/**
 * W7, W8: what the connection form may offer on this server (asked once, kept for the session).
 * `enabled`: whether to ask yet (a component on every page asks only once it is needed: before
 * sign-in the answer is a 401, which sends the page to sign-in).
 */
export function useConnectionCapabilities(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: ['connections', 'capabilities'] as const,
    queryFn: () => connectionsApi.capabilities(),
    staleTime: Infinity,
    enabled: () => toValue(enabled),
  })
}

/**
 * The i18n key of why an optional package is not there: the standalone binary and the Docker image
 * do not have it at all (the npm package does); the npm package says how to install it.
 */
export function unavailableKey(status: ModuleStatus | undefined): string {
  return status === 'not_in_package'
    ? 'connection.optional.notInPackage'
    : status === 'broken'
      ? 'connection.optional.broken'
      : 'connection.optional.missing'
}
