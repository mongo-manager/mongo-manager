import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { LibraryItem } from '@mongo-manager/shared'
import QueryComposer from '../src/documents/QueryComposer.vue'
import DocumentsView from '../src/documents/DocumentsView.vue'
import SaveItemDialog from '../src/library/SaveItemDialog.vue'
import LibraryView from '../src/library/LibraryView.vue'
import SavedPipelinesMenu from '../src/aggregation/SavedPipelinesMenu.vue'
import { useLibraryStore } from '../src/library/store'
import { parseTags } from '../src/library/tags'
import { emptyDraft } from '../src/documents/queryBuild'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useDialogStore } from '../src/stores/dialogs'
import { useSessionStore } from '../src/stores/session'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

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

const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const BASE = 'connections/c1/databases/shop/collections/orders'
const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const ID3 = '33333333-3333-4333-8333-333333333333'

const favourite = (over: object = {}) => ({
  id: ID1,
  name: 'Big orders',
  tags: ['sales'],
  query: { filter: { total: { $numberInt: '5' } } },
  shared: true,
  mine: true,
  owner: null,
  updatedAt: '2026-09-27T10:00:00.000Z',
  ...over,
})

describe('the Recent menu with favourites (final review 2c, I1 and Minor 19)', () => {
  function mountBar() {
    return mountApp(QueryComposer, {
      props: { completions: [], target, modelValue: { ...emptyDraft() }, 'onUpdate:modelValue': () => {} },
    })
  }

  it('shows the favourites and the recent queries together, with Clear', async () => {
    mockApi({
      [`GET ${BASE}/favourites`]: () => [200, { favourites: [favourite()] }],
      [`GET ${BASE}/recent-queries`]: () => [200, { queries: [{ query: { filter: { a: 1 } }, usedAt: 1 }] }],
    })
    mountBar()
    button('Recent queries').click()
    await flushPromises()
    expect(document.querySelector('[data-favourites]')!.textContent).toContain('Big orders')
    expect(document.querySelectorAll('[data-test="recent-query"]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('No recent queries yet')
    expect(button('Clear history')).toBeTruthy()
  })

  it('says when the favourites could not be loaded, and still lists the recent queries', async () => {
    mockApi({
      [`GET ${BASE}/favourites`]: () => [500, { code: 'INTERNAL', message: 'x' }],
      [`GET ${BASE}/recent-queries`]: () => [200, { queries: [{ query: { filter: { a: 1 } }, usedAt: 1 }] }],
    })
    mountBar()
    button('Recent queries').click()
    await flushPromises()
    expect(document.body.textContent).toContain('The favourites could not be loaded.')
    expect(document.querySelectorAll('[data-test="recent-query"]')).toHaveLength(1)
  })

  it('shows only the loading line while loading', async () => {
    let answer: (v: [number, unknown]) => void = () => {}
    mockApi({
      [`GET ${BASE}/favourites`]: () => [200, { favourites: [] }],
      [`GET ${BASE}/recent-queries`]: () => new Promise((resolve) => (answer = resolve)),
    })
    mountBar()
    button('Recent queries').click()
    await nextTick()
    expect(document.body.textContent).not.toContain('No recent queries yet')
    answer([200, { queries: [] }])
    await flushPromises()
    expect(document.body.textContent).toContain('No recent queries yet')
  })
})

describe('tags as typed (final review 2c, I3)', () => {
  it('drops a leading #, and names a tag the server would refuse', () => {
    expect(parseTags('#Sales, q3 #sales')).toEqual({ tags: ['sales', 'q3'] })
    expect(parseTags('ok, satış')).toEqual({ tags: ['ok'], invalid: 'satış', error: 'chars' })
    expect(parseTags('x'.repeat(31))).toMatchObject({ error: 'long' })
    expect(parseTags(Array.from({ length: 11 }, (_, i) => `t${i}`).join(' '))).toMatchObject({
      error: 'many',
    })
  })
})

describe('the save dialog (final review 2c, I3 and Minor 13)', () => {
  function mountDialog(props: Record<string, unknown> = {}) {
    const saved = vi.fn()
    mountApp(SaveItemDialog, { props: { title: 'Save', onSave: saved, ...props } })
    return saved
  }

  it('shows a refused tag beside the field and does not save', async () => {
    const saved = mountDialog()
    await typeInto(byLabel('Name'), 'n')
    await typeInto(byLabel('Tags'), 'ok satış')
    button('Save').click()
    await flushPromises()
    expect(saved).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('“satış”: use a–z, 0–9, - and _ only.')
  })

  it('saves with Enter from the name field', async () => {
    const saved = mountDialog()
    await typeInto(byLabel('Name'), 'Fast')
    byLabel('Name').form!.requestSubmit()
    await flushPromises()
    expect(saved).toHaveBeenCalledWith({ name: 'Fast', tags: [], shared: false })
    expect(document.querySelector('form button[type="submit"]')).not.toBeNull()
    expect(byLabel('Name').maxLength).toBe(100)
  })

  it('offers sharing only in team mode, starting from the item', async () => {
    mountDialog()
    expect(document.body.textContent).not.toContain('Share with the team')
    document.body.innerHTML = ''
    useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true }
    mountDialog({ shared: true })
    expect(byLabel<HTMLInputElement>('Share with the team').checked).toBe(true)
  })

  it('does not save twice while a save is running (Minor 14)', async () => {
    const saved = mountDialog({ busy: true })
    await typeInto(byLabel('Name'), 'Fast')
    byLabel('Name').form!.requestSubmit()
    await flushPromises()
    expect(saved).not.toHaveBeenCalled()
  })

  it('shows the error it is given inside the dialog', () => {
    mountDialog({ error: 'At most 200 favourites can be saved in one collection.' })
    expect(document.querySelector('[role="dialog"] [role="alert"]')!.textContent).toContain('At most 200')
  })
})

describe('favourites from the query bar (final review 2c, Minor 20, Minor 12, Minor 17)', () => {
  function mountBar(draft = { ...emptyDraft(), filter: '{ total: 5 }', skip: 'x' }) {
    const model = ref(draft)
    const mounted = mountApp(QueryComposer, {
      props: {
        completions: [],
        target,
        modelValue: model.value,
        'onUpdate:modelValue': (v: typeof draft) => (model.value = v),
      },
    })
    return { model, ...mounted }
  }

  it('saves the filter parts even when the page settings do not parse', async () => {
    const { calls } = mockApi({ [`POST ${BASE}/favourites`]: () => [201, favourite()] })
    mountBar()
    const star = document.querySelector<HTMLButtonElement>('button[aria-label="Save as favourite"]')!
    expect(star.disabled).toBe(false)
    star.click()
    await flushPromises()
    await typeInto(byLabel('Name'), 'Five')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      query: { filter: { total: { $numberInt: '5' } } },
    })
  })

  it('says the collection has too many favourites, in the dialog', async () => {
    mockApi({
      [`POST ${BASE}/favourites`]: () => [
        409,
        { code: 'CONFLICT', message: 'x', details: { reason: 'limit', max: 200 } },
      ],
    })
    mountBar()
    document.querySelector<HTMLButtonElement>('button[aria-label="Save as favourite"]')!.click()
    await flushPromises()
    await typeInto(byLabel('Name'), 'Five')
    button('Save').click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"] [role="alert"]')!.textContent).toContain(
      'This collection already has 200 saved items',
    )
  })

  it('shows the options when a draft with them arrives from elsewhere (the Library)', async () => {
    mockApi({})
    const { wrapper } = mountBar({ ...emptyDraft() })
    expect(document.querySelector('[aria-label="Sort"], textarea[aria-label="Sort"]')).toBeNull()
    await wrapper.setProps({ modelValue: { ...emptyDraft(), sort: '{ a: 1 }' } })
    await flushPromises()
    expect(byLabel('Sort')).toBeTruthy()
  })
})

