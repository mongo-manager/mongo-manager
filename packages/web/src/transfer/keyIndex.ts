// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { IndexInfo } from '@/api/documents'

/**
 * W4.1 (phase 3d-1 spec §6.1): whether an upsert or merge finds each record's document through an
 * index — some index must start with one of the key fields (its equality lookup then scans the index,
 * not the collection). A partial or hidden index, and text, geo or wildcard keys, are not counted:
 * the planner cannot use them for every key value.
 */
export function keysCovered(keys: string[], indexes: IndexInfo[]): boolean {
  if (keys.length === 1 && keys[0] === '_id') return true
  return indexes.some((index) => {
    if (index.options.partialFilterExpression !== undefined || index.options.hidden === true) return false
    const first = Object.entries(index.key)[0]
    if (!first) return false
    const [field, kind] = first
    if (field.includes('$**')) return false
    const usable = kind === 1 || kind === -1 || kind === 'hashed'
    return usable && keys.includes(field)
  })
}
