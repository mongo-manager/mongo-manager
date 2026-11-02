import { describe, expect, it } from 'vitest'
import {
  BSONRegExp,
  Binary,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from 'bson'
import { bsonTypeOf, deserializeValue, fromWire, serializeValue, toWire } from '../src/ejson'

const sample = () => ({
  oid: ObjectId.createFromHexString('65f0a1b2c3d4e5f601234567'),
  int: new Int32(42),
  dbl: new Double(1),
  negZero: new Double(-0),
  nan: new Double(NaN),
  inf: new Double(Infinity),
  long: Long.fromString('9223372036854775807'),
  dec: Decimal128.fromString('12345.678901234567890123456789'),
  date: new Date('2024-02-29T12:34:56.789Z'),
  uuid: new UUID('0f8fad5b-d9cb-469f-a165-70867728950e'),
  bin: new Binary(new Uint8Array([1, 2, 3]), 128),
  ts: new Timestamp({ t: 1700000000, i: 7 }),
  re: new BSONRegExp('^a.b$', 'imx'),
  min: new MinKey(),
  max: new MaxKey(),
  ref: new DBRef('users', ObjectId.createFromHexString('65f0a1b2c3d4e5f601234568'), 'app'),
  code: new Code('function () { return 1 }'),
  nested: { arr: [new Int32(1), 'two', null, true] },
})

describe('EJSON wire helpers', () => {
  it('round-trips every BSON type losslessly', () => {
    const wire = toWire(sample())
    expect(toWire(fromWire(wire))).toBe(wire)
  })

  it('round-trips through the object form too', () => {
    const obj = serializeValue(sample())
    expect(JSON.parse(JSON.stringify(obj))).toEqual(obj)
    expect(toWire(deserializeValue(obj))).toBe(toWire(sample()))
  })

  it('keeps 1.0 as a double and 1 as an int32', () => {
    expect(toWire({ a: new Double(1), b: 1 })).toBe('{"a":{"$numberDouble":"1.0"},"b":{"$numberInt":"1"}}')
  })

  it('preserves Long precision beyond 2^53', () => {
    const v = fromWire<{ n: Long }>('{"n":{"$numberLong":"9007199254740993"}}')
    expect(v.n.toString()).toBe('9007199254740993')
  })

  it('returns wrapper classes, not plain numbers', () => {
    const v = fromWire<{ i: unknown; d: unknown }>('{"i":{"$numberInt":"5"},"d":{"$numberDouble":"5.0"}}')
    expect(bsonTypeOf(v.i)).toBe('int32')
    expect(bsonTypeOf(v.d)).toBe('double')
  })
})

describe('bsonTypeOf', () => {
  it('names every BSON type', () => {
    const s = sample()
    expect(bsonTypeOf(s.oid)).toBe('objectId')
    expect(bsonTypeOf(s.int)).toBe('int32')
    expect(bsonTypeOf(s.dbl)).toBe('double')
    expect(bsonTypeOf(s.long)).toBe('long')
    expect(bsonTypeOf(s.dec)).toBe('decimal128')
    expect(bsonTypeOf(s.date)).toBe('date')
    expect(bsonTypeOf(s.uuid)).toBe('uuid')
    expect(bsonTypeOf(s.bin)).toBe('binary')
    expect(bsonTypeOf(s.ts)).toBe('timestamp')
    expect(bsonTypeOf(s.re)).toBe('regex')
    expect(bsonTypeOf(/x/i)).toBe('regex')
    expect(bsonTypeOf(s.min)).toBe('minKey')
    expect(bsonTypeOf(s.max)).toBe('maxKey')
    expect(bsonTypeOf(s.ref)).toBe('dbref')
    expect(bsonTypeOf(s.code)).toBe('code')
    expect(bsonTypeOf(s.nested)).toBe('object')
    expect(bsonTypeOf(s.nested.arr)).toBe('array')
    expect(bsonTypeOf(null)).toBe('null')
    expect(bsonTypeOf(undefined)).toBe('undefined')
    expect(bsonTypeOf('x')).toBe('string')
    expect(bsonTypeOf(true)).toBe('boolean')
    expect(bsonTypeOf(10n)).toBe('long')
  })

  it('classifies plain numbers the way the BSON serializer does', () => {
    expect(bsonTypeOf(5)).toBe('int32')
    expect(bsonTypeOf(-2147483648)).toBe('int32')
    expect(bsonTypeOf(2147483648)).toBe('double')
    expect(bsonTypeOf(5.5)).toBe('double')
    expect(bsonTypeOf(-0)).toBe('double')
    expect(bsonTypeOf(NaN)).toBe('double')
  })

  it('treats a 16-byte subtype-4 Binary as uuid and other subtype-4 data as binary', () => {
    expect(bsonTypeOf(new Binary(new Uint8Array(16), 4))).toBe('uuid')
    expect(bsonTypeOf(new Binary(new Uint8Array(3), 4))).toBe('binary')
  })
})
