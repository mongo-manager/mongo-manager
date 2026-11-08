// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Index script (research 2026-10-28: CUSTOMER-I-6953): a collection's indexes — or a database's —
 * written as the commands that make them again: in mongosh, for the Node.js or the Python driver, or
 * as JSON. The default _id index (or a clustered one) is made with its collection and is left out.
 */
export type Format = 'mongosh' | 'node' | 'python' | 'json'
export const FORMATS: Format[] = ['mongosh', 'node', 'python', 'json']

export type Doc = Record<string, unknown>
export interface ListedIndex {
  name: string
  key: Doc
  options: Doc
}
export interface CollectionIndexes {
  coll: string
  indexes: ListedIndex[]
}

const isDoc = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v)
const MASK = '***'

/** What the app shows for a value hidden from the user: an index holding one cannot be made again as listed. */
export function holdsHidden(v: unknown): boolean {
  if (v === MASK) return true
  if (Array.isArray(v)) return v.some(holdsHidden)
  return isDoc(v) && Object.values(v).some(holdsHidden)
}

/** A date JavaScript cannot hold (past ±8.64e15 ms): written as it came, it makes no index. */
export function holdsFarDate(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(holdsFarDate)
  if (!isDoc(v)) return false
  if (isDoc(v.$date) && typeof v.$date.$numberLong === 'string')
    return Number.isNaN(new Date(Number(v.$date.$numberLong)).getTime())
  return Object.values(v).some(holdsFarDate)
}

/**
 * A key whose fields may have come in another order: an object puts the names that are numbers
 * ("2") first, so once read the order of { a: 1, "2": 1 } is lost (review 2026-10-28).
 */
export function orderUncertain(key: Doc): boolean {
  const names = Object.keys(key)
  return names.length > 1 && names.some((k) => /^(0|[1-9]\d*)$/.test(k) && Number(k) < 2 ** 32 - 1)
}

/**
 * The key an index is made with: a text index is listed as { _fts: 'text', _ftsx: 1 } beside its
 * other fields, its text fields in its weights; it is made with { field: 'text' } for each.
 */
export function creationKey(index: ListedIndex): Doc {
  const weights = isDoc(index.options.weights) ? Object.keys(index.options.weights) : []
  const out: Doc = {}
  // An own field even when named __proto__ (out.__proto__ = … would set the prototype).
  const put = (field: string, value: unknown) =>
    Object.defineProperty(out, field, { value, enumerable: true, writable: true, configurable: true })
  for (const [field, value] of Object.entries(index.key)) {
    if (field === '_fts') for (const w of weights) put(w, 'text')
    else if (field !== '_ftsx') put(field, value)
  }
  return out
}

/** The options it is made with: its name first; nothing the server keeps for itself. */
export function creationOptions(index: ListedIndex): Doc {
  const { ns: _ns, v: _v, ...rest } = index.options
  return { name: index.name, ...rest }
}

/** The indexes a script makes: all but the default _id one, and a clustered one (made with its collection). */
export const madeIndexes = (indexes: readonly ListedIndex[]): ListedIndex[] =>
  indexes.filter((i) => i.name !== '_id_' && i.options.clustered !== true)

/**
 * The options the Node.js driver's createIndex passes on (mongosh's goes through it too): it leaves
 * out any other, so an index with one is made with the createIndexes command (review 2026-10-28).
 */
const DRIVER_OPTIONS = new Set([
  'background',
  'unique',
  'name',
  'partialFilterExpression',
  'sparse',
  'hidden',
  'expireAfterSeconds',
  'storageEngine',
  'collation',
  'version',
  'weights',
  'default_language',
  'language_override',
  'textIndexVersion',
  '2dsphereIndexVersion',
  'bits',
  'min',
  'max',
  'bucketSize',
  'wildcardProjection',
])

// ---- values as each language writes them (canonical Extended JSON in)
type Lang = 'js' | 'node' | 'python'

/**
 * A string as JavaScript and Python both read one: on one line, so no text ends a comment or a
 * line of code (JavaScript ends a line at U+2028 and U+2029 too, review I1).
 */
