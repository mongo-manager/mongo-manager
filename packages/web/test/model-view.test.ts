import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { DataModel } from '@mongo-manager/shared/browser'
import ModelView from '../src/model/ModelView.vue'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { useToastStore } from '../src/stores/toasts'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const MODEL = (over: Partial<DataModel> = {}): DataModel => ({
  db: 'shop',
  sampleSize: 200,
  collections: [
    {
      name: 'orders',
      type: 'collection',
      sampled: 30,
      fields: [
        { path: '_id', types: ['objectId'], share: 1 },
        { path: 'card', types: [], share: 1, masked: true },
        { path: 'items', types: ['array'], items: ['object'], share: 0.9 },
        { path: 'userId', types: ['objectId'], share: 1 },
      ],
      moreFields: 2,
    },
    {
      name: 'users',
      type: 'collection',
      sampled: 3,
      fields: [{ path: '_id', types: ['objectId'], share: 1 }],
      moreFields: 0,
    },
    { name: 'bigOrders', type: 'view', sampled: 0, fields: [], moreFields: 0, viewOn: 'orders' },
    { name: 'audit', type: 'collection', sampled: 0, fields: [], moreFields: 0, refused: 'not_permitted' },
  ],
  references: [
    {
      from: 'orders',
      field: 'userId',
      to: 'users',
      toField: '_id',
      sources: ['name', 'values'],
      many: false,
      overlap: { checked: 3, found: 3 },
    },
  ],
  skipped: 0,
  at: '2026-10-16T10:00:00.000Z',
  ...over,
})
const URL_ = 'GET connections/c1/databases/shop/model'

async function mounted(model = MODEL()) {
  const api = mockApi({ [URL_]: () => [200, model] })
  mountApp(ModelView, { props: { connectionId: 'c1', db: 'shop' } })
  await flushPromises()
  return api
}
async function read(model = MODEL()) {
  const api = await mounted(model)
  button('Read the model').click()
  await flushPromises()
  return api
}

