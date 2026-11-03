import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { LibraryItem } from '@mongo-manager/shared'
import LibraryView from '../src/library/LibraryView.vue'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useDialogStore } from '../src/stores/dialogs'
import { useLibraryStore } from '../src/library/store'
import { openLibraryTab } from '../src/workspace/openTabs'
import { newCard } from '../src/aggregation/stages'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { createMemoryHistory } from 'vue-router'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { SHORTCUT_GROUPS } from '../src/workspace/shortcuts'
import { commandTitle, useCommandsStore } from '../src/stores/commands'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  useTabsStore().bindUser('local')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const item = (over: Partial<LibraryItem>): LibraryItem => ({
  type: 'favourite',
  id: randomId(),
  db: 'shop',
  coll: 'orders',
  tags: [],
  kind: 'find',
  preview: '{ a: 1 }',
  body: { filter: { a: { $numberInt: '1' } } },
  at: '2026-09-27T10:00:00.000Z',
  shared: false,
  mine: true,
  ...over,
})
let n = 0
function randomId() {
  n++
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

const CONNECTION = {
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
  permissions: [],
}

const ITEMS: LibraryItem[] = [
  item({ name: 'Big orders', tags: ['sales'] }),
  item({
    type: 'pipeline',
    name: 'Report',
    kind: 'aggregate',
    coll: 'items',
    tags: ['etl'],
    body: [{ $limit: { $numberInt: '3' } }],
    preview: '[{ $limit: 3 }]',
  }),
  item({ type: 'history', kind: 'find', db: 'crm', coll: 'people', count: 4 }),
]

async function mountPage(items = ITEMS, connectionId: string | null = 'c1') {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const api = mockApi({
    'GET connections': () => [200, [CONNECTION, { ...CONNECTION, id: 'c2', name: 'Staging' }]],
    'GET connections/c1/library': (_b, url) => [
      200,
      {
        items: url.searchParams.get('type')
          ? items.filter((i) => i.type === url.searchParams.get('type'))
          : items,
        truncated: false,
      },
    ],
    'DELETE connections/c1/library/history': () => [204],
    [`DELETE connections/c1/library/history/${items[2]?.id ?? 'none'}`]: () => [204],
  })
  useLibraryStore().connectionId = connectionId
  mountApp(LibraryView)
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  return api
}
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-library-item]')]

// User request 2026-10-10: the Library is a page of its own, "Queries", no longer a side panel.
// Review of R3–R5 (I-4): what deletes is in a "…" menu, in danger colour, never a button of its own.
async function fromMenu(trigger: string, entry: string) {
  document.querySelector<HTMLButtonElement>(`button[aria-label="${trigger}"]`)!.click()
  await flushPromises()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (m) => m.textContent?.trim() === entry,
  )!
  expect(item.className).toContain('text-danger')
  item.click()
  await flushPromises()
}

