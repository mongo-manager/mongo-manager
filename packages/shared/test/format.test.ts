import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
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
import { formatShell } from '../src/query/format'
import { parseShellExpression } from '../src/query/parse'
import { toWire } from '../src/ejson'

const roundTrip = (v: unknown, indent?: number) =>
  toWire(parseShellExpression(formatShell(v, indent === undefined ? {} : { indent })))

describe('formatShell examples', () => {
  it('formats a document the way mongosh users expect', () => {
    const doc = {
      _id: ObjectId.createFromHexString('65f0a1b2c3d4e5f601234567'),
      n: new Int32(5),
      price: new Double(1),
      ratio: new Double(0.5),
      big: Long.fromString('9223372036854775807'),
      at: new Date('2024-01-02T03:04:05.006Z'),
      'odd key': true,
    }
    expect(formatShell(doc)).toBe(
      [
        '{',
        '  _id: ObjectId("65f0a1b2c3d4e5f601234567"),',
        '  n: 5,',
        '  price: Double(1),',
        '  ratio: 0.5,',
        '  big: NumberLong("9223372036854775807"),',
        '  at: ISODate("2024-01-02T03:04:05.006Z"),',
        '  "odd key": true',
        '}',
      ].join('\n'),
    )
    expect(formatShell({ a: [1, 2], b: {} }, { indent: 0 })).toBe('{ a: [1, 2], b: {} }')
  })

  it('round-trips the awkward cases', () => {
    const cases: unknown[] = [
      { d: new Double(-0) },
      { d: new Double(NaN), e: new Double(Infinity), f: new Double(-Infinity) },
      { d: new Double(1e300), e: new Double(5e-324) },
      { dec: Decimal128.fromString('NaN'), dec2: Decimal128.fromString('-1E+10') },
      {
        re: new BSONRegExp('a/b', ''),
        re2: new BSONRegExp('[', 'i'),
        re3: new BSONRegExp('x', 'x'),
        re4: /a.b/is,
      },
      { re5: new BSONRegExp('', '') },
      { u: new UUID('0f8fad5b-d9cb-469f-a165-70867728950e'), b: new Binary(new Uint8Array([0, 255]), 128) },
      { b4: new Binary(new Uint8Array(3), 4) },
      { ts: new Timestamp({ t: 4294967295, i: 0 }), min: new MinKey(), max: new MaxKey() },
      { ref: new DBRef('users', ObjectId.createFromHexString('65f0a1b2c3d4e5f601234567'), 'app') },
      { code: new Code('function () { return "}" }') },
      { __proto__x: 1, constructor: 2, 'line\nbreak': 'tab\tquote"', '': 'empty key', '1': 'numeric key' },
      { date: new Date(8.64e15), neg: new Date(-8.64e15) },
    ]
    for (const c of cases) {
      expect(roundTrip(c)).toBe(toWire(c))
      expect(roundTrip(c, 0)).toBe(toWire(c))
    }
  })

  it('round-trips an own __proto__ key', () => {
    const doc: Record<string, unknown> = {}
    Object.defineProperty(doc, '__proto__', {
      value: { x: new Int32(1) },
      enumerable: true,
      writable: true,
      configurable: true,
    })
    expect(roundTrip(doc)).toBe(toWire(doc))
  })

  it('formats invalid dates without throwing', () => {
    expect(formatShell(new Date(NaN))).toBe('new Date(NaN)')
  })
})

const key = fc
  .string({ maxLength: 8 })
  .filter((k) => !k.startsWith('$') && k !== '_bsontype' && k !== '__proto__')

const leaf = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 20 }),
  fc.boolean(),
  fc.constant(null),
  fc.integer({ min: -2147483648, max: 2147483647 }).map((n) => new Int32(n)),
  fc.double().map((d) => new Double(d)),
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map((b) => Long.fromBigInt(b)),
  fc
    .constantFrom('0', '1.5', '-1E+10', 'NaN', 'Infinity', '1234567890.123456789')
    .map((s) => Decimal128.fromString(s)),
  fc.date({ min: new Date(-8.64e15), max: new Date(8.64e15), noInvalidDate: true }),
  fc.uint8Array({ minLength: 12, maxLength: 12 }).map((b) => new ObjectId(b)),
  fc.uuid().map((u) => new UUID(u)),
  fc
    .tuple(fc.uint8Array({ maxLength: 20 }), fc.constantFrom(0, 4, 5, 128))
    .map(([bytes, sub]) => new Binary(bytes, sub)),
  fc
    .tuple(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 0xffffffff }))
    .map(([t, i]) => new Timestamp({ t, i })),
  fc
    .tuple(
      fc.constantFrom('a.b', '^x$', 'a/b', '(?i)x', '[', '', '\\d+'),
      fc.constantFrom('', 'i', 'im', 'x', 's', 'imsux'),
    )
    .map(([p, f]) => new BSONRegExp(p, f)),
  fc.constantFrom(new MinKey(), new MaxKey()),
)

const { value } = fc.letrec((tie) => ({
  value: fc.oneof({ depthSize: 'small', withCrossShrink: true }, leaf, tie('array'), tie('object')),
  array: fc.array(tie('value'), { maxLength: 4 }),
  object: fc.dictionary(key, tie('value'), { maxKeys: 4, noNullPrototype: true }),
}))

describe('formatShell property', () => {
  it('parse(format(v)) is lossless for arbitrary BSON documents', () => {
    fc.assert(
      fc.property(fc.dictionary(key, value, { maxKeys: 6, noNullPrototype: true }), (doc) => {
        expect(roundTrip(doc)).toBe(toWire(doc))
        expect(roundTrip(doc, 0)).toBe(toWire(doc))
      }),
      { numRuns: 500 },
    )
  })
})

// Plan 1a deferred minor: undefined was printed, and the parser refuses it.
describe('formatShell and undefined', () => {
  it('leaves out a field that is undefined and writes null in an array, as EJSON does', () => {
    const text = formatShell({ a: undefined, b: [undefined, 1], c: 2 })
    expect(text).not.toContain('undefined')
    expect(toWire(parseShellExpression(text))).toBe(toWire({ b: [null, 1], c: 2 }))
  })
})

// Review of the deferred fixes (M14): the shell prints undefined as mongosh does.
describe('formatShell and undefined alone', () => {
  it('shows undefined alone as undefined', () => {
    expect(formatShell(undefined)).toBe('undefined')
    expect(formatShell([undefined], { indent: 0 })).toBe('[null]')
  })
})
