// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { SqlError, canonical, likeToRegex, translate, type Doc } from '../src/translate'
import { code } from '../src/codegen'
import { MESSAGES, sqlMessage } from '../src/messages'

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
const refused = (sql: string): SqlError => {
  try {
    translate(sql)
  } catch (e) {
    expect(e).toBeInstanceOf(SqlError)
    return e as SqlError
  }
  throw new Error(`accepted: ${sql}`)
}

describe('what a SELECT means, kept (wave 1 review I4, Minor 3)', () => {
  it('refuses HAVING with nothing to group', () => {
    expect(refused('SELECT * FROM t HAVING a > 1').code).toBe('having_alone')
    expect(refused('SELECT a FROM t HAVING a > 1').code).toBe('having_alone')
  })

  it('keeps apart group keys whose paths differ only by a dot', () => {
    const p = pipeline('SELECT a.b, a_b, COUNT(*) AS n FROM t GROUP BY a.b, a_b')
    const group = (p[0] as { $group: { _id: Doc } }).$group
    const keys = Object.keys(group._id)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    const project = (p.at(-1) as { $project: Doc }).$project
    expect(project['a.b']).not.toEqual(project.a_b)
    expect(project['a.b']).toBe(`$_id.${keys.find((k) => group._id[k] === '$a.b')}`)
  })

  it('keeps apart aggregates whose names would be the same', () => {
    const p = pipeline('SELECT COUNT(a.b), COUNT(a_b) FROM t')
    const group = (p[0] as { $group: Doc }).$group
    expect(Object.keys(group).filter((k) => k !== '_id')).toHaveLength(2)
    const named = pipeline('SELECT COUNT(a) AS sum_b, SUM(b) FROM t')
    const g2 = (named[0] as { $group: Doc }).$group
    expect(Object.keys(g2).filter((k) => k !== '_id')).toHaveLength(2)
    const project = (named.at(-1) as { $project: Doc }).$project
    expect(project.sum_b).not.toEqual(project.sum_b_2 ?? project.sum_b_)
  })

  it('refuses two columns of one name', () => {
    expect(refused('SELECT a AS x, b AS x FROM t').code).toBe('same_name')
    expect(refused('SELECT a AS n, COUNT(*) AS n FROM t GROUP BY a').code).toBe('same_name')
  })

  it('compares with NULL only through IS NULL', () => {
    for (const sql of [
      'SELECT * FROM t WHERE a = NULL',
      'SELECT * FROM t WHERE a <> NULL',
      'SELECT * FROM t WHERE NULL = a',
      'SELECT * FROM t WHERE a IN (1, NULL)',
      'SELECT * FROM t WHERE a BETWEEN NULL AND 1',
    ])
      expect(refused(sql).code, sql).toBe('null_compare')
  })

  it('leaves out missing and null values where SQL does', () => {
    expect(find("SELECT * FROM t WHERE name <> 'Ada'").filter).toEqual({ name: { $nin: ['Ada', null] } })
    expect(find('SELECT * FROM t WHERE id NOT IN (1, 2)').filter).toEqual({ id: { $nin: [1, 2, null] } })
  })

  it('makes LIKE match across lines, to the very end', () => {
    expect(likeToRegex('a%b_')).toBe(String.raw`^a[\s\S]*b[\s\S]\z`)
    expect(likeToRegex('1.5$')).toBe(String.raw`^1\.5\$\z`)
  })
})

describe('numbers kept exact (wave 1 review I4)', () => {
  it('refuses a whole number beyond what a double holds exactly', () => {
    expect(refused('SELECT * FROM t WHERE a = 9007199254740993').code).toBe('number_too_large')
    expect(refused('SELECT * FROM t LIMIT 9007199254740993').code).toBe('number_too_large')
    expect(refused('SELECT * FROM t LIMIT 5 OFFSET 99999999999999999999').code).toBe('number_too_large')
    expect(find('SELECT * FROM t WHERE a = 9007199254740991').filter).toEqual({ a: 9007199254740991 })
  })

  it('writes a number too large for a long as a double', () => {
    expect(canonical(2 ** 40)).toEqual({ $numberLong: String(2 ** 40) })
    expect(canonical(2 ** 60)).toEqual({ $numberDouble: String(2 ** 60) })
    expect(canonical(1e300)).toEqual({ $numberDouble: '1e+300' })
  })
})

