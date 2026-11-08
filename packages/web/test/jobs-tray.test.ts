// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { JobView } from '@mongo-manager/shared'
import JobsTray from '../src/jobs/JobsTray.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { formatElapsed } from '../src/jobs/elapsed'
import { useJobsStore } from '../src/jobs/store'
import { useJobOutcomes } from '../src/jobs/outcomes'
import { useToastStore } from '../src/stores/toasts'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, settled } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 'j1',
  kind: 'index.create',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: 'orders',
  target: 'n_1',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: Date.now(),
  finishedAt: null,
  mine: true,
  cancellable: true,
  ...over,
})

const Host = defineComponent(() => () => h('div', [h(JobsTray), h(DialogHost)]))

const trayButton = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Background jobs"]')!

async function openTray() {
  trayButton().click()
  await flushPromises()
  return document.querySelector('[data-test="jobs-panel"]')!
}

describe('elapsed time (phase 1h spec §6)', () => {
  it('reads naturally in both languages', () => {
    expect(formatElapsed(12_400, 'en')).toBe('12 s')
    expect(formatElapsed(192_000, 'en')).toBe('3 min 12 s')
    expect(formatElapsed(7_500_000, 'en')).toBe('2 h 5 min')
    expect(formatElapsed(12_400, 'tr')).toBe('12 sn')
    expect(formatElapsed(192_000, 'tr')).toBe('3 dk 12 sn')
    expect(formatElapsed(7_500_000, 'tr')).toBe('2 sa 5 dk')
    expect(formatElapsed(-5, 'en')).toBe('0 s')
  })
})

