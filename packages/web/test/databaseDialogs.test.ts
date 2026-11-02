import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DatabaseCreateDialog from '../src/connections/DatabaseCreateDialog.vue'
import CollectionCreateDialog from '../src/connections/CollectionCreateDialog.vue'
import RenameCollectionDialog from '../src/connections/RenameCollectionDialog.vue'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, choose, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('database dialog', () => {
  it('creates a database with its first collection and opens it', async () => {
    const { calls } = mockApi({ 'POST connections/c1/databases': () => [201, { name: 'shop' }] })
    const { wrapper } = mountApp(DatabaseCreateDialog, { props: { connectionId: 'c1' } })
    await typeInto(byLabel('Database name'), 'shop')
    await typeInto(byLabel('First collection'), 'orders')
    button('Create').click()
    await flushPromises()
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: 'connections/c1/databases',
      body: { name: 'shop', collection: 'orders' },
    })
    expect(useTabsStore().active?.params).toEqual({ connectionId: 'c1', db: 'shop' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('shows the server’s field error', async () => {
    mockApi({
      'POST connections/c1/databases': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: [{ path: 'name', message: 'Invalid database name' }],
        },
      ],
    })
    mountApp(DatabaseCreateDialog, { props: { connectionId: 'c1' } })
    await typeInto(byLabel('Database name'), 'a b')
    await typeInto(byLabel('First collection'), 'x')
    button('Create').click()
    await flushPromises()
    expect(byLabel('Database name').getAttribute('aria-invalid')).toBe('true')
  })
})

describe('collection dialog', () => {
  it('creates a view from a pipeline parsed with the safe shell parser', async () => {
    const { calls } = mockApi({
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'orders', type: 'collection', options: {}, readOnly: false }],
      ],
      'POST connections/c1/databases/shop/collections': () => [201, { name: 'recent' }],
    })
    mountApp(CollectionCreateDialog, { props: { connectionId: 'c1', db: 'shop' } })
    await typeInto(byLabel('Collection name'), 'recent')
    await choose(byLabel<HTMLSelectElement>('Type'), 'view')
    await flushPromises()
    expect(byLabel<HTMLSelectElement>('Source collection').value).toBe('orders')
    await typeInto(
      byLabel<HTMLTextAreaElement>('Pipeline'),
      "[{ $match: { at: { $gte: ISODate('2026-01-01T00:00:00Z') } } }]",
    )
    button('Create').click()
    await flushPromises()
    // The last call is the collections refetch after the create; check the POST itself.
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      kind: 'view',
      name: 'recent',
      viewOn: 'orders',
      pipeline: [{ $match: { at: { $gte: { $date: { $numberLong: '1767225600000' } } } } }],
    })
    expect(useTabsStore().active?.params).toEqual({ connectionId: 'c1', db: 'shop', coll: 'recent' })
  })

  it('opens as a view of the aggregation builder pipeline, filled in (phase 2a)', async () => {
    const { calls } = mockApi({
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [
          { name: 'items', type: 'collection', options: {}, readOnly: false },
          { name: 'orders', type: 'collection', options: {}, readOnly: false },
        ],
      ],
      'POST connections/c1/databases/shop/collections': () => [201, { name: 'big' }],
    })
    mountApp(CollectionCreateDialog, {
      props: {
        connectionId: 'c1',
        db: 'shop',
        view: { viewOn: 'orders', pipeline: '[{ $match: { a: 1 } }]' },
      },
    })
    await flushPromises()
    expect(byLabel<HTMLSelectElement>('Type').value).toBe('view')
    expect(byLabel<HTMLSelectElement>('Source collection').value).toBe('orders')
    expect(byLabel<HTMLTextAreaElement>('Pipeline').value).toBe('[{ $match: { a: 1 } }]')
    await typeInto(byLabel('Collection name'), 'big')
    button('Create').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      kind: 'view',
      name: 'big',
      viewOn: 'orders',
      pipeline: [{ $match: { a: { $numberInt: '1' } } }],
    })
  })

  it('refuses an invalid pipeline without calling the server', async () => {
    const { calls } = mockApi({ 'GET connections/c1/databases/shop/collections': () => [200, []] })
    mountApp(CollectionCreateDialog, { props: { connectionId: 'c1', db: 'shop' } })
    await typeInto(byLabel('Collection name'), 'v')
    await choose(byLabel<HTMLSelectElement>('Type'), 'view')
    await typeInto(byLabel<HTMLTextAreaElement>('Pipeline'), '[{ $match: { a: this.constructor } }]')
    button('Create').click()
    await flushPromises()
    expect(byLabel<HTMLTextAreaElement>('Pipeline').getAttribute('aria-invalid')).toBe('true')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('creates capped and time series collections with typed numbers', async () => {
    const { calls } = mockApi({
      'POST connections/c1/databases/shop/collections': () => [201, { name: 'x' }],
    })
    mountApp(CollectionCreateDialog, { props: { connectionId: 'c1', db: 'shop' } })
    await typeInto(byLabel('Collection name'), 'log')
    await choose(byLabel<HTMLSelectElement>('Type'), 'capped')
    await typeInto(byLabel('Maximum size (bytes)'), '4096')
    await typeInto(byLabel('Maximum documents'), '10')
    button('Create').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual({ kind: 'capped', name: 'log', size: 4096, max: 10 })
  })

  it('creates a time series collection', async () => {
    const { calls } = mockApi({
      'POST connections/c1/databases/shop/collections': () => [201, { name: 'x' }],
    })
    mountApp(CollectionCreateDialog, { props: { connectionId: 'c1', db: 'shop' } })
    await typeInto(byLabel('Collection name'), 'metrics')
    await choose(byLabel<HTMLSelectElement>('Type'), 'timeseries')
    await typeInto(byLabel('Time field'), 'ts')
    await typeInto(byLabel('Meta field'), 'host')
    await choose(byLabel<HTMLSelectElement>('Granularity'), 'minutes')
    button('Create').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual({
      kind: 'timeseries',
      name: 'metrics',
      timeField: 'ts',
      metaField: 'host',
      granularity: 'minutes',
    })
  })
})