const item = (over: Partial<LibraryItem>): LibraryItem => ({
  type: 'favourite',
  id: ID1,
  db: 'shop',
  coll: 'orders',
  name: 'Big orders',
  tags: ['sales'],
  kind: 'find',
  preview: '{ a: 1 }',
  body: { filter: { a: { $numberInt: '1' } } },
  at: '2026-09-27T10:00:00.000Z',
  shared: false,
  mine: true,
  ...over,
})

describe('the Library panel (final review 2c, I2, I5, Minor 15 and 16)', () => {
  async function mountPanel(items: LibraryItem[], access: 'admin' | 'editor' = 'editor', extra = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const api = mockApi({
      'GET connections': () => [
        200,
        [
          {
            id: 'c1',
            name: 'Local',
            group: null,
            color: null,
            favorite: false,
            readOnly: false,
            access,
            permissions: [],
          },
        ],
      ],
      'GET connections/c1/library': () => [200, { items, truncated: false, tags: ['etl', 'sales'] }],
      ...extra,
    })
    useLibraryStore().connectionId = 'c1'
    const mounted = mountApp(LibraryView)
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    return { ...api, ...mounted }
  }
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-library-item]')]
  const action = (row: HTMLElement, name: string) =>
    row.querySelector<HTMLButtonElement>(`button[data-action="${name}"]`)

  it('edits a favourite: name, tags and sharing, keeping its query', async () => {
    useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true }
    const { calls } = await mountPanel([item({})], 'editor', {
      [`PUT ${BASE}/favourites/${ID1}`]: (body: unknown) => [200, { ...favourite(), ...(body as object) }],
    })
    action(rows()[0]!, 'edit')!.click()
    await flushPromises()
    expect(byLabel('Name').value).toBe('Big orders')
    expect(byLabel('Tags').value).toBe('sales')
    await typeInto(byLabel('Tags'), 'sales, q3')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      name: 'Big orders',
      tags: ['sales', 'q3'],
      query: { filter: { a: { $numberInt: '1' } } },
      shared: false,
    })
  })

  it('edits a saved pipeline with its stages', async () => {
    const stages = [{ $limit: { $numberInt: '3' } }]
    const { calls } = await mountPanel(
      [item({ type: 'pipeline', kind: 'aggregate', body: stages })],
      'editor',
      {
        [`PUT ${BASE}/pipelines/${ID1}`]: (body: unknown) => [200, body],
      },
    )
    action(rows()[0]!, 'edit')!.click()
    await flushPromises()
    await typeInto(byLabel('Name'), 'Renamed')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      name: 'Renamed',
      stages,
      tags: ['sales'],
      shared: false,
    })
  })

  it('deletes a favourite after asking; others’ shared items only for connection admins', async () => {
    const theirs = item({ id: ID2, name: 'Theirs', mine: false, shared: true })
    const { calls } = await mountPanel([item({}), theirs], 'editor', {
      [`DELETE ${BASE}/favourites/${ID1}`]: () => [204],
    })
    expect(action(rows()[1]!, 'delete')).toBeNull()
    expect(action(rows()[1]!, 'edit')).toBeNull()
    action(rows()[0]!, 'delete')!.click()
    await flushPromises()
    expect(useDialogStore().current!.danger).toBe(true)
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith(ID1))).toBe(true)
    expect(rows()).toHaveLength(1)
    document.body.innerHTML = ''
    await mountPanel([theirs], 'admin')
    expect(action(rows()[0]!, 'delete')).not.toBeNull()
  })

  it('narrows to one of the collections it lists, when asked', async () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'collection', title: 'shop.orders', params: target })
    const { fetchMock } = await mountPanel([item({})])
    const scope = byLabel<HTMLSelectElement>('Collections')
    expect([...scope.options].map((o) => o.textContent?.trim())).toEqual(['All collections', 'shop.orders'])
    scope.value = 'shop\u0000orders'
    scope.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    const url = String(fetchMock.mock.calls.at(-1)![0])
    expect(url).toContain('db=shop')
    expect(url).toContain('coll=orders')
  })

  it('offers the tags the server found, focuses the search, and names each Remove', async () => {
    await mountPanel([item({ type: 'history', name: undefined, tags: [], preview: '{ x: 1 }' })])
    expect([...document.querySelectorAll('[data-tag]')].map((b) => b.getAttribute('data-tag'))).toEqual([
      'etl',
      'sales',
    ])
    expect(document.activeElement).toBe(document.querySelector('input[type="search"]'))
    expect(action(rows()[0]!, 'remove')!.getAttribute('aria-label')).toBe(
      'Remove from history: shop.orders { x: 1 }',
    )
  })

  it('opens a pipeline with a stage it cannot read, saying so; and a find again, running it', async () => {
    const tabs = useTabsStore()
    const { queryClient } = await mountPanel([
      item({ type: 'pipeline', kind: 'aggregate', body: [{ $limit: { $numberInt: '3' } }, 'junk'] }),
      item({ id: ID3 }),
    ])
    action(rows()[0]!, 'open')!.click()
    await flushPromises()
    const state = useCollectionViewsStore().stateFor(tabs.active!.id)
    expect(state.aggregation.cards).toHaveLength(1)
    expect(useToastStore().toasts.at(-1)!.message).toContain('1 stage could not be read')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    action(rows()[1]!, 'open')!.click()
    await flushPromises()
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['connections', 'c1', 'databases', 'shop', 'collections', 'orders', 'documents'],
    })
  })

  it('forgets an earlier error and truncation when the connection goes', async () => {
    await mountPanel([item({})], 'editor', {
      'GET connections/c1/library': () => [200, { items: [item({})], truncated: true, tags: [] }],
    })
    expect(document.body.textContent).toContain('Only the most recent matches are shown')
    useLibraryStore().connectionId = null
    await flushPromises()
    expect(document.body.textContent).not.toContain('Only the most recent matches are shown')
  })
})

