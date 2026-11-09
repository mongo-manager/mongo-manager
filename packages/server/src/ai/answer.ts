// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  AI_LIMITS,
  isWritePipeline,
  parsePipeline,
  parseQueryObject,
  serializeValue,
  type AiAction,
  type AiResult,
  type AiWarning,
} from '@mongo-manager/shared'

export interface ParsedAnswer {
  result: AiResult | null
  warnings: AiWarning[]
  reason?: 'unparsable' | 'wrong_shape' | 'server_js' | 'needs_pipeline'
}

type Doc = Record<string, unknown>
const isPlain = (v: unknown): v is Doc =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const ejson = (v: unknown) => serializeValue(v) as Doc

/** Spec §1.4: the first fenced block (json, javascript, js or none as its tag). */
export function firstJsonBlock(text: string): string | null {
  const m = /```(?:json|javascript|js)?[ \t]*\r?\n([\s\S]*?)```/i.exec(text)
  return m ? m[1]!.trim() : null
}

const SERVER_JS = new Set(['$where', '$function', '$accumulator'])
export function usesServerJs(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(usesServerJs)
  if (!isPlain(v)) return false
  return Object.entries(v).some(([k, x]) => SERVER_JS.has(k) || usesServerJs(x))
}

const QUERY_KEYS = new Set(['filter', 'projection', 'sort'])
const INDEX_OPTIONS = new Set([
  'name',
  'unique',
  'sparse',
  'partialFilterExpression',
  'collation',
  'expireAfterSeconds',
  'hidden',
])
const INDEX_VALUES = new Set<unknown>([1, -1, 'text', 'hashed', '2dsphere', '2d'])

export function shape(action: AiAction, value: unknown, warnings: Set<AiWarning>): AiResult | null {
  if (action === 'pipeline') {
    if (!Array.isArray(value) || value.length === 0 || value.length > AI_LIMITS.stages) return null
    if (!value.every((s) => isPlain(s) && Object.keys(s).length === 1 && Object.keys(s)[0]!.startsWith('$')))
      return null
    if (isWritePipeline(value)) warnings.add('write_stage')
    return { kind: 'pipeline', stages: value.map(ejson) }
  }
  if (!isPlain(value)) return null
  if (action === 'query') {
    const keys = Object.keys(value)
    // A bare filter is taken as the filter.
    if (!keys.some((k) => QUERY_KEYS.has(k))) return { kind: 'query', filter: ejson(value) }
    if (keys.some((k) => !QUERY_KEYS.has(k))) warnings.add('dropped_keys')
    const filter = value.filter ?? {}
    if (!isPlain(filter)) return null
    for (const k of ['projection', 'sort'] as const)
      if (value[k] !== undefined && !isPlain(value[k])) return null
    return {
      kind: 'query',
      filter: ejson(filter),
      ...(isPlain(value.projection) ? { projection: ejson(value.projection) } : {}),
      ...(isPlain(value.sort) ? { sort: ejson(value.sort) } : {}),
    }
  }
  if (action === 'validation') {
    if (isPlain(value.$jsonSchema)) {
      if (Object.keys(value).length > 1) warnings.add('dropped_keys')
      return { kind: 'validation', validator: ejson({ $jsonSchema: value.$jsonSchema }) }
    }
    // A bare JSON Schema is wrapped.
    if ('bsonType' in value || 'properties' in value || 'required' in value)
      return { kind: 'validation', validator: ejson({ $jsonSchema: value }) }
    return null
  }
  // optimise
  const list = value.indexes
  if (!Array.isArray(list)) return null
  if (list.length > AI_LIMITS.indexes) warnings.add('dropped_keys')
  const indexes: Array<{ keys: Doc; options: Doc }> = []
  for (const item of list.slice(0, AI_LIMITS.indexes)) {
    if (!isPlain(item) || !isPlain(item.keys)) return null
    const keys = Object.values(item.keys)
    if (keys.length === 0 || !keys.every((v) => INDEX_VALUES.has(v))) return null
    const options: Doc = {}
    if (item.options !== undefined) {
      if (!isPlain(item.options)) return null
      for (const [k, v] of Object.entries(item.options))
        if (INDEX_OPTIONS.has(k)) options[k] = v
        else warnings.add('dropped_keys')
    }
    indexes.push({ keys: ejson(item.keys), options: ejson(options) })
  }
  return { kind: 'optimise', indexes }
}

/** Spec §1.4, plan ruling 7. */
export function parseAnswer(action: AiAction, text: string, allowServerJs: boolean): ParsedAnswer {
  if (action === 'explain' || action === 'describe') return { result: null, warnings: [] }
  const block = firstJsonBlock(text)
  if (block === null)
    return action === 'optimise'
      ? { result: null, warnings: [] }
      : { result: null, warnings: [], reason: 'unparsable' }
  let value: unknown
  try {
    value = action === 'pipeline' ? parsePipeline(block) : parseQueryObject(block)
  } catch {
    return { result: null, warnings: [], reason: 'unparsable' }
  }
  // UI redesign R1 review: a find cannot join, group or compute — the model says so instead.
  if (
    action === 'query' &&
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).needsPipeline === true
  )
    return { result: null, warnings: [], reason: 'needs_pipeline' }
  const warnings = new Set<AiWarning>()
  const result = shape(action, value, warnings)
  if (!result) return { result: null, warnings: [], reason: 'wrong_shape' }
  if (usesServerJs(value)) {
    if (!allowServerJs) return { result: null, warnings: [], reason: 'server_js' }
    warnings.add('server_js')
  }
  return { result, warnings: [...warnings] }
}
