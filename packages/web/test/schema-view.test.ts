// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { SchemaAnalyser, PERMISSIONS } from '@mongo-manager/shared'
import SchemaView from '../src/schema/SchemaView.vue'
import CollectionOverview from '../src/workspace/tabs/CollectionOverview.vue'
import { i18n } from '../src/i18n'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, chartOptions, pick } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const BASE = 'connections/c1/databases/shop/collections/orders'

function analysis(truncated = false) {
  const a = new SchemaAnalyser()
  for (let i = 0; i < 10; i++) a.add(i % 2 ? { name: 'Ada', qty: i } : { name: i < 4 ? 'Ada' : 'Bob' })
  return { ...a.result(), truncated }
}

const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }

describe('the Schema tab (phase 1i spec §7)', () => {
  it('analyses a sample of the chosen size and shows each field with presence and types', async () => {
    const { calls } = mockApi({ [`POST ${BASE}/schema`]: () => [200, analysis()] })
    mountApp(SchemaView, { props: { target } })
    await flushPromises()
    const size = byLabel<HTMLSelectElement>('Sample size')
    size.value = '100'
    size.dispatchEvent(new Event('change'))
    button('Analyse').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ sampleSize: 100 })
    const row = (path: string) => document.querySelector(`[data-field="${path}"]`)!
    expect(row('name').textContent).toContain('100%')
    expect(row('qty').textContent).toContain('50%')
    expect(row('qty').textContent).toContain('int')
    expect(document.body.textContent).toContain('10 documents sampled')
  })

  it('opens a field for its histogram or its most common values', async () => {
    mockApi({ [`POST ${BASE}/schema`]: () => [200, analysis()] })
    mountApp(SchemaView, { props: { target } })
    await flushPromises()
    button('Analyse').click()
    await flushPromises()
    ;(document.querySelector('[data-field="qty"] button[aria-expanded]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelectorAll('[data-field="qty"] [data-schema-bar]').length).toBe(10)
    ;(document.querySelector('[data-field="name"] button[aria-expanded]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-field="name"]')!.textContent).toContain('Ada')
  })

  it('shows a hidden personal path with a lock and no details (phase 3c §7)', async () => {
    const hidden = {
      sampled: 2,
      truncated: false,
      fields: [{ path: 'email', keys: ['email'], count: 2, types: {}, masked: true }],
    }
    mockApi({ [`POST ${BASE}/schema`]: () => [200, hidden] })
    mountApp(SchemaView, { props: { target } })
    await flushPromises()
    button('Analyse').click()
    await flushPromises()
    const row = document.querySelector('[data-field="email"]')!
    expect(row.querySelector('[data-schema-masked]')!.textContent).toContain('Personal data')
    ;(row.querySelector('button[aria-expanded]') as HTMLButtonElement).click()
    await flushPromises()
    expect(row.querySelector('[data-echarts]')).toBeNull()
    expect(row.textContent).not.toContain('No details')
  })

  it('says when there were more fields than it tracks', async () => {
    mockApi({ [`POST ${BASE}/schema`]: () => [200, analysis(true)] })
    mountApp(SchemaView, { props: { target } })
    await flushPromises()
    button('Analyse').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Only the first 500 fields are shown.')
  })

  it('exports the schema as Mongoose, JSON Schema or TypeScript, to copy or download', async () => {
    mockApi({ [`POST ${BASE}/schema`]: () => [200, analysis()] })
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => (created.push(b as Blob), 'blob:x'))
    const clicks: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download)
    })
    mountApp(SchemaView, { props: { target } })
    await flushPromises()
    button('Analyse').click()
    await flushPromises()
    button('Export').click()
    // The dialog is loaded on demand.
    await vi.waitFor(() => expect(() => byLabel('Format')).not.toThrow())
    const format = byLabel<HTMLSelectElement>('Format')
    format.value = 'mongoose'
    format.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(document.querySelector('[role="dialog"] pre')!.textContent).toContain(
      'export const OrdersSchema = new Schema(',
    )
    button('Copy').click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('new Schema('))
    button('Download').click()
    format.value = 'jsonSchema'
    format.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(document.querySelector('[role="dialog"] pre')!.textContent).toContain('"bsonType": "object"')
    button('Download').click()
    format.value = 'typescript'
    format.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(document.querySelector('[role="dialog"] pre')!.textContent).toContain('export interface Orders')
    button('Download').click()
    // Plugins wave 1: Pydantic, Go and C# from the same analysis.
    for (const [value, text] of [
      ['pydantic', 'class Orders(BaseModel):'],
      ['go', 'type Orders struct {'],
      ['csharp', 'public class Orders'],
    ] as const) {
      format.value = value
      format.dispatchEvent(new Event('change'))
      await flushPromises()
      expect(document.querySelector('[role="dialog"] pre')!.textContent, value).toContain(text)
      button('Download').click()
    }
    expect(clicks).toEqual([
      'orders.model.js',
      'orders.schema.json',
      'orders.ts',
      'orders_model.py',
      'orders_model.go',
      'Orders.cs',
    ])
    expect(await created[0]!.text()).toContain('new Schema(')
  })
})

