import { DBRef, Decimal128, Double, EJSON, Long, type Document, type ObjectId } from 'bson'
import { Errors } from '../../errors'
import { MAX_DEPTH, MAX_FIELDS, MAX_RECORD_CHARS } from '../limits'
import type { DocSource, RecordFailure } from './types'

/** One record's problem: the record is reported and skipped, the file goes on. */
export class RecordError extends Error {}

const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype'])
/** Spec §7 T9–T10: names MongoDB accepts that are refused unless the import allows them. */
export const isUnusualKey = (key: string): boolean =>
  key.startsWith('$') || key.includes('.') || DANGEROUS.has(key)

/** The first keys of EJSON value wrappers (canonical and relaxed). */
const WRAPPERS = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$regularExpression',
  '$timestamp',
  '$symbol',
  '$code',
  '$minKey',
  '$maxKey',
  '$dbPointer',
  '$undefined',
  '$ref',
])

class NumberText {
  constructor(readonly text: string) {}
}
type Entries = Array<[string, Node]>
type Node = string | NumberText | boolean | null | Node[] | { entries: Entries }

const INT = /^-?(0|[1-9]\d*)$/
const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y
const INT32_MIN = -2147483648n
const INT32_MAX = 2147483647n
const INT64_MIN = -9223372036854775808n
const INT64_MAX = 9223372036854775807n
const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/** Plain JSON numbers by size (spec §7 T17): int32, Long, Decimal128 for integers; Double otherwise. */
function number(text: string): unknown {
  if (text === '-0') return new Double(-0)
  if (INT.test(text)) {
    // More than 19 digits can only be a Decimal128 (34 digits at most): never a BigInt of millions
    // of digits, whose parse is quadratic (final review I10).
    if (text.length - (text.startsWith('-') ? 1 : 0) > 19) {
      if (text.length <= 35)
        try {
          return Decimal128.fromString(text)
        } catch {
          // out of range: below
        }
      throw new RecordError(`The number ${text.slice(0, 40)} is out of range`)
    }
    const big = BigInt(text)
    if (big >= INT32_MIN && big <= INT32_MAX) return Number(big)
    if (big >= INT64_MIN && big <= INT64_MAX) return Long.fromBigInt(big)
    try {
      return Decimal128.fromString(text)
    } catch {
      throw new RecordError(`The number ${text.slice(0, 40)} is out of range`)
    }
  }
  const n = Number(text)
  if (!Number.isFinite(n)) throw new RecordError(`The number ${text.slice(0, 40)} is out of range`)
  return new Double(n)
}

/** A recursive-descent JSON parser: strict syntax, bounded depth and fields, objects as ordered entries. */
class Parser {
  private i = 0
  private fields = 0

  constructor(private readonly s: string) {}

  fail(what: string): never {
    throw new RecordError(`${what} at character ${this.i + 1}`)
  }

