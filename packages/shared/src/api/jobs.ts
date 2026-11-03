/** Background jobs (phase 1h spec §3): what the REST routes and the /ws channel show. */
export const JOB_KINDS = [
  'index.create',
  'collection.duplicate',
  'data.import',
  // User request 2026-10-10: a SQL dump's tables into collections of a database.
  'data.importSql',
  'data.export',
  'data.copy',
  'data.compare',
  'data.sync',
  'backup.dump',
  'backup.restore',
  'backup.send',
  'backup.fetch',
  // W4.4: a scheduled restore drill (a backup restored into a scratch database, verified, dropped).
  'backup.drill',
] as const
export type JobKindName = (typeof JOB_KINDS)[number]

export const JOB_STATES = ['running', 'done', 'failed', 'cancelled', 'interrupted', 'unknown'] as const
export type JobState = (typeof JOB_STATES)[number]

/**
 * W4.3, W4.4: a job's progress per part — a database copy's collections, a dump's or a restore's
 * namespaces — with the phase it is in. Live only: a finished job's report holds the outcome.
 */
export const JOB_PART_STATES = ['waiting', 'running', 'done', 'failed', 'skipped'] as const
export type JobPartState = (typeof JOB_PART_STATES)[number]
export interface JobPart {
  name: string
  state: JobPartState
  done: number
  /** What `done` counts up to, when known (documents, or bytes for a dump's namespace). */
  total: number | null
}
export interface JobParts {
  /** What the job is doing now: "copy", "indexes", "views", "dump", "restore", "verify"… */
  phase?: string
  /** All the parts; `items` lists at most a bounded number of them, the running ones always. */
  count: number
  finished: number
  items: JobPart[]
}

/** A job as a user sees it: never its owner's id or the staging collection. */
export interface JobView {
  id: string
  kind: JobKindName
  connectionId: string
  db: string
  coll: string
  /** Phase 3d-2: the other connection of a copy, compare or sync. */
  targetConnectionId: string | null
  /** The index name, or the new collection's name. */
  target: string
  state: JobState
  /** Measured progress, or null when MongoDB reports none (the UI then shows the elapsed time). */
  progress: { done: number; total: number } | null
  /** The source document count of a duplicate, shown as "about N documents". */
  estimate: number | null
  error: string | null
  startedAt: number
  finishedAt: number | null
  /** Started by the viewer. */
  mine: boolean
  /** The viewer may cancel it now. */
  cancellable: boolean
  /**
   * Phase 3d-3b (spec §4.2): a running send or fetch waits for a transfer slot of these destinations
   * (their names): "Waiting for the destination". Absent when it waits for none.
   */
  waitingFor?: string[]
  /** Phase 3d-3b: a send asked to delete the local copy, and kept it (a destination did not complete). */
  localKept?: boolean
  /** Phase 3d-3b: a fetch checks the file against a recorded digest; false: a foreign file, not verified. */
  verified?: boolean
  /**
   * Phase 3d-3b final review B33: a failed send's destinations that did not complete, each with its
   * reason code (destinations.reason.*), the same the error sentence is made of.
   */
  failures?: Array<{ destination: string; reason: string | null }>
  /** Phase 3d-3c: the schedule a scheduled dump or send runs for (plan ruling 29). */
  scheduleName?: string
  /** W4.3, W4.4: progress per collection or namespace while the job runs. */
  parts?: JobParts
}
