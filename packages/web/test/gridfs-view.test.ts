// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import type { GridFsFile } from '@mongo-manager/shared'
import GridFsView from '../src/gridfs/GridFsView.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { setCsrfToken } from '../src/api/client'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const conn = (extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: '',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...PERMISSIONS],
  ...extra,
})
const file = (n: number, over: Partial<GridFsFile> = {}): GridFsFile => ({
  id: `id${n}`,
  filename: `report-${n}.pdf`,
  length: 3000 * n,
  chunkSize: 261120,
  uploadDate: new Date(Date.UTC(2026, 9, n)).toISOString(),
  contentType: 'application/pdf',
  metadata: { owner: 'ada' },
  version: `${n}`.repeat(64),
  caution: null,
  masked: [],
  ...over,
})
const BASE = 'connections/c1/databases/shop/gridfs/fs/files'

function api(
  extra: Record<string, Handler> = {},
  connection = conn(),
  locked = (connection as { restricted?: boolean }).restricted === true,
) {
  const asked: URL[] = []
  const r = mockApi({
    'GET connections': () => [200, [connection]],
    [`GET ${BASE}`]: (_b, url) => {
      asked.push(url)
      const skip = Number(url.searchParams.get('skip') ?? 0)
      return [
        200,
        skip ? { files: [file(9)], next: null, locked } : { files: [file(1), file(2)], next: 2, locked },
      ]
    },
    ...extra,
  })
  return { ...r, asked }
}
function show() {
  mountApp(GridFsView, { props: { connectionId: 'c1', db: 'shop', bucket: 'fs' } })
  mountApp(DialogHost)
}
/** A file's row (UI redesign R3 leftovers: a DsDataTable row; its name cell is marked). */
const rowOf = (name: string) =>
  [...document.querySelectorAll('[data-gridfs-file]')]
    .find((r) => r.textContent?.includes(name))!
    .closest('tr')!
const menu = async (name: string, label: string) => {
  ;(rowOf(name).querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement).click()
  await flushPromises()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((m) => m.textContent?.trim() === label)!
    .click()
  await flushPromises()
}

