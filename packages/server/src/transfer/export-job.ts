import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { PassThrough, type Transform } from 'node:stream'
import { createGzip } from 'node:zlib'
import type { AbstractCursor, Document, FindOptions, MongoClient } from 'mongodb'
import type { ExportReport, ExportRequest } from '@mongo-manager/shared'
import { deserializeValue } from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { JobKind } from '../jobs/types'
import type { ServerContext } from '../http/context'
import type { NsMasker } from '../masking/match'
import { maskDocument } from '../masking/document'
import { READ_OPTIONS, toClient } from '../data/ejson-io'
import { killByComment } from '../data/operations'
import { countBytes } from './gzip'
import { BATCH_DOCS } from './limits'
import { docWriter } from './writers'
import { refuseAnyRepeat } from '../masking/repeats'

/** What the route checked and rewrote, run as is by the job. */
export type ExportPlan =
  | {
      kind: 'find'
      filter: Document
      options: FindOptions
      /** The gate's check of a guarded sort, and removal of the keys it added (3c §3.7). */
      finish: ((docs: Document[]) => Document[]) | null
      /** A time series whose _id may repeat: asked about once before it is read (eighteenth review). */
      repeats?: boolean
      /** `finish` refuses document _ids itself: the question leaves them out (nineteenth review). */
      checksId?: boolean
      output: NsMasker | null
    }
  | { kind: 'aggregate'; stages: Document[]; output: NsMasker | null }

export interface ExportJobParams {
  owner: string
  request: ExportRequest
  plan: ExportPlan
  /**
   * User request 2026-10-11: several collections of one database into one SQL file, in this order,
   * each with its own plan (masked as its own) and its table's name; the job's collection is "*".
   */
  parts?: Array<{ db: string; coll: string; table: string; plan: ExportPlan }>
  masked: boolean
  rulesVersion: number
  /** The file's name without extension: "<collection>-<time>". */
  name: string
}

/**
 * Spec §8.1: a document as the documents view shows it to a restricted user. The masking walks
 * canonical EJSON, as on every other read: a DBRef's fields are its keys there, and BSON values
 * are wrappers it keeps whole (final review C1); the result is read back into BSON for the writer.
 */
function masked(doc: Document, output: NsMasker): Document {
  let wire: unknown
  try {
    wire = toClient(doc)
  } catch {
    throw Errors.conflict('A document holds a value that cannot be exported masked (a date out of range)')
  }
  return deserializeValue<Document>(maskDocument(wire, output))
}

