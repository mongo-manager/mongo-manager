import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { DataModel, ModelCollection, ModelReference } from '@mongo-manager/shared/browser'
import ModelView from '../src/model/ModelView.vue'
import { BOX_W, layoutModel, placeNodes } from '../src/model/layout'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

/**
 * 2026-10-26 (user report): a box of the data model held and dragged moved the whole diagram. A box
 * dragged moves alone, its links following; the empty canvas dragged still pans.
 */
const coll = (name: string, fields: string[] = ['_id']): ModelCollection => ({
  name,
  type: 'collection',
  sampled: 10,
  fields: fields.map((path) => ({ path, types: ['string'], share: 1 })),
  moreFields: 0,
})
const ref = (from: string, field: string, to: string): ModelReference => ({
  from,
  field,
  to,
  toField: '_id',
  sources: ['name'],
  many: false,
  overlap: { checked: 1, found: 1 },
})
const MODEL = (): DataModel => ({
  db: 'shop',
  sampleSize: 200,
  collections: [coll('orders', ['_id', 'userId']), coll('users'), coll('logs')],
  references: [ref('orders', 'userId', 'users')],
  skipped: 0,
  at: '2026-10-26T10:00:00.000Z',
})

describe('placeNodes', () => {
  it('moves a box where it is put, its links following, the others where they were', () => {
    const base = layoutModel(MODEL())
    const moved = placeNodes(base, { orders: { x: 900, y: 500 } })
    const at = (l: typeof base, name: string) => l.nodes.find((n) => n.name === name)!
    expect(at(moved, 'orders')).toMatchObject({ x: 900, y: 500 })
    expect(at(moved, 'users')).toEqual(at(base, 'users'))
    const edge = moved.edges[0]!
    expect(edge.d).not.toBe(base.edges[0]!.d)
    // Out of the side of orders facing users, now on its left.
    expect(edge.d.startsWith('M 900 ')).toBe(true)
    // The drawing grows to hold it.
    expect(moved.width).toBeGreaterThanOrEqual(900 + BOX_W)
    expect(moved.height).toBeGreaterThan(500)
    // The layout it was given is left as it was.
    expect(at(base, 'orders').x).not.toBe(900)
  })

  it('never puts a box above or left of the drawing, and ignores names it does not know', () => {
    const base = layoutModel(MODEL())
    const moved = placeNodes(base, { orders: { x: -50, y: -20 }, gone: { x: 5, y: 5 } })
    expect(moved.nodes.find((n) => n.name === 'orders')).toMatchObject({ x: 0, y: 0 })
    expect(moved.nodes.map((n) => n.name).sort()).toEqual(['logs', 'orders', 'users'])
  })

  it('takes a collection named as an object’s own keys for what it is', () => {
    const model = MODEL()
    model.collections.push(coll('constructor'), coll('toString'), coll('__proto__'))
    const base = layoutModel(model)
    const moved = placeNodes(base, {})
    expect(moved.nodes).toEqual(base.nodes)
    const own = placeNodes(base, { ['__proto__']: { x: 7, y: 9 } })
    expect(own.nodes.find((n) => n.name === '__proto__')).toMatchObject({ x: 7, y: 9 })
  })

  it('joins boxes one under the other on their right sides', () => {
    const base = layoutModel(MODEL())
    const users = base.nodes.find((n) => n.name === 'users')!
    const moved = placeNodes(base, { orders: { x: users.x + 20, y: users.y + 300 } })
    // Both ends on the right: out at orders' right edge, in at users' right edge.
    const d = moved.edges[0]!.d
    expect(d.startsWith(`M ${users.x + 20 + BOX_W} `)).toBe(true)
    expect(d.endsWith(`${users.x + BOX_W} ${/ ([\d.]+)$/.exec(d)![1]}`)).toBe(true)
  })
})

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

async function read() {
  mockApi({ 'GET connections/c1/databases/shop/model': () => [200, MODEL()] })
  mountApp(ModelView, { props: { connectionId: 'c1', db: 'shop' } })
  await flushPromises()
  button('Read the model').click()
  await flushPromises()
}
const rect = (name: string) => {
  const r = document.querySelector(`[data-node="${name}"] rect`)!
  return { x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')) }
}
const scene = () => document.querySelector('[data-model-scene]')!.getAttribute('transform')
const edge = () => document.querySelector('[data-edge]')!.getAttribute('d')
const pointer = (el: Element, type: string, x: number, y: number) =>
  el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }))
