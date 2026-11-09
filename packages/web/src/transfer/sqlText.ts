// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { isSpoofingChar } from '@mongo-manager/shared/browser'
import { formatCount } from '@/format'

/**
 * Review M18: a dump's names and values as shown — a character that could disguise them (bidi
 * overrides, zero-width marks…) written as its \u code, so "users\u202etxt" is seen for what it is.
 */
export function visible(text: string): string {
  let out = ''
  for (const c of text) {
    const code = c.codePointAt(0)!
    out += isSpoofingChar(code) ? `\\u${code.toString(16).padStart(4, '0')}` : c
  }
  return out
}

/** A name without those characters: what a collection is called after it. */
export const stripped = (text: string): string =>
  [...text].filter((c) => !isSpoofingChar(c.codePointAt(0)!)).join('')

/** "12 SET, 3 DROP TABLE, 5 CREATE INDEX": the statements a dump holds that are read but never run. */
export function skippedList(skipped: Record<string, number>, locale: string): string {
  return Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${formatCount(n, locale)} ${kind}`)
    .join(', ')
}

const WRAPPERS = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal', '$oid', '$symbol'] as const

/**
 * A sample value (canonical EJSON) as a cell shows it: numbers, ids and dates plainly, text as it is,
 * anything else as JSON.
 */
export function sampleText(value: unknown): string {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return String(value)
  const v = value as Record<string, unknown>
  const keys = Object.keys(v)
  if (keys.length === 1) {
    const key = keys[0]!
    if ((WRAPPERS as readonly string[]).includes(key) && typeof v[key] === 'string') return v[key]
    if (key === '$date') {
      const d = v.$date as { $numberLong?: string } | string
      const ms = typeof d === 'string' ? Date.parse(d) : Number(d?.$numberLong)
      if (Number.isFinite(ms)) return new Date(ms).toISOString()
    }
  }
  return JSON.stringify(value)
}
