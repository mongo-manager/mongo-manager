import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { ApiError } from '@/api/client'
import { serverApi, type ServerSample } from '@/api/server'
import { realtimeSocket } from '@/jobs/live'

/** Five minutes at one sample every 2 s (phase 1i spec §3); nothing is kept on the server. */
export const MAX_SAMPLES = 150
const POLL_MS = 5_000

export type MonitorError = 'FORBIDDEN' | 'TOO_MANY' | 'NOT_PERMITTED' | 'UNREACHABLE'

/**
 * Live samples of one connection's server into `samples` and `error`: over the app's real-time socket,
 * or, when it has fallen back to polling (or there is none), from the status route every 5 s. Returns
 * the stop. Not tied to a component (user review 2026-10-09: the Overview's widgets share one).
 */
export function startMonitor(
  connectionId: string,
  samples: Ref<ServerSample[]>,
  error: Ref<MonitorError | null>,
): () => void {
  const socket = realtimeSocket()
  let poll: ReturnType<typeof setInterval> | undefined

  const push = (sample: ServerSample | null) => {
    if (!sample || typeof sample !== 'object') return
    samples.value = [...samples.value.slice(-(MAX_SAMPLES - 1)), sample]
    error.value = null
  }

  const tick = () =>
    serverApi.status(connectionId).then(push, (e: unknown) => {
      const reason =
        e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : undefined
      error.value =
        reason === 'mongo_not_permitted'
          ? 'NOT_PERMITTED'
          : e instanceof ApiError && e.status === 403
            ? 'FORBIDDEN'
            : 'UNREACHABLE'
    })

  function startPolling(): void {
    if (poll) return
    void tick()
    poll = setInterval(() => void tick(), POLL_MS)
  }

  function stopPolling(): void {
    clearInterval(poll)
    poll = undefined
  }

  if (!socket) {
    startPolling()
    return stopPolling
  }
  const off = socket.watch(
    `monitor:${connectionId}`,
    { ch: 'monitor', type: 'sub', connectionId },
    { ch: 'monitor', type: 'unsub', connectionId },
    (m) => m.payload.connectionId === connectionId,
    (m) => {
      if (m.type === 'sample') push(m.payload as unknown as ServerSample)
      else if (m.type === 'error') error.value = m.payload.code as MonitorError
    },
  )
  const stopState = watch(socket.state, (state) => (state === 'polling' ? startPolling() : stopPolling()), {
    immediate: true,
  })
  return () => {
    off()
    stopState()
    stopPolling()
  }
}

/** Live samples of one connection's server, while the calling component is mounted. */
export function useMonitor(connectionId: string): {
  samples: Ref<ServerSample[]>
  error: Ref<MonitorError | null>
} {
  const samples = ref<ServerSample[]>([])
  const error = ref<MonitorError | null>(null)
  let stop: (() => void) | null = null
  onMounted(() => {
    stop = startMonitor(connectionId, samples, error)
  })
  onBeforeUnmount(() => stop?.())
  return { samples, error }
}
