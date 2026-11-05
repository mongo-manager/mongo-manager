// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { JobView } from '@mongo-manager/shared'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useJobsStore } from '../src/jobs/store'
import { useJobOutcomes } from '../src/jobs/outcomes'
import { useToastStore } from '../src/stores/toasts'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'
import { useTabSectionsStore } from '../src/stores/tabSections'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  try {
    localStorage.clear()
  } catch {
    // no storage: tabs simply start empty
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 'js',
  kind: 'backup.send',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: '*',
  target: 'shop-20261003-120000.mmbak',
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

const Outcomes = defineComponent(() => {
  useJobOutcomes()
  return () => h('div')
})

function setup() {
  const { queryClient } = mountApp(Outcomes)
  mountApp(ToastHost)
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const store = useJobsStore()
  const finish = (over: Partial<JobView>) => {
    store.upsert(job({ ...over, state: 'running' }))
    store.upsert(job({ ...over, state: over.state ?? 'done' }))
  }
  return { queryClient, invalidate, finish, toasts: useToastStore(), tabs: useTabsStore() }
}
const keys = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))

describe('send and fetch outcomes (phase 3d-3b V8)', () => {
  it('announces a finished send and opens its connection’s Backups section from the toast', async () => {
    const { queryClient, invalidate, finish, toasts, tabs } = setup()
    queryClient.setQueryData(['connections'], [{ id: 'c1', name: 'Prod' }])
    const section = document.createElement('section')
    section.id = 'backups-c1'
    section.scrollIntoView = vi.fn()
    document.body.appendChild(section)
    finish({ state: 'done' })
    expect(toasts.toasts.at(-1)).toMatchObject({
      kind: 'success',
      message: 'shop-20261003-120000.mmbak was sent',
    })
    // Copies changed (and the local backup may be gone): both lists are read again.
    expect(keys(invalidate)).toEqual(expect.arrayContaining(['["backups"]', '["destinations"]']))
    await flushPromises()
    button('Open in Backups').click()
    await flushPromises()
    expect(tabs.active).toMatchObject({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    // User request 2026-10-23: on its Backups tab.
    expect(useTabSectionsStore().get(tabs.activeId!, 'overview')).toBe('backups')
    expect(section.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    // The toast closed with its action.
    expect(toasts.toasts.some((t) => t.message.includes('was sent'))).toBe(false)
  })

  it('opens nothing when the connection is no longer known', async () => {
    const { finish, tabs } = setup()
    const before = JSON.stringify(tabs.tabs)
    finish({ state: 'done' })
    await flushPromises()
    button('Open in Backups').click()
    await flushPromises()
    expect(JSON.stringify(tabs.tabs)).toBe(before)
  })

  it('says why a send failed, with no action to follow', async () => {
    const { finish, toasts, invalidate } = setup()
    finish({ state: 'failed', error: 'Not sent — Offsite S3: The destination is full.' })
    expect(toasts.toasts.at(-1)).toEqual({
      id: expect.any(Number),
      kind: 'error',
      // Phase 3d-3b final review C24: one prefix, the reader's (the server's own is stripped).
      message: 'Not sent — Offsite S3: The destination is full.',
    })
    expect(keys(invalidate)).toEqual(expect.arrayContaining(['["backups"]', '["destinations"]']))
  })

  it('says when a download from a destination failed, and stays quiet when it finished', async () => {
    const { finish, toasts, invalidate } = setup()
    finish({ id: 'jf', kind: 'backup.fetch', state: 'done' })
    expect(toasts.toasts).toEqual([])
    // Nothing changed anywhere: the restore sheet that asked carries on.
    expect(invalidate).not.toHaveBeenCalled()
    finish({ id: 'jf2', kind: 'backup.fetch', state: 'failed', error: 'The backup is archived' })
    expect(toasts.toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: 'The download failed: The backup is archived',
    })
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('The download failed')
  })

  it('refreshes for everyone but tells only the person who sent it', () => {
    const { finish, toasts, invalidate } = setup()
    finish({ state: 'done', mine: false })
    expect(toasts.toasts).toEqual([])
    expect(keys(invalidate)).toEqual(expect.arrayContaining(['["backups"]', '["destinations"]']))
  })

  it('names a cancelled send as cancelled, not as failed', () => {
    const { finish, toasts } = setup()
    finish({ state: 'cancelled' })
    expect(toasts.toasts.at(-1)).toMatchObject({
      kind: 'info',
      message: 'Cancelled: shop-20261003-120000.mmbak',
    })
    expect(toasts.toasts.at(-1)?.actions).toBeUndefined()
  })
})

describe('backup and restore outcomes (phase 3d-3a U8)', () => {
  it('downloads a finished backup from its toast, and nothing when the report is not a backup', async () => {
    // Phase 3d-3b final review: the end of a dump reads its report once (a send that could not start),
    // the Download action reads it again.
    const reports: unknown[] = [
      { kind: 'dump', backupId: 'b/1' },
      { kind: 'dump', backupId: 'b/1' },
      { kind: 'export' },
      { kind: 'export' },
    ]
    const { calls } = mockApi({ 'GET transfer/jobs/jd/report': () => [200, reports.shift()] })
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.href)
    })
    const { finish, invalidate } = setup()
    finish({ id: 'jd', kind: 'backup.dump', target: 'shop' })
    expect(keys(invalidate)).toContain('["backups"]')
    await flushPromises()
    button('Download').click()
    await flushPromises()
    expect(calls.map((c) => c.path)).toEqual(['transfer/jobs/jd/report', 'transfer/jobs/jd/report'])
    expect(clicked).toHaveLength(1)
    // The backup id is encoded into the download address (team mode: the link as it is).
    expect(clicked[0]).toMatch(/\/api\/backups\/b%2F1\/download$/)
    finish({ id: 'jd', kind: 'backup.dump', target: 'shop' })
    await flushPromises()
    button('Download').click()
    await flushPromises()
    expect(clicked).toHaveLength(1)
  })

  it('reads the target connection’s databases again after a restore, and says how it went', () => {
    const { finish, toasts, invalidate } = setup()
    finish({ id: 'jr', kind: 'backup.restore', target: 'shop' })
    expect(toasts.toasts.at(-1)).toMatchObject({ kind: 'success', message: 'Restore finished: shop' })
    expect(keys(invalidate)).toContain('["connections","c1","databases"]')
    finish({ id: 'jr2', kind: 'backup.restore', target: 'shop', state: 'failed', error: 'E11000' })
    expect(toasts.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'Restore failed: shop: E11000' })
  })
})
