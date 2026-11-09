// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 2 (value search, after Studio 3T's "Search In…"): a text, a number or an ObjectId
 * looked for in every field of the collection's documents — the paths found in a sample, one $or
 * over them — and which paths of a found document matched. Canonical Extended JSON throughout.
 */
export type Doc = Record<string, unknown>
export type Mode = 'contains' | 'exact' | 'regex'
export interface SearchSpec {
  term: string
  mode: Mode
  ignoreCase: boolean
  paths: string[]
}
export type SearchError = 'empty' | 'tooLong' | 'badRegex' | 'noPaths'

/** The longest regular expression taken (the server runs it on every value). */
export const MAX_REGEX = 200

const isWrapper = (v: unknown): boolean => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => k.startsWith('$'))
}

/** A path the server reads as a field: not empty, no empty part, no "$" first. */
const isPath = (p: string) => !!p && !p.startsWith('$') && !p.split('.').some((part) => part === '')

/** Every path holding a value in the sampled documents (through objects and arrays), in order. */
export function searchPaths(documents: Doc[], max = 100): string[] {
  const seen = new Set<string>()
  const walk = (value: unknown, path: string, depth: number) => {
    if (seen.size >= max || depth > 6) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, path, depth + 1)
      return
    }
    if (value && typeof value === 'object' && !isWrapper(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, depth + 1)
      return
    }
    if (path && isPath(path)) seen.add(path)
  }
  for (const d of documents) walk(d, '', 0)
  return [...seen].slice(0, max)
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NUMBER = /^-?\d+(\.\d+)?$/
const OBJECT_ID = /^[0-9a-f]{24}$/i
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?Z?$/

/**
 * Plugin tabs redesign: the span a typed date names, in UTC — a day, a minute, a second or a
 * millisecond, as precise as it was written; null for anything that is no real date.
 */
export function dateRange(term: string): { from: number; to: number } | null {
  const m = DATE.exec(term.trim())
  if (!m) return null
  const [, y, mo, d, hh, mi, ss, ms] = m
  const parts = [
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? 0),
    Number(mi ?? 0),
    Number(ss ?? 0),
  ] as const
  const from = Date.UTC(...parts, ms ? Number(ms.padEnd(3, '0')) : 0)
  const back = new Date(from)
  const same = [
    back.getUTCFullYear(),
    back.getUTCMonth(),
    back.getUTCDate(),
    back.getUTCHours(),
    back.getUTCMinutes(),
    back.getUTCSeconds(),
  ].every((v, i) => v === parts[i])
  if (!same) return null
  const step = ms ? 1 : ss ? 1000 : hh ? 60_000 : 86_400_000
  return { from, to: from + step }
}
const dateValue = (ms: number) => ({ $date: { $numberLong: String(ms) } })

/** A date value's milliseconds, or null for any other value. */
function dateMs(v: unknown): number | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const d = (v as Record<string, unknown>).$date
  const ms =
    typeof d === 'string'
      ? Date.parse(d)
      : d && typeof d === 'object' && typeof (d as Record<string, unknown>).$numberLong === 'string'
        ? Number((d as Record<string, string>).$numberLong)
        : NaN
  return Number.isFinite(ms) ? ms : null
}
/** A date as the app's grid shows one: UTC, to the second. */
const dateText = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

const LONG_MAX = 2n ** 63n

/**
 * A number as typed, kept exact (review M9): a whole number beyond 2^53 as a long, any other as a
 * double (MongoDB compares numbers across types).
 */
function numberValue(term: string): Record<string, string> {
  if (/^-?\d+$/.test(term) && !Number.isSafeInteger(Number(term))) {
    const big = BigInt(term)
    if (big >= -LONG_MAX && big < LONG_MAX) return { $numberLong: term }
    return { $numberDecimal: term }
  }
  return { $numberDouble: String(Number(term)) }
}

