// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { isPositional } from '@mongo-manager/shared'
import type { Pattern } from './match'

const key = (p: Pattern) => JSON.stringify(p)

/** The patterns left of `p` once one segment is consumed. */
function step(p: Pattern, segment: string): Pattern[] {
  if (p.length === 0) return []
  const [head, ...rest] = p
  if (head === '**') return [p, ...step(rest, segment)]
  return head === '*' || head === segment ? [rest] : []
}

/**
 * Phase 3c §3.4: the suffixes s such that `path` + x matches `pattern` exactly when x matches some
 * s. An empty suffix means `path` itself matches.
 */
export function derive(pattern: Pattern, path: readonly string[]): Pattern[] {
  let current: Pattern[] = [pattern]
  for (const segment of path) {
    // A pattern used up before the path ends matched a field above it: everything below that field is
    // personal, so the path itself is (security review 2026-10-13, C1).
    if (current.some((p) => p.length === 0)) return [[]]
    const next = new Map<string, Pattern>()
    for (const p of current) for (const d of step(p, segment)) next.set(key(d), d)
    current = [...next.values()]
    if (current.length === 0) break
  }
  return current
}

/**
 * The patterns that follow a subtree moved from `from` to `to` ("x": "$customer"): every rule that
 * can match under `from`, re-rooted under `to`. Array positions are transparent on both sides.
 */
export function reroot(
  patterns: readonly Pattern[],
  from: readonly string[],
  to: readonly string[],
): Pattern[] {
  const source = from.filter((s) => !isPositional(s))
  const target = to.filter((s) => !isPositional(s))
  const out = new Map<string, Pattern>()
  for (const p of patterns)
    for (const d of derive(p, source)) {
      const moved = [...target, ...d]
      out.set(key(moved), moved)
    }
  return [...out.values()]
}
