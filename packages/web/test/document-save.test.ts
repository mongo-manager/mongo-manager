// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useDocumentSave } from '../src/documents/page/useDocumentSave'
import { provideMaskedPatterns } from '../src/masking/useMaskedPaths'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useDialogStore } from '../src/stores/dialogs'
import { decodeDocument } from '../src/documents/values'
import type { DocumentRow, EditorMode } from '../src/documents/rows'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// Document page design §6.5–§6.6: the save the tree and the text share — the one the inspector's
// editor had, unchanged: a review first, the opened version's hash, never over a newer copy.
const PREFIX = 'connections/c1/databases/shop/collections/orders'
const RAW = { _id: { $numberInt: '1' }, status: 'pending' }
const ROW: DocumentRow = {
  key: '0:1',
  kind: 'document',
  raw: RAW,
  hash: 'a'.repeat(64),
  value: decodeDocument(RAW),
}
const target = ref({ connectionId: 'c1', db: 'shop', coll: 'orders' })

function harness(mode: EditorMode = { kind: 'edit', row: ROW }) {
  let save!: ReturnType<typeof useDocumentSave>
  const done = vi.fn()
  mountApp(
    defineComponent({
      setup() {
        save = useDocumentSave({ target, tabId: 't', mode: ref(mode), onDone: done })
        return () => null
      },
    }),
  )
  return { save, done }
}

describe('the document save', () => {
  it('shows what changes, then sends an update with the opened version', async () => {
    const { calls } = mockApi({
      [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }],
      [`POST ${PREFIX}/find`]: () => [200, { documents: [], hasMore: false }],
    })
    useCollectionViewsStore().stateFor('t')
    const { save, done } = harness()
    save.text.value = "{ _id: 1, status: 'paid' }"
    save.prepareEdit()
    expect(save.review.value?.diff.kind).toBe('update')
    save.submit()
    await flushPromises()
    const update = calls.find((c) => c.path.endsWith('/documents/update'))!
    expect(update.body).toMatchObject({ set: { status: 'paid' }, hash: 'a'.repeat(64) })
    expect(done).toHaveBeenCalledWith('saved')
  })

  // Review Focus 3: a newer copy on the server is never written over.
  it('says when the server’s copy changed, and sends nothing more', async () => {
    let updates = 0
    mockApi({
      [`POST ${PREFIX}/documents/update`]: (() => {
        updates++
        return [409, { code: 'DOCUMENT_CHANGED', message: 'changed' }]
      }) as Handler,
    })
    useCollectionViewsStore().stateFor('t')
    const { save, done } = harness()
    save.text.value = "{ _id: 1, status: 'paid' }"
    save.prepareEdit()
    save.submit()
    await flushPromises()
    expect(save.conflict.value).toBe('changed')
    expect(updates).toBe(1)
    expect(done).not.toHaveBeenCalled()
  })

  it('loads the latest version when asked', async () => {
    mockApi({
      [`POST ${PREFIX}/documents/get`]: () => [
        200,
        { document: { _id: { $numberInt: '1' }, status: 'paid' }, hash: 'b'.repeat(64) },
      ],
    })
    useCollectionViewsStore().stateFor('t')
    vi.spyOn(useDialogStore(), 'confirm').mockResolvedValue(true)
    const { save } = harness()
    await save.reloadLatest()
    expect(save.hash.value).toBe('b'.repeat(64))
    expect(save.base.value.status).toBe('paid')
    expect(save.text.value).toContain('"paid"')
  })

  // Review Focus 5: unsaved edits stay with the tab, and come back in the next editor of the document.
  it('keeps an unsaved draft with the tab', async () => {
    mockApi({})
    const slot = useCollectionViewsStore().stateFor('t').inspector
    const first = harness()
    first.save.text.value = "{ _id: 1, status: 'held' }"
    await flushPromises()
    expect(slot.draft?.text).toBe("{ _id: 1, status: 'held' }")
    const second = harness()
    expect(second.save.text.value).toBe("{ _id: 1, status: 'held' }")
    expect(second.save.dirty.value).toBe(true)
  })

  // Final review I3: an array holding a hidden value is compared whole, so an update of it would carry
  // the stand-in *** — the server refuses that. The edit goes as a replace, which keeps hidden values.
  it('replaces the document when an update would carry a hidden value', async () => {
    const raw = {
      _id: { $numberInt: '1' },
      payments: [
        { card: '***', amount: { $numberInt: '5' } },
        { card: '***', amount: { $numberInt: '6' } },
      ],
    }
    const row: DocumentRow = {
      key: '0:1',
      kind: 'document',
      raw,
      hash: 'a'.repeat(64),
      value: decodeDocument(raw),
    }
    const { calls } = mockApi({
      [`POST ${PREFIX}/documents/replace`]: () => [200, { modified: 1 }],
      [`POST ${PREFIX}/find`]: () => [200, { documents: [], hasMore: false }],
    })
    useCollectionViewsStore().stateFor('t')
    let save!: ReturnType<typeof useDocumentSave>
    const Child = defineComponent({
      setup() {
        save = useDocumentSave({
          target,
          tabId: 't',
          mode: ref({ kind: 'edit' as const, row }),
          onDone: () => {},
        })
        return () => null
      },
    })
    mountApp(
      defineComponent({
        setup() {
          provideMaskedPatterns(ref([['payments', 'card']]))
          return () => h(Child)
        },
      }),
    )
    save.text.value = "{ _id: 1, payments: [{ card: '***', amount: 5 }, { card: '***', amount: 9 }] }"
    save.prepareEdit()
    expect(save.error.value).toBe('')
    expect(save.review.value?.diff).toMatchObject({ kind: 'replace', reason: 'hidden' })
    save.submit()
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/documents/replace'))).toBe(true)
    expect(calls.some((c) => c.path.endsWith('/documents/update'))).toBe(false)
  })
})