describe('the jobs tray (phase 1h spec §6)', () => {
  it('shows the number of running jobs, and nothing when none runs', async () => {
    mountApp(Host)
    const store = useJobsStore()
    await flushPromises()
    expect(document.querySelector('[data-test="jobs-badge"]')).toBeNull()
    store.upsert(job())
    store.upsert(job({ id: 'j2' }))
    store.upsert(job({ id: 'j3', state: 'done' }))
    await flushPromises()
    expect(document.querySelector('[data-test="jobs-badge"]')!.textContent).toBe('2')
  })

  it('shows measured progress as a bar with numbers, and unmeasured work as elapsed time', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-09-27T10:00:00Z'))
    mountApp(Host)
    const store = useJobsStore()
    store.upsert(job({ progress: { done: 1234, total: 5000 } }))
    store.upsert(
      job({
        id: 'j2',
        kind: 'collection.duplicate',
        target: 'orders_copy',
        estimate: 1_200_000,
        startedAt: Date.now() - 192_000,
      }),
    )
    const panel = await openTray()
    const bars = panel.querySelectorAll('[role="progressbar"]')
    expect(bars[0]!.getAttribute('aria-valuenow')).toBe('24')
    expect(panel.textContent).toContain('1,234 / 5,000')
    expect(bars[1]!.hasAttribute('aria-valuenow')).toBe(false)
    expect(panel.textContent).toContain('Still running · 3 min 12 s')
    expect(panel.textContent).toContain('about 1.2M documents')
    vi.advanceTimersByTime(3_000)
    await flushPromises()
    expect(panel.textContent).toContain('Still running · 3 min 15 s')
    i18n.global.locale.value = 'tr'
    await flushPromises()
    expect(panel.textContent).toContain('Sürüyor · 3 dk 15 sn')
  })

  it('cancels after confirming, only where allowed, and says so when the job had finished', async () => {
    const { calls } = mockApi({
      'POST jobs/j1/cancel': () => [200, { job: job({ state: 'cancelled', cancellable: false }) }],
      'POST jobs/j2/cancel': () => [
        409,
        { code: 'CONFLICT', message: 'The job has already finished', details: { reason: 'finished' } },
      ],
    })
    mountApp(Host)
    const store = useJobsStore()
    store.upsert(job())
    store.upsert(job({ id: 'j2', target: 'e_1' }))
    store.upsert(job({ id: 'j3', target: 'x_1', mine: false, cancellable: false }))
    const panel = await openTray()
    expect(panel.querySelectorAll('[data-action="cancel"]')).toHaveLength(2)
    ;(panel.querySelector('[data-job="j1"] [data-action="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    button('Cancel job').click()
    await flushPromises()
    // The bell also reads what needs attention (UI redesign R1 revision 2 §3.2); only the cancel writes.
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST jobs/j1/cancel',
    ])
    expect(store.byId.j1!.state).toBe('cancelled')
    // The confirmation took the focus, which closes the panel: open it again.
    if (!document.querySelector('[data-test="jobs-panel"]')) await openTray()
    ;(document.querySelector('[data-job="j2"] [data-action="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    button('Cancel job').click()
    await flushPromises()
    expect(useToastStore().toasts.at(-1)?.message).toBe('The job had already finished.')
  })

  it('says when a job is stopping, and when it could not be stopped (final review I3)', async () => {
    mockApi({
      'POST jobs/j1/cancel': () => [202, { job: job() }],
      'POST jobs/j2/cancel': () => [
        409,
        {
          code: 'CONFLICT',
          message: 'The job could not be stopped; it is still running',
          details: { reason: 'not_stopped' },
        },
      ],
    })
    mountApp(Host)
    const store = useJobsStore()
    store.upsert(job())
    store.upsert(job({ id: 'j2', target: 'e_1' }))
    const cancel = async (id: string) => {
      if (!document.querySelector('[data-test="jobs-panel"]')) await openTray()
      ;(document.querySelector(`[data-job="${id}"] [data-action="cancel"]`) as HTMLButtonElement).click()
      await flushPromises()
      button('Cancel job').click()
      await flushPromises()
    }
    await cancel('j1')
    expect(useToastStore().toasts.at(-1)?.message).toBe('Stopping n_1…')
    await cancel('j2')
    expect(useToastStore().toasts.at(-1)?.message).toBe('The job could not be stopped; it is still running.')
  })

  it('lists finished jobs after running ones, with their outcome and error', async () => {
    mountApp(Host)
    const store = useJobsStore()
    store.upsert(job({ id: 'old', state: 'failed', error: 'E11000 duplicate key', startedAt: 1 }))
    store.upsert(job({ id: 'new', startedAt: 2 }))
    const panel = await openTray()
    const rows = [...panel.querySelectorAll('[data-job]')].map((r) => r.getAttribute('data-job'))
    expect(rows).toEqual(['new', 'old'])
    expect(panel.textContent).toContain('Failed: E11000 duplicate key')
  })

  it('opens with the keyboard and closes with Escape, giving focus back', async () => {
    mountApp(Host)
    await flushPromises()
    const trigger = trayButton()
    trigger.focus()
    trigger.click()
    await flushPromises()
    await settled()
    expect(document.querySelector('[data-test="jobs-panel"]')).not.toBeNull()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-test="jobs-panel"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('final review 1h, minor findings (web)', () => {
  it('says how many jobs run in the button’s accessible name (Minor 8)', async () => {
    mountApp(Host)
    const store = useJobsStore()
    await flushPromises()
    expect(trayButton().getAttribute('aria-label')).toBe('Background jobs')
    store.upsert(job())
    store.upsert(job({ id: 'j2' }))
    await flushPromises()
    expect(trayButton().getAttribute('aria-label')).toBe('Background jobs, 2 running')
  })

  it('says how long an ended job took and when it ended, never a counter (user, 2026-10-08)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-09-27T10:00:00Z'))
    mountApp(Host)
    await flushPromises()
    // An hour with nothing running: the times are fixed, not "N ago".
    vi.setSystemTime(new Date('2026-09-27T11:00:00Z'))
    const ended = Date.now() - 3_000
    useJobsStore().upsert(job({ state: 'done', startedAt: Date.now() - 10_000, finishedAt: ended }))
    const panel = await openTray()
    const at = new Date(ended).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
    expect(panel.textContent).toContain(`7 s · ${at}`)
    expect(panel.textContent).not.toContain('ago')
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(panel.textContent).toContain(`7 s · ${at}`)
  })

  it('opens a job chosen in the panel on the jobs page, with its details (user, 2026-10-08)', async () => {
    mockApi({})
    useJobsStore().replaceAll([job({ id: 'done1', state: 'done', finishedAt: Date.now() })])
    mountApp(Host)
    const panel = await openTray()
    panel.querySelector<HTMLButtonElement>('[data-job="done1"] button')!.click()
    await flushPromises()
    expect(useTabsStore().active?.kind).toBe('jobs')
    expect(useJobsStore().focused).toBe('done1')
  })

  it('measures elapsed time on the server’s clock, not a skewed local one (Minor 9)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-09-27T10:00:00Z'))
    mountApp(Host)
    const store = useJobsStore()
    // The server is 2 minutes behind this machine; the job started 12 s ago on its clock.
    const serverNow = Date.now() - 120_000
    store.setServerTime(serverNow)
    store.upsert(job({ kind: 'collection.duplicate', startedAt: serverNow - 12_000 }))
    const panel = await openTray()
    expect(panel.textContent).toContain('Still running · 12 s')
  })
})

