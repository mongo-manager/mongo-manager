// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { applyCompletion, catalogOf, completionsAt, type Catalog } from '../src/complete'

const ORDERS = [
  {
    _id: { $oid: 'a'.repeat(24) },
    status: 'shipped',
    city: 'Ankara',
    total: { $numberInt: '5' },
    address: { city: 'Izmir', zip: '35' },
  },
  {
    _id: { $oid: 'b'.repeat(24) },
    status: 'shipped',
    city: 'Izmir',
    total: { $numberDouble: '7.5' },
    paid: true,
  },
  {
    _id: { $oid: 'c'.repeat(24) },
    status: 'paid',
    city: "O'Hara",
    'first name': 'Ada',
    items: [{ productId: 1 }],
  },
]
const catalog: Catalog = catalogOf(ORDERS, 'orders')

/** The suggestions at the "|" of `sql`. */
const at = (sql: string) => {
  const caret = sql.indexOf('|')
  // Only the caret's own "|" is taken out: one the SQL holds after it (`||`) stays.
  return completionsAt(sql.slice(0, caret) + sql.slice(caret + 1), caret, catalog)
}
const labels = (sql: string) => at(sql)?.items.map((i) => i.label) ?? []

describe('what the sample tells (SQL completion, user request 2026-10-10)', () => {
  it('lists the fields, nested ones and those in arrays, the most common first, _id among them', () => {
    expect(catalog.fields.slice(0, 3)).toEqual(['_id', 'status', 'city'])
    expect(catalog.fields).toEqual(
      expect.arrayContaining([
        'total',
        'address.city',
        'address.zip',
        'paid',
        'first name',
        'items.productId',
      ]),
    )
  })

  it('keeps the values a field holds, the most common first, as SQL writes them', () => {
    expect(catalog.values.status).toEqual(["'shipped'", "'paid'"])
    expect(catalog.values.city).toEqual(["'Ankara'", "'Izmir'", "'O''Hara'"])
    expect(catalog.values.total).toEqual(['5', '7.5'])
    expect(catalog.values.paid).toEqual(['TRUE'])
    expect(catalog.values._id).toBeUndefined()
  })
})

