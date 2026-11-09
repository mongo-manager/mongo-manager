// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { tokenize, type Token } from '@/ds/code/tokenize'
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

/**
 * Review 2026-11-07: a text as the search compares it, and where each of its characters came from.
 * Folded one letter at a time — "İ".toLowerCase() is two characters, and a match found in the whole
 * text lowered was one place to the right of what it marked — so every offset is the original's.
 * Case is ignored; Turkish ı and İ are i, as a Turkish reader types them on any keyboard; a Latin
 * letter's accents are ignored (Şişli by sisli, café by cafe), as the browser's own find does.
 * Other scripts keep their marks: in Japanese が is another letter than か.
 */
interface Folded {
  text: string
  /** Where folded character i starts and ends in the original; null when they are the same. */
  starts: number[] | null
  ends: number[] | null
}

/** Printable ASCII and line breaks: folded by lowering alone, every offset kept. */
const PLAIN = /^[\t\n\r -~]*$/
const LATIN = /\p{Script=Latin}/u
const MARKS = /\p{M}/gu
const IS_MARK = /^\p{M}+$/u
const letters = new Map<string, string>()

function foldLetter(ch: string): string {
  let out = letters.get(ch)
  if (out === undefined) {
    const base = ch.normalize('NFD')
    out = LATIN.test(base) ? base.replace(MARKS, '').toLowerCase().replace(/ı/g, 'i') : ch.toLowerCase()
    if (letters.size > 4096) letters.clear()
    letters.set(ch, out)
  }
  return out
}

function fold(text: string): Folded {
  if (PLAIN.test(text)) return { text: text.toLowerCase(), starts: null, ends: null }
  let out = ''
  const starts: number[] = []
  const ends: number[] = []
  let at = 0
  let afterLatin = false
  for (const ch of text) {
    const end = at + ch.length
    // A mark written apart from its letter (e + ◌́) goes with it: ignored after a Latin letter,
    // kept after any other.
    if (IS_MARK.test(ch) && afterLatin) {
      if (ends.length) ends[ends.length - 1] = end
    } else {
      const folded = foldLetter(ch)
      afterLatin = LATIN.test(ch)
      out += folded
      for (let i = 0; i < folded.length; i++) {
        starts.push(at)
        ends.push(end)
      }
    }
    at = end
  }
  return { text: out, starts, ends }
}