async function dragBox(name: string, dx: number, dy: number) {
  const box = document.querySelector(`[data-node="${name}"] rect`)!
  pointer(box, 'pointerdown', 100, 100)
  for (let i = 1; i <= 5; i++) pointer(box, 'pointermove', 100 + (dx * i) / 5, 100 + (dy * i) / 5)
  pointer(box, 'pointerup', 100 + dx, 100 + dy)
  box.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

describe('a box of the diagram dragged', () => {
  it('moves alone, its links following; the diagram stays where it is and nothing is selected', async () => {
    await read()
    const orders = rect('orders')
    const users = rect('users')
    const view = scene()
    const line = edge()
    await dragBox('orders', 60, 40)
    expect(rect('orders')).toEqual({ x: orders.x + 60, y: orders.y + 40 })
    expect(rect('users')).toEqual(users)
    expect(scene()).toBe(view)
    expect(edge()).not.toBe(line)
    // The press that ended a drag is not a click on the box.
    expect(document.querySelector('[data-model-details]')).toBeNull()
  })

  it('moves by what the pointer moved at the zoom in use', async () => {
    await read()
    const canvas = document.querySelector<HTMLElement>('[data-model-canvas]')!
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
    await flushPromises()
    const k = Number(/scale\(([\d.]+)\)/.exec(scene()!)![1])
    const orders = rect('orders')
    await dragBox('orders', 60, 0)
    expect(rect('orders').x).toBe(orders.x + Math.round(60 / k))
  })

  it('is put back with Reset layout, which is offered only once a box moved', async () => {
    await read()
    expect(document.querySelector('[data-model-reset]')).toBeNull()
    const orders = rect('orders')
    await dragBox('orders', 60, 40)
    document.querySelector<HTMLButtonElement>('[data-model-reset]')!.click()
    await flushPromises()
    expect(rect('orders')).toEqual(orders)
    expect(document.querySelector('[data-model-reset]')).toBeNull()
  })

  it('moves with Alt and the arrow keys once it has the focus, the diagram staying still', async () => {
    await read()
    const node = document.querySelector<SVGGElement>('[data-node="orders"]')!
    const orders = rect('orders')
    const view = scene()
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }))
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, shiftKey: true, bubbles: true }),
    )
    await flushPromises()
    expect(rect('orders')).toEqual({ x: orders.x + 16, y: orders.y + 64 })
    expect(scene()).toBe(view)
  })

  it('is exported where it was put', async () => {
    await read()
    await dragBox('orders', 60, 40)
    const at = rect('orders')
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => (blobs.push(b as Blob), 'blob:x'))
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    button('Export').click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('SVG'))!
      .click()
    await flushPromises()
    expect(await blobs.at(-1)!.text()).toContain(`<rect x="${at.x}" y="${at.y}"`)
  })

  it('says how in the diagram’s hint, in English and Turkish', async () => {
    expect(i18n.global.t('model.canvasHint')).toContain('Alt and the arrow keys move it')
    i18n.global.locale.value = 'tr'
    expect(i18n.global.t('model.canvasHint')).toContain('Alt ve ok tuşları onu taşır')
    expect(i18n.global.t('model.resetLayout')).toBe('Yerleşimi sıfırla')
  })
})

describe('the boxes moved (review 2026-10-26, M4)', () => {
  it('stay where they were put when the Model section is left and opened again', async () => {
    await read()
    await dragBox('orders', 60, 40)
    const at = rect('orders')
    document.body.innerHTML = ''
    mountApp(ModelView, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    button('Read the model').click()
    await flushPromises()
    expect(rect('orders')).toEqual(at)
  })

  it('are kept per database', async () => {
    await read()
    await dragBox('orders', 60, 40)
    const moved = rect('orders')
    document.body.innerHTML = ''
    mockApi({ 'GET connections/c1/databases/crm/model': () => [200, { ...MODEL(), db: 'crm' }] })
    mountApp(ModelView, { props: { connectionId: 'c1', db: 'crm' } })
    await flushPromises()
    button('Read the model').click()
    await flushPromises()
    expect(rect('orders')).not.toEqual(moved)
  })
})
