// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { InjectionKey, Ref } from 'vue'
import type { BsonTypeName } from '@mongo-manager/shared/browser'
import { typeOf } from '../values'

/**
 * Document page design §6.4: the tree as one flat list of lines — which containers are open, and how
 * many entries of each are listed — so a search opens the way to its match and the keyboard walks
 * the lines in order. A long container lists its entries a page at a time, as the inspector did.
 */
export const TREE_PAGE = 100

/** A field's identity in the tree. A key may hold a dot, so the path is not joined with one. */
export const pathKey = (path: readonly string[]): string => JSON.stringify(path)

/** A path as MongoDB writes it (`payments.2.amount`), for the copy button and the query bar. */
export const dottedPath = (path: readonly string[]): string => path.join('.')

export type TreeLine =
  | {
      key: string
      path: readonly string[]
      name: string
      depth: number
      value: unknown
      type: BsonTypeName
      container: boolean
      open: boolean
      /** A container's number of entries (0 for a scalar). */
      size: number
      /** What holds it (the document itself is an object). */
      parentType: 'object' | 'array'
      /** Its place among its siblings (1-based) and their number, for aria-posinset / aria-setsize. */
      index: number
      setSize: number
    }
  | {
      key: string
      more: true
      path: readonly string[]
      depth: number
      remaining: number
      /** Between the first entries and a page further on, or after the last entry listed. */
      place: 'gap' | 'end'
    }

/** A line that is a field (or an array's item), not a "show more". */
export type FieldLine = Extract<TreeLine, { name: string }>

/** The key of the line the tree's focus is on, given to each line (it reads it itself). */
export const TREE_FOCUS: InjectionKey<Readonly<Ref<string | null>>> = Symbol('tree focus')

/** Entries [from, to) of a container, listed apart from its first ones. */
export interface TreeWindow {
  from: number
  to: number
}

export interface TreeState {
  open: ReadonlySet<string>
  /** How many entries of a container are listed from its start, by its key; TREE_PAGE when not set. */
  shown: ReadonlyMap<string, number>
  /**
   * Review 2026-11-07 (performance): a page further on, by its container's key — where a search's
   * match or a path is. Listing every entry up to it rendered 5,000 lines for a match at the end.
   */
  window?: ReadonlyMap<string, TreeWindow>
}

/** The first level listed, every container closed (as the inspector opened a document). */
export const closedState = (): TreeState => ({ open: new Set(), shown: new Map(), window: new Map() })

/** The parts of a container's entries listed: its first ones, and a page further on apart from them. */
function listedRanges(state: TreeState, key: string, size: number): Array<[number, number]> {
  const first = Math.min(size, state.shown.get(key) ?? TREE_PAGE)
  const win = state.window?.get(key)
  if (!win || win.to <= first) return [[0, first]]
  if (win.from <= first) return [[0, Math.min(size, win.to)]]
  return [
    [0, first],
    [win.from, Math.min(size, win.to)],
  ]
}

const entriesOf = (value: unknown): Array<[string, unknown]> | null => {
  const type = typeOf(value)
  if (type === 'array') return (value as unknown[]).map((v, i): [string, unknown] => [String(i), v])
  if (type === 'object') return Object.entries(value as Record<string, unknown>)
  return null
}