/** W2.4 (2026-10-16): a default collation and change-stream pre/post images when a collection is made. */
describe('collection dialog: collation and pre/post images', () => {
  it('sends a default collation and pre/post images when asked for, and nothing otherwise', async () => {
    const { calls } = mockApi({
      'POST connections/c1/databases/shop/collections': () => [201, { name: 'x' }],
    })
    mountApp(CollectionCreateDialog, { props: { connectionId: 'c1', db: 'shop' } })
    await typeInto(byLabel('Collection name'), 'people')
    button('Create').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual({ kind: 'collection', name: 'people', clustered: false })
    await check(byLabel('Use a default collation'))
    await choose(byLabel<HTMLSelectElement>('Locale'), 'tr')
    await choose(byLabel<HTMLSelectElement>('Strength'), '2')
    await check(byLabel('Numeric ordering ("10" after "9")'))
    await check(byLabel('Change-stream pre- and post-images'))
    button('Create').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual({
      kind: 'collection',
      name: 'people',
      clustered: false,
      collation: { locale: 'tr', strength: 2, numericOrdering: true },
      changeStreamPreAndPostImages: true,
    })
  })

  it('offers no pre/post images for a time series or a view, and a collation for a view', async () => {
    mockApi({ 'GET connections/c1/databases/shop/collections': () => [200, [{ name: 'orders' }]] })
    mountApp(CollectionCreateDialog, { props: { connectionId: 'c1', db: 'shop' } })
    await choose(byLabel<HTMLSelectElement>('Type'), 'timeseries')
    expect(() => byLabel('Change-stream pre- and post-images')).toThrow()
    await choose(byLabel<HTMLSelectElement>('Type'), 'view')
    expect(() => byLabel('Change-stream pre- and post-images')).toThrow()
    expect(byLabel('Use a default collation')).toBeTruthy()
  })
})