describe('GridFS bucket page (phase 4b §1)', () => {
  it('lists the files with size, type and date; searches, sorts and loads more', async () => {
    const { asked } = api()
    show()
    await flushPromises()
    // The default order is the server's: no sort asked for (a personal date cannot be sorted by).
    expect(asked[0]!.searchParams.has('sort')).toBe(false)
    expect(rowOf('report-1.pdf').textContent).toContain('2.93 KB')
    expect(rowOf('report-1.pdf').textContent).toContain('application/pdf')
    await typeInto(byLabel('Search by name'), 'rep')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    expect(asked.at(-1)!.searchParams.get('q')).toBe('rep')
    await choose(byLabel<HTMLSelectElement>('Sort by'), 'length')
    await flushPromises()
    expect(asked.at(-1)!.searchParams.get('sort')).toBe('length')
    button('Load more').click()
    await flushPromises()
    expect(asked.at(-1)!.searchParams.get('skip')).toBe('2')
    expect(rowOf('report-9.pdf')).toBeDefined()
  })

  it('shows metadata readably: plain numbers and dates, the type left to its own column', async () => {
    api({
      [`GET ${BASE}`]: () => [
        200,
        {
          files: [
            file(1, {
              metadata: {
                contentType: 'application/pdf',
                rows: { $numberInt: '2' },
                at: { $date: { $numberLong: '0' } },
                ref: { $oid: '6ac625df13a09509ca0da14f' },
              },
            }),
          ],
          next: null,
        },
      ],
    })
    show()
    await flushPromises()
    const cell = rowOf('report-1.pdf').querySelector('[data-gridfs-metadata-preview]')!.textContent!
    expect(cell).toContain('"rows":2')
    expect(cell).toContain('1970-01-01T00:00:00.000Z')
    expect(cell).toContain('6ac625df13a09509ca0da14f')
    expect(cell).not.toContain('$numberInt')
    expect(cell).not.toContain('contentType')
  })

  it('downloads through a link the browser saves', async () => {
    api()
    show()
    await flushPromises()
    const link = rowOf('report-1.pdf').querySelector<HTMLAnchorElement>('a[data-gridfs-download]')!
    expect(new URL(link.href).pathname).toMatch(
      /\/api\/connections\/c1\/databases\/shop\/gridfs\/fs\/files\/id1\/download$/,
    )
    expect(link.hasAttribute('download')).toBe(true)
  })

  it('uploads files with progress, with the CSRF token, and lists them after', async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
    class FakeXhr {
      upload: { onprogress: ((e: { loaded: number; total: number }) => void) | null } = { onprogress: null }
      status = 0
      responseText = ''
      withCredentials = false
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      private url = ''
      private headers: Record<string, string> = {}
      open(_m: string, url: string) {
        this.url = url
      }
      setRequestHeader(k: string, v: string) {
        this.headers[k] = v
      }
      send(body: unknown) {
        sent.push({ url: this.url, headers: this.headers, body })
        this.upload.onprogress?.({ loaded: 5, total: 10 })
        this.status = 201
        this.responseText = JSON.stringify(file(5, { filename: 'notes.txt' }))
        queueMicrotask(() => this.onload?.())
      }
      abort() {
        this.onabort?.()
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    setCsrfToken('tok')
    const { asked } = api()
    show()
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('input[type="file"][data-gridfs-upload]')!
    const notes = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { value: [notes] })
    input.dispatchEvent(new Event('change'))
    await flushPromises()
    await flushPromises()
    expect(sent).toHaveLength(1)
    const url = new URL(sent[0]!.url)
    expect(url.pathname).toMatch(/gridfs\/fs\/files$/)
    expect(Object.fromEntries(url.searchParams)).toEqual({ filename: 'notes.txt', contentType: 'text/plain' })
    expect(sent[0]!.headers['x-csrf-token']).toBe('tok')
    expect(sent[0]!.headers['content-type']).toBe('application/octet-stream')
    expect(asked.length).toBeGreaterThan(1)
  })

  it('renames, describes and deletes a file, after asking', async () => {
    const { calls } = api({
      [`PATCH ${BASE}/id1`]: (body) => [200, file(1, body as Partial<GridFsFile>)],
      [`DELETE ${BASE}/id2`]: () => [204],
    })
    show()
    await flushPromises()
    await menu('report-1.pdf', 'Rename')
    await typeInto(
      document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'renamed.pdf',
    )
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ filename: 'renamed.pdf' })
    await menu('report-1.pdf', 'Edit metadata')
    const text = document.querySelector<HTMLTextAreaElement>('[data-gridfs-metadata] textarea')!
    await typeInto(text, '{ not json')
    button('Save').click()
    await flushPromises()
    expect(document.querySelector('[data-gridfs-metadata]')!.textContent).toContain('JSON')
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
    await typeInto(text, '{ "owner": "grace", "tags": ["q1"] }')
    button('Save').click()
    await flushPromises()
    // Data review 2026-10-13 (M3): a change of metadata names the version it was made from.
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({
      metadata: { owner: 'grace', tags: ['q1'] },
      version: '1'.repeat(64),
    })
    await menu('report-2.pdf', 'Delete')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `${BASE}/id2`)).toBe(true)
  })

  it('offers no download or change to a restricted user, saying why', async () => {
    api({}, conn({ restricted: true }))
    show()
    await flushPromises()
    expect(document.querySelector('a[data-gridfs-download]')).toBeNull()
    expect(document.querySelector('input[data-gridfs-upload]')).toBeNull()
    expect(rowOf('report-1.pdf').querySelector('button[aria-haspopup="menu"]')).toBeNull()
    expect(document.querySelector('[data-gridfs-restricted]')!.textContent).toContain('Personal data')
  })

  // Until the server says whether rules reach the bucket, a restricted user is offered no upload.
  it('offers a restricted user nothing to change before the list says the bucket is free', async () => {
    api({ [`GET ${BASE}`]: () => new Promise<never>(() => {}) }, conn({ restricted: true }), false)
    show()
    await flushPromises()
    expect(document.querySelector('input[data-gridfs-upload]')).toBeNull()
  })

  // User report 2026-10-27: personal data rules elsewhere on the connection, none on this bucket.
  it('lets a restricted user download and change the files of a bucket no rule reaches', async () => {
    api({}, conn({ restricted: true }), false)
    show()
    await flushPromises()
    expect(document.querySelector('a[data-gridfs-download]')).not.toBeNull()
    expect(document.querySelector('input[data-gridfs-upload]')).not.toBeNull()
    expect(rowOf('report-1.pdf').querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
    expect(document.querySelector('[data-gridfs-restricted]')).toBeNull()
  })

  it('lets a reader download, never change', async () => {
    api({}, conn({ access: 'viewer', permissions: ['connections:read', 'databases:read', 'documents:read'] }))
    show()
    await flushPromises()
    expect(document.querySelector('a[data-gridfs-download]')).not.toBeNull()
    // Review of the Monitoring redesign (minor): a file's download stays in sight, not on hover only.
    expect(
      document.querySelector('a[data-gridfs-download]')!.closest('td')!.querySelector('div')!.className,
    ).not.toContain('opacity-0')
    expect(document.querySelector('input[data-gridfs-upload]')).toBeNull()
    expect(rowOf('report-1.pdf').querySelector('button[aria-haspopup="menu"]')).toBeNull()
  })
})

