// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { CompareReport, CopyPlan, CopyReport } from '@mongo-manager/shared'
import CopyWizard from '../src/transfer/CopyWizard.vue'
import CompareView from '../src/transfer/CompareView.vue'
import ImportReport from '../src/transfer/ImportReport.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

/** Phase 3d-2 final review: the web side of I4, I5, I8, I9, M4 and M5. */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ALL = ['documents:read', 'documents:write', 'databases:write', 'indexes:write', 'jobs:run']
const CONNS = [
  { id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true, restricted: true },
  { id: 'c2', name: 'Dev', access: 'admin', permissions: ALL, export: true },
]
const PLAN: CopyPlan = {
  planHash: 'f'.repeat(64),
  collections: [
    {
      source: 'orders',
      target: 'orders',
      exists: false,
      count: null,
      path: 'stream',
      sharded: false,
      ttlIndexes: [],
      fullSort: false,
    },
  ],
  views: [],
  masked: true,
  missingRules: [],
  mayAddRules: false,
  deployment: 'unknown',
  refusals: [],
}
const PLAN_PATH = 'POST connections/c1/databases/shop/collections/orders/copy/plan'
const REPORT: CompareReport = {
  kind: 'compare',
  source: { connectionId: 'c1', db: 'shop', coll: 'orders' },
  target: { connectionId: 'c2', db: 'shop', coll: 'orders' },
  filter: {},
  ignore: [],
  collections: [
    {
      source: 'orders',
      target: 'orders',
      onlySource: 2,
      onlyTarget: 0,
      different: 0,
      same: 0,
      samples: {
        onlySource: [
          { id: { $oid: 'zz' }, doc: { _id: { $oid: 'zz' }, b: { $numberDecimal: 'abc' } } },
          {
            id: { $numberInt: '2' },
            doc: { _id: { $numberInt: '2' }, b: '[binary, 9000 characters, not shown]' },
          },
        ],
        onlyTarget: [],
        different: [],
      },
    },
  ],
  masked: false,
  versions: { source: 1, target: 1 },
  expiresAt: Date.now() + 3600_000,
  complete: true,
  missingRules: [],
  restricted: { source: false, target: false },
}
const SYNC_JOB = {
  id: 'j2',
  kind: 'data.sync',
  connectionId: 'c1',
  targetConnectionId: 'c2',
  db: 'shop',
  coll: 'orders',
  target: 'shop.orders',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
}

async function toOptions() {
  await flushPromises()
  button('Next').click()
  await flushPromises()
  const select = document.querySelector<HTMLSelectElement>('[data-test="target-connection"] select')!
  select.value = 'c2'
  select.dispatchEvent(new Event('change'))
  await flushPromises()
  button('Next').click()
  await flushPromises()
}

describe('copy wizard, final review (phase 3d-2)', () => {
  it('M5: a source with hidden personal values copies anonymised, locked on', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET transfer/presets': () => [200, { presets: [] }],
      [PLAN_PATH]: () => [200, PLAN],
    })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await toOptions()
    const anonymous = document.querySelector<HTMLInputElement>('[data-test="copy-anonymous"] input')!
    expect(anonymous.checked).toBe(true)
    expect(anonymous.disabled).toBe(true)
    button('Next').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/copy/plan'))!.body).toMatchObject({ anonymous: true })
  })

  // Review of the data fixes (minor): "Update only" is shown for Upsert as for Merge — never a
  // choice sent while hidden.
  it('offers "Update only" for Upsert and Merge', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET transfer/presets': () => [200, { presets: [] }],
      [PLAN_PATH]: () => [200, PLAN],
    })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await toOptions()
    const shown = () => document.body.textContent!.includes('Update only (never add documents)')
    for (const mode of ['upsert', 'merge']) {
      const radio = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!
      radio.checked = true
      radio.dispatchEvent(new Event('change'))
      await flushPromises()
      expect(shown(), mode).toBe(true)
    }
  })

  it('M5: an unknown deployment with the same names warns that the target may be the source', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET transfer/presets': () => [200, { presets: [] }],
      [PLAN_PATH]: () => [200, PLAN],
    })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await toOptions()
    button('Next').click()
    await flushPromises()
    expect(document.body.textContent).toContain('may be the source itself')
  })

  it('I8: copy presets load and save the copy settings', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET transfer/presets': () => [
        200,
        {
          presets: [
            {
              id: 'p1',
              kind: 'copy',
              name: 'Nightly',
              namespace: 'shop.orders',
              body: { mode: 'upsert', keys: ['sku'], copy: { indexes: false } },
            },
          ],
        },
      ],
      [PLAN_PATH]: () => [200, PLAN],
      'POST transfer/presets': (body) => [201, { id: 'p2', ...(body as object) }],
    })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await toOptions()
    const pick = [...document.querySelectorAll<HTMLSelectElement>('select')].find((s) =>
      [...s.options].some((o) => o.value === 'p1'),
    )!
    pick.value = 'p1'
    pick.dispatchEvent(new Event('change'))
    await flushPromises()
    const name = document.querySelector<HTMLInputElement>('input[maxlength="120"]')!
    name.value = 'Weekly'
    name.dispatchEvent(new Event('input'))
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST' && c.path === 'transfer/presets')!.body).toMatchObject({
      kind: 'copy',
      name: 'Weekly',
      namespace: 'shop.orders',
      body: { mode: 'upsert', keys: ['sku'], copy: { indexes: false, anonymous: false } },
    })
    button('Next').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/copy/plan'))!.body).toMatchObject({
      mode: 'upsert',
      keys: ['sku'],
      indexes: false,
    })
  })

  it('M4: a database copy lists views to choose one by one', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET transfer/presets': () => [200, { presets: [] }],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [
          { name: 'orders', type: 'collection' },
          { name: 'recent', type: 'view' },
        ],
      ],
      'POST connections/c1/databases/shop/copy/plan': () => [200, { ...PLAN, views: ['recent'] }],
    })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    const view = document.querySelector<HTMLInputElement>('input[value="recent"]')!
    expect(view.closest('label')!.textContent).toContain('view')
    view.click()
    await flushPromises()
    await toOptions().catch(() => undefined)
    button('Next').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/copy/plan'))!.body).toMatchObject({ collections: ['recent'] })
  })
})