describe('field names (wave 1 review Minor 5)', () => {
  it('refuses what is no field name', () => {
    for (const sql of [
      'SELECT * FROM t WHERE "$where" = 1',
      'SELECT * FROM t WHERE "a..b" = 1',
      'SELECT * FROM t WHERE "" = 1',
      'SELECT * FROM t WHERE a. = 1',
      'SELECT a AS "$x" FROM t',
      'SELECT "$a" FROM t',
    ])
      expect(refused(sql).code, sql).toBe('bad_field')
  })

  it('takes the collection name off a field, even when the collection has an alias', () => {
    expect(find('SELECT users.name FROM users u WHERE users.age > 1')).toMatchObject({
      filter: { age: { $gt: 1 } },
      projection: { name: 1, _id: 0 },
    })
    expect(
      pipeline('SELECT o.total, customers.name FROM orders o JOIN customers c ON o.cid = customers._id'),
    ).toEqual([
      { $lookup: { from: 'customers', localField: 'cid', foreignField: '_id', as: 'c' } },
      { $unwind: { path: '$c', preserveNullAndEmptyArrays: false } },
      { $project: { _id: 0, total: '$total', 'c.name': '$c.name' } },
    ])
  })

  it('groups by a selected column’s alias', () => {
    expect(pipeline('SELECT city AS c, COUNT(*) AS n FROM t GROUP BY c')).toEqual([
      { $group: { _id: { city: '$city' }, n: { $sum: 1 } } },
      { $project: { _id: 0, c: '$_id.city', n: '$n' } },
    ])
  })
})

describe('text the code holds (wave 1 review Minor 4)', () => {
  it('writes a pattern holding line breaks so the code parses, to the pattern the server is sent', () => {
    const typed = 'x\ny\r\u2028\u2029/z'
    const m = translate(`SELECT * FROM t WHERE a LIKE '${typed}'`)
    const mongosh = code(m, 'mongosh')
    expect(/[\n\r\u2028\u2029]/.test(mongosh)).toBe(false)
    // Not a regex literal (it could not hold the line break): the shell's RegExp of a string.
    const [, shellPattern] = /a: RegExp\(("(?:[^"\\]|\\.)*"), ""\)/.exec(mongosh)!
    expect(JSON.parse(shellPattern!)).toBe(likeToRegex(typed))
    const node = code(m, 'node')
    const [, nodePattern] = /a: new BSONRegExp\(("(?:[^"\\]|\\.)*"), ""\)/.exec(node)!
    expect(JSON.parse(nodePattern!)).toBe(likeToRegex(typed))
    expect(/[\r\u2028\u2029]/.test(node)).toBe(false)
  })

  it('spells out line separators in Java, C# and Go strings', () => {
    const m = translate("SELECT * FROM t WHERE a = 'x\u2028y\u2029z\u0085'")
    for (const lang of ['java', 'csharp', 'go'] as const)
      expect(/[\u2028\u2029\u0085]/.test(code(m, lang)), lang).toBe(false)
  })

  it('refuses a broken character', () => {
    expect(refused("SELECT * FROM t WHERE a = '\uD800'").code).toBe('broken_char')
    expect(refused("SELECT * FROM t WHERE a = '\uDC00x'").position).toBe(27)
  })

  it('writes Go with ordered documents (a sort keeps its order)', () => {
    const go = code(translate('SELECT a, COUNT(*) FROM t GROUP BY a ORDER BY a'), 'go')
    expect(go).toContain('pipeline := mongo.Pipeline{')
    expect(go).toContain('{Key: "$sort", Value: bson.D{{Key: "a", Value: int32(1)}}}')
    expect(code(translate('SELECT * FROM t WHERE a = 1 ORDER BY b DESC, a'), 'go')).toContain(
      'SetSort(bson.D{{Key: "b", Value: int32(-1)}, {Key: "a", Value: int32(1)}})',
    )
  })
})

describe('refusals in the app’s language (wave 1 review Minor 10)', () => {
  it('says what is wrong in English and Turkish', () => {
    const e = refused('SELECT * FROM t WHERE a = = 1')
    expect(e.code).toBe('expected_value')
    expect(sqlMessage(e, 'en')).toBe('A value is expected here')
    expect(sqlMessage(e, 'tr')).toBe('Burada bir değer bekleniyor')
    expect(sqlMessage(refused('SELECT * FROM a RIGHT JOIN b ON a.x = b.y'), 'tr')).toContain('RIGHT JOIN')
    expect(sqlMessage(refused('SELECT * FROM t WHERE "$x" = 1'), 'tr')).toContain('$x')
  })

  it('has every message in both languages', () => {
    expect(Object.keys(MESSAGES.tr!).sort()).toEqual(Object.keys(MESSAGES.en).sort())
  })
})
