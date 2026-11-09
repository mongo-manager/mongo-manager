// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { toShell } from './values'

/**
 * Review 2026-11-07: a field's diff is by lines; this says in words which values changed in it, by
 * their path (payments.10.amount: 110 → 999), as a person thinks of the change.
 */
export interface ValueChange {
  path: string
  kind: 'changed' | 'added' | 'removed'
  /** The value as written in the shell, one line, cut short when long. */
  before?: string
  after?: string
}

const MAX_TEXT = 60
const isDocument = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const text = (v: unknown) => {
  const s = toShell(v, 0)
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s
}

/** The values changed between two values of a field, in document order: at most `max`, the rest counted. */
export function valueChanges(
  path: string,
  before: unknown,
  after: unknown,
  max = 6,
): { changes: ValueChange[]; more: number } {
  const changes: ValueChange[] = []
  let count = 0
  const add = (change: ValueChange) => {
    count++
    if (changes.length < max) changes.push(change)
  }
  // A path from the document itself (no field given) has no leading dot.
  const join = (at: string, key: string | number) => (at ? `${at}.${key}` : String(key))
  const walk = (at: string, a: unknown, b: unknown): void => {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const p = join(at, i)
        if (i >= b.length) add({ path: p, kind: 'removed', before: text(a[i]) })
        else if (i >= a.length) add({ path: p, kind: 'added', after: text(b[i]) })
        else walk(p, a[i], b[i])
      }
      return
    }
    if (isDocument(a) && isDocument(b)) {
      for (const key of Object.keys(a)) {
        const p = join(at, key)
        if (!Object.hasOwn(b, key)) add({ path: p, kind: 'removed', before: text(a[key]) })
        else walk(p, a[key], b[key])
      }
      for (const key of Object.keys(b))
        if (!Object.hasOwn(a, key)) add({ path: join(at, key), kind: 'added', after: text(b[key]) })
      return
    }
    const x = toShell(a, 0)
    const y = toShell(b, 0)
    if (x !== y) add({ path: at, kind: 'changed', before: text(a), after: text(b) })
  }
  walk(path, before, after)
  return { changes, more: count - changes.length }
}
