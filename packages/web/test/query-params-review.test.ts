import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import DocumentTable from '../src/documents/DocumentTable.vue'
import QueryComposer from '../src/documents/QueryComposer.vue'
import FilterBuilder from '../src/documents/FilterBuilder.vue'
import { buildQuery, emptyDraft, type QueryDraft } from '../src/documents/queryBuild'
import { addCondition } from '../src/schema/conditions'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, settled } from './support/dom'

/** Final review of the query parameters (2026-10-28): what a template must survive. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const M = (name: string) => ({ $$param: name })
const T = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const PREFIX = 'connections/c1/databases/shop/collections/orders'
const items = [
  { document: { _id: { $numberInt: '1' }, status: 'paid', qty: { $numberInt: '5' } }, hash: '1'.repeat(64) },
]
const draftOf = (over: Partial<QueryDraft>): QueryDraft => ({ ...emptyDraft(), ...over })
const finds = (calls: Array<{ path: string; body: unknown }>) => calls.filter((c) => c.path.endsWith('/find'))

describe('building a template', () => {
  it('takes parameters named as every object’s own properties (Important 1)', () => {
    const draft = draftOf({
      filter: '{ a: {{constructor}}, b: {{__proto__}} }',
      params: JSON.parse('{"constructor":"1","__proto__":"x"}') as Record<string, string>,
    })
    expect(buildQuery(draft)).toMatchObject({
      ok: true,
      query: { filter: { a: { $numberInt: '1' }, b: 'x' } },
    })
    expect(buildQuery(draftOf({ filter: '{ a: {{constructor}} }' }))).toMatchObject({
      ok: false,
      field: 'params',
      errors: { constructor: 'required' },
    })
  })

  it('counts the parameters of every part together, 20 at most (Minor 4)', () => {
    const many = (from: number, n: number) =>
      `{ ${Array.from({ length: n }, (_, i) => `f${from + i}: {{p${from + i}}}`).join(', ')} }`
    expect(buildQuery(draftOf({ filter: many(0, 15), projection: many(15, 6) }))).toMatchObject({
      ok: false,
      field: 'filter',
      message: 'A query has 20 parameters at most',
    })
  })

  it('says why a value written as code cannot be read (Important 4)', async () => {
    const model = { value: draftOf({ filter: '{ _id: {{id}} }', params: { id: 'ObjectId("bad")' } }) }
    const onApply = vi.fn()
    mountApp(QueryComposer, {
      props: {
        completions: [],
        modelValue: model.value,
        'onUpdate:modelValue': (v: QueryDraft) => (model.value = v),
        onApply,
      },
    })
    await flushPromises()
    button('Find').click()
    await flushPromises()
    expect(onApply).not.toHaveBeenCalled()
    expect(document.querySelector('[data-query-param="id"]')!.textContent).toMatch(
      /\{\{id\}\} cannot be read: ObjectId/,
    )
  })

  it('shows and fills a field named constructor', async () => {
    const model = { value: draftOf({ filter: '{ a: {{constructor}} }' }) }
    const onApply = vi.fn()
    mountApp(QueryComposer, {
      props: {
        completions: [],
        modelValue: model.value,
        'onUpdate:modelValue': (v: QueryDraft) => (model.value = v),
        onApply,
      },
    })
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-query-param="constructor"] input')!
    expect(input.value).toBe('')
    // Nothing the plain object inherits is taken for its error either.
    expect(input.getAttribute('aria-invalid')).toBeNull()
    input.value = 'x'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    button('Find').click()
    await flushPromises()
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ filter: { a: 'x' } }))
  })
})

describe('a favourite with parameters picked from the recent queries menu (Important 5)', () => {
  function mountBar(favourites: unknown[]) {
    mockApi({
      [`GET ${PREFIX}/recent-queries`]: () => [200, { queries: [] }],
      [`GET ${PREFIX}/favourites`]: () => [200, { favourites }],
    })
    const model = { value: emptyDraft() }
    const onApply = vi.fn()
    // As a parent does: the draft written comes back as the model.
    const { wrapper } = mountApp(QueryComposer, {
      props: {
        completions: [],
        target: T,
        modelValue: model.value,
        'onUpdate:modelValue': (v: QueryDraft) => {
          model.value = v
          void wrapper.setProps({ modelValue: v })
        },
        onApply,
      },
    })
    return { model, onApply }
  }
  const fav = (params?: Record<string, string>) => ({
    id: '6f8c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f',
    name: 'By status',
    tags: [],
    query: { filter: { status: M('status') }, ...(params ? { params } : {}) },
    shared: false,
    mine: true,
    owner: null,
    updatedAt: '2026-10-28T00:00:00.000Z',
  })
  async function pick() {
    await flushPromises()
    button('Recent queries').click()
    await flushPromises()
    await settled()
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-favourites] button')]
      .find((b) => b.textContent?.includes('By status'))!
      .click()
    await flushPromises()
  }

  it('puts in its defaults and runs it filled in', async () => {
    const { model, onApply } = mountBar([fav({ status: 'paid' })])
    await pick()
    expect(model.value.filter).toBe('{ status: {{status}} }')
    expect(model.value.params).toEqual({ status: 'paid' })
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ filter: { status: 'paid' } }))
  })

  it('waits for a value where a parameter has none, its field focused', async () => {
    const { onApply } = mountBar([fav()])
    await pick()
    await flushPromises()
    expect(onApply).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(document.querySelector('[data-query-param="status"] input'))
  })
})

describe('the documents view with a template in the bar (Important 6, Minor 6)', () => {
  function mount(tab: string, draft: Partial<QueryDraft>, filter: Record<string, unknown>) {
    const api = mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
      [`POST ${PREFIX}/favourites`]: (body) => [
        201,
        { id: 'f1', mine: true, owner: null, updatedAt: '2026-10-28T00:00:00Z', ...(body as object) },
      ],
    })
    const state = useCollectionViewsStore().stateFor(tab)
    state.draft = { ...state.draft, ...draft }
    state.query = { filter, skip: 0, limit: 20 }
    const wrapper = mountApp(DocumentsView, {
      props: { target: T, tabId: tab, canWrite: true, isView: false },
    })
    return { ...api, state, wrapper }
  }
  const template = { filter: '{ status: {{status}}, qty: { $lt: 30 } }', params: { status: 'paid' } }
  const run = { status: 'paid', qty: { $lt: { $numberInt: '30' } } }

  it('adds a cell’s condition beside the parameters, keeping them', async () => {
    const { state, wrapper, calls } = mount('tab-f', template, run)
    await flushPromises()
    wrapper.wrapper.findComponent(DocumentTable).vm.$emit('filter-by', 'city', 'Izmir')
    await flushPromises()
    expect(state.draft.filter).toBe('{ status: {{status}}, qty: { $lt: 30 }, city: "Izmir" }')
    expect(finds(calls).at(-1)!.body).toMatchObject({ filter: { ...run, city: 'Izmir' } })
  })

  it('takes a removed chip’s condition out of the template, its parameters kept', async () => {
    const { state } = mount('tab-c', template, run)
    await flushPromises()
    const chips = [...document.querySelectorAll<HTMLElement>('[data-filter-chips] [data-chip]')]
    chips[1]!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect(state.draft.filter).toBe('{ status: {{status}} }')
    expect(state.query.filter).toEqual({ status: 'paid' })
  })

  it('saves the template from the query panel when its values make the query in use', async () => {
    const { calls } = mount('tab-p', template, run)
    await flushPromises()
    document
      .querySelector<HTMLButtonElement>(
        '[data-query-panel] button[aria-label="Save the query in use as a favourite"]',
      )!
      .click()
    await flushPromises()
    await settled()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const name = dialog.querySelector<HTMLInputElement>('input')!
    name.value = 'Template'
    name.dispatchEvent(new Event('input'))
    await flushPromises()
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    const saved = calls.find((c) => c.method === 'POST' && c.path.endsWith('/favourites'))!
    expect((saved.body as { query: unknown }).query).toEqual({
      filter: { status: M('status'), qty: { $lt: { $numberInt: '30' } } },
      params: { status: 'paid' },
    })
  })

  it('saves the query in use as it ran when the bar holds another', async () => {
    const { calls } = mount('tab-q', { ...template, params: { status: 'new' } }, run)
    await flushPromises()
    document
      .querySelector<HTMLButtonElement>(
        '[data-query-panel] button[aria-label="Save the query in use as a favourite"]',
      )!
      .click()
    await flushPromises()
    await settled()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const name = dialog.querySelector<HTMLInputElement>('input')!
    name.value = 'As run'
    name.dispatchEvent(new Event('input'))
    await flushPromises()
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    const saved = calls.find((c) => c.method === 'POST' && c.path.endsWith('/favourites'))!
    expect((saved.body as { query: unknown }).query).toEqual({ filter: run })
  })
})

describe('other readers of the filter text (Important 6)', () => {
  it('adds a schema condition beside the parameters', () => {
    expect(addCondition('{ status: {{status}} }', 'qty', { $gt: 1 })).toEqual({
      text: '{ status: {{status}}, qty: { $gt: 1 } }',
    })
  })

  it('leaves a template to the text: the filter builder says it cannot show it, and changes nothing', async () => {
    const model = { value: '{ status: {{status}} }' }
    mountApp(FilterBuilder, {
      props: { modelValue: model.value, 'onUpdate:modelValue': (v: string) => (model.value = v), fields: [] },
    })
    await flushPromises()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    expect(model.value).toBe('{ status: {{status}} }')
  })
})
