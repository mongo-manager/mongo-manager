import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import { useDialogStore } from '../src/stores/dialogs'
import type { HistoryPoint } from '../src/api/server'
import { historySeries } from '../src/monitor/historySeries'
import HistoryControls from '../src/monitor/HistoryControls.vue'
import { mockApi, mountApp } from './support/app'

/** Phase 3b spec §6: history ranges, and the connection admin's switch. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const point = (t: number, query: number | null): HistoryPoint => ({
  t,
  ops: { insert: 0, query, update: 0, delete: 0, getmore: 0, command: 0 },
  network: { inPerSec: 1, outPerSec: 2 },
  connections: { current: 3, available: 97 },
  memory: { residentMb: 10, virtualMb: 100 },
  cache: { usedBytes: 1024 * 1024, dirtyBytes: 0, maxBytes: 0 },
  queues: { readers: 0, writers: 0 },
  restarted: false,
})

describe('historySeries (phase 3b §6)', () => {
  it('lays points on their steps, with null where no sample was taken', () => {
    const step = 60_000
    const s = historySeries({
      from: 0,
      to: 4 * step,
      stepMs: step,
      points: [point(0, 5), point(2 * step, 7)],
    })
    const query = s.ops.find((x) => x.name === 'query')!
    expect(query.points).toEqual([5, null, 7, null])
    expect(s.connections[0]!.points).toEqual([3, null, 3, null])
    expect(s.memory.find((x) => x.name === 'cache')!.points[0]).toBe(1)
  })
})

describe('HistoryControls (phase 3b §6)', () => {
  const settings =
    (enabled: boolean, lastError = false) =>
    () =>
      [200, { enabled, samples: enabled ? 3 : 0, lastError, lastErrorAt: null }] as [number, unknown]

  /** The entries of the history menu, opened. */
  async function historyMenu(): Promise<HTMLElement[]> {
    document.querySelector<HTMLButtonElement>('button[aria-label="Metric history"]')!.click()
    await flushPromises()
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  }
  const named = (items: HTMLElement[], name: string) =>
    items.find((i) => i.querySelector('span > span')?.textContent?.trim() === name)!

  // UI redesign R3 §4: the span is a segmented control; recording and deleting are a menu.
  it('offers the ranges, and no history menu to one who may not change it', async () => {
    mockApi({ 'GET connections/c1/server/history/settings': settings(false) })
    const { wrapper } = mountApp(HistoryControls, {
      props: { connectionId: 'c1', canOperate: false, range: 'live' },
    })
    await flushPromises()
    const group = document.querySelector('[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toBe('Time span')
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(radios.map((r) => r.textContent?.trim())).toEqual(['Live (5 min)', '1 hour', '24 hours', '7 days'])
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true')
    radios[2]!.click()
    await flushPromises()
    expect(wrapper.emitted('update:range')![0]).toEqual(['24h'])
    expect(document.querySelector('button[aria-label="Metric history"]')).toBeNull()
  })

  it('lets a connection admin switch it off, and delete it after asking (delete in danger colour)', async () => {
    const { calls } = mockApi({
      'GET connections/c1/server/history/settings': settings(true, true),
      'PUT connections/c1/server/history/settings': (body) => [
        200,
        { ...(body as object), samples: 0, lastError: false, lastErrorAt: null },
      ],
      'DELETE connections/c1/server/history': () => [204, undefined],
    })
    mountApp(HistoryControls, { props: { connectionId: 'c1', canOperate: true, range: 'live' } })
    await flushPromises()
    // A failed recording is a warning badge, said in full to a screen reader.
    const failed = document.querySelector('[data-history-failed]')!
    expect(failed.textContent).toContain('Recording failed')
    expect(failed.querySelector('.sr-only')!.textContent).toContain('last recording failed')
    let items = await historyMenu()
    expect(named(items, 'Delete history').className).toContain('text-danger')
    named(items, 'Stop recording history').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ enabled: false })
    items = await historyMenu()
    named(items, 'Delete history').click()
    await flushPromises()
    // Asked first: nothing is deleted until the answer.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('offers to record when it is off, saying what it keeps', async () => {
    const { calls } = mockApi({
      'GET connections/c1/server/history/settings': settings(false),
      'PUT connections/c1/server/history/settings': (body) => [
        200,
        { ...(body as object), samples: 0, lastError: false, lastErrorAt: null },
      ],
    })
    mountApp(HistoryControls, { props: { connectionId: 'c1', canOperate: true, range: 'live' } })
    await flushPromises()
    const items = await historyMenu()
    // Nothing recorded, nothing to delete.
    expect(items).toHaveLength(1)
    expect(items[0]!.textContent).toContain('kept for 7 days')
    named(items, 'Record metric history').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ enabled: true })
  })
})