/**
 * User report 2026-10-15 (an order total of Decimal128 524.66 was found by neither 524 nor 524.66):
 * a number with a fraction is also looked for as the decimal written, since a Decimal128 is never
 * equal to the double nearest to it.
 */
const decimalToo = (term: string) => /^-?\d+\.\d+$/.test(term)

/** Digits as one may look for them inside a number: a digit, maybe a sign and a point. */
const DIGITS = /^-?[\d.]*\d[\d.]*$/

/**
 * The numbers in a path (a field, or any item of an array there) whose digits hold the pattern —
 * "524" finds 524.66 and 1524 as the text of a string would. Only for a path an expression can name.
 */
function digitsIn(path: string, pattern: string): Doc | null {
  if (path.includes('$')) return null
  const field = `$${path}`
  return {
    $expr: {
      $anyElementTrue: [
        {
          $map: {
            input: { $cond: [{ $isArray: field }, field, [field]] },
            as: 'v',
            in: {
              $and: [{ $isNumber: '$$v' }, { $regexMatch: { input: { $toString: '$$v' }, regex: pattern } }],
            },
          },
        },
      ],
    },
  }
}

/**
 * A pattern that may backtrack without end in a JavaScript engine: a group holding a quantifier,
 * itself repeated ("(a+)+"); repeated alternatives that may overlap ("(a|aa)+"); three unbounded
 * repeats or more. The server bounds its own run; the page never runs such a pattern (it only
 * leaves the matched fields unmarked).
 */
export function isRisky(pattern: string): boolean {
  // A group holding a quantifier, itself repeated ("(a+)+").
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) return true
  // Review 2026-10-10: a repeated group of alternatives longer than a character ("(a|aa)+").
  for (const m of pattern.matchAll(/\(((?:[^()\\]|\\.)*)\)[+*{]/g))
    if (
      m[1]!.includes('|') &&
      m[1]!
        .replace(/^\?:/, '')
        .split('|')
        .some((alt) => !/^(\\.|[^\\])$/.test(alt))
    )
      return true
  // …and three unbounded repeats or more ("\w*\w*\w*x"), each a factor of the time on no match.
  const unbounded = pattern.replace(/\\./g, 'x').match(/[+*]|\{\d+,\}/g) ?? []
  return unbounded.length >= 3
}

/** The longest value text the page tests a pattern on. */
const MAX_TESTED = 1000

/** The pattern a string value must match, or null for plain equality. */
function patternOf(spec: SearchSpec): string | null {
  if (spec.mode === 'regex') return spec.term
  if (spec.mode === 'contains') return escape(spec.term)
  return spec.ignoreCase ? `^${escape(spec.term)}\\z` : null
}

/** The documents holding the term in any of the paths, or why there is no such query. */
export function buildSearch(spec: SearchSpec): { filter: Doc } | { error: SearchError } {
  if (!spec.term.trim()) return { error: 'empty' }
  // The server (PCRE) judges a regular expression; the page only bounds it (review M8).
  if (spec.mode === 'regex' && spec.term.length > MAX_REGEX) return { error: 'tooLong' }
  const paths = spec.paths.filter(isPath)
  if (!paths.length) return { error: 'noPaths' }
  const pattern = patternOf(spec)
  const options = spec.ignoreCase ? 'i' : ''
  const term = spec.term.trim()
  const conditions: Doc[] = []
  const range = spec.mode === 'regex' ? null : dateRange(term)
  for (const p of paths) {
    conditions.push(
      pattern === null ? { [p]: { $eq: spec.term } } : { [p]: { $regularExpression: { pattern, options } } },
    )
    if (spec.mode !== 'regex' && NUMBER.test(term)) {
      conditions.push({ [p]: { $eq: numberValue(term) } })
      if (decimalToo(term)) conditions.push({ [p]: { $eq: { $numberDecimal: term } } })
    }
    if (spec.mode === 'contains' && DIGITS.test(term)) {
      const digits = digitsIn(p, escape(term))
      if (digits) conditions.push(digits)
    }
    if (spec.mode !== 'regex' && OBJECT_ID.test(term))
      conditions.push({ [p]: { $eq: { $oid: term.toLowerCase() } } })
    if (range) conditions.push({ [p]: { $gte: dateValue(range.from), $lt: dateValue(range.to) } })
  }
  return { filter: { $or: conditions } }
}

