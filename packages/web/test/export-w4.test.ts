// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ExportReport, JobView, SchemaAnalysis } from '@mongo-manager/shared'
import ExportDataDialog from '../src/transfer/ExportDataDialog.vue'
import ImportReport from '../src/transfer/ImportReport.vue'
import JobActions from '../src/jobs/JobActions.vue'
import { schemaColumns } from '../src/transfer/schemaColumns'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'

/** W4 item 2 (completion design §2 W4.2): columns from a schema sample, arrays, the file's expiry. */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const C = 'connections/c1'
const NS = `${C}/databases/shop/collections/people`
const field = (keys: Array<string | null>, types: Record<string, number>, extra = {}) => ({
  path: keys.map((k) => k ?? '[]').join('.'),
  keys,
  count: 1,
  types,
  ...extra,
})
const SCHEMA: SchemaAnalysis = {
  sampled: 3,
  truncated: false,
  fields: [
    field(['name'], { string: 3 }),
    field(['_id'], { objectId: 3 }),
    field(['address'], { object: 3 }),
    field(['address', 'city'], { string: 3 }),
    field(['tags'], { array: 3 }, { arrays: { minLength: 1, maxLength: 4, avgLength: 2 } }),
    field(['tags', null], { string: 6 }),
    field(['meta'], { object: 1, string: 2 }),
    field(['meta', 'x'], { int: 1 }),
    field(['email'], { string: 3 }, { masked: true }),
  ] as SchemaAnalysis['fields'],
}
const JOB: JobView = {
  id: 'j1',
  kind: 'data.export',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: 'people',
  target: 'people.csv',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
}

describe('columns from a schema sample (W4.2)', () => {
  it('derives leaf columns, _id first, whole values above their children, arrays marked', () => {
    expect(schemaColumns(SCHEMA)).toEqual([
      { path: '_id', array: false, masked: false },
      { path: 'name', array: false, masked: false },
      { path: 'address.city', array: false, masked: false },
      { path: 'tags', array: true, masked: false },
      { path: 'meta', array: false, masked: false },
      { path: 'email', array: false, masked: true },
    ])
  })

  it('proposes them when the dialog is opened from the tree, without fields of its own', async () => {
    const { calls } = mockApi({
      [`POST ${NS}/schema`]: () => [200, SCHEMA],
      [`POST ${NS}/count`]: () => [200, { count: 3, exact: true }],
      [`POST ${NS}/export`]: () => [202, { job: JOB }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [['email']] }],
    })
    mountApp(ExportDataDialog, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/schema'))!.body).toEqual({ sampleSize: 100 })
    const listed = [...document.querySelectorAll('[aria-label^="Include "]')].map((e) =>
      e.getAttribute('aria-label'),
    )
    expect(listed).toEqual([
      'Include _id',
      'Include name',
      'Include address.city',
      'Include tags',
      'Include meta',
      'Include email',
    ])
    button('Export').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/export'))!.body).toMatchObject({
      source: { kind: 'collection' },
      fields: ['_id', 'name', 'address.city', 'tags', 'meta', 'email'],
    })
  })

  it('does not sample for a pipeline, whose output is not the collection', async () => {
    const { calls } = mockApi({
      [`POST ${NS}/export`]: () => [202, { job: JOB }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ExportDataDialog, {
      props: { connectionId: 'c1', db: 'shop', coll: 'people', stages: [{ $match: {} }] },
    })
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/schema'))).toBe(false)
  })

  it('keeps the fields handed over by the documents view, without sampling', async () => {
    const { calls } = mockApi({
      [`POST ${NS}/count`]: () => [200, { count: 3, exact: true }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ExportDataDialog, {
      props: { connectionId: 'c1', db: 'shop', coll: 'people', query: { filter: {} }, fields: ['a'] },
    })
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/schema'))).toBe(false)
  })
})

describe('arrays as columns (W4.2)', () => {
  it('sends one column per element up to the bound, or the elements joined', async () => {
    const { calls } = mockApi({
      [`POST ${NS}/schema`]: () => [200, SCHEMA],
      [`POST ${NS}/count`]: () => [200, { count: 3, exact: true }],
      [`POST ${NS}/export`]: () => [202, { job: JOB }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ExportDataDialog, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Arrays'), 'index')
    await typeInto(byLabel('Columns per array (at most)'), '4')
    button('Export').click()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/export')).at(-1)!.body).toMatchObject({
      arrays: { mode: 'index', max: 4 },
    })
  })

  it('sends the separator for joined arrays, and hides the option for JSON', async () => {
    const { calls } = mockApi({
      [`POST ${NS}/schema`]: () => [200, SCHEMA],
      [`POST ${NS}/count`]: () => [200, { count: 3, exact: true }],
      [`POST ${NS}/export`]: () => [202, { job: JOB }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ExportDataDialog, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Arrays'), 'join')
    await typeInto(byLabel('Separator'), ' | ')
    button('Export').click()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/export')).at(-1)!.body).toMatchObject({
      arrays: { mode: 'join', separator: ' | ' },
    })
    await choose(byLabel<HTMLSelectElement>('Format'), 'json')
    expect(document.querySelector('label')?.textContent).not.toBe('Arrays')
    expect([...document.querySelectorAll('label')].some((l) => l.textContent?.trim() === 'Arrays')).toBe(
      false,
    )
  })
})

describe("the export file's expiry (W4.2)", () => {
  const REPORT: ExportReport = {
    kind: 'export',
    written: 3,
    bytes: 120,
    omittedFields: [],
    cutCells: 0,
    expiresAt: Date.UTC(2026, 9, 17, 9, 30),
    masked: false,
  }

  it('says until when the file can be downloaded, in the report', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 16, 9, 30) })
    mountApp(ImportReport, { props: { jobId: 'j1', report: REPORT } })
    const expiry = document.querySelector('[data-test="export-expiry"]')!
    expect(expiry.textContent).toMatch(/Available to download until .*\(tomorrow\)/)
    expect(expiry.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-17T09:30:00.000Z')
  })

  it('says so next to Download in the jobs list', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 16, 9, 30), toFake: ['Date'] })
    mockApi({ 'GET transfer/jobs/j1/report': () => [200, REPORT] })
    mountApp(JobActions, { props: { job: { ...JOB, state: 'done', finishedAt: 2 } } })
    await flushPromises()
    expect(document.querySelector('a[href$="transfer/files/j1"]')).toBeTruthy()
    expect(document.querySelector('[data-test="export-expiry"]')!.textContent).toContain('tomorrow')
  })

  it('offers no download once the file expired, and says so', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 18, 9, 30), toFake: ['Date'] })
    mockApi({ 'GET transfer/jobs/j1/report': () => [200, REPORT] })
    mountApp(JobActions, { props: { job: { ...JOB, state: 'done', finishedAt: 2 } } })
    await flushPromises()
    expect(document.querySelector('a[href$="transfer/files/j1"]')).toBeNull()
    expect(document.querySelector('[data-test="export-expiry"]')!.textContent).toContain(
      'The file expired; export again',
    )
  })
})
