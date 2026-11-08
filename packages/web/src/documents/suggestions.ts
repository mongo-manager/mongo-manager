// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { SCHEMA_MAX_VALUE_LENGTH, type FieldStats, type SchemaAnalysis } from '@mongo-manager/shared/browser'
import type { LibraryItem } from '@mongo-manager/shared/browser'
import { describeCondition } from './filterChips'
import { decodeValue, isDocument, toShell, typeOf } from './values'

/**
 * W1 (completion §2): conditions offered under the composer, from a small schema sample — the
 * common value of a field that holds a few (`status = "paid"`), and fields many documents lack
 * (`coupon exists`). A hidden field (phase 3c) is never offered, by name or by value.
 */
export interface FilterSuggestion {
  field: string
  /** The condition added to the filter (plain values). */
  condition: Record<string, unknown>
  label: string
}

const MAX = 6
const MAX_EXISTS = 2
/** A field present in fewer documents than this share is worth asking about. */
const SPARSE = 0.9

/** A field's dotted path when every key is a plain name (not an array element, "$…" or dotted). */
function pathOf(f: FieldStats): string | null {
  if (f.keys.length === 0) return null
  for (const key of f.keys)
    if (key === null || key === '' || key.startsWith('$') || key.includes('.')) return null
  return f.keys.join('.')
}

/** The value worth offering: a string or boolean seen more than once, whole (never cut short). */
function commonValue(f: FieldStats): string | boolean | undefined {
  const top = f.top?.[0]
  if (!top || top.count < 2 || top.cut || top.value.length >= SCHEMA_MAX_VALUE_LENGTH) return undefined
  const types = Object.keys(f.types).filter((t) => t !== 'null')
  // W2: a top value says its own type; the field's single type is still asked for.
  if (types.length === 1 && types[0] === 'bool' && top.type === 'bool')
    return top.value === 'true' ? true : top.value === 'false' ? false : undefined
  if (types.length === 1 && types[0] === 'string' && top.type === 'string') return top.value
  return undefined
}

export function filterSuggestions(
  analysis: SchemaAnalysis,
  isMasked: (path: readonly string[]) => boolean,
  filtered: readonly string[],
): FilterSuggestion[] {
  const values: Array<FilterSuggestion & { share: number }> = []
  const exists: Array<FilterSuggestion & { share: number }> = []
  const sampled = Math.max(1, analysis.sampled)
  const taken = new Set(filtered)
  for (const f of analysis.fields) {
    const field = pathOf(f)
    if (!field || field === '_id' || taken.has(field)) continue
    if (f.masked || isMasked(f.keys as string[])) continue
    const value = commonValue(f)
    // User report 2026-11-07: a value every sampled document holds would filter nothing out (headers
    // every log carries filled all six chips).
    if (value !== undefined && f.top![0]!.count >= sampled) continue
    if (value !== undefined) {
      values.push({
        field,
        condition: { [field]: value },
        label: `${field} = ${toShell(value, 0)}`,
        share: f.top![0]!.count / Math.max(1, f.count),
      })
    } else if (f.count / sampled < SPARSE) {
      exists.push({
        field,
        condition: { [field]: { $exists: true } },
        label: `${field} exists`,
        share: f.count / sampled,
      })
    }
  }
  const byShare = (a: { share: number }, b: { share: number }) => b.share - a.share
  const chosenExists = exists.sort(byShare).slice(0, MAX_EXISTS)
  const chosenValues = values.sort(byShare).slice(0, MAX - chosenExists.length)
  return [...chosenValues, ...chosenExists].map(({ share: _share, ...s }) => s)
}

/** W1 review (minor 13): a value a recent condition may hold — a scalar, or one operator on one. */
const SCALAR = new Set([
  'string',
  'int32',
  'double',
  'long',
  'decimal128',
  'boolean',
  'date',
  'objectId',
  'null',
])
function plainCondition(value: unknown): boolean {
  if (SCALAR.has(typeOf(value))) return true
  if (!isDocument(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0]!.startsWith('$') && SCALAR.has(typeOf(value[keys[0]!]))
}

/**
 * W1 review (minor 13): conditions the user ran lately on the collection (its query history, newest
 * first): plain top-level ones, once each, never on a hidden field or one the filter already names.
 */
export function recentSuggestions(
  items: readonly LibraryItem[],
  isMasked: (path: readonly string[]) => boolean,
  filtered: readonly string[],
  max = 3,
): FilterSuggestion[] {
  const out: FilterSuggestion[] = []
  const seen = new Set<string>()
  const taken = new Set(filtered)
  for (const item of items) {
    if (item.type !== 'history' || !isDocument(item.body)) continue
    const raw = (item.body as { filter?: unknown }).filter
    if (!raw || typeof raw !== 'object') continue
    let filter: Record<string, unknown>
    try {
      filter = decodeValue(raw) as Record<string, unknown>
    } catch {
      continue
    }
    for (const [field, value] of Object.entries(filter)) {
      if (out.length >= max) return out
      if (field.startsWith('$') || field.split('.').some((k) => k === '' || k.startsWith('$'))) continue
      if (taken.has(field) || isMasked(field.split('.')) || !plainCondition(value)) continue
      const label = describeCondition(field, value)
      if (seen.has(label)) continue
      seen.add(label)
      out.push({ field, condition: { [field]: value }, label })
    }
  }
  return out
}
