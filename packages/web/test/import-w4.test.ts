// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ImportReport as Report, JobView, TransferPreviewResponse } from '@mongo-manager/shared'
import ImportWizard from '../src/transfer/ImportWizard.vue'
import ImportReport from '../src/transfer/ImportReport.vue'
import { keysCovered } from '../src/transfer/keyIndex'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'

/** W4 item 1 (completion design §2 W4.1): encodings, typed constants, key index, conversions. */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function fakeXhr(status: number, body: unknown) {
  class Fake {
    upload = { onprogress: null as null | ((e: { loaded: number; total: number }) => void) }
    status = status
    responseText = JSON.stringify(body)
    withCredentials = false
    onload: null | (() => void) = null
    onerror: null | (() => void) = null
    onabort: null | (() => void) = null
    open() {}
    setRequestHeader() {}
    send() {
      queueMicrotask(() => this.onload?.())
    }
    abort() {}
  }
  vi.stubGlobal('XMLHttpRequest', Fake)
}

const UPLOAD = '11111111-1111-4111-8111-111111111111'
const PREVIEW: TransferPreviewResponse = {
  format: 'csv',
  gzip: false,
  dialect: { delimiter: ';', header: true, sheet: null, encoding: 'utf8' },
  sheets: [],
  fields: [
    { source: 'id', suggestedPath: 'id', suggestedType: 'int32', samples: ['1', '007'], unusual: false },
    { source: 'name', suggestedPath: 'name', suggestedType: 'string', samples: ['Ali'], unusual: false },
  ],
  records: [{ id: { $numberInt: '1' }, name: 'Ali' }],
  warnings: ['The file is not UTF-8 text; it looks like Windows-1254 (Turkish).'],
  suggestedEncoding: 'windows1254',
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
const NS = `${C}/databases/shop/collections/people`

async function chooseFile() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: [new File(['id;name\n1;Ali\n'], 'f.csv')] })
  input.dispatchEvent(new Event('change'))
  await flushPromises()
}

function api(extra: Record<string, (body: unknown) => [number, unknown]> = {}) {
  return mockApi({
    [`POST ${C}/transfer/uploads/${UPLOAD}/preview`]: (body) => {
      const enc = (body as { dialect?: { encoding?: string } } | undefined)?.dialect?.encoding
      return [
        200,
        enc
          ? {
              ...PREVIEW,
              dialect: { ...PREVIEW.dialect, encoding: enc },
              warnings: [],
              suggestedEncoding: undefined,
            }
          : PREVIEW,
      ]
    },
    [`POST ${C}/transfer/convert-samples`]: (body) => [
      200,
      {
        items: (body as { items: Array<{ type: string; values: string[] }> }).items.map((i) =>
          i.values.map((v) =>
            i.type === 'int32' && v.startsWith('0')
              ? { ok: false, reason: 'looks like a code (a leading + or 0), not a number' }
              : { ok: true, text: v, kind: i.type },
          ),
        ),
      },
    ],
    [`POST ${NS}/import`]: () => [202, { job: JOB }],
    [`GET ${NS}/indexes`]: () => [200, [{ name: '_id_', key: { _id: 1 }, options: {}, usage: null }]],
    'GET transfer/presets': () => [200, { presets: [] }],
    [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [] }],
    ...extra,
  })
}

describe('encoding picker (W4.1)', () => {
  it('suggests the detected encoding and reads the file again in it with one click', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    const { calls } = api()
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    expect(document.body.textContent).toContain('This file looks like Windows-1254 (Turkish) text')
    button('Read as Windows-1254 (Turkish)').click()
    await flushPromises()
    const previews = calls.filter((c) => c.path.endsWith('/preview'))
    expect(previews.at(-1)!.body).toMatchObject({ dialect: { encoding: 'windows1254' } })
    expect(byLabel<HTMLSelectElement>('Encoding').value).toBe('windows1254')
    expect(document.body.textContent).not.toContain('This file looks like')
  })

  it('lists the encodings and reads again when one is chosen', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    const { calls } = api()
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    const select = byLabel<HTMLSelectElement>('Encoding')
    expect([...select.options].map((o) => o.value)).toEqual([
      'utf8',
      'utf16le',
      'utf16be',
      'latin1',
      'windows1252',
      'windows1254',
      'iso88599',
    ])
    await choose(select, 'iso88599')
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/preview')).at(-1)!.body).toMatchObject({
      dialect: { encoding: 'iso88599' },
    })
  })
})

