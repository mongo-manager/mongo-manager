import { computed } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { alertKeys, alertsApi } from '@/api/alerts'
import { useSessionStore } from '@/stores/session'

/**
 * W3.3: the alerts the bell shows this user — firing ones and recent events, only if they opted in
 * and only on connections whose server they may watch (the server filters). One shared query,
 * every 30 s while the tab is visible.
 */
export function useAlertSignals() {
  const session = useSessionStore()
  const queryClient = useQueryClient()
  const active = useQuery({
    queryKey: alertKeys.active,
    queryFn: alertsApi.active,
    enabled: computed(() => !!session.status?.authenticated),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  })
  const alerts = computed(() => (active.isError.value ? [] : (active.data.value ?? [])))
  const firing = computed(() => alerts.value.filter((a) => a.state === 'firing').length)
  const unacknowledged = computed(() => alerts.value.filter((a) => !a.acknowledgedAt).length)
  async function acknowledge(id: string): Promise<void> {
    await alertsApi.acknowledge(id)
    await queryClient.invalidateQueries({ queryKey: alertKeys.active })
  }
  /** W3 review (M8): out of this user's bell only. */
  async function dismiss(id: string): Promise<void> {
    await alertsApi.dismiss(id)
    await queryClient.invalidateQueries({ queryKey: alertKeys.active })
  }
  return { alerts, firing, unacknowledged, acknowledge, dismiss }
}
