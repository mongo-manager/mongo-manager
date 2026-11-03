import type { DatabaseSync } from 'node:sqlite'
import type { JobRecord, JobState } from './types'

interface Row {
  id: string
  kind: JobRecord['kind']
  user_id: string | null
  connection_id: string
  target_connection_id: string | null
  db: string
  coll: string
  target: string
  state: JobState
  progress_done: number | null
  progress_total: number | null
  estimate: number | null
  error: string | null
  staging: string | null
  staging_connection_id: string | null
  staging_db: string | null
  started_at: number
  finished_at: number | null
}

const toRecord = (r: Row): JobRecord => ({
  id: r.id,
  kind: r.kind,
  userId: r.user_id,
  connectionId: r.connection_id,
  targetConnectionId: r.target_connection_id,
  db: r.db,
  coll: r.coll,
  target: r.target,
  state: r.state,
  progress:
    r.progress_done !== null && r.progress_total !== null
      ? { done: r.progress_done, total: r.progress_total }
      : null,
  estimate: r.estimate,
  error: r.error,
  staging: r.staging,
  stagingConnectionId: r.staging_connection_id,
  stagingDb: r.staging_db,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
})

export interface JobFilter {
  state?: JobState
  connectionId?: string
  db?: string
  coll?: string
  limit?: number
}

/** The record of every job (phase 1h spec §3); the runner keeps the live part in memory. */
export class JobRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(job: JobRecord): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, user_id, connection_id, target_connection_id, db, coll, target, state,
           progress_done, progress_total, estimate, error, staging, staging_connection_id, staging_db,
           started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.kind,
        job.userId,
        job.connectionId,
        job.targetConnectionId,
        job.db,
        job.coll,
        job.target,
        job.state,
        job.progress?.done ?? null,
        job.progress?.total ?? null,
        job.estimate,
        job.error,
        job.staging,
        job.stagingConnectionId,
        job.stagingDb,
        job.startedAt,
        job.finishedAt,
      )
  }

  /** Writes the changing fields; a job whose connection was deleted meanwhile has no row left. */
  update(job: JobRecord): void {
    this.db
      .prepare(
        `UPDATE jobs SET state = ?, progress_done = ?, progress_total = ?, estimate = ?, error = ?, staging = ?,
           staging_connection_id = ?, staging_db = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        job.state,
        job.progress?.done ?? null,
        job.progress?.total ?? null,
        job.estimate,
        job.error,
        job.staging,
        job.stagingConnectionId,
        job.stagingDb,
        job.finishedAt,
        job.id,
      )
  }

  get(id: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as Row | undefined
    return row && toRecord(row)
  }

  list(filter: JobFilter = {}): JobRecord[] {
    const where: string[] = []
    const params: Array<string | number> = []
    for (const [column, value] of [
      ['state', filter.state],
      ['connection_id', filter.connectionId],
      ['db', filter.db],
      ['coll', filter.coll],
    ] as const) {
      if (value !== undefined) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY started_at DESC, rowid DESC ${filter.limit ? 'LIMIT ?' : ''}`
    if (filter.limit) params.push(filter.limit)
    return (this.db.prepare(sql).all(...params) as unknown as Row[]).map(toRecord)
  }

  /** Jobs whose staging collection lives on this connection (phase 3d-2: maybe not the job's own). */
  withStaging(connectionId: string): JobRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM jobs WHERE staging IS NOT NULL AND (staging_connection_id = ?
             OR (staging_connection_id IS NULL AND connection_id = ?)) ORDER BY started_at`,
        )
        .all(connectionId, connectionId) as unknown as Row[]
    ).map(toRecord)
  }

  /**
   * Drops finished jobs older than `before`, then all but the newest `keep` finished ones. A job
   * still naming a staging collection is kept: it is the only record of what is left to drop.
   */
  prune(before: number, keep: number): void {
    this.db
      .prepare("DELETE FROM jobs WHERE state != 'running' AND staging IS NULL AND finished_at < ?")
      .run(before)
    this.db
      .prepare(
        `DELETE FROM jobs WHERE state != 'running' AND staging IS NULL AND id NOT IN (
           SELECT id FROM jobs WHERE state != 'running' AND staging IS NULL
           ORDER BY finished_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(keep)
  }
}
