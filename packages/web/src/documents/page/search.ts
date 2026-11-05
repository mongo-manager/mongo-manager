// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { summarize, typeOf } from '../values'

/**
 * Document page design §6.7 (user request 2026-11-04): a search inside the open document — its keys,
 * its values or both — so a value deep in a reservation's payments is found without the browser's
 * Ctrl+F. It runs in the page only; nothing is sent.
 */
export type SearchScope = 'both' | 'keys' | 'values'

/** One match: the field it is in, whether in its key or its value, and where in the text shown. */
export interface DocMatch {
  path: readonly string[]
  part: 'key' | 'value'
  start: number
  end: number
}

/** Past this many matches the count says "10,000+" and the search stops (a large document stays quick). */
export const MATCH_LIMIT = 10_000

/** What stands for a hidden value on the page by default; a search finds that, never the value. */
const HIDDEN_SHOWN = '***'

/** The text the tree shows for a scalar: a string whole (unquoted), anything else as its cell shows it. */
export function shownText(value: unknown): string {
  if (typeOf(value) === 'string') return value as string
  const summary = summarize(value)
  return summary.kind === 'scalar' ? summary.text : ''
}

const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] => {
  const type = typeOf(value)
  return type === 'object' || type === 'array'
}

/** The fields of `doc` whose key or value holds `query`, in document order (depth first). */
export function searchDocument(
  doc: Record<string, unknown>,
  query: string,
  scope: SearchScope,
  isMasked: (path: readonly string[]) => boolean,
  /** What the view shows for a hidden value (the tree writes a word, the JSON ***). */
  hiddenText = HIDDEN_SHOWN,
): { matches: DocMatch[]; capped: boolean } {
  const matches: DocMatch[] = []
  const needle = query.toLowerCase()
  if (!needle) return { matches, capped: false }
  let capped = false
  const add = (path: readonly string[], part: DocMatch['part'], text: string): boolean => {
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) return true
    if (matches.length >= MATCH_LIMIT) {
      capped = true
      return false
    }
    matches.push({ path, part, start: at, end: at + needle.length })
    return true
  }
  const walk = (value: Record<string, unknown> | unknown[], parent: readonly string[]): boolean => {
    const entries: Array<[string, unknown]> = Array.isArray(value)
      ? value.map((item, i): [string, unknown] => [String(i), item])
      : Object.entries(value)
    for (const [key, child] of entries) {
      const path = [...parent, key]
      // An array's indexes are places, not keys someone named: they are not searched as keys.
      if (scope !== 'values' && !Array.isArray(value) && !add(path, 'key', key)) return false
      if (isMasked(path)) {
        if (scope !== 'keys' && !add(path, 'value', hiddenText)) return false
      } else if (isContainer(child)) {
        if (!walk(child, path)) return false
      } else if (scope !== 'keys' && !add(path, 'value', shownText(child))) return false
    }
    return true
  }
  walk(doc, [])
  return { matches, capped }
}

/** Every place `query` is in `text` (case-insensitive), for the JSON and edit views. */
export function textMatches(
  text: string,
  query: string,
  limit = MATCH_LIMIT,
): { ranges: Array<[number, number]>; capped: boolean } {
  const ranges: Array<[number, number]> = []
  const needle = query.toLowerCase()
  if (!needle) return { ranges, capped: false }
  const haystack = text.toLowerCase()
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    if (ranges.length >= limit) return { ranges, capped: true }
    ranges.push([at, at + needle.length])
  }
  return { ranges, capped: false }
}

/**
 * The text near a field: each of its keys in turn, written as a key (`name:` or `"name":`), so a
 * value holding the same word is not taken for it (the tree's "edit in text").
 */
export function keyPlace(text: string, path: readonly string[]): number {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let at = 0
  for (const part of path) {
    if (/^\d+$/.test(part)) continue
    // A key starts a line or follows `{` or `,` (and spaces); a word inside a value does not.
    const key = new RegExp(`(^|[{,\\s])(?:${escape(part)}|${escape(JSON.stringify(part))})\\s*:`, 'g')
    key.lastIndex = at
    const found = key.exec(text)
    if (!found) break
    at = found.index + found[1]!.length
  }
  return at
}
