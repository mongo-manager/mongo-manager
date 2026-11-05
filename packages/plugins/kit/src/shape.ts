// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 3 (spec §2): the shape of sampled documents as a plugin reads them (canonical
 * Extended JSON) — each field's share and types, and a few examples where they are few, short and
 * not hidden. A field personal-data rules hide from the user (`hidden`, from `context.get`) is
 * named only: its type is never told, and its "***" is not taken for a string.
 */
import { matchesAny } from '../../../shared/src/masking/glob'

export interface FieldShape {
  /** For display: keys joined by "." (array elements as "[]"): `items[].qty`. */
  path: string
  /** The keys, arrays left out (as personal-data rules name a field). */
  segments: string[]
  /** Share of the documents holding it, 0–1. */
  share: number
  /** The types seen, most common first (none for a hidden field). */
  types: Array<{ type: string; count: number }>
  hidden: boolean
  /** Its distinct values, where they are at most 20 short strings and the field is not hidden. */
  examples?: string[]
}

/** How deep a field is followed (top level is 1). */
const DEPTH = 4
const EXAMPLES = 20
const EXAMPLE_CHARS = 40

const has = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key)

/** A value's BSON type, from canonical (or relaxed) Extended JSON, named as the app names it. */
export function typeOfEjson(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'number') return 'double'
  if (Array.isArray(v)) return 'array'
  if (typeof v !== 'object') return 'string'
  const o = v as Record<string, unknown>
  if (has(o, '$oid')) return 'objectId'
  if (has(o, '$date')) return 'date'
  if (has(o, '$numberInt')) return 'int32'
  if (has(o, '$numberDouble')) return 'double'
  if (has(o, '$numberLong')) return 'long'
  if (has(o, '$numberDecimal')) return 'decimal128'
  if (has(o, '$uuid')) return 'uuid'
  if (has(o, '$binary')) {
    const sub = (o.$binary as { subType?: unknown } | null)?.subType
    return sub === '04' || sub === '4' ? 'uuid' : 'binary'
  }
  if (has(o, '$regularExpression')) return 'regex'
  if (has(o, '$timestamp')) return 'timestamp'
  if (has(o, '$minKey')) return 'minKey'
  if (has(o, '$maxKey')) return 'maxKey'
  if (has(o, '$code')) return 'javascript'
  if (has(o, '$symbol')) return 'symbol'
  if (has(o, '$dbPointer')) return 'dbPointer'
  return 'object'
}

/** Whether personal-data rules hide this field (or one above it) from the user — as the app matches. */
export const hiddenMatch = (patterns: readonly (readonly string[])[], segments: readonly string[]): boolean =>
  patterns.length > 0 && matchesAny(patterns, segments)

interface Tally {
  path: string
  segments: string[]
  docs: number
  types: Map<string, number>
  hidden: boolean
  values: Set<string> | null
}

/** The fields of the documents, each once, in the order first met. */
export function shapeOf(documents: readonly unknown[], hidden: readonly (readonly string[])[]): FieldShape[] {
  const tallies = new Map<string, Tally>()
  const tally = (path: string, segments: string[]): Tally => {
    let t = tallies.get(path)
    if (!t) {
      t = {
        path,
        segments,
        docs: 0,
        types: new Map(),
        hidden: hiddenMatch(hidden, segments),
        values: new Set(),
      }
      tallies.set(path, t)
    }
    return t
  }
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue
    const seen = new Set<string>()
    const visit = (value: unknown, path: string, segments: string[], inArray: boolean) => {
      const t = tally(path, segments)
      if (!seen.has(path)) {
        seen.add(path)
        t.docs++
      }
      if (t.hidden) {
        t.values = null
        return
      }
      const type = typeOfEjson(value)
      // An array's elements count as its field's values, under `[]`.
      if (type === 'array' && !inArray) {
        t.types.set('array', (t.types.get('array') ?? 0) + 1)
        t.values = null
        for (const item of value as unknown[]) {
          const itemType = typeOfEjson(item)
          if (itemType === 'object') walk(item as Record<string, unknown>, `${path}[]`, segments)
        }
        return
      }
      t.types.set(type, (t.types.get(type) ?? 0) + 1)
      if (type === 'string' && t.values) {
        const s = value as string
        if ([...s].length > EXAMPLE_CHARS) t.values = null
        else {
          t.values.add(s)
          if (t.values.size > EXAMPLES) t.values = null
        }
      } else t.values = null
      if (type === 'object') walk(value as Record<string, unknown>, path, segments)
    }
    const walk = (o: Record<string, unknown>, base: string, segments: string[]) => {
      if (segments.length >= DEPTH) return
      for (const [key, value] of Object.entries(o)) {
        const path = base ? `${base}.${key}` : key
        visit(value, path, [...segments, key], false)
      }
    }
    walk(doc as Record<string, unknown>, '', [])
  }
  const total = documents.length || 1
  return [...tallies.values()].map((t) => {
    const types = t.hidden
      ? []
      : [...t.types.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }))
    return {
      path: t.path,
      segments: t.segments,
      share: Math.round((t.docs / total) * 1000) / 1000,
      types,
      hidden: t.hidden,
      // A value that is not a short string emptied `values` when it was met.
      ...(!t.hidden && t.values && t.values.size ? { examples: [...t.values] } : {}),
    }
  })
}

/** A field's most common type; "hidden" for one the user may not see. */
export const mainType = (field: FieldShape): string =>
  field.hidden ? 'hidden' : (field.types[0]?.type ?? 'null')