/** The lines shown for `doc` in `state`, in document order. */
export function flattenTree(doc: Record<string, unknown>, state: TreeState): TreeLine[] {
  const lines: TreeLine[] = []
  const list = (
    entries: Array<[string, unknown]>,
    parent: readonly string[],
    depth: number,
    parentType: 'object' | 'array',
  ): void => {
    const parentKey = pathKey(parent)
    const ranges: Array<[number, number]> = parent.length
      ? listedRanges(state, parentKey, entries.length)
      : [[0, entries.length]]
    ranges.forEach(([from, to], r) => {
      if (r > 0)
        lines.push({
          key: `${parentKey}:gap`,
          more: true,
          path: parent,
          depth,
          remaining: Math.min(TREE_PAGE, from - ranges[r - 1]![1]),
          place: 'gap',
        })
      for (let at = from; at < to; at++) {
        const [name, value] = entries[at]!
        const path = [...parent, name]
        const key = pathKey(path)
        const children = entriesOf(value)
        const open = !!children && state.open.has(key)
        lines.push({
          key,
          path,
          name,
          depth,
          value,
          type: typeOf(value),
          container: !!children,
          open,
          size: children?.length ?? 0,
          parentType,
          index: at + 1,
          setSize: entries.length,
        })
        if (open) list(children!, path, depth + 1, typeOf(value) === 'array' ? 'array' : 'object')
      }
    })
    const end = ranges.at(-1)![1]
    if (entries.length > end)
      lines.push({
        key: `${parentKey}:more`,
        more: true,
        path: parent,
        depth,
        remaining: Math.min(TREE_PAGE, entries.length - end),
        place: 'end',
      })
  }
  list(Object.entries(doc), [], 0, 'object')
  return lines
}

/**
 * `state` with the way to each of `paths` open, and each of them listed: an entry past the first
 * ones by the page it is on (the page listed before it in that container is let go), never by every
 * entry up to it. A state that already shows them all is returned as it is.
 */
export function revealPaths(
  doc: Record<string, unknown>,
  state: TreeState,
  paths: ReadonlyArray<readonly string[]>,
): TreeState {
  const open = new Set(state.open)
  const window = new Map(state.window)
  let changed = false
  for (const path of paths) {
    let value: unknown = doc
    for (let i = 0; i < path.length; i++) {
      const name = path[i]!
      if (i > 0) {
        const parent = pathKey(path.slice(0, i))
        if (!open.has(parent)) {
          open.add(parent)
          changed = true
        }
        const keys = Array.isArray(value) ? null : Object.keys(value as object)
        const index = keys ? keys.indexOf(name) : Number(name)
        const size = keys ? keys.length : (value as unknown[]).length
        const listed = listedRanges({ ...state, window }, parent, size)
        if (index >= 0 && index < size && !listed.some(([from, to]) => index >= from && index < to)) {
          const from = Math.floor(index / TREE_PAGE) * TREE_PAGE
          window.set(parent, { from, to: from + TREE_PAGE })
          changed = true
        }
      }
      value = (value as Record<string, unknown> | undefined)?.[name]
      if (value === undefined || value === null || typeof value !== 'object') break
    }
  }
  return changed ? { open, shown: state.shown, window } : state
}

/** `state` with the next page of a container listed: at its gap, or after its last entry. */
export function showMore(state: TreeState, path: readonly string[], place: 'gap' | 'end'): TreeState {
  const key = pathKey(path)
  const first = state.shown.get(key) ?? TREE_PAGE
  const win = state.window?.get(key)
  if (place === 'end' && win && win.to > first) {
    const window = new Map(state.window)
    window.set(key, { ...win, to: win.to + TREE_PAGE })
    return { ...state, window }
  }
  const shown = new Map(state.shown)
  shown.set(key, first + TREE_PAGE)
  return { ...state, shown }
}

/** Every container open, level by level, until about `maxNodes` lines would be listed. */
export function openAll(doc: Record<string, unknown>, maxNodes = 5_000): ReadonlySet<string> {
  const open = new Set<string>()
  let listed = Object.keys(doc).length
  let level: Array<[readonly string[], unknown]> = Object.entries(doc).map(([k, v]) => [[k], v])
  while (level.length) {
    const next: Array<[readonly string[], unknown]> = []
    for (const [path, value] of level) {
      const children = entriesOf(value)
      if (!children) continue
      if (listed + Math.min(children.length, TREE_PAGE) > maxNodes) return open
      open.add(pathKey(path))
      listed += Math.min(children.length, TREE_PAGE)
      for (const [name, child] of children.slice(0, TREE_PAGE)) next.push([[...path, name], child])
    }
    level = next
  }
  return open
}