describe('compare tab and sync, final review (phase 3d-2)', () => {
  it('I4: a sample that does not decode is shown as text, and the others still render', async () => {
    mockApi({ 'GET transfer/jobs/j1/report': () => [200, REPORT], 'GET connections': () => [200, []] })
    mountApp(CompareView, { props: { jobId: 'j1' } })
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('not shown')
    expect(document.querySelectorAll('[data-compare] li').length).toBe(2)
  })

  it('I9: a partial comparison says so and cannot be synced', async () => {
    mockApi({
      'GET transfer/jobs/j1/report': () => [200, { ...REPORT, complete: false }],
      'GET connections': () => [200, []],
    })
    mountApp(CompareView, { props: { jobId: 'j1' } })
    await flushPromises()
    expect(document.body.textContent).toContain('did not finish')
    expect(button('Sync…').disabled).toBe(true)
  })

  it('I5: a sync to a target without the rules asks for the personal-data confirmation', async () => {
    const { calls } = mockApi({
      'GET transfer/jobs/j1/report': () => [200, { ...REPORT, missingRules: ['shop.orders.email'] }],
      'GET connections': () => [200, []],
      'POST transfer/sync': () => [202, { job: SYNC_JOB }],
    })
    mountApp(CompareView, { props: { jobId: 'j1' } })
    await flushPromises()
    button('Sync…').click()
    await flushPromises()
    expect(document.body.textContent).toContain('shop.orders.email')
    expect(button('Sync').disabled).toBe(true)
    document.querySelector<HTMLInputElement>('[data-test="sync-confirm-personal"]')!.click()
    await flushPromises()
    button('Sync').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'transfer/sync')!.body).toMatchObject({ confirmPersonal: true })
  })

  it('M4: a view created over a source that was not copied is reported', () => {
    const report: CopyReport = {
      kind: 'copy',
      dryRun: false,
      mode: 'insert',
      collections: [],
      views: [{ name: 'v1', created: true, reason: 'Its source was not copied' }],
      masked: false,
      anonymous: false,
      rulesAdded: 0,
      rejectedFile: false,
      versions: { source: 1, target: 1 },
      restricted: { source: false, target: false },
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    expect(document.body.textContent).toContain('View v1 created; its source was not copied')
  })

  // Review of the data fixes (I2): a validator set before the load is said, with what it means.
  it('says when the validator was set before the load', () => {
    const report: CopyReport = {
      kind: 'copy',
      dryRun: false,
      mode: 'insert',
      collections: [
        {
          source: 'v',
          target: 'v',
          path: 'stream',
          read: 2,
          inserted: 1,
          matched: 0,
          modified: 0,
          upserted: 0,
          skipped: 0,
          failed: 1,
          errors: [],
          moreErrors: false,
          indexes: { built: [], skipped: [] },
          validatorBeforeLoad: true,
        },
      ],
      views: [],
      masked: false,
      anonymous: false,
      rulesAdded: 0,
      rejectedFile: false,
      versions: { source: 1, target: 1 },
      restricted: { source: false, target: false },
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    expect(document.querySelector('[data-validator-before-load]')!.textContent).toContain('were not copied')
  })
})
