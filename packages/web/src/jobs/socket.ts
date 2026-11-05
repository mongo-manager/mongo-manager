// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref, type Ref } from 'vue'
import type { JobView } from '@mongo-manager/shared'
import type { JobsStore } from './store'

/** The part of the browser WebSocket used here, so tests can drive a fake one. */
export interface SocketLike {
  send(data: string): void
  close(code?: number): void
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: (() => void) | null
}

export type SocketState = 'connecting' | 'open' | 'polling' | 'closed'

const FIRST_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
/** Opens that never reached "ready" in a row before falling back to polling (a proxy without upgrade). */
const FAILURES_BEFORE_POLLING = 3
const POLL_MS = 5_000
/** The server's close code for a session that ended (sign-out, expiry, disabled user) or none at all. */
const UNAUTHENTICATED = 4401
/** The server's close code for a missing or stale hello token; the session may be fine. */
const BAD_HELLO = 4403

export interface JobsSocketDeps {
  store: JobsStore
  open(url: string): SocketLike
  url(): string
  csrf(): string | undefined
  list(): Promise<{ jobs: JobView[] }>
  /**
   * Asks the server whether the session is still there, refreshing the CSRF token when it is:
   * 'gone' (signed out; the API has already sent the user to sign-in), 'ok', or 'unknown'
   * (unreachable, e.g. restarting).
   */
  checkSession(): Promise<'ok' | 'gone' | 'unknown'>
}

/**
 * One socket for the whole app (phase 1h spec §6): hello with the CSRF token, subscribe to jobs,
 * and keep the store current. It reconnects with a growing delay; each subscription answers with
 * a full snapshot, so nothing that happened while it was away is missed. When it cannot open at
 * all, it polls, and only while a job runs.
 */
export interface ChannelMessage {
  ch: string
  type: string
  payload: Record<string, unknown>
}

export interface JobsSocket {
  state: Ref<SocketState>
  start(): void
  stop(): void
  /**
   * Another channel on the same socket (phase 1i: live server metrics). The subscription is sent now
   * if the socket is open and again after every reconnect; messages of that channel that `accepts`
   * are handed over. The returned function unsubscribes.
   */
  watch(
    key: string,
    sub: { ch: string } & Record<string, unknown>,
    unsub: Record<string, unknown>,
    accepts: (message: ChannelMessage) => boolean,
    onMessage: (message: ChannelMessage) => void,
  ): () => void
  /**
   * Phase 3a-1: a request/response channel (the shell). Unlike watch, no subscription is sent on
   * connect — the caller sends its own messages with send() and re-establishes on reconnect by
   * watching state. Returns a function that stops receiving.
   */
  receiver(key: string, ch: string, onMessage: (message: ChannelMessage) => void): () => void
  /** Send a raw channel message if the socket is open; returns whether it was sent. */
  send(message: { ch: string } & Record<string, unknown>): boolean
}

