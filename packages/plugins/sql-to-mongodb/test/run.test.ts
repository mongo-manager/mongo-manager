// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { translate } from '../src/translate'
import {
  ROWS,
  asPipeline,
  columnHeads,
  columnOrder,
  columnSource,
  columnsOf,
  flatRow,
  joinAliases,
  nestedKeys,
  planRun,
  positionOf,
  snippetOf,
} from '../src/run'

describe('what Run asks the app for (plugin tabs redesign §2.2)', () => {
  it('runs a find as documents.find, canonical and at most 50 rows', () => {
    const plan = planRun(
      translate('SELECT name, age FROM users WHERE age > 30 ORDER BY name LIMIT 20'),
      'users',
    )
    expect(plan).toEqual({
      kind: 'run',
      method: 'documents.find',
      params: {
        filter: { age: { $gt: { $numberInt: '30' } } },
        projection: { name: { $numberInt: '1' }, age: { $numberInt: '1' }, _id: { $numberInt: '0' } },
        sort: { name: { $numberInt: '1' } },
        limit: 20,
      },
      capped: false,
    })
    expect(planRun(translate('SELECT * FROM users'), 'users')).toEqual({
      kind: 'run',
      method: 'documents.find',
      params: { filter: {}, limit: ROWS },
      capped: true,
    })
    expect(planRun(translate('SELECT * FROM users LIMIT 500'), 'users')).toMatchObject({
      params: { limit: ROWS },
      capped: true,
    })
  })

  it('runs a find with OFFSET as a pipeline: documents.find always starts at the first document', () => {
    const plan = planRun(translate("SELECT * FROM users WHERE city = 'Izmir' LIMIT 10 OFFSET 20"), 'users')
    expect(plan).toEqual({
      kind: 'run',
      method: 'documents.aggregate',
      params: {
        pipeline: [
          { $match: { city: 'Izmir' } },
          { $skip: { $numberInt: '20' } },
          { $limit: { $numberInt: '10' } },
        ],
        limit: 10,
      },
      capped: false,
    })
  })

  it('runs a pipeline as documents.aggregate with at most 50 rows', () => {
    const plan = planRun(translate('SELECT city, COUNT(*) AS n FROM users GROUP BY city'), 'users')
    expect(plan).toMatchObject({ kind: 'run', method: 'documents.aggregate', params: { limit: ROWS } })
    const pipeline = (plan as unknown as { params: { pipeline: Array<Record<string, unknown>> } }).params
      .pipeline
    expect(pipeline[0]).toEqual({ $group: { _id: { city: '$city' }, n: { $sum: { $numberInt: '1' } } } })
  })

  it('does not run a query of another collection', () => {
    expect(planRun(translate('SELECT * FROM customers'), 'orders')).toEqual({
      kind: 'other',
      from: 'customers',
    })
    expect(planRun(translate('SELECT * FROM Orders'), 'orders')).toEqual({ kind: 'other', from: 'Orders' })
  })

  it('runs a JOIN here, as its pipeline (user request 2026-10-10)', () => {
    expect(
      planRun(
        translate('SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id'),
        'orders',
      ),
    ).toEqual({
      kind: 'run',
      method: 'documents.aggregate',
      params: {
        pipeline: [
          { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
          { $unwind: { path: '$c', preserveNullAndEmptyArrays: false } },
          { $project: { _id: { $numberInt: '0' }, orderNo: '$orderNo', 'c.name': '$c.name' } },
        ],
        limit: ROWS,
      },
      capped: true,
    })
  })

  it('shows a joined document as columns of its fields', () => {
    expect(
      flatRow({ orderNo: 1, c: { name: 'Ada', address: { city: 'Izmir' } }, total: { $numberInt: '5' } }, [
        'c',
      ]),
    ).toEqual({
      orderNo: 1,
      'c.name': 'Ada',
      'c.address.city': 'Izmir',
      total: { $numberInt: '5' },
    })
    // An EJSON value and an array stay one cell.
    expect(flatRow({ at: { $date: '2026-01-01T00:00:00Z' }, tags: ['a'] }, ['at'])).toEqual({
      at: { $date: '2026-01-01T00:00:00Z' },
      tags: ['a'],
    })
  })

  it('answers LIMIT 0 with no rows, as SQL does, without asking (the bridge takes 1 to 1000)', () => {
    expect(planRun(translate('SELECT * FROM t LIMIT 0'), 't')).toEqual({ kind: 'none' })
    expect(planRun(translate('SELECT * FROM t LIMIT 0 OFFSET 5'), 't')).toEqual({ kind: 'none' })
  })

  it('answers LIMIT 0 of a pipeline with no rows too: the server refuses a $limit of 0', () => {
    expect(planRun(translate('SELECT city, COUNT(*) FROM users GROUP BY city LIMIT 0'), 'users')).toEqual({
      kind: 'none',
    })
    expect(
      planRun(translate('SELECT DISTINCT city FROM users ORDER BY city LIMIT 0 OFFSET 2'), 'users'),
    ).toEqual({ kind: 'none' })
    // A LIMIT above 0 still runs.
    expect(
      planRun(translate('SELECT city, COUNT(*) FROM users GROUP BY city LIMIT 1'), 'users'),
    ).toMatchObject({
      kind: 'run',
      method: 'documents.aggregate',
    })
  })
})

describe('a find as a pipeline', () => {
  it('matches, sorts, pages then shapes', () => {
    const m = translate("SELECT name FROM t WHERE a = 'x' ORDER BY name DESC LIMIT 5 OFFSET 2")
    expect(asPipeline(m)).toEqual([
      { $match: { a: 'x' } },
      { $sort: { name: -1 } },
      { $skip: 2 },
      { $limit: 5 },
      { $project: { name: 1, _id: 0 } },
    ])
  })
})

describe('the columns of the rows', () => {
  it('takes top-level keys in the order first seen, _id first', () => {
    expect(
      columnsOf([
        { b: 1, _id: 2 },
        { c: 3, b: 4 },
      ]),
    ).toEqual({ columns: ['_id', 'b', 'c'], hidden: 0 })
    expect(columnsOf([])).toEqual({ columns: [], hidden: 0 })
  })

  it('opens only the joined documents: never _id, nor a document of the collection itself (review I3)', () => {
    const row = { _id: { a: 1, b: 2 }, address: { city: 'Izmir' }, c: { name: 'Ada' } }
    expect(flatRow(row, ['c'])).toEqual({ _id: { a: 1, b: 2 }, address: { city: 'Izmir' }, 'c.name': 'Ada' })
    expect(flatRow(row, [])).toEqual(row)
  })

  it('keeps a field whose name has a dot, and a field called __proto__ (review M4)', () => {
    const row = JSON.parse('{"c.name":"literal","c":{"name":"nested","__proto__":[1]}}')
    const flat = flatRow(row, ['c'])
    expect(flat['c.name']).toBe('literal')
    expect(Object.getPrototypeOf(flat)).not.toEqual([1])
    expect(flat['c.__proto__']).toEqual([1])
    const top = flatRow(JSON.parse('{"__proto__":[2],"c":{"name":"x"}}'), ['c'])
    expect(Object.getPrototypeOf(top)).not.toEqual([2])
    expect(Object.prototype.hasOwnProperty.call(top, '__proto__')).toBe(true)
  })

  it('knows the aliases a query joins under', () => {
    expect(
      joinAliases(
        translate('SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id'),
      ),
    ).toEqual(['c'])
    expect(joinAliases(translate('SELECT * FROM orders'))).toEqual([])
  })

  it('heads a join’s columns as the SELECT writes them, each with its collection field (user request 2026-10-10)', () => {
    const heads = columnHeads(
      'SELECT o.orderNo, o.total AS amount, c.name FROM orders o JOIN customers c ON o.customerId = c._id',
    )!
    expect(heads('orderNo')).toEqual({ label: 'o.orderNo', note: 'orders.orderNo' })
    expect(heads('amount')).toEqual({ label: 'amount', note: 'orders.total' })
    expect(heads('c.name')).toEqual({ label: 'c.name', note: 'customers.name' })
    // A name written bare stays bare; its note still says where it is.
    const bare = columnHeads('SELECT orderNo, c.name FROM orders JOIN customers c ON customerId = c._id')!
    expect(bare('orderNo')).toEqual({ label: 'orderNo', note: 'orders.orderNo' })
  })

  it('heads every column of a SELECT * join, and leaves a computed one without a note', () => {
    const all = columnHeads('SELECT * FROM orders o JOIN customers c ON o.customerId = c._id')!
    expect(all('total')).toEqual({ label: 'o.total', note: 'orders.total' })
    expect(all('_id')).toEqual({ label: 'o._id', note: 'orders._id' })
    expect(all('c.email')).toEqual({ label: 'c.email', note: 'customers.email' })
    const grouped = columnHeads(
      'SELECT c.name, COUNT(*) AS n FROM orders o JOIN customers c ON o.customerId = c._id GROUP BY c.name',
    )!
    expect(grouped('c.name')).toEqual({ label: 'c.name', note: 'customers.name' })
    expect(grouped('n')).toEqual({ label: 'n', note: null })
  })

  it('reads a prefix as the translator does: a self-join, an alias shared (review I1)', () => {
    const self = columnHeads(
      'SELECT employees.name, m.name AS manager FROM employees JOIN employees m ON employees.managerId = m._id',
    )!
    expect(self('name')).toEqual({ label: 'employees.name', note: 'employees.name' })
    expect(self('manager')).toEqual({ label: 'manager', note: 'employees.name' })
    const aliased = columnHeads(
      'SELECT employees.name, m.name FROM employees e JOIN employees m ON e.managerId = m._id',
    )!
    expect(aliased('name')).toEqual({ label: 'employees.name', note: 'employees.name' })
    expect(aliased('m.name')).toEqual({ label: 'm.name', note: 'employees.name' })
    const shared = columnHeads(
      'SELECT x.orderNo, customers.name FROM orders x JOIN customers x ON x.customerId = customers._id',
    )!
    expect(shared('orderNo')).toEqual({ label: 'x.orderNo', note: 'orders.orderNo' })
  })

  it('opens a nested field of the open collection into its own column, headed (review M2)', () => {
    const sql =
      'SELECT o.shipping.city, o.total AS money.total, c.name FROM orders o JOIN customers c ON o.customerId = c._id'
    const model = translate(sql)
    const row = flatRow(
      { shipping: { city: 'Izmir' }, money: { total: 5 }, c: { name: 'Ada' } },
      joinAliases(model),
      nestedKeys(model),
    )
    expect(row).toEqual({ 'shipping.city': 'Izmir', 'money.total': 5, 'c.name': 'Ada' })
    const heads = columnHeads(sql)!
    expect(heads('shipping.city')).toEqual({ label: 'o.shipping.city', note: 'orders.shipping.city' })
    expect(heads('money.total')).toEqual({ label: 'money.total', note: 'orders.total' })
  })

  it('heads nothing of a query without a join, or of SQL it cannot read', () => {
    expect(columnHeads('SELECT name FROM users')).toBeNull()
    expect(columnHeads('SELECT FROM')).toBeNull()
  })

  it('knows the collection a joined column comes from', () => {
    const join = translate(
      'SELECT o.orderNo, c.name, c.email FROM orders o JOIN customers c ON o.customerId = c._id',
    )
    expect(columnSource('c.email', join)).toBe('customers.email')
    expect(columnSource('c.address.city', join)).toBe('customers.address.city')
    expect(columnSource('orderNo', join)).toBeNull()
    expect(columnSource('c', join)).toBeNull()
    expect(columnSource('c.name', translate('SELECT c.name FROM orders c'))).toBeNull()
  })

  it('puts the columns in the order the SELECT names them', () => {
    // The server put the joined document first (c.name before orderNo).
    const rows = [{ 'c.name': 'Ada', orderNo: 1, total: 5 }]
    expect(columnsOf(rows, 30, ['orderNo', 'total', 'c.name']).columns).toEqual([
      'orderNo',
      'total',
      'c.name',
    ])
    // Those it did not name come after; those absent from every row are left out.
    expect(columnsOf([{ x: 1, orderNo: 2 }], 30, ['orderNo', 'gone']).columns).toEqual(['orderNo', 'x'])
  })

  it('knows the order a query names its columns in', () => {
    expect(
      columnOrder(
        translate('SELECT o.orderNo, o.total, c.name FROM orders o JOIN customers c ON o.customerId = c._id'),
      ),
    ).toEqual(['orderNo', 'total', 'c.name'])
    expect(columnOrder(translate('SELECT name, age FROM users'))).toEqual(['name', 'age'])
    expect(columnOrder(translate('SELECT * FROM users'))).toEqual([])
  })

  it('shows at most a bound of them, and says how many more', () => {
    const row = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`f${i}`, i]))
    expect(columnsOf([row], 30)).toMatchObject({ hidden: 5 })
    expect(columnsOf([row], 30).columns).toHaveLength(30)
  })
})