/** A value as text to look in: strings, numbers and ObjectIds; nothing else. */
function textOf(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  for (const k of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal', '$oid'])
    if (typeof o[k] === 'string') return o[k] as string
  return null
}

/** The paths of a found document whose values match, with the value (the page shows why it was found). */
export function matchedIn(doc: Doc, spec: Omit<SearchSpec, 'paths'>): Array<{ path: string; value: string }> {
  let test: (s: string) => boolean
  try {
    const flags = spec.ignoreCase ? 'i' : ''
    if (spec.mode === 'regex') {
      // Never a pattern that may run without end, nor on a long value (review M8).
      if (isRisky(spec.term)) return []
      const r = new RegExp(spec.term, flags)
      test = (s) => r.test(s.slice(0, MAX_TESTED))
    } else if (spec.mode === 'contains') {
      const t = spec.ignoreCase ? spec.term.toLowerCase() : spec.term
      test = (s) => (spec.ignoreCase ? s.toLowerCase() : s).includes(t)
    } else {
      const t = spec.ignoreCase ? spec.term.toLowerCase() : spec.term
      // A number is equal as a number, as the server compares it (review M9).
      const n = NUMBER.test(spec.term.trim()) ? Number(spec.term.trim()) : null
      test = (s) =>
        (spec.ignoreCase ? s.toLowerCase() : s) === t || (n !== null && NUMBER.test(s) && Number(s) === n)
    }
  } catch {
    return []
  }
  const range = spec.mode === 'regex' ? null : dateRange(spec.term)
  const found: Array<{ path: string; value: string }> = []
  const walk = (value: unknown, path: string, depth: number) => {
    if (found.length >= 20 || depth > 6) return
    if (Array.isArray(value)) return value.forEach((item) => walk(item, path, depth + 1))
    if (value && typeof value === 'object' && !isWrapper(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, depth + 1)
      return
    }
    const ms = dateMs(value)
    if (ms !== null) {
      if (range && ms >= range.from && ms < range.to) found.push({ path, value: dateText(ms) })
      return
    }
    const text = textOf(value)
    if (text !== null && test(text)) found.push({ path, value: text })
  }
  walk(doc, '', 0)
  return found
}

/** The sampled field names that hold the term (their last part). */
export function matchingNames(paths: string[], spec: { term: string; ignoreCase: boolean }): string[] {
  const t = spec.ignoreCase ? spec.term.toLowerCase() : spec.term
  if (!t.trim()) return []
  return paths.filter((p) => {
    const name = p.split('.').at(-1) ?? p
    return (spec.ignoreCase ? name.toLowerCase() : name).includes(t)
  })
}

/** Plugin tabs redesign: how many of the documents each path matched in, most first. */
export function facetsOf(
  docs: Doc[],
  spec: Omit<SearchSpec, 'paths'>,
): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>()
  for (const doc of docs)
    for (const path of new Set(matchedIn(doc, spec).map((m) => m.path)))
      counts.set(path, (counts.get(path) ?? 0) + 1)
  return [...counts]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Plugin tabs redesign: a document's first fields, to say which one it is — not _id, not what matched. */
export function previewOf(doc: Doc, matched: string[], n = 4): Array<{ key: string; value: unknown }> {
  return Object.entries(doc)
    .filter(([key]) => key !== '_id' && !matched.includes(key))
    .slice(0, n)
    .map(([key, value]) => ({ key, value }))
}
