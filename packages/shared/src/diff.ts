// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { bsonTypeOf, toWire } from './ejson'

/** One changed field; `before` or `after` is absent when the field is missing on that side. */
export interface FieldChange {
  path: string
  before?: unknown
  after?: unknown
}

export type DocumentDiff =
  | { kind: 'none' }
  | { kind: 'update'; set: Record<string, unknown>; unset: string[]; changes: FieldChange[] }
  | {
      kind: 'replace'
      /**
       * - field-name: a changed field's name cannot be written as a path (".", "$", empty, NUL,
       *   __proto__);
       * - order: fields were reordered, or added where $set would not put them;
       * - too-many: more paths than one update may carry;
       * - path-length: a path longer than the server accepts;
       * - hidden: (the editor's) an update would carry a value hidden from the user (an array compared
       *   whole); a replace keeps hidden values where they are.
       */
      reason: 'field-name' | 'order' | 'too-many' | 'path-length' | 'hidden'
      changes: FieldChange[]
    }

/** The server's UpdateRequestSchema limits. */
const MAX_PATHS = 1000
const MAX_PATH_LENGTH = 1024

/**
 * Whether a field name can be one segment of an update path: not empty, no "$" at the start, no
 * "." or NUL, and not __proto__ (which a plain object cannot carry as a key).
 */
export const pathSafe = (key: string): boolean =>
  key !== '' && !key.startsWith('$') && !key.includes('.') && !key.includes('\0') && key !== '__proto__'

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i])
/** MongoDB (5.0+) appends fields that $set adds in this order; numeric-looking names sort apart. */
const lexicographic = (keys: string[]) =>
  keys.every((k, i) => !/^\d+$/.test(k) && (i === 0 || keys[i - 1]! < k))

const isObject = (v: unknown): v is Record<string, unknown> => bsonTypeOf(v) === 'object'

/**
 * The field-level change from `before` to `after` (decoded BSON documents), as MongoDB update
 * operators (spec §4.2). Values compare by canonical EJSON, so a type change is a change.
 * Objects on both sides are compared field by field; arrays and all other values whole. `_id`
 * is left out: changing it is refused by the caller.
 */
export function documentDiff(before: Record<string, unknown>, after: Record<string, unknown>): DocumentDiff {
  const set: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const unset: string[] = []
  const changes: FieldChange[] = []
  let badName = false
  let reordered = false

  const walk = (b: Record<string, unknown>, a: Record<string, unknown>, prefix: string, safe: boolean) => {
    const keep = (k: string) => prefix !== '' || k !== '_id'
    const bKeys = Object.keys(b).filter(keep)
    const aKeys = Object.keys(a).filter(keep)
    const common = (keys: string[], other: Record<string, unknown>) =>
      keys.filter((k) => Object.hasOwn(other, k))
    if (!sameOrder(common(bKeys, a), common(aKeys, b))) reordered = true
    // Added fields can only be kept where $set puts them: after every existing one, sorted.
    const firstAdded = aKeys.findIndex((k) => !Object.hasOwn(b, k))
    if (firstAdded >= 0) {
      const tail = aKeys.slice(firstAdded)
      if (tail.some((k) => Object.hasOwn(b, k)) || !lexicographic(tail)) reordered = true
    }
    const changed = (k: string, change: FieldChange) => {
      if (!(safe && pathSafe(k))) badName = true
      changes.push(change)
    }
    for (const k of bKeys) {
      const path = prefix + k
      if (!Object.hasOwn(a, k)) {
        changed(k, { path, before: b[k] })
        unset.push(path)
      } else if (isObject(b[k]) && isObject(a[k])) {
        walk(b[k], a[k], `${path}.`, safe && pathSafe(k))
      } else if (toWire(b[k]) !== toWire(a[k])) {
        changed(k, { path, before: b[k], after: a[k] })
        set[path] = a[k]
      }
    }
    for (const k of aKeys) {
      if (Object.hasOwn(b, k)) continue
      const path = prefix + k
      changed(k, { path, after: a[k] })
      set[path] = a[k]
    }
  }

  walk(before, after, '', true)
  if (badName) return { kind: 'replace', reason: 'field-name', changes }
  if (reordered) return { kind: 'replace', reason: 'order', changes }
  if (changes.length === 0) return { kind: 'none' }
  if (Object.keys(set).length > MAX_PATHS || unset.length > MAX_PATHS) {
    return { kind: 'replace', reason: 'too-many', changes }
  }
  if ([...Object.keys(set), ...unset].some((p) => p.length > MAX_PATH_LENGTH)) {
    return { kind: 'replace', reason: 'path-length', changes }
  }
  return { kind: 'update', set, unset, changes }
}
