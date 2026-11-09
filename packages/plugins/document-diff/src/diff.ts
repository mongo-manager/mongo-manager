// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 2 (document diff): two documents compared field by field — objects by field,
 * arrays by index, any other value whole by its canonical Extended JSON (so a type change is a
 * change) — and an _id as a person types it.
 */
export type Doc = Record<string, unknown>
export interface Change {
  path: string
  kind: 'added' | 'removed' | 'changed'
  left?: unknown
  right?: unknown
}
export interface Diff {
  changes: Change[]
  /** The fields that are the same, with their value. */
  same: Array<{ path: string; value: unknown }>
}

const isWrapper = (v: Record<string, unknown>) => {
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => k.startsWith('$'))
}
const kindOf = (v: unknown): 'object' | 'array' | 'value' =>
  Array.isArray(v) ? 'array' : v && typeof v === 'object' && !isWrapper(v as Doc) ? 'object' : 'value'
const MAX_DEPTH = 100

/** The changes from `left` to `right`; the documents' own _id is left out (they differ by nature). */
export function diffDocuments(left: Doc, right: Doc): Diff {
  const changes: Change[] = []
  const same: Diff['same'] = []
  const walk = (l: unknown, r: unknown, path: string, depth: number) => {
    const kl = kindOf(l)
    const kr = kindOf(r)
    if (depth < MAX_DEPTH && kl === 'object' && kr === 'object') {
      const lo = l as Doc
      const ro = r as Doc
      const keys = [...Object.keys(lo), ...Object.keys(ro).filter((k) => !Object.hasOwn(lo, k))]
      for (const k of keys) {
        if (depth === 0 && k === '_id') continue
        const p = path ? `${path}.${k}` : k
        if (!Object.hasOwn(ro, k)) changes.push({ path: p, kind: 'removed', left: lo[k] })
        else if (!Object.hasOwn(lo, k)) changes.push({ path: p, kind: 'added', right: ro[k] })
        else walk(lo[k], ro[k], p, depth + 1)
      }
      return
    }
    if (depth < MAX_DEPTH && kl === 'array' && kr === 'array') {
      const la = l as unknown[]
      const ra = r as unknown[]
      for (let i = 0; i < Math.max(la.length, ra.length); i++) {
        const p = `${path}.${i}`
        if (i >= ra.length) changes.push({ path: p, kind: 'removed', left: la[i] })
        else if (i >= la.length) changes.push({ path: p, kind: 'added', right: ra[i] })
        else walk(la[i], ra[i], p, depth + 1)
      }
      return
    }
    if (JSON.stringify(l) === JSON.stringify(r)) same.push({ path, value: l })
    else changes.push({ path, kind: 'changed', left: l, right: r })
  }
  walk(left, right, '', 0)
  return { changes, same }
}

/** The changes as JSON, to copy. */
export const changesAsJson = (diff: Diff): string => JSON.stringify(diff.changes, null, 2)

/**
 * An _id as typed: 24 hex digits are an ObjectId, a whole number is a number, quoted or braced
 * text is Extended JSON, anything else a string; nothing typed is null.
 */
export function parseId(typed: string): unknown {
  const text = typed.trim()
  if (!text) return null
  if (/^[0-9a-f]{24}$/i.test(text)) return { $oid: text.toLowerCase() }
  if (/^-?\d{1,19}$/.test(text)) {
    const n = Number(text)
    if (Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647) return { $numberInt: String(n) }
    const big = BigInt(text)
    if (big >= -(2n ** 63n) && big < 2n ** 63n) return { $numberLong: text }
  }
  // A decimal number is a double, as typed (review M10).
  if (/^-?\d+\.\d+$/.test(text)) return { $numberDouble: text }
  if (/^[{["]/.test(text)) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  return text
}

/**
 * An _id as the box shows it, so that reading it back gives the same value (review M10): an
 * ObjectId by its hex digits, a number by its digits when they read as that number, a string
 * quoted, anything else as Extended JSON.
 */
export function idInput(id: unknown): string {
  const same = (text: string) => JSON.stringify(parseId(text)) === JSON.stringify(id)
  if (id && typeof id === 'object' && !Array.isArray(id)) {
    const o = id as Record<string, unknown>
    for (const k of ['$oid', '$numberInt', '$numberLong', '$numberDouble'])
      if (typeof o[k] === 'string' && same(o[k] as string)) return o[k] as string
  }
  return JSON.stringify(id)
}
