// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import { toWire, type PreviewStageResult, type Sample } from '@mongo-manager/shared'

/**
 * Phase 2a spec §4.6: preview results per pipeline prefix, for 60 s. A Map keeps insertion order,
 * so re-inserting on read makes its first key the least recently used. Bounded in entries and in
 * bytes (final review 2a, I4): a result above `maxEntryBytes` is not kept at all.
 */
export class PreviewCache {
  private readonly entries = new Map<string, { value: PreviewStageResult; expires: number; bytes: number }>()
  private readonly epochs = new Map<string, number>()
  private bytes = 0
  private readonly now: () => number
  private readonly maxBytes: number
  private readonly maxEntryBytes: number

  constructor(
    private readonly opts: {
      ttlMs: number
      max: number
      now?: () => number
      maxBytes?: number
      maxEntryBytes?: number
    },
  ) {
    this.now = opts.now ?? Date.now
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024
    this.maxEntryBytes = opts.maxEntryBytes ?? 4 * 1024 * 1024
  }

  private drop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.bytes -= entry.bytes
    this.entries.delete(key)
  }

  get(key: string): PreviewStageResult | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.drop(key)
    if (entry.expires <= this.now()) return undefined
    this.entries.set(key, entry)
    this.bytes += entry.bytes
    return entry.value
  }

  set(key: string, value: PreviewStageResult, bytes = 0): void {
    this.drop(key)
    if (bytes > this.maxEntryBytes) return
    this.entries.set(key, { value, expires: this.now() + this.opts.ttlMs, bytes })
    this.bytes += bytes
    while (this.entries.size > this.opts.max || this.bytes > this.maxBytes)
      this.drop(this.entries.keys().next().value!)
  }

  /** The current generation of a scope (a connection, or a collection) for cache keys. */
  epoch(scope: string): number {
    return this.epochs.get(scope) ?? 0
  }

  /**
   * Makes every cached preview of a scope stale (final review 2a, Minor 9): the builder wrote into
   * that collection, or the connection was edited.
   */
  bump(scope: string): void {
    this.epochs.set(scope, this.epoch(scope) + 1)
  }
}

/** The cache scope of a connection, and of one of its collections. */
export const connectionScope = (connectionId: string) => `c:${connectionId}`
export const collectionScope = (connectionId: string, db: string, coll: string) =>
  `n:${JSON.stringify([connectionId, db, coll])}`

/** The cache key of one prefix: who asks, where, on which sample, and the stages up to it. */
export function previewKey(parts: {
  userId: string | null
  connectionId: string
  db: string
  coll: string
  sample: Sample
  perStage: number
  stages: readonly unknown[]
  /** The epochs of the connection and the collection. */
  epoch?: string
  /** Masked (with the rules' version) or full: phase 3c §4.8. */
  view: string
}): string {
  return createHash('sha256')
    .update(
      toWire({
        u: parts.userId ?? '',
        c: parts.connectionId,
        d: parts.db,
        n: parts.coll,
        s: parts.sample,
        p: parts.perStage,
        e: parts.epoch ?? '',
        v: parts.view,
        x: [...parts.stages],
      }),
    )
    .digest('hex')
}
