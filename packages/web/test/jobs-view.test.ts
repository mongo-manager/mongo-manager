// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS, type JobView } from '@mongo-manager/shared'
import JobsView from '../src/jobs/JobsView.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useJobsStore } from '../src/jobs/store'
import { useTabsStore } from '../src/stores/tabs'
import { useCommandsStore } from '../src/stores/commands'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel } from './support/dom'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// A fixed noon, the clock set to it for every test: a run that starts just after midnight saw a job
// of a minute ago under Yesterday (2026-10-24).
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000
let n = 0
const job = (over: Partial<JobView>): JobView => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  kind: 'data.export',
  connectionId: 'c1',
  db: 'shop',
  coll: 'orders',
  targetConnectionId: null,
  target: 'orders.json',
  state: 'done',
  progress: null,
  estimate: null,
  error: null,
  startedAt: NOW - 60_000,
  finishedAt: NOW - 57_000,
  mine: true,
  cancellable: false,
  ...over,
})
const conn = (id: string, name: string) => ({
  id,
  name,
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  access: 'admin',
  permissions: [],
})
const CONNECTIONS = [conn('c1', 'Prod'), conn('c2', 'Archive')]

async function page(jobs: JobView[], handlers: Record<string, Handler> = {}) {
  const api = mockApi({ 'GET connections': () => [200, CONNECTIONS], ...handlers })
  useJobsStore().replaceAll(jobs)
  mountApp(JobsView)
  mountApp(DialogHost)
  await flushPromises()
  return api
}
const lines = () => [...document.querySelectorAll<HTMLElement>('[data-day] [data-job]')]
const running = () => [...document.querySelectorAll<HTMLElement>('[data-running]')]
const card = (id: string) => document.querySelector<HTMLButtonElement>(`[data-card="${id}"]`)!
const radio = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent?.trim() === label)!
const days = () => [...document.querySelectorAll('[data-day] h4')].map((h) => h.textContent?.trim())

