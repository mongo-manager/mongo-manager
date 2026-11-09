// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { isUtf8 } from 'node:buffer'
import type { TextEncodingName } from '@mongo-manager/shared'
import { Errors } from '../errors'

export type TextEncoding = TextEncodingName

type Unicode = 'utf8' | 'utf16le' | 'utf16be'
const LABEL: Record<Unicode, string> = { utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be' }
export const isUnicode = (e: TextEncoding): e is Unicode => e === 'utf8' || e === 'utf16le' || e === 'utf16be'
const NAME: Record<TextEncoding, string> = {
  utf8: 'UTF-8',
  utf16le: 'UTF-16',
  utf16be: 'UTF-16',
  latin1: 'ISO-8859-1',
  windows1252: 'Windows-1252',
  windows1254: 'Windows-1254',
  iso88599: 'ISO-8859-9',
}

export function sniffEncoding(head: Uint8Array): { encoding: TextEncoding; bom: number } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf8', bom: 3 }
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf16le', bom: 2 }
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf16be', bom: 2 }
  return { encoding: 'utf8', bom: 0 }
}

const bad = (encoding: TextEncoding) =>
  Errors.badFile(`The file is not valid ${NAME[encoding]} text`, { reason: 'encoding' })

/**
 * W4.1: the code points of bytes 0x80–0x9F in Windows-1252 (WHATWG's table); 0 marks a byte the
 * code page leaves undefined, which is invalid text (spec §7 T11), never a guessed character.
 */
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0,
  0x017d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0, 0x017e, 0x0178,
]
/** Windows-1254 is Windows-1252 without Ž and ž, with the six Turkish letters of ISO-8859-9. */
const CP1254_HIGH = CP1252_HIGH.map((c, i) => (i === 0x0e || i === 0x1e ? 0 : c))
const TURKISH = new Map<number, number>([
  [0xd0, 0x011e], // Ğ
  [0xdd, 0x0130], // İ
  [0xde, 0x015e], // Ş
  [0xf0, 0x011f], // ğ
  [0xfd, 0x0131], // ı
  [0xfe, 0x015f], // ş
])

function singleByteTable(encoding: TextEncoding): Int32Array {
  const table = new Int32Array(256)
  for (let b = 0; b < 256; b++) table[b] = b
  if (encoding === 'windows1252' || encoding === 'windows1254') {
    const high = encoding === 'windows1252' ? CP1252_HIGH : CP1254_HIGH
    for (let i = 0; i < 32; i++) table[0x80 + i] = high[i] || -1
  }
  if (encoding === 'windows1254' || encoding === 'iso88599') for (const [b, c] of TURKISH) table[b] = c
  return table
}
const TABLES = new Map<TextEncoding, Int32Array>()
const tableOf = (encoding: TextEncoding): Int32Array => {
  let t = TABLES.get(encoding)
  if (!t) TABLES.set(encoding, (t = singleByteTable(encoding)))
  return t
}

/** A single-byte encoding: each byte is one character; an undefined byte throws, or is marked. */
class SingleByte {
  private readonly table: Int32Array
  constructor(
    private readonly encoding: TextEncoding,
    private readonly lenient: boolean,
  ) {
    this.table = tableOf(encoding)
  }

  write(chunk: Uint8Array): string {
    let out = ''
    const codes = new Uint16Array(Math.min(chunk.length, 8192))
    let n = 0
    for (let i = 0; i < chunk.length; i++) {
      const c = this.table[chunk[i]!]!
      if (c < 0 && !this.lenient) throw bad(this.encoding)
      codes[n++] = c < 0 ? INVALID_CODE : c
      if (n === codes.length) {
        out += String.fromCharCode(...codes)
        n = 0
      }
    }
    return out + String.fromCharCode(...codes.subarray(0, n))
  }

  end(): string {
    return ''
  }
}

/**
 * W4.1: the encoding the first bytes of a file look like — a byte order mark, UTF-16 by its zero
 * bytes, valid UTF-8, else the single-byte code page whose letters they hold (Windows-1254 when the
 * Turkish letters' bytes occur, else Windows-1252). A suggestion for the user, never applied alone.
 */
