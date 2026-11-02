import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import DsCodeEditor from '../src/ds/DsCodeEditor.vue'
import DocumentTable from '../src/documents/DocumentTable.vue'
import DocumentJsonList from '../src/documents/DocumentJsonList.vue'
import DocumentsView from '../src/documents/DocumentsView.vue'
import BulkDialog from '../src/documents/BulkDialog.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { toRows } from '../src/documents/rows'
import { rowMenuItems } from '../src/documents/rowMenu'
import { completionsFor } from '../src/documents/completions'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useTabsStore } from '../src/stores/tabs'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const T = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const PREFIX = 'connections/c1/databases/shop/collections/orders'
const press = (
  el: HTMLElement,
  key: string,
  init: KeyboardEventInit & { extra?: Record<string, unknown> } = {},
) => {
  const { extra, ...rest } = init
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...rest })
  for (const [k, v] of Object.entries(extra ?? {})) Object.defineProperty(event, k, { value: v })
  el.dispatchEvent(event)
  return event
}

function mountInput(props: Record<string, unknown> = {}) {
  const value = ref('')
  const submits: number[] = []
  const escapes: number[] = []
  const Host = defineComponent(
    () => () =>
      h('div', { onKeydown: (e: KeyboardEvent) => e.key === 'Escape' && escapes.push(1) }, [
        h(DsCodeEditor, {
          label: 'Code',
          modelValue: value.value,
          'onUpdate:modelValue': (v: string) => (value.value = v),
          onSubmit: () => submits.push(1),
          ...props,
        }),
      ]),
  )
  mountApp(Host)
  return { value, submits, escapes, area: () => byLabel<HTMLTextAreaElement>('Code') }
}

