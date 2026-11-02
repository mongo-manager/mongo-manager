import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { useSharedMonitor, _resetSharedMonitors } from '../src/workspace/overview/widgets/sharedMonitor'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  _resetSharedMonitors()
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

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
function api() {
  return mockApi(
    Object.fromEntries(
      ids.map((c) => [`GET connections/${c}/server/status`, () => [200, SAMPLE] as [number, unknown]]),
    ),
  )
}
/** A widget reading one connection; returns what it sees. */
function widget(connectionId: string) {
  const seen = { live: ref(false), samples: ref<unknown[]>([]) }
  const C = defineComponent({
    setup() {
      const m = useSharedMonitor(() => connectionId)
      seen.live = m.live as never
      seen.samples = m.samples as never
      return () => h('div')
    },
  })
  const { wrapper } = mountApp(C)
  return { seen, wrapper }
}
const statusCalls = (calls: Array<{ path: string }>, c: string) =>
  calls.filter((x) => x.path === `connections/${c}/server/status`).length

describe('live server status for widgets (user review 2026-10-09)', () => {
  it('reads each connection once, however many widgets show it', async () => {
    const { calls } = api()
    const a = widget('c1')
    const b = widget('c1')
    await flushPromises()
    expect(statusCalls(calls, 'c1')).toBe(1)
    expect(a.seen.samples.value).toHaveLength(1)
    expect(b.seen.samples.value).toHaveLength(1)
    // The last one leaving stops it.
    a.wrapper.unmount()
    b.wrapper.unmount()
    widget('c1')
    await flushPromises()
    expect(statusCalls(calls, 'c1')).toBe(2)
  })

  it('keeps at most 3 connections live, and tells a widget beyond that it is not', async () => {
    const { calls } = api()
    const shown = ids.map((c) => widget(c))
    await flushPromises()
    expect(shown.map((w) => w.seen.live.value)).toEqual([true, true, true, false])
    expect(statusCalls(calls, 'c4')).toBe(0)
    // One of the first three goes: the fourth becomes live.
    shown[0]!.wrapper.unmount()
    await flushPromises()
    expect(shown[3]!.seen.live.value).toBe(true)
    expect(statusCalls(calls, 'c4')).toBe(1)
  })

  it('stops while the window is hidden, and starts again when it is shown', async () => {
    const { calls } = api()
    const a = widget('c1')
    await flushPromises()
    let state = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state as DocumentVisibilityState)
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(a.seen.live.value).toBe(false)
    state = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(a.seen.live.value).toBe(true)
    expect(statusCalls(calls, 'c1')).toBe(2)
  })
})
