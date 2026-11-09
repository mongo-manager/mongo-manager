// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { onBeforeUnmount, onMounted } from 'vue'
import { ApiError, api, csrfTokenNow, setCsrfToken } from '@/api/client'
import { jobsApi, socketUrl } from '@/api/jobs'
import { createJobsSocket, type JobsSocket, type SocketLike } from './socket'
import { useJobsStore } from './store'
import { useJobOutcomes } from './outcomes'

/** The app's one real-time socket while the signed-in workspace is shown, for other channels. */
let active: JobsSocket | null = null

export function realtimeSocket(): JobsSocket | null {
  return active
}

let openSocket: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike

/** Tests replace the browser WebSocket; nothing else should. */
export function setJobsSocketFactory(factory: (url: string) => SocketLike): void {
  openSocket = factory
}

/**
 * Keeps the jobs store live while the signed-in workspace is shown: one socket, opened when it
 * mounts and closed (with the store emptied) when it goes, such as on sign-out.
 */
export function useJobsLive(): void {
  const store = useJobsStore()
  useJobOutcomes()
  const socket = createJobsSocket({
    store,
    open: (url) => openSocket(url),
    url: socketUrl,
    csrf: csrfTokenNow,
    list: jobsApi.list,
    checkSession: async () => {
      try {
        setCsrfToken((await api.get<{ csrfToken: string }>('auth/me')).csrfToken)
        return 'ok'
      } catch (e) {
        // A 401 has already sent the user to sign-in, through the API's own handler.
        return e instanceof ApiError && e.status === 401 ? 'gone' : 'unknown'
      }
    },
  })
  active = socket
  // The updater (2026-11-03): the server says it restarts into a new version; every page shows it.
  // The store loads only then: this module is loaded early (tests' setup), before their mocks.
  socket.receiver('updates', 'server', (m) => {
    const version = m.payload.version
    if (m.type === 'restarting' && typeof version === 'string')
      void import('@/stores/updates').then(({ useUpdatesStore }) =>
        useUpdatesStore().serverRestarting(version),
      )
  })
  // User report 2026-11-09: a page going into the back-forward cache with its socket open had the
  // browser cut it ("Page entered Back-Forward Cache" in the console). It closes it itself, and opens
  // a new one when it comes back.
  const onHide = (e: PageTransitionEvent) => {
    if (e.persisted) socket.stop()
  }
  const onShow = (e: PageTransitionEvent) => {
    if (e.persisted) socket.start()
  }
  onMounted(() => {
    window.addEventListener('pagehide', onHide)
    window.addEventListener('pageshow', onShow)
    socket.start()
  })
  onBeforeUnmount(() => {
    window.removeEventListener('pagehide', onHide)
    window.removeEventListener('pageshow', onShow)
    if (active === socket) active = null
    socket.stop()
    store.reset()
  })
}