describe('mapping step (W4.1)', () => {
  it('shows each field converted to its type, and why a sample would fail', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    const { calls } = api()
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    button('Next').click()
    await flushPromises()
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith('/convert-samples'))).toBe(true))
    await flushPromises()
    const row = document.querySelector('[data-mapping-row="id"]')!
    expect(row.textContent).toContain('1 → int32')
    expect(row.textContent).toContain('looks like a code')
    const sent = calls.find((c) => c.path.endsWith('/convert-samples'))!.body as {
      items: Array<{ type: string; values: string[] }>
    }
    expect(sent.items).toEqual([
      { type: 'int32', values: ['1', '007'] },
      { type: 'string', values: ['Ali'] },
    ])
  })

  it('adds typed constants and sends them with the import', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    const { calls } = api()
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    button('Next').click()
    await flushPromises()
    button('Add a constant field').click()
    await flushPromises()
    await typeInto(byLabel('Constant field 1'), 'source')
    await choose(byLabel<HTMLSelectElement>('Type of constant 1'), 'string')
    await typeInto(byLabel('Value of constant 1'), 'crm')
    button('Add a constant field').click()
    await flushPromises()
    await typeInto(byLabel('Constant field 2'), 'importedAt')
    await choose(byLabel<HTMLSelectElement>('Type of constant 2'), 'now')
    expect(document.querySelector('[aria-label="Value of constant 2"]')).toBeNull()
    button('Add a constant field').click()
    await flushPromises()
    await typeInto(byLabel('Constant field 3'), 'owner')
    await choose(byLabel<HTMLSelectElement>('Type of constant 3'), 'objectId')
    await typeInto(byLabel('Value of constant 3'), '5f1d7f1c2b3a4c5d6e7f8091')
    button('Add a constant field').click()
    await flushPromises()
    await typeInto(byLabel('Constant field 4'), 'deletedAt')
    await choose(byLabel<HTMLSelectElement>('Type of constant 4'), 'null')
    button('Next').click()
    await flushPromises()
    button('Dry run').click()
    await flushPromises()
    const start = calls.find((c) => c.path.endsWith('/import'))!.body as { constants: unknown[] }
    expect(start.constants).toEqual([
      { path: 'source', type: 'string', value: 'crm' },
      { path: 'importedAt', now: true },
      { path: 'owner', type: 'objectId', value: '5f1d7f1c2b3a4c5d6e7f8091' },
      { path: 'deletedAt', type: 'null', value: '' },
    ])
  })

  it('locks a constant on a personal path for a restricted user', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    api({ [`GET ${C}/personal-fields/applied`]: () => [200, { rules: [], patterns: [['email']] }] })
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    button('Next').click()
    await flushPromises()
    button('Add a constant field').click()
    await flushPromises()
    await typeInto(byLabel('Constant field 1'), 'email')
    await flushPromises()
    expect(document.body.textContent).toContain('Personal field: it cannot be imported here')
    expect(button('Next').disabled).toBe(true)
  })
})

