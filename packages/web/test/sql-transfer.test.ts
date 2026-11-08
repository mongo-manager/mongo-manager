// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import {
  PERMISSIONS,
  type JobView,
  type SqlImportReport,
  type SqlPreviewResponse,
} from '@mongo-manager/shared'
import SqlImportPanel from '../src/transfer/SqlImportPanel.vue'
import SqlExportPanel from '../src/transfer/SqlExportPanel.vue'
import ExportDataDialog from '../src/transfer/ExportDataDialog.vue'
import ImportWizard from '../src/transfer/ImportWizard.vue'
import ImportReport from '../src/transfer/ImportReport.vue'
import ResultsToolbar from '../src/documents/ResultsToolbar.vue'
import JobActions from '../src/jobs/JobActions.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { createAppRouter } from '../src/router'
import { useJobsStore } from '../src/jobs/store'
import { useJobOutcomes } from '../src/jobs/outcomes'
import { kindKey } from '../src/jobs/labels'
import { useToastStore } from '../src/stores/toasts'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { useTabsStore } from '../src/stores/tabs'
import { useCommandsStore } from '../src/stores/commands'
import { usePluginsStore } from '../src/plugins/store'
import { useSessionStore } from '../src/stores/session'
import { useWorkspaceCommands } from '../src/workspace/commands'
import { useShownJob } from '../src/transfer/shownJobs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, choose, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
/** Panels left mounted by a test: unmounted while the API is still mocked (they discard uploads). */
const leaving: Array<() => void> = []
afterEach(() => {
  for (const leave of leaving.splice(0)) leave()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  i18n.global.locale.value = 'en'
})

/** A stand-in for XMLHttpRequest: answers the upload with the given JSON, and records it. */
function fakeXhr(status: number, body: unknown) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  class Fake {
    upload = { onprogress: null as null | ((e: { loaded: number; total: number }) => void) }
    status = status
    responseText = JSON.stringify(body)
    withCredentials = false
    onload: null | (() => void) = null
    onerror: null | (() => void) = null
    onabort: null | (() => void) = null
    private url = ''
    private headers: Record<string, string> = {}
    open(_method: string, url: string) {
      this.url = url
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v
    }
    send(payload: unknown) {
      sent.push({ url: this.url, headers: this.headers, body: payload })
      this.upload.onprogress?.({ loaded: 5, total: 10 })
      queueMicrotask(() => this.onload?.())
    }
    abort() {}
  }
  vi.stubGlobal('XMLHttpRequest', Fake)
  return sent
}

/** The element of this exact label (compared as text: a label may hold a backslash). */
const byAria = <T extends HTMLElement>(label: string, tag = '*') =>
  [...document.querySelectorAll<T>(`${tag}[aria-label]`)].find((e) => e.getAttribute('aria-label') === label)!
const aria = (label: string) => byAria<HTMLInputElement>(label, 'input')
const UPLOAD = '11111111-1111-4111-8111-111111111111'
const C = 'connections/c1'
const PREVIEW: SqlPreviewResponse = {
  gzip: false,
  dialect: 'mysql',
  tables: [
    {
      key: 'users',
      name: 'users',
      columns: [
        { name: 'id', type: 'INT', kind: 'int32' },
        { name: 'email', type: 'VARCHAR(255)', kind: 'string' },
      ],
      columnCount: 2,
      primaryKey: ['id'],
      rows: 1200,
      samples: [{ _id: { $numberInt: '1' }, email: 'ada@example.com' }],
    },
    {
      key: 'orders',
      name: 'orders',
      columns: [{ name: 'total', type: 'DECIMAL(10,2)', kind: 'decimal128' }],
      columnCount: 1,
      primaryKey: [],
      rows: 30,
      samples: [],
    },
  ],
  skipped: { SET: 12, 'DROP TABLE': 3, 'CREATE INDEX': 5 },
  truncated: false,
}
const JOB: JobView = {
  id: 'j1',
  kind: 'data.importSql',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: '*',
  target: 'dump.sql',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
}
const REPORT: SqlImportReport = {
  kind: 'importSql',
  dryRun: true,
  mode: 'upsert',
  tables: [
    {
      table: 'users',
      collection: 'people',
      read: 1200,
      inserted: 0,
      matched: 0,
      modified: 0,
      upserted: 0,
      skipped: 0,
      failed: 2,
      wouldMatch: 40,
    },
    {
      table: 'orders',
      collection: 'orders',
      read: 30,
      inserted: 30,
      matched: 0,
      modified: 0,
      upserted: 0,
      skipped: 0,
      failed: 0,
    },
  ],
  skipped: { SET: 12 },
  errors: [{ table: 'users', record: 7, field: 'email', reason: 'too long' }],
  moreErrors: false,
  rejectedFile: true,
  stoppedAt: { table: 'users', record: 9 },
}

const handlers = (over: Record<string, Parameters<typeof mockApi>[0][string]> = {}) => ({
  [`POST ${C}/transfer/uploads/${UPLOAD}/sql-preview`]: () => [200, PREVIEW] as [number, unknown],
  [`GET ${C}/databases/shop/collections`]: () =>
    [200, [{ name: 'people', type: 'collection', options: {}, readOnly: false }]] as [number, unknown],
  [`DELETE ${C}/transfer/uploads/${UPLOAD}`]: () => [204, undefined] as [number, unknown],
  ...over,
})

async function chooseFile(name = 'dump.sql') {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: [new File(['CREATE TABLE users (id INT);'], name)] })
  input.dispatchEvent(new Event('change'))
  await flushPromises()
}
const labelled = <T extends HTMLElement>(label: string) => byAria<T>(label)
const text = () => document.body.textContent ?? ''
/** User request 2026-10-12: one step at a time; the job on a page of its own. */
const stepButton = (step: string) =>
  document.querySelector<HTMLButtonElement>(`[data-transfer-step="${step}"]`)!
const current = () => document.querySelector('[aria-current="step"]')?.getAttribute('data-transfer-step')
/** The steps one may go to now. */
const reachable = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button[data-transfer-step]')]
    .filter((b) => !b.disabled)
    .map((b) => b.dataset.transferStep)
/** An answer held back until released: what the page shows meanwhile. */
function held(answer: [number, unknown]) {
  let release = () => {}
  const promise = new Promise<[number, unknown]>((resolve) => (release = () => resolve(answer)))
  return { handler: () => promise, release: () => release() }
}
/** A button outside the panel, focused: where the focus is when something else changes the page. */
function focusOutside() {
  const outside = document.createElement('button')
  outside.textContent = 'outside'
  document.body.appendChild(outside)
  outside.focus()
  return outside
}
const nextButton = () => document.querySelector<HTMLButtonElement>('[data-step-next]')!
async function next() {
  expect(nextButton().disabled).toBe(false)
  nextButton().click()
  await flushPromises()
}
async function back() {
  document.querySelector<HTMLButtonElement>('[data-step-back]')!.click()
  await flushPromises()
}

/** User request 2026-10-11: the import is a part of the SQL ↔ MongoDB page; leaving it unmounts it. */
async function openDialog(over: Parameters<typeof handlers>[0] = {}) {
  const sent = fakeXhr(201, { uploadId: UPLOAD, size: 10 })
  const api = mockApi(handlers(over))
  const { wrapper } = mountApp(SqlImportPanel, { props: { connectionId: 'c1', db: 'shop' } })
  await flushPromises()
  await chooseFile()
  let left = false
  const leave = () => {
    if (left) return
    left = true
    wrapper.unmount()
  }
  leaving.push(leave)
  return { ...api, sent, leave }
}

