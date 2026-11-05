// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { formatShell, parseShellExpression } from '@mongo-manager/shared/browser'
import { byteSize } from '@/ds/code/size'

/**
 * User report 2026-11-05: the text of the document's edit view. Its keys are quoted, as JSON writes
 * them; a string of LONG_FROM characters or more (an image as base64) is written as a short stand-in
 * — its size and a hash of it — and read back as the value it stands for, so the text stays short
 * and the value is saved as it was. A stand-in that stands for nothing known is refused: it is never
 * saved as a string in the value's place.
 */
export const LONG_FROM = 10_000

const STAND_IN = /^⟨\d+(?:\.\d)? [KMG]?B · [0-9a-f]{16}⟩$/
const FNV_PRIME = 16777619

function hash(value: string): string {
  let a = 2166136261
  let b = 0x811c9dc5 ^ 0x5bd1e995
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    a = Math.imul(a ^ code, FNV_PRIME)
    b = Math.imul(b ^ code, FNV_PRIME) ^ (b >>> 13)
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  return hex(a) + hex(b)
}

/** What the text shows for a long string. */
export const standIn = (value: string): string => `⟨${byteSize(value)} · ${hash(value)}⟩`

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))

/** Each string of `value` (in its plain objects and arrays) given to `visit`, as `map` returns it. */
function mapStrings(value: unknown, map: (s: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map))
  if (isPlain(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, map)
    return out
  }
  return value
}

/**
 * The long strings of the sources by their stand-ins. A string of theirs that only looks like a
 * stand-in stands for itself; a stand-in two different strings share is left out (both stay whole).
 */
export function longValues(...sources: unknown[]): ReadonlyMap<string, string> {
  const found = new Map<string, string | null>()
  const note = (key: string, value: string) => {
    const known = found.get(key)
    if (known === undefined) found.set(key, value)
    else if (known !== value) found.set(key, null)
  }
  for (const source of sources)
    mapStrings(source, (s) => {
      if (s.length >= LONG_FROM) note(standIn(s), s)
      else if (STAND_IN.test(s)) note(s, s)
      return s
    })
  const longs = new Map<string, string>()
  for (const [key, value] of found) if (value !== null) longs.set(key, value)
  return longs
}

/** The value as the edit view writes it: keys quoted, each long string the map knows as its stand-in. */
export function writeEditText(value: unknown, longs: ReadonlyMap<string, string>): string {
  const folded = mapStrings(value, (s) => {
    if (s.length < LONG_FROM) return s
    const key = standIn(s)
    return longs.get(key) === s ? key : s
  })
  return formatShell(folded, { indent: 2, quoteKeys: true })
}

/** A stand-in in the text that stands for no value known here. */
export class UnknownStandIn extends Error {
  constructor(readonly standIn: string) {
    super(`unknown stand-in ${standIn}`)
  }
}

/** The text read back: each stand-in as the value it stands for (throws UnknownStandIn). */
export function readEditText(text: string, longs: ReadonlyMap<string, string>): unknown {
  return mapStrings(parseShellExpression(text), (s) => {
    if (!STAND_IN.test(s)) return s
    const value = longs.get(s)
    if (value === undefined) throw new UnknownStandIn(s)
    return value
  })
}
