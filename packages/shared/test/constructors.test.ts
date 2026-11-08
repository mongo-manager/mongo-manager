// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  BSONRegExp,
  Binary,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from 'bson'
import { parseQueryObject, parseShellExpression } from '../src/query/parse'
import { QueryParseError } from '../src/query/errors'
import { bsonTypeOf, toWire } from '../src/ejson'

const HEX = '65f0a1b2c3d4e5f601234567'

describe('BSON constructors', () => {
  it('ObjectId', () => {
    const v = parseShellExpression(`ObjectId("${HEX}")`) as ObjectId
    expect(v.toHexString()).toBe(HEX)
    expect(bsonTypeOf(parseShellExpression('new ObjectId()'))).toBe('objectId')
    expect(() => parseShellExpression('ObjectId("user_0000001")')).toThrow(/24-character hex/)
  })

  it('dates', () => {
    expect((parseShellExpression('ISODate("2024-02-29T12:00:00Z")') as Date).toISOString()).toBe(
      '2024-02-29T12:00:00.000Z',
    )
    expect((parseShellExpression('new Date("2024-01-02")') as Date).toISOString()).toBe(
      '2024-01-02T00:00:00.000Z',
    )
    expect((parseShellExpression('new Date(0)') as Date).getTime()).toBe(0)
    expect((parseShellExpression('new Date(2024, 0, 2)') as Date).toISOString()).toBe(
      '2024-01-02T00:00:00.000Z',
    )
    expect(() => parseShellExpression('new Date(NaN)')).toThrow(/date range/)
    expect(() => parseShellExpression('ISODate("not a date")')).toThrow(/invalid date/)
  })

  it('numeric wrappers', () => {
    expect(parseShellExpression('NumberInt(5)')).toEqual(new Int32(5))
    expect(parseShellExpression('NumberInt("7")')).toEqual(new Int32(7))
    expect(() => parseShellExpression('NumberInt(2147483648)')).toThrow(/32-bit/)
    expect((parseShellExpression('NumberLong("9223372036854775807")') as Long).toString()).toBe(
      '9223372036854775807',
    )
    expect((parseShellExpression('NumberLong(42)') as Long).toString()).toBe('42')
    expect(() => parseShellExpression('NumberLong(9007199254740993)')).toThrow(/safe integer/)
    expect(() => parseShellExpression('NumberLong("9223372036854775808")')).toThrow(/out of range/)
    expect((parseShellExpression('NumberDecimal("1.10")') as Decimal128).toString()).toBe('1.10')
    expect((parseShellExpression('Decimal128("2")') as Decimal128).toString()).toBe('2')
    expect(parseShellExpression('Double(1)')).toEqual(new Double(1))
    expect(Object.is((parseShellExpression('Double(-0)') as Double).value, -0)).toBe(true)
  })

  it('binary, uuid, timestamp, keys, regex, dbref', () => {
    expect(bsonTypeOf(parseShellExpression('UUID("0f8fad5b-d9cb-469f-a165-70867728950e")'))).toBe('uuid')
    expect(() => parseShellExpression('UUID("nope")')).toThrow(QueryParseError)
    const bin = parseShellExpression('BinData(0, "AQID")') as Binary
    expect([...bin.buffer]).toEqual([1, 2, 3])
    expect(() => parseShellExpression('BinData(0, "***")')).toThrow(/base64/)
    const ts = parseShellExpression('Timestamp({ t: 1700000000, i: 7 })') as Timestamp
    expect([ts.t, ts.i]).toEqual([1700000000, 7])
    expect((parseShellExpression('Timestamp(1, 2)') as Timestamp).i).toBe(2)
    expect(parseShellExpression('MinKey()')).toBeInstanceOf(MinKey)
    expect(parseShellExpression('MaxKey')).toBeInstanceOf(MaxKey)
    const re = parseShellExpression('RegExp("^a", "xi")') as BSONRegExp
    expect([re.pattern, re.options]).toEqual(['^a', 'ix'])
    const ref = parseShellExpression(`DBRef("users", ObjectId("${HEX}"), "app")`) as DBRef
    expect([ref.collection, ref.db]).toEqual(['users', 'app'])
  })

  it('reports constructor errors at the call position', () => {
    try {
      parseShellExpression('{\n  _id: ObjectId("zz")\n}')
      expect.unreachable()
    } catch (e) {
      expect((e as QueryParseError).line).toBe(2)
      expect((e as QueryParseError).message).toMatch(/^ObjectId\(\):/)
    }
  })
})

