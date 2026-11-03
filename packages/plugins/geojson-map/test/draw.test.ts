// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { mount } from '../src/view'
import { featuresOf } from '../src/geo'
import { continuous } from '../src/area'

/** Map 1.2 (research 2026-10-28): an area drawn on the map filters the documents by it. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
type Handlers = Record<string, (params: unknown) => unknown>

function fakeClient(place: PluginContext['place'], handlers: Handlers) {
  const calls: Array<{ method: string; params: unknown }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'map' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'context.get')
        return {
          plugin: { id: 'geojson-map', version: '1' },
          contribution: { kind: 'collectionTab', id: 'map' },
          locale: 'en',
          theme: 'light',
          accent: 'ocean',
          place,
          settings: {},
        } as T
      return (await handlers[method]!(params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'places', documentId: null }
const point = (lng: number, lat: number) => ({
  type: 'Point',
  coordinates: [{ $numberDouble: String(lng) }, { $numberDouble: String(lat) }],
})
const DOCS = [
  { _id: 1, name: 'Izmir', location: point(27.14, 38.42) },
  { _id: 2, name: 'Ankara', location: point(32.85, 39.93) },
]
const find = (documents: unknown[]) => ({ 'documents.find': () => ({ documents, hasMore: false }) })
const app = () => document.getElementById('app')!
const svg = () => document.querySelector('#map svg')!
const zoom = () => Number(document.getElementById('map')!.dataset.zoom)
const click = (x: number, y: number) =>
  svg().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }))
/** A double click as a browser sends it: two clicks, then the dblclick. */
const doubleClick = (x: number, y: number) => {
  click(x, y)
  click(x, y)
  svg().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }))
}
const key = (k: string, on: Element = document.getElementById('map')!) =>
  on.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
const button = (id: string) => document.getElementById(id) as HTMLButtonElement
const corners = () => document.querySelectorAll('.gm-sketch-corner, .gm-sketch-first').length
const filters = (calls: Array<{ method: string; params: unknown }>) =>
  calls
    .filter((c) => c.method === 'ui.useQuery')
    .map((c) => (c.params as { filter: Record<string, unknown> }).filter)
type Ring = Array<Array<{ $numberDouble: string }>>
const ringOf = (clause: unknown) =>
  (clause as { $geoWithin: { $geometry: { coordinates: Ring[] } } }).$geoWithin.$geometry.coordinates[0]!.map(
    ([lng, lat]) => ({ lng: Number(lng!.$numberDouble), lat: Number(lat!.$numberDouble) }),
  )
/** Twice the ring's signed area, its longitudes continuous: positive when counterclockwise. */
const winding = (ring: Array<{ lng: number; lat: number }>) => {
  const r = continuous(ring)
  let sum = 0
  for (let i = 0; i < r.length - 1; i++) sum += r[i]!.lng * r[i + 1]!.lat - r[i + 1]!.lng * r[i]!.lat
  return sum
}

