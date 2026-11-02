import { describe, expect, it } from 'vitest'
import { highlightCode, highlightSql, type Piece } from '../src/highlight'

const kinds = (pieces: Piece[]) => pieces.filter((p) => p.kind !== 'plain').map((p) => [p.kind, p.text])
const joined = (pieces: Piece[]) => pieces.map((p) => p.text).join('')

// User request 2026-10-10: "colour the SQL".
describe('colouring SQL', () => {
  it('names each part of a query', () => {
    const sql =
      "SELECT c.name, COUNT(*) AS n FROM orders o JOIN `my coll` c ON o.cid = c._id WHERE o.total >= -1.5 AND s = 'it''s' -- note\n/* more */ LIMIT 10"
    expect(kinds(highlightSql(sql))).toEqual([
      ['keyword', 'SELECT'],
      ['operator', ','],
      ['function', 'COUNT'],
      ['operator', '('],
      ['operator', '*'],
      ['operator', ')'],
      ['keyword', 'AS'],
      ['keyword', 'FROM'],
      ['keyword', 'JOIN'],
      ['name', '`my coll`'],
      ['keyword', 'ON'],
      ['operator', '='],
      ['keyword', 'WHERE'],
      ['operator', '>='],
      ['operator', '-'],
      ['number', '1.5'],
      ['keyword', 'AND'],
      ['operator', '='],
      ['string', "'it''s'"],
      ['comment', '-- note'],
      ['comment', '/* more */'],
      ['keyword', 'LIMIT'],
      ['number', '10'],
    ])
  })

  it('gives back exactly the text it was given, spaces and lines included', () => {
    for (const sql of [
      '  select *\n\tfrom  t\r\nwhere a = 1  ',
      "SELECT 'open",
      'SELECT /* open',
      'SELECT "quoted name" FROM t',
      'x @ # ! ~',
      '',
    ])
      expect(joined(highlightSql(sql))).toBe(sql)
  })

  it('colours a text or comment left open to the end', () => {
    expect(kinds(highlightSql("WHERE a = 'open"))).toContainEqual(['string', "'open"])
    expect(kinds(highlightSql('SELECT /* open'))).toContainEqual(['comment', '/* open'])
  })

  it('takes keywords in any case, and a word that only looks like one as a name', () => {
    expect(kinds(highlightSql('select statusx from t'))).toEqual([
      ['keyword', 'select'],
      ['keyword', 'from'],
    ])
    // COUNT without "(" is a field.
    expect(kinds(highlightSql('SELECT count FROM t'))).toEqual([
      ['keyword', 'SELECT'],
      ['keyword', 'FROM'],
    ])
  })
})

describe('colouring the MongoDB code', () => {
  it('names strings, numbers, operators and keys', () => {
    const code =
      'db.getCollection("orders").find({ status: "shipped", $or: [{ total: { $gt: 5 } }] }).limit(20)'
    const found = kinds(highlightCode(code))
    expect(found).toContainEqual(['string', '"orders"'])
    expect(found).toContainEqual(['operator', '$or'])
    expect(found).toContainEqual(['operator', '$gt'])
    expect(found).toContainEqual(['key', 'status'])
    expect(found).toContainEqual(['number', '20'])
    expect(joined(highlightCode(code))).toBe(code)
  })

  it('takes comments and keywords of the driver languages', () => {
    const python = '# the orders\nfrom pymongo import MongoClient\nfilter = {"a": None}'
    const found = kinds(highlightCode(python))
    expect(found).toContainEqual(['comment', '# the orders'])
    expect(found).toContainEqual(['keyword', 'import'])
    expect(joined(highlightCode(python))).toBe(python)
    expect(kinds(highlightCode('// note\nconst x = 1'))).toContainEqual(['comment', '// note'])
  })

  it('gives back long code as one plain piece', () => {
    const long = 'x'.repeat(200_001)
    expect(highlightCode(long)).toEqual([{ kind: 'plain', text: long }])
    expect(highlightSql(long)).toEqual([{ kind: 'plain', text: long }])
  })
})
