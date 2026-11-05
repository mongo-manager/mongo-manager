// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { decodeDocument } from '../src/documents/values'
import {
  LONG_FROM,
  UnknownStandIn,
  longValues,
  readEditText,
  standIn,
  writeEditText,
} from '../src/documents/page/editText'

/**
 * User report 2026-11-05: a document holding an image as base64 filled the edit view with thousands
 * of lines of it, and scrolling dragged. A string of LONG_FROM characters or more is written in the
 * text as a short stand-in (its size and a hash of it) and read back as the value it stands for; a
 * stand-in that stands for nothing known is refused, never saved as a string.
 */
const photo = `data:image/png;base64,${'iVBORw0KGgo'.repeat(5000)}`
const doc = () => ({
  _id: decodeDocument({ id: { $oid: '65f0a1b2c3d4e5f601234567' } }).id,
  name: 'Guest 1',
  photo,
  stays: [
    { room: 101, scan: photo },
    { room: 102, note: 'quiet' },
  ],
})

describe('the text of the edit view', () => {
  it('writes the keys quoted and a long string as its stand-in', () => {
    const text = writeEditText(doc(), longValues(doc()))
    expect(text).toContain('"name": "Guest 1"')
    expect(text).toContain(`"photo": "${standIn(photo)}"`)
    expect(text).not.toContain('iVBORw0KGgo')
    expect(text.length).toBeLessThan(500)
    expect(standIn(photo)).toMatch(/^⟨54 KB · [0-9a-f]{16}⟩$/)
  })

  it('reads the text back as the document, each stand-in as its value', () => {
    const longs = longValues(doc())
    expect(readEditText(writeEditText(doc(), longs), longs)).toEqual(doc())
    const edited = writeEditText(doc(), longs).replace('"Guest 1"', '"Guest 2"')
    expect(readEditText(edited, longs)).toEqual({ ...doc(), name: 'Guest 2' })
  })

  it('leaves a string shorter than the limit as it is', () => {
    const short = 'x'.repeat(LONG_FROM - 1)
    const value = { a: short, b: 'x'.repeat(LONG_FROM) }
    const text = writeEditText(value, longValues(value))
    expect(text).toContain(short)
    expect(text).toContain(standIn(value.b))
  })

  it('refuses a stand-in that stands for nothing it knows', () => {
    const text = writeEditText(doc(), longValues(doc()))
    expect(() => readEditText(text, longValues({}))).toThrow(UnknownStandIn)
    try {
      readEditText(text, longValues({}))
    } catch (e) {
      expect((e as UnknownStandIn).standIn).toBe(standIn(photo))
    }
  })

  it('keeps a string of the document that only looks like a stand-in', () => {
    const value = { note: '⟨12 KB · 0123456789abcdef⟩' }
    const longs = longValues(value)
    expect(readEditText(writeEditText(value, longs), longs)).toEqual(value)
  })

  it('never folds two different strings that share a stand-in', () => {
    const longs = new Map([[standIn(photo), photo]])
    // A map built from the sources leaves a shared stand-in out: both strings stay whole.
    const a = 'a'.repeat(LONG_FROM)
    expect(longValues({ a }).get(standIn(a))).toBe(a)
    expect(readEditText(writeEditText({ photo }, longs), longs)).toEqual({ photo })
  })

  it('reads a text written with keys unquoted, as a draft kept from before', () => {
    expect(readEditText('{ name: "Guest 1" }', longValues({}))).toEqual({ name: 'Guest 1' })
  })
})