describe('the background jobs page (user, 2026-10-08: "yeni baştan tasarla")', () => {
  it('sums up in three cards that filter: running now, ended in 24 hours, failed in 24 hours', async () => {
    await page([
      job({ state: 'running', finishedAt: null, progress: { done: 1, total: 4 } }),
      job({ state: 'failed', error: 'boom' }),
      job({ target: 'old.json', startedAt: NOW - 3 * DAY, finishedAt: NOW - 3 * DAY + 5_000 }),
    ])
    expect(card('running').textContent).toContain('1')
    expect(card('recent').textContent).toContain('1')
    expect(card('failed').textContent).toContain('1')
    card('failed').click()
    await flushPromises()
    expect(card('failed').getAttribute('aria-pressed')).toBe('true')
    expect(lines()).toHaveLength(1)
    expect(running()).toHaveLength(0)
    card('failed').click()
    await flushPromises()
    expect(lines()).toHaveLength(2)
    card('running').click()
    await flushPromises()
    expect(running()).toHaveLength(1)
    expect(lines()).toHaveLength(0)
  })

  it('shows a running job large: progress, how much, how long, the time left once known, Cancel', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    const big = job({
      state: 'running',
      finishedAt: null,
      cancellable: true,
      progress: { done: 1000, total: 4000 },
    })
    await page([big])
    const [first] = running()
    expect(first!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25')
    expect(first!.textContent).toContain('25%')
    expect(first!.textContent).toContain('1,000 / 4,000 documents')
    expect(first!.textContent).not.toContain('left')
    vi.setSystemTime(NOW + 1_000)
    useJobsStore().upsert({ ...big, progress: { done: 2000, total: 4000 } })
    await flushPromises()
    expect(running()[0]!.textContent).toContain('~2 s left')
    expect(running()[0]!.textContent).toContain('1,000 documents/s')
  })

  it('offers Cancel only where the user may cancel, and asks first', async () => {
    const mine = job({ state: 'running', finishedAt: null, cancellable: true, target: 'big.json' })
    const { calls } = await page(
      [mine, job({ state: 'running', finishedAt: null, cancellable: false, mine: false })],
      {
        [`POST jobs/${mine.id}/cancel`]: () => [
          200,
          { job: { ...mine, state: 'cancelled', cancellable: false } },
        ],
      },
    )
    const cancels = document.querySelectorAll<HTMLButtonElement>(
      '[data-running] button[data-action="cancel"]',
    )
    expect(cancels).toHaveLength(1)
    cancels[0]!.click()
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(false)
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === `jobs/${mine.id}/cancel`)).toBe(true)
    expect(useJobsStore().byId[mine.id]!.state).toBe('cancelled')
  })

  it('lists the history by day, each job in one line: how long it took and when it ended', async () => {
    const yesterday = new Date(NOW)
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(9, 5, 0, 0)
    await page([
      job({ target: 'today.json' }),
      job({
        target: 'yesterday.json',
        startedAt: yesterday.getTime() - 4_000,
        finishedAt: yesterday.getTime(),
      }),
      job({
        state: 'failed',
        kind: 'data.import',
        target: 'in.csv',
        error: 'E11000 duplicate key\nmore detail',
      }),
    ])
    expect(days()).toEqual(['Today', 'Yesterday'])
    const today = lines().find((l) => l.textContent?.includes('today.json'))!
    expect(today.textContent).toContain('shop.orders')
    expect(today.textContent).toContain('3 s ·')
    expect(today.textContent).not.toContain('ago')
    const failed = lines().find((l) => l.textContent?.includes('in.csv'))!
    expect(failed.querySelector('[data-status="failed"]')).not.toBeNull()
    expect(failed.textContent).toContain('Failed: E11000 duplicate key')
    expect(failed.textContent).not.toContain('more detail')
  })

  it('says a job quicker than a second took under a second, not "0 s"', async () => {
    await page([job({ startedAt: NOW - 1_000, finishedAt: NOW - 600 })])
    expect(lines()[0]!.textContent).toContain('under 1 s ·')
    expect(lines()[0]!.textContent).not.toContain('0 s')
  })

  it('filters the history by outcome, kind, connection, owner and words, and clears them', async () => {
    await page([
      job({}),
      job({ state: 'failed', error: 'disk full', kind: 'data.import', target: 'in.csv' }),
      job({ state: 'interrupted', connectionId: 'c2', mine: false, target: 'other.json' }),
    ])
    radio('Failed').click()
    await flushPromises()
    expect(lines()).toHaveLength(2)
    radio('All').click()
    const kind = byLabel<HTMLSelectElement>('Kind of job')
    kind.value = 'data.import'
    kind.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(lines().map((l) => l.textContent)).toEqual([expect.stringContaining('in.csv')])
    kind.value = 'all'
    kind.dispatchEvent(new Event('change'))
    const connection = byLabel<HTMLSelectElement>('Connection')
    connection.value = 'c2'
    connection.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]!.textContent).toContain('Another user')
    ;(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click()
    await flushPromises()
    expect(document.body.textContent).toContain('No job matches these filters')
    button('Clear the filters').click()
    await flushPromises()
    expect(lines()).toHaveLength(3)
  })

  it('shows a job in full beside the list: headline, actions, timeline, the whole error to copy', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const failed = job({ state: 'failed', error: 'E11000 duplicate key error collection: shop.orders' })
    await page([failed])
    lines()[0]!.querySelector('button')!.click()
    await flushPromises()
    const details = document.querySelector('[data-job-details]')!
    expect(details.textContent).toContain('Export failed')
    expect(details.textContent).toContain('Timeline')
    expect(details.textContent).toContain('took 3 s')
    expect(details.querySelector('[data-job-error]')!.textContent).toContain('E11000 duplicate key')
    button('Copy the error').click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('E11000 duplicate key error collection: shop.orders')
    ;(details.querySelector('button[aria-label="Copy the job id"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith(failed.id)
    button('Open the collection').click()
    expect(useTabsStore().active).toMatchObject({
      kind: 'collection',
      params: { db: 'shop', coll: 'orders' },
    })
  })

  it('offers an export’s file as its first action', async () => {
    const done = job({})
    await page([done])
    lines()[0]!.querySelector('button')!.click()
    await flushPromises()
    const download = document.querySelector<HTMLAnchorElement>('[data-job-details] a[download]')!
    expect(download.textContent).toContain('Download')
    expect(download.getAttribute('href')).toContain(done.id)
  })

  it('opens the job the jobs panel asked for', async () => {
    const asked = job({ target: 'asked.json' })
    useJobsStore().focus(asked.id)
    await page([job({}), asked])
    expect(document.querySelector('[data-job-details]')!.textContent).toContain('asked.json')
    expect(useJobsStore().focused).toBeNull()
  })

  it('shows names as text, never as markup (abuse case)', async () => {
    await page([
      job({ target: '<img src=x onerror="window.hit=1">', coll: '<b>x</b>', error: '<script>1</script>' }),
    ])
    expect(
      document.querySelector('[data-jobs-page] img, [data-jobs-page] b, [data-jobs-page] script'),
    ).toBeNull()
    expect(lines()[0]!.textContent).toContain('<img src=x')
  })

  it('says when only the newest jobs are listed, and what an empty list means', async () => {
    await page(Array.from({ length: 200 }, () => job({})))
    expect(document.body.textContent).toContain('The 200 newest jobs are shown.')
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    await page([])
    expect(document.body.textContent).toContain('No background jobs yet')
  })
})

describe('reaching the page', () => {
  const ME = {
    mode: 'local',
    user: { id: 'local', username: 'owner', role: 'admin' },
    permissions: [...PERMISSIONS],
    csrfToken: 'c',
    readOnly: false,
    twoFactor: {},
  }
  async function workspace(path = '/') {
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, ME],
      'GET connections': () => [200, CONNECTIONS],
      'GET jobs': () => [200, { jobs: [] }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push(path)
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    return router
  }

  it('opens from the sidebar’s Background jobs, from its address and from the palette', async () => {
    const router = await workspace()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Activity')!
      .click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('button, a')]
      .find((b) => b.textContent?.trim() === 'Background jobs')!
      .click()
    await flushPromises()
    expect(useTabsStore().active?.kind).toBe('jobs')
    expect(router.currentRoute.value.path).toBe('/jobs')
    await vi.waitFor(() => expect(document.querySelector('[data-jobs-page]')).not.toBeNull())
    expect(
      useCommandsStore()
        .search('background')
        .some((c) => c.id === 'jobs'),
    ).toBe(true)
  })

  it('opens when its address is visited', async () => {
    await workspace('/jobs')
    expect(useTabsStore().active?.kind).toBe('jobs')
  })
})
