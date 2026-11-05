// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
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
  | { key: string; more: true; path: readonly string[]; depth: number; remaining: number }

export interface TreeState {
  open: ReadonlySet<string>
  /** How many entries of a container are listed, by its key; TREE_PAGE when not set. */
  shown: ReadonlyMap<string, number>
}

/** The first level listed, every container closed (as the inspector opened a document). */
export const closedState = (): TreeState => ({ open: new Set(), shown: new Map() })

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
    const limit = parent.length ? (state.shown.get(pathKey(parent)) ?? TREE_PAGE) : entries.length
    for (const [at, [name, value]] of entries.slice(0, limit).entries()) {
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
    if (entries.length > limit)
      lines.push({
        key: `${pathKey(parent)}:more`,
        more: true,
        path: parent,
        depth,
        remaining: Math.min(TREE_PAGE, entries.length - limit),
      })
  }
  list(Object.entries(doc), [], 0, 'object')
  return lines
}

/** `state` with the way to each of `paths` open, and enough of each container listed to show it. */
export function revealPaths(
  doc: Record<string, unknown>,
  state: TreeState,
  paths: ReadonlyArray<readonly string[]>,
): TreeState {
  const open = new Set(state.open)
  const shown = new Map(state.shown)
  for (const path of paths) {
    let value: unknown = doc
    for (let i = 0; i < path.length; i++) {
      const name = path[i]!
      if (i > 0) {
        const parent = pathKey(path.slice(0, i))
        open.add(parent)
        const index = Object.keys(value as object).indexOf(name)
        const needed = Math.ceil((index + 1) / TREE_PAGE) * TREE_PAGE
        if (index >= 0 && needed > (shown.get(parent) ?? TREE_PAGE)) shown.set(parent, needed)
      }
      value = (value as Record<string, unknown> | undefined)?.[name]
      if (value === undefined) break
    }
  }
  return { open, shown }
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