describe('the Queries page (phase 2c spec §3)', () => {
  it('shows favourites, pipelines and history with their names, namespaces, tags and previews', async () => {
    await mountPage()
    expect(rows()).toHaveLength(3)
    expect(rows()[0]!.textContent).toContain('Big orders')
    expect(rows()[0]!.textContent).toContain('shop.orders')
    expect(rows()[0]!.textContent).toContain('sales')
    expect(rows()[1]!.textContent).toContain('[{ $limit: 3 }]')
    expect(rows()[2]!.textContent).toContain('Find')
    expect(rows()[2]!.textContent).toContain('4')
  })

  it('searches 300 ms after typing, and filters by type and by tag', async () => {
    const { calls, fetchMock } = await mountPage()
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'big'
    search.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(299)
    const searches = () => calls.filter((c) => c.path === 'connections/c1/library')
    expect(searches()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(searches()).toHaveLength(2)
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('q=big')
    const history = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (b) => b.textContent?.trim() === 'History',
    )!
    history.click()
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(rows()).toHaveLength(1)
    expect(history.getAttribute('aria-checked')).toBe('true')
  })

  // The panel once opened empty when no connection was active: the page always has one.
  it('searches the first connection when none is open, never showing an empty page', async () => {
    await mountPage(ITEMS, null)
    expect(useLibraryStore().connectionId).toBe('c1')
    expect(rows()).toHaveLength(3)
    expect(document.body.textContent).toContain('Prod')
  })

  it('narrows to one collection of those it lists', async () => {
    const { fetchMock } = await mountPage()
    const select = [...document.querySelectorAll<HTMLSelectElement>('select')].find((el) =>
      [...el.options].some((o) => o.textContent === 'shop.items'),
    )!
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'All collections',
      'crm.people',
      'shop.items',
      'shop.orders',
    ])
    select.value = [...select.options].find((o) => o.textContent === 'shop.items')!.value
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    const url = String(fetchMock.mock.calls.at(-1)![0])
    expect(url).toContain('db=shop')
    expect(url).toContain('coll=items')
    // The list it chose from stays on offer.
    expect([...select.options]).toHaveLength(4)
  })

  it('names what is edited: a snippet is not a pipeline', async () => {
    await mountPage([
      item({
        type: 'snippet',
        name: 'Top',
        kind: 'shell',
        db: '',
        coll: '',
        body: { code: 'x', params: [] },
      }),
    ])
    rows()[0]!.querySelector<HTMLButtonElement>('button[data-action="edit"]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('Edit the snippet')
    // W5: a snippet's code is edited there too, not only its name and tags.
    const code = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Code')!
    expect((document.getElementById(code.htmlFor) as HTMLTextAreaElement).value).toBe('x')
  })

  // W5 review (minor): a connection admin edits what local mode saved, as the server allows.
  it('offers Edit on an item without an owner to a connection admin, not on another user’s', async () => {
    const snippet = {
      type: 'snippet' as const,
      kind: 'shell' as const,
      db: '',
      coll: '',
      body: { code: 'x', params: [] },
    }
    await mountPage([
      item({ ...snippet, name: 'Local', mine: false, ownerless: true }),
      item({ ...snippet, name: 'Theirs', mine: false, shared: true }),
    ])
    const edit = (name: string) =>
      rows()
        .find((r) => r.textContent?.includes(name))!
        .querySelector('button[data-action="edit"]')
    expect(edit('Local')).not.toBeNull()
    expect(edit('Theirs')).toBeNull()
  })

  // Review I5, M7: each row is one control, read whole, with a visible focus ring.
  it('reads each row whole, says where it opens, and shows where the focus is', async () => {
    await mountPage([...ITEMS, item({ type: 'snippet', name: 'Top', kind: 'shell', db: '', coll: '' })])
    const open = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('button[data-action="open"]')!
    expect(open(rows()[0]!).hasAttribute('aria-label')).toBe(false)
    expect(open(rows()[0]!).textContent).toContain('Open in its collection:')
    expect(open(rows()[0]!).textContent).toContain('Big orders')
    expect(open(rows()[0]!).textContent).toContain('shop.orders')
    expect(open(rows()[3]!).textContent).toContain('Open in the shell:')
    expect(open(rows()[0]!).className).not.toContain('outline-none')
    // The visible "Open" is part of the row's own button, not a second control.
    expect(rows()[0]!.querySelectorAll('button:not([data-action])')).toHaveLength(0)
  })

  // Review I6, M10: a connection's rows go the moment another is chosen; one search per change.
  it('drops the rows of the connection it leaves at once, and searches the new one once', async () => {
    const { calls } = await mountPage()
    const c2 = () => calls.filter((c) => c.path === 'connections/c2/library')
    // A tag and a collection chosen: both go with the connection, in the same one search.
    useLibraryStore().filters.tag = 'sales'
    useLibraryStore().filters.scope = 'shop\u0000orders'
    await flushPromises()
    useLibraryStore().connectionId = 'c2'
    await Promise.resolve()
    await Promise.resolve()
    expect(rows()).toHaveLength(0)
    await flushPromises()
    expect(c2()).toHaveLength(1)
  })

  // Review M3: while the connections load, the page says it loads — never "Nothing saved yet".
  it('shows it loads until the connections are known, searching none before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let answer!: (v: unknown) => void
    const { calls } = mockApi({
      'GET connections': () => new Promise((r) => (answer = r)) as never,
      'GET connections/c1/library': () => [200, { items: ITEMS, truncated: false }],
    })
    useLibraryStore().connectionId = 'gone'
    mountApp(LibraryView)
    await flushPromises()
    expect(document.body.textContent).not.toContain('Nothing saved yet')
    expect(document.querySelector('[data-library-loading]')).not.toBeNull()
    expect(calls.some((c) => c.path.endsWith('/library'))).toBe(false)
    answer([200, [CONNECTION]])
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(useLibraryStore().connectionId).toBe('c1')
    expect(calls.filter((c) => c.path === 'connections/gone/library')).toHaveLength(0)
    expect(rows()).toHaveLength(3)
  })

  // Review M4: what was searched is kept when the page shows again; the collection it came from is offered.
  it('keeps its search when shown again, and offers the collection it was opened from', async () => {
    await mountPage()
    useLibraryStore().origin = { db: 'sales', coll: 'leads' }
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'big'
    search.dispatchEvent(new Event('input'))
    document.body.innerHTML = ''
    mountApp(LibraryView)
    await flushPromises()
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('big')
    const select = [...document.querySelectorAll<HTMLSelectElement>('select')].find((el) =>
      [...el.options].some((o) => o.textContent === 'All collections'),
    )!
    expect([...select.options].map((o) => o.textContent)).toContain('sales.leads')
  })

  it('opens a find in its collection tab and runs it', async () => {
    await mountPage()
    rows()[0]!.querySelector<HTMLButtonElement>('button[data-action="open"]')!.click()
    await flushPromises()
    const tabs = useTabsStore()
    expect(tabs.active).toMatchObject({
      kind: 'collection',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    const state = useCollectionViewsStore().stateFor(tabs.active!.id)
    expect(state.section).toBe('documents')
    expect(state.query.filter).toEqual({ a: { $numberInt: '1' } })
    expect(state.draft.filter).toContain('a: 1')
  })

  it('opens a pipeline in the Aggregations cards, asking before it replaces unsaved cards', async () => {
    await mountPage()
    const tabs = useTabsStore()
    const id = tabs.open({
      kind: 'collection',
      title: 'shop.items',
      params: { connectionId: 'c1', db: 'shop', coll: 'items' },
    })
    useCollectionViewsStore().stateFor(id).aggregation.cards = [{ ...newCard('$match'), text: '{ keep: 1 }' }]
    rows()[1]!.querySelector<HTMLButtonElement>('button[data-action="open"]')!.click()
    await flushPromises()
    expect(useDialogStore().current).not.toBeNull()
    useDialogStore().settle(true)
    await flushPromises()
    const state = useCollectionViewsStore().stateFor(id)
    expect(state.section).toBe('aggregations')
    expect(state.aggregation.cards.map((c) => [c.operator, c.text])).toEqual([['$limit', '3']])
  })

  it('opens an entry of a collection that no longer exists without failing (Review Focus 4)', async () => {
    await mountPage([item({ type: 'history', db: 'gone', coll: 'dropped' })])
    rows()[0]!.querySelector<HTMLButtonElement>('button[data-action="open"]')!.click()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({ params: { db: 'gone', coll: 'dropped' } })
  })

  it('removes a history entry, and clears the history after asking', async () => {
    const { calls } = await mountPage()
    rows()[2]!.querySelector<HTMLButtonElement>('button[data-action="remove"]')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith(ITEMS[2]!.id))).toBe(true)
    expect([...document.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
      'Clear history',
    )
    await fromMenu('More library actions', 'Clear history')
    expect(useDialogStore().current!.danger).toBe(true)
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/library/history'))).toBe(true)
  })
})

