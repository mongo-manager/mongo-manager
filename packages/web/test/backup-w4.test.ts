// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { JobView, RestoreReport } from '@mongo-manager/shared'
import BackupsCard from '../src/backup/BackupsCard.vue'
import MappingTable from '../src/backup/MappingTable.vue'
import JobActions from '../src/jobs/JobActions.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useJobsStore } from '../src/jobs/store'
import { useJobOutcomes } from '../src/jobs/outcomes'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

/** W4 item 4 (completion design §2 W4.4): live backup progress, toast actions, restore helpers. */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ALL = [
  'documents:read',
  'documents:write',
  'databases:write',
  'indexes:write',
  'jobs:run',
  'data:export',
]
const CONNS = [{ id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true }]
const JOB = (over: Partial<JobView>): JobView => ({
  id: 'j1',
  kind: 'backup.dump',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: '*',
  target: 'shop-20261016-101010.archive.gz',
  state: 'running',
  progress: { done: 10, total: 100 },
  estimate: null,
  error: null,
  startedAt: Date.now() - 5000,
  finishedAt: null,
  mine: true,
  cancellable: true,
  ...over,
})
const RESTORE_REPORT = (to: string[]): RestoreReport =>
  ({
    kind: 'restore',
    dryRun: false,
    mode: 'insert',
    engine: 'builtin',
    source: { kind: 'kept', name: 'x.archive' },
    namespaces: to.map((t) => ({
      from: t,
      to: t,
      type: 'collection',
      read: 1,
      inserted: 1,
      matched: 0,
      modified: 0,
      upserted: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      moreErrors: false,
      indexes: { built: [], skipped: [] },
      crc: 'ok',
    })),
    views: [],
    rejectedFile: false,
    masked: false,
    rulesAdded: 0,
    versions: { target: 1 },
    restricted: { target: false },
  }) as unknown as RestoreReport

describe('Backups card: live progress (W4.4, U8)', () => {
  it('shows the running backups and restores of this connection with their parts', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 1024 ** 3, ttlHours: 24 }],
      'GET destinations/mine': () => [200, []],
    })
    const jobs = useJobsStore()
    jobs.upsert(
      JOB({
        parts: {
          phase: 'dump',
          count: 2,
          finished: 1,
          items: [
            { name: 'shop.users', state: 'done', done: 2, total: 2 },
            { name: 'shop.orders', state: 'running', done: 40, total: 100 },
          ],
        },
      }),
    )
    jobs.upsert(JOB({ id: 'j2', kind: 'backup.restore', target: 'x.archive' }))
    jobs.upsert(JOB({ id: 'j3', connectionId: 'other' }))
    mountApp(BackupsCard, { props: { connectionId: 'c1' } })
    await flushPromises()
    const running = document.querySelector('[data-test="backups-running"]')!
    expect(running).toBeTruthy()
    expect(running.querySelectorAll('[data-running-job]')).toHaveLength(2)
    expect(running.textContent).toContain('1 of 2 namespaces')
    expect(running.textContent).toContain('shop.orders 40%')
  })
})

describe('finished toasts (W4.4, U8)', () => {
  const Outcomes = defineComponent(() => {
    useJobOutcomes()
    return () => h('div')
  })

  it('offers Download and Open report for a finished backup', async () => {
    mockApi({})
    mountApp(Outcomes)
    mountApp(ToastHost)
    const store = useJobsStore()
    store.upsert(JOB({}))
    store.upsert(JOB({ state: 'done', finishedAt: Date.now() }))
    await flushPromises()
    expect(button('Download')).toBeTruthy()
    button('Open report').click()
    await flushPromises()
    expect(useTabsStore().tabs.some((t) => t.kind === 'jobs')).toBe(true)
    expect(store.reportWanted).toBe('j1')
  })

  it('offers Open collection when a restore wrote one collection, and Open report', async () => {
    mockApi({ 'GET transfer/jobs/j2/report': () => [200, RESTORE_REPORT(['shop.orders'])] })
    mountApp(Outcomes)
    mountApp(ToastHost)
    const store = useJobsStore()
    const r = JOB({ id: 'j2', kind: 'backup.restore', target: 'x.archive' })
    store.upsert(r)
    store.upsert({ ...r, state: 'done', finishedAt: Date.now() })
    await flushPromises()
    expect(button('Open report')).toBeTruthy()
    button('Open collection').click()
    await flushPromises()
    const tab = useTabsStore().tabs.find((t) => t.kind === 'collection')!
    expect(tab.params).toMatchObject({ connectionId: 'c1', db: 'shop', coll: 'orders' })
  })

  it('offers Open database when a restore wrote several collections of one database', async () => {
    mockApi({ 'GET transfer/jobs/j2/report': () => [200, RESTORE_REPORT(['shop.orders', 'shop.users'])] })
    mountApp(Outcomes)
    mountApp(ToastHost)
    const store = useJobsStore()
    const r = JOB({ id: 'j2', kind: 'backup.restore', target: 'x.archive' })
    store.upsert(r)
    store.upsert({ ...r, state: 'done', finishedAt: Date.now() })
    await flushPromises()
    button('Open database').click()
    await flushPromises()
    expect(useTabsStore().tabs.find((t) => t.kind === 'database')!.params).toMatchObject({ db: 'shop' })
  })
})

