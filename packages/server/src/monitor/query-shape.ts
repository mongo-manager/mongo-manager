// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'

/** The longest shape kept (characters): a query of hundreds of fields is cut, not refused. */
const MAX_SHAPE = 2000
/**
 * Where a number or a boolean says how, not what: a sort's directions, a projection's choices — the
 * command's own `sort` and `projection`, and a pipeline stage's `$sort` and `$project` (final review
 * I2: by position only, never under a field a user named so).
 */
const LITERAL_PARTS = new Set(['sort', 'projection'])
const LITERAL_STAGES = new Set(['$sort', '$project'])
/** Stages holding pipelines of their own, shaped as pipelines. */
const PIPELINE_STAGES = new Set(['$facet', '$lookup', '$unionWith'])
/** A field name a command names (a distinct's key): kept as it is, as other field names are. */
const NAME_PARTS = new Set(['key'])

const isPlain = (v: unknown): v is Document =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !('_bsontype' in v) &&
  !(v instanceof Date) &&
  !(v instanceof RegExp) &&
  !(v instanceof Uint8Array)

/**
 * A value with every value replaced by "?": keys, operators and the structure kept. A list of
 * values is one "?" (an $in of three or of thirty is the same question); a list of conditions keeps
 * each. `literals`: a sort's or a projection's own values, numbers and booleans, are kept (they are
 * its shape); a number deeper down (a $cond's threshold) is data.
 */
function shapeOf(value: unknown, literals = false): unknown {
  if (Array.isArray(value)) {
    if (!value.some(isPlain)) return ['?']
    return value.map((v) => shapeOf(v))
  }
  if (isPlain(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        literals && (typeof v === 'number' || typeof v === 'boolean') ? v : shapeOf(v),
      ]),
    )
  return '?'
}

/** A pipeline: each stage's values replaced, a $sort's and a $project's own choices kept. */
function pipelineShape(stages: unknown, depth = 0): unknown {
  if (!Array.isArray(stages) || depth > 4) return shapeOf(stages)
  return stages.map((stage) => {
    if (!isPlain(stage)) return shapeOf(stage)
    return Object.fromEntries(
      Object.entries(stage).map(([op, arg]) => {
        if (LITERAL_STAGES.has(op)) return [op, shapeOf(arg, true)]
        if (op === '$facet' && isPlain(arg))
          return [
            op,
            Object.fromEntries(Object.entries(arg).map(([k, v]) => [k, pipelineShape(v, depth + 1)])),
          ]
        if (PIPELINE_STAGES.has(op) && isPlain(arg) && Array.isArray(arg.pipeline))
          return [
            op,
            {
              ...(shapeOf({ ...arg, pipeline: [] }) as Document),
              pipeline: pipelineShape(arg.pipeline, depth + 1),
            },
          ]
        return [op, shapeOf(arg)]
      }),
    )
  })
}

/** The parts of a command that say what it asks, by command; its name as MongoDB gives it. */
function partsOf(command: Document): { name: string; parts: Document } {
  const name = Object.keys(command)[0] ?? ''
  const pick = (...keys: string[]) =>
    Object.fromEntries(keys.filter((k) => command[k] !== undefined).map((k) => [k, command[k]]))
  const first = (list: unknown): Document | null =>
    Array.isArray(list) && isPlain(list[0]) ? (list[0] as Document) : null
  switch (name) {
    case 'find':
      return { name, parts: pick('filter', 'sort', 'projection') }
    case 'aggregate':
      return { name, parts: pick('pipeline') }
    case 'count':
      return { name, parts: pick('query') }
    case 'distinct':
      return { name, parts: pick('key', 'query') }
    case 'findAndModify':
    case 'findandmodify':
      return { name, parts: pick('query', 'sort') }
    case 'update':
    case 'delete': {
      const statement = first(command[name === 'update' ? 'updates' : 'deletes'])
      return { name, parts: statement?.q !== undefined ? { q: statement.q } : {} }
    }
    // A statement as the log reports an update ({ q, u }) or a delete ({ q, limit }).
    case 'q':
      return { name: 'u' in command ? 'update' : 'delete', parts: { q: command.q } }
    default:
      return { name, parts: {} }
  }
}

/**
 * Index advice gaps (2026-10-27, wave 4 #6): what a slow query asked — its command's name and the
 * structure of its filter, sort, projection or pipeline — with no value in it, so the slow queries
 * of one kind are counted together, the same for every user (field names are names, as elsewhere).
 */
export function queryShape(command: Document | null, origin?: Document | null): string {
  if (!command) return ''
  // Final review Minor 16: a getMore is the query whose cursor it reads.
  if (Object.keys(command)[0] === 'getMore' && origin && Object.keys(origin)[0] !== 'getMore') {
    const of = queryShape(origin)
    return of ? `getMore ${of}` : 'getMore'
  }
  const { name, parts } = partsOf(command)
  const keys = Object.keys(parts)
  if (!keys.length) return name
  const shaped = Object.fromEntries(
    keys.map((k) => [
      k,
      NAME_PARTS.has(k) && typeof parts[k] === 'string'
        ? (parts[k] as string).slice(0, 200)
        : k === 'pipeline'
          ? pipelineShape(parts[k])
          : shapeOf(parts[k], LITERAL_PARTS.has(k)),
    ]),
  )
  const text = `${name} ${JSON.stringify(shaped)}`
  return text.length > MAX_SHAPE ? `${text.slice(0, MAX_SHAPE)}…` : text
}
