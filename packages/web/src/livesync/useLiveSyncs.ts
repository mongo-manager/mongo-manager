import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/vue-query'
import type { LiveSyncView, LiveSyncsList } from '@mongo-manager/shared/browser'
import { liveSyncApi, liveSyncKeys } from '@/api/liveSync'
import { realtimeSocket } from '@/jobs/live'

/** Plan ruling 15: the lag chart shows the last 10 minutes this page saw. */
export const LAG_WINDOW_MS = 10 * 60_000
const lags = reactive(new Map<string, Array<{ at: number; lag: number }>>())

function remember(sync: LiveSyncView): void {
  if (sync.state !== 'live' && sync.state !== 'catching_up') return
  const at = Date.now()
  const points = (lags.get(sync.id) ?? []).filter((p) => p.at >= at - LAG_WINDOW_MS)
  if (points.at(-1)?.at !== at) points.push({ at, lag: sync.counters.lagMs })
  lags.set(sync.id, points)
}

/**
 * W4.6: the server keeps each sync's lag history; a page that opens fills the card's chart from it
 * once, then adds what it is pushed (a reload no longer starts the chart empty).
 */
const seeded = new Set<string>()
async function seedLag(id: string): Promise<void> {
  if (seeded.has(id)) return
  seeded.add(id)
  const history = await liveSyncApi.lag(id, LAG_WINDOW_MS / 60_000).catch(() => null)
  if (!history) return
  const live = lags.get(id) ?? []
  const first = live[0]?.at ?? Infinity
  lags.set(id, [...history.points.filter((p) => p.at < first), ...live])
}

const byNewest = (a: LiveSyncView, b: LiveSyncView) => b.createdAt - a.createdAt

/** A pushed sync replaces the listed one, or joins the list (newest first). */
export function applyUpdate(queryClient: QueryClient, sync: LiveSyncView): void {
  remember(sync)
  queryClient.setQueryData<LiveSyncsList>(liveSyncKeys.list, (old) =>
    old ? { ...old, syncs: [...old.syncs.filter((s) => s.id !== sync.id), sync].sort(byNewest) } : old,
  )
}

export function applyGone(queryClient: QueryClient, id: string): void {
  lags.delete(id)
  queryClient.setQueryData<LiveSyncsList>(liveSyncKeys.list, (old) =>
    old ? { ...old, syncs: old.syncs.filter((s) => s.id !== id) } : old,
  )
}

/** Spec §5: the caller's syncs (all for administrators), kept current by the livesync channel. */
export function useLiveSyncs() {
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: liveSyncKeys.list,
    queryFn: async () => {
      const data = await liveSyncApi.list()
      data.syncs.forEach(remember)
      for (const s of data.syncs) if (s.state === 'live' || s.state === 'catching_up') void seedLag(s.id)
      return data
    },
    refetchInterval: 30_000,
  })
  const socket = realtimeSocket()
  let off: (() => void) | null = null
  onMounted(() => {
    off =
      socket?.watch(
        'livesync',
        { ch: 'livesync', type: 'sub' },
        { ch: 'livesync', type: 'unsub' },
        () => true,
        (m) => {
          if (m.type === 'update') applyUpdate(queryClient, m.payload.sync as LiveSyncView)
          else if (m.type === 'gone') applyGone(queryClient, String(m.payload.id))
        },
      ) ?? null
  })
  onBeforeUnmount(() => off?.())
  const syncs = computed(() => list.data.value?.syncs ?? [])
  return { list, syncs, lagOf: (id: string) => lags.get(id) ?? [] }
}

/** Spec §5 badge: the caller's own syncs that need a person (attention, or failed). */
export function useLiveSyncSignals() {
  const list = useQuery({
    queryKey: liveSyncKeys.list,
    queryFn: () => liveSyncApi.list(),
    refetchInterval: 60_000,
  })
  const attention = computed(
    () =>
      (list.data.value?.syncs ?? []).filter(
        (s) => s.mine && (s.state === 'attention' || s.state === 'failed'),
      ).length,
  )
  return { attention }
}