async function mounted(handlers: Handlers, place: PluginContext['place'] = PLACE) {
  const f = fakeClient(place, { 'ui.useQuery': () => true, ...handlers })
  mount(app(), f.client)
  f.greet()
  await settle()
  return f
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('drawing an area to filter by', () => {
  it('draws a polygon corner by corner, closes it on its first corner, and filters by it as drawn', async () => {
    const { calls } = await mounted(find(DOCS))
    button('draw-area').click()
    expect(button('draw-area').getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById('drawing')!.hidden).toBe(false)
    expect(document.getElementById('drawing-text')!.textContent).toContain('click the first corner')
    expect(document.getElementById('drawing-text')!.textContent).toContain('Space adds a corner')
    // Said for a screen reader by a live region that is always there.
    expect(document.getElementById('drawing-live')!.getAttribute('role')).toBe('status')
    expect(document.getElementById('drawing-live')!.textContent).toContain('click the first corner')
    click(100, 100)
    click(300, 100)
    click(300, 300)
    expect(corners()).toBe(3)
    click(102, 101)
    await settle()
    const [filter] = filters(calls)
    const geometry = (filter!.location as { $geoWithin: { $geometry: { type: string; crs: unknown } } })
      .$geoWithin.$geometry
    expect(geometry.type).toBe('Polygon')
    const ring = ringOf(filter!.location)
    // Counterclockwise as drawn on the map, its edges in steps (review C1, I1).
    expect(winding(ring)).toBeGreaterThan(0)
    expect(ring.length).toBeGreaterThan(4)
    expect(ring[0]).toEqual(ring.at(-1))
    expect(document.getElementById('drawing')!.hidden).toBe(true)
    expect(button('draw-area').getAttribute('aria-pressed')).toBe('false')
    expect(document.getElementById('draw-done')!.textContent).toContain(
      'The documents with a shape of location in the area are in Documents.',
    )
  })

  it('ends on a real double click, with no corner said twice and no zoom after', async () => {
    const { calls } = await mounted(find(DOCS))
    button('draw-area').click()
    click(100, 100)
    click(300, 100)
    // A double click is a corner and the end: its second click adds none.
    doubleClick(300, 300)
    await settle()
    const [filter] = filters(calls)
    // The three corners, densified: no spike back to a repeated one.
    expect(winding(ringOf(filter!.location))).toBeGreaterThan(0)
    // A double click on the first corner ends it on its first click; its dblclick zooms nothing.
    button('draw-area').click()
    click(100, 100)
    click(300, 100)
    click(300, 300)
    const before = zoom()
    doubleClick(100, 100)
    await settle()
    expect(filters(calls)).toHaveLength(2)
    expect(zoom()).toBe(before)
    // Two corners and a double click: one more corner, then the end.
    button('draw-area').click()
    click(100, 100)
    doubleClick(300, 100)
    expect(document.getElementById('drawing')!.hidden).toBe(false)
    expect(corners()).toBe(2)
  })

  it('takes a corner near an earlier one, and lets the click that ended a drawing pick nothing', async () => {
    const { calls } = await mounted(find(DOCS))
    button('draw-area').click()
    click(100, 100)
    click(300, 100)
    click(300, 300)
    // Near the second corner, not the last: a corner all the same.
    click(306, 96)
    expect(corners()).toBe(4)
    click(100, 100)
    await settle()
    expect(filters(calls)).toHaveLength(1)
    // The double click's second click lands on a place: it opens nothing.
    const mark = document.querySelector('.gm-cluster, .gm-marker')!
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    expect(document.querySelector('.gm-pop')).toBeNull()
  })

  it('takes a corner back on Backspace, gives up on Escape anywhere, and puts the focus back from Cancel', async () => {
    const { calls } = await mounted(find(DOCS))
    button('draw-area').click()
    click(100, 100)
    click(300, 100)
    click(320, 140)
    key('Backspace')
    expect(corners()).toBe(2)
    // Two corners are no area yet: Enter does nothing.
    key('Enter')
    expect(document.getElementById('drawing')!.hidden).toBe(false)
    click(300, 300)
    key('Enter')
    await settle()
    expect(filters(calls)).toHaveLength(1)
    // Escape with the focus elsewhere on the page.
    button('draw-area').click()
    click(100, 100)
    key('Escape', document.body)
    expect(document.getElementById('drawing')!.hidden).toBe(true)
    // Cancel: the focus goes back to the tool.
    button('draw-circle').click()
    button('draw-cancel').focus()
    button('draw-cancel').click()
    expect(document.getElementById('drawing')!.hidden).toBe(true)
    expect(document.activeElement).toBe(button('draw-circle'))
    await settle()
    expect(filters(calls)).toHaveLength(1)
  })

  it('draws by keyboard: Space puts a corner at the map’s centre, the arrows move it', async () => {
    const { calls } = await mounted(find(DOCS))
    button('draw-area').click()
    expect(document.querySelector('.gm-sketch-aim')).not.toBeNull()
    key(' ')
    key('ArrowRight')
    key(' ')
    key('ArrowDown')
    key(' ')
    expect(corners()).toBe(3)
    key('Enter')
    await settle()
    expect(winding(ringOf(filters(calls)[0]!.location))).not.toBe(0)
  })

  it('switches tools, puts one down on a second click, and stops when the field changes', async () => {
    const { calls } = await mounted(find([{ _id: 1, home: point(27, 38), work: point(29, 41) }]))
    const select = document.getElementById('field') as HTMLSelectElement
    select.value = 'work'
    select.dispatchEvent(new Event('change'))
    button('draw-area').click()
    click(100, 100)
    button('draw-circle').click()
    // The circle now, the polygon gone: the bar and the buttons say so (review I2).
    expect(button('draw-area').getAttribute('aria-pressed')).toBe('false')
    expect(button('draw-circle').getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById('drawing')!.hidden).toBe(false)
    expect(document.getElementById('drawing-text')!.textContent).toContain('Click the centre, then the edge.')
    expect(document.getElementById('drawing-text')!.textContent).not.toContain('corner')
    button('draw-circle').click()
    expect(document.getElementById('drawing')!.hidden).toBe(true)
    // Another field mid-drawing: the drawing stops, nothing is filtered (review I3).
    button('draw-area').click()
    click(100, 100)
    click(300, 100)
    select.value = 'home'
    select.dispatchEvent(new Event('change'))
    expect(document.getElementById('drawing')!.hidden).toBe(true)
    click(300, 300)
    click(100, 100)
    await settle()
    expect(filters(calls)).toEqual([])
  })

  it('draws a circle from its centre to its edge, as the globe holds it, saying its radius', async () => {
    const { calls } = await mounted(find(DOCS))
    button('draw-circle').click()
    click(400, 240)
    // A second click on the centre makes no circle.
    click(402, 241)
    svg().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 460, clientY: 240 }))
    expect(document.querySelector('.gm-sketch-label')!.textContent).toMatch(/km$/)
    expect(document.querySelector('path.gm-sketch-area')).not.toBeNull()
    click(460, 240)
    await settle()
    const [filter] = filters(calls)
    const sphere = (
      filter!.location as { $geoWithin: { $centerSphere: [unknown, { $numberDouble: string }] } }
    ).$geoWithin.$centerSphere
    expect(Number(sphere[1].$numberDouble)).toBeGreaterThan(0)
  })

  it('says why a drawn area makes no filter: its corners in a line', async () => {
    const { calls } = await mounted(find(DOCS))
    button('draw-area').click()
    click(100, 100)
    click(200, 200)
    click(300, 300)
    key('Enter')
    await settle()
    expect(filters(calls)).toEqual([])
    expect(document.getElementById('draw-failed')!.textContent).toContain(
      'The corners are in a line: the area has no size.',
    )
  })
})

