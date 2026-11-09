// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { DataModel, ModelCollection } from '@mongo-manager/shared/browser'
import { fieldMark, modelMermaid } from '../src/model/marks'
import { layoutModel } from '../src/model/layout'
import { modelSvg, modelWords } from '../src/model/exportModel'
import { i18n } from '../src/i18n'

/**
 * Plugins wave 3 (spec §4): the Database tab's data model marks a field that is a key, unique or in
 * an index, ends each reference as one or many, and exports as Mermaid.
 */
const orders: ModelCollection = {
  name: 'orders',
  type: 'collection',
  sampled: 30,
  fields: [
    { path: '_id', types: ['objectId'], share: 1 },
    { path: 'userId', types: ['objectId'], share: 1 },
    { path: 'total', types: ['double', 'int'], share: 1 },
    { path: 'card', types: [], share: 1, masked: true },
    { path: 'items[].productId', types: ['objectId'], share: 0.9 },
    { path: 'code', types: ['string'], share: 1 },
  ],
  moreFields: 0,
  indexes: [{ keys: ['_id'], unique: true }, { keys: ['userId', 'total'] }, { keys: ['code'], unique: true }],
}
const model: DataModel = {
  db: 'shop',
  sampleSize: 200,
  collections: [
    orders,
    {
      name: 'users',
      type: 'collection',
      sampled: 3,
      fields: [{ path: '_id', types: ['objectId'], share: 1 }],
      moreFields: 0,
    },
    { name: 'order-lines.next', type: 'collection', sampled: 1, fields: [], moreFields: 0 },
    { name: 'bigOrders', type: 'view', sampled: 0, fields: [], moreFields: 0, viewOn: 'orders' },
  ],
  references: [
    {
      from: 'orders',
      field: 'userId',
      to: 'users',
      toField: '_id',
      sources: ['name', 'values'],
      many: false,
    },
    {
      from: 'orders',
      field: 'items[].productId',
      to: 'order-lines.next',
      toField: '_id',
      sources: ['lookup'],
      many: true,
    },
  ],
  skipped: 0,
  at: '2026-10-26T00:00:00.000Z',
}

describe('a field’s mark', () => {
  it('is the key for _id, unique for a unique index of it alone, an index for any index it is in', () => {
    expect(fieldMark(orders, '_id')).toBe('pk')
    expect(fieldMark(orders, 'code')).toBe('unique')
    expect(fieldMark(orders, 'userId')).toBe('index')
    expect(fieldMark(orders, 'total')).toBe('index')
    expect(fieldMark(orders, 'card')).toBeNull()
    expect(fieldMark({ ...orders, indexes: undefined }, 'userId')).toBeNull()
    // Unique only together with another key: in an index, not unique by itself.
    expect(fieldMark({ ...orders, indexes: [{ keys: ['a', 'b'], unique: true }] }, 'a')).toBe('index')
  })

  // Wave 3 review: a multikey index names `items.sku` where the model says `items[].sku`; a
  // wildcard index covers every field (or every field under its path).
  it('marks a field inside an array, and the fields a wildcard index covers', () => {
    const multikey = { ...orders, indexes: [{ keys: ['items.productId'], unique: true as const }] }
    expect(fieldMark(multikey, 'items[].productId')).toBe('unique')
    expect(fieldMark({ ...orders, indexes: [{ keys: ['$**'] }] }, 'total')).toBe('index')
    const under = { ...orders, indexes: [{ keys: ['items.$**'] }] }
    expect(fieldMark(under, 'items[].productId')).toBe('index')
    expect(fieldMark(under, 'total')).toBeNull()
    expect(fieldMark(under, 'itemsCount')).toBeNull()
  })
})

describe('the model as Mermaid', () => {
  const text = modelMermaid(model, 'hidden')

  it('lists each collection with its fields’ main types and marks, a hidden one as hidden', () => {
    expect(text.startsWith('erDiagram\n')).toBe(true)
    expect(text).toContain(
      '  orders {\n    objectId _id PK\n    objectId userId "indexed"\n    double total "indexed"\n    hidden card\n',
    )
    expect(text).toContain('    string code UK\n')
    // A path Mermaid cannot take is written with _ and named as it is.
    expect(text).toContain('    objectId items___productId "items[].productId"\n')
  })

  it('writes a reference as one to many, an array of them as many to many, a $lookup and a view dotted', () => {
    expect(text).toContain('  users ||--o{ orders : "userId"\n')
    expect(text).toContain('  order_lines_next }o..o{ orders : "items[].productId"\n')
    expect(text).toContain('  orders ||..o{ bigOrders : "view on"\n')
    // A name changed for Mermaid is said under its own.
    expect(text).toContain('  %% order_lines_next is "order-lines.next"\n')
  })

  it('gives two collections Mermaid would name alike names of their own', () => {
    const twins: DataModel = {
      ...model,
      collections: [
        { name: 'a-b', type: 'collection', sampled: 1, fields: [], moreFields: 0 },
        { name: 'a.b', type: 'collection', sampled: 1, fields: [], moreFields: 0 },
      ],
      references: [{ from: 'a.b', field: 'x', to: 'a-b', toField: '_id', sources: ['name'], many: false }],
    }
    const out = modelMermaid(twins, 'hidden')
    expect(out).toContain('  %% a_b is "a-b"\n')
    expect(out).toContain('  %% a_b_2 is "a.b"\n')
    expect(out).toContain('  a_b ||--o{ a_b_2 : "x"\n')
  })

  it('keeps nothing a name could break out with', () => {
    const hostile: DataModel = {
      ...model,
      collections: [
        {
          name: 'a"b\n}c',
          type: 'collection',
          sampled: 1,
          fields: [{ path: 'x"\n}y', types: ['string'], share: 1 }],
          moreFields: 0,
        },
      ],
      references: [],
    }
    const out = modelMermaid(hostile, 'hidden')
    expect(out.split('\n').every((line) => !line.includes('}c') && !line.includes('}y'))).toBe(true)
    expect(out).not.toMatch(/"[^"\n]*"[^"\n]*"[^"\n]*"/)
  })
})

describe('the diagram’s ends and marks in its image', () => {
  it('ends a reference as many at the field and one (or many) at the collection, and marks the fields', () => {
    const svg = modelSvg(
      model,
      layoutModel(model),
      { background: '#fff', surface: '#fff', line: '#ccc', fg: '#111', muted: '#666', accent: '#047a4d' },
      modelWords(i18n.global.t),
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const edges = [...doc.querySelectorAll('path[data-kind="reference"]')]
    expect(edges).toHaveLength(2)
    expect(edges.map((e) => [e.getAttribute('marker-start'), e.getAttribute('marker-end')])).toEqual([
      ['url(#many)', 'url(#one)'],
      ['url(#many)', 'url(#many)'],
    ])
    expect(doc.querySelector('marker#many')).not.toBeNull()
    expect(doc.querySelector('marker#one')).not.toBeNull()
    const marks = (node: string) =>
      [...doc.querySelectorAll(`g[data-node="${node}"] [data-mark]`)].map((m) => [
        m.getAttribute('data-mark'),
        m.textContent,
      ])
    expect(marks('orders')).toEqual([
      ['pk', 'PK'],
      ['index', 'IX'],
      ['index', 'IX'],
      ['unique', 'UQ'],
    ])
    expect(marks('users')).toEqual([['pk', 'PK']])
  })
})