describe('where a translation failed', () => {
  it('says the line and the column, counted from 1', () => {
    expect(positionOf('SELECT *', 0)).toEqual({ line: 1, column: 1 })
    expect(positionOf('SELECT *\nFROM t\nWHERE a = = 1', 26)).toEqual({ line: 3, column: 11 })
    expect(positionOf('SELECT *\nFROM t', 15)).toEqual({ line: 2, column: 7 })
  })

  it('counts a character outside the BMP as one column', () => {
    expect(positionOf("SELECT '😀' x", 11)).toEqual({ line: 1, column: 11 })
  })

  it('cuts the line around the character, marking it', () => {
    expect(snippetOf('SELECT *\nFROM t\nWHERE a = = 1', 26)).toEqual({
      before: 'WHERE a = ',
      at: '=',
      after: ' 1',
    })
    expect(snippetOf('SELECT * FROM', 13)).toEqual({ before: 'SELECT * FROM', at: ' ', after: '' })
    const long = `SELECT ${'a, '.repeat(60)}= FROM t`
    const at = long.indexOf('=')
    const s = snippetOf(long, at)
    expect(s.at).toBe('=')
    expect(s.before.startsWith('…')).toBe(true)
    expect(s.before.length).toBeLessThanOrEqual(41)
  })
})