describe('SQL import dialog (SQL transfer spec §3, §5)', () => {
  it('uploads the dump, lists its tables with what was skipped, and starts a dry run as asked', async () => {
    const { sent, calls } = await openDialog({
      [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: JOB }],
    })
    expect(sent[0]!.headers['content-type']).toBe('application/octet-stream')
    expect(sent[0]!.url).toMatch(/\/api\/connections\/c1\/transfer\/uploads\?name=dump\.sql$/)
    expect(calls.some((c) => c.path.endsWith('/sql-preview'))).toBe(true)
    expect(text()).toContain('Skipped, never run: 12 SET, 3 DROP TABLE, 5 CREATE INDEX')
    expect(text()).toContain('1,200 rows')
    expect(text()).toContain('2 columns')
    expect(text()).toContain('id becomes _id')
    expect(text()).toContain('No primary key')
    expect(labelled<HTMLInputElement>('Import users').checked).toBe(true)
    expect(labelled<HTMLInputElement>('Import orders').checked).toBe(true)
    expect(labelled<HTMLInputElement>('Collection for users').value).toBe('users')

    // The details: columns with their SQL type and how they are read, and the first rows.
    const details = labelled<HTMLButtonElement>('Details of users')
    expect(details.getAttribute('aria-expanded')).toBe('false')
    details.click()
    await flushPromises()
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(text()).toContain('VARCHAR(255)')
    expect(text()).toContain('ada@example.com')

    await typeInto(labelled<HTMLInputElement>('Collection for users'), 'people')
    await check(labelled<HTMLInputElement>('Import orders'), false)
    await next()
    const upsert = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (r) => r.textContent?.trim() === 'Upsert',
    )!
    upsert.click()
    const stop = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (r) => r.textContent?.trim() === 'Stop the import',
    )!
    stop.click()
    await flushPromises()
    expect(text()).toContain('matched on _id')
    button('Dry run').click()
    await flushPromises()
    const start = calls.find((c) => c.path.endsWith('/import-sql'))!
    expect(start.path).toBe(`${C}/databases/shop/import-sql`)
    expect(start.body).toEqual({
      uploadId: UPLOAD,
      tables: [{ table: 'users', collection: 'people', include: true }],
      primaryKeyAsId: true,
      mode: 'upsert',
      onError: 'stop',
      dryRun: true,
    })
    expect(useJobsStore().byId.j1).toBeTruthy()
  })

  // Data review 2026-10-13 (M7): in upsert and merge, two tables into one collection would replace
  // each other's rows of the same key; said, and not started.
  it('does not upsert two tables into one collection, saying why', async () => {
    const { calls } = await openDialog({ [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: JOB }] })
    await typeInto(labelled<HTMLInputElement>('Collection for orders'), 'users')
    await next()
    const upsert = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (r) => r.textContent?.trim() === 'Upsert',
    )!
    upsert.click()
    await flushPromises()
    expect(document.querySelector('[data-sql-shared-keyed]')!.textContent).toContain('users')
    expect(button('Dry run').disabled).toBe(true)
    const insert = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (r) => r.textContent?.trim() === 'Insert',
    )!
    insert.click()
    await flushPromises()
    expect(document.querySelector('[data-sql-shared-keyed]')).toBeNull()
    expect(button('Dry run').disabled).toBe(false)
    expect(calls.some((c) => c.path.endsWith('/import-sql'))).toBe(false)
  })

  it('shows the dry run report inline once its job ends, then imports, its progress and report in place', async () => {
    const { calls } = await openDialog({
      [`POST ${C}/databases/shop/import-sql`]: (body) => [
        202,
        { job: { ...JOB, id: (body as { dryRun: boolean }).dryRun ? 'j1' : 'j2' } },
      ],
      'GET transfer/jobs/j1/report': () => [200, REPORT],
      'GET transfer/jobs/j2/report': () => [200, REPORT],
    })
    await next()
    button('Dry run').click()
    await flushPromises()
    // The dry run is followed on a page of its own, the forms out of sight.
    expect(current()).toBe('run')
    expect(document.querySelector('[data-sql-step="options"]')).toBeNull()
    expect(text()).toContain('Dry run in progress')
    useJobsStore().upsert({ ...JOB, state: 'done', finishedAt: 2 })
    await flushPromises()
    expect(document.querySelector('[data-sql-report]')).toBeTruthy()
    expect(text()).toContain('people')

    await back()
    expect(current()).toBe('options')
    await check(byLabel('Primary key as _id'), false)
    button('Import into shop').click()
    await flushPromises()
    const last = calls.filter((c) => c.path.endsWith('/import-sql')).at(-1)!
    expect(last.body).toMatchObject({ primaryKeyAsId: false, dryRun: false, mode: 'insert' })
    // Its progress is in place: no toast besides.
    expect(useToastStore().toasts).toHaveLength(0)
    const job = () => document.querySelector('[data-sql-import-job]')!
    expect(job().textContent).toContain('Importing…')
    expect(document.querySelector('[data-sql-import-actions]')).toBeNull()
    // Handed over: what was chosen cannot change, nor the file — no step to go back to.
    expect(current()).toBe('run')
    expect(document.querySelector('[data-sql-import-form]')).toBeNull()
    expect(reachable()).toEqual([])
    expect(text()).not.toContain('Choose another file')
    useJobsStore().upsert({ ...JOB, id: 'j2', state: 'running', progress: { done: 3, total: 4 } })
    await flushPromises()
    expect(job().querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('75')
    useJobsStore().upsert({ ...JOB, id: 'j2', state: 'done', finishedAt: 3 })
    await flushPromises()
    expect(job().textContent).toContain('Import finished')
    expect(job().querySelector('[data-sql-report]')).toBeTruthy()
    // Handed over to the job: the upload is not discarded, not even on leaving the page.
    button('Import another file').click()
    await flushPromises()
    expect(current()).toBe('file')
    expect(document.querySelector('input[type="file"]')).toBeTruthy()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('stops a running import, and says how it ended: stopped, failed or interrupted, with what it wrote', async () => {
    const { calls } = await openDialog({
      [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: { ...JOB, id: 'j2' } }],
      'POST jobs/j2/cancel': () => [200, { job: { ...JOB, id: 'j2', state: 'cancelled', finishedAt: 2 } }],
      'GET transfer/jobs/j2/report': () => [200, { ...REPORT, dryRun: false }],
    })
    await next()
    button('Import into shop').click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-import-stop]')!.click()
    await flushPromises()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'jobs/j2/cancel')).toBe(true)
    const job = () => document.querySelector('[data-sql-import-job]')!
    expect(job().querySelector('[data-import-ended]')!.textContent).toContain('The import was stopped.')
    // No spinner left on; what it wrote before it stopped is its report.
    expect(job().textContent).not.toContain('Importing…')
    expect(job().querySelector('[data-sql-report]')).toBeTruthy()
    expect(job().textContent).not.toContain('Import finished')
    useJobsStore().upsert({ ...JOB, id: 'j2', state: 'failed', error: 'The server lost the connection' })
    await flushPromises()
    expect(job().querySelector('[data-import-ended]')!.textContent).toContain(
      'The server lost the connection',
    )
    useJobsStore().upsert({ ...JOB, id: 'j2', state: 'interrupted', error: null })
    await flushPromises()
    expect(job().querySelector('[data-import-ended]')!.textContent).toContain(
      'interrupted when the server restarted',
    )
    button('Import another file').click()
    await flushPromises()
    expect(document.querySelector('input[type="file"]')).toBeTruthy()
  })

  it('says it ended even when its report cannot be read', async () => {
    await openDialog({
      [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: { ...JOB, id: 'j2' } }],
      'GET transfer/jobs/j2/report': () => [404, { error: { code: 'NOT_FOUND', message: 'gone' } }],
    })
    await next()
    button('Import into shop').click()
    await flushPromises()
    useJobsStore().upsert({ ...JOB, id: 'j2', state: 'failed', error: 'Out of space' })
    await flushPromises()
    await flushPromises()
    const job = document.querySelector('[data-sql-import-job]')!
    expect(job.textContent).toContain('Out of space')
    expect(job.textContent).not.toContain('Importing…')
    // How it ended is said once: a report it may not have is no second error.
    expect([...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent?.trim())).toEqual([
      'Out of space',
    ])
    expect(button('Import another file')).toBeTruthy()
  })

  it('waits for a database to import into, keeping the file, and says when there is work to lose', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    mockApi(handlers())
    const work = vi.fn()
    const { wrapper } = mountApp(SqlImportPanel, { props: { connectionId: 'c1', db: null, onWork: work } })
    leaving.push(() => wrapper.unmount())
    await flushPromises()
    expect(work).toHaveBeenLastCalledWith(false)
    await chooseFile()
    expect(work).toHaveBeenLastCalledWith(true)
    // The tables need no database; the import does.
    await next()
    const startButton = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-sql-import-actions] button')].at(-1)!
    expect(startButton().textContent?.trim()).toBe('Import')
    expect(startButton().disabled).toBe(true)
    expect(button('Dry run').disabled).toBe(true)
    await wrapper.setProps({ db: 'shop' })
    await flushPromises()
    expect(startButton().textContent?.trim()).toBe('Import into shop')
    expect(startButton().disabled).toBe(false)
  })

  // Review 2026-10-11 (second, I3): an import running is work leaving would lose from sight.
  it('says there is work to lose while its import runs, and none once it ended', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    mockApi(handlers({ [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: { ...JOB, id: 'j2' } }] }))
    const work = vi.fn()
    const { wrapper } = mountApp(SqlImportPanel, { props: { connectionId: 'c1', db: 'shop', onWork: work } })
    leaving.push(() => wrapper.unmount())
    await flushPromises()
    await chooseFile()
    await next()
    button('Import into shop').click()
    await flushPromises()
    expect(work).toHaveBeenLastCalledWith(true)
    useJobsStore().upsert({ ...JOB, id: 'j2', state: 'done', finishedAt: 2 })
    await flushPromises()
    expect(work).toHaveBeenLastCalledWith(false)
  })

  // Review 2026-10-11 (second, minor 7): a dry run tells about its database only.
  it('lets go of a dry run when another database is chosen, stopping one still running', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    const { calls } = mockApi(
      handlers({
        [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: JOB }],
        'GET transfer/jobs/j1/report': () => [200, REPORT],
        'POST jobs/j1/cancel': () => [200, { job: { ...JOB, state: 'cancelled' } }],
        [`GET ${C}/databases/crm/collections`]: () => [200, []],
      }),
    )
    const { wrapper } = mountApp(SqlImportPanel, { props: { connectionId: 'c1', db: 'shop' } })
    leaving.push(() => wrapper.unmount())
    await flushPromises()
    await chooseFile()
    await next()
    button('Dry run').click()
    await flushPromises()
    expect(text()).toContain('Dry run in progress')
    await wrapper.setProps({ db: 'crm' })
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'jobs/j1/cancel')).toBe(true)
    expect(text()).not.toContain('Dry run in progress')
    // Its page goes with it: back to the options, for the database chosen now.
    expect(current()).toBe('options')
    expect(reachable()).not.toContain('run')
    useJobsStore().upsert({ ...JOB, state: 'done', finishedAt: 2 })
    await flushPromises()
    expect(document.querySelector('[data-sql-report]')).toBeNull()
  })

  it('tells tables of one name apart by their schema, validates names, and refuses to start meanwhile', async () => {
    const twice: SqlPreviewResponse = {
      ...PREVIEW,
      tables: [
        { ...PREVIEW.tables[0]!, key: 'public.users', schema: 'public' },
        { ...PREVIEW.tables[0]!, key: 'audit.users', schema: 'audit' },
      ],
      skipped: {},
      truncated: true,
    }
    const { calls } = await openDialog({
      [`POST ${C}/transfer/uploads/${UPLOAD}/sql-preview`]: () => [200, twice],
    })
    // Each table by its key: both may be chosen (the server reads them apart).
    expect(text()).toContain('public.users')
    expect(text()).toContain('audit.users')
    expect(text()).toContain('The dump holds more than could be read for this preview')
    expect(aria('Collection for public.users').value).toBe('public_users')
    expect(aria('Collection for audit.users').value).toBe('audit_users')
    expect(nextButton().disabled).toBe(false)
    // Two tables into one collection on purpose (orders_2024 and orders_2025, say): said, not refused.
    await typeInto(aria('Collection for audit.users'), 'public_users')
    expect(text()).toContain('Several tables go into public_users: their rows are added together.')
    expect(nextButton().disabled).toBe(false)
    await check(aria('Import audit.users'), false)
    expect(text()).not.toContain('Several tables go into')

    const name = aria('Collection for public.users')
    await typeInto(name, 'bad$name')
    expect(text()).toContain('cannot contain $')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    // A name that cannot be used keeps the next steps out of reach.
    expect(nextButton().disabled).toBe(true)
    expect(reachable()).toEqual([])
    await typeInto(name, 'system.users')
    expect(text()).toContain('system.')
    await typeInto(name, '')
    expect(text()).toContain('Enter a collection name')
    await typeInto(name, 'people')
    // The server is told the table by its key, never by a name two schemas share.
    await next()
    button('Dry run').click()
    await flushPromises()
    const sent = calls.find((c) => c.path.endsWith('/import-sql'))!
    expect((sent.body as { tables: unknown }).tables).toEqual([
      { table: 'public.users', collection: 'people', include: true },
    ])
    calls.length = 0

    // Nothing chosen: nothing to import.
    stepButton('tables').click()
    await flushPromises()
    await check(aria('Import public.users'), false)
    expect(text()).toContain('Choose at least one table')
    expect(nextButton().disabled).toBe(true)
    expect(stepButton('options').disabled).toBe(true)
    expect(calls.some((c) => c.path.endsWith('/import-sql'))).toBe(false)
  })

  // User request 2026-10-12: one step at a time, never one long page; the job apart from the forms.
  it('shows one step at a time, the steps passed reachable, the one in sight focused', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    mockApi(handlers({ [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: JOB }] }))
    const { wrapper } = mountApp(SqlImportPanel, { props: { connectionId: 'c1', db: 'shop' } })
    leaving.push(() => wrapper.unmount())
    await flushPromises()
    expect(current()).toBe('file')
    expect(reachable()).toEqual([])
    expect(document.querySelector('[data-sql-import-actions]')).toBeNull()
    await chooseFile()
    // Read: its tables, alone; what is chosen said once, in the bar always in sight.
    expect(current()).toBe('tables')
    expect(text().split('2 of 2 tables chosen').length - 1).toBe(1)
    expect(document.querySelector('[data-sql-import-actions]')!.textContent).toContain('2 of 2 tables chosen')
    expect(document.activeElement?.textContent?.trim()).toBe('Tables')
    expect(document.querySelector('[data-sql-step="options"]')).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(reachable()).toEqual(['options'])
    await next()
    expect(current()).toBe('options')
    expect(document.activeElement?.textContent?.trim()).toBe('Options')
    expect(document.querySelector('[data-sql-step="tables"]')).toBeNull()
    expect(stepButton('file').disabled).toBe(true)
    expect(reachable()).toEqual(['tables'])
    stepButton('tables').click()
    await flushPromises()
    expect(current()).toBe('tables')
    // What was chosen is kept from one step to another.
    await check(aria('Import orders'), false)
    stepButton('options').click()
    await flushPromises()
    stepButton('tables').click()
    await flushPromises()
    expect(aria('Import orders').checked).toBe(false)
    expect(aria('Import users').checked).toBe(true)
    await next()
    button('Dry run').click()
    await flushPromises()
    expect(current()).toBe('run')
    expect(document.activeElement?.textContent?.trim()).toBe('Dry run')
    expect(reachable()).toEqual(['tables', 'options'])
    // From the dry run's page, the import itself.
    expect(button('Import into shop')).toBeTruthy()
    expect(document.querySelector('[data-sql-import-actions]')!.textContent).not.toContain('Dry run')
    await back()
    expect(current()).toBe('options')
    expect(reachable()).toEqual(['tables', 'run'])
  })

  // Review 2026-10-12 (I4): a step changed by the page (another database) never takes the focus.
  it('leaves the focus where it is when another database sends a dry run’s page back', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    mockApi(
      handlers({
        [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: JOB }],
        'POST jobs/j1/cancel': () => [200, { job: { ...JOB, state: 'cancelled' } }],
        [`GET ${C}/databases/crm/collections`]: () => [200, []],
      }),
    )
    const { wrapper } = mountApp(SqlImportPanel, { props: { connectionId: 'c1', db: 'shop' } })
    leaving.push(() => wrapper.unmount())
    await flushPromises()
    await chooseFile()
    await next()
    button('Dry run').click()
    await flushPromises()
    const outside = focusOutside()
    await wrapper.setProps({ db: 'crm' })
    await flushPromises()
    expect(current()).toBe('options')
    expect(document.activeElement).toBe(outside)
  })

  // Review 2026-10-12 (M3): while an import is being started nothing it was given can change.
  it('holds the file and the steps while the import is being started', async () => {
    const start = held([202, { job: { ...JOB, id: 'j2' } }])
    await openDialog({ [`POST ${C}/databases/shop/import-sql`]: start.handler })
    await next()
    button('Import into shop').click()
    await flushPromises()
    expect(button('Choose another file').disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-step-back]')!.disabled).toBe(true)
    expect(reachable()).toEqual([])
    start.release()
    await flushPromises()
    expect(current()).toBe('run')
    expect(document.querySelector('[data-sql-import-job]')!.textContent).toContain('Importing…')
  })

  // Review 2026-10-12 (M4): another file lets a dry run still running go.
  it('stops a running dry run when another file is chosen', async () => {
    const { calls } = await openDialog({
      [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: JOB }],
      'POST jobs/j1/cancel': () => [200, { job: { ...JOB, state: 'cancelled' } }],
    })
    await next()
    button('Dry run').click()
    await flushPromises()
    button('Choose another file').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'jobs/j1/cancel')).toBe(true)
    expect(current()).toBe('file')
  })

  // Review 2026-10-12 (M5): a dry run tells about the choices it ran with; another choice lets it go.
  it('lets a dry run go once what it checked changes, stopping it if it still runs', async () => {
    let runs = 0
    const { calls } = await openDialog({
      [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: { ...JOB, id: `j${++runs}` } }],
      'GET transfer/jobs/j1/report': () => [200, REPORT],
      'POST jobs/j1/cancel': () => [200, { job: { ...JOB, state: 'cancelled' } }],
      'POST jobs/j2/cancel': () => [200, { job: { ...JOB, id: 'j2', state: 'cancelled' } }],
    })
    await next()
    button('Dry run').click()
    await flushPromises()
    useJobsStore().upsert({ ...JOB, state: 'done', finishedAt: 2 })
    await flushPromises()
    expect(document.querySelector('[data-sql-report]')).toBeTruthy()
    // Going back to look changes nothing: its page stays.
    stepButton('tables').click()
    await flushPromises()
    expect(reachable()).toContain('run')
    await typeInto(aria('Collection for users'), 'people')
    expect(reachable()).not.toContain('run')
    await next()
    expect(document.querySelector('[data-sql-report]')).toBeNull()
    // A dry run still running is stopped by an option changed.
    button('Dry run').click()
    await flushPromises()
    await back()
    await check(byLabel('Primary key as _id'), false)
    // The first, ended, is only let go; the second, running, is stopped.
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cancel')).map((c) => c.path)).toEqual(
      ['jobs/j2/cancel'],
    )
    expect(reachable()).not.toContain('run')
  })

  // Review 2026-10-12 (M8): a dump without tables still says so with the focus on it.
  it('puts the focus on the note that the dump has no table', async () => {
    await openDialog({
      [`POST ${C}/transfer/uploads/${UPLOAD}/sql-preview`]: () => [200, { ...PREVIEW, tables: [] }],
    })
    expect(current()).toBe('tables')
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement?.textContent).toContain('No table')
  })

  // Review 2026-10-12 (M7): the step in sight is said as current, never as a button one cannot press;
  // the steps passed are said as done.
  it('says which step is current and which are done', async () => {
    await openDialog()
    await next()
    const now = document.querySelector('[aria-current="step"]')!
    expect(now.tagName).not.toBe('BUTTON')
    expect(now.textContent).toContain('Options')
    expect(stepButton('tables').textContent).toContain('done')
    expect(stepButton('run').textContent).not.toContain('done')
  })

  it('goes back to choosing a file once another file is asked for, the one read let go', async () => {
    const { calls } = await openDialog()
    await next()
    button('Choose another file').click()
    await flushPromises()
    expect(current()).toBe('file')
    expect(reachable()).toEqual([])
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith(UPLOAD))).toBe(true)
  })

  // Review M12: upsert and merge match on _id; a table whose rows have none is named.
  it('names each table whose rows have no _id to match on, in upsert and merge', async () => {
    await openDialog()
    await next()
    const mode = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((r) => r.textContent?.trim() === label)!
        .click()
    expect(text()).not.toContain('no _id to match on')
    mode('Upsert')
    await flushPromises()
    expect(text()).toContain('orders: no single-column primary key, so its rows have no _id to match on')
    expect(text()).not.toContain('users: no single-column primary key')
    await back()
    await check(aria('Import orders'), false)
    await next()
    expect(text()).not.toContain('orders: no single-column primary key')
  })

  // Review M10: why a table, or the dump, cannot be read — before anything is chosen.
  it('says why the dump or a table cannot be read, and leaves such a table out', async () => {
    const broken: SqlPreviewResponse = {
      ...PREVIEW,
      error: 'The dump ends inside a string',
      tables: [{ ...PREVIEW.tables[0]!, error: 'The table has more than 1,000 columns' }, PREVIEW.tables[1]!],
    }
    await openDialog({ [`POST ${C}/transfer/uploads/${UPLOAD}/sql-preview`]: () => [200, broken] })
    expect(text()).toContain('The dump could not be read to its end: The dump ends inside a string')
    expect(text()).toContain('The table has more than 1,000 columns')
    expect(aria('Import users').checked).toBe(false)
    expect(aria('Import orders').checked).toBe(true)
  })

  // Review M17: a table with more columns than listed says how many there are.
  it('counts every column of a table, listing the first ones', async () => {
    const wide: SqlPreviewResponse = {
      ...PREVIEW,
      tables: [{ ...PREVIEW.tables[0]!, columnCount: 450 }],
    }
    await openDialog({ [`POST ${C}/transfer/uploads/${UPLOAD}/sql-preview`]: () => [200, wide] })
    expect(text()).toContain('450 columns')
    labelled<HTMLButtonElement>('Details of users').click()
    await flushPromises()
    expect(text()).toContain('448 more columns are not listed.')
  })

  // Review M18: names and values that could disguise themselves are shown with those characters marked.
  it('marks characters that could disguise a name or a value, and leaves them out of a collection name', async () => {
    const odd: SqlPreviewResponse = {
      ...PREVIEW,
      tables: [
        {
          ...PREVIEW.tables[0]!,
          key: 'users\u202Etxt',
          name: 'users\u202Etxt',
          columns: [{ name: 'e\u2066mail', type: 'TEXT', kind: 'string' }],
          samples: [{ 'e\u2066mail': 'ab\u202Ecd' }],
        },
      ],
    }
    await openDialog({ [`POST ${C}/transfer/uploads/${UPLOAD}/sql-preview`]: () => [200, odd] })
    labelled<HTMLButtonElement>('Details of users\\u202etxt').click()
    await flushPromises()
    expect(text()).not.toContain('\u202E')
    expect(text()).not.toContain('\u2066')
    expect(text()).toContain('users\\u202etxt')
    expect(text()).toContain('e\\u2066mail')
    expect(text()).toContain('ab\\u202ecd')
    expect(aria('Collection for users\\u202etxt').value).toBe('userstxt')
  })

  it('never proposes one collection for two tables, even one named like a schema’s table', async () => {
    const three: SqlPreviewResponse = {
      ...PREVIEW,
      tables: [
        // The table really called "public_users" comes last: it still keeps its name.
        { ...PREVIEW.tables[0]!, key: 'public.users', schema: 'public' },
        { ...PREVIEW.tables[0]!, key: 'audit.users', schema: 'audit' },
        { ...PREVIEW.tables[0]!, key: 'public_users', name: 'public_users' },
      ],
    }
    await openDialog({ [`POST ${C}/transfer/uploads/${UPLOAD}/sql-preview`]: () => [200, three] })
    expect(aria('Collection for public_users').value).toBe('public_users')
    expect(aria('Collection for public.users').value).toBe('public_users_2')
    expect(aria('Collection for audit.users').value).toBe('audit_users')
    expect(text()).not.toContain('Several tables go into')
  })

  // Review M18: leaving while a dry run reads the upload leaves the upload to it.
  it('keeps the upload a running dry run reads when the page is left', async () => {
    const { calls, leave } = await openDialog({
      [`POST ${C}/databases/shop/import-sql`]: () => [202, { job: JOB }],
    })
    await next()
    button('Dry run').click()
    await flushPromises()
    leave()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('chooses every table or none at once, and says which collections exist', async () => {
    await openDialog()
    const all = byLabel('All tables')
    expect(all.checked).toBe(true)
    await check(all, false)
    expect(labelled<HTMLInputElement>('Import users').checked).toBe(false)
    expect(labelled<HTMLInputElement>('Import orders').checked).toBe(false)
    await check(all, true)
    expect(labelled<HTMLInputElement>('Import orders').checked).toBe(true)
    await typeInto(labelled<HTMLInputElement>('Collection for users'), 'people')
    expect(document.querySelector('[data-collection-state="users"]')?.textContent?.trim()).toBe('exists')
    expect(document.querySelector('[data-collection-state="orders"]')?.textContent?.trim()).toBe('new')
  })

  it('discards the upload when the page is left before importing', async () => {
    const { calls, leave } = await openDialog()
    leave()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith(UPLOAD))).toBe(true)
  })

  it('reads naturally in Turkish', async () => {
    i18n.global.locale.value = 'tr'
    await openDialog()
    expect(text()).toContain('Atlandı, hiçbiri çalıştırılmadı: 12 SET, 3 DROP TABLE, 5 CREATE INDEX')
    expect(text()).toContain('1.200 satır')
    expect(labelled<HTMLInputElement>('users tablosunu içe aktar')).toBeTruthy()
    expect(byAria('Adımlar', 'nav')).toBeTruthy()
    expect(stepButton('tables').textContent).toContain('Tablolar')
    expect(stepButton('tables').textContent).toContain('adım 2/4')
    button('İleri').click()
    await flushPromises()
    expect(text()).toContain('shop veritabanına aktar')
    expect(byLabel('Birincil anahtar _id olsun')).toBeTruthy()
    expect(button('Geri')).toBeTruthy()
    expect(stepButton('tables').textContent).toContain('tamamlandı')
  })
})