/** Phase 3d-1 §4.3, §8.1: the export job — masked as it is written, never stored unmasked for a restricted user. */
export function exportKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  ctx: () => ServerContext
  /** Kills the operations tagged with a comment; tests replace it. */
  kill?: (client: MongoClient, comment: string) => Promise<number>
}): JobKind<ExportJobParams> {
  const kill = deps.kill ?? killByComment
  return {
    name: 'data.export',
    async run(job, p) {
      const ctx = deps.ctx()
      const { files, reports, limits } = ctx.transfer
      const { db, coll, connectionId } = job.target
      const started = Date.now()
      const client = await deps.client(connectionId)
      const parts = p.parts ?? [{ db, coll, table: coll, plan: p.plan }]
      let estimate: number | null = 0
      for (const part of parts) {
        // Cancelled while counting: no further count (review 2026-10-11); the writing loop stops too.
        if (job.signal.aborted) break
        const collection = client.db(part.db).collection(part.coll)
        const plan = part.plan
        if (plan.kind !== 'find' || estimate === null) {
          estimate = null
          continue
        }
        try {
          let n = Object.keys(plan.filter).length
            ? await collection.countDocuments(plan.filter, { maxTimeMS: 10_000, comment: job.comment })
            : await collection.estimatedDocumentCount({ comment: job.comment })
          n = Math.max(0, n - (plan.options.skip ?? 0))
          if (plan.options.limit) n = Math.min(n, plan.options.limit)
          estimate += n
        } catch {
          estimate = null
        }
      }
      if (estimate !== null) job.setEstimate(estimate)
      const { file, path } = files.reserve({
        owner: p.owner,
        kind: 'export',
        connectionId,
        name: p.name,
        jobId: job.id,
        namespace: `${db}.${coll}`,
        format: p.request.format,
        gzip: p.request.gzip,
        masked: p.masked,
        rulesVersion: p.rulesVersion,
      })
      let bytes = 0
      // The query ends when the job may run no longer (final review I8).
      const timeLeft = () => Math.max(1, limits.maxJobMs - (Date.now() - started))
      // Measured against every file of the owner as it is now: other jobs grow theirs meanwhile (I6).
      const checkRoom = () => {
        files.grow(file.id, bytes)
        if (files.room(p.owner) < 0) throw files.full(p.owner)
      }
      const head = new PassThrough()
      const chain: Transform[] = p.request.gzip ? [createGzip()] : []
      const done = pipeline([
        head,
        ...chain,
        countBytes((n) => (bytes += n)),
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      ])
      done.catch(() => undefined)
      let written = 0
      let cutCells = 0
      const omittedFields = new Set<string>()
      const tables: NonNullable<ExportReport['tables']> = []
      let cursor: AbstractCursor<Document> | null = null
      try {
        for (const part of parts) {
          // A cancel is seen before the next collection's query (review 2026-10-11).
          if (job.signal.aborted) break
          const plan = part.plan
          const collection = client.db(part.db).collection(part.coll)
          const request = p.parts ? { ...p.request, sql: { ...p.request.sql, table: part.table } } : p.request
          const writer = docWriter(head, request, { collection: part.coll })
          const writtenBefore = written
          cursor =
            plan.kind === 'find'
              ? collection.find(plan.filter, {
                  ...READ_OPTIONS,
                  ...plan.options,
                  batchSize: BATCH_DOCS,
                  comment: job.comment,
                  maxTimeMS: timeLeft(),
                })
              : collection.aggregate(plan.stages, {
                  ...READ_OPTIONS,
                  allowDiskUse: true,
                  batchSize: BATCH_DOCS,
                  comment: job.comment,
                  maxTimeMS: timeLeft(),
                })
          // Eighteenth review (Minor 3, Minor 4): a time series whose _id may repeat is asked once,
          // before anything is written, whether one does.
          if (plan.kind === 'find' && plan.repeats)
            await refuseAnyRepeat(
              collection,
              {
                comment: job.comment,
                maxTimeMS: timeLeft(),
                ...(plan.options.collation ? { collation: plan.options.collation } : {}),
              },
              plan.checksId === true,
            )
          let batch: Document[] = []
          const drain = async () => {
            const docs = plan.kind === 'find' && plan.finish ? plan.finish(batch) : batch
            batch = []
            for (const d of docs) {
              // Spec §8.1: the file holds what the documents view shows: *** where a value is hidden.
              await writer.write(plan.output?.any ? masked(d, plan.output) : d)
              written++
            }
            job.progress(written, estimate ?? written)
            checkRoom()
            if (Date.now() - started > limits.maxJobMs)
              throw Errors.conflict('The export ran longer than allowed')
          }
          for await (const doc of cursor) {
            if (job.signal.aborted) break
            batch.push(doc)
            if (batch.length >= BATCH_DOCS) await drain()
          }
          // Cancelled meanwhile: the next part's first check ends the export (its file is deleted).
          await drain()
          const ended = await writer.end()
          cutCells += ended.cutCells
          for (const f of ended.omittedFields) omittedFields.add(f)
          tables.push({
            database: part.db,
            collection: part.coll,
            table: part.table,
            written: written - writtenBefore,
            omittedFields: ended.omittedFields,
            cutCells: ended.cutCells,
          })
          cursor = null
        }
        if (job.signal.aborted) throw Errors.conflict('The export was cancelled')
        head.end()
        await done
        checkRoom()
        files.complete(file.id, bytes)
        const report: ExportReport = {
          kind: 'export',
          written,
          bytes,
          omittedFields: [...omittedFields],
          cutCells,
          expiresAt: ctx.now() + limits.ttlMs,
          masked: p.masked,
          ...(p.parts ? { tables } : {}),
        }
        reports.save(job.id, p.owner, report, report.expiresAt)
        ctx.audit.append({
          action: 'transfer.export',
          outcome: 'success',
          userId: p.owner === 'local' ? null : p.owner,
          username: null,
          ip: null,
          connectionId,
          namespace: `${db}.${coll}`,
          details: {
            job: job.id,
            format: p.request.format,
            source: p.request.source.kind,
            // Names bounded (review 2026-10-11): at most 100 of them, with the count.
            ...(p.parts
              ? {
                  collections: p.parts.slice(0, 100).map((part) => `${part.db}.${part.coll}`),
                  collectionCount: p.parts.length,
                }
              : {}),
            written,
            bytes,
            masked: p.masked,
          },
        })
      } catch (e) {
        await cursor?.close().catch(() => undefined)
        head.destroy()
        await done.catch(() => undefined)
        // A partial file never stays (spec §4.5).
        files.delete(p.owner, file.id)
        if (job.signal.aborted) return
        throw e
      }
    },
    // Cancel ends the query too, not only the loop that reads it (final review I8).
    async cancel(job) {
      const client = await deps.client(job.target.connectionId).catch(() => null)
      if (client) await kill(client, job.comment).catch(() => 0)
      return true
    },
    recover: () => 'interrupted',
  }
}
