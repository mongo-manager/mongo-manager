import { describe, expect, it } from 'vitest'
import type { DataModel, ModelCollection, ModelReference } from '@mongo-manager/shared/browser'
import { layoutModel, MAX_ROWS, rowY } from '../src/model/layout'
import { modelSvg, modelWords } from '../src/model/exportModel'
import { i18n } from '../src/i18n'

const coll = (
  name: string,
  fields: string[] = ['_id'],
  over: Partial<ModelCollection> = {},
): ModelCollection => ({
  name,
  type: 'collection',
  sampled: 10,
  fields: fields.map((path) => ({ path, types: ['string'], share: 1 })),
  moreFields: 0,
  ...over,
})
const ref = (
  from: string,
  field: string,
  to: string,
  over: Partial<ModelReference> = {},
): ModelReference => ({
  from,
  field,
  to,
  toField: '_id',
  sources: ['name'],
  many: false,
  ...over,
})
const model = (collections: ModelCollection[], references: ModelReference[] = []): DataModel => ({
  db: 'shop',
  sampleSize: 200,
  collections,
  references,
  skipped: 0,
  at: '2026-10-16T00:00:00.000Z',
})

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('the data model’s layout (completion W6.4)', () => {
  it('puts referenced collections left of those referring to them, views further right', () => {
    const m = model(
      [
        coll('orders', ['_id', 'userId', 'sku']),
        coll('users'),
        coll('products'),
        coll('bigOrders', [], { type: 'view', viewOn: 'orders', sampled: 0 }),
      ],
      [ref('orders', 'userId', 'users'), ref('orders', 'sku', 'products', { sources: ['lookup'] })],
    )
    const l = layoutModel(m)
    const x = (name: string) => l.nodes.find((n) => n.name === name)!.x
    expect(x('users')).toBe(x('products'))
    expect(x('users')).toBeLessThan(x('orders'))
    expect(x('orders')).toBeLessThan(x('bigOrders'))
    expect(l.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ['orders', 'users', 'reference'],
      ['orders', 'products', 'reference'],
      ['bigOrders', 'orders', 'view'],
    ])
    // An edge leaves from its field's row.
    const orders = l.nodes.find((n) => n.name === 'orders')!
    expect(l.edges[0]!.d.startsWith(`M ${orders.x} ${rowY(orders, 1)} `)).toBe(true)
    for (const a of l.nodes)
      for (const b of l.nodes) if (a !== b) expect(overlaps(a, b), `${a.name}/${b.name}`).toBe(false)
    expect(l.width).toBeGreaterThan(x('bigOrders'))
  })

  it('survives cycles and self-references, lists isolated collections apart, and is deterministic', () => {
    const m = model(
      [
        coll('a', ['_id', 'bId']),
        coll('b', ['_id', 'aId']),
        coll('c', ['_id', 'parentId']),
        coll('lonely'),
        coll('alone'),
      ],
      [ref('a', 'bId', 'b'), ref('b', 'aId', 'a'), ref('c', 'parentId', 'c')],
    )
    const one = layoutModel(m)
    expect(layoutModel(m)).toEqual(one)
    expect(one.nodes.map((n) => n.name).sort()).toEqual(['a', 'alone', 'b', 'c', 'lonely'])
    const self = one.edges.find((e) => e.from === 'c' && e.to === 'c')!
    expect(self.d).toMatch(/^M [\d.]+ [\d.]+ C /)
    const graphBottom = Math.max(
      ...one.nodes.filter((n) => ['a', 'b', 'c'].includes(n.name)).map((n) => n.y + n.h),
    )
    for (const name of ['alone', 'lonely'])
      expect(one.nodes.find((n) => n.name === name)!.y).toBeGreaterThan(graphBottom)
  })

  it('lists at most a few rows per box and says how many more there are', () => {
    const fields = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `f${i}`)
    const l = layoutModel(model([coll('wide', fields, { moreFields: 3 })]))
    const box = l.nodes[0]!
    expect(box.rows).toHaveLength(MAX_ROWS)
    expect(box.more).toBe(5 + 3)
  })

  it('lays out 50 collections and 200 references quickly', () => {
    const cs = Array.from({ length: 50 }, (_, i) =>
      coll(`c${i}`, ['_id', ...Array.from({ length: 10 }, (_, j) => `r${j}Id`)]),
    )
    const rs = Array.from({ length: 200 }, (_, i) => ref(`c${i % 50}`, `r${i % 10}Id`, `c${(i * 7) % 50}`))
    const started = performance.now()
    const l = layoutModel(model(cs, rs))
    expect(performance.now() - started).toBeLessThan(500)
    expect(l.nodes).toHaveLength(50)
  })
})

describe('the data model’s SVG export', () => {
  it('is a standalone SVG with every name escaped', () => {
    const hostile = '<script>alert(1)</script>&"\''
    const m = model(
      [coll(hostile, ['_id', `${hostile}Id`]), coll('users')],
      [ref(hostile, `${hostile}Id`, 'users')],
    )
    const svg = modelSvg(m, layoutModel(m), PALETTE, modelWords(i18n.global.t))
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).not.toContain('<script')
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&apos;')
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelectorAll('script')).toHaveLength(0)
  })
})

const PALETTE = {
  background: '#fff',
  surface: '#fff',
  line: '#ccc',
  fg: '#111',
  muted: '#666',
  accent: '#047a4d',
}

// Review minor 11: the image speaks the reader's language.
describe('the data model’s image in the reader’s language', () => {
  it('writes its title, notes and types in Turkish for a Turkish reader', () => {
    i18n.global.locale.value = 'tr'
    try {
      const m = model([
        coll(
          'orders',
          Array.from({ length: MAX_ROWS + 2 }, (_, i) => `f${i}`),
        ),
        coll('v', [], { type: 'view', viewOn: 'orders', sampled: 0 }),
        coll('audit', [], { refused: 'not_permitted', sampled: 0 }),
      ])
      m.collections[0]!.fields[0] = { path: 'f0', types: [], share: 1, masked: true }
      const svg = modelSvg(m, layoutModel(m), PALETTE, modelWords(i18n.global.t))
      expect(svg).toContain('<title>shop veri modeli</title>')
      expect(svg).toContain('orders üzerinde görünüm')
      expect(svg).toContain('Sizin için okunamaz')
      expect(svg).toContain('+2 tane daha')
      expect(svg).toContain('gizli')
      expect(svg).not.toMatch(/Data model of|view on|not read|more</)
    } finally {
      i18n.global.locale.value = 'en'
    }
  })
})