describe('the SQL import report (SQL transfer spec §3)', () => {
  it('lists every table with its counts, the errors by table and row, the stop and the rejected rows', () => {
    mountApp(ImportReport, { props: { jobId: 'j1', report: REPORT } })
    const rows = [...document.querySelectorAll('[data-sql-report] tbody tr')].map((r) =>
      [...r.querySelectorAll('th,td')].map((c) => c.textContent?.trim()),
    )
    expect(rows[0]).toEqual(['users', 'people', '1,200', '0', '0', '0', '0', '2', '40'])
    expect(rows[1]).toEqual(['orders', 'orders', '30', '30', '0', '0', '0', '0', '—'])
    expect(text()).toContain('Dry run: nothing was written.')
    expect(text()).toContain('Skipped, never run: 12 SET')
    expect(text()).toContain('users, row 7, email: too long')
    expect(text()).toContain('Stopped at row 9 of users.')
    expect(document.querySelector('a[href$="transfer/jobs/j1/rejected"]')).toBeTruthy()
  })

  // Data review 2026-10-13 (low): an unfinished SQL import says what it wrote.
  it('says what an unfinished SQL import wrote', () => {
    const report: SqlImportReport = {
      ...REPORT,
      dryRun: false,
      mode: 'insert',
      unfinished: { written: 30, notWritten: 0 },
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    expect(text()).toContain('The import did not finish: 30 records were written.')
    expect(text()).toContain('Running it again with Insert writes those 30 records a second time')
  })

  it('says when the rejected rows were not kept, and leaves out a column nothing used', () => {
    const report: SqlImportReport = {
      ...REPORT,
      dryRun: false,
      tables: [REPORT.tables[1]!],
      errors: [],
      rejectedFile: false,
      rejectedDropped: true,
      skipped: {},
      stoppedAt: undefined,
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    expect(text()).toContain('The rejected records were not kept')
    expect(document.querySelector('a[href$="transfer/jobs/j1/rejected"]')).toBeNull()
    expect(text()).not.toContain('Would match')
    expect(text()).not.toContain('Skipped, never run')
    expect(text()).not.toContain('Nothing to change')
  })

  it('counts rows a merge had nothing to change in, in a column only when there are any', () => {
    const report: SqlImportReport = {
      ...REPORT,
      dryRun: false,
      mode: 'merge',
      tables: [
        { ...REPORT.tables[1]!, inserted: 0, matched: 28, skipped: 2 },
        { ...REPORT.tables[1]!, table: 'items', collection: 'items', skipped: 1 },
      ],
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    const head = [...document.querySelectorAll('thead th')].map((c) => c.textContent?.trim())
    expect(head).toContain('Nothing to change')
    const foot = [...document.querySelectorAll('tfoot td')].map((c) => c.textContent?.trim())
    expect(foot).toContain('3')
  })

  it('says when the dump itself ended cut short, never a stop “at row 0 of nothing”', () => {
    const report: SqlImportReport = {
      ...REPORT,
      errors: [],
      dumpError: 'The dump ends inside a comment',
      stoppedAt: { table: '', record: 0 },
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    expect(text()).toContain('The dump could not be read to its end: The dump ends inside a comment')
    expect(text()).not.toContain('Stopped at row')
  })

  it('opens from a finished job’s Report action', async () => {
    mockApi({ 'GET transfer/jobs/j1/report': () => [200, REPORT] })
    mountApp(JobActions, { props: { job: { ...JOB, state: 'done', finishedAt: 2 } } })
    await flushPromises()
    button('Report').click()
    await flushPromises()
    expect(document.querySelector('[data-sql-report]')).toBeTruthy()
  })
})

describe('the SQL import job', () => {
  it('has its own name', () => {
    expect(i18n.global.t(kindKey('data.importSql'))).toBe('SQL import')
    i18n.global.locale.value = 'tr'
    expect(i18n.global.t(kindKey('data.importSql'))).toBe('SQL içe aktarma')
  })

  it('refreshes the database it wrote into and says how it went', async () => {
    const Outcomes = defineComponent(() => {
      useJobOutcomes()
      return () => h('div')
    })
    const { queryClient } = mountApp(Outcomes)
    mountApp(ToastHost)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const store = useJobsStore()
    store.upsert(JOB)
    store.upsert({ ...JOB, state: 'done', finishedAt: 2 })
    expect(invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey)).toContainEqual([
      'connections',
      'c1',
      'databases',
      'shop',
    ])
    // A new database it created is listed too (review 2026-10-11, I6): the list is its own query.
    expect(invalidate.mock.calls.map((c) => c[0])).toContainEqual({
      queryKey: ['connections', 'c1', 'databases'],
      exact: true,
    })
    expect(useToastStore().toasts.at(-1)).toMatchObject({
      kind: 'success',
      message: 'SQL import finished: dump.sql',
    })
    store.upsert({ ...JOB, id: 'j2', state: 'running' })
    store.upsert({ ...JOB, id: 'j2', state: 'failed', error: 'boom', finishedAt: 3 })
    expect(useToastStore().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: 'SQL import of dump.sql failed: boom',
    })
  })

  // Review 2026-10-11: the SQL ↔ MongoDB page says how its jobs ended in place; no toast besides.
  // Review 2026-10-11 (second, I2): only a job shown in sight is said there and not toasted; out of
  // sight (its part or tab not shown, its panel gone) it is announced as any other.
  it('adds no toast for a job a page shows in sight, and announces one out of sight', async () => {
    const Outcomes = defineComponent(() => {
      useJobOutcomes()
      return () => h('div')
    })
    mountApp(Outcomes)
    const job = ref<string | null>('j1')
    const inSight = ref(true)
    const { wrapper } = mountApp(
      defineComponent(() => {
        useShownJob(job, inSight)
        return () => h('div')
      }),
    )
    const store = useJobsStore()
    const toasts = useToastStore()
    const finish = async (id: string, state: 'done' | 'failed') => {
      store.upsert({ ...JOB, id })
      store.upsert({ ...JOB, id, state, finishedAt: 2, error: state === 'failed' ? 'boom' : null })
      await flushPromises()
    }
    await finish('j1', 'done')
    expect(toasts.toasts).toHaveLength(0)
    // Out of sight (its part or tab not shown): announced.
    inSight.value = false
    job.value = 'j2'
    await finish('j2', 'failed')
    expect(toasts.toasts).toHaveLength(1)
    expect(toasts.toasts.at(-1)).toMatchObject({ kind: 'error' })
    // Back in sight, another job: said there only.
    inSight.value = true
    job.value = 'j3'
    await finish('j3', 'done')
    expect(toasts.toasts).toHaveLength(1)
    // Its panel gone: announced.
    job.value = 'j4'
    wrapper.unmount()
    await finish('j4', 'done')
    expect(toasts.toasts).toHaveLength(2)
  })
})

describe('export as SQL (SQL transfer spec §4)', () => {
  const exportHandlers = () =>
    mockApi({
      [`POST ${C}/databases/shop/collections/people/export`]: () => [
        202,
        { job: { ...JOB, kind: 'data.export', coll: 'people' } },
      ],
      [`POST ${C}/databases/shop/collections/people/count`]: () => [200, { count: 12, exact: true }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })

  // User request 2026-10-11: SQL is exported on the SQL ↔ MongoDB page only, never from a collection.
  it('offers no SQL in a collection’s Export', async () => {
    exportHandlers()
    mountApp(ExportDataDialog, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    const format = byLabel<HTMLSelectElement>('Format')
    expect(format.value).toBe('csv')
    expect([...format.options].map((o) => o.value)).not.toContain('sql')
    expect(document.querySelector('[data-export-sql]')).toBeNull()
    expect(document.querySelector('[data-export-sql-elsewhere]')).toBeNull()
    expect(text()).not.toMatch(/\bSQL\b/)
  })

  it('keeps an import wizard from taking a preset meant for a SQL export', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    mockApi({
      [`POST ${C}/transfer/uploads/${UPLOAD}/preview`]: () => [
        200,
        {
          format: 'csv',
          gzip: false,
          dialect: { delimiter: ',', header: true, sheet: null, encoding: 'utf8' },
          sheets: [],
          fields: [{ source: 'a', suggestedPath: 'a', suggestedType: 'string', samples: [], unusual: false }],
          records: [],
          warnings: [],
        },
      ],
      'GET transfer/presets': () => [
        200,
        {
          presets: [
            {
              id: 'p1',
              kind: 'import',
              name: 'odd',
              namespace: null,
              body: { format: 'sql', mode: 'merge' },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      ],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile('a.csv')
    button('Next').click()
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Load saved settings'), 'p1')
    await flushPromises()
    button('Next').click()
    await flushPromises()
    expect(document.querySelector<HTMLInputElement>('input[value="insert"]')!.checked).toBe(true)
  })
})

// User requests 2026-10-11, 2026-10-12: chosen collections of one database out as one SQL file,
// on the page.
describe('the SQL page’s export', () => {
  const LIST = [
    { name: 'people', type: 'collection', options: {}, readOnly: false },
    { name: 'orders', type: 'collection', options: {}, readOnly: false },
    { name: 'recent', type: 'view', options: { viewOn: 'orders' }, readOnly: true },
    { name: 'ticks', type: 'timeseries', options: {}, readOnly: false },
    { name: 'system.views', type: 'collection', options: {}, readOnly: false },
  ]
  const EXPORT_JOB = {
    ...JOB,
    id: 'e1',
    kind: 'data.export' as const,
    coll: '*',
    target: 'shop.sql',
  }
  const REPORT_OK = {
    kind: 'export',
    written: 12,
    bytes: 2048,
    omittedFields: [],
    cutCells: 0,
    expiresAt: 9,
    masked: false,
  }
  function panel(opts: { db?: string; preselect?: string } = {}, over: Parameters<typeof mockApi>[0] = {}) {
    const api = mockApi({
      [`GET ${C}/databases/shop/collections`]: () => [200, LIST],
      [`GET ${C}/databases/crm/collections`]: () => [
        200,
        [
          { name: 'leads', type: 'collection', options: {}, readOnly: false },
          { name: 'people', type: 'collection', options: {}, readOnly: false },
        ],
      ],
      [`POST ${C}/databases/shop/export-sql`]: () => [202, { job: EXPORT_JOB }],
      'GET transfer/jobs/e1/report': () => [200, REPORT_OK],
      ...over,
    })
    const { wrapper } = mountApp(SqlExportPanel, {
      props: {
        connectionId: 'c1',
        db: opts.db ?? 'shop',
        ...(opts.preselect ? { preselect: opts.preselect } : {}),
      },
    })
    return { ...api, wrapper }
  }
  const rows = () =>
    [...document.querySelectorAll<HTMLElement>('[data-export-collection]')].map((r) => ({
      name: r.dataset.exportCollection,
      on: r.querySelector<HTMLInputElement>('input')!.checked,
    }))
  const start = () => document.querySelector<HTMLButtonElement>('[data-export-start]')!
  const job = () => document.querySelector('[data-sql-export-job]')!

  it('lists collections, views and time series, never a system one, every one chosen to begin with', async () => {
    panel()
    await flushPromises()
    expect(rows()).toEqual([
      { name: 'orders', on: true },
      { name: 'people', on: true },
      { name: 'recent', on: true },
      { name: 'ticks', on: true },
    ])
    expect(text()).toContain('4 of 4 chosen')
    expect(current()).toBe('collections')
    expect(document.querySelector('[data-export-collection="recent"]')!.textContent).toContain('view')
    expect(document.querySelector('[data-export-collection="ticks"]')!.textContent).toContain('time series')
    await next()
    expect(start().textContent).toContain('Export 4 collections')
    // The step asked for takes the focus: its heading.
    expect(document.activeElement?.textContent?.trim()).toBe('Options')
  })

  it('chooses only the collection it was opened for, and all or none at once', async () => {
    panel({ preselect: 'orders' })
    await flushPromises()
    expect(
      rows()
        .filter((r) => r.on)
        .map((r) => r.name),
    ).toEqual(['orders'])
    await check(document.querySelector<HTMLInputElement>('[data-export-all]')!, false)
    expect(rows().some((r) => r.on)).toBe(false)
    expect(nextButton().disabled).toBe(true)
    expect(reachable()).toEqual([])
    await check(document.querySelector<HTMLInputElement>('[data-export-all]')!, true)
    expect(rows().every((r) => r.on)).toBe(true)
  })

  it('sends what is chosen with its options, then shows its progress and the download', async () => {
    const { calls } = panel()
    await flushPromises()
    await check(document.querySelector<HTMLInputElement>('[data-export-collection="recent"] input')!, false)
    await next()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((b) => b.textContent?.trim() === 'MySQL')!
      .click()
    await flushPromises()
    expect(text()).toContain('START TRANSACTION')
    await typeInto(byLabel('Rows per INSERT'), '500')
    await check(byLabel('One transaction per table'), false)
    await check(byLabel('Compress (.sql.gz)'), true)
    start().click()
    await flushPromises()
    const sent = calls.find((c) => c.path.endsWith('/export-sql'))!
    expect(sent.path).toBe(`${C}/databases/shop/export-sql`)
    expect(sent.body).toEqual({
      collections: ['orders', 'people', 'ticks'],
      sql: { dialect: 'mysql', rowsPerInsert: 500, transaction: false, jsonAsText: false },
      gzip: true,
    })
    // Followed on a page of its own, the forms out of sight and out of reach while it runs.
    expect(current()).toBe('run')
    expect(document.querySelector('[data-sql-step="options"]')).toBeNull()
    expect(reachable()).toEqual([])
    expect(job().textContent).toContain('Exporting…')
    useJobsStore().upsert({ ...EXPORT_JOB, progress: { done: 1, total: 4 } })
    await flushPromises()
    expect(job().querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25')
    useJobsStore().upsert({ ...EXPORT_JOB, state: 'done', finishedAt: 2 })
    await flushPromises()
    expect(job().textContent).toContain('Ready: 12 rows, 2 KB.')
    const link = job().querySelector<HTMLAnchorElement>('[data-export-download]')!
    expect(link.getAttribute('href')).toMatch(/transfer\/files\/e1$/)
    expect(link.getAttribute('download')).toBe('shop.sql')
    expect(job().querySelector('[data-export-notes]')).toBeNull()
    // Ended: the steps before it can be gone back to, its page kept.
    expect(reachable()).toEqual(['collections', 'options'])
  })

  it('says what the export renamed or left out, table by table', async () => {
    panel(
      {},
      {
        'GET transfer/jobs/e1/report': () => [
          200,
          {
            ...REPORT_OK,
            tables: [
              {
                database: 'shop',
                collection: 'people',
                table: 'people',
                written: 3,
                omittedFields: [],
                cutCells: 0,
              },
              {
                database: 'shop',
                collection: 'People',
                table: 'People_2',
                written: 1,
                omittedFields: [],
                cutCells: 0,
              },
              {
                database: 'shop',
                collection: 'leads',
                table: 'leads',
                written: 8,
                omittedFields: ['late'],
                cutCells: 2,
              },
            ],
          },
        ],
      },
    )
    await flushPromises()
    await next()
    start().click()
    await flushPromises()
    useJobsStore().upsert({ ...EXPORT_JOB, state: 'done', finishedAt: 2 })
    await flushPromises()
    const notes = [...document.querySelectorAll('[data-export-notes] li')].map((li) => li.textContent)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toContain('People')
    expect(notes[0]).not.toContain('shop.')
    expect(notes[0]).toContain('Written as table People_2')
    expect(notes[1]).toContain('leads')
    expect(notes[1]).toContain('late')
    expect(notes[1]).toContain('2 values written as NULL')
  })

  it('stops a running export, and says it was stopped or interrupted, never a spinner left on', async () => {
    const { calls } = panel(
      {},
      {
        'POST jobs/e1/cancel': () => [200, { job: { ...EXPORT_JOB, state: 'cancelled', finishedAt: 2 } }],
      },
    )
    await flushPromises()
    await next()
    start().click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-export-stop]')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'jobs/e1/cancel')).toBe(true)
    expect(job().querySelector('[data-export-ended]')!.textContent).toContain('The export was stopped.')
    expect(job().textContent).not.toContain('Exporting…')
    useJobsStore().upsert({ ...EXPORT_JOB, state: 'interrupted' })
    await flushPromises()
    expect(job().querySelector('[data-export-ended]')!.textContent).toContain(
      'interrupted when the server restarted',
    )
    button('Export again').click()
    await flushPromises()
    expect(document.querySelector('[data-sql-export-job]')).toBeNull()
    // Its options again, what was chosen kept.
    expect(current()).toBe('options')
    expect(start().textContent).toContain('Export 4 collections')
  })

  it('refuses more collections than the server takes, before sending', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      name: `c${String(i).padStart(3, '0')}`,
      type: 'collection',
      options: {},
      readOnly: false,
    }))
    panel({}, { [`GET ${C}/databases/shop/collections`]: () => [200, many] })
    await flushPromises()
    expect(document.querySelector('[data-export-too-many]')!.textContent).toContain(
      'At most 500 collections in one export',
    )
    expect(nextButton().disabled).toBe(true)
    expect(stepButton('options').disabled).toBe(true)
    await check(document.querySelector<HTMLInputElement>('[data-export-collection="c000"] input')!, false)
    expect(document.querySelector('[data-export-too-many]')).toBeNull()
    expect(nextButton().disabled).toBe(false)
  })

  // Review 2026-10-11 (second, I2): an export running stays in sight, the page shown again or not.
  it('shows an export of mine still running on this connection when it is built again', async () => {
    useJobsStore().upsert({ ...EXPORT_JOB, progress: { done: 1, total: 2 } })
    useJobsStore().upsert({ ...EXPORT_JOB, id: 'other', connectionId: 'c2', startedAt: 5 })
    // Another database's export, newer: not this panel's (one database at a time).
    useJobsStore().upsert({ ...EXPORT_JOB, id: 'crm-run', db: 'crm', startedAt: 9 })
    panel()
    await flushPromises()
    expect(current()).toBe('run')
    expect(job().textContent).toContain('Exporting…')
    expect(job().querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('50')
    useJobsStore().upsert({ ...EXPORT_JOB, state: 'done', finishedAt: 2 })
    await flushPromises()
    expect(job().textContent).toContain('Ready: 12 rows, 2 KB.')
  })

  it('keeps a running export across another place, and lets a finished one go with its place', async () => {
    const { wrapper: panelWrapper } = panel()
    await flushPromises()
    await next()
    start().click()
    await flushPromises()
    await panelWrapper.setProps({ db: 'crm' })
    await flushPromises()
    expect(current()).toBe('run')
    expect(job().textContent).toContain('Exporting…')
    useJobsStore().upsert({ ...EXPORT_JOB, state: 'done', finishedAt: 2 })
    await flushPromises()
    expect(job().textContent).toContain('Ready:')
    // Ended, the collections of the database chosen meanwhile are a step away.
    stepButton('collections').click()
    await flushPromises()
    expect(rows().map((r) => r.name)).toEqual(['leads', 'people'])
    // Its page is a step away still, until another export starts.
    expect(reachable()).toEqual(['options', 'run'])
    stepButton('run').click()
    await flushPromises()
    expect(current()).toBe('run')
    expect(job().textContent).toContain('Ready:')
    await panelWrapper.setProps({ db: 'shop' })
    await flushPromises()
    expect(document.querySelector('[data-sql-export-job]')).toBeNull()
    expect(current()).toBe('collections')
  })

  // Review 2026-10-12 (I4): another database never moves the focus into the panel.
  it('leaves the focus where it is when another database sends the options back', async () => {
    const { wrapper } = panel()
    await flushPromises()
    await next()
    const outside = focusOutside()
    await wrapper.setProps({ db: 'crm' })
    await flushPromises()
    expect(current()).toBe('collections')
    expect(document.activeElement).toBe(outside)
  })

  // Review 2026-10-12 (M3): while the export is being started, what it was given stays.
  it('holds the steps while the export is being started', async () => {
    const start_ = held([202, { job: EXPORT_JOB }])
    panel({}, { [`POST ${C}/databases/shop/export-sql`]: start_.handler })
    await flushPromises()
    await next()
    start().click()
    await flushPromises()
    expect(document.querySelector<HTMLButtonElement>('[data-step-back]')!.disabled).toBe(true)
    expect(reachable()).toEqual([])
    start_.release()
    await flushPromises()
    expect(current()).toBe('run')
  })

  // Review 2026-10-12 (M6): a running export stays in sight, its Stop at hand, whatever the list.
  it('shows a running export even when the collections cannot be listed', async () => {
    useJobsStore().upsert({ ...EXPORT_JOB, progress: { done: 1, total: 2 } })
    panel(
      {},
      { [`GET ${C}/databases/shop/collections`]: () => [500, { error: { code: 'INTERNAL', message: 'x' } }] },
    )
    await flushPromises()
    expect(current()).toBe('run')
    expect(job().textContent).toContain('Exporting…')
    expect(document.querySelector('[data-export-stop]')).toBeTruthy()
  })

  it('shows a running export while the collections are still being listed', async () => {
    useJobsStore().upsert({ ...EXPORT_JOB, progress: { done: 1, total: 2 } })
    const list = held([200, LIST])
    panel({}, { [`GET ${C}/databases/shop/collections`]: list.handler })
    await flushPromises()
    expect(job().textContent).toContain('Exporting…')
    expect(document.querySelector('[data-export-stop]')).toBeTruthy()
    list.release()
    await flushPromises()
    expect(job().textContent).toContain('Exporting…')
  })

  it('says when the database’s collections cannot be listed', async () => {
    panel(
      {},
      { [`GET ${C}/databases/shop/collections`]: () => [500, { error: { code: 'INTERNAL', message: 'x' } }] },
    )
    await flushPromises()
    expect(document.querySelector('[data-export-failed]')).toBeTruthy()
    expect(document.querySelector('[data-export-start]')).toBeNull()
  })

  // User request 2026-10-12: one database at a time — never a list of several, never grouped.
  it('lists the collections of its one database, never grouped by database', async () => {
    panel({ db: 'crm' })
    await flushPromises()
    expect(rows().map((r) => r.name)).toEqual(['leads', 'people'])
    expect(document.querySelector('[data-export-database]')).toBeNull()
    expect(text()).not.toContain('Each database becomes')
  })

  // User request 2026-10-12: nested values as LONGTEXT for older tools (phpMyAdmin before 4.7).
  it('offers LONGTEXT for nested values with MySQL only, and sends it', async () => {
    const { calls } = panel()
    await flushPromises()
    await next()
    const radio = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (b) => b.textContent?.trim() === name,
      )!
    expect(document.querySelector('[data-export-json-text]')).toBeNull()
    radio('MySQL').click()
    await flushPromises()
    expect(text()).toContain('phpMyAdmin before 4.7')
    await check(byLabel('Nested values as LONGTEXT'), true)
    // Another dialect does not offer it.
    radio('PostgreSQL').click()
    await flushPromises()
    expect(document.querySelector('[data-export-json-text]')).toBeNull()
    radio('MySQL').click()
    await flushPromises()
    start().click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/export-sql'))!.body).toMatchObject({
      sql: { dialect: 'mysql', jsonAsText: true },
    })
  })

  it('never sends LONGTEXT for another dialect, even turned on with MySQL first', async () => {
    const { calls } = panel()
    await flushPromises()
    await next()
    const radio = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (b) => b.textContent?.trim() === name,
      )!
    radio('MySQL').click()
    await flushPromises()
    await check(byLabel('Nested values as LONGTEXT'), true)
    radio('PostgreSQL').click()
    await flushPromises()
    start().click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/export-sql'))!.body).toMatchObject({
      sql: { dialect: 'postgres', jsonAsText: false },
    })
  })

  it('refuses rows per INSERT out of range, and says when the export failed', async () => {
    panel()
    await flushPromises()
    await next()
    await typeInto(byLabel('Rows per INSERT'), '0')
    expect(text()).toContain('A whole number from 1 to 1000.')
    expect(start().disabled).toBe(true)
    await typeInto(byLabel('Rows per INSERT'), '100')
    start().click()
    await flushPromises()
    useJobsStore().upsert({
      ...EXPORT_JOB,
      state: 'failed',
      finishedAt: 2,
      error: 'The export ran longer than allowed',
    })
    await flushPromises()
    expect(job().querySelector('[data-export-ended]')!.textContent).toContain(
      'The export ran longer than allowed',
    )
  })

  it('says when personal fields were written as ***', async () => {
    panel(
      {},
      { 'GET transfer/jobs/e1/report': () => [200, { ...REPORT_OK, written: 1, bytes: 10, masked: true }] },
    )
    await flushPromises()
    await next()
    start().click()
    await flushPromises()
    useJobsStore().upsert({ ...EXPORT_JOB, state: 'done', finishedAt: 2 })
    await flushPromises()
    expect(text()).toContain('Personal fields you may not see are written as ***.')
  })
})

