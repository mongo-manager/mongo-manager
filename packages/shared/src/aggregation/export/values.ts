import { bsonClassOf, bsonTypeOf } from '../../ejson'

/**
 * Phase 2a spec §4.6: a pipeline value reduced to what a driver needs to write it, walked once and
 * then printed by each language.
 */
export type Value =
  | { k: 'null' }
  | { k: 'bool'; v: boolean }
  | { k: 'string'; v: string }
  | { k: 'int32'; v: number }
  | { k: 'double'; v: number }
  | { k: 'long'; v: string }
  | { k: 'decimal'; v: string }
  | { k: 'date'; ms: number }
  | { k: 'oid'; hex: string }
  | { k: 'uuid'; hex: string }
  | { k: 'binary'; sub: number; base64: string; bytes: number[] }
  | { k: 'timestamp'; t: number; i: number }
  | { k: 'regex'; pattern: string; flags: string }
  | { k: 'minKey' }
  | { k: 'maxKey' }
  | { k: 'array'; items: Value[] }
  | { k: 'doc'; entries: Array<[string, Value]> }

const MAX_DEPTH = 100

interface BinaryLike {
  sub_type: number
  value(asRaw?: boolean): Uint8Array | string
  toString(encoding: 'base64' | 'hex'): string
}

const dashed = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

export function toValue(value: unknown, depth = 0): Value {
  if (depth > MAX_DEPTH) throw new Error('The pipeline is nested too deeply to export')
  const type = bsonTypeOf(value)
  const v = value as never
  switch (type) {
    case 'null':
    case 'undefined':
      return { k: 'null' }
    case 'boolean':
      return { k: 'bool', v }
    case 'string':
      return { k: 'string', v }
    case 'int32':
      return { k: 'int32', v: Number(typeof value === 'number' ? value : (v as { value: number }).value) }
    case 'double':
      return { k: 'double', v: Number(typeof value === 'number' ? value : (v as { value: number }).value) }
    case 'long':
      return { k: 'long', v: String(value) }
    case 'decimal128':
      return { k: 'decimal', v: String(value) }
    case 'date':
      return { k: 'date', ms: (value as Date).getTime() }
    case 'objectId':
      return { k: 'oid', hex: (value as { toHexString(): string }).toHexString() }
    case 'uuid':
      return { k: 'uuid', hex: dashed((value as BinaryLike).toString('hex')) }
    case 'binary': {
      const bin = value as BinaryLike
      const raw = bin.value(true)
      const bytes = typeof raw === 'string' ? [...raw].map((c) => c.charCodeAt(0)) : [...raw]
      return { k: 'binary', sub: bin.sub_type, base64: bin.toString('base64'), bytes }
    }
    case 'timestamp': {
      const ts = value as { t: number; i: number }
      return { k: 'timestamp', t: ts.t, i: ts.i }
    }
    case 'regex':
      return value instanceof RegExp
        ? { k: 'regex', pattern: value.source, flags: value.flags }
        : {
            k: 'regex',
            pattern: (value as { pattern: string }).pattern,
            flags: (value as { options: string }).options,
          }
    case 'minKey':
      return { k: 'minKey' }
    case 'maxKey':
      return { k: 'maxKey' }
    case 'dbref': {
      const ref = value as { collection: string; oid: unknown; db?: string }
      const entries: Array<[string, Value]> = [
        ['$ref', { k: 'string', v: ref.collection }],
        ['$id', toValue(ref.oid, depth + 1)],
      ]
      if (ref.db) entries.push(['$db', { k: 'string', v: ref.db }])
      return { k: 'doc', entries }
    }
    case 'code':
    case 'symbol':
      return {
        k: 'string',
        v: String((value as { code?: string; value?: string }).code ?? (value as { value: string }).value),
      }
    case 'array':
      return { k: 'array', items: (value as unknown[]).map((x) => toValue(x, depth + 1)) }
    case 'object':
      if (bsonClassOf(value) !== undefined)
        throw new Error(`This value cannot be exported: ${bsonClassOf(value)}`)
      return {
        k: 'doc',
        entries: Object.entries(value as Record<string, unknown>).map(([key, x]) => [
          key,
          toValue(x, depth + 1),
        ]),
      }
  }
}

/**
 * How a language writes characters its string literal cannot hold raw: `\uXXXX`, `\u{X}`, or octal
 * (Java translates `\uXXXX` before it parses, so a `\u000a` there would end the string).
 */
export type EscapeStyle = 'u4' | 'ubrace' | 'octal'

/**
 * A double-quoted string literal. Backslash, the quote, and any `extra` characters (interpolation
 * marks: `$` in PHP, `#` in Ruby) are escaped with a backslash; line breaks, tabs, control
 * characters, DEL, C1 controls and U+2028/U+2029 never appear raw. A lone surrogate (text that is not valid
 * Unicode) is escaped where the language's strings can hold one, else the export is refused: copied
 * raw, it would silently become U+FFFD (final review 2a, Minor 4).
 */
export function quote(
  text: string,
  style: EscapeStyle,
  extra = '',
  surrogates: 'escape' | 'refuse' = 'escape',
): string {
  let out = '"'
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) {
      if (surrogates === 'refuse')
        throw new Error(
          'This pipeline holds text that is not valid Unicode; it cannot be exported to this language',
        )
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else if (ch === '\\' || ch === '"' || extra.includes(ch)) out += `\\${ch}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    // C1 controls too: C# reads NEL (U+0085) as a line break (plugins wave 2).
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      if (style === 'octal' && code < 0x100) out += `\\${code.toString(8).padStart(3, '0')}`
      else if (style === 'ubrace') out += `\\u{${code.toString(16)}}`
      else out += `\\u${code.toString(16).padStart(4, '0')}`
    } else out += ch
  }
  return `${out}"`
}

/** A double as a literal that stays a double: `1` becomes `1.0`. Special values are the caller's. */
export function doubleText(v: number): string {
  if (Object.is(v, -0)) return '-0.0'
  const text = String(v)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

/**
 * Layout shared by the languages: a container on one line when it is short, else one item per line
 * (with a trailing separator where the language allows one).
 */
export function layout(
  open: string,
  items: string[],
  close: string,
  indent: string,
  sep = ',',
  trailing = true,
): string {
  if (items.length === 0) return `${open.trimEnd()}${close.trimStart()}`
  const oneLine = `${open}${items.join(`${sep} `)}${close}`
  if (oneLine.length <= 80 && !items.some((i) => i.includes('\n'))) return oneLine
  const inner = `${indent}  `
  const body = items.map((i) => `${inner}${i}`).join(`${sep}\n`)
  return `${open.trimEnd()}\n${body}${trailing ? sep : ''}\n${indent}${close.trimStart()}`
}
