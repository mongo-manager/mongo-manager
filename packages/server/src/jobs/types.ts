// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { JobKindName, JobParts, JobState } from '@mongo-manager/shared'

export type { JobKindName, JobState }

/** A job as stored: the owner and the staging collection never leave the server. */
export interface JobRecord {
  id: string
  kind: JobKindName
  userId: string | null
  connectionId: string
  /** Phase 3d-2: the second connection of a copy, compare or sync. */
  targetConnectionId: string | null
  db: string
  coll: string
  target: string
  state: JobState
  progress: { done: number; total: number } | null
  estimate: number | null
  error: string | null
  staging: string | null
  /** Where the staging collection lives; null: the job's connection and database. */
  stagingConnectionId: string | null
  stagingDb: string | null
  startedAt: number
  finishedAt: number | null
  /** W4.3, W4.4: progress per part, held in memory while the job runs (never stored). */
  parts?: JobParts
}

export interface JobTarget {
  userId: string | null
  connectionId: string
  targetConnectionId?: string | null
  db: string
  coll: string
  target: string
}

/** What a running job may do besides its work. */
export interface JobContext {
  readonly id: string
  readonly signal: AbortSignal
  /** "mm-job:<id>": tags the MongoDB operation, so it can be found in $currentOp and killed. */
  readonly comment: string
  readonly target: JobTarget
  progress(done: number, total: number): void
  /** Stored at once: a restart must know which staging collection to drop, and where. */
  setStaging(name: string | null, where?: { connectionId: string; db: string }): void
  setEstimate(count: number): void
  /** W4.3, W4.4: progress per part (see jobs/parts.ts); coalesced like progress. */
  setParts(parts: JobParts): void
}

export interface JobKind<P> {
  name: JobKindName
  run(ctx: JobContext, params: P): Promise<void>
  /** Stops a running job. False when the operation had already ended, so nothing was cancelled. */
  cancel(ctx: JobContext, params: P): Promise<boolean>
  /** The state of a job a previous process left running. */
  recover(record: JobRecord): 'interrupted' | 'unknown'
}
