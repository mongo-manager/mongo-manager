// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { langTag } from '../../kit/src/i18n'

/**
 * Plugins wave 4 (spec §2): a database's storage as the report shows it — what each collection
 * takes, what WiredTiger holds free inside its files (what compact could give back) and how much of
 * the file that is. The figures come from the app (`storage.stats`); a size hidden from the user
 * (personal data rules there) stays unknown, never guessed.
 */
export interface StorageIndex {
  name: string
  size: number | null
  freeBytes: number | null
}
export interface StorageCollection {
  name: string
  type: 'collection' | 'timeseries'
  count: number | null
  size: number | null
  storageSize: number | null
  freeBytes: number | null
  indexSize: number | null
  indexFreeBytes: number | null
  indexes: StorageIndex[]
  sizesHidden?: true
  unread?: true
}
export interface StorageReport {
  collections: StorageCollection[]
  more: boolean
}
export type CompactEstimate =
  | { available: true; estimatedBytes: number }
  | { available: false; reason: 'version' | 'mongos' | 'timeseries' }

export interface Row {
  collection: StorageCollection
  /** The collection's and its indexes' free bytes; null when either is unknown. */
  reclaimable: number | null
  /** Free bytes over the collection's file and its indexes' files, 0 to 1; null when unknown. */
  fragmentation: number | null
}

const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

export function rowOf(c: StorageCollection): Row {
  const reclaimable = known(c.freeBytes) && known(c.indexFreeBytes) ? c.freeBytes + c.indexFreeBytes : null
  const onDisk = known(c.storageSize) && known(c.indexSize) ? c.storageSize + c.indexSize : null
  return {
    collection: c,
    reclaimable,
    fragmentation: reclaimable !== null && onDisk ? Math.min(1, reclaimable / onDisk) : null,
  }
}

/** Most reclaimable first; those whose figures are unknown last, by name. */
export function rowsOf(report: StorageReport): Row[] {
  return report.collections.map(rowOf).sort((a, b) => {
    if (a.reclaimable === null || b.reclaimable === null) {
      if (a.reclaimable !== b.reclaimable) return a.reclaimable === null ? 1 : -1
      return a.collection.name < b.collection.name ? -1 : a.collection.name > b.collection.name ? 1 : 0
    }
    return b.reclaimable - a.reclaimable || (a.collection.name < b.collection.name ? -1 : 1)
  })
}

export interface Totals {
  storage: number
  data: number
  indexes: number
  reclaimable: number
  /** Collections whose sizes are not in the totals (hidden or unread). */
  unknown: number
}
/** What the collections whose sizes are known add up to. */
export function totalsOf(rows: readonly Row[]): Totals {
  const t: Totals = { storage: 0, data: 0, indexes: 0, reclaimable: 0, unknown: 0 }
  for (const { collection: c, reclaimable } of rows) {
    if (!known(c.storageSize) || !known(c.size) || !known(c.indexSize) || reclaimable === null) {
      t.unknown++
      continue
    }
    t.storage += c.storageSize
    t.data += c.size
    t.indexes += c.indexSize
    t.reclaimable += reclaimable
  }
  return t
}

/**
 * Worth compacting: at least 20% of the files free and at least 10 MB to give back — below that,
 * WiredTiger reuses the space itself and compact costs more than it gives (my call, after Atlas's
 * and MongoDB's guidance that compact pays only for a large share of free space).
 */
export const WORTH_SHARE = 0.2
export const WORTH_BYTES = 10 * 1024 * 1024
export const worthCompacting = (row: Row): boolean =>
  row.reclaimable !== null &&
  row.fragmentation !== null &&
  row.reclaimable >= WORTH_BYTES &&
  row.fragmentation >= WORTH_SHARE

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
/** Bytes in binary units (1 KB = 1024 B), in the user's language. */
export function bytesText(n: number, locale: string): string {
  let value = Math.max(0, n)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  const text = new Intl.NumberFormat(langTag(locale), {
    maximumFractionDigits: digits,
  }).format(value)
  return `${text} ${UNITS[unit]}`
}

/** A share as a percentage, in the user's language. */
export function percentText(share: number, locale: string): string {
  return new Intl.NumberFormat(langTag(locale), {
    style: 'percent',
    maximumFractionDigits: share > 0 && share < 0.1 ? 1 : 0,
  }).format(share)
}
