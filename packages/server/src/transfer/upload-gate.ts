// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../errors'
import { MAX_CONCURRENT_UPLOADS, UPLOADS_PER_MINUTE } from './limits'

/** Spec §7 T2: uploads per owner, per minute and at once. */
export class UploadGate {
  private readonly active = new Map<string, number>()
  private readonly recent = new Map<string, number[]>()

  private readonly perMinute: number
  private readonly concurrent: number
  private readonly windowMs: number

  /**
   * Phase 3d-3a: resumable backup uploads send many parts, so their gate has its own limits.
   * Phase 3d-3c (plan ruling 23): `windowMs` widens the window `perMinute` counts in (key creation: an hour).
   */
  constructor(
    private readonly now: () => number,
    limits: { perMinute?: number; concurrent?: number; windowMs?: number } = {},
  ) {
    this.perMinute = limits.perMinute ?? UPLOADS_PER_MINUTE
    this.concurrent = limits.concurrent ?? MAX_CONCURRENT_UPLOADS
    this.windowMs = limits.windowMs ?? 60_000
  }

  /** Takes a slot; the returned function gives it back (once). */
  enter(owner: string): () => void {
    const t = this.now()
    const times = (this.recent.get(owner) ?? []).filter((x) => x > t - this.windowMs)
    if (times.length >= this.perMinute) throw Errors.rateLimited(times[0]! + this.windowMs - t)
    const running = this.active.get(owner) ?? 0
    if (running >= this.concurrent)
      throw Errors.conflict(`${this.concurrent} uploads are already running`, {
        reason: 'upload_busy',
      })
    times.push(t)
    this.recent.set(owner, times)
    this.active.set(owner, running + 1)
    let left = false
    return () => {
      if (left) return
      left = true
      const n = (this.active.get(owner) ?? 1) - 1
      if (n <= 0) this.active.delete(owner)
      else this.active.set(owner, n)
    }
  }
}

/** Final review C3: one preview per owner at a time; each holds a bounded sample of the file. */
export class PreviewGate {
  private readonly active = new Set<string>()

  /** Takes the owner's slot; the returned function gives it back (once). */
  enter(owner: string): () => void {
    if (this.active.has(owner))
      throw Errors.conflict('A preview of your files is already being read', { reason: 'preview_busy' })
    this.active.add(owner)
    let left = false
    return () => {
      if (left) return
      left = true
      this.active.delete(owner)
    }
  }
}
