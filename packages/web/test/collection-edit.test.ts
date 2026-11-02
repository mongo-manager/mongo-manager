import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import CollectionEditDialog from '../src/connections/CollectionEditDialog.vue'
import AggregationView from '../src/aggregation/AggregationView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { editViewPipeline } from '../src/aggregation/viewEdit'
import { newCard } from '../src/aggregation/stages'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useTabsStore } from '../src/stores/tabs'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, check } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const COLLS = 'connections/c1/databases/shop/collections'
const confirm = () => (document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
const confirmDialog = () =>
  document.querySelector('[data-test="confirm"]')!.closest('[role="dialog"], [role="alertdialog"]')!
const t = (key: string, values?: Record<string, unknown>) => i18n.global.t(key, values ?? {})

/** W2.4 (2026-10-16): Edit collection turns change-stream pre/post images on or off. */
describe('Edit collection', () => {
  function open(options: Record<string, unknown>) {
    const api = mockApi({
      [`GET ${COLLS}`]: () => [200, [{ name: 'orders', type: 'collection', options, readOnly: false }]],
      [`PATCH ${COLLS}/orders/options`]: (body) => [
        200,
        {
          changeStreamPreAndPostImages: (body as { changeStreamPreAndPostImages: boolean })
            .changeStreamPreAndPostImages,
        },
      ],
    })
    const mounted = mountApp(CollectionEditDialog, {
      props: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    mountApp(DialogHost)
    return { ...api, ...mounted }
  }

  it('turns the images on after a confirmation naming the collection, and shows the collation', async () => {
    const { calls, wrapper } = open({ collation: { locale: 'tr', strength: { $numberInt: '2' } } })
    await flushPromises()
    expect(document.querySelector('[data-collation-shown]')!.textContent).toContain('tr')
    expect(document.querySelector('[data-collation-shown]')!.textContent).toContain('strength 2')
    const toggle = document.querySelector('input[role="switch"]') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    await check(toggle)
    button('Save').click()
    await flushPromises()
    expect(confirmDialog().textContent).toContain(
      'From now on, MongoDB keeps each changed document of orders',
    )
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
    confirm()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      changeStreamPreAndPostImages: true,
      confirm: 'orders',
    })
    expect(useToastStore().toasts.at(-1)?.message).toBe('Pre- and post-images are on for orders.')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('starts from what the collection has, and sends nothing when nothing changed', async () => {
    const { calls, wrapper } = open({ changeStreamPreAndPostImages: { enabled: true } })
    await flushPromises()
    expect((document.querySelector('input[role="switch"]') as HTMLInputElement).checked).toBe(true)
    expect(document.querySelector('[data-collation-shown]')!.textContent).toContain('None')
    button('Save').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

/** W2.2 (2026-10-16): a view's pipeline is edited in its source's aggregation builder. */
/** W2.2 (2026-10-16): a view's pipeline is edited in its source's aggregation builder. */
describe("editing a view's pipeline", () => {
  const VIEW = { connectionId: 'c1', db: 'shop', name: 'bigOrders' }
  const PIPELINE = [
    { $match: { qty: { $gt: { $numberInt: '10' } } } },
    { $project: { qty: { $numberInt: '1' } } },
  ]
  /** The view's definition as the server reads it to edit (re-review minor 3: with its types). */
  const definition = (pipeline: unknown[] = PIPELINE) => ({
    [`GET ${COLLS}/bigOrders/view`]: (): [number, unknown] => [200, { viewOn: 'orders', pipeline }],
  })
  const PREVIEW = {
    'POST connections/c1/databases/shop/collections/orders/aggregate/preview': (): [number, unknown] => [
      200,
      { sample: null, stages: [] },
    ],
  }

  it('opens the pipeline in the source collection’s builder, marked as the view’s', async () => {
    mockApi(definition())
    expect(await editViewPipeline(VIEW, t)).toBe(true)
    const tabs = useTabsStore()
    expect(tabs.active?.params).toEqual({ connectionId: 'c1', db: 'shop', coll: 'orders' })
    const state = useCollectionViewsStore().stateFor(tabs.active!.id)
    expect(state.section).toBe('aggregations')
    expect(state.aggregation.cards.map((c) => c.operator)).toEqual(['$match', '$project'])
    expect(state.aggregation.editingView).toEqual({
      name: 'bigOrders',
      base: { viewOn: 'orders', pipeline: PIPELINE },
    })
  })

  it('never opens a pipeline with a stage it cannot read: saving it would drop that stage', async () => {
    mockApi(definition([{ $match: {} }, { bad: 1, worse: 2 }]))
    expect(await editViewPipeline(VIEW, t)).toBe(false)
    expect(useTabsStore().tabs.filter((tab) => tab.kind === 'collection')).toHaveLength(0)
    expect(useToastStore().toasts.at(-1)?.message).toContain('bigOrders')
  })

  it('asks before replacing stages already in the builder', async () => {
    mockApi(definition())
    mountApp(DialogHost)
    const tabs = useTabsStore()
    const tabId = tabs.open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    useCollectionViewsStore().stateFor(tabId).aggregation.cards = [newCard('$limit')]
    const pending = editViewPipeline(VIEW, t)
    await flushPromises()
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    expect(await pending).toBe(false)
    expect(
      useCollectionViewsStore()
        .stateFor(tabId)
        .aggregation.cards.map((c) => c.operator),
    ).toEqual(['$limit'])
  })

  it('updates the view after a confirmation naming it, with the enabled stages', async () => {
    const { calls } = mockApi({
      ...definition(),
      ...PREVIEW,
      [`PUT ${COLLS}/bigOrders/view`]: () => [200, { name: 'bigOrders', viewOn: 'orders' }],
      'GET connections': () => [200, [{ id: 'c1', permissions: [...PERMISSIONS] }]],
    })
    await editViewPipeline(VIEW, t)
    const tabId = useTabsStore().active!.id
    const agg = useCollectionViewsStore().stateFor(tabId).aggregation
    agg.cards[1]!.enabled = false
    mountApp(AggregationView, {
      props: {
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
        tabId,
        canWrite: true,
        canWriteDatabase: true,
      },
    })
    mountApp(DialogHost)
    await flushPromises()
    const banner = document.querySelector('[data-editing-view]')!
    expect(banner.textContent).toContain('bigOrders')
    button('Update view').click()
    await flushPromises()
    const dialog = confirmDialog()
    expect(dialog.textContent).toContain('Update the view bigOrders?')
    expect(dialog.textContent).toContain('The disabled stage is left out.')
    confirm()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      viewOn: 'orders',
      pipeline: [{ $match: { qty: { $gt: { $numberInt: '10' } } } }],
      confirm: 'bigOrders',
      base: { viewOn: 'orders', pipeline: PIPELINE },
    })
    expect(agg.editingView).toBeNull()
    expect(useToastStore().toasts.at(-1)?.message).toBe('The view bigOrders was updated.')
  })

  // Re-review (minor 3): a double stays a double and a Long a Long, read and written back.
  it('writes back a double and a Long as they were read', async () => {
    const typed = [{ $match: { d: { $numberDouble: '1.0' }, l: { $numberLong: '5' } } }]
    const { calls } = mockApi({
      ...definition(typed),
      ...PREVIEW,
      [`PUT ${COLLS}/bigOrders/view`]: () => [200, { name: 'bigOrders', viewOn: 'orders' }],
    })
    await editViewPipeline(VIEW, t)
    const tabId = useTabsStore().active!.id
    mountApp(AggregationView, {
      props: {
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
        tabId,
        canWrite: true,
        canWriteDatabase: true,
      },
    })
    mountApp(DialogHost)
    await flushPromises()
    button('Update view').click()
    await flushPromises()
    confirm()
    await flushPromises()
    const put = calls.find((c) => c.method === 'PUT')!.body as { pipeline: unknown; base: unknown }
    expect(put.pipeline).toEqual(typed)
    expect(put.base).toEqual({ viewOn: 'orders', pipeline: typed })
  })

  // W2 review (I1): a view changed since the edit began is not overwritten; the page offers to load it.
  it('says the view changed meanwhile, and loads the definition there is now when asked', async () => {
    const now = [{ $limit: { $numberInt: '5' } }]
    let reads = 0
    mockApi({
      [`GET ${COLLS}/bigOrders/view`]: () => [200, { viewOn: 'orders', pipeline: reads++ ? now : PIPELINE }],
      ...PREVIEW,
      [`PUT ${COLLS}/bigOrders/view`]: () => [
        409,
        { code: 'CONFLICT', message: 'changed', details: { reason: 'view_changed' } },
      ],
    })
    await editViewPipeline(VIEW, t)
    const tabId = useTabsStore().active!.id
    const agg = useCollectionViewsStore().stateFor(tabId).aggregation
    mountApp(AggregationView, {
      props: {
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
        tabId,
        canWrite: true,
        canWriteDatabase: true,
      },
    })
    mountApp(DialogHost)
    await flushPromises()
    button('Update view').click()
    await flushPromises()
    confirm()
    await flushPromises()
    expect(confirmDialog().textContent).toContain('was changed since you began')
    confirm()
    await flushPromises()
    expect(agg.cards.map((c) => c.operator)).toEqual(['$limit'])
    expect(agg.editingView).toEqual({ name: 'bigOrders', base: { viewOn: 'orders', pipeline: now } })
  })

  it('offers no update to someone who may not change views', async () => {
    mockApi(definition())
    await editViewPipeline(VIEW, t)
    const tabId = useTabsStore().active!.id
    mountApp(AggregationView, {
      props: { target: { connectionId: 'c1', db: 'shop', coll: 'orders' }, tabId, canWrite: true },
    })
    await flushPromises()
    expect(document.querySelector('[data-editing-view]')!.textContent).toContain(
      'You may not change views on this connection.',
    )
    expect(() => button('Update view')).toThrow()
  })
})
