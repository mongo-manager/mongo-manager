// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { BridgeError } from './bridge'

/**
 * Plugins wave 1: what a plugin may ask the server to run, and what it may hand the user to run.
 * Only reading stages, on the plugin's own collection; nothing that runs code, writes or reads
 * elsewhere, at any depth. The server still applies the user's rights and masking.
 */
const READING_STAGES = new Set([
  '$match',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$project',
  '$addFields',
  '$set',
  '$unset',
  '$count',
  '$unwind',
  '$sortByCount',
  '$bucket',
  '$bucketAuto',
  '$facet',
  '$replaceRoot',
  '$replaceWith',
  '$sample',
])
/**
 * Plugins wave 4: a search of the collection's search indexes, as a pipeline's first stage only (as
 * MongoDB wants it) and never nested; its body holds no forbidden operator either.
 */
const SEARCH_STAGES = new Set(['$search', '$searchMeta', '$vectorSearch'])
/** Operators refused anywhere: code that runs on the server, writes, reads of other collections. */
const FORBIDDEN = new Set([
  '$where',
  '$function',
  '$accumulator',
  '$lookup',
  '$graphLookup',
  '$unionWith',
  '$out',
  '$merge',
])
const MAX_STAGES = 50
const MAX_DEPTH = 40

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Refuses a value holding a forbidden operator anywhere in it. */
export function assertNoForbidden(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) throw new BridgeError('bad_params', 'Too deeply nested')
  if (Array.isArray(value)) return value.forEach((v) => assertNoForbidden(v, depth + 1))
  if (!isObject(value)) return
  for (const [key, v] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) throw new BridgeError('bad_params', `${key} is not allowed here`)
    assertNoForbidden(v, depth + 1)
  }
}

const LOOKUP_KEYS = ['as', 'foreignField', 'from', 'localField']
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 255

/**
 * User request 2026-10-10 (a SQL JOIN run in its own tab): a join of a plugin allowed to read the
 * other collections of its database (database:read) — the plain form only: a collection of this
 * database (no system one), its field and ours, a name for the result. No `pipeline` nor `let`:
 * stages and code would hide there. The server applies the user's rights and the joined
 * collection's masking, as for any pipeline.
 */
function assertPlainLookup(body: unknown): void {
  if (!isObject(body) || Object.keys(body).sort().join() !== LOOKUP_KEYS.join())
    throw new BridgeError(
      'bad_params',
      'Only a $lookup of from, localField, foreignField and as is allowed here',
    )
  const { from, localField, foreignField, as } = body
  if (!isName(from) || from.startsWith('system.') || from.includes('\0') || from.startsWith('$'))
    throw new BridgeError('bad_params', '$lookup reads a collection of this database')
  for (const field of [localField, foreignField, as])
    if (!isName(field) || field.startsWith('$')) throw new BridgeError('bad_params', '$lookup names fields')
}

/**
 * A pipeline of reading stages only (canonical EJSON), $facet's pipelines too; a plain $lookup at
 * the top when `joins` (the plugin may read its database's other collections).
 */
export function assertReadOnlyPipeline(
  stages: unknown,
  nested = false,
  joins = false,
): Record<string, unknown>[] {
  if (!Array.isArray(stages) || stages.length > MAX_STAGES)
    throw new BridgeError('bad_params', `A pipeline is a list of at most ${MAX_STAGES} stages`)
  for (const [i, stage] of stages.entries()) {
    if (!isObject(stage) || Object.keys(stage).length !== 1)
      throw new BridgeError('bad_params', 'A stage is an object with one operator')
    const [op, body] = Object.entries(stage)[0]!
    if (SEARCH_STAGES.has(op) && i === 0 && !nested) {
      assertNoForbidden(body)
      continue
    }
    if (op === '$lookup' && joins && !nested) {
      assertPlainLookup(body)
      continue
    }
    if (!READING_STAGES.has(op) || (nested && op === '$facet'))
      throw new BridgeError('bad_params', `${op} is not allowed here`)
    if (op === '$facet') {
      if (!isObject(body)) throw new BridgeError('bad_params', '$facet holds pipelines')
      for (const sub of Object.values(body)) assertReadOnlyPipeline(sub, true)
    } else assertNoForbidden(body)
  }
  return stages as Record<string, unknown>[]
}

/** Operators a pipeline handed to the user may not hold: code on the server, and writes. */
const NEVER_HANDED = new Set(['$where', '$function', '$accumulator', '$out', '$merge'])

/**
 * A pipeline handed to the user's Aggregations (`ui.useAggregation`): nothing runs until the user
 * runs it, with their own rights and masking, so it may read other collections (a SQL JOIN is a
 * $lookup) — but it never writes nor runs code.
 */
export function assertHandedPipeline(stages: unknown): Record<string, unknown>[] {
  if (!Array.isArray(stages) || stages.length > MAX_STAGES)
    throw new BridgeError('bad_params', `A pipeline is a list of at most ${MAX_STAGES} stages`)
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) throw new BridgeError('bad_params', 'Too deeply nested')
    if (Array.isArray(value)) return value.forEach((v) => walk(v, depth + 1))
    if (!isObject(value)) return
    for (const [key, v] of Object.entries(value)) {
      if (NEVER_HANDED.has(key)) throw new BridgeError('bad_params', `${key} is not allowed here`)
      walk(v, depth + 1)
    }
  }
  for (const stage of stages)
    if (!isObject(stage) || Object.keys(stage).length !== 1)
      throw new BridgeError('bad_params', 'A stage is an object with one operator')
  walk(stages, 0)
  return stages as Record<string, unknown>[]
}
