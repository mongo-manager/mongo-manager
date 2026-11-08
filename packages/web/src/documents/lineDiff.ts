// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER

/**
 * User request 2026-11-07: the review before a save shows each field as a diff of its lines, side by
 * side, as a code review does. Lines are numbered from 1 on each side.
 */
export type DiffRow =
  | { kind: 'same'; left: number; right: number; text: string }
  | { kind: 'del'; left: number; text: string }
  | { kind: 'add'; right: number; text: string }
  /** A line changed in place: the old text beside the new. */
  | { kind: 'mod'; left: number; right: number; before: string; after: string }

/** Unchanged lines out of sight, shown on request. */
export interface Fold {
  kind: 'fold'
  rows: DiffRow[]
}

/** Above this many cells, the changed middle is not compared line by line (all old, then all new). */
const MAX_CELLS = 2_000_000

type Op = { kind: 'same'; a: number; b: number } | { kind: 'del'; a: number } | { kind: 'add'; b: number }

/** The longest common subsequence of a[from..] and b[from..], as edit operations. */
function middleOps(a: string[], b: string[], aFrom: number, aTo: number, bFrom: number, bTo: number): Op[] {
  const n = aTo - aFrom
  const m = bTo - bFrom
  const ops: Op[] = []
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    for (let i = aFrom; i < aTo; i++) ops.push({ kind: 'del', a: i })
    for (let j = bFrom; j < bTo; j++) ops.push({ kind: 'add', b: j })
    return ops
  }
  // lengths[i][j]: the common subsequence of a[i..] and b[j..], in one flat table.
  const width = m + 1
  const lengths = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lengths[i * width + j] =
        a[aFrom + i] === b[bFrom + j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[aFrom + i] === b[bFrom + j]) {
      ops.push({ kind: 'same', a: aFrom + i, b: bFrom + j })
      i++
      j++
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
      ops.push({ kind: 'del', a: aFrom + i++ })
    else ops.push({ kind: 'add', b: bFrom + j++ })
  }
  while (i < n) ops.push({ kind: 'del', a: aFrom + i++ })
  while (j < m) ops.push({ kind: 'add', b: bFrom + j++ })
  return ops
}

/** The rows of a side-by-side diff: a run of removed and added lines is paired line by line. */
export function diffLines(before: string[], after: string[]): DiffRow[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++
  const ops: Op[] = []
  for (let i = 0; i < start; i++) ops.push({ kind: 'same', a: i, b: i })
  ops.push(...middleOps(before, after, start, before.length - end, start, after.length - end))
  for (let k = end; k > 0; k--) ops.push({ kind: 'same', a: before.length - k, b: after.length - k })

  const rows: DiffRow[] = []
  let k = 0
  while (k < ops.length) {
    const op = ops[k]!
    if (op.kind === 'same') {
      rows.push({ kind: 'same', left: op.a + 1, right: op.b + 1, text: before[op.a]! })
      k++
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    for (; k < ops.length && ops[k]!.kind !== 'same'; k++) {
      const o = ops[k]!
      if (o.kind === 'del') dels.push(o.a)
      else if (o.kind === 'add') adds.push(o.b)
    }
    const paired = Math.min(dels.length, adds.length)
    for (let p = 0; p < paired; p++)
      rows.push({
        kind: 'mod',
        left: dels[p]! + 1,
        right: adds[p]! + 1,
        before: before[dels[p]!]!,
        after: after[adds[p]!]!,
      })
    for (const a of dels.slice(paired)) rows.push({ kind: 'del', left: a + 1, text: before[a]! })
    for (const b of adds.slice(paired)) rows.push({ kind: 'add', right: b + 1, text: after[b]! })
  }
  return rows
}

/** Unchanged lines more than `context` away from a change are folded (two at least: one is shown). */
export function foldUnchanged(rows: DiffRow[], context = 3): Array<DiffRow | Fold> {
  const parts: Array<DiffRow | Fold> = []
  let k = 0
  while (k < rows.length) {
    if (rows[k]!.kind !== 'same') {
      parts.push(rows[k]!)
      k++
      continue
    }
    let end = k
    while (end < rows.length && rows[end]!.kind === 'same') end++
    const keepBefore = k === 0 ? 0 : context
    const keepAfter = end === rows.length ? 0 : context
    const hidden = end - k - keepBefore - keepAfter
    if (hidden < 2) parts.push(...rows.slice(k, end))
    else {
      parts.push(...rows.slice(k, k + keepBefore))
      parts.push({ kind: 'fold', rows: rows.slice(k + keepBefore, end - keepAfter) })
      parts.push(...rows.slice(end - keepAfter, end))
    }
    k = end
  }
  return parts
}

/** Text before, the part changed, and text after. */
export type Spans = [lead: string, changed: string, tail: string]

/**
 * The part of a line changed in place, on each side; null when the two share too little for a mark
 * to say more than the line's colour does.
 */
export function inlineChange(before: string, after: string): { before: Spans; after: Spans } | null {
  let same = 0
  while (same < before.length && same < after.length && before[same] === after[same]) same++
  let sameEnd = 0
  while (
    sameEnd < before.length - same &&
    sameEnd < after.length - same &&
    before[before.length - 1 - sameEnd] === after[after.length - 1 - sameEnd]
  )
    sameEnd++
  if (same + sameEnd < 3) return null
  const split = (s: string): Spans => [
    s.slice(0, same),
    s.slice(same, s.length - sameEnd),
    s.slice(s.length - sameEnd),
  ]
  return { before: split(before), after: split(after) }
}
