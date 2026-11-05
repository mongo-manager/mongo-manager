// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/** Phase 3d-3b spec §3: at most `limit` transfers per destination across the server; others wait. */
export class DestinationSlots {
  private readonly active = new Map<string, number>()
  private readonly waiting = new Map<string, Array<() => void>>()

  constructor(private readonly limit: number) {}

  inUse(id: string): number {
    return this.active.get(id) ?? 0
  }

  async acquire(id: string, signal: AbortSignal, onWait?: () => void): Promise<() => void> {
    // Phase 3d-3b final review: a cancelled request never queues.
    if (signal.aborted) throw signal.reason ?? new Error('Cancelled')
    if (this.inUse(id) >= this.limit) {
      onWait?.()
      // A released slot is handed over with its count (see release): nothing to add here, and no
      // other caller can take it between the release and the moment this one resumes.
      await new Promise<void>((resolve, reject) => {
        const queue = this.waiting.get(id) ?? []
        const wake = () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          this.waiting.set(
            id,
            (this.waiting.get(id) ?? []).filter((w) => w !== wake),
          )
          reject(signal.reason ?? new Error('Cancelled'))
        }
        queue.push(wake)
        this.waiting.set(id, queue)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    } else this.active.set(id, this.inUse(id) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.get(id)?.shift()
      if (next) next()
      else this.active.set(id, this.inUse(id) - 1)
    }
  }
}
