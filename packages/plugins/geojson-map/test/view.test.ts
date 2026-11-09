// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Accent, CellsAnswer, PluginClient, PluginContext } from '../../kit/src/client'
import { mount } from '../src/view'

const flush = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush()
}

type Handlers = Record<string, (params: unknown) => unknown>

function fakeClient(
  place: PluginContext['place'],
  handlers: Handlers,
  o: { kind?: string; settings?: Record<string, string> } = {},
) {
  const calls: Array<{ method: string; params: unknown }> = []
  let ready: (() => void) | null = null
  let cells: CellsAnswer | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: o.kind ?? 'collectionTab', id: o.kind === 'documentAction' ? 'show' : 'map' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'context.get')
        return {
          plugin: { id: 'geojson-map', version: '1' },
          contribution: { kind: o.kind ?? 'collectionTab', id: 'map' },
          locale: 'en',
          theme: 'light',
          accent: 'ocean',
          place,
          settings: o.settings ?? {},
        } as T
      return (await handlers[method]!(params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: (fn) => (cells = fn),
  }
  return { client, calls, greet: () => ready!(), contexts, cells: () => cells }
}

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const CITIES = [
  ['Izmir', 27.14, 38.42],
  ['Ankara', 32.85, 39.93],
  ['Istanbul', 28.98, 41.01],
  ['Bursa', 29.06, 40.19],
] as const
/** The review data: 60 orders, 15 around each of 4 cities. */
const ORDERS = Array.from({ length: 60 }, (_, i) => {
  const [city, lng, lat] = CITIES[i % 4]!
  return {
    _id: { $oid: `65a1b2c3d4e5f6071829${String(1000 + i).padStart(4, '0')}` },
    orderNo: { $numberInt: String(1000 + i) },
    city,
    status: i === 0 ? '<img src=x onerror=alert(1)>' : 'paid',
    location: {
      type: 'Point',
      coordinates: [
        { $numberDouble: String(lng + (i % 5) / 50) },
        { $numberDouble: String(lat + (i % 3) / 50) },
      ],
    },
  }
})
const find = (documents: unknown[]) => ({
  'documents.find': () => ({ documents, hasMore: false }),
})

const app = () => document.getElementById('app')!
const map = () => document.getElementById('map')!
const zoom = () => Number(map().dataset.zoom)
const clusters = () => [...document.querySelectorAll<SVGGElement>('.gm-cluster')]
const points = () => [...document.querySelectorAll<SVGGElement>('.gm-marker')]
const tap = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
const counts = () => clusters().map((c) => c.querySelector('.gm-count')!.textContent)
/** What a mark says on hover: its SVG title. */
const tip = (el: Element) => el.querySelector(':scope > title')!.textContent

