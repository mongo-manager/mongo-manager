// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { toWire } from '@mongo-manager/shared/browser'
import { editableType, editText, parseScalar } from '../src/documents/scalarEdit'
import { decodeValue } from '../src/documents/values'

const wire = (r: ReturnType<typeof parseScalar>) => (r.ok ? toWire(r.value) : `error:${r.error}`)

describe('typed inline editing (phase 1g-1, Review Focus 2)', () => {
  it('keeps int32 within its range', () => {
    expect(wire(parseScalar('int32', ' 7 '))).toBe('{"$numberInt":"7"}')
    expect(wire(parseScalar('int32', '-2147483648'))).toBe('{"$numberInt":"-2147483648"}')
    for (const bad of ['2147483648', '1.5', '', 'x', '1e3', '0x10'])
      expect(parseScalar('int32', bad), bad).toMatchObject({ ok: false, error: 'int32' })
  })

  it('keeps doubles finite and typed as double even when whole', () => {
    expect(wire(parseScalar('double', '5'))).toBe('{"$numberDouble":"5.0"}')
    expect(wire(parseScalar('double', '-1.25e2'))).toBe('{"$numberDouble":"-125.0"}')
    for (const bad of ['NaN', 'Infinity', '1e400', '', 'abc', '1,5'])
      expect(parseScalar('double', bad), bad).toMatchObject({ ok: false, error: 'double' })
  })

  it('keeps longs exact over the whole 64-bit range', () => {
    expect(wire(parseScalar('long', '9223372036854775807'))).toBe('{"$numberLong":"9223372036854775807"}')
    expect(wire(parseScalar('long', '-9223372036854775808'))).toBe('{"$numberLong":"-9223372036854775808"}')
    for (const bad of ['9223372036854775808', '1.0', ''])
      expect(parseScalar('long', bad), bad).toMatchObject({ ok: false, error: 'long' })
  })

  it('checks decimals, booleans, dates, object ids and null', () => {
    expect(wire(parseScalar('decimal128', '1.10'))).toBe('{"$numberDecimal":"1.10"}')
    expect(parseScalar('decimal128', '1..0')).toMatchObject({ ok: false, error: 'decimal128' })
    expect(wire(parseScalar('boolean', 'false'))).toBe('false')
    expect(parseScalar('boolean', 'yes')).toMatchObject({ ok: false, error: 'boolean' })
    expect(wire(parseScalar('date', '2024-01-02T03:04:05.006Z'))).toBe(
      '{"$date":{"$numberLong":"1704164645006"}}',
    )
    expect(wire(parseScalar('date', '2024-01-02T05:04:05+02:00'))).toBe(
      '{"$date":{"$numberLong":"1704164645000"}}',
    )
    for (const bad of ['2024-02-30T00:00:00Z', '2024-01-02', 'yesterday'])
      expect(parseScalar('date', bad), bad).toMatchObject({ ok: false, error: 'date' })
    expect(wire(parseScalar('objectId', '65F0A1B2C3D4E5F601234567'))).toBe(
      '{"$oid":"65f0a1b2c3d4e5f601234567"}',
    )
    expect(parseScalar('objectId', '65f0')).toMatchObject({ ok: false, error: 'objectId' })
    expect(wire(parseScalar('null', 'null'))).toBe('null')
    expect(parseScalar('null', '')).toMatchObject({ ok: false, error: 'null' })
    expect(wire(parseScalar('string', '  kept as typed '))).toBe('"  kept as typed "')
  })

  it('knows which types are edited inline and starts from their current text', () => {
    for (const type of [
      'string',
      'int32',
      'double',
      'long',
      'decimal128',
      'boolean',
      'date',
      'objectId',
      'null',
    ])
      expect(editableType(type as never), type).toBe(true)
    for (const type of ['object', 'array', 'binary', 'regex', 'timestamp'])
      expect(editableType(type as never), type).toBe(false)
    expect(editText(decodeValue({ $numberDouble: '5.0' }))).toBe('5')
    expect(editText(decodeValue({ $date: { $numberLong: '1704164645006' } }))).toBe(
      '2024-01-02T03:04:05.006Z',
    )
    expect(editText(decodeValue({ $oid: '65f0a1b2c3d4e5f601234567' }))).toBe('65f0a1b2c3d4e5f601234567')
    expect(editText(decodeValue({ $numberLong: '9223372036854775807' }))).toBe('9223372036854775807')
    expect(editText('text')).toBe('text')
    expect(editText(null)).toBe('null')
  })
})

describe('-0 keeps its sign (final review Minor 1)', () => {
  it('parses and shows negative zero', () => {
    expect(wire(parseScalar('double', '-0'))).toBe('{"$numberDouble":"-0.0"}')
    expect(editText(decodeValue({ $numberDouble: '-0.0' }))).toBe('-0')
  })
})