const quote = (s: string) =>
  JSON.stringify(s).replace(
    /[\u2028\u2029\u0085]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
const identifier = /^[A-Za-z_$][\w$]*$/

function hexOf(base64: string): string | null {
  try {
    return [...atob(base64)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function scalar(v: Doc, lang: Lang): string | null {
  const s = (x: unknown) => quote(String(x))
  const keys = Object.keys(v)
  // Digits only: a number is written as it is (review 2026-10-28), anything else as it came.
  const digits = (x: unknown): x is string => typeof x === 'string' && /^-?[0-9]+$/.test(x)
  if (typeof v.$numberInt === 'string') return digits(v.$numberInt) ? v.$numberInt : null
  if (typeof v.$numberDouble === 'string') {
    const d = v.$numberDouble
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(d)) return /[.e]/i.test(d) ? d : `${d}.0`
    return lang === 'python'
      ? `float(${s(d)})`
      : d === 'NaN'
        ? 'NaN'
        : d.startsWith('-')
          ? '-Infinity'
          : 'Infinity'
  }
  if (typeof v.$numberLong === 'string') {
    if (!digits(v.$numberLong)) return null
    return lang === 'python'
      ? `Int64(${v.$numberLong})`
      : lang === 'node'
        ? `Long.fromString(${s(v.$numberLong)})`
        : `NumberLong(${s(v.$numberLong)})`
  }
  if (typeof v.$numberDecimal === 'string')
    return lang === 'python'
      ? `Decimal128(${s(v.$numberDecimal)})`
      : lang === 'node'
        ? `Decimal128.fromString(${s(v.$numberDecimal)})`
        : `NumberDecimal(${s(v.$numberDecimal)})`
  if (typeof v.$oid === 'string')
    return lang === 'node' ? `new ObjectId(${s(v.$oid)})` : `ObjectId(${s(v.$oid)})`
  if (isDoc(v.$date) && typeof v.$date.$numberLong === 'string') {
    const at = new Date(Number(v.$date.$numberLong))
    if (Number.isNaN(at.getTime())) return null
    const iso = at.toISOString()
    return lang === 'python'
      ? `datetime.fromisoformat(${s(iso.replace('Z', '+00:00'))})`
      : lang === 'node'
        ? `new Date(${s(iso)})`
        : `ISODate(${s(iso)})`
  }
  // Binary, timestamps and the min and max keys, as their own types (review 2026-10-28). No regular
  // expression: a partial filter holds none ($regex is refused there), so none is written.
  if (isDoc(v.$binary) && typeof v.$binary.base64 === 'string' && typeof v.$binary.subType === 'string') {
    const sub = Number.parseInt(v.$binary.subType, 16)
    const hex = hexOf(v.$binary.base64)
    if (!/^[0-9a-f]{1,2}$/i.test(v.$binary.subType) || hex === null) return null
    return lang === 'python'
      ? `Binary(bytes.fromhex(${s(hex)}), ${sub})`
      : lang === 'node'
        ? `new Binary(Buffer.from(${s(hex)}, "hex"), ${sub})`
        : `BinData(${sub}, ${s(v.$binary.base64)})`
  }
  if (isDoc(v.$timestamp)) {
    const { t, i } = v.$timestamp
    if (!Number.isInteger(t) || !Number.isInteger(i)) return null
    return lang === 'python'
      ? `Timestamp(${t}, ${i})`
      : `${lang === 'node' ? 'new ' : ''}Timestamp({ t: ${t}, i: ${i} })`
  }
  if (keys.length === 1 && (keys[0] === '$minKey' || keys[0] === '$maxKey')) {
    const name = keys[0] === '$minKey' ? 'MinKey' : 'MaxKey'
    return lang === 'node' ? `new ${name}()` : `${name}()`
  }
  return null
}

/** A value as the language writes a literal of it. */
export function literal(v: unknown, lang: Lang): string {
  if (v === null || v === undefined) return lang === 'python' ? 'None' : 'null'
  if (typeof v === 'boolean') return lang === 'python' ? (v ? 'True' : 'False') : String(v)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return quote(v)
  if (Array.isArray(v)) return `[${v.map((x) => literal(x, lang)).join(', ')}]`
  if (isDoc(v)) {
    const typed = scalar(v, lang)
    if (typed !== null) return typed
    const entries = Object.entries(v)
    if (!entries.length) return '{}'
    // { __proto__: 1 } sets an object's prototype, quoted or not: only a computed name is a field.
    const key = (k: string) =>
      lang === 'python' ? quote(k) : k === '__proto__' ? `[${quote(k)}]` : identifier.test(k) ? k : quote(k)
    return `{ ${entries.map(([k, x]) => `${key(k)}: ${literal(x, lang)}`).join(', ')} }`
  }
  return quote(String(v))
}

/** Python's own way of writing an option name (unique=True); its keys as (field, direction) pairs. */
const pythonKey = (key: Doc) =>
  `[${Object.entries(key)
    .map(([f, d]) => `(${quote(f)}, ${literal(d, 'python')})`)
    .join(', ')}]`

/** Python cannot name an option that is no identifier: such options go in a dict passed with **. */
function pythonArgs(options: Doc): string {
  const plain = Object.entries(options).filter(([k]) => /^[A-Za-z_]\w*$/.test(k))
  const other = Object.entries(options).filter(([k]) => !/^[A-Za-z_]\w*$/.test(k))
  const args = plain.map(([k, v]) => `${k}=${literal(v, 'python')}`)
  if (other.length) args.push(`**${literal(Object.fromEntries(other), 'python')}`)
  return args.join(', ')
}

export interface Script {
  text: string
  /** Indexes written; of them those holding a value hidden from the user, and those whose key order is uncertain. */
  count: number
  hidden: string[]
  unordered: string[]
}

/**
 * The script making these collections' indexes again. `missing`: collections whose indexes could
 * not be read, named at its top so the script never passes for the whole database (review I2).
 */
export function writeScript(
  collections: readonly CollectionIndexes[],
  format: Format,
  missing: readonly string[] = [],
): Script {
  const hidden: string[] = []
  const unordered: string[] = []
  let count = 0
  const lines: string[] = []
  const json: Doc[] = []
  const comment = format === 'python' ? '#' : '//'
  for (const { coll, indexes } of collections)
    for (const index of madeIndexes(indexes)) {
      count++
      const key = creationKey(index)
      const options = creationOptions(index)
      const masked = holdsHidden(index.key) || holdsHidden(index.options)
      const order = orderUncertain(key)
      if (masked) hidden.push(`${coll}.${index.name}`)
      if (order) unordered.push(`${coll}.${index.name}`)
      if (format === 'json') {
        json.push({
          collection: coll,
          key,
          options,
          ...(masked ? { hiddenValues: true } : {}),
          ...(order ? { keyOrderUncertain: true } : {}),
          ...(holdsFarDate(index.options) ? { farDate: true } : {}),
        })
        continue
      }
      // The index's name as a string: a name may hold any character, a line break too (review I1).
      if (masked)
        lines.push(
          `${comment} ${quote(index.name)} holds values hidden from you, written as "***": not the index as it is`,
        )
      if (holdsFarDate(index.options))
        lines.push(
          `${comment} ${quote(index.name)}: a date past what JavaScript holds is written as it came: set it by hand`,
        )
      if (order)
        lines.push(
          `${comment} ${quote(index.name)}: its key's fields may be in another order (names that are numbers come first once read)`,
        )
      const name = quote(coll)
      if (format === 'python') {
        lines.push(`db[${name}].create_index(${pythonKey(key)}, ${pythonArgs(options)})`)
        continue
      }
      const lang: Lang = format === 'node' ? 'node' : 'js'
      if (Object.keys(options).every((k) => DRIVER_OPTIONS.has(k))) {
        const target = format === 'node' ? `await db.collection(${name})` : `db.getCollection(${name})`
        lines.push(`${target}.createIndex(${literal(key, lang)}, ${literal(options, lang)})`)
      } else {
        const command = literal({ createIndexes: coll, indexes: [{ key, ...options }] }, lang)
        lines.push(format === 'node' ? `await db.command(${command})` : `db.runCommand(${command})`)
      }
    }
  if (format === 'json') return { text: `${JSON.stringify(json, null, 2)}\n`, count, hidden, unordered }
  const head =
    format === 'python'
      ? [
          '# pip install pymongo',
          'from datetime import datetime',
          'from bson import Binary, Decimal128, Int64, MaxKey, MinKey, ObjectId, Timestamp',
          'from pymongo import MongoClient',
          '# db = MongoClient(uri)["…"]',
        ]
      : format === 'node'
        ? [
            '// npm install mongodb; run it as an ES module (a .mjs file): it awaits at its top level',
            "import { Binary, Decimal128, Long, MaxKey, MinKey, MongoClient, ObjectId, Timestamp } from 'mongodb'",
            '// const db = new MongoClient(uri).db("…")',
          ]
        : []
  const gap = missing.length
    ? [`${comment} Not in this script: the indexes of ${missing.map(quote).join(', ')} could not be read`]
    : []
  const top = [...head, ...gap]
  return { text: `${[...top, ...(top.length ? [''] : []), ...lines].join('\n')}\n`, count, hidden, unordered }
}
