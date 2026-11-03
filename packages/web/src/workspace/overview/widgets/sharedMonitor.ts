import { effectScope, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { ServerSample } from '@/api/server'
import { startMonitor, type MonitorError } from '@/monitor/useMonitor'

/** The real-time socket follows at most this many connections at once (server: realtime/hub.ts). */
export const LIVE_CONNECTIONS = 3

interface Entry {
  connectionId: string
  users: number
  samples: Ref<ServerSample[]>
  error: Ref<MonitorError | null>
  live: Ref<boolean>
  stop: (() => void) | null
}

/** In the order connections were first asked for: the first ones are live. */
const entries = new Map<string, Entry>()
let listening = false

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
/** The window is hidden: nothing is live, and the widgets ask nothing else either (final review 12). */
const paused = ref(false)

/**
 * Starts following a connection in a scope of its own: it is often started from a widget's setup or
 * unmount, and must not stop with that widget while others show it (final review 1).
 */
function follow(entry: Entry): () => void {
  const scope = effectScope(true)
  const stop = scope.run(() => startMonitor(entry.connectionId, entry.samples, entry.error))!
  return () => {
    stop()
    scope.stop()
  }
}

/** Which connections are live now: the first few asked for, none while the window is hidden. */
function arrange(): void {
  paused.value = hidden()
  let place = 0
  for (const entry of entries.values()) {
    const live = !hidden() && place < LIVE_CONNECTIONS
    place += 1
    if (live && !entry.stop) entry.stop = follow(entry)
    if (!live && entry.stop) {
      entry.stop()
      entry.stop = null
    }
    entry.live.value = live
  }
}

function acquire(connectionId: string): Entry {
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', arrange)
    listening = true
  }
  let entry = entries.get(connectionId)
  if (!entry) {
    entry = { connectionId, users: 0, samples: ref([]), error: ref(null), live: ref(false), stop: null }
    entries.set(connectionId, entry)
  }
  entry.users += 1
  arrange()
  return entry
}

function release(connectionId: string): void {
  const entry = entries.get(connectionId)
  if (!entry) return
  entry.users -= 1
  if (entry.users > 0) return
  entry.stop?.()
  entries.delete(connectionId)
  arrange()
}

/**
 * User review 2026-10-09: a connection's live server status for the Overview's widgets — one
 * subscription per connection however many widgets show it, at most {@link LIVE_CONNECTIONS}
 * connections live (`live` false beyond them: the widget shows stored history instead), and none
 * while the window is hidden.
 */
export function useSharedMonitor(connectionId: () => string | null): {
  samples: Ref<ServerSample[]>
  error: Ref<MonitorError | null>
  live: Ref<boolean>
  /** The window is hidden: show what was last seen, ask for nothing instead. */
  paused: Readonly<Ref<boolean>>
} {
  const samples = ref<ServerSample[]>([])
  const error = ref<MonitorError | null>(null)
  const live = ref(false)
  let current: string | null = null
  let unbind: Array<() => void> = []
  const follow = (id: string | null) => {
    unbind.forEach((u) => u())
    unbind = []
    if (current) release(current)
    current = id
    if (!id) {
      samples.value = []
      error.value = null
      live.value = false
      return
    }
    const entry = acquire(id)
    unbind = [
      watch(entry.samples, (s) => (samples.value = s), { immediate: true }),
      watch(entry.error, (e) => (error.value = e), { immediate: true }),
      watch(entry.live, (l) => (live.value = l), { immediate: true }),
    ]
  }
  watch(connectionId, follow, { immediate: true })
  onBeforeUnmount(() => follow(null))
  return { samples, error, live, paused }
}

/** Tests: start again with nothing followed. */
export function _resetSharedMonitors(): void {
  for (const entry of entries.values()) entry.stop?.()
  entries.clear()
  paused.value = false
}