export function guessEncoding(head: Uint8Array): TextEncoding {
  const bom = sniffEncoding(head)
  if (bom.bom) return bom.encoding
  const pairs = Math.floor(Math.min(head.length, 4096) / 2)
  if (pairs >= 2) {
    let evenZero = 0
    let oddZero = 0
    for (let i = 0; i < pairs; i++) {
      if (head[2 * i] === 0) evenZero++
      if (head[2 * i + 1] === 0) oddZero++
    }
    if (oddZero / pairs >= 0.3 && evenZero / pairs < 0.05) return 'utf16le'
    if (evenZero / pairs >= 0.3 && oddZero / pairs < 0.05) return 'utf16be'
  }
  if (validIn('utf8', head)) return 'utf8'
  for (const b of head) if (TURKISH.has(b)) return 'windows1254'
  return 'windows1252'
}

/** Whether a file's head is text in the encoding (a sequence cut at its end is not counted). */
export function validIn(encoding: TextEncoding, head: Uint8Array): boolean {
  try {
    if (isUnicode(encoding))
      new TextDecoder(LABEL[encoding], { fatal: true, ignoreBOM: true }).decode(head, { stream: true })
    else new SingleByte(encoding, false).write(head)
    return true
  } catch {
    return false
  }
}

/** Text with invalid sequences replaced: only for sniffing a format, never for records. */
export function looseText(encoding: TextEncoding, bytes: Uint8Array): string {
  if (isUnicode(encoding)) return new TextDecoder(LABEL[encoding]).decode(bytes)
  return new SingleByte(encoding, true).write(bytes)
}

/** Spec §7 T11: an invalid sequence is an error, never U+FFFD. */
export class StrictDecoder {
  private readonly decoder: TextDecoder | SingleByte

  constructor(private readonly encoding: TextEncoding) {
    this.decoder = isUnicode(encoding)
      ? new TextDecoder(LABEL[encoding], { fatal: true, ignoreBOM: true })
      : new SingleByte(encoding, false)
  }

  write(chunk: Uint8Array): string {
    if (this.decoder instanceof SingleByte) return this.decoder.write(chunk)
    try {
      return this.decoder.decode(chunk, { stream: true })
    } catch {
      throw bad(this.encoding)
    }
  }

  end(): string {
    if (this.decoder instanceof SingleByte) return this.decoder.end()
    try {
      return this.decoder.decode()
    } catch {
      throw bad(this.encoding)
    }
  }
}

/**
 * What an invalid byte sequence becomes in lenient decoding: a lone low surrogate. Valid UTF-8 never
 * decodes to one, so a record holding it is refused as a row (spec §7 T11) — never U+FFFD.
 */
export const INVALID_TEXT = '\udfff'
const INVALID_CODE = 0xdfff

/** The valid range of each continuation byte after a UTF-8 lead byte (Unicode table 3-7). */
function utf8Ranges(lead: number): Array<[number, number]> | null {
  if (lead >= 0xc2 && lead <= 0xdf) return [[0x80, 0xbf]]
  if (lead === 0xe0)
    return [
      [0xa0, 0xbf],
      [0x80, 0xbf],
    ]
  if ((lead >= 0xe1 && lead <= 0xec) || lead === 0xee || lead === 0xef)
    return [
      [0x80, 0xbf],
      [0x80, 0xbf],
    ]
  if (lead === 0xed)
    return [
      [0x80, 0x9f],
      [0x80, 0xbf],
    ]
  if (lead === 0xf0)
    return [
      [0x90, 0xbf],
      [0x80, 0xbf],
      [0x80, 0xbf],
    ]
  if (lead >= 0xf1 && lead <= 0xf3)
    return [
      [0x80, 0xbf],
      [0x80, 0xbf],
      [0x80, 0xbf],
    ]
  if (lead === 0xf4)
    return [
      [0x80, 0x8f],
      [0x80, 0xbf],
      [0x80, 0xbf],
    ]
  return null
}

/** UTF-8 that turns each maximal invalid subpart into INVALID_TEXT and carries split sequences over. */
class LenientUtf8 {
  private carry = Buffer.alloc(0)

