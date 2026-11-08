// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../errors'

/**
 * Sign-in bans (2026-10-30): a password check costs 19 MiB and a worker thread for tens of
 * milliseconds, so a flood of sign-ins from many addresses could hold every worker (files and the
 * other hashes wait on the same ones). Sign-in checks run at most `limit` at once with `queue` more
 * waiting; past that a sign-in is refused at once as busy, before anything is counted against it.
 * Review of the bans (I4): `reserved` places more are kept for accounts signing in where they did
 * lately, so a flood from elsewhere does not keep the team out. A signed-in user's own password
 * check (a confirmation) waits in turn and is never refused: its own throttle bounds it.
 */
export class PasswordWork {
  private running = 0
  private readonly waiting: Array<() => void> = []
  private refusals = 0
  private reportedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly limit = 2,
    private readonly queue = 32,
    private readonly reserved = 16,
  ) {}

  /** Refuses when no check could start or wait now (`known`: one of the reserved places may). */
  admit(known = false): void {
    if (this.running + this.waiting.length >= this.limit + this.queue + (known ? this.reserved : 0))
      throw Errors.rateLimited(2_000, 'server_busy')
  }

  /** Counts a busy refusal; how many to report now (at most once a minute), or null. */
  refused(now: number): number | null {
    this.refusals += 1
    if (now - this.reportedAt < 60_000) return null
    const n = this.refusals
    this.refusals = 0
    this.reportedAt = now
    return n
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    // A finished check hands its place to the next one waiting (the count stays with it).
    if (this.running >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.running += 1
    try {
      return await work()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.running -= 1
    }
  }
}