/** An upload request the test answers itself. */
class HeldXhr {
  static all: HeldXhr[] = []
  upload: { onprogress: ((e: { loaded: number; total: number }) => void) | null } = { onprogress: null }
  status = 0
  responseText = ''
  withCredentials = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  url = ''
  headers: Record<string, string> = {}
  aborted = false
  constructor() {
    HeldXhr.all.push(this)
  }
  open(_m: string, url: string) {
    this.url = url
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v
  }
  send() {}
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  answer(status: number, body: unknown) {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.onload?.()
  }
}
const pick = async (files: File[]) => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"][data-gridfs-upload]')!
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change'))
  await flushPromises()
  return input
}

describe('GridFS page after the 4b review', () => {
  beforeEach(() => {
    HeldXhr.all = []
  })

  it('shows hidden fields as hidden and offers nothing for a file it cannot name', async () => {
    api(
      {
        [`GET ${BASE}`]: () => [
          200,
          {
            files: [
              file(1, {
                id: null,
                filename: '***',
                length: null,
                uploadDate: null,
                contentType: null,
                metadata: null,
                masked: ['_id', 'filename', 'length', 'uploadDate', 'metadata'],
              }),
              file(2, { metadata: '***' as never, masked: ['metadata'] }),
            ],
            next: null,
          },
        ],
      },
      conn({ restricted: true }),
    )
    show()
    await flushPromises()
    const rows = [...document.querySelectorAll('[data-gridfs-file]')].map((r) => r.closest('tr')!)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Hidden')
    expect(rows[0]!.textContent).not.toContain('0 B')
    expect(rows[1]!.querySelector('[data-gridfs-metadata-preview]')!.textContent).toContain('Hidden')
    expect(document.body.textContent).not.toContain('"0":"*"')
  })

  it('shows a name that fakes its direction with the trick made visible', async () => {
    api({
      [`GET ${BASE}`]: () => [200, { files: [file(1, { filename: 'invoice\u202Efdp.exe' })], next: null }],
    })
    show()
    await flushPromises()
    const row = document.querySelector('[data-gridfs-file]')!
    expect(row.textContent).not.toContain('\u202E')
    expect(row.textContent).toContain('invoice\uFFFDfdp.exe')
  })

  it('keeps the list when a further page fails, saying so', async () => {
    api({
      [`GET ${BASE}`]: (_b, url) =>
        url.searchParams.get('skip') === '2'
          ? [500, { code: 'INTERNAL', message: 'boom' }]
          : [200, { files: [file(1), file(2)], next: 2 }],
    })
    show()
    await flushPromises()
    button('Load more').click()
    await flushPromises()
    expect(rowOf('report-1.pdf')).toBeDefined()
    expect(document.querySelector('[data-gridfs-more-error]')!.getAttribute('role')).toBe('alert')
  })

  it('lists every picked file at once, clears the picker, and stops them all when the page closes', async () => {
    vi.stubGlobal('XMLHttpRequest', HeldXhr)
    setCsrfToken('tok')
    api()
    const { wrapper } = mountApp(GridFsView, { props: { connectionId: 'c1', db: 'shop', bucket: 'fs' } })
    await flushPromises()
    const input = await pick([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')])
    expect(document.querySelectorAll('[aria-label="Uploads"] li')).toHaveLength(2)
    expect(input.value).toBe('')
    expect(HeldXhr.all).toHaveLength(1)
    wrapper.unmount()
    await flushPromises()
    expect(HeldXhr.all[0]!.aborted).toBe(true)
    // The waiting one never starts.
    expect(HeldXhr.all).toHaveLength(1)
  })

  it('takes a rotated CSRF token once and sends the upload again', async () => {
    vi.stubGlobal('XMLHttpRequest', HeldXhr)
    setCsrfToken('old')
    api({ 'GET auth/me': () => [200, { csrfToken: 'new' }] })
    show()
    await flushPromises()
    await pick([new File(['a'], 'a.txt')])
    HeldXhr.all[0]!.answer(403, { code: 'FORBIDDEN', message: 'csrf', details: { reason: 'csrf' } })
    await flushPromises()
    expect(HeldXhr.all).toHaveLength(2)
    expect(HeldXhr.all[1]!.headers['x-csrf-token']).toBe('new')
    HeldXhr.all[1]!.answer(201, file(3))
    await flushPromises()
    expect(document.querySelectorAll('[aria-label="Uploads"] li')).toHaveLength(0)
  })

  // Data review 2026-10-13 (M3): told before saving, not after.
  it('says before a save when the metadata holds a field the app would change', async () => {
    api({
      [`GET ${BASE}`]: () => [
        200,
        { files: [file(1, { caution: { kind: 'ejson_like', field: 'metadata.n' } }), file(2)], next: null },
      ],
    })
    show()
    await flushPromises()
    await menu('report-1.pdf', 'Edit metadata')
    const note = document.querySelector('[data-gridfs-metadata] [data-caution]')!
    expect(note.textContent).toContain('metadata.n')
    expect(note.textContent).toContain('shell')
    button('Cancel').click()
    await flushPromises()
    await menu('report-2.pdf', 'Edit metadata')
    expect(document.querySelector('[data-gridfs-metadata] [data-caution]')).toBeNull()
  })

  it('ties the metadata error to its field', async () => {
    api({})
    show()
    await flushPromises()
    await menu('report-1.pdf', 'Edit metadata')
    const text = document.querySelector<HTMLTextAreaElement>('[data-gridfs-metadata] textarea')!
    await typeInto(text, '[1]')
    button('Save').click()
    await flushPromises()
    const described = text.getAttribute('aria-describedby')!
    expect(document.getElementById(described)!.textContent).toContain('JSON object')
  })
})

describe('GridFS previews (user request 2026-10-10)', () => {
  const bytes = (body: BodyInit, type: string, extra: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': type, ...extra } })
  function previewing(answers: Record<string, () => Response | [number, unknown]>, connection = conn()) {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const handlers: Record<string, Handler> = {}
    for (const [id, answer] of Object.entries(answers)) handlers[`GET ${BASE}/${id}/preview`] = () => answer()
    return api(handlers, connection)
  }
  const open = async (name: string) => {
    rowOf(name).querySelector<HTMLButtonElement>('button[data-gridfs-preview]')!.click()
    await new Promise((r) => setTimeout(r, 200))
    await loaded()
  }
  const panel = () => document.querySelector<HTMLElement>('[data-gridfs-preview-panel]')!
  // The read ends when the panel says so, not after a count of turns: reading a response's body takes
  // more of them on some Node versions (CI, Node 26, 2026-11-03).
  const loaded = () =>
    vi.waitFor(
      () => {
        expect(panel()).not.toBeNull()
        expect(panel().querySelector('[aria-busy="true"]')).toBeNull()
      },
      { timeout: 5000, interval: 10 },
    )
  const labelled = (name: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!

  it('shows an image from the bytes the server sent, with the file’s details and a download', async () => {
    previewing({
      id1: () => bytes(new Uint8Array([137, 80, 78, 71]), 'image/png', { 'x-preview-kind': 'image' }),
    })
    show()
    await flushPromises()
    await open('report-1.pdf')
    const img = panel().querySelector('img')!
    expect(img.getAttribute('src')).toBe('blob:preview')
    expect(img.getAttribute('alt')).toBe('report-1.pdf')
    expect(panel().textContent).toContain('2.93 KB')
    expect(panel().querySelector<HTMLAnchorElement>('a[download]')!.href).toMatch(/\/files\/id1\/download$/)
  })

  it('shows text as text, never as markup, saying when only its start is shown', async () => {
    previewing({
      id1: () =>
        bytes('<b>bold?</b>', 'text/plain; charset=utf-8', {
          'x-preview-kind': 'text',
          'x-preview-truncated': '1',
        }),
    })
    show()
    await flushPromises()
    await open('report-1.pdf')
    const pre = panel().querySelector('pre')!
    expect(pre.textContent).toBe('<b>bold?</b>')
    expect(pre.querySelector('b')).toBeNull()
    expect(panel().textContent).toContain('Only the first 256 KB')
  })

  it('says why there is no preview, offering the download', async () => {
    previewing({
      id1: () => [415, { code: 'BAD_FILE', message: 'x', details: { reason: 'no_preview' } }],
      id2: () => [413, { code: 'PAYLOAD_TOO_LARGE', message: 'x', details: { reason: 'too_large' } }],
    })
    show()
    await flushPromises()
    await open('report-1.pdf')
    expect(panel().textContent).toContain('No preview for this kind of file')
    expect(panel().querySelector('a[download]')).not.toBeNull()
    // The next file, from the panel.
    labelled('Next file').click()
    await new Promise((r) => setTimeout(r, 200))
    await loaded()
    expect(panel().textContent).toContain('Too large to preview')
    expect(panel().textContent).toContain('report-2.pdf')
    // More files on the server: Next stays offered (it fetches their page).
    expect(labelled('Next file').disabled).toBe(false)
    labelled('Previous file').click()
    await new Promise((r) => setTimeout(r, 200))
    await loaded()
    expect(panel().textContent).toContain('report-1.pdf')
  })

  const textOf = (body: string) => () =>
    bytes(body, 'text/plain; charset=utf-8', { 'x-preview-kind': 'text' })
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 220))
    await loaded()
  }

  it('changes file with the arrow keys on the panel only, never while resizing it or seeking', async () => {
    previewing({ id1: textOf('one'), id2: textOf('two') })
    show()
    await flushPromises()
    await open('report-1.pdf')
    await settle()
    const separator = document.querySelector<HTMLElement>('[role="separator"]')!
    separator.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    )
    await settle()
    expect(panel().textContent).toContain('report-1.pdf')
    // Reading a text: the arrows scroll it, they do not change the file.
    panel()
      .querySelector('pre')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await settle()
    expect(panel().textContent).toContain('report-1.pdf')
    panel().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    )
    await settle()
    expect(panel().textContent).toContain('report-2.pdf')
    expect(
      document.querySelector('button[data-gridfs-preview][aria-expanded="true"]')!.textContent,
    ).toContain('report-2.pdf')
  })

  it('asks only for the file it stops on, and never shows an earlier one’s text', async () => {
    const asked: string[] = []
    previewing({
      id1: () => (asked.push('id1'), bytes('first', 'text/plain', { 'x-preview-kind': 'text' })),
      id2: () => (asked.push('id2'), bytes('second', 'text/plain', { 'x-preview-kind': 'text' })),
    })
    show()
    await flushPromises()
    // Chosen, then the next one at once: only the one it stops on is read.
    rowOf('report-1.pdf').querySelector<HTMLButtonElement>('button[data-gridfs-preview]')!.click()
    await flushPromises()
    labelled('Next file').click()
    await settle()
    expect(asked).toEqual(['id2'])
    expect(panel().querySelector('pre')!.textContent).toBe('second')
  })

  it('says there is no preview when the browser cannot show what the server recognised', async () => {
    previewing({ id1: () => bytes(new Uint8Array([1]), 'image/png', { 'x-preview-kind': 'image' }) })
    show()
    await flushPromises()
    await open('report-1.pdf')
    await settle()
    panel().querySelector('img')!.dispatchEvent(new Event('error'))
    await flushPromises()
    expect(panel().textContent).toContain('No preview for this kind of file')
  })

  it('spells out characters that hide or reverse text, saying so', async () => {
    previewing({ id1: textOf('pay to \u202Eevil') })
    show()
    await flushPromises()
    await open('report-1.pdf')
    await settle()
    const pre = panel().querySelector('pre')!
    expect(pre.textContent).toBe('pay to [U+202E]evil')
    expect(panel().textContent).toContain('hide or reverse')
  })

  it('goes on to the next page of files from the last one shown', async () => {
    previewing({ id2: textOf('two'), id9: textOf('nine') })
    show()
    await flushPromises()
    await open('report-2.pdf')
    await settle()
    expect(labelled('Next file').disabled).toBe(false)
    labelled('Next file').click()
    await settle()
    expect(panel().textContent).toContain('report-9.pdf')
  })

  it('keeps the preview open when the order changes', async () => {
    previewing({ id1: textOf('one') })
    show()
    await flushPromises()
    await open('report-1.pdf')
    await settle()
    await choose(byLabel<HTMLSelectElement>('Sort by'), 'length')
    await settle()
    expect(document.querySelector('[data-gridfs-preview-panel]')).not.toBeNull()
  })

  it('offers no preview to a restricted user', async () => {
    previewing({}, conn({ restricted: true }))
    show()
    await flushPromises()
    expect(document.querySelector('button[data-gridfs-preview]')).toBeNull()
  })
})

