// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { AI_AGENT_LIMITS, type AiAgentStepBackup } from '@mongo-manager/shared'
import type { AgentAuth } from './calls'

/** How a proposed change ended, as the turn reports it to the model. */
export type ChangeEnd =
  | { state: 'done'; summary: Record<string, number | string | boolean>; result: Record<string, unknown> }
  | { state: 'declined' | 'expired' | 'cancelled' }
  | { state: 'error'; reason: string }

/** What the person's answer carries besides yes or no. */
export interface DecisionInput {
  confirm?: string | undefined
  password?: string | undefined
  /** User request 2026-10-26: a backup without a password, where the card offers one. */
  plain?: boolean
}

/** A change waiting for the person: what runs when they confirm it, and how the turn learns the end. */
export interface PendingChange {
  callId: string
  /** B6: the chat of the turn, for the audit of the change's own routes. */
  chat?: string
  /** The connection it acts on (checked again when the person confirms). */
  connectionId: string
  /** The name to type, for a destructive change. */
  typed?: string
  /** An encrypted backup asks for its password. */
  password?: boolean
  /** B2: that password opens a backup made before (any length), not a new one's. */
  opening?: boolean
  /** B4: that password is a new MongoDB user's (as Database Access takes one). */
  passwordFor?: 'user'
  /** User request 2026-10-26: the backup may be made without a password instead. */
  plain?: boolean
  run(auth: AgentAuth, input: DecisionInput): Promise<ChangeEnd>
  /** C5: the change's tool (an administrator may turn it off on the connection meanwhile). */
  tool?: string
  /** C4: the backup the card offers, made through the backup route as the person. */
  backup?: (auth: AgentAuth, password: string) => Promise<{ job: string } | { reason: string }>
  /** C4: how that backup goes, said in the turn. */
  notify?: (backup: AiAgentStepBackup) => void
}

interface Run {
  owner: string
  pending: PendingChange | null
  /** The answer being carried out: a second answer is refused (no double click). */
  deciding: boolean
  settle: ((end: ChangeEnd) => void) | null
  timer: ReturnType<typeof setTimeout> | null
  /** The turn ended while an answer was being carried out: the run goes once that answer ends. */
  closing: boolean
  /** C4: the card's backup — none yet, being made (the change waits for it), or made. */
  backup: 'none' | 'running' | 'done'
  /** The change's whole time to be answered. */
  ms: number
  /** When its time runs out (while its timer runs). */
  deadline: number
  /** Review of C4 (M3): the time it had left when its backup began. */
  left: number
  /** Second review of C4 (M3): the card is held for its backups until then at most, all together. */
  holdUntil: number | null
}

/** Second review of C4 (M3): a clock that never goes back (a wall clock changed is not time spent). */
const clock = () => performance.now()

/**
 * Review of C4 (M3): how long a change waits for its backup at most — the backup's job runs on, but
 * the card is no longer held open by it.
 */
export const BACKUP_HOLD_TIMES = 6

/**
 * W6.3: the turns running now, each with at most one change waiting for its person. A run belongs
 * to the person who started it: anyone else's answer finds nothing (404), as for a chat.
 */
export class AgentRuns {
  private readonly runs = new Map<string, Run>()

  open(id: string, owner: string): void {
    this.runs.set(id, {
      owner,
      pending: null,
      deciding: false,
      settle: null,
      timer: null,
      closing: false,
      backup: 'none',
      ms: AI_AGENT_LIMITS.decisionMs,
      deadline: 0,
      left: 0,
      holdUntil: null,
    })
  }

  /** The turn ended: a change still waiting is cancelled (nothing is written). */
  close(id: string): void {
    const run = this.runs.get(id)
    if (!run) return
    // W6.3 security review (minor 1): an answer being carried out ends as it really ends (finish),
    // never as "cancelled — nothing was changed" while its write goes through.
    if (run.deciding) {
      run.closing = true
      return
    }
    this.end(run, { state: 'cancelled' })
    this.runs.delete(id)
  }

  /** Review of B8 (M3): the run is open and the person's own (whether a change waits or not). */
  owns(id: string, owner: string): boolean {
    return this.runs.get(id)?.owner === owner
  }

  /** The person's change, found by its run and call — only for its owner, only while it waits. */
  pending(id: string, owner: string, callId: string): PendingChange | null {
    const run = this.runs.get(id)
    if (!run || run.owner !== owner || !run.pending || run.pending.callId !== callId) return null
    return run.pending
  }

