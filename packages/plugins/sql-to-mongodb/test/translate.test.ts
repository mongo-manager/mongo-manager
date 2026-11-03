import { describe, expect, it } from 'vitest'
import { SqlError, translate } from '../src/translate'

const find = (sql: string) => {
  const m = translate(sql)
  if (m.kind !== 'find') throw new Error(`expected a find, got ${m.kind}`)
  return m
}
const pipeline = (sql: string) => {
  const m = translate(sql)
  if (m.kind !== 'aggregate') throw new Error(`expected a pipeline, got ${m.kind}`)
  return m.pipeline
}
const refused = (sql: string) => {
  try {
    translate(sql)
  } catch (e) {
    expect(e).toBeInstanceOf(SqlError)
    return (e as SqlError).message
  }
  throw new Error('accepted')
}

describe('SQL → find', () => {
  it.each([
    ['SELECT * FROM users WHERE age > 30', { age: { $gt: 30 } }],
    ["SELECT * FROM users WHERE name = 'Ada'", { name: 'Ada' }],
    ["SELECT * FROM users WHERE name <> 'Ada'", { name: { $nin: ['Ada', null] } }],
    ['SELECT * FROM users WHERE 30 < age', { age: { $gt: 30 } }],
    ['SELECT * FROM users WHERE age >= 18 AND age <= 65', { age: { $gte: 18, $lte: 65 } }],
    ["SELECT * FROM users WHERE a = 1 AND b = 'x'", { a: 1, b: 'x' }],
    ['SELECT * FROM users WHERE a = 1 OR b = 2', { $or: [{ a: 1 }, { b: 2 }] }],
    ["SELECT * FROM users WHERE city IN ('Ankara', 'İzmir')", { city: { $in: ['Ankara', 'İzmir'] } }],
    ['SELECT * FROM users WHERE id NOT IN (1, 2)', { id: { $nin: [1, 2, null] } }],
    ["SELECT * FROM users WHERE name LIKE 'A%'", { name: { $regex: String.raw`^A[\s\S]*\z`, $options: '' } }],
    [
      "SELECT * FROM users WHERE name LIKE '%a.b_'",
      { name: { $regex: String.raw`^[\s\S]*a\.b[\s\S]\z`, $options: '' } },
    ],
    ["SELECT * FROM users WHERE name ILIKE 'ada'", { name: { $regex: String.raw`^ada\z`, $options: 'i' } }],
    [
      "SELECT * FROM users WHERE name NOT LIKE 'A%'",
      { name: { $not: { $regex: String.raw`^A[\s\S]*\z`, $options: '' } } },
    ],
    ['SELECT * FROM users WHERE age BETWEEN 18 AND 65', { age: { $gte: 18, $lte: 65 } }],
    [
      'SELECT * FROM users WHERE age NOT BETWEEN 18 AND 65',
      { $or: [{ age: { $lt: 18 } }, { age: { $gt: 65 } }] },
    ],
    ['SELECT * FROM users WHERE email IS NULL', { email: null }],
    ['SELECT * FROM users WHERE email IS NOT NULL', { email: { $ne: null } }],
    ['SELECT * FROM users WHERE NOT (a = 1 OR b = 2)', { $nor: [{ $or: [{ a: 1 }, { b: 2 }] }] }],
    ['SELECT * FROM users WHERE active = TRUE AND deleted = false', { active: true, deleted: false }],
    ["SELECT * FROM users WHERE address.city = 'Bursa'", { 'address.city': 'Bursa' }],
    ['SELECT * FROM users u WHERE u.age > 1', { age: { $gt: 1 } }],
    ['SELECT * FROM users WHERE price > -1.5', { price: { $gt: -1.5 } }],
    ['SELECT * FROM users WHERE a = b', { $expr: { $eq: ['$a', '$b'] } }],
    ["SELECT * FROM users WHERE name = 'O''Brien'", { name: "O'Brien" }],
  ])('%s', (sql, filter) => {
    expect(find(sql).filter).toEqual(filter)
  })

  it('keeps columns, order and paging', () => {
    expect(find('SELECT name, age FROM users ORDER BY age DESC, name LIMIT 10 OFFSET 20')).toEqual({
      kind: 'find',
      collection: 'users',
      filter: {},
      projection: { name: 1, age: 1, _id: 0 },
      sort: { age: -1, name: 1 },
      skip: 20,
      limit: 10,
    })
    expect(find('SELECT _id, name FROM users LIMIT 5, 10')).toMatchObject({
      projection: { _id: 1, name: 1 },
      skip: 5,
      limit: 10,
    })
    expect(find('select * from `my users` -- comment\n where /* x */ a = 1;')).toMatchObject({
      collection: 'my users',
      filter: { a: 1 },
    })
  })
})