describe('what is suggested where (SQL completion)', () => {
  it('offers WHERE while it is being typed', () => {
    expect(labels('SELECT * FROM orders Wh|')).toEqual(['WHERE'])
    expect(labels('SELECT * FROM orders wh|')).toEqual(['WHERE'])
  })

  it('offers what may follow a table', () => {
    expect(labels('SELECT * FROM orders |')).toEqual(
      expect.arrayContaining(['WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'JOIN', 'LEFT JOIN']),
    )
  })

  it('finds "status" for "st" after WHERE, from the collection’s own fields', () => {
    expect(labels('SELECT * FROM orders WHERE st|')[0]).toBe('status')
  })

  it('offers every field after WHERE, AND, OR and NOT', () => {
    for (const sql of [
      'SELECT * FROM orders WHERE |',
      "SELECT * FROM orders WHERE status = 'paid' AND |",
      'SELECT * FROM orders WHERE a = 1 OR |',
      'SELECT * FROM orders WHERE NOT |',
    ])
      expect(labels(sql)).toEqual(expect.arrayContaining(['status', 'city', 'address.city']))
  })

  it('finds a nested field by its last part, and a field in the middle of its name', () => {
    expect(labels('SELECT * FROM orders WHERE zip|')).toEqual(['address.zip'])
    expect(labels('SELECT * FROM orders WHERE prod|')).toEqual(['items.productId'])
    expect(labels('SELECT * FROM orders WHERE ity|')).toEqual(['city', 'address.city'])
  })

  it('offers the values seen after a comparison, inside a started text too', () => {
    expect(labels('SELECT * FROM orders WHERE status = |')).toEqual(["'shipped'", "'paid'"])
    expect(labels("SELECT * FROM orders WHERE status = 'sh|")).toEqual(["'shipped'"])
    expect(labels('SELECT * FROM orders WHERE status <> |')).toEqual(["'shipped'", "'paid'"])
    expect(labels('SELECT * FROM orders WHERE city IN (|')).toEqual(["'Ankara'", "'Izmir'", "'O''Hara'"])
    expect(labels("SELECT * FROM orders WHERE city IN ('Ankara', |")).toEqual(["'Izmir'", "'O''Hara'"])
    expect(labels('SELECT * FROM orders WHERE total > |')).toEqual(['5', '7.5'])
  })

  it('offers fields and functions in SELECT', () => {
    const select = labels('SELECT |')
    expect(select).toEqual(expect.arrayContaining(['*', 'status', 'COUNT(*)', 'SUM()', 'DISTINCT']))
    expect(labels('SELECT status, |')).toEqual(expect.arrayContaining(['city', 'COUNT(*)']))
    expect(labels('SELECT co|')).toEqual(['COUNT(*)'])
    expect(labels('SELECT SUM(|')).toEqual(expect.arrayContaining(['total']))
  })

  it('offers FROM and AS after a column, the collection after FROM', () => {
    expect(labels('SELECT status |')).toEqual(expect.arrayContaining(['FROM', 'AS']))
    expect(labels('SELECT * FROM |')).toEqual(['orders'])
    expect(labels('SELECT * FROM or|')).toEqual(['orders'])
  })

  it('offers what may follow a condition', () => {
    expect(labels("SELECT * FROM orders WHERE status = 'paid' |")).toEqual(
      expect.arrayContaining(['AND', 'OR', 'ORDER BY', 'GROUP BY', 'LIMIT']),
    )
    expect(labels('SELECT * FROM orders WHERE status |')).toEqual(
      expect.arrayContaining(['IN', 'NOT IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL']),
    )
  })

  it('offers fields after GROUP BY and ORDER BY, then ASC and DESC', () => {
    expect(labels('SELECT * FROM orders ORDER BY |')).toEqual(expect.arrayContaining(['status', 'total']))
    expect(labels('SELECT * FROM orders ORDER BY total |')).toEqual(
      expect.arrayContaining(['ASC', 'DESC', 'LIMIT']),
    )
    expect(labels('SELECT status, COUNT(*) FROM orders GROUP BY |')).toEqual(
      expect.arrayContaining(['status']),
    )
  })

  it('offers SELECT on an empty editor, nothing after LIMIT’s number but OFFSET', () => {
    expect(labels('|')).toEqual(['SELECT'])
    expect(labels('SELECT * FROM orders LIMIT |')).toEqual([])
    expect(labels('SELECT * FROM orders LIMIT 10 |')).toEqual(['OFFSET'])
  })

  it('offers nothing inside a comment or a name in quotes', () => {
    expect(labels('SELECT * FROM orders -- wh|')).toEqual([])
    expect(labels('SELECT `st|')).toEqual([])
  })

  it('never puts a value over a name in backticks', () => {
    expect(labels('SELECT * FROM orders WHERE status = `pa|')).toEqual([])
  })

  it('ranks a part of a name found from its start before one found within', () => {
    expect(labels('SELECT * FROM orders WHERE id|')).toEqual(['_id', 'items.productId', 'paid'])
  })

  it('offers nothing it would only repeat', () => {
    expect(labels('SELECT * FROM orders WHERE status|')).toEqual([])
  })

  it('replaces the whole word the caret is in', () => {
    const sql = 'SELECT * FROM orders WHERE stat = 1'
    const found = completionsAt(sql, sql.indexOf('at ='), catalog)!
    expect(sql.slice(found.from, found.to)).toBe('stat')
  })
})

describe('putting a suggestion in (SQL completion)', () => {
  const put = (sql: string, label: string) => {
    const caret = sql.indexOf('|')
    const plain = sql.slice(0, caret) + sql.slice(caret + 1)
    const found = completionsAt(plain, caret, catalog)!
    const item = found.items.find((i) => i.label === label)!
    const { text, caret: after } = applyCompletion(plain, found, item)
    return `${text.slice(0, after)}|${text.slice(after)}`
  }

  it('writes a keyword in the case typed, then a space', () => {
    expect(put('SELECT * FROM orders Wh|', 'WHERE')).toBe('SELECT * FROM orders WHERE |')
    expect(put('select * from orders wh|', 'WHERE')).toBe('select * from orders where |')
    expect(put('SELECT * FROM orders wh|', 'WHERE')).toBe('SELECT * FROM orders where |')
    expect(put('select * from orders WH|', 'WHERE')).toBe('select * from orders WHERE |')
  })

  it('writes a field, quoting a name SQL would not read', () => {
    expect(put('SELECT * FROM orders WHERE st|', 'status')).toBe('SELECT * FROM orders WHERE status |')
    expect(put('SELECT * FROM orders WHERE fir|', 'first name')).toBe(
      'SELECT * FROM orders WHERE `first name` |',
    )
  })

  it('writes a value over a text already started, and a function with the caret inside', () => {
    expect(put("SELECT * FROM orders WHERE status = 'sh|", "'shipped'")).toBe(
      "SELECT * FROM orders WHERE status = 'shipped' |",
    )
    expect(put('SELECT su|', 'SUM()')).toBe('SELECT SUM(|)')
  })

  it('keeps the text after the caret, without a second space', () => {
    expect(put('SELECT * FROM orders WHERE st| = 1', 'status')).toBe('SELECT * FROM orders WHERE status| = 1')
  })
})