describe('GridFS in the tree (phase 4b §1)', () => {
  it('opens the tree to the bucket of the open tab', async () => {
    mockApi({
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
      'GET connections': () => [200, [conn()]],
      'GET connections/c1/databases': () => [
        200,
        { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
      ],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        ['fs.files', 'fs.chunks'].map((name) => ({ name, type: 'collection', options: {}, readOnly: false })),
      ],
      [`GET ${BASE}`]: () => [200, { files: [], next: null }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/c/c1/db/shop/gridfs/fs')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    await flushPromises()
    const labels = [...document.querySelectorAll('[role="treeitem"]')].map((i) =>
      i.getAttribute('aria-label'),
    )
    expect(labels).toContain('fs')
  })

  it('shows a bucket as one files node, not its two collections, and opens it', async () => {
    mockApi({
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
      'GET connections': () => [200, [conn()]],
      'GET connections/c1/databases': () => [
        200,
        { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
      ],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        ['fs.files', 'fs.chunks', 'orders', 'odd.files'].map((name) => ({
          name,
          type: 'collection',
          options: {},
          readOnly: false,
        })),
      ],
      [`GET ${BASE}`]: () => [200, { files: [], next: null }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    const item = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
        (i) => i.getAttribute('aria-label') === label,
      )
    const expand = async (label: string) => {
      item(label)!.focus()
      item(label)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await flushPromises()
    }
    await expand('Prod')
    await expand('shop')
    const labels = [...document.querySelectorAll('[role="treeitem"]')].map((i) =>
      i.getAttribute('aria-label'),
    )
    expect(labels).toContain('fs')
    expect(labels).toContain('orders')
    // A ".files" without its ".chunks" is no bucket: a collection as any other.
    expect(labels).toContain('odd.files')
    expect(labels).not.toContain('fs.files')
    expect(labels).not.toContain('fs.chunks')
    item('fs')!.querySelector<HTMLElement>(':scope > div')!.click()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({
      kind: 'gridfs',
      params: { connectionId: 'c1', db: 'shop', bucket: 'fs' },
    })
  })
})