describe('double quotes (user report 2026-10-10: "shipped" was read as a field)', () => {
  it('reads a double-quoted value as text, as MySQL and Studio 3T do', () => {
    expect(find('SELECT * FROM orders WHERE status = "shipped" LIMIT 20')).toEqual({
      kind: 'find',
      collection: 'orders',
      filter: { status: 'shipped' },
      limit: 20,
    })
  })

  it.each([
    ['SELECT * FROM orders WHERE status <> "shipped"', { status: { $nin: ['shipped', null] } }],
    ['SELECT * FROM orders WHERE status IN ("shipped", "paid")', { status: { $in: ['shipped', 'paid'] } }],
    [
      'SELECT * FROM orders WHERE day BETWEEN "2026-01-01" AND "2026-02-01"',
      { day: { $gte: '2026-01-01', $lte: '2026-02-01' } },
    ],
    ['SELECT * FROM orders WHERE "first name" = "Ada"', { 'first name': 'Ada' }],
    ['SELECT * FROM orders WHERE status = `state`', { $expr: { $eq: ['$status', '$state'] } }],
    ['SELECT * FROM orders WHERE status = state', { $expr: { $eq: ['$status', '$state'] } }],
  ])('%s', (sql, filter) => {
    expect(find(sql).filter).toEqual(filter)
  })

  it('reads a double-quoted LIKE pattern as text', () => {
    expect(find('SELECT * FROM users WHERE name LIKE "A%"').filter).toEqual({
      name: { $regex: String.raw`^A[\s\S]*\z`, $options: '' },
    })
  })

  it('keeps a double-quoted name a name where a name is meant', () => {
    expect(find('SELECT "first name" FROM "my users" ORDER BY "first name"')).toMatchObject({
      collection: 'my users',
      projection: { 'first name': 1, _id: 0 },
      sort: { 'first name': 1 },
    })
  })

  it('keeps a doubled double quote inside the text', () => {
    expect(find('SELECT * FROM t WHERE title = "say ""hi"""').filter).toEqual({ title: 'say "hi"' })
  })
})

describe('SQL → aggregation', () => {
  it('groups with aggregates, HAVING and ORDER BY', () => {
    expect(
      pipeline(
        'SELECT city, COUNT(*) AS n, AVG(age) FROM users WHERE active = true GROUP BY city HAVING COUNT(*) > 5 ORDER BY n DESC LIMIT 3',
      ),
    ).toEqual([
      { $match: { active: true } },
      { $group: { _id: { city: '$city' }, n: { $sum: 1 }, avg_age: { $avg: '$age' } } },
      { $match: { n: { $gt: 5 } } },
      { $project: { _id: 0, city: '$_id.city', n: '$n', avg_age: '$avg_age' } },
      { $sort: { n: -1 } },
      { $limit: 3 },
    ])
  })

  it('counts and sums without groups, COUNT(col) counting values only', () => {
    expect(pipeline('SELECT COUNT(email), SUM(total), MIN(total), MAX(total) FROM orders')).toEqual([
      {
        $group: {
          _id: null,
          count_email: { $sum: { $cond: [{ $gt: ['$email', null] }, 1, 0] } },
          sum_total: { $sum: '$total' },
          min_total: { $min: '$total' },
          max_total: { $max: '$total' },
        },
      },
      {
        $project: {
          _id: 0,
          count_email: '$count_email',
          sum_total: '$sum_total',
          min_total: '$min_total',
          max_total: '$max_total',
        },
      },
    ])
  })

  it('makes DISTINCT a group', () => {
    expect(pipeline('SELECT DISTINCT city, address.zip FROM users ORDER BY city')).toEqual([
      { $group: { _id: { city: '$city', address_zip: '$address.zip' } } },
      { $project: { _id: 0, city: '$_id.city', 'address.zip': '$_id.address_zip' } },
      { $sort: { city: 1 } },
    ])
  })

  it('renames columns with aliases', () => {
    expect(
      pipeline('SELECT name AS fullName, age FROM users WHERE age > 1 ORDER BY fullName LIMIT 2'),
    ).toEqual([
      { $match: { age: { $gt: 1 } } },
      { $sort: { name: 1 } },
      { $limit: 2 },
      { $project: { _id: 0, fullName: '$name', age: '$age' } },
    ])
  })

  it('joins with $lookup, a LEFT JOIN keeping the unmatched', () => {
    expect(
      pipeline(
        "SELECT o.total, c.name FROM orders o LEFT JOIN customers c ON o.customerId = c._id WHERE c.country = 'TR' AND o.total > 10",
      ),
    ).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: { path: '$c', preserveNullAndEmptyArrays: true } },
      { $match: { 'c.country': 'TR', total: { $gt: 10 } } },
      { $project: { _id: 0, total: '$total', 'c.name': '$c.name' } },
    ])
    expect(pipeline('SELECT * FROM orders JOIN customers ON customers._id = orders.customerId')).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customers' } },
      { $unwind: { path: '$customers', preserveNullAndEmptyArrays: false } },
    ])
  })
})

describe('what SQL it refuses, by name', () => {
  it.each([
    ['SELECT * FROM a UNION SELECT * FROM b', /UNION/],
    ['UPDATE users SET a = 1', /Only SELECT/],
    ['DELETE FROM users', /Only SELECT/],
    ['SELECT * FROM a RIGHT JOIN b ON a.x = b.y', /RIGHT JOIN/],
    ['SELECT * FROM a WHERE x IN (SELECT y FROM b)', /subquer/i],
    ['SELECT * FROM a JOIN b ON a.x = b.y JOIN c ON a.z = c.w', /one JOIN/],
    ['SELECT * FROM a WHERE COUNT(*) > 1', /HAVING/],
    ['SELECT CASE WHEN a THEN 1 END FROM t', /CASE/],
    ['SELECT * FROM', /collection name/],
    ["SELECT * FROM t WHERE name = 'unterminated", /string/],
    ['SELECT * FROM t WHERE name = "unterminated', /quoted name or text/],
    ['SELECT * FROM t WHERE 1 = 1', /field/],
    ['SELECT a, COUNT(*) FROM t', /GROUP BY/],
  ])('%s', (sql, message) => {
    expect(refused(sql)).toMatch(message)
  })

  it('says where the problem is', () => {
    try {
      translate('SELECT * FROM t WHERE a = = 1')
    } catch (e) {
      expect((e as SqlError).position).toBe(26)
      return
    }
    throw new Error('accepted')
  })
})
