// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const PREFIX = 'connections/c1/databases/shop/collections/orders'
const DOC = { _id: { $numberInt: '1' }, price: { $numberDouble: '5.0' } }

async function view(handlers: Record<string, Handler>) {
  const api = mockApi({
    [`POST ${PREFIX}/find`]: () => [
      200,
      { documents: [{ document: DOC, hash: 'a'.repeat(64) }], hasMore: false },
    ],
    [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    ...handlers,
  })
  useCollectionViewsStore().stateFor('t')
  mountApp(DocumentsView, {
    props: {
      target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      tabId: 't',
      canWrite: true,
      isView: false,
    },
  })
  mountApp(DialogHost)
  await flushPromises()
  return api
}

async function rowAction(label: string) {
  ;(document.querySelector('button[aria-label="Actions for document 1"]') as HTMLButtonElement).click()
  await flushPromises()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((m) => m.textContent?.trim() === label)!
    .click()
  await vi.waitFor(() => expect(document.querySelector('[data-document-page]')).not.toBeNull())
  await flushPromises()
}

const editorText = () => byLabel<HTMLTextAreaElement>('Document')

describe('the diff before saving (phase 1g-1, Review Focus 1)', () => {
  const ok = () => [200, { modified: 1 }] as ReturnType<Handler>

  it('sends a removed field as unset and a new one as set', async () => {
    const { calls } = await view({ [`POST ${PREFIX}/documents/update`]: ok })
    await rowAction('Edit')
    await typeInto(editorText(), "{ _id: 1, note: 'hi' }")
    button('Review and save').click()
    await flushPromises()
    button('Save changes').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/update'))!.body).toMatchObject({
      set: { note: 'hi' },
      unset: ['price'],
    })
  })

  // Document page design §6.2: nothing to save, nothing offered — the bar comes with the first change.
  it('sends nothing when nothing changed', async () => {
    const { calls } = await view({})
    await rowAction('Edit')
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Review and save'),
    ).toBe(false)
    expect(document.querySelector('[data-document-footer]')).toBeNull()
    expect(calls.some((c) => c.path.includes('/documents/'))).toBe(false)
  })

  it('replaces only when the user chooses it', async () => {
    const { calls } = await view({ [`POST ${PREFIX}/documents/replace`]: ok })
    await rowAction('Edit')
    await typeInto(editorText(), editorText().value.replace('Double(5)', 'Double(8)'))
    button('Review and save').click()
    await flushPromises()
    byLabel('Replace the whole document instead').click()
    await flushPromises()
    button('Replace document').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/replace'))!.body).toMatchObject({
      document: { _id: { $numberInt: '1' }, price: { $numberDouble: '8.0' } },
    })
    expect(calls.some((c) => c.path.endsWith('/documents/update'))).toBe(false)
  })

  it('explains why a dotted field name needs a replace, and offers only that', async () => {
    const { calls } = await view({ [`POST ${PREFIX}/documents/replace`]: ok })
    await rowAction('Edit')
    await typeInto(editorText(), "{ _id: 1, price: Double(5), 'a.b': 1 }")
    button('Review and save').click()
    await flushPromises()
    expect(document.body.textContent).toContain('cannot be updated on its own')
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Save changes'),
    ).toBe(false)
    button('Replace document').click()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/documents/replace'))).toHaveLength(1)
  })

  it('Back returns to the text unchanged', async () => {
    await view({})
    await rowAction('Edit')
    await typeInto(editorText(), editorText().value.replace('Double(5)', 'Double(9)'))
    button('Review and save').click()
    await flushPromises()
    button('Back').click()
    await flushPromises()
    expect(editorText().value).toContain('Double(9)')
  })
})

