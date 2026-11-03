import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { scheduleKeys, schedulesApi } from '@/api/schedules'

/** Spec §5 signals: the viewer's own schedules that are paused, or whose last run failed or was partial. */
export function useScheduleSignals() {
  const list = useQuery({
    queryKey: scheduleKeys.list,
    queryFn: () => schedulesApi.list(),
    refetchInterval: 60_000,
  })
  const attention = computed(
    () =>
      (list.data.value?.schedules ?? []).filter(
        (s) =>
          s.mine &&
          (s.state === 'paused' ||
            // Final review I4: the last finished run, as the card's badge reads it.
            ['failed', 'partial'].includes(
              [...s.lastRuns].reverse().find((r) => r.outcome !== 'running' && r.outcome !== 'queued')
                ?.outcome ?? '',
            )),
      ).length,
  )
  return { attention, list }
}
