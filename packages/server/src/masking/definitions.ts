// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Masker, NsMasker } from './match'
import { maskCommand } from './command'
import { isPlain, maskLiterals } from './document'
import { isParam, paramsOf } from '@mongo-manager/shared'

type Json = unknown
const ruleColl = (coll: string) =>
  coll.startsWith('system.buckets.') ? coll.slice('system.buckets.'.length) : coll

/** A filter someone wrote (partial index, validator, shared favourite), masked as 3b masks commands. */
export const maskFilterDef = (filter: Json, db: string, coll: string, masker: Masker): Json =>
  (maskCommand({ find: ruleColl(coll), filter }, db, ruleColl(coll), masker) as { filter: Json }).filter

/** A pipeline someone wrote (a view, a shared pipeline), masked against the collection it reads. */
export const maskPipelineDef = (pipeline: Json, db: string, coll: string, masker: Masker): Json =>
  (maskCommand({ aggregate: ruleColl(coll), pipeline }, db, ruleColl(coll), masker) as { pipeline: Json })
    .pipeline

const isFields = (v: unknown): v is Record<string, Json> => {
  if (!isPlain(v) || '_bsontype' in v) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Query parameters (spec 2026-10-28): a parameter is no literal, so masking leaves it as written —
 * its marker put back wherever the masked value took its place.
 */
function keepParams(original: Json, masked: Json): Json {
  if (isParam(original)) return original
  if (Array.isArray(original) && Array.isArray(masked) && original.length === masked.length)
    return masked.map((item, i) => keepParams(original[i], item))
  // Only a plain object holds fields: a BSON value (a Double, a Long, an ObjectId) is left as it is.
  if (!isFields(original) || !isFields(masked)) return masked
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(masked))
    Object.defineProperty(out, k, {
      value: Object.hasOwn(original, k) ? keepParams(original[k], v) : v,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  return out
}

/**
 * A saved find (filter, projection, sort, …): the command shape 3b masks, without the command name.
 * Its parameters' defaults are literals whose paths are not known until they are filled: they are
 * dropped, not masked.
 */
export function maskFindDef(
  query: Record<string, unknown>,
  db: string,
  coll: string,
  masker: Masker,
): Record<string, unknown> {
  const { params: _defaults, ...find } = query
  const masked = maskCommand({ find: ruleColl(coll), ...find }, db, ruleColl(coll), masker) as Record<
    string,
    unknown
  >
  const { find: _name, ...rest } = (
    paramsOf(find).length > 0 ? keepParams({ find: ruleColl(coll), ...find }, masked) : masked
  ) as Record<string, unknown>
  for (const k of ['skip', 'limit', 'maxTimeMS'] as const) if (k in query) rest[k] = query[k]
  return rest
}

/** $jsonSchema keywords that hold a value (not a name, a type or a structure). */
const VALUE_KEYWORDS = new Set([
  'enum',
  'const',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'examples',
  'default',
  'description',
  'title',
])
/** Keywords whose schemas cannot be tied to one path. */
const UNMAPPABLE = new Set([
  'patternProperties',
  'additionalProperties',
  'dependencies',
  'if',
  'then',
  'else',
])
/** Keywords whose schemas describe the same path (arrays are transparent). */
const SAME_PATH = new Set(['allOf', 'anyOf', 'oneOf', 'not', 'items', 'additionalItems'])

/** Phase 3c §4.5: $jsonSchema keywords holding values are masked under personal paths. */
function maskJsonSchema(node: Json, ns: NsMasker, path: string[]): Json {
  if (Array.isArray(node)) return node.map((n) => maskJsonSchema(n, ns, path))
  if (!isPlain(node)) return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isPlain(value)) {
      const props: Record<string, unknown> = {}
      for (const [name, sub] of Object.entries(value)) props[name] = maskJsonSchema(sub, ns, [...path, name])
      out[key] = props
    } else if (SAME_PATH.has(key)) out[key] = maskJsonSchema(value, ns, path)
    // At, above or below a personal field (review 2026-10-13, I2: below a rule's field it was shown).
    else if (UNMAPPABLE.has(key)) out[key] = ns.matches(path) || ns.under(path) ? maskLiterals(value) : value
    // Wave 3 third review: also above a personal field — an enum or const of the whole object holds
    // its value.
    else if (VALUE_KEYWORDS.has(key) && ((path.length > 0 && ns.matches(path)) || ns.under(path)))
      out[key] = maskLiterals(value)
    else out[key] = value
  }
  return out
}

export function maskValidator(validator: Json, db: string, coll: string, masker: Masker): Json {
  if (!isPlain(validator)) return validator
  const ns = masker.forNs(db, ruleColl(coll))
  if (!ns.any) return validator
  // Wave 3 second review: a $jsonSchema inside $and / $or / $nor is masked as a schema (each part as
  // a validator of its own), never turned whole into "***"; any other part as a filter. Third
  // review: in the validator's own key order (a copy compares it as text).
  const logical = (key: string, value: unknown) =>
    (key === '$and' || key === '$or' || key === '$nor') && Array.isArray(value)
  const rest = Object.fromEntries(
    Object.entries(validator).filter(([key, value]) => key !== '$jsonSchema' && !logical(key, value)),
  )
  const queryPart = Object.keys(rest).length
    ? (maskFilterDef(rest, db, coll, masker) as Record<string, unknown>)
    : {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(validator)) {
    if (key === '$jsonSchema') out[key] = maskJsonSchema(value as Json, ns, [])
    else if (logical(key, value))
      out[key] = (value as Json[]).map((part) => maskValidator(part, db, coll, masker))
    else if (Object.hasOwn(queryPart, key)) out[key] = queryPart[key]
  }
  for (const [key, value] of Object.entries(queryPart)) if (!Object.hasOwn(out, key)) out[key] = value
  return out
}

export function maskIndexOptions(options: Json, db: string, coll: string, masker: Masker): Json {
  if (!isPlain(options) || options.partialFilterExpression === undefined) return options
  return {
    ...options,
    partialFilterExpression: maskFilterDef(options.partialFilterExpression, db, coll, masker),
  }
}

/**
 * A collection's options: its validator, and a view's pipeline (masked against what it reads).
 * `own` answers the view's own rules; `masker` may resolve views to their sources (final review I3).
 */
export function maskCollectionOptions(
  options: Json,
  db: string,
  coll: string,
  masker: Masker,
  own: Masker = masker,
): Json {
  if (!isPlain(options)) return options
  const out: Record<string, unknown> = { ...options }
  if (out.validator !== undefined) out.validator = maskValidator(out.validator, db, coll, masker)
  if (Array.isArray(out.pipeline) && typeof out.viewOn === 'string') {
    // The view's own rules name its output, which the pipeline does not follow: in doubt, mask all.
    out.pipeline = own.forNs(db, coll).any
      ? maskLiterals(out.pipeline)
      : maskPipelineDef(out.pipeline, db, out.viewOn, masker)
  }
  return out
}