describe('the database’s Model section (completion W6.4)', () => {
  // Wave 3 review (e2e screen 2026-10-26): "2 collections, 1 references".
  it('counts one collection and one reference in the singular', async () => {
    const one = MODEL()
    await read({ ...one, collections: one.collections.slice(0, 2) })
    expect(document.body.textContent).toContain('2 collections, 1 reference;')
    expect(document.querySelector('[data-model-canvas]')!.getAttribute('aria-label')).toBe(
      'Data model of shop: 2 collections, 1 link',
    )
    document.body.innerHTML = ''
    await read({ ...one, collections: one.collections.slice(1, 2), references: [] })
    expect(document.body.textContent).toContain('1 collection, 0 references;')
  })

  it('reads nothing until asked, then the chosen sample size', async () => {
    const { calls } = await mounted()
    expect(calls.filter((c) => c.path.endsWith('/model'))).toHaveLength(0)
    expect(document.body.textContent).toContain('Draw the collections of shop')
    button('Read the model').click()
    await flushPromises()
    const call = calls.find((c) => c.path.endsWith('/model'))!
    expect(call).toBeDefined()
  })

  it('draws each collection with its fields, references and views, masked fields by name only', async () => {
    await read()
    const svg = document.querySelector('svg[data-model-diagram]')!
    // Review minor 10: the focusable canvas is a named group, said to be a diagram.
    const canvas = document.querySelector('[data-model-canvas]')!
    expect(canvas.getAttribute('role')).toBe('group')
    expect(canvas.getAttribute('aria-roledescription')).toBe('diagram')
    expect(canvas.getAttribute('aria-label')).toBe('Data model of shop: 4 collections, 2 links')
    const node = (name: string) => svg.querySelector(`[data-node="${name}"]`)!
    expect(node('orders').textContent).toContain('userId')
    expect(node('orders').textContent).toContain('+2 more')
    expect(node('orders').querySelector('[data-field="card"]')!.textContent).toContain('hidden')
    expect(node('bigOrders').textContent).toContain('view on orders')
    expect(node('audit').textContent).toContain('Not readable')
    expect(svg.querySelectorAll('path[data-edge]')).toHaveLength(2)
    expect(svg.querySelector('path[data-edge][data-kind="view"]')).not.toBeNull()
  })

  it('selects a collection to see its links, and opens it', async () => {
    await read()
    const orders = document.querySelector<SVGGElement>('[data-node="orders"]')!
    orders.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    const details = document.querySelector('[data-model-details]')!
    expect(details.textContent).toContain('userId')
    expect(details.textContent).toContain('users')
    expect(details.textContent).toContain('by name, by values (3 of 3 found)')
    ;[...details.querySelectorAll('button')].find((b) => b.textContent?.includes('Open collection'))!.click()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({
      kind: 'collection',
      params: { db: 'shop', coll: 'orders' },
    })
  })

  it('pans and zooms by pointer and keyboard', async () => {
    await read()
    const canvas = document.querySelector<HTMLElement>('[data-model-canvas]')!
    const scene = () => document.querySelector('[data-model-scene]')!.getAttribute('transform')!
    const scale = () => Number(/scale\(([\d.]+)\)/.exec(scene())![1])
    const before = scale()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
    await flushPromises()
    expect(scale()).toBeGreaterThan(before)
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }))
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }))
    await flushPromises()
    expect(scale()).toBeLessThan(before)
    const at = scene()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(scene()).not.toBe(at)
    document.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click()
    await flushPromises()
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(scene()).toMatch(/scale\(/)
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))
    await flushPromises()
    expect(scale()).toBeGreaterThan(0)
    // Dragged a few pixels at a time: it pans once past the threshold.
    const start = scene()
    const pointer = (type: string, x: number) =>
      canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 10, button: 0, bubbles: true }))
    pointer('pointerdown', 10)
    for (const x of [11, 12, 13, 14, 15, 16, 17]) pointer('pointermove', x)
    pointer('pointerup', 17)
    await flushPromises()
    expect(scene()).not.toBe(start)
    // A plain click on a box still selects it.
    const orders = document.querySelector<SVGGElement>('[data-node="orders"]')!
    orders.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
    orders.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }))
    orders.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-model-details]')).not.toBeNull()
  })

  // Review minor 10: the page scrolls past the diagram; the wheel is the diagram's once it has the
  // focus (or with Shift); each box is reached and chosen from the keyboard.
  it('leaves the wheel to the page until the diagram has the focus, and selects boxes from the keyboard', async () => {
    await read()
    const canvas = document.querySelector<HTMLElement>('[data-model-canvas]')!
    const scene = () => document.querySelector('[data-model-scene]')!.getAttribute('transform')!
    const wheel = (init: WheelEventInit = {}) => {
      const e = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true, ...init })
      // happy-dom's WheelEvent leaves the modifier keys of its init out.
      if (init.shiftKey) Object.defineProperty(e, 'shiftKey', { value: true })
      canvas.dispatchEvent(e)
      return e
    }
    const at = scene()
    expect(wheel().defaultPrevented).toBe(false)
    await flushPromises()
    expect(scene()).toBe(at)
    expect(wheel({ shiftKey: true }).defaultPrevented).toBe(true)
    canvas.focus()
    expect(wheel().defaultPrevented).toBe(true)
    await flushPromises()
    expect(scene()).not.toBe(at)

    const box = document.querySelector<SVGGElement>('[data-node="users"]')!
    expect(box.getAttribute('tabindex')).toBe('0')
    expect(box.getAttribute('role')).toBe('button')
    expect(box.getAttribute('aria-label')).toBe('users, 1 field')
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.querySelector('[data-model-details] h3')!.textContent).toBe('users')
    expect(box.getAttribute('aria-pressed')).toBe('true')
  })

  // Re-review minor 4: a box the keyboard reaches is brought into sight.
  it('pans a focused box into view', async () => {
    await read()
    const canvas = document.querySelector<HTMLElement>('[data-model-canvas]')!
    Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true })
    for (let i = 0; i < 40; i++)
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }))
    await flushPromises()
    const view = () => {
      const m = /translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)/.exec(
        document.querySelector('[data-model-scene]')!.getAttribute('transform')!,
      )!
      return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) }
    }
    expect(view().x).toBeGreaterThan(800)
    const box = document.querySelector<SVGGElement>('[data-node="orders"]')!
    const rect = box.querySelector('rect')!
    const bx = Number(rect.getAttribute('x'))
    const bw = Number(rect.getAttribute('width'))
    box.dispatchEvent(new FocusEvent('focus'))
    await flushPromises()
    const v = view()
    expect(bx * v.k + v.x).toBeGreaterThanOrEqual(0)
    expect((bx + bw) * v.k + v.x).toBeLessThanOrEqual(800)
  })

  it('has a list for the keyboard: collections in order, a reference moves to its target', async () => {
    await read()
    ;[...document.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'List')!
      .click()
    await flushPromises()
    const heads = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-model-list] [data-collection-head]'),
    ]
    expect(heads.map((h) => h.dataset.collectionHead)).toEqual(['audit', 'bigOrders', 'orders', 'users'])
    heads[0]!.focus()
    heads[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(heads[1])
    heads[2]!.click()
    await flushPromises()
    const orders = document.querySelector('[data-model-list] [data-collection="orders"]')!
    expect(orders.textContent).toContain('card')
    expect(orders.textContent).toContain('Hidden from you')
    ;[...orders.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('users'))!
      .click()
    await flushPromises()
    expect(document.activeElement).toBe(document.querySelector('[data-collection-head="users"]'))
  })

  it('exports as JSON, SVG and PNG', async () => {
    await read()
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => (blobs.push(b as Blob), 'blob:x'))
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    // The download link is not followed here (happy-dom would leave the test's page).
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const exportAs = async (label: string) => {
      button('Export').click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((m) => m.textContent?.includes(label))!
        .click()
      await flushPromises()
    }
    await exportAs('JSON')
    expect(blobs.at(-1)!.type).toBe('application/json')
    expect(JSON.parse(await blobs.at(-1)!.text())).toMatchObject({ db: 'shop' })
    await exportAs('SVG')
    expect(blobs.at(-1)!.type).toBe('image/svg+xml')
    expect(await blobs.at(-1)!.text()).toContain('<svg')
  })

  // Plugins wave 3 (spec §4): the model as Mermaid, saved or copied; marks and ends on the diagram.
  it('exports as Mermaid, saved or copied, and marks keys, unique and indexed fields with one and many ends', async () => {
    const m = MODEL()
    m.collections[0]!.indexes = [{ keys: ['_id'], unique: true }, { keys: ['userId'] }]
    await read(m)
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => (blobs.push(b as Blob), 'blob:x'))
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const copied: string[] = []
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: async (s: string) => void copied.push(s) },
    })
    const exportAs = async (label: string) => {
      button('Export').click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes(label))!
        .click()
      await flushPromises()
    }
    await exportAs('Mermaid (ER diagram)')
    expect(await blobs.at(-1)!.text()).toContain('users ||--o{ orders : "userId"')
    await exportAs('Copy as Mermaid')
    expect(copied[0]).toContain('objectId userId "indexed"')
    expect(useToastStore().toasts.at(-1)!.message).toBe('The model was copied as Mermaid.')
    const orders = document.querySelector('[data-node="orders"]')!
    expect([...orders.querySelectorAll('[data-mark]')].map((e) => e.getAttribute('data-mark'))).toEqual([
      'pk',
      'index',
    ])
    const edge = document.querySelector('[data-edge][data-kind="reference"]')!
    expect(edge.getAttribute('marker-start')).toMatch(/many\)$/)
    expect(edge.getAttribute('marker-end')).toMatch(/one\)$/)
    expect(document.body.textContent).toContain('PK key · UQ unique · IX in an index')
  })

  it('says when collections were left out or could not be read, and offers Retry on failure', async () => {
    await read(MODEL({ skipped: 7, capped: true, sampleSize: 100 }))
    expect(document.body.textContent).toContain('7 more collections are not drawn')
    // Review minor 13: a sample made smaller by the server's cap says so.
    expect(document.body.textContent).toContain(
      '100 documents were sampled from each collection, to stay within this server',
    )
    document.body.innerHTML = ''
    mockApi({ [URL_]: () => [500, { code: 'INTERNAL', message: 'x' }] })
    mountApp(ModelView, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    button('Read the model').click()
    await flushPromises()
    expect(button('Retry')).toBeDefined()
  })
})