describe('pasted Extended JSON', () => {
  it('converts canonical and relaxed EJSON wrappers into BSON types', () => {
    const v = parseQueryObject(
      `{"_id":{"$oid":"${HEX}"},"at":{"$date":"2024-01-02T00:00:00Z"},"n":{"$numberLong":"9223372036854775807"},` +
        `"d":{"$numberDecimal":"1.5"},"i":{"$numberInt":"3"},"f":{"$numberDouble":"1.0"},` +
        `"u":{"$uuid":"0f8fad5b-d9cb-469f-a165-70867728950e"},"ts":{"$timestamp":{"t":1,"i":2}},` +
        `"when":{"$date":{"$numberLong":"0"}}}`,
    )
    expect(bsonTypeOf(v._id)).toBe('objectId')
    expect(bsonTypeOf(v.at)).toBe('date')
    expect(bsonTypeOf(v.n)).toBe('long')
    expect(bsonTypeOf(v.d)).toBe('decimal128')
    expect(bsonTypeOf(v.i)).toBe('int32')
    expect(bsonTypeOf(v.f)).toBe('double')
    expect(bsonTypeOf(v.u)).toBe('uuid')
    expect(bsonTypeOf(v.ts)).toBe('timestamp')
    expect((v.when as Date).getTime()).toBe(0)
  })

  it('leaves query operators alone', () => {
    expect(toWire(parseQueryObject('{ name: { $regex: "a", $options: "i" }, n: { $gt: 1 } }'))).toBe(
      '{"name":{"$regex":"a","$options":"i"},"n":{"$gt":{"$numberInt":"1"}}}',
    )
  })

  it('rejects malformed wrappers with a parse error', () => {
    expect(() => parseQueryObject('{ n: { $numberLong: "abc" } }')).toThrow(QueryParseError)
  })
})

// Plan 1a deferred minors: what mongosh users type, and what an old mongoexport wrote.
describe('constructor edge cases', () => {
  it('Timestamp() with no arguments is the zero timestamp, as in mongosh', () => {
    for (const s of ['Timestamp()', 'new Timestamp()']) {
      expect(parseShellExpression(s)).toEqual(new Timestamp({ t: 0, i: 0 }))
    }
  })

  it('Double takes a number or a number written as text, nothing else', () => {
    expect(parseShellExpression('Double("1.5e3")')).toEqual(new Double(1500))
    expect(parseShellExpression('Double(" 2 ")')).toEqual(new Double(2))
    expect(Number.isNaN((parseShellExpression('Double("NaN")') as Double).value)).toBe(true)
    expect((parseShellExpression('Double("-Infinity")') as Double).value).toBe(-Infinity)
    for (const s of [
      'Double("")',
      'Double("  ")',
      'Double(null)',
      'Double("0x10")',
      'Double("1,5")',
      'Double(true)',
    ]) {
      expect(() => parseShellExpression(s), s).toThrow(QueryParseError)
    }
  })

  it('NumberDecimal() is zero; NumberDecimal(null) is refused', () => {
    expect((parseShellExpression('NumberDecimal()') as Decimal128).toString()).toBe('0')
    expect(() => parseShellExpression('NumberDecimal(null)')).toThrow(QueryParseError)
    expect(() => parseShellExpression('Decimal128(null)')).toThrow(QueryParseError)
  })

  it('reads the legacy $binary/$type form, $undefined and $dbPointer', () => {
    const bin = parseQueryObject('{ b: { $binary: "AQID", $type: "80" } }').b as Binary
    expect([bin.sub_type, ...bin.buffer]).toEqual([0x80, 1, 2, 3])
    expect(() => parseQueryObject('{ b: { $binary: "***", $type: "00" } }')).toThrow(QueryParseError)
    expect(() => parseQueryObject('{ b: { $binary: "AQID", $type: "zz" } }')).toThrow(QueryParseError)
    expect(parseQueryObject('{ u: { $undefined: true } }')).toEqual({ u: null })
    const pointer = parseQueryObject(`{ p: { $dbPointer: { $ref: "c", $id: { $oid: "${HEX}" } } } }`).p
    expect(bsonTypeOf(pointer)).not.toBe('object')
  })
})

// Review of the deferred fixes (M11-M13).
describe('constructor edge cases, reviewed', () => {
  it('reads NaN and Infinity only as JavaScript writes them', () => {
    for (const s of ['Double("infinity")', 'Double("-INFINITY")', 'Double("nan")']) {
      expect(() => parseShellExpression(s), s).toThrow(QueryParseError)
    }
    expect((parseShellExpression('Double("+Infinity")') as Double).value).toBe(Infinity)
    expect((parseShellExpression('Double("1E3")') as Double).value).toBe(1000)
  })

  it('takes $undefined: true only', () => {
    for (const v of ['false', '"x"', '1', 'null']) {
      expect(() => parseQueryObject(`{ u: { $undefined: ${v} } }`), v).toThrow(QueryParseError)
    }
  })

  it('names what is wrong with a malformed $dbPointer', () => {
    for (const v of ['1', '{}', '{ $ref: "c" }', '{ $ref: 1, $id: { $oid: "x" } }']) {
      expect(() => parseQueryObject(`{ p: { $dbPointer: ${v} } }`), v).toThrow(/\$dbPointer/)
    }
  })
})