describe('job outcomes (phase 1h spec §6)', () => {
  const Outcomes = defineComponent(() => {
    useJobOutcomes()
    return () => h('div')
  })

  it('tells about the user’s own jobs when they end, never about others’', async () => {
    const { queryClient } = mountApp(Outcomes)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const store = useJobsStore()
    const toasts = useToastStore()
    store.upsert(job())
    store.upsert(job({ state: 'done' }))
    expect(toasts.toasts.at(-1)?.message).toBe('The index n_1 is ready.')
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['connections', 'c1', 'databases', 'shop', 'collections', 'orders', 'indexes'],
    })
    store.upsert(job({ id: 'd1', kind: 'collection.duplicate', target: 'orders_copy' }))
    store.upsert(job({ id: 'd1', kind: 'collection.duplicate', target: 'orders_copy', state: 'done' }))
    expect(toasts.toasts.at(-1)?.message).toBe('Copied to orders_copy.')
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['connections', 'c1', 'databases', 'shop', 'collections'],
    })
    store.upsert(job({ id: 'd2', kind: 'collection.duplicate', target: 'x' }))
    store.upsert(job({ id: 'd2', kind: 'collection.duplicate', target: 'x', state: 'failed', error: 'boom' }))
    expect(toasts.toasts.at(-1)?.message).toBe('Duplicating to x failed: boom')
    store.upsert(job({ id: 'c', target: 'c_1' }))
    store.upsert(job({ id: 'c', target: 'c_1', state: 'cancelled' }))
    expect(toasts.toasts.at(-1)?.message).toBe('Cancelled: c_1')
    store.upsert(job({ id: 'u', target: 'u_1' }))
    store.upsert(job({ id: 'u', target: 'u_1', state: 'unknown' }))
    // Minor 5: an index build may still go on inside MongoDB; it was not interrupted.
    expect(toasts.toasts.at(-1)?.message).toBe('The server restarted; MongoDB may still be building u_1.')
    const count = toasts.toasts.length
    store.upsert(job({ id: 'o', mine: false }))
    store.upsert(job({ id: 'o', mine: false, state: 'done' }))
    expect(toasts.toasts).toHaveLength(count)
  })
})

describe('the panel leads to the jobs page (user, 2026-10-08)', () => {
  it('opens the background jobs page and closes itself', async () => {
    mockApi({})
    useJobsStore().replaceAll([job()])
    mountApp(Host)
    const panel = await openTray()
    panel.querySelector<HTMLButtonElement>('button[data-action="all-jobs"]')!.click()
    await flushPromises()
    expect(useTabsStore().active?.kind).toBe('jobs')
    expect(document.querySelector('[data-test="jobs-panel"]')).toBeNull()
  })
})
