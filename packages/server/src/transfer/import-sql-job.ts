// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document, MongoClient } from 'mongodb'
import type { SqlImportReport, SqlImportRequest, SqlImportTableReport } from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { JobKind } from '../jobs/types'
import type { ServerContext } from '../http/context'
import type { Masker } from '../masking/match'
import { gateDepsFor } from '../masking/restricted'
import type { GateDeps } from '../masking/gate'
import { killByComment } from '../data/operations'
import { BATCH_BYTES, BATCH_DOCS, MAX_REPORT_ERRORS } from './limits'
import { checkImportPlan } from './protect'
import { openDump } from './source'
import { RejectedWriter } from './rejected'
import { TargetWriter, pathLikeField, type PendingDoc } from './target-writer'
import { readSqlDump, scanSqlDump } from './formats/sqldump'
import { isFailure } from './formats/types'

export interface SqlImportJobParams {
  owner: string
  uploadId: string
  request: SqlImportRequest
  /** Restricted callers only: the rules their writes are checked with (phase 3d-1 spec §8.2). */
  masker: Masker | null
}

const sizeOf = (doc: Document) => JSON.stringify(doc)?.length ?? 0

/**
 * User request 2026-10-10 (design §3): the
 * chosen tables of a SQL dump, each into its collection of the job's database, in one pass over the
 * file. A dump is data, never code: only its rows are read. Each table's documents go through the
 * import's own writer (batches, the restricted caller's rules, counts), as a file import's do.
 */