describe('key index warning (W4.1)', () => {
  it('says when no index covers the key fields of an upsert or merge', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    api()
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    const radio = document.querySelector<HTMLInputElement>('input[type="radio"][value="merge"]')!
    radio.checked = true
    radio.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(document.body.textContent).not.toContain('No index covers')
    await typeInto(byLabel('Key fields (comma-separated)'), 'email')
    await flushPromises()
    expect(document.body.textContent).toContain('No index covers the key fields')
  })

  // Eighteenth review of explain masking (M-5): a key the server would refuse is said first.
  it('says a key field the server would refuse, and starts nothing', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    const { calls } = api()
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    const radio = document.querySelector<HTMLInputElement>('input[type="radio"][value="merge"]')!
    radio.checked = true
    radio.dispatchEvent(new Event('change'))
    await flushPromises()
    await typeInto(byLabel('Key fields (comma-separated)'), 'code, $expr')
    await flushPromises()
    expect(document.body.textContent).toContain('The key "$expr" cannot')
    expect(button('Dry run').disabled).toBe(true)
    button('Dry run').click()
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/import'))).toBe(false)
  })

  // Nineteenth review of explain masking (M-2): a preset whose keys were dropped means _id, never a
  // key typed before (it could be part of the dropped compound key).
  it('takes _id for a key mode preset saved without keys', async () => {
    fakeXhr(201, { uploadId: UPLOAD, size: 10 })
    api({
      'GET transfer/presets': () => [
        200,
        {
          presets: [
            {
              id: 'p1',
              kind: 'import',
              name: 'dropped',
              namespace: null,
              body: { mode: 'merge', keys: [] },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      ],
    })
    mountApp(ImportWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'people' } })
    await flushPromises()
    await chooseFile()
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    const radio = document.querySelector<HTMLInputElement>('input[type="radio"][value="upsert"]')!
    radio.checked = true
    radio.dispatchEvent(new Event('change'))
    await flushPromises()
    await typeInto(byLabel('Key fields (comma-separated)'), 'code')
    button('Back').click()
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Load saved settings'), 'p1')
    await flushPromises()
    button('Next').click()
    await flushPromises()
    expect(byLabel<HTMLInputElement>('Key fields (comma-separated)').value).toBe('_id')
  })

  it('decides coverage from the index list', () => {
    const idx = (key: Record<string, unknown>, options: Record<string, unknown> = {}) => ({
      name: Object.keys(key).join('_'),
      key,
      options,
      usage: null,
    })
    expect(keysCovered(['_id'], [])).toBe(true)
    expect(keysCovered(['email'], [idx({ _id: 1 })])).toBe(false)
    expect(keysCovered(['email'], [idx({ email: 1 })])).toBe(true)
    expect(keysCovered(['a', 'b'], [idx({ b: -1, c: 1 })])).toBe(true)
    expect(keysCovered(['a'], [idx({ c: 1, a: 1 })])).toBe(false)
    expect(keysCovered(['email'], [idx({ email: 'hashed' })])).toBe(true)
    expect(keysCovered(['email'], [idx({ email: 'text' })])).toBe(false)
    expect(keysCovered(['email'], [idx({ email: 1 }, { partialFilterExpression: { a: 1 } })])).toBe(false)
    expect(keysCovered(['email'], [idx({ email: 1 }, { hidden: true })])).toBe(false)
  })
})

describe('report card conversions (W4.1)', () => {
  it('lists each mapped field with how many values converted and failed', () => {
    const report: Report = {
      kind: 'import',
      dryRun: true,
      mode: 'insert',
      read: 3,
      inserted: 0,
      matched: 0,
      modified: 0,
      upserted: 0,
      skipped: 0,
      failed: 1,
      fields: [
        { source: 'id', converted: 2, failed: 1 },
        { source: 'name', converted: 3, failed: 0 },
      ],
      errors: [],
      moreErrors: false,
      rejectedFile: false,
    }
    mountApp(ImportReport, { props: { jobId: 'j1', report } })
    const table = document.querySelector('[data-test="field-conversions"]')!
    expect(table).toBeTruthy()
    const rows = [...table.querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td,th')].map((c) => c.textContent?.trim()),
    )
    expect(rows).toEqual([
      ['id', '2', '1'],
      ['name', '3', '0'],
    ])
  })
})