  write(chunk: Buffer, final = false): string {
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
    if (!final) {
      // A sequence cut by the chunk boundary waits for the next chunk.
      let cut = buf.length
      for (let back = 1; back <= 3 && back <= buf.length; back++) {
        const b = buf[buf.length - back]!
        if (b < 0x80) break
        if (b >= 0xc0) {
          const need = utf8Ranges(b)
          if (need && need.length >= back) cut = buf.length - back
          break
        }
      }
      this.carry = Buffer.from(buf.subarray(cut))
      return this.decode(buf.subarray(0, cut))
    }
    this.carry = Buffer.alloc(0)
    return this.decode(buf)
  }

  private decode(buf: Buffer): string {
    if (isUtf8(buf)) return buf.toString('utf8')
    let out = ''
    let run = 0
    let i = 0
    while (i < buf.length) {
      const b = buf[i]!
      if (b < 0x80) {
        i++
        continue
      }
      const ranges = utf8Ranges(b)
      let ok = ranges !== null
      let j = i + 1
      for (const [lo, hi] of ranges ?? []) {
        const c = buf[j]
        if (c === undefined || c < lo || c > hi) {
          ok = false
          break
        }
        j++
      }
      if (ok) {
        i = j
        continue
      }
      out += buf.toString('utf8', run, i) + INVALID_TEXT
      // The maximal subpart: the lead and the continuation bytes that fit, never the byte that broke it.
      i = Math.max(i + 1, j)
      run = i
    }
    return out + buf.toString('utf8', run)
  }
}

/** UTF-16 as code units: lone surrogates stay lone (and are refused downstream); an odd last byte is invalid. */
class LenientUtf16 {
  private carry = Buffer.alloc(0)

  constructor(private readonly bigEndian: boolean) {}

  write(chunk: Buffer, final = false): string {
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
    const even = buf.length - (buf.length % 2)
    this.carry = Buffer.from(buf.subarray(even))
    const units = Buffer.from(buf.subarray(0, even))
    if (this.bigEndian) units.swap16()
    let text = units.toString('utf16le')
    if (final && this.carry.length) {
      text += INVALID_TEXT
      this.carry = Buffer.alloc(0)
    }
    return text
  }
}

interface Decoder {
  write(chunk: Buffer): string
  end(): string
}

function decoderFor(encoding: TextEncoding, lenient: boolean): Decoder {
  if (!lenient) return new StrictDecoder(encoding)
  if (!isUnicode(encoding)) return new SingleByte(encoding, true)
  const d = encoding === 'utf8' ? new LenientUtf8() : new LenientUtf16(encoding === 'utf16be')
  return { write: (chunk) => d.write(chunk), end: () => d.write(Buffer.alloc(0), true) }
}

/**
 * Bytes to text. A byte order mark chooses the encoding unless one is given, and is dropped when it
 * belongs to the encoding used. Strict decoding (workbook parts) refuses the file at the first invalid
 * sequence; lenient decoding (CSV and JSON records) marks it with INVALID_TEXT so only that record fails.
 */
export async function* decodeText(
  source: AsyncIterable<Uint8Array>,
  encoding?: TextEncoding,
  opts: { lenient?: boolean } = {},
): AsyncGenerator<string> {
  let decoder: Decoder | undefined
  let pending = Buffer.alloc(0)
  const start = (bytes: Buffer): string => {
    const sniff = sniffEncoding(bytes)
    const use = encoding ?? sniff.encoding
    decoder = decoderFor(use, opts.lenient ?? false)
    // W4 review (minor): a byte order mark is never text — under a single-byte encoding it would lead
    // the first header ("ï»¿id"); it is dropped there too (the preview says what it means).
    return decoder.write(bytes.subarray(use === sniff.encoding || !isUnicode(use) ? sniff.bom : 0))
  }
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let text: string
    if (decoder) text = decoder.write(bytes)
    else {
      pending = Buffer.concat([pending, bytes])
      if (pending.length < 3) continue
      text = start(pending)
    }
    if (text) yield text
  }
  if (!decoder) {
    const text = start(pending)
    if (text) yield text
  }
  const tail = decoder!.end()
  if (tail) yield tail
}
