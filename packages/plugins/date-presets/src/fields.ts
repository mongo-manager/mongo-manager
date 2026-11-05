// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * The fields of a sample a date filter can be put on: those holding dates, and _id when it holds
 * ObjectIds (an ObjectId begins with the second it was made), the most found first.
 */
export interface DateField {
  path: string
  kind: 'date' | 'objectId'
  count: number
}

type Doc = Record<string, unknown>
const isDoc = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v)
const MAX_DEPTH = 20

export function dateFields(docs: readonly unknown[]): DateField[] {
  const found = new Map<string, number>()
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (Array.isArray(v)) {
      for (const item of v) walk(item, path, depth + 1)
      return
    }
    if (!isDoc(v)) return
    if ('$date' in v) {
      found.set(path, (found.get(path) ?? 0) + 1)
      return
    }
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1)
  }
  let ids = 0
  for (const doc of docs) {
    walk(doc, '', 0)
    if (isDoc(doc) && isDoc(doc._id) && typeof doc._id.$oid === 'string') ids++
  }
  const fields: DateField[] = [...found.entries()].map(([path, count]) => ({ path, kind: 'date', count }))
  if (ids) fields.push({ path: '_id', kind: 'objectId', count: ids })
  return fields.sort(
    (a, b) =>
      b.count - a.count || (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'date' ? -1 : 1),
  )
}
