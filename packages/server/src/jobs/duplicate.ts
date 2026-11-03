import { randomBytes } from 'node:crypto'
import type { MongoClient } from 'mongodb'
import { Errors } from '../errors'
import { withMongo } from '../data/mongo-errors'
import { killByComment } from '../data/operations'
import type { JobContext, JobKind } from './types'

export interface DuplicateJobParams {
  to: string
}

/**
 * W4.4: the staging mark of a restore drill — its scratch database (the job's `stagingDb`) is dropped
 * whole at the next open when a stopped server left it, and only when the name is one a drill makes.
 */
export const DRILL_STAGING = '*drill'
export const DRILL_DB = /^mm_drill_[0-9a-f]{12}$/

/** Only names this code made are ever dropped as staging collections. */
export const STAGING_NAME = /^mm_duplicate_[0-9a-f]{16}$/
/** Phase 3d-2: staging collections of copies (on the target connection, in the target database). */
export const COPY_STAGING = /^mm_copy_[0-9a-f]{16}$/
/** Phase 3d-3a: a replace restore's collection, before it is swapped in. */
export const RESTORE_STAGING = /^mm_restore_[0-9a-f]{16}$/
const STAGING_NAMES = [STAGING_NAME, COPY_STAGING, RESTORE_STAGING]

type Phase = 'preparing' | 'copying' | 'renaming'

const aborted = () => Errors.conflict('The copy was cancelled')

/**
 * Duplicating a collection as a job. $out reports no progress, so the job carries the source's
 * document count as an estimate and the UI shows the elapsed time. $out replaces its target, so
 * it writes to a staging name nobody else uses, and the copy takes the requested name only
 * through a rename that refuses to replace a collection created meanwhile (final review 1g-3).
 */
export function duplicateKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  /** Kills the operations tagged with a comment; tests replace it. */
  kill?: (client: MongoClient, comment: string) => Promise<number>
}): JobKind<DuplicateJobParams> {
  const kill = deps.kill ?? killByComment
  const phases = new WeakMap<JobContext, Phase>()
  /**
   * Copies asked to stop. Marked before any await in cancel, and checked right before the rename,
   * so a copy is either renamed into place (and cancel answers no) or never (final review I2).
   */
  const stopRequested = new WeakSet<JobContext>()
  const stopping = (ctx: JobContext) => ctx.signal.aborted || stopRequested.has(ctx)

  return {
    name: 'collection.duplicate',
    async run(ctx, { to }) {
      phases.set(ctx, 'preparing')
      const client = await deps.client(ctx.target.connectionId)
      const database = client.db(ctx.target.db)
      const taken = await withMongo(() =>
        database.listCollections({ name: to }, { nameOnly: true }).toArray(),
      )
      if (taken.length > 0) throw Errors.conflict('A collection or view with that name already exists')
      ctx.setEstimate(await withMongo(() => database.collection(ctx.target.coll).estimatedDocumentCount()))
      const staging = `mm_duplicate_${randomBytes(8).toString('hex')}`
      ctx.setStaging(staging)
      try {
        phases.set(ctx, 'copying')
        if (stopping(ctx)) throw aborted()
        await withMongo(() =>
          database
            .collection(ctx.target.coll)
            .aggregate([{ $match: {} }, { $out: staging }], { comment: ctx.comment })
            .toArray(),
        )
        if (stopping(ctx)) throw aborted()
        phases.set(ctx, 'renaming')
        await withMongo(() => database.collection(staging).rename(to, { dropTarget: false }))
        ctx.setStaging(null)
      } catch (error) {
        // The name is forgotten only once the staging collection is surely gone (code 26: it never
        // existed); otherwise the next open of the connection tries again.
        const gone = await database
          .collection(staging)
          .drop()
          .then(
            () => true,
            (e: { code?: unknown }) => e.code === 26,
          )
        if (gone) ctx.setStaging(null)
        throw error
      } finally {
        phases.delete(ctx)
      }
    },
    async cancel(ctx) {
      const phase = phases.get(ctx)
      // Renaming (or done): the copy is, or is about to be, in place; it is not undone.
      if (phase !== 'preparing' && phase !== 'copying') return false
      stopRequested.add(ctx)
      // The copy will not be renamed now. Killing $out only makes it end sooner; if that fails (an
      // account that may not kill it), it ends when $out does, still without a rename.
      if (phase === 'copying') {
        const client = await deps.client(ctx.target.connectionId).catch(() => null)
        if (client) await kill(client, ctx.comment).catch(() => 0)
      }
      return true
    },
    recover: () => 'interrupted',
  }
}

/**
 * Drops the staging collections that finished copies left behind (a restart, or a drop that failed),
 * then forgets them. Runs when the connection opens, before anything else uses it. The copy's own
 * operation is killed first, in case MongoDB kept it running after its client went away. Only names
 * this code makes are dropped; a failure is logged by job id and tried again at the next open.
 */
export async function dropLeftoverStaging(
  jobs: {
    /** Jobs whose staging collection lives on this connection (phase 3d-2: maybe not their own). */
    withStaging(
      connectionId: string,
    ): Array<{ id: string; db: string; state: string; staging: string | null; stagingDb: string | null }>
    forgetStaging(id: string): void
  },
  connectionId: string,
  client: MongoClient,
  deps: {
    kill?: (client: MongoClient, comment: string) => Promise<number>
    warn: (fields: { job: string }, message: string) => void
    /** The open was stopped and the client is being closed: nothing more is tried, or warned of. */
    signal?: AbortSignal
  },
): Promise<void> {
  const kill = deps.kill ?? killByComment
  for (const job of jobs.withStaging(connectionId)) {
    if (deps.signal?.aborted) return
    const staging = job.staging
    if (job.state === 'running' || !staging) continue
    // W4.4: a restore drill's scratch database, dropped whole — only a name a drill makes.
    if (staging === DRILL_STAGING) {
      if (!job.stagingDb || !DRILL_DB.test(job.stagingDb)) continue
      await kill(client, `mm-job:${job.id}`).catch(() => 0)
      if (deps.signal?.aborted) return
      try {
        await client.db(job.stagingDb).dropDatabase()
      } catch {
        if (deps.signal?.aborted) return
        deps.warn({ job: job.id }, 'could not drop the scratch database of a restore drill; will retry')
        continue
      }
      jobs.forgetStaging(job.id)
      continue
    }
    if (!STAGING_NAMES.some((r) => r.test(staging))) continue
    await kill(client, `mm-job:${job.id}`).catch(() => 0)
    if (deps.signal?.aborted) return
    try {
      await client
        .db(job.stagingDb ?? job.db)
        .collection(staging)
        .drop()
    } catch (e) {
      // Already gone (NamespaceNotFound) is what we wanted; anything else is tried again next open.
      if ((e as { code?: unknown }).code !== 26) {
        if (deps.signal?.aborted) return
        deps.warn({ job: job.id }, 'could not drop the staging collection of a copy; will retry')
        continue
      }
    }
    jobs.forgetStaging(job.id)
  }
}
