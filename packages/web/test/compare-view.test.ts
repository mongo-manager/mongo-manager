import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { CompareReport, CopyReport, JobView, SyncReport } from '@mongo-manager/shared'
import CompareView from '../src/transfer/CompareView.vue'
import ImportReport from '../src/transfer/ImportReport.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

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
      onlySource: 1,
      onlyTarget: 2,
      different: 1,
      same: 5,
      samples: {
        onlySource: [{ id: { $numberInt: '1' }, doc: { _id: { $numberInt: '1' }, v: { $numberInt: '1' } } }],
        onlyTarget: [],
        different: [
          {
            id: { $numberInt: '2' },
            changes: [{ path: 'v', before: { $numberInt: '9' }, after: { $numberInt: '2' } }],
            more: false,
          },
        ],
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
} satisfies JobView

describe('compare tab (phase 3d-2 spec §3.2)', () => {
  it('shows the four counts and a field diff, and a sync with deletions needs the typed name', async () => {
    const { calls } = mockApi({
      'GET transfer/jobs/j1/report': () => [200, REPORT],
      'GET connections': () => [200, []],
      'POST transfer/sync': () => [202, { job: SYNC_JOB }],
    })
    mountApp(CompareView, { props: { jobId: 'j1' } })
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Only in source')
    expect(text).toContain('Only in target')
    expect(document.querySelector('[data-count="onlyTarget"]')!.textContent).toContain('2')
    document.querySelector<HTMLButtonElement>('[data-count="different"]')!.click()
    await flushPromises()
    expect(document.querySelector('[data-test="diff"]')!.textContent).toContain('v')
    button('Sync…').click()
    await flushPromises()
    document.querySelector<HTMLInputElement>('[data-test="sync-delete"]')!.click()
    await flushPromises()
    expect(button('Sync').disabled).toBe(true)
    const confirm = document.querySelector<HTMLInputElement>('[data-test="sync-confirm"]')!
    confirm.value = 'orders'
    confirm.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(button('Sync').disabled).toBe(false)
    button('Sync').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'transfer/sync')!.body).toEqual({
      compareJobId: 'j1',
      insert: true,
      replace: true,
      delete: true,
      confirm: 'orders',
      confirmPersonal: false,
    })
  })

  // UI redesign R4: the comparison opens on the page header; its collections are a named table and the
  // samples of the group shown are a card named after the group.
  it('opens on the page header, lists its collections as a table and its samples in a card', async () => {
    const first = REPORT.collections[0]!
    mockApi({
      'GET transfer/jobs/j1/report': () => [
        200,
        { ...REPORT, collections: [first, { ...first, source: 'items', target: 'items' }] },
      ],
      'GET connections': () => [200, []],
    })
    mountApp(CompareView, { props: { jobId: 'j1' } })
    await flushPromises()
    expect(document.querySelector('[data-compare] header h2')!.textContent).toContain('⇄')
    const table = document.querySelector('table[aria-label="Collections"]')!
    expect(
      [...table.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')!.textContent!.trim()),
    ).toEqual(['orders', 'items'])
    // Review of R3–R5 (I-3): the figures keep a column of their own and the name gives way, shortened
    // with its whole text on hover.
    const heads = [...table.querySelectorAll('thead th')] as HTMLElement[]
    expect(heads.slice(1, 5).map((th) => th.style.width)).toEqual(['7rem', '7rem', '7rem', '7rem'])
    const name = table.querySelector('tbody td span')!
    expect(name.className).toContain('truncate')
    expect(name.getAttribute('title')).toBe('orders')
    const card = [...document.querySelectorAll('section[aria-labelledby]')].find(
      (s) => s.querySelector('h3')!.textContent!.trim() === 'Different',
    )!
    // One sample from each collection (a diff's own list of fields is inside its sample).
    expect(card.querySelector('ul')!.children).toHaveLength(2)
  })

  it('says when the comparison has expired', async () => {
    mockApi({
      'GET transfer/jobs/j1/report': () => [404, { code: 'NOT_FOUND', message: 'Report not found' }],
      'GET connections': () => [200, []],
    })
    mountApp(CompareView, { props: { jobId: 'j1' } })
    await flushPromises()
    expect(document.body.textContent).toContain('This comparison has expired')
  })
})

describe('copy and sync report cards (phase 3d-2)', () => {
  it('shows a copy report per collection, with indexes, views and the path', () => {
    const report: CopyReport = {
      kind: 'copy',
      dryRun: false,
      mode: 'insert',
      collections: [
        {
          source: 'orders',
          target: 'orders',
          path: 'shortcut',
          read: 3,
          inserted: 3,
          matched: 0,
          modified: 0,
          upserted: 0,
          skipped: 0,
          failed: 0,
          errors: [],
          moreErrors: false,
          indexes: { built: ['email_1'], skipped: [{ name: 'phone_1', reason: 'personal' }] },
        },
      ],
      views: [{ name: 'v1', created: false, reason: 'writes' }],
      masked: false,
      anonymous: true,
      rulesAdded: 2,
      rejectedFile: false,
      versions: { source: 1, target: 1 },
      restricted: { source: false, target: false },
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Copied inside the server.')
    expect(text).toContain('Indexes built: email_1')
    expect(text).toContain('Index phone_1 not built: personal')
    expect(text).toContain('View v1 not created: writes')
    expect(text).toContain('2 personal-field rules were added')
    expect(text).toContain('Personal values were written as ***.')
  })

  it('shows a sync report with what changed meanwhile and stopped deletions', () => {
    const report: SyncReport = {
      kind: 'sync',
      compareJobId: 'j1',
      collections: [
        {
          source: 'orders',
          target: 'orders',
          inserted: 1,
          replaced: 2,
          deleted: 3,
          changedMeanwhile: 4,
          failed: 0,
          errors: [],
          moreErrors: false,
          deletionStopped: true,
        },
      ],
      masked: false,
      versions: { source: 1, target: 1 },
      restricted: { source: false, target: false },
    }
    mountApp(ImportReport, { props: { jobId: 'j3', report } })
    const text = document.body.textContent ?? ''
    expect(text).toContain('2 replaced')
    expect(text).toContain('3 deleted')
    expect(text).toContain('4 changed meanwhile')
    expect(text).toContain('Deletions stopped')
  })
})
