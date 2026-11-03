import { BSONError, EJSON } from 'bson'

/**
 * A BSON value's type tag ("Long", "Int32", "ObjectId"…). The driver may load its own copy of the
 * bson package (CommonJS while this code runs as ESM, for one), so `instanceof` against our classes
 * can miss its values; the tag is what bson itself relies on.
 */
export function bsonKind(v: unknown): string | undefined {
  if (v === null || typeof v !== 'object') return undefined
  // Review M7 (2026-10-10): a stored sub-document may hold a field named "_bsontype" (another
  // driver can write one); read from MongoDB it is a plain object, never a BSON value.
  const proto = Object.getPrototypeOf(v) as unknown
  if (proto === Object.prototype || proto === null) return undefined
  const tag = (v as { _bsontype?: unknown })._bsontype
  return typeof tag === 'string' ? tag : undefined
}

/** The number inside an Int32 or Double (or a plain number). */
export function numberValue(v: unknown): number | null {
  if (typeof v === 'number') return v
  const kind = bsonKind(v)
  return kind === 'Int32' || kind === 'Double' ? Number((v as { value: unknown }).value) : null
}

const SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Data review 2026-10-13 (M4): relaxed Extended JSON writes a Long as a JSON number, which past
 * 2^53 is another number. Such a Long is written as {"$numberLong": "…"}; the rest is left as it is
 * (copied only along the way to one).
 */
function exactLongs(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) {
    let out: unknown[] | null = null
    v.forEach((x, i) => {
      const y = exactLongs(x)
      if (y !== x) (out ??= [...v])[i] = y
    })
    return out ?? v
  }
  const kind = bsonKind(v)
  if (kind === 'Long') {
    const text = String(v)
    const big = BigInt(text)
    return big > SAFE || big < -SAFE ? { $numberLong: text } : v
  }
  if (kind !== undefined) return v
  const proto = Object.getPrototypeOf(v) as unknown
  if (proto !== Object.prototype && proto !== null) return v
  // Every key defined, never set: a field named "__proto__" stays a field (review of the fix, Minor 2).
  const define = (o: object, k: string, value: unknown) =>
    Object.defineProperty(o, k, { value, writable: true, enumerable: true, configurable: true })
  let out: object | null = null
  for (const [k, x] of Object.entries(v)) {
    const y = exactLongs(x)
    if (y !== x && !out) {
      out = Object.create(proto as object | null) as object
      for (const [k2, x2] of Object.entries(v)) define(out, k2, x2)
    }
    if (out) define(out, k, y)
  }
  return out ?? v
}

/** A value as Extended JSON's tree: BSON values and dates as EJSON, plain objects and arrays walked. */
function ejsonTree(v: unknown, relaxed: boolean): unknown {
  if (Array.isArray(v)) return v.map((x) => ejsonTree(x, relaxed))
  if (v !== null && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v) as unknown
    if (proto === Object.prototype || proto === null)
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ejsonTree(x, relaxed)]))
  }
  return EJSON.serialize(v, { relaxed })
}

/**
 * Review M7 (2026-10-10): a document as Extended JSON text, even when a sub-document holds a field
 * named "_bsontype" (another driver can store one): bson's own stringify refuses those, which would
 * stop a whole export over one value. Such a document is walked instead, and written as data.
 */
export function ejsonText(v: unknown, opts: { relaxed: boolean }, indent?: number): string {
  if (opts.relaxed) v = exactLongs(v)
  try {
    return indent === undefined ? EJSON.stringify(v, opts) : EJSON.stringify(v, undefined, indent, opts)
  } catch (e) {
    if (!BSONError.isBSONError(e)) throw e
    return JSON.stringify(ejsonTree(v, opts.relaxed), undefined, indent)
  }
}
