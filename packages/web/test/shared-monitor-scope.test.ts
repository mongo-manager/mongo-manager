import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { useSharedMonitor, _resetSharedMonitors } from '../src/workspace/overview/widgets/sharedMonitor'
import { mockApi, mountApp } from './support/app'
import { fakeSocket } from './support/watch'

const live = vi.hoisted(() => ({ socket: null as unknown }))
vi.mock('../src/jobs/live', () => ({ realtimeSocket: () => live.socket }))

const SAMPLE = {
  t: 1,
  ops: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
  network: { inPerSec: 0, outPerSec: 0 },
  connections: { current: 1, available: 9 },
  memory: { residentMb: 1, virtualMb: 1 },
  cache: null,
  queues: { readers: 0, writers: 0 },
  restarted: false,
  uptimeSec: 60,
  version: '8.0.4',
}
const ids = ['c1', 'c2', 'c3', 'c4']

beforeEach(() => {
  setActivePinia(createPinia())
  _resetSharedMonitors()
})
afterEach(() => {
  _resetSharedMonitors()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function widget(connectionId: string) {
  const C = defineComponent({
    setup() {
      useSharedMonitor(() => connectionId)
      return () => h('div')
    },
  })
  return mountApp(C).wrapper
}
const statusCalls = (calls: Array<{ path: string }>, c: string) =>
  calls.filter((x) => x.path === `connections/${c}/server/status`).length

describe('a shared live connection outlives the widget that started it (final review 1)', () => {
  it('goes on following the socket for the widgets left when the first one goes', async () => {
    const s = fakeSocket('open')
    live.socket = s.socket
    const { calls } = mockApi(
      Object.fromEntries(ids.map((c) => [`GET connections/${c}/server/status`, () => [200, SAMPLE]])),
    )
    const first = widget('c1')
    widget('c1')
    await flushPromises()
    first.unmount()
    // The socket falls back to polling: the widget left polls.
    s.poll()
    await flushPromises()
    expect(statusCalls(calls, 'c1')).toBe(1)
  })

  it('follows a connection made live when another widget goes', async () => {
    const s = fakeSocket('open')
    live.socket = s.socket
    const { calls } = mockApi(
      Object.fromEntries(ids.map((c) => [`GET connections/${c}/server/status`, () => [200, SAMPLE]])),
    )
    const shown = ids.map((c) => widget(c))
    await flushPromises()
    shown[0]!.unmount()
    s.poll()
    await flushPromises()
    expect(statusCalls(calls, 'c4')).toBe(1)
  })
})