/** W2 (2026-10-16): a click on a value, a range, a type or a map area filters the Documents. */
describe('the Schema tab filters the documents', () => {
  const TAB = 'tab-schema'
  async function opened(fields: Array<Record<string, unknown>>, path: string) {
    const a = new SchemaAnalyser()
    for (const d of fields) a.add(d)
    mockApi({ [`POST ${BASE}/schema`]: () => [200, a.result()] })
    mountApp(SchemaView, { props: { target, tabId: TAB } })
    await flushPromises()
    button('Analyse').click()
    await flushPromises()
    ;(document.querySelector(`[data-field="${path}"] button[aria-expanded]`) as HTMLButtonElement).click()
    await flushPromises()
    return useCollectionViewsStore().stateFor(TAB)
  }
  const bar = (path: string, label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(`[data-field="${path}"] [data-schema-bar] button`)].find(
      (b) => b.textContent!.includes(label),
    )!

  it('adds a most common value to the filter typed so far, runs it and shows the documents', async () => {
    const state = await opened([{ name: 'Ada' }, { name: 'Ada' }, { name: 'Bob' }], 'name')
    state.draft.filter = '{ qty: { $gt: 1 } }'
    state.section = 'schema'
    bar('name', 'Ada').click()
    await flushPromises()
    expect(state.draft.filter).toBe('{ qty: { $gt: 1 }, name: "Ada" }')
    expect(state.query.filter).toEqual({ qty: { $gt: { $numberInt: '1' } }, name: 'Ada' })
    expect(state.page).toBe(0)
    expect(state.section).toBe('documents')
  })

  it('adds a histogram range and a type, in canonical EJSON', async () => {
    const state = await opened(
      Array.from({ length: 10 }, (_, i) => ({ qty: i * 10, at: new Date(Date.UTC(2026, 0, 1 + i)) })),
      'qty',
    )
    bar('qty', '0 – 9').click()
    await flushPromises()
    expect(state.query.filter).toEqual({ qty: { $gte: { $numberInt: '0' }, $lt: { $numberInt: '9' } } })
    ;(document.querySelector('[data-field="at"] button[aria-expanded]') as HTMLButtonElement).click()
    await flushPromises()
    const types = [...document.querySelectorAll<HTMLButtonElement>('[data-field="at"] [data-schema-type]')]
    types[0]!.click()
    await flushPromises()
    expect(state.query.filter).toEqual({
      qty: { $gte: { $numberInt: '0' }, $lt: { $numberInt: '9' } },
      at: { $type: 'date' },
    })
  })

  // W2 review (minor 13): a type is named as people say it, in their language, not as BSON spells it.
  it('names each type in words, in Turkish too', async () => {
    await opened([{ at: new Date(), ok: true }], 'at')
    i18n.global.locale.value = 'tr'
    await flushPromises()
    const chip = document.querySelector('[data-field="at"] [data-schema-type]')!
    expect(chip.textContent).toContain('Tarih')
    expect(chip.getAttribute('aria-label')).toBe('at alanı Tarih olan belgeleri süz')
    ;(document.querySelector('[data-field="ok"] button[aria-expanded]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-field="ok"] [data-schema-type]')!.textContent).toContain('Mantıksal')
  })

  it('offers no filter for a value cut short, nor for a field no path can name', async () => {
    await opened([{ long: 'x'.repeat(150), 'a.b': 'dotted' }], 'long')
    expect(document.querySelectorAll('[data-field="long"] [data-schema-bar] button')).toHaveLength(0)
    expect(document.querySelectorAll('[data-field="long"] [data-schema-bar]')).toHaveLength(1)
    ;(document.querySelector('[data-field="a.b"] button[aria-expanded]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelectorAll('[data-field="a.b"] [data-schema-bar] button')).toHaveLength(0)
    expect(document.querySelectorAll('[data-field="a.b"] button[data-schema-type]')).toHaveLength(0)
  })

  it('shows the places on an offline map, and filters to the area in view', async () => {
    const state = await opened(
      [{ at: { type: 'Point', coordinates: [29, 41] } }, { at: { type: 'Point', coordinates: [28, 40] } }],
      'at',
    )
    const map = await vi.waitFor(() => {
      const m = document.querySelector('[data-field="at"] [data-geo-map]')
      if (!m) throw new Error('no map yet')
      return m
    })
    expect(map.querySelectorAll('[data-geo-points] circle')).toHaveLength(2)
    expect(map.querySelector('svg[tabindex="0"] > path')!.getAttribute('d')!.length).toBeGreaterThan(1000)
    // Offline: no image, no tile, no request beyond the analysis (and, W5, the app's own masking hint).
    expect(map.querySelector('image, img')).toBeNull()
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map(([url]) => new URL(String(url)).pathname)
        .filter((p) => !p.endsWith('/personal-fields/applied')),
    ).toEqual([`/api/${BASE}/schema`])
    expect(
      vi.mocked(fetch).mock.calls.every(([url]) => new URL(String(url)).origin === window.location.origin),
    ).toBe(true)
    ;[...map.querySelectorAll('button')].find((b) => b.textContent!.includes('Filter to this area'))!.click()
    await flushPromises()
    const within = (state.query.filter as { at: { $geoWithin: { $geometry: { type: string } } } }).at
    expect(within.$geoWithin.$geometry.type).toBe('Polygon')
    expect(state.section).toBe('documents')
  })

  it('never draws a masked field: it has no places, values or types to click', async () => {
    mockApi({
      [`POST ${BASE}/schema`]: () => [
        200,
        {
          sampled: 2,
          truncated: false,
          fields: [{ path: 'home', keys: ['home'], count: 2, types: {}, masked: true }],
        },
      ],
    })
    mountApp(SchemaView, { props: { target, tabId: TAB } })
    await flushPromises()
    button('Analyse').click()
    await flushPromises()
    ;(document.querySelector('[data-field="home"] button[aria-expanded]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-field="home"] [data-geo-map]')).toBeNull()
    expect(document.querySelector('[data-field="home"] [data-schema-bar]')).toBeNull()
  })
})

describe('charts on the collection overview (phase 1i spec §7)', () => {
  it('shows data against index size, each index size, and index use', async () => {
    mockApi({
      connections: () => [200, []],
      'GET connections': () => [200, [{ id: 'c1', permissions: [...PERMISSIONS] }]],
      [`GET ${BASE}/stats`]: () => [
        200,
        {
          count: 10,
          size: 4000,
          storageSize: 8192,
          avgObjSize: 400,
          totalIndexSize: 1000,
          nindexes: 2,
          capped: false,
          indexSizes: { _id_: 600, name_1: 400 },
        },
      ],
      [`GET ${BASE}/indexes`]: () => [
        200,
        [
          { name: '_id_', key: {}, options: {}, usage: { ops: 12, since: '2026-09-01T00:00:00Z' } },
          { name: 'name_1', key: {}, options: {}, usage: { ops: 3, since: '2026-09-01T00:00:00Z' } },
        ],
      ],
    })
    mountApp(CollectionOverview, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    const captions = [...document.querySelectorAll('figcaption')].map((c) => c.textContent)
    expect(captions).toEqual(['Data and indexes', 'Size of each index', 'Index use since the server started'])
    const bars = chartOptions().map((c) => (pick(c.option, 'series.0.data') as unknown[]).length)
    expect(bars).toEqual([2, 2, 2])
  })
})
