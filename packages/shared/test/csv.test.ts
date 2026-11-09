// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { MAX_CSV_COLUMNS, csvCell, csvFile, flattenDocument, toCsv } from '../src/csv'

/** Phase 3a-2 spec §3.4 (A10): CSV export of shell results, safe to open in a spreadsheet. */
describe('csvCell', () => {
  it('neutralises cells a spreadsheet would run as a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-1')).toBe("'-1")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\tx')).toBe("'\tx")
    expect(csvCell('\rx')).toBe('"\'\rx"')
  })

  it('quotes per RFC 4180', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell(' pad ')).toBe('" pad "')
  })

  it('prints EJSON values as a person expects', () => {
    expect(csvCell({ $numberInt: '-5' })).toBe('-5')
    expect(csvCell({ $numberDouble: '-1.5' })).toBe('-1.5')
    expect(csvCell({ $numberLong: '9007199254740993' })).toBe('9007199254740993')
    expect(csvCell({ $numberDecimal: '-0.1' })).toBe('-0.1')
    expect(csvCell({ $oid: '0123456789abcdef01234567' })).toBe('0123456789abcdef01234567')
    expect(csvCell({ $date: { $numberLong: '0' } })).toBe('1970-01-01T00:00:00.000Z')
    const binary = { $binary: { base64: 'AA==', subType: '00' } }
    expect(csvCell(binary)).toBe(`"${JSON.stringify(binary).replace(/"/g, '""')}"`)
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(true)).toBe('true')
  })

  it('guards a numeric-looking string that is not a number wrapper', () => {
    expect(csvCell('-5')).toBe("'-5")
  })

  it('treats only a real number inside a number wrapper as numeric', () => {
    // A document may hold a $-prefixed field (MongoDB 5.0+): a fake wrapper is not a number.
    expect(csvCell({ $numberDouble: '-1+1' })).toBe("'-1+1")
    expect(csvCell({ $numberDouble: '-Infinity' })).toBe("'-Infinity")
    expect(csvCell({ $numberDouble: 'NaN' })).toBe('NaN')
    expect(csvCell({ $numberDouble: '-1.5e-3' })).toBe('-1.5e-3')
  })
})

describe('flattenDocument', () => {
  it('uses dotted paths and keeps EJSON wrappers and arrays as leaves', () => {
    const flat = flattenDocument({
      a: { b: { c: { $numberInt: '1' } } },
      arr: [{ $numberInt: '1' }, { $numberInt: '2' }],
      id: { $oid: '0123456789abcdef01234567' },
    })
    expect(Object.keys(flat)).toEqual(['a.b.c', 'arr', 'id'])
    expect(flat['id']).toEqual({ $oid: '0123456789abcdef01234567' })
    expect(flat['arr']).toEqual([{ $numberInt: '1' }, { $numberInt: '2' }])
  })
})

describe('toCsv', () => {
  it('unions the headers in first-seen order with CRLF rows', () => {
    const csv = toCsv([
      { a: { $numberInt: '1' }, b: 'x' },
      { c: 'y', a: { $numberInt: '2' } },
    ])
    expect(csv).toBe('a,b,c\r\n1,x,\r\n2,,y\r\n')
  })

  it('guards header cells too', () => {
    expect(toCsv([{ '=cmd': 'v' }]).split('\r\n')[0]).toBe("'=cmd")
  })

  it('keeps at most 500 columns', () => {
    const doc: Record<string, unknown> = {}
    for (let i = 0; i < MAX_CSV_COLUMNS + 20; i++) doc[`f${i}`] = i
    const header = toCsv([doc]).split('\r\n')[0]!
    expect(header.split(',')).toHaveLength(MAX_CSV_COLUMNS)
  })

  it('keeps a field named __proto__ as a column (final review M1)', () => {
    const doc = JSON.parse('{"__proto__":"p","constructor":"c","a":{"__proto__":"q"}}') as Record<
      string,
      unknown
    >
    expect(toCsv([doc])).toBe('__proto__,constructor,a.__proto__\r\np,c,q\r\n')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('csvFile (final review M2)', () => {
  it('starts with a UTF-8 byte order mark so spreadsheets read the text right', () => {
    const file = csvFile([{ name: 'Çağrı' }])
    expect(file.text).toBe('\uFEFFname\r\nÇağrı\r\n')
    expect(file.droppedColumns).toBe(0)
  })

  it('says how many columns were left out', () => {
    const doc: Record<string, unknown> = {}
    for (let i = 0; i < MAX_CSV_COLUMNS + 20; i++) doc[`f${i}`] = i
    expect(csvFile([doc, { extra: 1 }]).droppedColumns).toBe(21)
  })
})