describe('opening the Queries page', () => {
  it('searches the collection tab’s connection, and offers that collection', () => {
    const tabs = useTabsStore()
    tabs.open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c9', db: 'shop', coll: 'orders' },
    })
    openLibraryTab(tabs)
    expect(tabs.active?.kind).toBe('library')
    expect(useLibraryStore().connectionId).toBe('c9')
    expect(useLibraryStore().origin).toEqual({ db: 'shop', coll: 'orders' })
  })
})

describe('the Library in the workspace (phase 2c spec §3)', () => {
  async function mountWorkspace() {
    const { calls } = mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      // Another connection listed first: the page still searches the active tab's.
      'GET connections': () => [200, [{ ...CONNECTION, id: 'c0', name: 'Other' }, CONNECTION]],
      'GET connections/c1/library': (_b, url) => [
        200,
        {
          items: ITEMS.filter(
            (i) => !url.searchParams.get('type') || i.type === url.searchParams.get('type'),
          ),
          truncated: false,
        },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    useTabsStore().open({ kind: 'connection', title: 'c1', params: { connectionId: 'c1' } })
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    return { calls, router }
  }

  it('opens the Queries page from Ctrl+Shift+L, the sidebar and the palette, for the active connection', async () => {
    const { router } = await mountWorkspace()
    expect(document.querySelector('[data-library-page]')).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true }))
    await flushPromises()
    await flushPromises()
    expect(useTabsStore().active?.kind).toBe('library')
    expect(document.querySelector('[data-library-page]')).not.toBeNull()
    expect(document.querySelector('[data-library-panel]')).toBeNull()
    expect(useLibraryStore().connectionId).toBe('c1')
    expect(router.currentRoute.value.path).toBe('/library')
    // The sidebar's Queries item is a page like the others: current while it is open.
    const queries = [...document.querySelectorAll<HTMLButtonElement>('nav button')].find(
      (b) => b.textContent?.trim() === 'Queries',
    )!
    expect(queries.getAttribute('aria-current')).toBe('page')
    expect(queries.hasAttribute('aria-expanded')).toBe(false)
    useTabsStore().open({ kind: 'connection', title: 'c1', params: { connectionId: 'c1' } })
    await flushPromises()
    queries.click()
    await flushPromises()
    expect(useTabsStore().active?.kind).toBe('library')
    expect(useCommandsStore().commands.some((c) => c.id === 'library')).toBe(true)
    expect(SHORTCUT_GROUPS.flatMap((g) => g.items).some((s) => s.action === 'library')).toBe(true)
  })

  // Review M12: the page has an address: opened from it (a reload, a link), it is the page.
  it('opens the Queries page from its address', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, [CONNECTION]],
      'GET connections/c1/library': () => [200, { items: ITEMS, truncated: false }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/library')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    await flushPromises()
    expect(useTabsStore().active?.kind).toBe('library')
    expect(document.querySelector('[data-library-page]')).not.toBeNull()
    expect(document.querySelectorAll('[data-library-item]')).toHaveLength(3)
  })

  // Review M11: in a code editor the keys are the editor's ("select all matches" in CodeMirror).
  it('leaves Ctrl+Shift+L to a code editor that has the focus', async () => {
    await mountWorkspace()
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    const content = document.createElement('div')
    content.contentEditable = 'true'
    editor.append(content)
    document.body.append(editor)
    content.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true, bubbles: true }),
    )
    await flushPromises()
    expect(useTabsStore().active?.kind).not.toBe('library')
  })

  it('lists the shell snippets of the active connection in the palette (phase 3a-2)', async () => {
    const snippet: LibraryItem = {
      type: 'snippet',
      id: 'sn1',
      db: '',
      coll: '',
      name: 'Top tags',
      tags: [],
      kind: 'shell',
      preview: 'db.orders.find()',
      body: { code: 'db.orders.find()', params: [] },
      at: '2026-09-29T00:00:00.000Z',
      shared: false,
      mine: true,
    }
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, []],
      'GET connections/c1/library': (_b, url) => [
        200,
        { items: url.searchParams.get('type') === 'snippet' ? [snippet] : [], truncated: false },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    useTabsStore().open({ kind: 'connection', title: 'c1', params: { connectionId: 'c1' } })
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    const titles = useCommandsStore().commands.map((c) => commandTitle(c))
    expect(titles).toContain('Open snippet: Top tags')
  })

  it('lists favourites and saved pipelines of the active connection in the palette, not history', async () => {
    const { calls } = await mountWorkspace()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    const titles = useCommandsStore().commands.map((c) => commandTitle(c))
    expect(titles).toContain('Open favourite: Big orders (shop.orders)')
    expect(titles).toContain('Open pipeline: Report (shop.items)')
    expect(titles.some((x) => x.includes('crm.people'))).toBe(false)
    // Opening the palette again soon after reuses the list (the palette really closes first:
    // final review 2c, Minor 5).
    document
      .querySelector('[role="combobox"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[role="combobox"]')).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    expect(document.querySelector('[role="combobox"]')).not.toBeNull()
    // One request per type: favourites, pipelines and (phase 3a-2) shell snippets — and no more when
    // the palette opens again soon after.
    expect(calls.filter((c) => c.path === 'connections/c1/library')).toHaveLength(3)
  })

  // Review (minor): a list the server now refuses is not offered from before.
  it('drops a connection’s saved items when a refresh is refused', async () => {
    let refused = false
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, [CONNECTION]],
      'GET connections/c1/library': (_b, url) =>
        refused
          ? [403, { code: 'FORBIDDEN', message: 'no access' }]
          : [
              200,
              { items: url.searchParams.get('type') === 'favourite' ? [ITEMS[0]] : [], truncated: false },
            ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    useTabsStore().open({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    const titles = () => useCommandsStore().commands.map((c) => commandTitle(c))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    expect(titles().some((x) => x.includes('Big orders'))).toBe(true)
    document
      .querySelector('[role="combobox"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    refused = true
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    expect(titles().some((x) => x.includes('Big orders'))).toBe(false)
    vi.restoreAllMocks()
  })

  // W5: the palette lists the saved items of every connection open in a tab, grouped by connection.
  it('lists the saved items of every open connection, each connection its own group', async () => {
    const { calls } = mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, [CONNECTION, { ...CONNECTION, id: 'c2', name: 'Staging' }]],
      'GET connections/c1/library': (_b, url) => [
        200,
        { items: url.searchParams.get('type') === 'favourite' ? [ITEMS[0]] : [], truncated: false },
      ],
      'GET connections/c2/library': (_b, url) => [
        200,
        {
          items: url.searchParams.get('type') === 'favourite' ? [item({ name: 'Staged orders' })] : [],
          truncated: false,
        },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    useTabsStore().open({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    const staging = useTabsStore().open({
      kind: 'connection',
      title: 'Staging',
      params: { connectionId: 'c2' },
    })
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    const groups = [...document.querySelectorAll('[role="listbox"] [role="group"]')]
    const savedIn = (name: string) => groups.find((g) => g.getAttribute('aria-label') === `Saved in ${name}`)
    expect(savedIn('Prod')!.textContent).toContain('Big orders')
    expect(savedIn('Staging')!.textContent).toContain('Staged orders')
    expect(savedIn('Prod')!.textContent).not.toContain('Staged orders')
    expect(calls.filter((c) => c.path === 'connections/c2/library')).toHaveLength(3)
    // A connection whose tabs all close leaves the palette.
    document
      .querySelector('[role="combobox"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    useTabsStore().close(staging)
    await flushPromises()
    const titles = useCommandsStore().commands.map((c) => commandTitle(c))
    expect(titles.some((x) => x.includes('Staged orders'))).toBe(false)
    expect(titles.some((x) => x.includes('Big orders'))).toBe(true)
  })
})
