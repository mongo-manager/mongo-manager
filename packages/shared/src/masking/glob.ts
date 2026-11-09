// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Glob over path segments: a name matches itself, `*` one segment, `**` zero or more. With
 * `partial`, it answers whether some extension of the path could match (the path is a prefix of a
 * match). Each (pattern, path) position is solved once, so many `**` stay linear in
 * pattern × path, never exponential (a rule with thirty `**` must not stall the server).
 */
export function globMatch(
  pattern: readonly string[],
  path: readonly string[],
  partial: boolean,
  /** The pattern may match a prefix of the path (a field above it): one pass, not one per prefix. */
  prefix = false,
): boolean {
  const width = path.length + 1
  const memo = new Int8Array((pattern.length + 1) * width) // 0 unknown, 1 true, 2 false
  const solve = (pi: number, si: number): boolean => {
    const slot = pi * width + si
    if (memo[slot] !== 0) return memo[slot] === 1
    let result: boolean
    if (partial && si === path.length) result = true
    else if (pi === pattern.length) result = si === path.length || (prefix && si > 0)
    else if (pattern[pi] === '**') result = solve(pi + 1, si) || (si < path.length && solve(pi, si + 1))
    else
      result = si < path.length && (pattern[pi] === '*' || pattern[pi] === path[si]) && solve(pi + 1, si + 1)
    memo[slot] = result ? 1 : 2
    return result
  }
  return solve(0, 0)
}

const POSITIONAL = /^(\d+|\$|\$\[\w*\])$/

/** An array position as commands write it: `0`, `$`, `$[]`, `$[e]`. */
export const isPositional = (segment: string): boolean => POSITIONAL.test(segment)

/**
 * Array positions in a path as commands write them: `items.0.cardNo`, `items.$.cardNo`,
 * `items.$[].cardNo`, `items.$[e].cardNo`. Rules name the field (arrays are transparent), so a
 * path is tried both as written and without these segments (final review 3b C4).
 */
export function pathVariants(path: readonly string[]): Array<readonly string[]> {
  const bare = path.filter((s) => !isPositional(s))
  return bare.length === path.length ? [path] : [path, bare]
}

/**
 * The deepest path matched against rules. MongoDB nests documents 100 levels deep at most; a path
 * deeper than this names no field and is taken as personal (in doubt, mask), never matched at a
 * cost of its length (security review 2026-10-13, I1).
 */
export const MAX_PATH_SEGMENTS = 256

/**
 * Some pattern matches the path, or a path above it (phase 3b §2.1 rules; phase 3c for the web
 * too): a value inside a personal sub-document or array is personal as well (security review
 * 2026-10-13, C1: `address.city` under a rule naming `address` was read by projections, pipelines,
 * filters, sorts, bulk updates and change events). One pass over the path (review I1).
 */
export const matchesAny = (patterns: readonly (readonly string[])[], path: readonly string[]): boolean =>
  path.length > MAX_PATH_SEGMENTS ||
  pathVariants(path).some((v) => patterns.some((p) => globMatch(p, v, false, true)))

/** Some pattern could match the path or a path below it. */
export const underAny = (patterns: readonly (readonly string[])[], path: readonly string[]): boolean =>
  path.length > MAX_PATH_SEGMENTS ||
  pathVariants(path).some((v) => patterns.some((p) => globMatch(p, v, true)))

/**
 * Review M3: a rule pattern covers another when it matches every path the other names (or a field
 * above them). A literal covers only the same literal; `*` one segment that is not `**`; `**` any.
 * Conservative: a cover it cannot show is reported missing.
 */
export function globCovers(target: readonly string[], source: readonly string[]): boolean {
  const width = source.length + 1
  const memo = new Int8Array((target.length + 1) * width)
  const solve = (ti: number, si: number): boolean => {
    const slot = ti * width + si
    if (memo[slot] !== 0) return memo[slot] === 1
    let result: boolean
    if (ti === target.length) result = si > 0
    else if (target[ti] === '**') result = solve(ti + 1, si) || (si < source.length && solve(ti, si + 1))
    else if (si === source.length || source[si] === '**') result = false
    else if (target[ti] === '*') result = solve(ti + 1, si + 1)
    else result = target[ti] === source[si] && solve(ti + 1, si + 1)
    memo[slot] = result ? 1 : 2
    return result
  }
  return source.length <= MAX_PATH_SEGMENTS && solve(0, 0)
}
