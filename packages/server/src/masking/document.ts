// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { NsMasker } from './match'

export const MASK = '***'

export const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A fresh object without a prototype: a `__proto__` key is an ordinary property. */
export function bare(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

/** The first keys of canonical EJSON values ({ $oid }, { $date }, { $numberInt }, …). */
const EJSON_KEYS = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$regularExpression',
  '$regex',
  '$timestamp',
  '$symbol',
  '$code',
  '$minKey',
  '$maxKey',
  '$dbPointer',
  '$undefined',
])

/** A canonical EJSON value: a literal, not a sub-document or an operator. */
export function isWrapper(v: unknown): boolean {
  if (!isPlain(v)) return false
  const keys = Object.keys(v)
  return keys.length > 0 && EJSON_KEYS.has(keys[0]!) && keys.every((k) => k.startsWith('$'))
}

/**
 * Every value replaced by `***`, keys and field references ("$name", "$$var") kept: what is left of
 * a part that cannot be tied to fields that are not personal (in doubt, mask). `null` stays.
 */
export function maskLiterals(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (typeof v === 'string') return v.startsWith('$') ? v : MASK
  if (typeof v !== 'object') return MASK
  if (Array.isArray(v)) return v.map(maskLiterals)
  if (isWrapper(v)) return MASK
  const out = bare()
  for (const key of Object.keys(v)) out[key] = maskLiterals((v as Record<string, unknown>)[key])
  return out
}

/**
 * Phase 3b spec §2.3: a document (canonical EJSON) with every personal value replaced whole by
 * `***`. Arrays are transparent (elements keep the array's path). Keys are kept. A value at a
 * personal `prefix` is masked whole (final review C4: a caller may hand in a personal path).
 */
export function maskDocument(value: unknown, ns: NsMasker, prefix: string[] = []): unknown {
  if (!ns.any) return value
  if (prefix.length > 0 && ns.matches(prefix)) return MASK
  if (Array.isArray(value)) return value.map((v) => maskDocument(v, ns, prefix))
  if (!isPlain(value) || isWrapper(value)) return value
  const out = bare()
  for (const key of Object.keys(value)) {
    const path = [...prefix, key]
    const v = value[key]
    if (ns.matches(path)) out[key] = MASK
    else if (ns.under(path)) out[key] = maskDocument(v, ns, path)
    else out[key] = v
  }
  return out
}