export function importSqlKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  ctx: () => ServerContext
  kill?: (client: MongoClient, comment: string) => Promise<number>
}): JobKind<SqlImportJobParams> {
  const kill = deps.kill ?? killByComment
  return {
    name: 'data.importSql',
    async run(job, params) {
      const ctx = deps.ctx()
      const { files, reports, limits } = ctx.transfer
      const { request: req, owner, masker } = params
      const { db, connectionId } = job.target
      const started = Date.now()
      const chosen = req.tables.filter((t) => t.include)
      const targetOf = new Map(chosen.map((t) => [t.table, t.collection]))
      const tables = new Map<string, SqlImportTableReport>(
        chosen.map((t) => [
          t.table,
          {
            table: t.table,
            collection: t.collection,
            read: 0,
            inserted: 0,
            matched: 0,
            modified: 0,
            upserted: 0,
            skipped: 0,
            failed: 0,
            ...(req.dryRun && req.mode !== 'insert' ? { wouldMatch: 0 } : {}),
          },
        ]),
      )
      const report: SqlImportReport = {
        kind: 'importSql',
        dryRun: req.dryRun,
        mode: req.mode,
        tables: [...tables.values()],
        skipped: {},
        errors: [],
        moreErrors: false,
        rejectedFile: false,
      }
      const file = files.get(owner, params.uploadId)
      if (!file || file.kind !== 'upload' || !file.complete || file.connectionId !== connectionId)
        throw Errors.notFound('The upload is gone')
      const ordered = req.onError === 'stop'
      let stopped = false
      let threw = false
      let opened: Awaited<ReturnType<typeof openDump>> | undefined
      const rejected = new RejectedWriter({
        files,
        owner,
        connectionId,
        jobId: job.id,
        format: 'sql',
        header: null,
        name: file.name,
      })
      const timeLeft = () => Math.max(1, limits.maxJobMs - (Date.now() - started))

      const fail = async (
        table: string,
        p: { n: number; raw?: string },
        reason: string,
        field?: string,
        code?: number,
      ) => {
        tables.get(table)!.failed++
        if (report.errors.length < MAX_REPORT_ERRORS)
          report.errors.push({
            table,
            record: p.n,
            reason,
            ...(field !== undefined ? { field } : {}),
            ...(code !== undefined ? { code } : {}),
          })
        else report.moreErrors = true
        await rejected.write(p)
        if (ordered && !stopped) {
          stopped = true
          report.stoppedAt = { table, record: p.n }
        }
      }
      try {
        // A first, quick pass: a pg_dump names its primary keys after its data (ALTER TABLE … ADD
        // PRIMARY KEY), which one pass would see too late. Read from the file, never the request.
        const first = await openDump(file, files, limits)
        let scan: Awaited<ReturnType<typeof scanSqlDump>>
        // Review I3: the first pass stops on a cancel and at the job's time limit, as the second does.
        const passSignal = () => AbortSignal.any([job.signal, AbortSignal.timeout(timeLeft())])
        try {
          scan = await scanSqlDump(first.bytes, {
            samples: 0,
            columnsPerTable: Infinity,
            signal: passSignal(),
          })
        } finally {
          await first.close()
        }
        if (job.signal.aborted) return
        if (Date.now() - started > limits.maxJobMs)
          throw Errors.conflict('The import ran longer than allowed')
        const primaryKeys = Object.fromEntries(scan.tables.map((t) => [t.key, t.primaryKey]))
        const client = await deps.client(connectionId)
        const gate: GateDeps | null = masker
          ? gateDepsFor(masker, client, { comment: job.comment, timeLeft })
          : null
        // Spec §8.2 (review M8): a restricted caller's tables are checked, column by column, before
        // any row is written — as a file import's mapping is before it starts.
        if (gate)
          for (const t of scan.tables) {
            const coll = targetOf.get(t.key)
            if (coll === undefined) continue
            const paths = t.columns.map((c) =>
              req.primaryKeyAsId && t.primaryKey.length === 1 && c.name === t.primaryKey[0] ? '_id' : c.name,
            )
            await checkImportPlan(
              db,
              coll,
              { paths, keys: req.mode === 'insert' ? [] : ['_id'], mode: req.mode },
              gate,
            )
          }
        opened = await openDump(file, files, limits)
        // One writer and one batch a table: its counts go straight into the table's report.
        const writers = new Map<string, TargetWriter>()
        const batches = new Map<string, { docs: PendingDoc[]; bytes: number }>()
        const writerOf = (table: string) => {
          let writer = writers.get(table)
          if (!writer) {
            const coll = targetOf.get(table)!
            writer = new TargetWriter({
              collection: client.db(db).collection(coll),
              targetDb: client.db(db),
              db,
              coll,
              mode: req.mode,
              keys: ['_id'],
              updateOnly: false,
              ordered,
              gate,
              codeOnly: masker !== null,
              comment: job.comment,
              timeLeft,
              signal: job.signal,
              counts: tables.get(table)!,
              fail: (p, reason, field, code) => fail(table, p, reason, field, code),
              stopped: () => stopped,
            })
            writers.set(table, writer)
          }
          return writer
        }
        const flush = async (table: string) => {
          const batch = batches.get(table)
          if (!batch?.docs.length) return
          batches.set(table, { docs: [], bytes: 0 })
          const writer = writerOf(table)
          if (!req.dryRun) await writer.write(batch.docs)
          else if (req.mode !== 'insert') {
            const counts = tables.get(table)!
            counts.wouldMatch = (counts.wouldMatch ?? 0) + (await writer.wouldMatch(batch.docs))
          }
        }
        const flushAll = async () => {
          for (const table of batches.keys()) await flush(table)
        }

        let lastTable: string | undefined
        for await (const { table, record } of readSqlDump(opened.bytes, {
          tables: new Set(targetOf.keys()),
          primaryKeyAsId: req.primaryKeyAsId,
          primaryKeys,
          skipped: report.skipped,
          signal: passSignal(),
        })) {
          if (job.signal.aborted || stopped) break
          if (Date.now() - started > limits.maxJobMs)
            throw Errors.conflict('The import ran longer than allowed')
          // The dump itself failed (it ends inside a text, a COPY never ends…): said, and the end.
          if (table === '') {
            if (isFailure(record)) report.dumpError = record.error.slice(0, 500)
            if (ordered) {
              stopped = true
              report.stoppedAt = { table: '', record: 0 }
            }
            continue
          }
          const counts = tables.get(table)
          if (!counts) continue
          // Review I2: with "stop", rows are written in the dump's order: what another table read
          // before this row is written first, and nothing after a failure is.
          if (ordered && lastTable !== undefined && lastTable !== table) {
            await flush(lastTable)
            if (stopped) break
          }
          lastTable = table
          counts.read++
          if (isFailure(record)) {
            // With "stop", what was read before is written first (as a file import does).
            if (ordered) await flushAll()
            if (!stopped) await fail(table, record, record.error)
          } else {
            const pathLike = req.mode === 'merge' ? pathLikeField(record.doc) : undefined
            if (req.mode !== 'insert' && record.doc._id === undefined) {
              if (ordered) await flushAll()
              if (!stopped) await fail(table, record, 'The row has no primary key to match on', '_id')
            } else if (pathLike !== undefined) {
              if (ordered) await flushAll()
              if (!stopped)
                await fail(
                  table,
                  record,
                  'A merge cannot set a field whose name holds "." or starts with "$"; use upsert',
                  pathLike.slice(0, 200),
                )
            } else {
              const batch = batches.get(table) ?? { docs: [], bytes: 0 }
              batch.docs.push({ n: record.n, raw: record.raw, doc: record.doc })
              batch.bytes += sizeOf(record.doc)
              batches.set(table, batch)
              if (batch.docs.length >= BATCH_DOCS || batch.bytes >= BATCH_BYTES) await flush(table)
            }
          }
          job.progress(opened.consumed(), file.size)
        }
        if (!job.signal.aborted && !stopped) await flushAll()
        if (Date.now() - started > limits.maxJobMs)
          throw Errors.conflict('The import ran longer than allowed')
        if (stopped && !report.stoppedAt!.table)
          throw Errors.conflict('The dump could not be read to its end; the report says why')
        // Review M14: what was read is kept, but a dump cut short is not a finished import.
        if (report.dumpError && !stopped)
          throw Errors.conflict('The dump could not be read to its end; the report says why')
        if (stopped)
          throw Errors.conflict(
            `Stopped at row ${report.stoppedAt!.record} of ${report.stoppedAt!.table}; the report says why`,
          )
      } catch (e) {
        threw = true
        throw e
      } finally {
        await opened?.close().catch(() => undefined)
        report.tables = [...tables.values()]
        report.rejectedFile = await rejected.finish().catch(async () => {
          await rejected.abort()
          return false
        })
        if (rejected.dropped) report.rejectedDropped = true
        if (!req.dryRun && (threw || stopped || job.signal.aborted)) {
          const sum = (f: (t: SqlImportTableReport) => number) => report.tables.reduce((n, t) => n + f(t), 0)
          const written = sum((t) => t.inserted + t.upserted + t.matched)
          // The writers count into the tables' reports: their uncertain records (review I4).
          const uncertain = sum((t) => (t as { uncertain?: number }).uncertain ?? 0)
          report.unfinished = {
            written,
            notWritten: Math.max(0, sum((t) => t.read - t.failed - t.skipped) - written - uncertain),
            ...(uncertain ? { uncertain } : {}),
          }
        }
        for (const t of report.tables) delete (t as { uncertain?: number }).uncertain
        reports.save(job.id, owner, report, ctx.now() + limits.ttlMs)
        if (!req.dryRun) files.delete(owner, file.id)
        const total = (k: keyof SqlImportTableReport) =>
          report.tables.reduce((n, t) => n + (typeof t[k] === 'number' ? (t[k] as number) : 0), 0)
        ctx.audit.append({
          action: 'transfer.importSql',
          outcome: threw || stopped || job.signal.aborted ? 'failure' : 'success',
          userId: owner === 'local' ? null : owner,
          username: null,
          ip: null,
          connectionId,
          namespace: db,
          details: {
            job: job.id,
            mode: req.mode,
            dryRun: req.dryRun,
            tables: report.tables.map((t) => `${t.table}→${t.collection}`).slice(0, 100),
            read: total('read'),
            inserted: total('inserted'),
            upserted: total('upserted'),
            modified: total('modified'),
            failed: total('failed'),
          },
        })
      }
    },
    async cancel(job) {
      const client = await deps.client(job.target.connectionId).catch(() => null)
      if (client) await kill(client, job.comment).catch(() => 0)
      return true
    },
    recover: () => 'interrupted',
  }
}
