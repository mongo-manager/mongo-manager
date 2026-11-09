// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { setCsrfToken } from '../src/api/client'
import { setJobsSocketFactory, useJobsLive } from '../src/jobs/live'
import { useJobsStore } from '../src/jobs/store'
import type { SocketLike } from '../src/jobs/socket'
import { i18n } from '../src/i18n'
import ContextBar from '../src/workspace/ContextBar.vue'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function recording() {
  const opened: Array<{ url: string; sent: unknown[]; closed: number | null; socket: SocketLike }> = []
  setJobsSocketFactory((url) => {
    const entry = {
      url,
      sent: [] as unknown[],
      closed: null as number | null,
      socket: null as unknown as SocketLike,
    }
    entry.socket = {
      send: (d) => entry.sent.push(JSON.parse(d)),
      close: (code) => (entry.closed = code ?? 1000),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }
    opened.push(entry)
    return entry.socket
  })
  return opened
}

/** A page transition as the browser sends it (happy-dom drops `persisted` from the init). */
function transition(type: 'pagehide' | 'pageshow', persisted: boolean): void {
  const e = new Event(type)
  Object.defineProperty(e, 'persisted', { value: persisted })
  window.dispatchEvent(e)
}

describe('the live jobs connection (phase 1h spec §6)', () => {
  it('opens one socket to /ws under the base URL, says hello, and closes it and empties the store on unmount', async () => {
    const opened = recording()
    setCsrfToken('the-token')
    const Live = defineComponent(() => {
      useJobsLive()
      return () => h('div')
    })
    const { wrapper } = mountApp(Live)
    await flushPromises()
    expect(opened.map((o) => o.url)).toEqual(['ws://localhost:4321/ws'])
    opened[0]!.socket.onopen?.()
    expect(opened[0]!.sent).toEqual([{ type: 'hello', csrf: 'the-token' }])
    useJobsStore().upsert({
      id: 'j1',
      kind: 'index.create',
      connectionId: 'c1',
      targetConnectionId: null,
      db: 'd',
      coll: 'c',
      target: 't',
      state: 'running',
      progress: null,
      estimate: null,
      error: null,
      startedAt: 1,
      finishedAt: null,
      mine: true,
      cancellable: true,
    })
    wrapper.unmount()
    expect(opened[0]!.closed).toBe(1000)
    expect(useJobsStore().list).toEqual([])
  })

  // User report 2026-11-09: "WebSocket connection … failed: Page entered Back-Forward Cache" in the
  // console. The page closes its socket itself as it goes into that cache, and opens a new one when
  // it comes back; a page that is only left (not cached) keeps it until it unloads.
  it('closes the socket as the page enters the back-forward cache, and opens it again on the way back', async () => {
    const opened = recording()
    const Live = defineComponent(() => {
      useJobsLive()
      return () => h('div')
    })
    const { wrapper } = mountApp(Live)
    await flushPromises()
    expect(opened).toHaveLength(1)
    transition('pagehide', false)
    expect(opened[0]!.closed).toBeNull()
    transition('pagehide', true)
    expect(opened[0]!.closed).toBe(1000)
    transition('pageshow', false)
    expect(opened).toHaveLength(1)
    transition('pageshow', true)
    expect(opened).toHaveLength(2)
    wrapper.unmount()
    expect(opened[1]!.closed).toBe(1000)
    // Gone with the workspace: a later return opens nothing.
    transition('pageshow', true)
    expect(opened).toHaveLength(2)
  })

  it('after a server restart, fetches the new CSRF token and says hello with it (final review C1)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const opened = recording()
      mockApi({ 'GET auth/me': () => [200, { csrfToken: 'fresh-token' }] })
      setCsrfToken('stale-token')
      const Live = defineComponent(() => {
        useJobsLive()
        return () => h('div')
      })
      mountApp(Live)
      await flushPromises()
      opened[0]!.socket.onopen?.()
      opened[0]!.socket.onclose?.({ code: 4403 })
      await flushPromises()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(opened).toHaveLength(2)
      opened[1]!.socket.onopen?.()
      expect(opened[1]!.sent).toEqual([{ type: 'hello', csrf: 'fresh-token' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('puts the jobs tray in the header and keeps the socket open while the header is shown', async () => {
    const opened = recording()
    mountApp(ContextBar)
    await flushPromises()
    expect(document.querySelector('button[aria-label="Background jobs"]')).not.toBeNull()
    expect(opened).toHaveLength(1)
  })
})