describe('finished restore actions (W4.4)', () => {
  it('offers Open collection in the job details', async () => {
    mockApi({ 'GET transfer/jobs/j2/report': () => [200, RESTORE_REPORT(['shop.orders'])] })
    mountApp(JobActions, {
      props: {
        job: JOB({ id: 'j2', kind: 'backup.restore', state: 'done', finishedAt: 2, target: 'x.archive' }),
        variant: 'buttons',
      },
    })
    await flushPromises()
    button('Open collection').click()
    await flushPromises()
    expect(useTabsStore().tabs.some((t) => t.kind === 'collection')).toBe(true)
  })

  it('opens its report when asked from a toast', async () => {
    mockApi({ 'GET transfer/jobs/j2/report': () => [200, RESTORE_REPORT(['shop.orders'])] })
    const store = useJobsStore()
    store.focus('j2', { report: true })
    mountApp(JobActions, {
      props: {
        job: JOB({ id: 'j2', kind: 'backup.restore', state: 'done', finishedAt: 2, target: 'x.archive' }),
        variant: 'buttons',
      },
    })
    await flushPromises()
    expect(document.querySelector('[data-backup-report], [data-transfer-report]')).toBeTruthy()
    expect(store.reportWanted).toBeNull()
  })
})

describe('restore mapping suggestions (W4.4)', () => {
  it('puts every namespace into a new database, never one the target already has', async () => {
    const rows = [
      {
        from: { db: 'shop', coll: 'orders' },
        to: { db: 'shop', coll: 'orders' },
        type: 'collection',
        on: true,
      },
      {
        from: { db: 'shop', coll: 'users' },
        to: { db: 'shop', coll: 'users' },
        type: 'collection',
        on: true,
      },
    ]
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 16, 8, 0), toFake: ['Date'] })
    const { wrapper } = mountApp(MappingTable, {
      props: { plan: null, modelValue: rows, taken: ['shop', 'shop_restore_20261016'] },
    })
    button('Into a new database').click()
    await flushPromises()
    const emitted = wrapper.emitted('update:modelValue')!.at(-1)![0] as typeof rows
    expect(emitted.map((r) => r.to.db)).toEqual(['shop_restore_20261016_2', 'shop_restore_20261016_2'])
    vi.useRealTimers()
  })

  // W4 review (minor): two databases' collections of one name never meet in one new database.
  it('gives each source database a new database of its own', async () => {
    const rows = ['shop', 'crm'].flatMap((db) =>
      ['users', 'orders'].map((coll) => ({
        from: { db, coll },
        to: { db, coll },
        type: 'collection',
        on: true,
      })),
    )
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 16, 8, 0), toFake: ['Date'] })
    const { wrapper } = mountApp(MappingTable, {
      props: { plan: null, modelValue: rows, taken: ['crm_restore_20261016'] },
    })
    button('Into new databases').click()
    await flushPromises()
    const emitted = wrapper.emitted('update:modelValue')!.at(-1)![0] as typeof rows
    expect(emitted.map((r) => `${r.from.db}→${r.to.db}`)).toEqual([
      'shop→shop_restore_20261016',
      'shop→shop_restore_20261016',
      'crm→crm_restore_20261016_2',
      'crm→crm_restore_20261016_2',
    ])
    vi.useRealTimers()
  })
})