  ws(): void {
    for (;;) {
      const c = this.s.charCodeAt(this.i)
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) this.i++
      else return
    }
  }

  done(): void {
    this.ws()
    if (this.i !== this.s.length) this.fail('Unexpected text after the value')
  }

  value(depth: number): Node {
    this.ws()
    const c = this.s[this.i]
    if (c === '{') return this.object(depth + 1)
    if (c === '[') return this.array(depth + 1)
    if (c === '"') return this.string()
    if (this.s.startsWith('true', this.i)) {
      this.i += 4
      return true
    }
    if (this.s.startsWith('false', this.i)) {
      this.i += 5
      return false
    }
    if (this.s.startsWith('null', this.i)) {
      this.i += 4
      return null
    }
    NUMBER.lastIndex = this.i
    const hit = NUMBER.exec(this.s)
    if (!hit || hit[0] === '' || hit[0] === '-') this.fail('Unexpected character')
    this.i += hit[0].length
    return new NumberText(hit[0])
  }

  private object(depth: number): { entries: Entries } {
    if (depth > MAX_DEPTH) this.fail('Nested deeper than 100 levels')
    this.i++
    const entries: Entries = []
    const seen = new Set<string>()
    this.ws()
    if (this.s[this.i] === '}') {
      this.i++
      return { entries }
    }
    for (;;) {
      this.ws()
      if (this.s[this.i] !== '"') this.fail('Expected a field name')
      const key = this.string()
      if (key.includes('\0')) this.fail('A field name holds a NUL character')
      if (seen.has(key)) this.fail(`The field "${key.slice(0, 100)}" appears twice`)
      seen.add(key)
      if (++this.fields > MAX_FIELDS) this.fail('More than 10 000 fields')
      this.ws()
      if (this.s[this.i] !== ':') this.fail('Expected ":"')
      this.i++
      entries.push([key, this.value(depth)])
      this.ws()
      const c = this.s[this.i++]
      if (c === '}') return { entries }
      if (c !== ',') this.fail('Expected "," or "}"')
    }
  }

  private array(depth: number): Node[] {
    if (depth > MAX_DEPTH) this.fail('Nested deeper than 100 levels')
    this.i++
    const out: Node[] = []
    this.ws()
    if (this.s[this.i] === ']') {
      this.i++
      return out
    }
    for (;;) {
      out.push(this.value(depth))
      this.ws()
      const c = this.s[this.i++]
      if (c === ']') return out
      if (c !== ',') this.fail('Expected "," or "]"')
    }
  }

  private string(): string {
    this.i++
    let out = ''
    let from = this.i
    for (;;) {
      const c = this.s.charCodeAt(this.i)
      if (Number.isNaN(c)) this.fail('A string never ends')
      if (c === 0x22) {
        out += this.s.slice(from, this.i)
        this.i++
        break
      }
      if (c < 0x20) this.fail('A control character inside a string')
      if (c === 0x5c) {
        out += this.s.slice(from, this.i)
        const e = this.s[this.i + 1]
        const hex = this.s.slice(this.i + 2, this.i + 6)
        if (e !== undefined && e in ESCAPES) {
          out += ESCAPES[e]
          this.i += 2
        } else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          this.i += 6
        } else this.fail('A bad escape in a string')
        from = this.i
        continue
      }
      this.i++
    }
    if (!out.isWellFormed()) this.fail('A string holds a lone surrogate')
    return out
  }
}

/** Plain values for bson's EJSON reader: only for wrapper objects. */
function plain(node: Node): unknown {
  if (node instanceof NumberText) return Number(node.text)
  if (Array.isArray(node)) return node.map(plain)
  if (node !== null && typeof node === 'object')
    return Object.fromEntries(node.entries.map(([k, v]) => [k, plain(v)]))
  return node
}

/**
 * A DBRef, built here rather than by the EJSON reader so that its id and extra fields pass the same
 * checks as any other value: unusual names, invalid dates, oversized numbers (final review I2). Not a
 * DBRef in shape ($ref text, an $id, $db text when present): undefined, read as a plain document.
 */
function dbRef(node: { entries: Entries }, allowUnusual: boolean): DBRef | undefined {
  const at = new Map(node.entries)
  const ref = at.get('$ref')
  const db = at.get('$db')
  if (typeof ref !== 'string' || !at.has('$id') || (db !== undefined && typeof db !== 'string'))
    return undefined
  const fields = Object.fromEntries(
    node.entries
      .filter(([k]) => k !== '$ref' && k !== '$id' && k !== '$db')
      .map(([k, v]) => {
        if (!allowUnusual && isUnusualKey(k))
          throw new RecordError(`The field name "${k.slice(0, 100)}" is not allowed`)
        return [k, build(v, allowUnusual)]
      }),
  )
  return new DBRef(ref, build(at.get('$id')!, allowUnusual) as ObjectId, db, fields)
}

function build(node: Node, allowUnusual: boolean): unknown {
  if (node instanceof NumberText) return number(node.text)
  if (Array.isArray(node)) return node.map((v) => build(v, allowUnusual))
  if (node === null || typeof node !== 'object') return node
  const first = node.entries[0]?.[0]
  if (first === '$ref') {
    const ref = dbRef(node, allowUnusual)
    if (ref) return ref
  } else if (first !== undefined && WRAPPERS.has(first) && node.entries.every(([k]) => k.startsWith('$'))) {
    let value: unknown
    try {
      value = EJSON.deserialize(plain(node) as Document, { relaxed: false })
    } catch {
      throw new RecordError(`An invalid ${first} value`)
    }
    // Spec §7 T17 (final review I5): a date that does not parse is this record's error, never 1970.
    if (value instanceof Date && Number.isNaN(value.getTime())) throw new RecordError('An invalid date')
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      return value
  }
  // Object.fromEntries defines own properties: "__proto__" stays data and never sets a prototype.
  return Object.fromEntries(
    node.entries.map(([k, v]) => {
      if (!allowUnusual && isUnusualKey(k))
        throw new RecordError(`The field name "${k.slice(0, 100)}" is not allowed`)
      return [k, build(v, allowUnusual)]
    }),
  )
}