describe('the area in view', () => {
  it('filters by what the map shows, keeping the Documents filter, replacing an earlier area', async () => {
    const { calls } = await mounted(find(DOCS), {
      ...PLACE,
      filter: { $and: [{ kind: 'city' }, { size: { $gt: 1 } }] },
    } as PluginContext['place'])
    expect(button('in-view').hasAttribute('aria-pressed')).toBe(false)
    button('in-view').click()
    await settle()
    const [filter] = filters(calls)
    const clauses = filter!.$and as Array<Record<string, unknown>>
    // Its clauses kept, flat.
    expect(clauses.slice(0, 2)).toEqual([{ kind: 'city' }, { size: { $gt: 1 } }])
    const ring = ringOf(clauses[2]!.location)
    expect(winding(ring)).toBeGreaterThan(0)
    // Around the documents' places.
    const lngs = ring.map((p) => p.lng)
    const lats = ring.map((p) => p.lat)
    expect(Math.min(...lngs)).toBeLessThan(27.14)
    expect(Math.max(...lngs)).toBeGreaterThan(32.85)
    expect(Math.min(...lats)).toBeLessThan(38.42)
    expect(Math.max(...lats)).toBeGreaterThan(39.93)

    // An area an earlier drawing put there is replaced, not narrowed again.
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const again = await mounted(find(DOCS), {
      ...PLACE,
      filter: { $and: [{ kind: 'city' }, clauses[2]] },
    } as PluginContext['place'])
    button('in-view').click()
    await settle()
    const next = filters(again.calls)[0]!.$and as unknown[]
    expect(next).toHaveLength(2)
    expect(next[0]).toEqual({ kind: 'city' })
    // Beside other keys of the filter too: { kind, location } is { kind } and { location }.
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const keyed = await mounted(find(DOCS), {
      ...PLACE,
      filter: { kind: 'city', ...clauses[2] },
    } as PluginContext['place'])
    button('in-view').click()
    await settle()
    const split = filters(keyed.calls)[0]!.$and as Array<Record<string, unknown>>
    expect(split).toHaveLength(2)
    expect(split[0]).toEqual({ kind: 'city' })
    expect(Object.keys(split[1]!)).toEqual(['location'])
  })
})

describe('the area in view while drawing', () => {
  it('takes the place of the drawing: it ends, and a later click filters nothing more', async () => {
    const { calls } = await mounted(find(DOCS))
    button('draw-area').click()
    click(100, 100)
    click(300, 100)
    button('in-view').click()
    expect(document.getElementById('drawing')!.hidden).toBe(true)
    click(300, 300)
    click(100, 100)
    await settle()
    expect(filters(calls)).toHaveLength(1)
  })
})

