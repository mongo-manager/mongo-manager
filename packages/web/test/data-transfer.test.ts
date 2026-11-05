// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ImportReport as Report, JobView, TransferPreviewResponse } from '@mongo-manager/shared'
import ImportWizard from '../src/transfer/ImportWizard.vue'
import ExportDataDialog from '../src/transfer/ExportDataDialog.vue'
import ImportReport from '../src/transfer/ImportReport.vue'
import { useJobsStore } from '../src/jobs/store'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, choose } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
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

const UPLOAD = '11111111-1111-4111-8111-111111111111'
const PREVIEW: TransferPreviewResponse = {
  format: 'csv',
  gzip: false,
  dialect: { delimiter: ';', header: true, sheet: null, encoding: 'utf8' },
  sheets: [],
  fields: [
    { source: 'id', suggestedPath: 'id', suggestedType: 'int32', samples: ['1'], unusual: false },
    { source: 'email', suggestedPath: 'email', suggestedType: 'string', samples: ['a@x'], unusual: false },
    { source: '$weird', suggestedPath: '$weird', suggestedType: 'string', samples: ['1'], unusual: true },
  ],
  records: [{ id: { $numberInt: '1' }, email: 'a@x' }],
  warnings: ['The file is not UTF-8 text.'],
}
const JOB: JobView = {
  id: 'j1',
  kind: 'data.import',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: 'people',
  target: 'f.csv',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
}
const C = 'connections/c1'
const control = <T extends HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`)!

async function chooseFile(name = 'f.csv') {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: [new File(['id;email\n1;a@x\n'], name)] })
  input.dispatchEvent(new Event('change'))
  await flushPromises()
}

describe('import wizard (spec §9)', () => {
  it('uploads as raw bytes, previews, maps with unusual fields off, and starts a dry run', async () => {
    const sent = fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    const { calls } = mockApi({
      [`POST ${C}/transfer/uploads/${UPLOAD}/preview`]: () => [200, PREVIEW],
      [`POST ${C}/databases/shop/collections/people/import`]: () => [202, { job: JOB }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    expect(sent[0]!.headers['content-type']).toBe('application/octet-stream')
    expect(sent[0]!.url).toMatch(/\/api\/connections\/c1\/transfer\/uploads\?name=f\.csv$/)
    expect(document.body.textContent).toContain('not UTF-8')
    button('Next').click()
    await flushPromises()
    expect(control<HTMLInputElement>('Include $weird').checked).toBe(false)
    expect(control<HTMLInputElement>('Include id').checked).toBe(true)
    button('Next').click()
    await flushPromises()
    button('Dry run').click()
    await flushPromises()
    const start = calls.find((c) => c.path.endsWith('/import'))!
    expect(start.body).toMatchObject({
      uploadId: UPLOAD,
      format: 'csv',
      dryRun: true,
      mode: 'insert',
      dialect: { delimiter: ';', header: true },
    })
    expect(
      (start.body as { mapping: Array<{ source: string; include: boolean }> }).mapping.map((m) => [
        m.source,
        m.include,
      ]),
    ).toEqual([
      ['id', true],
      ['email', true],
      ['$weird', false],
    ])
    expect(useJobsStore().byId.j1).toBeTruthy()
  })

  // Data review 2026-10-13 (low): "Update only" now holds for Upsert too, so it is shown there — a
  // box ticked under Merge and hidden by choosing Upsert would have skipped records unseen.
  it('offers "Update only" for Upsert as for Merge', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    mockApi({
      [`POST ${C}/transfer/uploads/${UPLOAD}/preview`]: () => [200, PREVIEW],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    const updateOnly = () =>
      [...document.querySelectorAll('label')].some((l) => l.textContent?.includes('Update only'))
    expect(updateOnly()).toBe(false)
    for (const mode of ['upsert', 'merge']) {
      const radio = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!
      radio.checked = true
      radio.dispatchEvent(new Event('change'))
      await flushPromises()
      expect(updateOnly(), mode).toBe(true)
    }
  })

  it('locks personal paths and disables upsert for a restricted user', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    mockApi({
      [`POST ${C}/transfer/uploads/${UPLOAD}/preview`]: () => [200, PREVIEW],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [['email']] }],
    })
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    button('Next').click()
    await flushPromises()
    expect(control<HTMLInputElement>('Include email').disabled).toBe(true)
    expect(control<HTMLInputElement>('Include email').checked).toBe(false)
    button('Next').click()
    await flushPromises()
    expect(document.querySelector<HTMLInputElement>('input[value="upsert"]')!.disabled).toBe(true)
  })

  it('reads one preview at a time, and the latest settings win (phase 3d-1 final review C3)', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    let running = 0
    let most = 0
    const held: Array<() => void> = []
    const bodies: unknown[] = []
    mockApi({
      [`POST ${C}/transfer/uploads/${UPLOAD}/preview`]: async (body) => {
        bodies.push(body)
        most = Math.max(most, ++running)
        // The first preview (after the upload) answers at once; the others wait to be let go.
        if (bodies.length > 1) await new Promise<void>((r) => held.push(r))
        running--
        const header = (body as { dialect?: { header?: boolean } }).dialect?.header ?? true
        return [200, { ...PREVIEW, dialect: { ...PREVIEW.dialect, header } }]
      },
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    const delimiter = document.querySelectorAll('select')[1]!
    delimiter.value = ','
    delimiter.dispatchEvent(new Event('change'))
    await flushPromises()
    const header = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    header.click()
    await flushPromises()
    // The second preview runs; the third waits for it instead of being refused as busy.
    expect(bodies).toHaveLength(2)
    held.shift()!()
    await flushPromises()
    expect(bodies).toHaveLength(3)
    held.shift()!()
    await flushPromises()
    expect(most).toBe(1)
    expect(bodies[2]).toMatchObject({ dialect: { delimiter: ',', header: false } })
    expect(header.checked).toBe(false)
  })

  // R4: the first sheet is read when none was chosen; the list named none and showed blank.
  it('shows the first sheet as chosen until another is picked, and sends none meanwhile', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    const XLSX: TransferPreviewResponse = {
      ...PREVIEW,
      format: 'xlsx',
      dialect: { delimiter: ',', header: true, sheet: null, encoding: 'utf8' },
      sheets: ['People', 'Orders'],
    }
    const bodies: unknown[] = []
    mockApi({
      [`POST ${C}/transfer/uploads/${UPLOAD}/preview`]: (body) => {
        bodies.push(body)
        return [200, XLSX]
      },
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile('f.xlsx')
    expect(byLabel<HTMLSelectElement>('Sheet').value).toBe('People')
    // Nothing was picked: the preview is not read again and no sheet is named.
    expect(bodies).toHaveLength(1)
    await choose(byLabel<HTMLSelectElement>('Sheet'), 'Orders')
    await flushPromises()
    expect(bodies[1]).toMatchObject({ dialect: { sheet: 'Orders' } })
  })

  it('discards the upload when closed before importing', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    const { calls } = mockApi({
      [`POST ${C}/transfer/uploads/${UPLOAD}/preview`]: () => [200, PREVIEW],
      [`DELETE ${C}/transfer/uploads/${UPLOAD}`]: () => [204, undefined],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    const closed = vi.fn()
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people', onClose: closed } })
    await flushPromises()
    await chooseFile()
    document.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith(UPLOAD))).toBe(true)
    expect(closed).toHaveBeenCalled()
  })
})

describe('export dialog (spec §9)', () => {
  it('starts an export of the current query with the chosen format and columns', async () => {
    const { calls } = mockApi({
      [`POST ${C}/databases/shop/collections/people/export`]: () => [
        202,
        { job: { ...JOB, kind: 'data.export' } },
      ],
      [`POST ${C}/databases/shop/collections/people/count`]: () => [200, { count: 12, exact: true }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [['email']] }],
    })
    mountApp(ExportDataDialog, {
      props: {
        connectionId: 'c1',
        db: 'shop',
        coll: 'people',
        query: { filter: { age: { $numberInt: '3' } } },
        fields: ['name', 'email', 'age'],
      },
    })
    await flushPromises()
    expect(document.body.textContent).toContain('***')
    expect(document.body.textContent).toContain('About 12 documents')
    await choose(byLabel<HTMLSelectElement>('Format'), 'xlsx')
    control<HTMLButtonElement>('Move age up').click()
    control<HTMLInputElement>('Include email').click()
    await flushPromises()
    button('Export').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/export'))!.body).toMatchObject({
      source: { kind: 'query', filter: { age: { $numberInt: '3' } } },
      format: 'xlsx',
      fields: ['name', 'age'],
    })
    expect(useJobsStore().byId.j1?.kind).toBe('data.export')
  })

  // Data review 2026-10-13 (M8): the formula guard is on unless the file is for another program.
  it('sends CSV text unguarded when the formula guard is turned off', async () => {
    const { calls } = mockApi({
      [`POST ${C}/databases/shop/collections/people/export`]: () => [
        202,
        { job: { ...JOB, kind: 'data.export' } },
      ],
      [`POST ${C}/databases/shop/collections/people/count`]: () => [200, { count: 1, exact: true }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ExportDataDialog, {
      props: { connectionId: 'c1', db: 'shop', coll: 'people', query: { filter: {} }, fields: ['name'] },
    })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Format'), 'csv')
    const guard = document.querySelector<HTMLInputElement>('[data-formula-guard] input')!
    expect(guard.checked).toBe(true)
    guard.click()
    await flushPromises()
    button('Export').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/export'))!.body).toMatchObject({
      format: 'csv',
      csv: { formulaGuard: false },
    })
  })
})

// User request 2026-10-13: a file asked for in the chat opens its export ready: the query or the
// pipeline, in the format asked for.
describe('an export handed over', () => {
  it('starts on the pipeline and the format it was given', async () => {
    const { calls } = mockApi({
      [`POST ${C}/databases/shop/collections/people/export`]: () => [
        202,
        { job: { ...JOB, kind: 'data.export' } },
      ],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    mountApp(ExportDataDialog, {
      props: { connectionId: 'c1', db: 'shop', coll: 'people', stages: [{ $match: {} }], format: 'xlsx' },
    })
    await flushPromises()
    expect(byLabel<HTMLSelectElement>('Format').value).toBe('xlsx')
    button('Export').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/export'))!.body).toMatchObject({
      source: { kind: 'pipeline', stages: [{ $match: {} }] },
      format: 'xlsx',
    })
  })

  it('is opened by the workspace with the query and the format handed over', async () => {
    const { calls } = mockApi({
      [`POST ${C}/databases/shop/collections/people/export`]: () => [
        202,
        { job: { ...JOB, kind: 'data.export' } },
      ],
      [`POST ${C}/databases/shop/collections/people/count`]: () => [200, { count: 2, exact: true }],
      'GET transfer/presets': () => [200, { presets: [] }],
      [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    })
    const { useWorkspaceDialogs } = await import('../src/stores/workspaceDialogs')
    const WorkspaceDialogs = (await import('../src/workspace/WorkspaceDialogs.vue')).default
    useWorkspaceDialogs().open({
      kind: 'exportData',
      connectionId: 'c1',
      db: 'shop',
      coll: 'people',
      query: { filter: { name: 'x' } },
      format: 'json',
    })
    mountApp(WorkspaceDialogs)
    await vi.waitFor(() => expect(byLabel<HTMLSelectElement>('Format').value).toBe('json'))
    button('Export').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/export'))!.body).toMatchObject({
      source: { kind: 'query', filter: { name: 'x' } },
      format: 'json',
    })
  })
})

describe('jobs store', () => {
  it('never sets a finished job back to running when the start reply arrives after the end', () => {
    const jobs = useJobsStore()
    const finished = vi.fn()
    jobs.onFinished(finished)
    jobs.upsert({ ...JOB, state: 'done', finishedAt: 5 })
    jobs.upsert({ ...JOB, state: 'running' })
    expect(jobs.byId.j1?.state).toBe('done')
    expect(finished).toHaveBeenCalledTimes(1)
  })
})

describe('report card', () => {
  it('shows counts, the first errors and the rejected-records link', () => {
    const report: Report = {
      kind: 'import',
      dryRun: false,
      mode: 'insert',
      read: 3,
      inserted: 2,
      matched: 0,
      modified: 0,
      upserted: 0,
      skipped: 0,
      failed: 1,
      fields: [],
      errors: [{ record: 2, field: 'age', reason: '"x" cannot be read as int32' }],
      moreErrors: false,
      rejectedFile: true,
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    expect(document.body.textContent).toContain('2 inserted')
    expect(document.body.textContent).toContain('Record 2, age')
    expect(document.querySelector('a[href$="transfer/jobs/j1/rejected"]')).toBeTruthy()
  })

  it('says when the rejected-records file passed the quota and was not kept (final review I6)', () => {
    const report: Report = {
      kind: 'import',
      dryRun: false,
      mode: 'insert',
      read: 3,
      inserted: 0,
      matched: 0,
      modified: 0,
      upserted: 0,
      skipped: 0,
      failed: 3,
      fields: [],
      errors: [],
      moreErrors: false,
      rejectedFile: false,
      rejectedDropped: true,
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    expect(document.body.textContent).toContain('The rejected records were not kept')
    expect(document.querySelector('a[href$="transfer/jobs/j1/rejected"]')).toBeNull()
  })

  // Data review 2026-10-13 (low): a run that did not finish says what it wrote, so it is not run
  // again with Insert blind.
  it('says what an unfinished import wrote, and what running it again would do', () => {
    const report: Report = {
      kind: 'import',
      dryRun: false,
      mode: 'insert',
      read: 5,
      inserted: 3,
      matched: 0,
      modified: 0,
      upserted: 0,
      skipped: 0,
      failed: 1,
      fields: [],
      errors: [],
      moreErrors: false,
      rejectedFile: false,
      unfinished: { written: 3, notWritten: 1 },
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    const text = document.body.textContent!
    expect(text).toContain('The import did not finish: 3 records were written and 1 read record was not.')
    expect(text).toContain('Running it again with Insert writes those 3 records a second time')
  })

  // Review of the data fixes (I4): records of a batch the server failed as a whole are uncertain.
  it('says when whether some records were written is not known', () => {
    const report: Report = {
      kind: 'import',
      dryRun: false,
      mode: 'insert',
      read: 1000,
      inserted: 700,
      matched: 0,
      modified: 0,
      upserted: 0,
      skipped: 0,
      failed: 0,
      fields: [],
      errors: [],
      moreErrors: false,
      rejectedFile: false,
      unfinished: { written: 700, notWritten: 0, uncertain: 300 },
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    expect(document.body.textContent).toContain(
      'The import did not finish: 700 records were written. Whether 300 more were written is not known.',
    )
  })
})
