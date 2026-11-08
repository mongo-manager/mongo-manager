// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Decimal128, EJSON, Int32, Long } from 'bson'
import { ejsonText } from '../src/transfer/bson-kind'
import { outCell } from '../src/transfer/flatten'

/**
 * Data review 2026-10-13 (M4): relaxed Extended JSON writes a Long as a plain number, which past 2^53
 * is not the same number. The relaxed form keeps such a Long exact — the JSON export opted into, and
 * nested values in CSV, XLSX and SQL cells.
 */
describe('relaxed Extended JSON', () => {
  const big = Long.fromString('9007199254740993')
  it('keeps a Long past 2^53 exact, and writes the rest as readable as before', () => {
    const text = ejsonText(
      { big, small: Long.fromNumber(5), n: new Int32(2), d: Decimal128.fromString('1.10') },
      {
        relaxed: true,
      },
    )
    expect(JSON.parse(text)).toEqual({
      big: { $numberLong: '9007199254740993' },
      small: 5,
      n: 2,
      d: { $numberDecimal: '1.10' },
    })
    expect(String(EJSON.parse(text, { relaxed: false }).big)).toBe('9007199254740993')
    const negative = ejsonText([Long.fromString('-9007199254740993')], { relaxed: true })
    expect(JSON.parse(negative)).toEqual([{ $numberLong: '-9007199254740993' }])
  })

  // Review of the fix (Minor 2): a field named __proto__ beside such a Long is kept.
  it('keeps a field named __proto__ beside a Long it rewrites', () => {
    const doc = JSON.parse('{"__proto__": {"k": 1}, "big": 0}') as Record<string, unknown>
    doc.big = big
    expect(ejsonText(doc, { relaxed: true })).toBe(
      '{"__proto__":{"k":1},"big":{"$numberLong":"9007199254740993"}}',
    )
  })

  it('keeps it exact inside a cell', () => {
    expect(outCell({ big })).toEqual({ t: 'text', v: '{"big":{"$numberLong":"9007199254740993"}}' })
  })
})