  /** Waits for the person's answer (or the deadline, or the end of the turn). */
  wait(id: string, change: PendingChange, ms: number = AI_AGENT_LIMITS.decisionMs): Promise<ChangeEnd> {
    const run = this.runs.get(id)
    if (!run) return Promise.resolve({ state: 'cancelled' })
    return new Promise<ChangeEnd>((resolve) => {
      run.pending = change
      run.deciding = false
      run.settle = resolve
      run.backup = 'none'
      run.ms = ms
      run.holdUntil = null
      this.arm(run, ms)
    })
  }

  private arm(run: Run, ms: number): void {
    run.deadline = clock() + ms
    run.timer = setTimeout(() => {
      if (!run.deciding) this.end(run, { state: 'expired' })
    }, ms)
    run.timer.unref?.()
  }

  /**
   * C4: the card's backup, once: true when this call may make it (its change waiting, not being
   * answered, no backup made or being made). The change's deadline waits while it is made.
   */
  startBackup(id: string, owner: string, callId: string): boolean {
    const run = this.runs.get(id)
    if (!run || run.owner !== owner || !run.pending || run.pending.callId !== callId) return false
    if (!run.pending.backup || run.deciding || run.backup !== 'none') return false
    run.backup = 'running'
    const now = clock()
    run.left = Math.min(run.ms, Math.max(0, run.deadline - now))
    if (run.timer) clearTimeout(run.timer)
    // Review of C4 (M3): held while the backup is made — for a bounded while, for all its backups.
    run.holdUntil ??= now + run.ms * BACKUP_HOLD_TIMES
    this.arm(run, Math.max(0, run.holdUntil - now))
    return true
  }

  /**
   * C4: the backup ended. Made, the change has its whole time again (the backup took it); not made,
   * the time it had left (it may be asked again — never a way to hold the card open).
   */
  endBackup(id: string, callId: string, made: boolean): void {
    const run = this.runs.get(id)
    if (!run || run.backup !== 'running' || run.pending?.callId !== callId) return
    run.backup = made ? 'done' : 'none'
    if (!run.settle || run.deciding) return
    if (run.timer) clearTimeout(run.timer)
    this.arm(run, made ? run.ms : run.left)
  }

  /** C4: a backup is being made for the change waiting: it cannot be confirmed yet. */
  backingUp(id: string): boolean {
    return this.runs.get(id)?.backup === 'running'
  }

  /**
   * Takes the person's answer once: true when this call may carry it out (a second answer, or one
   * after the change ended, is refused).
   */
  take(id: string, owner: string, callId: string): boolean {
    const run = this.runs.get(id)
    if (!run || run.owner !== owner || !run.pending || run.pending.callId !== callId || run.deciding)
      return false
    run.deciding = true
    // An answer taken while its backup is made: the deadline is the answer's now.
    if (run.timer) clearTimeout(run.timer)
    run.timer = null
    return true
  }

  /**
   * Re-review of A1/A2 (I1): every change still waiting for its answer ends as `end` — an
   * administrator narrowed what the agent may do. One being carried out is left to end as it ends.
   */
  endWaiting(end: ChangeEnd): number {
    let n = 0
    for (const run of this.runs.values())
      if (run.pending && !run.deciding && run.settle) {
        this.end(run, end)
        n++
      }
    return n
  }

  /** How the answered change ended; the turn goes on (false: the turn had ended meanwhile). */
  finish(id: string, end: ChangeEnd): boolean {
    const run = this.runs.get(id)
    if (!run?.settle) return false
    this.end(run, end)
    if (run.closing) this.runs.delete(id)
    return true
  }

  private end(run: Run, end: ChangeEnd): void {
    if (run.timer) clearTimeout(run.timer)
    run.timer = null
    const settle = run.settle
    run.settle = null
    run.pending = null
    run.deciding = false
    run.backup = 'none'
    settle?.(end)
  }
}

/** W6.3: tool calls a minute, per person, over all their turns. */
export class CallWindow {
  private readonly recent = new Map<string, number[]>()
  constructor(
    private readonly now: () => number,
    private readonly perMinute: number = AI_AGENT_LIMITS.callsPerMinute,
  ) {}

  /** Takes one call; false when the minute is full. */
  take(user: string): boolean {
    const t = this.now()
    const times = (this.recent.get(user) ?? []).filter((x) => x > t - 60_000)
    if (times.length >= this.perMinute) {
      this.recent.set(user, times)
      return false
    }
    times.push(t)
    this.recent.set(user, times)
    return true
  }
}
