// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { JobView } from '@mongo-manager/shared'
import ActivityModule from '../src/workspace/overview/ActivityModule.vue'
import { useJobsStore } from '../src/jobs/store'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const NOW = Date.now()
const job = (over: Partial<JobView>): JobView => ({
  id: 'j1',
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
  startedAt: NOW - 5_000,
  finishedAt: NOW - 1_000,
  mine: true,
  cancellable: false,
  ...over,
})

describe('Overview’s activity (user, 2026-10-08: jobs read as on the jobs page)', () => {
  it('shows each job as the jobs page does — state, where the work went, how long and when', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    useJobsStore().replaceAll([
      job({}),
      job({
        id: 'j2',
        state: 'running',
        finishedAt: null,
        progress: { done: 1, total: 4 },
        target: 'big.json',
      }),
    ])
    mountApp(ActivityModule)
    await flushPromises()
    const text = document.body.textContent!
    expect(text).toContain('shop.orders')
    expect(text).toContain('4 s ·')
    expect(text).not.toContain('Done')
    expect(document.querySelector('[data-job="j1"] [data-status="done"]')).not.toBeNull()
    expect(document.querySelector('[data-job="j2"] [role="progressbar"]')).not.toBeNull()
  })

  it('opens a job, or every job, on the jobs page', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    useJobsStore().replaceAll([job({})])
    mountApp(ActivityModule)
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-job="j1"] button')!.click()
    expect(useTabsStore().active?.kind).toBe('jobs')
    expect(useJobsStore().focused).toBe('j1')
    useTabsStore().home()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Show all jobs')!
      .click()
    expect(useTabsStore().active?.kind).toBe('jobs')
  })
})