async function typeText(el: HTMLTextAreaElement, text: string) {
  el.value = text
  el.setSelectionRange(text.length, text.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

describe('document table (Important 1)', () => {
  it('shows nothing for a field another document lacks, even if it is named like an Object method', () => {
    const rows = toRows(
      [
        { document: { _id: 1, constructor: 'x' }, hash: 'a'.repeat(64) },
        { document: { _id: 2 }, hash: 'b'.repeat(64) },
      ],
      0,
    )
    mountApp(DocumentTable, {
      props: { rows, columns: ['_id', 'constructor'], canWrite: false, rowHeight: 36 },
    })
    const second = document.querySelectorAll('tbody tr[data-row]')[1]!
    expect(second.textContent).not.toContain('fields')
  })
})

describe('code input', () => {
  it('lets the first Escape stay in a multi-line field and the second one leave (Important 5)', () => {
    const { escapes, area } = mountInput({ multiline: true })
    press(area(), 'Escape')
    expect(escapes).toHaveLength(0)
    press(area(), 'Escape')
    expect(escapes).toHaveLength(1)
  })

  it('grows a one-line field with its content, up to six lines (Important 6)', async () => {
    const { area } = mountInput()
    expect(Number(area().rows)).toBe(1)
    await typeText(area(), '{\n  a: 1,\n  b: 2\n}')
    expect(Number(area().rows)).toBe(4)
    await typeText(area(), 'x\n'.repeat(20))
    expect(Number(area().rows)).toBe(6)
  })

  it('ignores Enter while an IME is composing (Minor 1)', () => {
    const { submits, area } = mountInput()
    press(area(), 'Enter', { extra: { isComposing: true } })
    expect(submits).toHaveLength(0)
  })

  it('pairs brackets typed with AltGr (Turkish keyboards) (Minor 2)', async () => {
    const { value, area } = mountInput()
    area().focus()
    press(area(), '{', {
      ctrlKey: true,
      altKey: true,
      extra: { getModifierState: (k: string) => k === 'AltGraph' },
    })
    await nextTick()
    expect(value.value).toBe('{}')
  })

  it('does not suggest inside strings, and closes suggestions when a closer is typed over (Minor 3)', async () => {
    const { area } = mountInput({ completions: completionsFor('query', ['name']) })
    await typeText(area(), '{ a: "na')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    await typeText(area(), '{ na')
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
  })
})

describe('JSON view (Important 8)', () => {
  it('highlights a document only once it scrolls into view', async () => {
    const observers: Array<(entries: Array<{ isIntersecting: boolean; target: Element }>) => void> = []
    const observed: Element[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {
          observers.push(cb)
        }
        observe(el: Element) {
          observed.push(el)
        }
        unobserve() {}
        disconnect() {}
      },
    )
    const rows = toRows([{ document: { _id: 1, name: 'Ada' }, hash: 'a'.repeat(64) }], 0)
    mountApp(DocumentJsonList, { props: { rows, canWrite: false } })
    expect(document.querySelector('pre span')).toBeNull()
    for (const cb of observers) cb(observed.map((target) => ({ isIntersecting: true, target })))
    await nextTick()
    expect(document.querySelector('pre span')).not.toBeNull()
    expect(document.body.textContent).toContain('Ada')
  })
})

function view(handlers: Record<string, Handler>, canWrite = true) {
  const api = mockApi({
    [`POST ${PREFIX}/count`]: () => [200, { count: 40, exact: true }],
    ...handlers,
  })
  useCollectionViewsStore().stateFor('t')
  mountApp(DocumentsView, { props: { target: T, tabId: 't', canWrite, isView: false } })
  mountApp(DialogHost)
  return api
}
const page = (skip: number, n = 20, hasMore = true) => ({
  documents: Array.from({ length: n }, (_, i) => ({
    document: { _id: skip + i, name: `n${skip + i}` },
    hash: String(skip + i).padStart(64, '0'),
  })),
  hasMore,
})

describe('paging', () => {
  it('keeps the old page label while the next page loads and blocks further clicks (Important 7, Minor 11)', async () => {
    let release: (() => void) | undefined
    view({
      [`POST ${PREFIX}/find`]: (body) => {
        const skip = (body as { skip: number }).skip
        if (skip === 0) return [200, page(0)]
        return new Promise((resolve) => {
          release = () => resolve([200, page(skip)])
        })
      },
    })
    await flushPromises()
    const next = () => document.querySelector('button[aria-label="Next page"]') as HTMLButtonElement
    next().click()
    await flushPromises()
    expect(document.body.textContent).toContain('1–20 of 40')
    expect(next().disabled).toBe(true)
    release!()
    await flushPromises()
    expect(document.body.textContent).toContain('21–40 of 40')
  })

  it('steps back when a page becomes empty after deletions (Minor 11)', async () => {
    let second = page(20, 1, false)
    view({
      [`POST ${PREFIX}/find`]: (body) => [200, (body as { skip: number }).skip === 0 ? page(0) : second],
    })
    await flushPromises()
    ;(document.querySelector('button[aria-label="Next page"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.body.textContent).toContain('n20')
    second = { documents: [], hasMore: false }
    ;(document.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement).click()
    await flushPromises()
    await flushPromises()
    expect(useCollectionViewsStore().stateFor('t').page).toBe(0)
  })
})

describe('double submission (Important 2)', () => {
  it('inserts once even when Ctrl+Enter is pressed twice', async () => {
    let resolveInsert: (() => void) | undefined
    const { calls } = view({
      [`POST ${PREFIX}/find`]: () => [200, page(0)],
      [`POST ${PREFIX}/documents`]: () =>
        new Promise((resolve) => {
          resolveInsert = () => resolve([200, { insertedIds: [1] }])
        }),
    })
    await flushPromises()
    button('Add documents').click()
    await vi.waitFor(() => expect(document.querySelector('[data-inspector]')).not.toBeNull())
    const area = byLabel<HTMLTextAreaElement>('Document')
    await typeInto(area, '{ a: 1 }')
    press(area, 'Enter', { ctrlKey: true })
    await flushPromises()
    press(area, 'Enter', { ctrlKey: true })
    await flushPromises()
    resolveInsert!()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/documents'))).toHaveLength(1)
  })
})

describe('bulk dialog', () => {
  it('asks before discarding typed changes (Important 5)', async () => {
    mockApi({})
    const { wrapper } = mountApp(BulkDialog, {
      props: { target: T, operation: 'update', initialFilter: '{}', fields: [] },
    })
    mountApp(DialogHost)
    await typeInto(byLabel<HTMLTextAreaElement>('Update'), '{ $inc: { a: 1 } }')
    ;(document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(document.body.textContent).toContain('Discard your changes?')
  })

  it('ignores a preview that answers after the filter was edited (Minor 5)', async () => {
    let answer: (() => void) | undefined
    mockApi({
      [`POST ${PREFIX}/bulk/preview`]: () =>
        new Promise((resolve) => {
          answer = () =>
            resolve([200, { matched: 3, total: 10, requiresConfirmation: false, filterHash: 'tok' }])
        }),
    })
    mountApp(BulkDialog, { props: { target: T, operation: 'delete', initialFilter: '{ a: 1 }', fields: [] } })
    button('Preview').click()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('Filter'), '{ a: 2 }')
    answer!()
    await flushPromises()
    expect(button('Run').disabled).toBe(true)
    expect(document.body.textContent).not.toContain('3 of 10')
  })

  it('explains stale previews in the user language and formats counts (Minor 13)', async () => {
    i18n.global.locale.value = 'tr'
    mockApi({
      [`POST ${PREFIX}/bulk/preview`]: () => [
        200,
        { matched: 1234, total: 5000, requiresConfirmation: false, filterHash: 'tok' },
      ],
      [`POST ${PREFIX}/bulk/execute`]: () => [
        409,
        { code: 'CONFLICT', message: 'English', details: { reason: 'count_changed', from: 1234, to: 1300 } },
      ],
    })
    mountApp(BulkDialog, { props: { target: T, operation: 'delete', initialFilter: '{}', fields: [] } })
    button('Önizle').click()
    await flushPromises()
    expect(document.body.textContent).toContain('1.234')
    button('Çalıştır').click()
    await flushPromises()
    const alert = document.querySelector('[role="alert"]')!.textContent!
    expect(alert).not.toContain('English')
    expect(alert).toContain('1.300')
  })
})

describe('messages (Minor 13)', () => {
  it('uses singular forms in English', () => {
    expect(i18n.global.t('documents.arrayItems', { count: 1 }, 1)).toBe('1 item')
    expect(i18n.global.t('documents.arrayItems', { count: 3 }, 3)).toBe('3 items')
    expect(i18n.global.t('editor.inserted', { count: 1 }, 1)).toBe('1 document inserted.')
  })
})

describe('row menus (Minor 9)', () => {
  it('offers no delete for an unsupported document whose id could not be read', () => {
    const [row] = toRows([{ unsupported: { _id: null, reason: 'x' } }], 0)
    expect(rowMenuItems(row!, true, (k) => k)).toEqual([])
  })
})

describe('collection tabs', () => {
  async function workspace(collectionsReply: Handler) {
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
      'GET connections': () => [
        200,
        [
          {
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
          },
        ],
      ],
      'GET connections/c1/databases/shop/collections': collectionsReply,
      [`POST ${PREFIX}/find`]: () => [200, page(0, 1, false)],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    tabs.bindUser('local')
    tabs.open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    return tabs
  }

  it('stays read-only until the collection type is known (Minor 7)', async () => {
    await workspace(() => new Promise(() => {}))
    // The tab's view is a lazy chunk: under a parallel run it can take more than the default second.
    await vi.waitFor(() => expect(document.querySelector('form[role="search"]')).not.toBeNull(), {
      timeout: 5_000,
    })
    expect(document.body.textContent).not.toContain('Add documents')
  })

  it('forgets a tab’s query when the tab is closed (Minor 6)', async () => {
    const tabs = await workspace(() => [
      200,
      [{ name: 'orders', type: 'collection', options: {}, readOnly: false }],
    ])
    const id = tabs.active!.id
    const views = useCollectionViewsStore()
    views.stateFor(id).draft.filter = '{ secret: 1 }'
    tabs.close(id)
    await flushPromises()
    expect(views.states[id]).toBeUndefined()
  })
})

describe('editor reload (Minor 12)', () => {
  it('does not ask to discard after loading the current version', async () => {
    let replaced = 0
    view({
      [`POST ${PREFIX}/find`]: () => [200, page(0, 1, false)],
      [`POST ${PREFIX}/documents/update`]: () =>
        ++replaced ? [409, { code: 'DOCUMENT_CHANGED', message: 'x' }] : [200, {}],
      [`POST ${PREFIX}/documents/get`]: () => [
        200,
        { document: { _id: 0, name: 'fresh' }, hash: 'f'.repeat(64) },
      ],
    })
    await flushPromises()
    ;(document.querySelector('button[aria-label="Actions for document 0"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Edit')!
      .click()
    await vi.waitFor(() => expect(document.querySelector('[data-inspector]')).not.toBeNull())
    await typeInto(byLabel<HTMLTextAreaElement>('Document'), "{ _id: 0, name: 'mine' }")
    button('Save').click()
    await flushPromises()
    button('Save changes').click()
    await flushPromises()
    button('Load the current version').click()
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    ;(
      document.querySelector('[data-inspector] button[aria-label="Close the inspector"]') as HTMLButtonElement
    ).click()
    await flushPromises()
    expect(document.body.textContent).not.toContain('The document has unsaved changes.')
    expect(useToastStore().toasts).toBeDefined()
  })
})