describe('document editor (Review Focus 3)', () => {
  it('saves only the changed field, with the loaded hash, keeping number types exact (spec §4.2)', async () => {
    const { calls } = await view({ [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }] })
    await rowAction('Edit')
    expect(editorText().value).toContain('"price": Double(5)')
    await typeInto(editorText(), editorText().value.replace('Double(5)', 'Double(7)'))
    button('Review and save').click()
    await flushPromises()
    // The review lists the change before anything is sent.
    expect(calls.some((c) => c.path.includes('/documents/'))).toBe(false)
    const review = document.querySelector('[data-test="diff"]')!
    expect(review.textContent).toContain('price')
    expect(review.textContent).toContain('Double(5)')
    expect(review.textContent).toContain('Double(7)')
    button('Save changes').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/update'))!.body).toEqual({
      _id: { $numberInt: '1' },
      set: { price: { $numberDouble: '7.0' } },
      unset: [],
      hash: 'a'.repeat(64),
    })
    expect(calls.some((c) => c.path.endsWith('/documents/replace'))).toBe(false)
    expect(useToastStore().toasts.at(-1)?.message).toBe('Document saved.')
  })

  it('never overwrites a document someone else changed, and can load the current version', async () => {
    let replaced = 0
    const { calls } = await view({
      [`POST ${PREFIX}/documents/update`]: () => {
        replaced++
        return replaced === 1
          ? [409, { code: 'DOCUMENT_CHANGED', message: 'changed' }]
          : [200, { modified: 1 }]
      },
      [`POST ${PREFIX}/documents/get`]: () => [
        200,
        { document: { ...DOC, price: { $numberDouble: '9.5' } }, hash: 'c'.repeat(64) },
      ],
    })
    await rowAction('Edit')
    await typeInto(editorText(), editorText().value.replace('Double(5)', 'Double(6)'))
    button('Review and save').click()
    await flushPromises()
    button('Save changes').click()
    await flushPromises()
    expect(document.querySelector('[data-document-page] [role="alert"]')!.textContent).toContain(
      'Someone changed this document',
    )
    button('Load the current version').click()
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(editorText().value).toContain('"price": 9.5')
    await typeInto(editorText(), editorText().value.replace('9.5', '10.5'))
    button('Review and save').click()
    await flushPromises()
    button('Save changes').click()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/documents/update')).at(-1)!.body).toMatchObject({
      hash: 'c'.repeat(64),
    })
  })

  it('refuses to change the _id', async () => {
    const { calls } = await view({})
    await rowAction('Edit')
    await typeInto(editorText(), '{ _id: 2, price: 1 }')
    button('Review and save').click()
    await flushPromises()
    expect(document.body.textContent).toContain('The _id of a document cannot be changed.')
    expect(calls.some((c) => c.path.endsWith('/documents/replace'))).toBe(false)
  })

  it('inserts one document or an array, and rejects anything else', async () => {
    const { calls } = await view({
      [`POST ${PREFIX}/documents`]: () => [
        200,
        { insertedIds: [{ $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, { $oid: '65a1b2c3d4e5f6a7b8c9d0e2' }] },
      ],
    })
    button('Add documents').click()
    await vi.waitFor(() => expect(document.querySelector('[data-document-page]')).not.toBeNull())
    await typeInto(editorText(), '[1]')
    button('Insert').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Expected a document or an array of documents.')
    await typeInto(editorText(), '[{ a: 1 }, { a: Double(2) }]')
    button('Insert').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents'))!.body).toEqual({
      documents: [{ a: { $numberInt: '1' } }, { a: { $numberDouble: '2.0' } }],
    })
    expect(useToastStore().toasts.at(-1)?.message).toBe('2 documents inserted.')
  })

  // A full e2e run 2026-10-16: typed while an insert was still being saved, the next document went with
  // the pane when it closed. The editor takes no typing while it saves.
  it('takes no typing while it saves, so nothing typed then is lost', async () => {
    let answer!: () => void
    await view({
      [`POST ${PREFIX}/documents`]: () =>
        new Promise(
          (r) => (answer = () => r([200, { insertedIds: [{ $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }] }])),
        ) as never,
    })
    button('Add documents').click()
    await vi.waitFor(() => expect(document.querySelector('[data-document-page]')).not.toBeNull())
    await typeInto(editorText(), '{ a: 1 }')
    button('Insert').click()
    await flushPromises()
    expect(editorText().readOnly).toBe(true)
    expect(editorText().getAttribute('aria-readonly')).toBe('true')
    answer()
    await flushPromises()
    await flushPromises()
    expect(document.querySelector('[data-document-page]')).toBeNull()
  })

  it('clones without the _id', async () => {
    const { calls } = await view({
      [`POST ${PREFIX}/documents`]: () => [200, { insertedIds: [{ $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }] }],
    })
    await rowAction('Clone')
    expect(editorText().value).not.toContain('_id')
    button('Insert').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents'))!.body).toEqual({
      documents: [{ price: { $numberDouble: '5.0' } }],
    })
  })

  // Data review 2026-10-13 (M3): a field the app shows as a typed value it is not stored as — the
  // editor says so before a save is refused, and a clone says the copy would differ.
  it('says before saving or cloning when a field would not be written back as stored', async () => {
    const odd = { _id: { $numberInt: '1' }, price: { $numberInt: '5' } }
    await view({
      [`POST ${PREFIX}/find`]: () => [
        200,
        {
          documents: [
            { document: odd, hash: 'a'.repeat(64), caution: { kind: 'ejson_like', field: 'price' } },
          ],
          hasMore: false,
        },
      ],
    })
    await rowAction('Edit')
    const note = () => document.querySelector('[data-document-page] [data-caution]')
    expect(note()!.textContent).toContain('"price"')
    expect(note()!.textContent).toContain('shell')
    button('Back to results').click()
    await flushPromises()
    await rowAction('Clone')
    expect(note()!.textContent).toContain('copy')
  })

  it('asks before closing with unsaved edits', async () => {
    await view({})
    await rowAction('Edit')
    await typeInto(editorText(), '{ _id: 1, price: 3 }')
    button('Back to results').click()
    await flushPromises()
    expect(document.body.textContent).toContain('The document has unsaved changes.')
  })
})

describe('row actions', () => {
  it('deletes after confirmation and copies as shell text', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { calls } = await view({ [`POST ${PREFIX}/documents/delete`]: () => [204] })
    ;(document.querySelector('button[aria-label="Actions for document 1"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Copy')!
      .click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('price: Double(5)'))
    ;(document.querySelector('button[aria-label="Actions for document 1"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Delete')!
      .click()
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/delete'))!.body).toEqual({
      _id: { $numberInt: '1' },
    })
  })
})

describe('diff review: final review 1g-1', () => {
  it('keys changes whose paths look alike separately (Minor 5)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await view({})
    await rowAction('Edit')
    await typeInto(editorText(), "{ _id: 1, price: Double(5), 'a.b': 1, a: { b: 2 } }")
    button('Review and save').click()
    await flushPromises()
    expect(document.querySelectorAll('[data-test="diff"] li')).toHaveLength(2)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Duplicate keys'))).toBe(false)
  })

  it('explains every reason a replace is needed, in both languages (I4)', () => {
    for (const locale of ['en', 'tr'] as const)
      for (const reason of ['field-name', 'order', 'too-many', 'path-length'])
        expect(i18n.global.te(`editor.replaceReason.${reason}`, locale), `${locale} ${reason}`).toBe(true)
  })
})