export function createJobsSocket(deps: JobsSocketDeps): JobsSocket {
  const state = ref<SocketState>('closed')
  let socket: SocketLike | null = null
  let stopped = true
  let attempt = 0
  let failures = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  const channels = new Map<
    string,
    {
      sub?: { ch: string } & Record<string, unknown>
      ch: string
      accepts: (m: ChannelMessage) => boolean
      onMessage: (m: ChannelMessage) => void
    }
  >()

  const refresh = () =>
    deps.list().then(
      (r) => deps.store.replaceAll(r.jobs),
      () => undefined,
    )

  function startPolling(): void {
    if (pollTimer) return
    state.value = 'polling'
    void refresh()
    pollTimer = setInterval(() => {
      if (deps.store.running.length > 0) void refresh()
    }, POLL_MS)
  }

  function stopPolling(): void {
    clearInterval(pollTimer)
    pollTimer = undefined
  }

  /** Applies one message; true when it completed the handshake. */
  function receive(raw: string): boolean {
    let message: { type?: unknown; ch?: unknown; payload?: Record<string, unknown> }
    try {
      message = JSON.parse(raw)
    } catch {
      return false
    }
    if (message.type === 'ready') {
      attempt = 0
      failures = 0
      stopPolling()
      state.value = 'open'
      socket?.send(JSON.stringify({ ch: 'jobs', type: 'sub' }))
      for (const channel of channels.values()) if (channel.sub) socket?.send(JSON.stringify(channel.sub))
      return true
    }
    if (typeof message.ch === 'string' && message.ch !== 'jobs' && message.payload) {
      const m = message as ChannelMessage
      for (const channel of channels.values())
        if (channel.ch === m.ch && channel.accepts(m)) channel.onMessage(m)
      return false
    }
    if (message.ch !== 'jobs' || !message.payload) return false
    const { payload } = message
    if (typeof payload.now === 'number') deps.store.setServerTime(payload.now)
    if (message.type === 'snapshot' && Array.isArray(payload.jobs))
      deps.store.replaceAll(payload.jobs as JobView[])
    else if (message.type === 'update' && payload.job && typeof payload.job === 'object')
      deps.store.upsert(payload.job as JobView)
    else if (message.type === 'gone' && typeof payload.id === 'string') deps.store.remove(payload.id)
    return false
  }

  function connect(): void {
    if (stopped) return
    if (!pollTimer) state.value = 'connecting'
    let ready = false
    const current = deps.open(deps.url())
    socket = current
    current.onopen = () => current.send(JSON.stringify({ type: 'hello', csrf: deps.csrf() ?? '' }))
    current.onmessage = (event) => {
      if (socket !== current) return
      if (receive(event.data)) ready = true
    }
    current.onerror = () => undefined
    current.onclose = (event) => {
      if (socket !== current || stopped) return
      socket = null
      if (!ready && ++failures >= FAILURES_BEFORE_POLLING) startPolling()
      else if (!pollTimer) state.value = 'connecting'
      // Refused as unauthenticated, or its hello refused (a server restart makes the page's CSRF
      // token stale): only REST decides the session is over, and it refreshes the token otherwise
      // (final review C1: a restart must not sign the user out and lose unsaved work).
      if (event.code === UNAUTHENTICATED || event.code === BAD_HELLO) {
        void deps.checkSession().then((session) => {
          if (stopped) return
          if (session === 'gone') stop()
          else retry()
        })
        return
      }
      retry()
    }
  }

  function retry(): void {
    const delay = Math.min(FIRST_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
    attempt++
    reconnectTimer = setTimeout(connect, delay)
  }

  function start(): void {
    if (!stopped) return
    stopped = false
    attempt = 0
    failures = 0
    connect()
  }

  function stop(): void {
    stopped = true
    clearTimeout(reconnectTimer)
    stopPolling()
    const current = socket
    socket = null
    current?.close(1000)
    state.value = 'closed'
  }

  function watch(
    key: string,
    sub: { ch: string } & Record<string, unknown>,
    unsub: Record<string, unknown>,
    accepts: (m: ChannelMessage) => boolean,
    onMessage: (m: ChannelMessage) => void,
  ): () => void {
    const entry = { sub, ch: sub.ch, accepts, onMessage }
    channels.set(key, entry)
    if (state.value === 'open') socket?.send(JSON.stringify(sub))
    return () => {
      if (channels.get(key) !== entry) return
      channels.delete(key)
      if (state.value === 'open') socket?.send(JSON.stringify(unsub))
    }
  }

  function receiver(key: string, ch: string, onMessage: (m: ChannelMessage) => void): () => void {
    const entry = { ch, accepts: (m: ChannelMessage) => m.ch === ch, onMessage }
    channels.set(key, entry)
    return () => {
      if (channels.get(key) === entry) channels.delete(key)
    }
  }

  function send(message: { ch: string } & Record<string, unknown>): boolean {
    if (state.value !== 'open' || !socket) return false
    socket.send(JSON.stringify(message))
    return true
  }

  return { state, start, stop, watch, receiver, send }
}