describe('rename dialog', () => {
  it('renames and moves an open tab to the new name', async () => {
    const { calls } = mockApi({
      'POST connections/c1/databases/shop/collections/old/rename': () => [200, { name: 'new' }],
    })
    const tabs = useTabsStore()
    tabs.open({
      kind: 'collection',
      title: 'shop.old',
      params: { connectionId: 'c1', db: 'shop', coll: 'old' },
    })
    mountApp(RenameCollectionDialog, { props: { connectionId: 'c1', db: 'shop', coll: 'old' } })
    expect(byLabel('New name').value).toBe('old')
    await typeInto(byLabel('New name'), 'new')
    button('Rename').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual({ to: 'new' })
    expect(tabs.tabs.map((t) => t.title)).toEqual(['shop.new'])
  })

  // Review of the web fixes (minor 2): what was read under either name — pages, counts, indexes —
  // was shown again for a new collection of that name.
  it('forgets what it read under the old name and the new one', async () => {
    mockApi({ 'POST connections/c1/databases/shop/collections/old/rename': () => [200, { name: 'new' }] })
    const { queryClient } = mountApp(RenameCollectionDialog, {
      props: { connectionId: 'c1', db: 'shop', coll: 'old' },
    })
    const key = (coll: string) => ['connections', 'c1', 'databases', 'shop', 'collections', coll]
    queryClient.setQueryData([...key('old'), 'documents', 'page', {}], { documents: [] })
    queryClient.setQueryData([...key('new'), 'indexes'], [])
    await typeInto(byLabel('New name'), 'new')
    button('Rename').click()
    await flushPromises()
    expect(queryClient.getQueryCache().findAll({ queryKey: key('old') })).toEqual([])
    expect(queryClient.getQueryCache().findAll({ queryKey: key('new') })).toEqual([])
  })

  // Tab groups review 2026-10-12 (minor 18): the renamed tab moved to the end and was shown — its
  // group opened, the user taken away from where they were.
  it('renames the tab in its place, the tab in use staying in use', async () => {
    mockApi({ 'POST connections/c1/databases/shop/collections/old/rename': () => [200, { name: 'new' }] })
    const tabs = useTabsStore()
    const coll = (name: string) => ({
      kind: 'collection',
      title: `shop.${name}`,
      params: { connectionId: 'c1', db: 'shop', coll: name },
    })
    tabs.open(coll('old'))
    tabs.open(coll('other'))
    const jobs = tabs.open({ kind: 'jobs', title: 'Jobs' })
    mountApp(RenameCollectionDialog, { props: { connectionId: 'c1', db: 'shop', coll: 'old' } })
    await typeInto(byLabel('New name'), 'new')
    button('Rename').click()
    await flushPromises()
    expect(tabs.tabs.map((t) => t.title)).toEqual(['shop.new', 'shop.other', 'Jobs'])
    expect(tabs.activeId).toBe(jobs)
  })

  // Plugin pages review I4 (2026-10-10): a plugin page on it goes on with the new name.
  it('moves a plugin page on the renamed collection to the new name', async () => {
    mockApi({ 'POST connections/c1/databases/shop/collections/old/rename': () => [200, { name: 'new' }] })
    const tabs = useTabsStore()
    tabs.open({
      kind: 'pluginPage',
      title: '',
      params: { plugin: 'p', contribution: 'c', connectionId: 'c1', db: 'shop', coll: 'old' },
    })
    mountApp(RenameCollectionDialog, { props: { connectionId: 'c1', db: 'shop', coll: 'old' } })
    await typeInto(byLabel('New name'), 'new')
    button('Rename').click()
    await flushPromises()
    expect(tabs.tabs.find((t) => t.kind === 'pluginPage')!.params).toMatchObject({ coll: 'new' })
  })
})

describe('creating a collection a tab asked for (user review 2026-10-09)', () => {
  it('starts with the name the missing collection’s tab had', async () => {
    mockApi({ 'GET connections/c1/databases/shop/collections': () => [200, []] })
    mountApp(CollectionCreateDialog, { props: { connectionId: 'c1', db: 'shop', name: 'ordersssss' } })
    await flushPromises()
    expect(byLabel<HTMLInputElement>('Collection name').value).toBe('ordersssss')
  })
})
