import { Double, EJSON, type Document } from 'bson'

const CANONICAL = { relaxed: false } as const

export type BsonTypeName =
  | 'null'
  | 'undefined'
  | 'boolean'
  | 'string'
  | 'int32'
  | 'double'
  | 'long'
  | 'decimal128'
  | 'date'
  | 'objectId'
  | 'uuid'
  | 'binary'
  | 'timestamp'
  | 'regex'
  | 'minKey'
  | 'maxKey'
  | 'dbref'
  | 'code'
  | 'symbol'
  | 'array'
  | 'object'

const BSON_BRAND = Symbol.for('@@mdb.bson.version')

/**
 * The BSON class name of a genuine bson value, or undefined. A document field literally named
 * "_bsontype" is plain data, so the brand symbol (never present in stored data) is required.
 */
export function bsonClassOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || !(BSON_BRAND in value)) return undefined
  const tag = (value as { _bsontype?: unknown })._bsontype
  return typeof tag === 'string' ? tag : undefined
}

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

function isPlainContainer(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return (proto === Object.prototype || proto === null) && bsonClassOf(value) === undefined
}

/**
 * bson's EJSON serializer emits $numberLong for integral numbers outside int32, while binary BSON (and
 * mongosh) store them as doubles. Wrap them as Double so the wire type matches what gets stored.
 * Copy-on-write: the input is never mutated.
 */
function normalizeNumbers(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isInteger(value) && (value < INT32_MIN || value > INT32_MAX) ? new Double(value) : value
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined
    value.forEach((item, i) => {
      const next = normalizeNumbers(item)
      if (next !== item) (copy ??= value.slice())[i] = next
    })
    return copy ?? value
  }
  if (!isPlainContainer(value)) return value
  let changed = false
  const entries = Object.entries(value).map(([k, item]) => {
    const next = normalizeNumbers(item)
    if (next !== item) changed = true
    return [k, next] as const
  })
  if (!changed) return value
  const copy: Record<string, unknown> = Object.create(Object.getPrototypeOf(value))
  for (const [k, item] of entries) {
    Object.defineProperty(copy, k, { value: item, enumerable: true, writable: true, configurable: true })
  }
  return copy
}

/** Canonical Extended JSON text; the only format document data travels in (spec §4.2). */
export function toWire(value: unknown): string {
  return EJSON.stringify(normalizeNumbers(value) as Document, CANONICAL)
}

/** Parses canonical EJSON into BSON wrapper classes; never loses numeric types. */
export function fromWire<T = unknown>(text: string): T {
  return EJSON.parse(text, CANONICAL) as T
}

export function serializeValue(value: unknown): unknown {
  return EJSON.serialize(normalizeNumbers(value) as Document, CANONICAL)
}

export function deserializeValue<T = unknown>(value: unknown): T {
  return EJSON.deserialize(value as Document, CANONICAL) as T
}

export function bsonTypeOf(value: unknown): BsonTypeName {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  switch (typeof value) {
    case 'boolean':
      return 'boolean'
    case 'string':
      return 'string'
    case 'bigint':
      return 'long'
    case 'number':
      return Number.isInteger(value) && !Object.is(value, -0) && value >= INT32_MIN && value <= INT32_MAX
        ? 'int32'
        : 'double'
  }
  if (value instanceof Date) return 'date'
  if (value instanceof RegExp) return 'regex'
  if (Array.isArray(value)) return 'array'
  const tagged = value as { sub_type?: number; position?: number }
  switch (bsonClassOf(value)) {
    case 'ObjectId':
      return 'objectId'
    case 'Int32':
      return 'int32'
    case 'Double':
      return 'double'
    case 'Long':
      return 'long'
    case 'Decimal128':
      return 'decimal128'
    case 'Binary':
      return tagged.sub_type === 4 && tagged.position === 16 ? 'uuid' : 'binary'
    case 'Timestamp':
      return 'timestamp'
    case 'BSONRegExp':
      return 'regex'
    case 'MinKey':
      return 'minKey'
    case 'MaxKey':
      return 'maxKey'
    case 'DBRef':
      return 'dbref'
    case 'Code':
      return 'code'
    case 'BSONSymbol':
      return 'symbol'
  }
  return 'object'
}
