// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Decimal128, Double, Int32, Long, ObjectId } from 'bson'
import { convert, inferType, parseIsoDate } from '../src/transfer/infer'

const ok = (value: unknown, type: Parameters<typeof convert>[1]) =>
  convert(value, type, { allowUnusual: false })

describe('type inference (spec §5.2)', () => {
  it('picks the narrowest type every sample fits', () => {
    expect(inferType(['true', 'FALSE', ''])).toBe('boolean')
    expect(inferType(['1', '-2', '30'])).toBe('int32')
    expect(inferType(['1', '4294967296'])).toBe('int64')
    expect(inferType(['1', '2.5'])).toBe('double')
    expect(inferType(['2024-01-02', '2024-01-02T03:04:05Z'])).toBe('date')
    expect(inferType(['65a1b2c3d4e5f6a7b8c9d0e1'])).toBe('objectId')
    expect(inferType(['{"a":1}', '[1,2]'])).toBe('json')
    expect(inferType(['1', 'x'])).toBe('string')
    expect(inferType(['', null])).toBe('string')
    expect(inferType([1, 2.5])).toBe('double')
    expect(inferType([new Date(0)])).toBe('date')
  })

  it('keeps leading zeros and long digit strings exact (Review Focus 2)', () => {
    expect(inferType(['00123', '45'])).toBe('string')
    expect(inferType(['0', '0.5', '12'])).toBe('double')
    expect(inferType(['4111111111111111111'])).toBe('int64')
    expect(inferType(['41111111111111111111'])).toBe('decimal128')
    // Seventeen digits a double writes back as they are: a double; one more, a decimal.
    expect(inferType(['1234567890.1234567'])).toBe('double')
    expect(inferType(['1234567890.12345678'])).toBe('decimal128')
    // A double as JavaScript writes it is a double (review of the M1 fix, I1).
    expect(inferType(['0.30000000000000004', '1.5'])).toBe('double')
  })

  // Data review 2026-10-13 (M2): a leading + is a code (a phone number), not a number; a NaN or
  // Infinity among numbers keeps the column numeric.
  it('reads a leading + as a code, and NaN or Infinity among doubles as doubles', () => {
    expect(inferType(['+905321234567', '+905321234568'])).toBe('string')
    expect(inferType(['+5', '7'])).toBe('string')
    expect(inferType(['1.5', 'NaN', '-Infinity'])).toBe('double')
    expect(inferType(['NaN', 'NaN'])).toBe('string')
  })

  it('looks at only 64 characters for inference', () => {
    expect(inferType(['1'.repeat(65)])).toBe('string')
  })
})

describe('conversion (spec §5.3, §7 T17)', () => {
  it('converts to each type, failing instead of guessing', () => {
    expect(ok(' 42 ', 'int32')).toEqual({ ok: true, value: new Int32(42) })
    expect(ok('2147483648', 'int32').ok).toBe(false)
    expect(ok('9007199254740993', 'int64')).toEqual({ ok: true, value: Long.fromString('9007199254740993') })
    expect(ok(2 ** 53 + 2, 'int64').ok).toBe(false)
    expect(ok('1.5', 'double')).toEqual({ ok: true, value: new Double(1.5) })
    expect(ok('NaN', 'double').ok).toBe(true)
    expect(ok('NaN', 'int32').ok).toBe(false)
    expect(ok('0.1', 'decimal128')).toEqual({ ok: true, value: Decimal128.fromString('0.1') })
    expect(ok('yes', 'boolean')).toEqual({ ok: true, value: true })
    expect(ok('maybe', 'boolean').ok).toBe(false)
    expect(ok('2024-02-30', 'date').ok).toBe(false)
    expect(ok('2024-02-29 10:00', 'date')).toEqual({ ok: true, value: new Date('2024-02-29T10:00:00Z') })
    expect(ok('2024-02-29T10:00:00+03:00', 'date')).toEqual({
      ok: true,
      value: new Date('2024-02-29T07:00:00Z'),
    })
    expect(ok(5, 'date').ok).toBe(false)
    expect(ok('65a1b2c3d4e5f6a7b8c9d0e1', 'objectId')).toEqual({
      ok: true,
      value: new ObjectId('65a1b2c3d4e5f6a7b8c9d0e1'),
    })
    expect(ok('{"$date":"2024-01-01T00:00:00Z"}', 'json')).toEqual({
      ok: true,
      value: new Date('2024-01-01T00:00:00Z'),
    })
    expect(ok('{"__proto__":1}', 'json').ok).toBe(false)
    expect(ok(7, 'string')).toEqual({ ok: true, value: '7' })
    expect(ok(new Date('2024-01-01T00:00:00Z'), 'string')).toEqual({
      ok: true,
      value: '2024-01-01T00:00:00.000Z',
    })
    expect(ok('x', 'null')).toEqual({ ok: true, value: null })
  })

  // Data review 2026-10-13 (M1): a later row is converted by the rules the sample was read by — a
  // code is never a number, and a double is never given more digits than it holds.
  it('refuses to read a code or an over-long number as a number', () => {
    for (const type of ['int32', 'int64', 'double', 'decimal128'] as const) {
      expect([type, ok('02134', type).ok]).toEqual([type, false])
      expect([type, ok('+905321234567', type).ok]).toEqual([type, false])
    }
    expect(ok('12345678901234567', 'double').ok).toBe(false)
    // Review of the fix (I1): a double needs up to 17 digits to be written exactly; such text is it.
    expect(ok('0.30000000000000004', 'double')).toEqual({ ok: true, value: new Double(0.1 + 0.2) })
    expect(ok('1234567890123456', 'double')).toEqual({ ok: true, value: new Double(1234567890123456) })
    expect(ok('1.10', 'double')).toEqual({ ok: true, value: new Double(1.1) })
    expect(ok('2.5e-7', 'double')).toEqual({ ok: true, value: new Double(2.5e-7) })
    expect(ok('0.1000000000000000055', 'double').ok).toBe(false)
    expect(ok('123456789012345', 'double')).toEqual({ ok: true, value: new Double(123456789012345) })
    expect(ok('0', 'int32')).toEqual({ ok: true, value: new Int32(0) })
    expect(ok('0.5', 'double')).toEqual({ ok: true, value: new Double(0.5) })
    expect(ok('-12', 'int32')).toEqual({ ok: true, value: new Int32(-12) })
  })

  it('keeps values as read with keep: integers in int32 range as Int32, others as Double', () => {
    expect(ok(5, 'keep')).toEqual({ ok: true, value: new Int32(5) })
    expect(ok(5.5, 'keep')).toEqual({ ok: true, value: new Double(5.5) })
    expect(ok(4294967296, 'keep')).toEqual({ ok: true, value: new Double(4294967296) })
    expect(ok('text', 'keep')).toEqual({ ok: true, value: 'text' })
  })

  it('parses ISO dates strictly', () => {
    expect(parseIsoDate('2024-13-01')).toBeNull()
    expect(parseIsoDate('2024-01-01T24:00')).toBeNull()
    expect(parseIsoDate('2024-01-01T10:00+25:00')).toBeNull()
    expect(parseIsoDate('2024-01-01T10:00:00.123456789Z')).toEqual(new Date('2024-01-01T10:00:00.123Z'))
  })

  it('parses adversarial 64-character text quickly (T12)', () => {
    const started = Date.now()
    for (let i = 0; i < 2000; i++) {
      inferType(['1'.repeat(63) + 'x', '2024-01-01T' + '1'.repeat(53), '-'.repeat(64), '0.' + '0'.repeat(62)])
      parseIsoDate('2024-01-01T' + '1'.repeat(53))
    }
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
