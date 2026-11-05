// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { COLUMN_WIDTH } from './rows'

/**
 * W1 review (important 3): the widths a user gave a collection's columns, kept per collection
 * (connection, database, collection) in this browser, per user. Field names and numbers only — never a
 * value — and bounded: the collections used last, so many columns each. Storage that is blocked or
 * holds something else is read as nothing kept.
 */
export interface Namespace {
  connectionId: string
  db: string
  coll: string
}
interface Entry {
  ns: [string, string, string]
  widths: Record<string, number>
}

export const MAX_COLLECTIONS = 100
export const MAX_COLUMNS = 100
const MAX_NAME = 512

const keyOf = (owner: string) => `mm:column-widths:${owner}`
const same = (e: Entry, ns: Namespace) =>
  e.ns[0] === ns.connectionId && e.ns[1] === ns.db && e.ns[2] === ns.coll

function cleanWidths(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [name, width] of Object.entries(value).slice(0, MAX_COLUMNS))
    if (
      name.length <= MAX_NAME &&
      typeof width === 'number' &&
      Number.isFinite(width) &&
      width >= COLUMN_WIDTH.min &&
      width <= COLUMN_WIDTH.max
    )
      out[name] = Math.round(width)
  return out
}

function read(owner: string): Entry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyOf(owner)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e): e is Entry =>
          !!e &&
          typeof e === 'object' &&
          Array.isArray((e as Entry).ns) &&
          (e as Entry).ns.length === 3 &&
          (e as Entry).ns.every((p) => typeof p === 'string'),
      )
      .map((e) => ({ ns: e.ns, widths: cleanWidths(e.widths) }))
      .slice(-MAX_COLLECTIONS)
  } catch {
    return []
  }
}

/** The widths kept for a collection (none without a user). */
export function loadWidths(owner: string | null, ns: Namespace): Record<string, number> {
  if (!owner) return {}
  return { ...(read(owner).find((e) => same(e, ns))?.widths ?? {}) }
}

/** Keeps a collection's widths, the newest last; a collection without widths is forgotten. */
export function saveWidths(owner: string | null, ns: Namespace, widths: Record<string, number>): void {
  if (!owner) return
  const kept = read(owner).filter((e) => !same(e, ns))
  const clean = cleanWidths(widths)
  const next = Object.keys(clean).length
    ? [...kept, { ns: [ns.connectionId, ns.db, ns.coll] as Entry['ns'], widths: clean }]
    : kept
  try {
    localStorage.setItem(keyOf(owner), JSON.stringify(next.slice(-MAX_COLLECTIONS)))
  } catch {
    // storage blocked or full: the widths stay with the tab only
  }
}
