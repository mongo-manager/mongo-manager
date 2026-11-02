import type { StorageReport } from '@mongo-manager/shared/browser'

/**
 * Plugins wave 4 final review: what every plugin frame shares about storage — the collections being
 * compacted (I5: one compact of a collection at a time, from any frame), by [connection, db, coll],
 * and a database's storage report, read at most twice a minute (Minor 8: up to 500 $collStats a read).
 */
export const COMPACTING = new Set<string>()
export const STORAGE_READS = new Map<string, { at: number; report: Promise<StorageReport> }>()
export const STORAGE_KEPT_MS = 30_000
