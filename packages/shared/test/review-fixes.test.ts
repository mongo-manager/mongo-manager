import { describe, expect, it } from 'vitest'
import { DBRef, ObjectId } from 'bson'
import { parseQueryObject, parseShellExpression } from '../src/query/parse'
import { QueryParseError } from '../src/query/errors'
import { formatShell } from '../src/query/format'
import { bsonTypeOf, toWire } from '../src/ejson'

describe('review fix 1: EJSON wrappers are range-checked like constructors', () => {
  for (const src of [
    '{ n: { "$numberLong": "9223372036854775808" } }',
    '{ n: { "$numberInt": "99999999999" } }',
    '{ n: { "$numberInt": "1.5" } }',
    '{ n: { "$numberInt": 5 } }',
    '{ t: { "$timestamp": { "t": 99999999999, "i": 1 } } }',
    '{ d: { "$date": { "$numberLong": "9999999999999999999" } } }',
    '{ d: { "$date": { "$numberLong": "8640000000000001" } } }',
  ]) {
    it(`rejects ${src}`, () => {
      expect(() => parseQueryObject(src)).toThrow(QueryParseError)
    })
  }

  it('still accepts in-range wrappers', () => {
    const v = parseQueryObject('{ a: { "$numberInt": "-5" }, d: { "$date": { "$numberLong": "-1000" } } }')
    expect(toWire(v)).toBe('{"a":{"$numberInt":"-5"},"d":{"$date":{"$numberLong":"-1000"}}}')
  })
})

describe('review fix 2: dates are strict ISO-8601 and timezone-independent', () => {
  it('treats a time without offset as UTC', () => {
    expect((parseShellExpression('ISODate("2024-01-02T10:00:00")') as Date).toISOString()).toBe(
      '2024-01-02T10:00:00.000Z',
    )
    expect((parseShellExpression('ISODate("2024-01-02 10:00")') as Date).toISOString()).toBe(
      '2024-01-02T10:00:00.000Z',
    )
    expect((parseQueryObject('{ d: { "$date": "2024-01-02T10:00:00" } }').d as Date).toISOString()).toBe(
      '2024-01-02T10:00:00.000Z',
    )
  })

  it('honours explicit offsets', () => {
    expect((parseShellExpression('ISODate("2024-01-02T10:00:00+03:00")') as Date).toISOString()).toBe(
      '2024-01-02T07:00:00.000Z',
    )
  })

  for (const src of [
    'ISODate("1")',
    'ISODate("Jan 2 2024")',
    'ISODate(1e300)',
    'new Date(NaN)',
    '{ d: { "$date": "not a date" } }',
  ]) {
    it(`rejects ${src}`, () => {
      expect(() => parseShellExpression(src)).toThrow(QueryParseError)
    })
  }
})

describe('review fix 3: large integers travel as doubles', () => {
  it('serializes integral numbers outside int32 as $numberDouble', () => {
    expect(toWire(parseQueryObject('{ a: 1099511627776, b: -2147483649, c: 7 }'))).toBe(
      '{"a":{"$numberDouble":"1099511627776.0"},"b":{"$numberDouble":"-2147483649.0"},"c":{"$numberInt":"7"}}',
    )
    expect(toWire([2 ** 31])).toBe('[{"$numberDouble":"2147483648.0"}]')
  })

  it('does not mutate the input and keeps own __proto__ keys', () => {
    const doc: Record<string, unknown> = { n: 2 ** 40 }
    Object.defineProperty(doc, '__proto__', {
      value: { m: 2 ** 40 },
      enumerable: true,
      writable: true,
      configurable: true,
    })
    expect(toWire(doc)).toBe(
      '{"n":{"$numberDouble":"1099511627776.0"},"__proto__":{"m":{"$numberDouble":"1099511627776.0"}}}',
    )
    expect(doc.n).toBe(2 ** 40)
  })
})

describe('review fix 4: hostile _bsontype fields are plain data', () => {
  it('does not trust _bsontype without the bson brand', () => {
    const hostile = { _bsontype: 'ObjectId', id: 'x' }
    expect(bsonTypeOf(hostile)).toBe('object')
    expect(formatShell(hostile, { indent: 0 })).toBe('{ _bsontype: "ObjectId", id: "x" }')
    expect(() => formatShell({ _bsontype: 'Code' })).not.toThrow()
  })
})

describe('review fix 5: trailing semicolons with comments', () => {
  for (const src of ['{a:1}; // note', '{a:1};\n// x', '{a:1};;', '{a:1} ; /* c */ ;']) {
    it(`accepts ${JSON.stringify(src)}`, () => {
      expect(parseQueryObject(src)).toEqual({ a: 1 })
    })
  }

  it('still rejects a second statement', () => {
    expect(() => parseQueryObject('{a:1}; {b:2}')).toThrow(/single expression/)
  })
})

describe('upgraded minor: DBRef extra fields survive format → parse', () => {
  it('round-trips fields', () => {
    const oid = ObjectId.createFromHexString('65f0a1b2c3d4e5f601234567')
    for (const ref of [
      new DBRef('c', oid, 'db', { extra: 1 }),
      new DBRef('c', oid, undefined, { extra: 'x' }),
    ]) {
      const doc = { ref }
      expect(toWire(parseShellExpression(formatShell(doc)))).toBe(toWire(doc))
    }
  })
})
