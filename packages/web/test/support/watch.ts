import { ref } from 'vue'
import type { WatchEvent } from '@mongo-manager/shared/browser'
import type { ChannelMessage, JobsSocket, SocketState } from '../../src/jobs/socket'

/** The app socket as the Watch feed uses it: subscriptions re-sent on reopen, messages handed over. */
export function fakeSocket(initial: SocketState = 'open') {
  const state = ref<SocketState>(initial)
  const channels = new Map<
    string,
    {
      sub: Record<string, unknown>
      accepts: (m: ChannelMessage) => boolean
      onMessage: (m: ChannelMessage) => void
    }
  >()
  const sent: Array<Record<string, unknown>> = []
  const socket: JobsSocket = {
    state,
    start: () => undefined,
    stop: () => undefined,
    watch(key, sub, unsub, accepts, onMessage) {
      const entry = { sub, accepts, onMessage }
      channels.set(key, entry)
      if (state.value === 'open') sent.push(sub)
      return () => {
        if (channels.get(key) !== entry) return
        channels.delete(key)
        if (state.value === 'open') sent.push(unsub)
      }
    },
    receiver: () => () => undefined,
    send(message) {
      if (state.value !== 'open') return false
      sent.push(message)
      return true
    },
  }
  return {
    socket,
    sent,
    /** The last subscription sent. */
    lastSub: () =>
      [...sent].reverse().find((m) => m.type === 'sub') as Record<string, unknown> & { id: string },
    deliver(m: { type: string; payload: Record<string, unknown> }) {
      const message = { ch: 'watch', ...m }
      for (const c of [...channels.values()]) if (c.accepts(message)) c.onMessage(message)
    },
    drop: () => (state.value = 'connecting'),
    reopen() {
      state.value = 'open'
      for (const c of channels.values()) sent.push(c.sub)
    },
    poll: () => (state.value = 'polling'),
  }
}

/** A change event as the server sends it. */
export function event(seq: number, over: Partial<WatchEvent> = {}): WatchEvent {
  return {
    seq,
    op: 'insert',
    ns: { db: 'shop', coll: 'orders' },
    documentKey: { _id: { $numberInt: String(seq) } },
    fullDocument: { _id: { $numberInt: String(seq) }, n: { $numberInt: String(seq) } },
    clusterTime: 1_790_000_000,
    wallTime: 1_790_000_000_000 + seq,
    masked: false,
    bytes: 200,
    ...over,
  }
}