describe('what a drawn area filters', () => {
  it('asks for a field when shapes are in several, in words on the page', async () => {
    await mounted(find([{ _id: 1, home: point(27, 38), work: point(29, 41) }]))
    expect(button('draw-area').disabled).toBe(true)
    expect(document.getElementById('draw-why')!.hidden).toBe(false)
    expect(document.getElementById('draw-why')!.textContent).toBe(
      'Choose the GeoJSON field to filter by first',
    )
    expect(button('draw-area').getAttribute('aria-describedby')).toBe('draw-why')
    const select = document.getElementById('field') as HTMLSelectElement
    select.value = 'work'
    select.dispatchEvent(new Event('change'))
    expect(button('draw-area').disabled).toBe(false)
    expect(document.getElementById('draw-why')!.hidden).toBe(true)
  })

  it('reads a Feature at its geometry and a FeatureCollection at its features, one field’s paths joined', async () => {
    const feature = { type: 'Feature', geometry: point(27, 38), properties: {} }
    const docs = [
      { _id: 1, zone: feature },
      { _id: 2, zone: point(28, 39) },
      { _id: 3, zone: { type: 'FeatureCollection', features: [feature] } },
    ]
    const { calls } = await mounted(find(docs))
    button('in-view').click()
    await settle()
    const [filter] = filters(calls)
    expect((filter!.$or as Array<Record<string, unknown>>).map((c) => Object.keys(c)[0])).toEqual([
      'zone.geometry',
      'zone',
      'zone.features.geometry',
    ])
  })

  it('says before filtering which shapes it leaves out', async () => {
    // Both shown as "area": one under an empty key, which no path names.
    const docs = [
      { _id: 1, '': { area: point(27, 38) } },
      { _id: 2, area: point(28, 39) },
    ]
    const { calls } = await mounted(find(docs))
    expect(button('in-view').disabled).toBe(false)
    expect(document.getElementById('draw-why')!.hidden).toBe(false)
    expect(document.getElementById('draw-why')!.textContent).toContain(
      'Shapes of area under a key no filter can name',
    )
    button('in-view').click()
    await settle()
    expect(Object.keys(filters(calls)[0]!)).toEqual(['area'])
  })

  it('leaves out shapes under a key no filter can name, and says so', async () => {
    const docs = [
      { _id: 1, area: { 'a.b': point(27, 38) } },
      { _id: 2, area: { ok: point(28, 39) } },
    ]
    const only = await mounted(find([docs[0]]))
    expect(button('in-view').disabled).toBe(true)
    expect(document.getElementById('draw-why')!.textContent).toContain('under a key no filter can name')
    expect(only.calls.some((c) => c.method === 'ui.useQuery')).toBe(false)
  })

  it('says why the filter could not be put in Documents', async () => {
    await mounted({
      ...find(DOCS),
      'ui.useQuery': () => {
        throw new AskError('failed', 'At most 10 a minute')
      },
    })
    button('in-view').click()
    await settle()
    expect(document.getElementById('draw-failed')!.textContent).toContain('At most 10 a minute')
  })

  it('says it in Turkish', async () => {
    const f = await mounted(find(DOCS))
    for (const fn of f.contexts) fn('tr', 'light', 'ocean')
    button('draw-circle').click()
    expect(document.getElementById('drawing-text')!.textContent).toContain(
      'Önce merkeze, sonra kenara tıklayın.',
    )
    expect(button('draw-area').getAttribute('aria-label')).toBe('Filtrelemek için bir bölge çizin')
    expect(button('in-view').getAttribute('aria-label')).toBe('Görünen bölgeye göre filtreleyin')
  })
})

describe('the path a filter on a shape takes', () => {
  const paths = (doc: Record<string, unknown>) =>
    featuresOf(doc).map((x) => [x.properties.field, x.properties.query])

  it('is its keys, array positions left out; a Feature’s geometry; a FeatureCollection’s features', () => {
    expect(
      paths({
        _id: 1,
        a: point(1, 2),
        loc: [{ $numberDouble: '1' }, { $numberDouble: '2' }],
        f: { type: 'Feature', geometry: point(1, 2), properties: {} },
        fc: {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: point(1, 2), properties: {} }],
        },
        stops: [{ loc: point(1, 2) }, { loc: point(3, 4) }],
        places: [{ features: [{ type: 'Feature', geometry: point(1, 2), properties: {} }] }],
        zones: { '2024': point(1, 2) },
      }),
    ).toEqual([
      ['a', 'a'],
      ['loc', 'loc'],
      ['f', 'f.geometry'],
      ['fc.features.0', 'fc.features.geometry'],
      ['stops.0.loc', 'stops.loc'],
      ['stops.1.loc', 'stops.loc'],
      ['places.0.features.0', 'places.features.geometry'],
      ['zones.2024', 'zones.2024'],
    ])
  })

  it('reads a document that is a FeatureCollection itself at its features', () => {
    const doc = {
      _id: 1,
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: point(1, 2), properties: {} }],
      home: point(3, 4),
    }
    expect(paths(doc)).toEqual([
      ['features.features.0', 'features.geometry'],
      ['home', 'home'],
    ])
  })

  it('is none under a key with a dot or a $, or an empty one', () => {
    expect(paths({ _id: 1, $comment: point(1, 2), area: { 'a.b': point(1, 2), '': point(1, 2) } })).toEqual([
      ['$comment', null],
      ['area.a.b', null],
      ['area.', null],
    ])
  })
})
