import {
  bsonTypeOf,
  deserializeValue,
  formatShell,
  serializeValue,
  type BsonTypeName,
} from '@mongo-manager/shared/browser'

/** Server documents are canonical EJSON; decode once into BSON values so types survive editing. */
export const decodeDocument = (ejson: Record<string, unknown>): Record<string, unknown> =>
  deserializeValue<Record<string, unknown>>(ejson)

/** Canonical EJSON for writes (Double(5) stays a double, Int32 an int). */
export const encodeValue = (value: unknown): Record<string, unknown> =>
  serializeValue(value) as Record<string, unknown>

/** Decodes any canonical EJSON value (ids of unsupported documents, index keys and options). */
export const decodeValue = (ejson: unknown): unknown => deserializeValue(ejson)

export const typeOf = (value: unknown): BsonTypeName => bsonTypeOf(value)

export const toShell = (value: unknown, indent = 2): string => formatShell(value, { indent })

/** Query text for the query bar: a parameter's marker written as `{{name}}` (spec 2026-10-28). */
export const toQueryShell = (value: unknown, indent = 2): string =>
  formatShell(value, { indent, params: true })

export type Summary = { kind: 'array' | 'object'; count: number } | { kind: 'scalar'; text: string }

const MAX_TEXT = 200
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text)

/** One-line summary for a table cell; containers report their size instead of their content. */
export function summarize(value: unknown): Summary {
  const type = bsonTypeOf(value)
  switch (type) {
    case 'array':
      return { kind: 'array', count: (value as unknown[]).length }
    case 'object':
      return { kind: 'object', count: Object.keys(value as object).length }
    case 'string':
      return { kind: 'scalar', text: clip(value as string) }
    case 'date': {
      const date = value as Date
      return { kind: 'scalar', text: Number.isNaN(date.getTime()) ? 'Invalid Date' : date.toISOString() }
    }
    case 'objectId':
      return { kind: 'scalar', text: (value as { toHexString(): string }).toHexString() }
    case 'int32':
    case 'double':
      return { kind: 'scalar', text: String(Number((value as { valueOf(): number }).valueOf())) }
    case 'long':
    case 'decimal128':
      return { kind: 'scalar', text: String(value) }
    default:
      return { kind: 'scalar', text: clip(formatShell(value, { indent: 0 })) }
  }
}

/** Short label for a document id in messages. */
export function idLabel(id: unknown): string {
  const summary = summarize(id)
  return summary.kind === 'scalar' ? summary.text : clip(toShell(id, 0))
}

/** A plain document (not an array, date or BSON value). */
export const isDocument = (value: unknown): value is Record<string, unknown> => bsonTypeOf(value) === 'object'