async function mounted(
  handlers: Handlers,
  o: Parameters<typeof fakeClient>[2] = {},
  place: PluginContext['place'] = PLACE,
) {
  const f = fakeClient(place, handlers, o)
  mount(app(), f.client)
  f.greet()
  await settle()
  return f
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('the map, redesigned (plugin tabs redesign §2.5)', () => {
  it('says what it shows: the collection, documents and shapes, and the field the places are in', async () => {
    await mounted(find(ORDERS))
    expect(document.querySelector('h1')!.textContent).toBe('Map')
    expect(document.querySelector('.mm-head-desc')!.textContent).toContain('orders')
    expect(document.getElementById('status')!.textContent).toBe('60 shapes in 60 documents')
    expect(document.getElementById('field-chip')!.textContent).toBe('location')
    // One field: no picker.
    expect(document.getElementById('field')!.hidden).toBe(true)
  })

  it('draws places close together as one circle with their count', async () => {
    await mounted(find(ORDERS))
    expect(counts()).toEqual(['15', '15', '15', '15'])
    expect(tip(clusters()[0]!)).toBe('15 places here: zoom in')
  })

  it('zooms into a circle that is clicked, until its places stand apart', async () => {
    await mounted(find(ORDERS))
    const before = zoom()
    tap(clusters()[0]!)
    expect(zoom()).toBeGreaterThan(before + 3)
    expect(points().length).toBe(15)
    expect(document.querySelector('.gm-pop')).toBeNull()
  })

  it('shows a place’s document in a small card, as text only, with Open', async () => {
    const opened = vi.fn(() => true)
    await mounted({ ...find(ORDERS), 'ui.openDocument': opened })
    tap(clusters()[0]!)
    const first = points().find((p) => p.dataset.items === '0')!
    tap(first)
    const pop = document.querySelector('.gm-pop')!
    expect(pop.textContent).toContain('65a1b2c3d4e5f60718291000')
    expect(pop.textContent).toContain('orderNo')
    expect(pop.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector<SVGGElement>('.gm-marker.gm-selected')!.dataset.items).toBe('0')
    ;[...pop.querySelectorAll('button')].find((b) => b.textContent === 'Open')!.click()
    await flush()
    expect(opened).toHaveBeenCalledWith({ id: ORDERS[0]!._id })
    // Escape puts it away.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('.gm-pop')).toBeNull()
  })

  it('lists the documents of a circle that cannot split (the same spot)', async () => {
    const same = Array.from({ length: 12 }, (_, i) => ({ _id: i, name: `Shop ${i}`, loc: [29, 41] }))
    await mounted(find(same))
    expect(counts()).toEqual(['12'])
    tap(clusters()[0]!)
    const pop = document.querySelector('.gm-pop')!
    expect(pop.textContent).toContain('12 places at this spot')
    expect(pop.textContent).toContain('Shop 0')
    expect(pop.textContent).toContain('+4 more')
    // Focus in the card, on Close; a document of the list moves it to that one's Open.
    expect(document.activeElement).toBe(pop.querySelector('[aria-label="Close"]'))
    pop.querySelector<HTMLButtonElement>('button.gm-link')!.click()
    const one = document.querySelector('.gm-pop')!
    expect(one.textContent).toContain('Shop 0')
    expect(document.activeElement).toBe(
      [...one.querySelectorAll('button')].find((b) => b.textContent === 'Open'),
    )
  })

  it('fits, zooms in and out from the header, within the limits', async () => {
    await mounted(find(ORDERS))
    const fitted = zoom()
    const zoomIn = document.getElementById('zoom-in') as HTMLButtonElement
    const zoomOut = document.getElementById('zoom-out') as HTMLButtonElement
    // Whole steps, where tiles are sharp.
    zoomIn.click()
    expect(zoom()).toBe(Math.floor(fitted) + 1)
    zoomOut.click()
    zoomOut.click()
    expect(zoom()).toBe(Math.floor(fitted) - 1)
    ;(document.getElementById('fit') as HTMLButtonElement).click()
    expect(zoom()).toBe(fitted)
    for (let i = 0; i < 20; i++) zoomIn.click()
    expect(zoom()).toBe(19)
    expect(zoomIn.disabled).toBe(true)
  })

  it('fits the places above the no-tiles note, never under it', async () => {
    await mounted(find(ORDERS))
    Object.defineProperty(document.getElementById('no-tiles')!, 'offsetHeight', { value: 120 })
    ;(document.getElementById('fit') as HTMLButtonElement).click()
    const shift = /translate\(([-\d.]+) ([-\d.]+)\)/
    const [, , dy] = shift.exec(document.querySelector('.gm-content')!.getAttribute('transform')!)!
    const ys = clusters().map((c) => Number(shift.exec(c.getAttribute('transform')!)![2]) + Number(dy))
    // The default frame is 480 px tall: the note takes its bottom 132 px.
    expect(Math.max(...ys)).toBeLessThanOrEqual(480 - 132)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
  })

  it('moves and zooms from the keyboard, within the same limits', async () => {
    await mounted(find(ORDERS))
    const key = (k: string) => map().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    for (let i = 0; i < 25; i++) key('+')
    expect(zoom()).toBe(19)
    for (let i = 0; i < 25; i++) key('-')
    // The least zoom of the 480 px frame: the world as tall as the view.
    expect(zoom()).toBe(1)
    const before = document.querySelector('.gm-grid-label')!.textContent
    key('ArrowRight')
    key('ArrowRight')
    expect(map().dataset.zoom).toBe('1')
    expect(document.querySelector('.gm-grid-label')!.textContent).not.toBe(before)
  })

  it('says there are no tiles in a callout that can be put away, with a light graticule', async () => {
    await mounted(find(ORDERS))
    const note = document.getElementById('no-tiles')!
    expect(note.classList.contains('mm-callout-info')).toBe(true)
    expect(note.textContent).toContain('No map tiles')
    expect(note.textContent).toContain('An administrator can set a tile server')
    expect(document.querySelectorAll('.gm-grid-line').length).toBeGreaterThan(4)
    expect(document.querySelector('.gm-grid-label')!.textContent).toMatch(/^\d+(\.\d+)?°[NSEW]?$/)
    ;[...note.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Dismiss')!.click()
    expect(document.getElementById('no-tiles')!.hidden).toBe(true)
  })

  it('loads the tiles an administrator set, as images without a referrer, and credits them as text', async () => {
    await mounted(find(ORDERS), {
      settings: { tileUrl: 'https://{s}.tile.example.org/{z}/{x}/{y}.png', tileAttribution: '<b>OSM</b>' },
    })
    expect(document.getElementById('no-tiles')).toBeNull()
    const tiles = [...document.querySelectorAll<HTMLImageElement>('img.gm-tile')]
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles[0]!.getAttribute('src')).toMatch(/^https:\/\/[abc]\.tile\.example\.org\/\d+\/\d+\/\d+\.png$/)
    expect(tiles.every((t) => t.referrerPolicy === 'no-referrer')).toBe(true)
    expect(document.querySelector('.gm-credit')!.textContent).toBe('<b>OSM</b>')
    expect(document.querySelector('b')).toBeNull()
  })

  it('draws no tiles from an address that is not http(s)', async () => {
    await mounted(find(ORDERS), { settings: { tileUrl: 'javascript:alert(1)//{z}/{x}/{y}' } })
    expect(document.querySelectorAll('img').length).toBe(0)
    expect(document.getElementById('no-tiles')).not.toBeNull()
  })

  it('picks among the GeoJSON fields when there are several', async () => {
    const docs = [
      {
        _id: 1,
        home: { type: 'Point', coordinates: [29, 41] },
        route: {
          type: 'LineString',
          coordinates: [
            [29, 41],
            [30, 40],
          ],
        },
      },
      { _id: 2, home: { type: 'Point', coordinates: [32, 39] } },
    ]
    await mounted(find(docs))
    expect(document.getElementById('status')!.textContent).toBe('3 shapes in 2 documents')
    const field = document.getElementById('field') as HTMLSelectElement
    expect([...field.options].map((o) => o.textContent)).toEqual(['All fields', 'home · 2', 'route · 1'])
    expect(document.querySelectorAll('.gm-line').length).toBe(1)
    field.value = 'route'
    field.dispatchEvent(new Event('change'))
    expect(document.getElementById('status')!.textContent).toBe('1 shape in 1 document')
    expect(points().length + clusters().length).toBe(0)
  })

  it('lists the shapes in a table: a name shows it on the map, Open opens its document', async () => {
    const opened = vi.fn(() => true)
    await mounted({ ...find(ORDERS), 'ui.openDocument': opened })
    const shapes = document.getElementById('shapes') as HTMLDetailsElement
    expect(shapes.querySelector('summary')!.textContent).toContain('Shapes')
    const rows = [...shapes.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(60)
    expect(rows[0]!.textContent).toContain('location')
    expect(rows[0]!.textContent).toContain('Point')
    ;[...rows[1]!.querySelectorAll('button')].find((b) => b.textContent === 'Open')!.click()
    await flush()
    expect(opened).toHaveBeenCalledWith({ id: ORDERS[1]!._id })
    ;(rows[2]!.querySelector('button.gm-link') as HTMLButtonElement).click()
    expect(document.querySelector('.gm-pop')!.textContent).toContain('65a1b2c3d4e5f60718291002')
    expect(document.querySelector('.gm-marker.gm-selected')).not.toBeNull()
  })

  it('draws one document for "Show on map"', async () => {
    const one = ORDERS[2]
    const { calls } = await mounted(
      { 'documents.get': () => one },
      { kind: 'documentAction' },
      { ...PLACE, documentId: ORDERS[2]!._id },
    )
    expect(calls.find((c) => c.method === 'documents.get')!.params).toEqual({ id: ORDERS[2]!._id })
    expect(document.getElementById('status')!.textContent).toBe('1 shape in 1 document')
    expect(points()).toHaveLength(1)
    expect(zoom()).toBe(15)
  })

  it('says when the documents hold no places, and when they could not be read', async () => {
    await mounted(find([{ _id: 1, version: [2, 1] }]))
    expect(app().textContent).toContain('No places in these documents')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await mounted({
      'documents.find': () => {
        throw new Error('boom')
      },
    })
    expect(app().textContent).toContain('The documents could not be read')
  })

  it('says to open a collection where there is none', async () => {
    await mounted({}, {}, null)
    expect(app().textContent).toContain('Open a collection to see its documents on the map.')
  })

  it('follows the app’s language, theme and accent', async () => {
    const { contexts } = await mounted(find(ORDERS))
    expect(document.documentElement.dataset.accent).toBe('ocean')
    contexts[0]!('tr', 'dark', 'rose')
    expect(document.documentElement.dataset.accent).toBe('rose')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.querySelector('h1')!.textContent).toBe('Harita')
    expect(document.getElementById('status')!.textContent).toBe('60 belgede 60 şekil')
    expect(tip(clusters()[0]!)).toBe('Burada 15 konum var: yakınlaştır')
    expect(document.getElementById('no-tiles')!.textContent).toContain('Harita döşemesi yok')
  })

  it('draws a polygon of 250,000 vertices, thinned, instead of hanging on "Reading documents…"', async () => {
    const n = 250_000
    const ring = Array.from({ length: n + 1 }, (_, i) => [
      29 + 2 * Math.cos((2 * Math.PI * i) / n),
      41 + Math.sin((2 * Math.PI * i) / n),
    ])
    await mounted(find([{ _id: 1, name: 'Marmara', area: { type: 'Polygon', coordinates: [ring] } }]))
    expect(document.getElementById('status')!.textContent).toBe('1 shape in 1 document')
    expect(document.querySelector<HTMLElement>('.gm-overlay')!.hidden).toBe(true)
    const d = document.querySelector('.gm-area')!.getAttribute('d')!
    const drawn = d.match(/[ML]/g)!.length
    expect(drawn).toBeLessThanOrEqual(10_000)
    expect(drawn).toBeGreaterThan(1_000)
    // Fitted to the whole shape: from 27°E to 31°E fits a 800 px frame at zoom 7 or so.
    expect(zoom()).toBeGreaterThan(5)
    expect(zoom()).toBeLessThan(9)
  })

  it('draws its marks for the pointer only: the table of shapes is the keyboard’s way to them', async () => {
    await mounted(find(ORDERS))
    expect(map().querySelectorAll('[role="button"]')).toHaveLength(0)
    expect(map().querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    expect(map().getAttribute('role')).toBe('region')
    expect(map().getAttribute('aria-label')).toBe('Map: drag to move, scroll to zoom')
    expect(map().tabIndex).toBe(0)
    tap(clusters()[0]!)
    expect(tip(points()[0]!)).toMatch(/: show its document$/)
  })

  it('moves focus into a place’s card, and back to the map when it closes', async () => {
    await mounted({ ...find(ORDERS), 'ui.openDocument': () => true })
    map().focus()
    tap(clusters()[0]!)
    tap(points().find((p) => p.dataset.items === '0')!)
    const pop = document.querySelector('.gm-pop')!
    expect(document.activeElement).toBe(
      [...pop.querySelectorAll('button')].find((b) => b.textContent === 'Open'),
    )
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('.gm-pop')).toBeNull()
    expect(document.activeElement).toBe(map())
  })

  it('gives focus back to the row of the table that opened the card', async () => {
    await mounted(find(ORDERS))
    const link = document.querySelectorAll<HTMLButtonElement>('#shapes tbody button.gm-link')[3]!
    link.focus()
    link.click()
    const pop = document.querySelector('.gm-pop')!
    expect(pop.contains(document.activeElement)).toBe(true)
    ;[...pop.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close')!.click()
    expect(document.querySelector('.gm-pop')).toBeNull()
    expect(document.activeElement).toBe(link)
  })

  it('keeps focus in the card when it is drawn again (a new language)', async () => {
    const { contexts } = await mounted(find(ORDERS))
    document.querySelectorAll<HTMLButtonElement>('#shapes tbody button.gm-link')[0]!.click()
    contexts[0]!('tr', 'light', 'ocean')
    const pop = document.querySelector('.gm-pop')!
    expect(document.activeElement).toBe(
      [...pop.querySelectorAll('button')].find((b) => b.textContent === 'Aç'),
    )
    // The row that opened it was drawn again too: closed, focus goes to the map.
    pop.querySelector<HTMLButtonElement>('[aria-label="Kapat"]')!.click()
    expect(document.activeElement).toBe(map())
  })

  it('shows an object field of the card in the page’s language', async () => {
    const docs = [{ _id: 1, name: 'Depot', meta: { a: 1, b: 2 }, loc: [29, 41] }]
    const { contexts } = await mounted(find(docs))
    document.querySelector<HTMLButtonElement>('#shapes tbody button.gm-link')!.click()
    expect(document.querySelector('.gm-pop')!.textContent).toContain('{ 2 fields }')
    contexts[0]!('tr', 'light', 'ocean')
    expect(document.querySelector('.gm-pop')!.textContent).toContain('{ 2 alan }')
  })

  it('answers cells as a renderer, drawing nothing', async () => {
    const f = fakeClient(PLACE, {}, { kind: 'cellRenderer' })
    mount(app(), f.client)
    expect(app().childElementCount).toBe(0)
    const answer = await f.cells()!('point', [{ type: 'Point', coordinates: [29, 41] }, 'x'], 'en', [], null)
    expect(answer).toEqual([{ text: '41.00000, 29.00000', tone: 'info' }, null])
  })
})

describe('the new languages', () => {
  it.each([
    ['zh', '地图', '60 个文档中有 60 个形状', 'zh-CN'],
    ['ja', 'マップ', '60 件のドキュメントに 60 個のシェイプ', 'ja'],
    ['es', 'Mapa', '60 formas en 60 documentos', 'es'],
    ['pt', 'Mapa', '60 formas em 60 documentos', 'pt-BR'],
    ['ko', '지도', '60개 도큐먼트에 도형 60개', 'ko'],
    ['de', 'Karte', '60 Formen in 60 Dokumenten', 'de'],
    ['fr', 'Carte', '60 formes dans 60 documents', 'fr'],
    ['ru', 'Карта', '60 фигур в 60 документах', 'ru'],
  ])('shows the page in %s', async (language, title, status, lang) => {
    const { contexts } = await mounted(find(ORDERS))
    contexts[0]!(language, 'light', 'ocean')
    expect(document.querySelector('h1')!.textContent).toBe(title)
    expect(document.getElementById('status')!.textContent).toBe(status)
    expect(document.documentElement.lang).toBe(lang)
  })

  it('reads English for a language it has no words in', async () => {
    const { contexts } = await mounted(find(ORDERS))
    contexts[0]!('xx', 'light', 'ocean')
    expect(document.querySelector('h1')!.textContent).toBe('Map')
    expect(document.documentElement.lang).toBe('en')
    expect(document.getElementById('status')!.textContent).toBe('60 shapes in 60 documents')
  })
})