describe('where SQL import is offered', () => {
  const conn = (permissions: readonly string[], exportRight = true) => ({
    id: 'c1',
    name: 'Prod',
    group: null,
    color: null,
    favorite: false,
    readOnly: false,
    settings: {},
    uri: 'mongodb://c1',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    access: 'admin',
    export: exportRight,
    permissions,
  })

  // User request 2026-11-02: the menu's SQL items come with the SQL → MongoDB plugin, running here.
  const SQL_PLUGIN = {
    id: 'sql-to-mongodb',
    version: '1.0.0',
    name: { en: 'SQL to MongoDB' },
    entry: 'index.html',
    permissions: [],
    contributes: { collectionTabs: [], documentActions: [], sidebarPanels: [], cellRenderers: [] },
    settings: {},
  }
  async function tree(permissions: readonly string[], exportRight = true, plugins: unknown[] = [SQL_PLUGIN]) {
    mockApi({
      'GET plugins': () => [200, plugins],
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, [conn(permissions, exportRight)]],
      'GET connections/c1/databases': () => [
        200,
        {
          databases: [
            { name: 'admin', sizeOnDisk: 1, empty: false },
            { name: 'shop', sizeOnDisk: 2, empty: false },
          ],
          totalSize: 3,
        },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    const prod = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (i) => i.getAttribute('aria-label') === 'Prod',
    )!
    prod.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushPromises()
  }
  const openMenu = async (name: string) => {
    document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!.click()
    await flushPromises()
  }
  const menuItems = () =>
    [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())

  it('in a database’s menu, with documents:write and jobs:run, never for a system database', async () => {
    await tree(PERMISSIONS)
    await openMenu('shop')
    expect(menuItems()).toContain('Import SQL dump…')
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Import SQL dump…')!
      .click()
    await flushPromises()
    // User request 2026-10-11: the SQL ↔ MongoDB page, on that database.
    const tabs = useTabsStore()
    expect(tabs.tabs.find((t) => t.id === tabs.activeId)).toMatchObject({
      kind: 'sqlTransfer',
      params: { part: 'import', connectionId: 'c1', db: 'shop' },
    })
    expect(useWorkspaceDialogs().current).toBeNull()
    await openMenu('admin')
    expect(menuItems()).not.toContain('Import SQL dump…')
  })

  it('not while the SQL → MongoDB plugin does not run (user request 2026-11-02)', async () => {
    await tree(PERMISSIONS, true, [])
    await openMenu('shop')
    // The menu is open, its other items there (review of 1.0.1, M3): only the SQL ones are not.
    expect(menuItems()).toContain('Refresh')
    expect(menuItems()).not.toContain('Import SQL dump…')
    expect(menuItems().some((m) => m?.includes('SQL'))).toBe(false)
  })

  it('not without jobs:run', async () => {
    await tree(PERMISSIONS.filter((p) => p !== 'jobs:run'))
    await openMenu('shop')
    expect(menuItems()).not.toContain('Import SQL dump…')
  })

  // User request 2026-10-11 (review minor 17): the page's export, from the database it exports.
  it('exports a database as SQL from its menu, with the export right, never a system one', async () => {
    await tree(PERMISSIONS)
    await openMenu('shop')
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Export as SQL…')!
      .click()
    await flushPromises()
    const tabs = useTabsStore()
    expect(tabs.tabs.find((t) => t.id === tabs.activeId)).toMatchObject({
      kind: 'sqlTransfer',
      params: { part: 'export', connectionId: 'c1', db: 'shop' },
    })
    await openMenu('admin')
    expect(menuItems()).not.toContain('Export as SQL…')
  })

  it('no SQL export without the export right', async () => {
    await tree(PERMISSIONS, false)
    await openMenu('shop')
    expect(menuItems()).not.toContain('Export as SQL…')
    expect(menuItems()).toContain('Import SQL dump…')
  })

  // User request 2026-10-11: nothing about SQL in a collection's own views.
  it('never in the documents toolbar’s menus', async () => {
    mountApp(ResultsToolbar, {
      props: {
        state: { mode: 'table', page: 0 },
        first: 0,
        loadingPage: false,
        count: undefined,
        rowCount: 0,
        hasMore: false,
        fetching: false,
        canWrite: true,
        canImport: true,
        canExport: true,
      },
    })
    document.querySelector<HTMLButtonElement>('button[aria-label="More actions for these results"]')!.click()
    await flushPromises()
    expect(menuItems()).not.toContain('Import SQL dump…')
  })

  it('opens the SQL ↔ MongoDB page from the plugin bridge’s helpers', () => {
    const dialogs = useWorkspaceDialogs()
    const tabs = useTabsStore()
    const active = () => tabs.tabs.find((t) => t.id === tabs.activeId)
    dialogs.openImportSql('c1', 'shop')
    expect(active()).toMatchObject({
      kind: 'sqlTransfer',
      params: { part: 'import', connectionId: 'c1', db: 'shop' },
    })
    dialogs.openExportSql('c1', 'shop', 'people')
    expect(active()).toMatchObject({
      kind: 'sqlTransfer',
      params: { part: 'export', connectionId: 'c1', db: 'shop', coll: 'people' },
    })
    expect(dialogs.current).toBeNull()
  })
})

// User request 2026-10-11 (review minor 17): the page from the palette, and an export of where one is.
describe('SQL ↔ MongoDB in the palette', () => {
  const Host = defineComponent({
    setup() {
      useWorkspaceCommands()
      return () => h('div')
    },
  })
  const command = (id: string) => useCommandsStore().commands.find((c) => c.id === id)!
  const active = () => {
    const tabs = useTabsStore()
    return tabs.tabs.find((t) => t.id === tabs.activeId)
  }
  function host(exportRight = true) {
    mockApi({
      'GET connections': () => [
        200,
        [{ id: 'c1', name: 'Prod', export: exportRight, permissions: [...PERMISSIONS] }],
      ],
    })
    useSessionStore().status = { mode: 'local' } as never
    mountApp(Host)
  }

  // User request 2026-11-02: offered while the SQL → MongoDB plugin runs, and only then.
  it('offers its commands only while the SQL → MongoDB plugin runs', () => {
    host()
    const ids = ['sql.open', 'data.importSql', 'data.exportSql']
    expect(ids.map((id) => command(id).when?.() ?? true)).toEqual([false, false, false])
    usePluginsStore().setRuntime([
      {
        id: 'sql-to-mongodb',
        version: '1.0.0',
        name: { en: 'SQL to MongoDB' },
        entry: 'index.html',
        permissions: [],
        contributes: { collectionTabs: [], documentActions: [], sidebarPanels: [], cellRenderers: [] },
        settings: {},
      } as never,
    ])
    expect(ids.map((id) => command(id).when?.() ?? true)).toEqual([true, true, true])
  })

  it('opens the page from anywhere', async () => {
    host()
    await command('sql.open').run()
    expect(active()).toMatchObject({ kind: 'sqlTransfer', params: {} })
  })

  it('exports the database of the tab, its collection chosen; from a connection, the page picks one', async () => {
    host()
    const tabs = useTabsStore()
    tabs.open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    await command('data.exportSql').run()
    expect(active()).toMatchObject({
      kind: 'sqlTransfer',
      params: { part: 'export', connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    tabs.open({ kind: 'connection', title: '', params: { connectionId: 'c1' } })
    await command('data.exportSql').run()
    // One database at a time (user request 2026-10-12): never "every database".
    expect(active()!.params).toEqual({ part: 'export', connectionId: 'c1' })
    tabs.open({ kind: 'database', title: 'admin', params: { connectionId: 'c1', db: 'admin' } })
    await command('data.exportSql').run()
    expect(active()!.params).toEqual({ part: 'export', connectionId: 'c1' })
  })

  it('exports nothing without the export right', async () => {
    host(false)
    const tabs = useTabsStore()
    const db = tabs.open({ kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } })
    await command('data.exportSql').run()
    expect(tabs.activeId).toBe(db)
    expect(tabs.tabs.some((t) => t.kind === 'sqlTransfer')).toBe(false)
  })
})
