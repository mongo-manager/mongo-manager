// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../errors'

const bad = (what: string) =>
  Errors.badFile(`A document in the backup is damaged: ${what}`, { reason: 'bson' })

/**
 * Spec §8 B2: walks a raw BSON document without allocating values — lengths, types, terminators
 * and nesting — so a forged document is refused before the driver or a parser sees it.
 */
export function scanBson(buf: Buffer, maxDepth: number): void {
  if (buf.length < 5 || buf.readInt32LE(0) !== buf.length) throw bad('length')
  const stack: number[] = [buf.length] // end offsets of the open documents
  let p = 4
  while (stack.length) {
    const end = stack[stack.length - 1]!
    if (p >= end) throw bad('unterminated document')
    const type = buf[p++]!
    if (type === 0) {
      if (p !== end) throw bad('document end')
      stack.pop()
      continue
    }
    const nameEnd = buf.indexOf(0, p)
    if (nameEnd < 0 || nameEnd >= end) throw bad('field name')
    p = nameEnd + 1
    const need = (n: number) => {
      if (p + n > end) throw bad('field value')
    }
    switch (type) {
      case 0x01: // double
      case 0x09: // UTC datetime
      case 0x11: // timestamp
      case 0x12: // int64
        need(8)
        p += 8
        break
      case 0x10: // int32
        need(4)
        p += 4
        break
      case 0x13: // decimal128
        need(16)
        p += 16
        break
      case 0x08: // bool
        need(1)
        if (buf[p]! > 1) throw bad('boolean')
        p += 1
        break
      case 0x0a: // null
      case 0x06: // undefined (deprecated)
      case 0x7f: // max key
      case 0xff: // min key
        break
      case 0x07: // ObjectId
        need(12)
        p += 12
        break
      case 0x02: // string
      case 0x0d: // JavaScript code
      case 0x0e: {
        // symbol
        need(4)
        const n = buf.readInt32LE(p)
        if (n < 1 || p + 4 + n > end || buf[p + 4 + n - 1] !== 0) throw bad('string')
        p += 4 + n
        break
      }
      case 0x05: {
        // binary
        need(5)
        const n = buf.readInt32LE(p)
        if (n < 0 || p + 5 + n > end) throw bad('binary')
        p += 5 + n
        break
      }
      case 0x0b: {
        // regex: two C strings
        const a = buf.indexOf(0, p)
        if (a < 0 || a >= end) throw bad('regex')
        const b = buf.indexOf(0, a + 1)
        if (b < 0 || b >= end) throw bad('regex')
        p = b + 1
        break
      }
      case 0x0c: {
        // DBPointer (deprecated): string + 12 bytes
        need(4)
        const n = buf.readInt32LE(p)
        if (n < 1 || p + 4 + n + 12 > end) throw bad('dbpointer')
        p += 4 + n + 12
        break
      }
      case 0x0f: {
        // code with scope: int32 total, string, document
        need(4)
        const n = buf.readInt32LE(p)
        if (n < 14 || p + n > end) throw bad('code with scope')
        p += n
        break
      }
      case 0x03: // document
      case 0x04: {
        // array
        need(5)
        const n = buf.readInt32LE(p)
        if (n < 5 || p + n > end) throw bad('embedded document')
        if (stack.length >= maxDepth) throw bad(`nested more than ${maxDepth} levels`)
        stack.push(p + n)
        p += 4
        break
      }
      default:
        throw bad(`unknown type 0x${type.toString(16)}`)
    }
  }
  if (p !== buf.length) throw bad('trailing bytes')
}