/** Every place the folded `needle` is in `text`, as offsets of the original text. */
function* placesIn(text: string, needle: string): Generator<[number, number]> {
  const f = fold(text)
  for (let at = f.text.indexOf(needle); at >= 0; at = f.text.indexOf(needle, at + needle.length)) {
    const last = at + needle.length - 1
    yield f.starts ? [f.starts[at]!, f.ends![last]!] : [at, last + 1]
  }
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
  const needle = fold(query).text
  if (!needle) return { matches, capped: false }
  let capped = false
  const add = (path: readonly string[], part: DocMatch['part'], text: string): boolean => {
    const first = placesIn(text, needle).next()
    if (first.done) return true
    if (matches.length >= MATCH_LIMIT) {
      capped = true
      return false
    }
    const [start, end] = first.value
    matches.push({ path, part, start, end })
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

/**
 * Where the keys of a text are (`"name":` or `name:`), in order. Review 2026-11-07: the scope the
 * search bar offers holds in the JSON and edit views too.
 */
function keySpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let at = 0
  const tokens = tokenize(text)
  tokens.forEach((token, i) => {
    const end = at + token.text.length
    // An operator written bare ($gt: 1) is a key as well.
    if (token.type === 'key' || (token.type === 'operator' && nextIsColon(tokens, i))) spans.push([at, end])
    at = end
  })
  return spans
}

const nextIsColon = (tokens: readonly Token[], i: number): boolean => {
  for (let j = i + 1; j < tokens.length; j++) {
    const text = tokens[j]!.text
    if (tokens[j]!.type === 'text' && !text.trim()) continue
    return text.startsWith(':')
  }
  return false
}

/** Every place `query` is in `text` (folded as the tree's search folds it), for the JSON and edit views. */
export function textMatches(
  text: string,
  query: string,
  scope: SearchScope = 'both',
  limit = MATCH_LIMIT,
): { ranges: Array<[number, number]>; capped: boolean } {
  const ranges: Array<[number, number]> = []
  const needle = fold(query).text
  if (!needle) return { ranges, capped: false }
  const keys = scope === 'both' ? [] : keySpans(text)
  let k = 0
  for (const [start, end] of placesIn(text, needle)) {
    if (scope !== 'both') {
      while (k < keys.length && keys[k]![1] <= start) k++
      const span = keys[k]
      const inKey = !!span && span[0] <= start && end <= span[1]
      const touchesKey = !!span && span[0] < end
      if (scope === 'keys' ? !inKey : touchesKey) continue
    }
    if (ranges.length >= limit) return { ranges, capped: true }
    ranges.push([start, end])
  }
  return { ranges, capped: false }
}

/** Thrown inside fieldPlace when the text stops being a value it can follow (half typed). */
const LOST = Symbol('lost')

/**
 * Where a field's value is in a document's text, [from, to) — the tree's "edit in text" selects it.
 * Review 2026-11-07: found by following the path through the text's objects and arrays, as the
 * shell reads them: a key of the same name at another depth, a word inside a string, an array's
 * other items, commas in a call or a regular expression are never taken for it. The value, not the
 * key, is selected: it is what "edit in text" is for (a value the tree does not edit), an array's
 * item has no key, and the selection shows where the value ends. Null when the text does not reach
 * the field (it does not parse, or holds no such field).
 */
export function fieldPlace(text: string, path: readonly string[]): [number, number] | null {
  let i = 0
  const n = text.length
  const space = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i]!)) i++
      if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i)
        i = end < 0 ? n : end
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2)
        i = end < 0 ? n : end + 2
      } else return
    }
  }
  /** Past a quoted string; its text. */
  const quoted = (): string => {
    const quote = text[i]!
    const from = i++
    while (i < n && text[i] !== quote) i += text[i] === '\\' ? 2 : 1
    if (i >= n) throw LOST
    i++
    const inner = text.slice(from, i)
    if (quote === '"')
      try {
        return JSON.parse(inner) as string
      } catch {
        // an escape JSON does not know: read as written
      }
    return inner.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  /** Past a regular expression written /…/flags (a slash inside […] does not end it). */
  const regex = () => {
    let inClass = false
    for (i++; i < n; i++) {
      const c = text[i]
      if (c === '\\') i++
      else if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) break
      else if (c === '\n') throw LOST
    }
    if (i >= n) throw LOST
    i++
    while (i < n && /[a-z]/i.test(text[i]!)) i++
  }
  /** Past a value that is no object or array (a string, a number, a call); where it ends. */
  const scalar = (): number => {
    if (text[i] === '/' && text[i + 1] !== '/' && text[i + 1] !== '*') regex()
    let depth = 0
    let end = i
    while (i < n) {
      const c = text[i]!
      if (c === '"' || c === "'") quoted()
      else if (text.startsWith('//', i) || text.startsWith('/*', i)) {
        space()
        continue
      } else if (/\s/.test(c)) {
        i++
        continue
      } else if ('([{'.includes(c)) {
        depth++
        i++
      } else if (')]}'.includes(c) || (c === ',' && depth === 0)) {
        if (depth === 0) break
        depth--
        i++
      } else i++
      end = i
    }
    return end
  }
  const same = (at: readonly string[]) => at.length === path.length && at.every((p, k) => p === path[k])
  let found: [number, number] | null = null
  /** Past a value at `at`; where it ends. */
  const value = (at: readonly string[]): number => {
    space()
    const from = i
    let end: number
    if (text[i] === '{') end = object(at)
    else if (text[i] === '[') end = array(at)
    else end = scalar()
    if (end === from) throw LOST
    if (same(at)) found = [from, end]
    return end
  }
  const object = (at: readonly string[]): number => {
    i++
    for (;;) {
      space()
      if (text[i] === '}') return ++i
      let key: string
      if (text[i] === '"' || text[i] === "'") key = quoted()
      else {
        const bare = /^[^\s:,{}[\]()"']+/.exec(text.slice(i, i + 1024))
        if (!bare) throw LOST
        key = bare[0]
        i += key.length
      }
      space()
      if (text[i] !== ':') throw LOST
      i++
      value([...at, key])
      if (found) return i
      space()
      if (text[i] === ',') i++
      else if (text[i] !== '}') throw LOST
    }
  }
  const array = (at: readonly string[]): number => {
    i++
    for (let index = 0; ; index++) {
      space()
      if (text[i] === ']') return ++i
      value([...at, String(index)])
      if (found) return i
      space()
      if (text[i] === ',') i++
      else if (text[i] !== ']') throw LOST
    }
  }
  try {
    value([])
  } catch (e) {
    if (e !== LOST) throw e
  }
  return path.length ? found : null
}
