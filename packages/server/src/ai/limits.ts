// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../errors'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** What a slot is taken for: a person's request, or a further round of an agent's turn (W6.3). */
export type AiUse = 'request' | 'round'

/**
 * Phase 4a-1 spec §3.3, plan ruling 14: per-user windows (in memory) and how many run at once.
 * W6.3 re-review (minor 3): an agent's further rounds have a minute of their own (`agentPerMinute`),
 * so a turn of several rounds does not use up the person's requests; every use counts for the day.
 */
export class AiLimits {
  private readonly recent = new Map<string, Array<{ t: number; use: AiUse }>>()
  private readonly active = new Map<string, number>()
  private total = 0

  constructor(
    private readonly now: () => number,
    private readonly opts: {
      perMinute: number
      perDay: number
      perUser: number
      server: number
      /** An agent's rounds a minute, per person (default 30). */
      agentPerMinute?: number
    },
  ) {}

  /** Takes a slot; the returned function gives it back (once). */
  enter(user: string, use: AiUse = 'request'): () => void {
    const t = this.now()
    const times = (this.recent.get(user) ?? []).filter((x) => x.t > t - DAY)
    const minute = times.filter((x) => x.use === use && x.t > t - MINUTE)
    const perMinute = use === 'round' ? (this.opts.agentPerMinute ?? 30) : this.opts.perMinute
    if (minute.length >= perMinute) throw Errors.rateLimited(minute[0]!.t + MINUTE - t)
    if (times.length >= this.opts.perDay) throw Errors.rateLimited(times[0]!.t + DAY - t)
    const mine = this.active.get(user) ?? 0
    if (mine >= this.opts.perUser || this.total >= this.opts.server)
      throw Errors.conflict('The assistant is busy; try again shortly', { reason: 'busy' })
    times.push({ t, use })
    this.recent.set(user, times)
    this.active.set(user, mine + 1)
    this.total++
    let left = false
    return () => {
      if (left) return
      left = true
      this.total--
      const n = (this.active.get(user) ?? 1) - 1
      if (n <= 0) this.active.delete(user)
      else this.active.set(user, n)
    }
  }

  /** Requests running now: one user's, or the server's. */
  running(user?: string): number {
    return user === undefined ? this.total : (this.active.get(user) ?? 0)
  }
}
