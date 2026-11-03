import type { Document, MongoClient } from 'mongodb'
import type { ImportReport, ImportRequest } from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { JobKind } from '../jobs/types'
import type { ServerContext } from '../http/context'
import type { Masker } from '../masking/match'
import { gateDepsFor } from '../masking/restricted'
import type { GateDeps } from '../masking/gate'
import { killByComment } from '../data/operations'
import { BATCH_BYTES, BATCH_DOCS, MAX_REPORT_ERRORS } from './limits'
import { openSource, type Opened } from './source'
import { compileMapping, getPath, type Mapper } from './mapping'
import { RejectedWriter } from './rejected'
import { TargetWriter, pathLikeField, type PendingDoc } from './target-writer'
import { isFailure, type Cell, type DocRecord, type RecordFailure, type TableRow } from './formats/types'

export interface ImportJobParams {
  owner: string
  uploadId: string
  request: ImportRequest
  /** Restricted callers only: the rules their writes are checked with (spec §8.2). */
  masker: Masker | null
}

type Input = { n: number; cells?: Cell[]; raw?: string }
type Pending = PendingDoc

const sizeOf = (doc: Document) => JSON.stringify(doc)?.length ?? 0

/** Phase 3d-1 §4.2, §6: the import job (and its dry run). */
export function importKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  ctx: () => ServerContext
  /** Kills the operations tagged with a comment; tests replace it. */
  kill?: (client: MongoClient, comment: string) => Promise<number>
}): JobKind<ImportJobParams> {
  const kill = deps.kill ?? killByComment
  return {
    name: 'data.import',
    async run(job, params) {
      const ctx = deps.ctx()
      const { files, reports, limits } = ctx.transfer
      const { request: req, owner, masker } = params
      const { db, coll: collName, connectionId } = job.target
      const started = Date.now()
      const report: ImportReport = {
        kind: 'import',
        dryRun: req.dryRun,
        mode: req.mode,
        read: 0,
        inserted: 0,
        matched: 0,
        modified: 0,
        upserted: 0,
        skipped: 0,
        failed: 0,
        ...(req.dryRun && req.mode !== 'insert' ? { wouldMatch: 0 } : {}),
        fields: [],
        errors: [],
        moreErrors: false,
        rejectedFile: false,
      }
      const file = files.get(owner, params.uploadId)
      if (!file || file.kind !== 'upload' || !file.complete || file.connectionId !== connectionId)
        throw Errors.notFound('The upload is gone')
      const ordered = req.onError === 'stop'
      let stopped = false
      let opened: Opened | undefined
      let mapper: Mapper | undefined
      let rejected: RejectedWriter | undefined
      let threw = false
      // Every operation ends when the job may run no longer (final review I8).
      const timeLeft = () => Math.max(1, limits.maxJobMs - (Date.now() - started))

      const fail = async (p: Input, reason: string, field?: string, code?: number) => {
        report.failed++
        if (report.errors.length < MAX_REPORT_ERRORS)
          report.errors.push({
            record: p.n,
            reason,
            ...(field !== undefined ? { field } : {}),
            ...(code !== undefined ? { code } : {}),
          })
        else report.moreErrors = true
        await rejected?.write(p)
        if (ordered && !stopped) {
          stopped = true
          report.stoppedAt = p.n
        }
      }
      try {
        opened = await openSource(
          file,
          files,
          { format: req.format, dialect: req.dialect, allowUnusual: req.allowUnusualKeys },
          limits,
        )
        const source = opened.source
        rejected = new RejectedWriter({
          files,
          owner,
          connectionId,
          jobId: job.id,
          format: req.format,
          header: source.kind === 'table' ? source.header : null,
          name: file.name,
          delimiter: opened.dialect.delimiter,
        })
        mapper = compileMapping({
          table: source.kind === 'table' ? source : null,
          mapping: req.mapping,
          constants: req.constants,
          allowUnusual: req.allowUnusualKeys,
          now: new Date(started),
        })
        const client = await deps.client(connectionId)
        const collection = client.db(db).collection(collName)
        const gate: GateDeps | null = masker
          ? gateDepsFor(masker, client, { comment: job.comment, timeLeft })
          : null
        // Phase 3d-2: the writes live in TargetWriter, shared with the copy job; counts go straight
        // into the report.
        const writer = new TargetWriter({
          collection,
          targetDb: client.db(db),
          db,
          coll: collName,
          mode: req.mode,
          keys: req.keys,
          updateOnly: req.updateOnly,
          ordered,
          gate,
          codeOnly: masker !== null,
          comment: job.comment,
          timeLeft,
          signal: job.signal,
          counts: report,
          fail,
          stopped: () => stopped,
        })

        let batch: Pending[] = []
        let bytes = 0
        const flush = async () => {
          const taken = batch
          batch = []
          bytes = 0
          if (!taken.length) return
          if (!req.dryRun) await writer.write(taken)
          else if (req.mode !== 'insert')
            report.wouldMatch = (report.wouldMatch ?? 0) + (await writer.wouldMatch(taken))
        }
        const refuse = async (p: Input, reason: string, field?: string) => {
          // With "stop", the records before this one are written first (as mongoimport --stopOnError).
          if (ordered) await flush()
          if (!stopped) await fail(p, reason, field)
        }

        const records: AsyncIterable<TableRow | DocRecord | RecordFailure> =
          source.kind === 'table' ? source.rows : source.records
        for await (const rec of records) {
          if (job.signal.aborted || stopped) break
          if (Date.now() - started > limits.maxJobMs)
            throw Errors.conflict('The import ran longer than allowed')
          report.read++
          if (isFailure(rec)) await refuse(rec, rec.error)
          else {
            const mapped = 'cells' in rec ? mapper.table(rec) : mapper.doc(rec)
            const input: Input = 'cells' in rec ? { n: rec.n, cells: rec.cells } : { n: rec.n, raw: rec.raw }
            if (!mapped.ok) await refuse(input, mapped.reason, mapped.field)
            else {
              const missing =
                req.mode === 'insert' ? undefined : req.keys.find((k) => getPath(mapped.doc, k) === undefined)
              const pathLike = req.mode === 'merge' ? pathLikeField(mapped.doc) : undefined
              if (missing) await refuse(input, `The key field "${missing}" is missing`, missing)
              else if (pathLike !== undefined)
                await refuse(
                  input,
                  'A merge cannot set a field whose name holds "." or starts with "$"; use upsert',
                  pathLike.slice(0, 200),
                )
              else {
                batch.push({ ...input, doc: mapped.doc })
                bytes += sizeOf(mapped.doc)
              }
            }
          }
          if (batch.length >= BATCH_DOCS || bytes >= BATCH_BYTES) await flush()
          job.progress(opened.consumed(), opened.size)
        }
        if (!job.signal.aborted && !stopped) await flush()
        // The reason stays in the report, which only the owner reads: a record's text never reaches
        // the jobs list (final review M6).
        if (stopped) throw Errors.conflict(`Stopped at record ${report.stoppedAt}; the report says why`)
      } catch (e) {
        threw = true
        throw e
      } finally {
        await opened?.close().catch(() => undefined)
        if (mapper) report.fields = mapper.stats()
        report.rejectedFile = rejected
          ? await rejected.finish().catch(async () => {
              await rejected!.abort()
              return false
            })
          : false
        if (rejected?.dropped) report.rejectedDropped = true
        if (!req.dryRun && (threw || stopped || job.signal.aborted)) {
          const written = report.inserted + report.upserted + report.matched
          // The writer counts straight into the report: its uncertain records move into unfinished.
          const uncertain = (report as { uncertain?: number }).uncertain ?? 0
          delete (report as { uncertain?: number }).uncertain
          report.unfinished = {
            written,
            notWritten: Math.max(0, report.read - written - report.failed - report.skipped - uncertain),
            ...(uncertain ? { uncertain } : {}),
          }
        }
        reports.save(job.id, owner, report, ctx.now() + limits.ttlMs)
        if (!req.dryRun) files.delete(owner, file.id)
        ctx.audit.append({
          action: 'transfer.import',
          outcome: threw || stopped || job.signal.aborted ? 'failure' : 'success',
          userId: owner === 'local' ? null : owner,
          username: null,
          ip: null,
          connectionId,
          namespace: `${db}.${collName}`,
          details: {
            job: job.id,
            format: req.format,
            mode: req.mode,
            dryRun: req.dryRun,
            read: report.read,
            inserted: report.inserted,
            matched: report.matched,
            modified: report.modified,
            upserted: report.upserted,
            failed: report.failed,
          },
        })
      }
    },
    // Cancel ends the write in flight too, not only the loop that sends them (final review I8).
    async cancel(job) {
      const client = await deps.client(job.target.connectionId).catch(() => null)
      if (client) await kill(client, job.comment).catch(() => 0)
      return true
    },
    recover: () => 'interrupted',
  }
}