export function parseJsonValue(text: string, opts: { allowUnusual: boolean }): unknown {
  const p = new Parser(text)
  const node = p.value(0)
  p.done()
  return build(node, opts.allowUnusual)
}

export function parseDocument(text: string, opts: { allowUnusual: boolean }): Document {
  const value = parseJsonValue(text, opts)
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new RecordError('The record is not a document')
  return value as Document
}

const oversized = (n: number) =>
  Errors.badFile(`Record ${n} is larger than 16 MiB`, { reason: 'record_size', record: n })
const broken = (what: string, n: number) =>
  Errors.badFile(`${what} (near record ${n})`, { reason: 'json', record: n })
const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t'

/**
 * Spec §5.1: the elements of a top-level array, or the one top-level document, as raw text. Only
 * strings, escapes and nesting are tracked here (no recursion); each element is parsed on its own.
 * Damage between elements ends the file; damage inside one is that record's error.
 */
export async function* jsonElements(text: AsyncIterable<string>): AsyncGenerator<{ n: number; raw: string }> {
  let mode: 'start' | 'array' | 'single' | 'end' = 'start'
  let expect: 'value-or-close' | 'value' | 'comma-or-close' = 'value-or-close'
  // The element's text: earlier chunks' pieces, then chunk[start…] (final review C3: no rope).
  let parts: string[] = []
  let start = 0
  let size = 0
  let depth = 0
  let inString = false
  let escape = false
  let inElement = false
  let n = 0
  for await (const chunk of text) {
    const out: Array<{ n: number; raw: string }> = []
    const begin = (c: string, at: number) => {
      n++
      inElement = true
      parts = []
      start = at
      size = 1
      depth = c === '{' || c === '[' ? 1 : 0
      inString = c === '"'
      escape = false
    }
    const take = (end: number) => {
      inElement = false
      const raw = parts.join('') + chunk.slice(start, end)
      parts = []
      return raw
    }
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!
      if (inElement) {
        if (++size > MAX_RECORD_CHARS) throw oversized(n)
        if (inString) {
          if (escape) escape = false
          else if (c === '\\') escape = true
          else if (c === '"') inString = false
          continue
        }
        if (depth > 0) {
          if (c === '"') inString = true
          else if (c === '{' || c === '[') depth++
          else if (c === '}' || c === ']') {
            depth--
            if (depth === 0) {
              out.push({ n, raw: take(i + 1) })
              if (mode === 'single') mode = 'end'
              else expect = 'comma-or-close'
            }
          }
          continue
        }
        // A scalar element (a number, a string, true…): it ends at "," or "]".
        if (c === ',' || c === ']') {
          out.push({ n, raw: take(i).trim() })
          if (c === ',') expect = 'value'
          else mode = 'end'
          continue
        }
        if (c === '"') inString = true
        continue
      }
      if (isSpace(c)) continue
      if (mode === 'start') {
        if (c === '[') mode = 'array'
        else if (c === '{') {
          mode = 'single'
          begin(c, i)
        } else throw Errors.badFile('The file is not JSON', { reason: 'json' })
        continue
      }
      if (mode === 'end') throw broken('Unexpected text after the end', n)
      if (expect === 'comma-or-close') {
        if (c === ',') expect = 'value'
        else if (c === ']') mode = 'end'
        else throw broken('Expected "," or "]"', n)
        continue
      }
      if (c === ']' && expect === 'value-or-close') {
        mode = 'end'
        continue
      }
      if (c === ',' || c === ']') throw broken(`Unexpected "${c}"`, n + 1)
      begin(c, i)
    }
    if (inElement) {
      parts.push(chunk.slice(start))
      start = 0
    }
    yield* out
  }
  if (mode !== 'end') throw broken('The file ends in the middle of a value', n)
}

export function docSource(
  raws: AsyncIterable<{ n: number; raw: string } | RecordFailure>,
  opts: { allowUnusual: boolean },
): DocSource {
  async function* records() {
    for await (const r of raws) {
      if ('error' in r) {
        yield r
        continue
      }
      try {
        yield { n: r.n, doc: parseDocument(r.raw, opts), raw: r.raw }
      } catch (e) {
        if (!(e instanceof RecordError)) throw e
        yield { n: r.n, error: e.message, raw: r.raw }
      }
    }
  }
  return { kind: 'docs', records: records() }
}