describe('opening a history entry of a dropped collection (Review Focus 4)', () => {
  it('runs the query and says nothing matched', async () => {
    const tabs = useTabsStore()
    const id = tabs.open({
      kind: 'collection',
      title: 'gone.dropped',
      params: { connectionId: 'c1', db: 'gone', coll: 'dropped' },
    })
    const state = useCollectionViewsStore().stateFor(id)
    state.query = { filter: { a: { $numberInt: '1' } }, skip: 0, limit: 20 }
    const { calls } = mockApi({
      'POST connections/c1/databases/gone/collections/dropped/find': () => [
        200,
        { documents: [], hasMore: false },
      ],
      'POST connections/c1/databases/gone/collections/dropped/count': () => [200, { count: 0, exact: true }],
    })
    mountApp(DocumentsView, {
      props: {
        target: { connectionId: 'c1', db: 'gone', coll: 'dropped' },
        tabId: id,
        canWrite: true,
        isView: false,
      },
    })
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/find'))!.body).toMatchObject({
      filter: { a: { $numberInt: '1' } },
    })
    expect(document.body.textContent).toContain('No documents match this query.')
  })
})

describe('saved pipelines menu (final review 2c, Minor 18 and I2)', () => {
  const pipeline = (id: string, name: string, tags: string[]) => ({
    id,
    name,
    tags,
    stages: [],
    shared: false,
    mine: true,
    owner: null,
    updatedAt: '2026-09-27T10:00:00.000Z',
  })

  it('finds by tag, forgets a chosen tag that is gone, and edits a pipeline’s tags', async () => {
    let list = [pipeline(ID1, 'Report', ['etl']), pipeline(ID2, 'Cleanup', ['ops'])]
    const { calls } = mockApi({
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: list }],
      [`DELETE ${BASE}/pipelines/${ID2}`]: () => {
        list = list.filter((p) => p.id !== ID2)
        return [204]
      },
      [`PUT ${BASE}/pipelines/${ID1}`]: (body: unknown) => [200, { ...list[0], ...(body as object) }],
    })
    mountApp(SavedPipelinesMenu, { props: { target } })
    button('Pipelines').click()
    await flushPromises()
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    await typeInto(search, 'ops')
    expect(
      [...document.querySelectorAll('[data-pipeline]')].map((e) => e.getAttribute('data-pipeline')),
    ).toEqual([ID2])
    await typeInto(search, '')
    document.querySelector<HTMLButtonElement>('button[data-tag="ops"]')!.click()
    await flushPromises()
    expect(document.querySelector('button[data-tag="ops"]')!.textContent!.trim()).toBe('#ops')
    document
      .querySelector<HTMLButtonElement>(`[data-pipeline="${ID2}"] button[data-action="delete"]`)!
      .click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(document.querySelectorAll('[data-pipeline]')).toHaveLength(1)
    document.querySelector<HTMLButtonElement>(`[data-pipeline="${ID1}"] button[data-action="edit"]`)!.click()
    await flushPromises()
    await typeInto(byLabel('Tags'), 'etl weekly')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      name: 'Report',
      stages: [],
      tags: ['etl', 'weekly'],
      shared: false,
    })
  })
})
