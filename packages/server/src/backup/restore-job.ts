// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { AgentVia } from '../ai/agent/calls'
import { randomBytes } from 'node:crypto'
import { BSON, EJSON, type Document } from 'bson'
import type { Db, MongoClient } from 'mongodb'
import {
  findServerJs,
  type RestoreNamespaceReport,
  type RestoreReport,
  type RestoreStart,
  type RowError,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { serverCode, serverText } from '../data/mongo-errors'
import type { JobKind } from '../jobs/types'
import { PartTracker } from '../jobs/parts'
import type { ServerContext } from '../http/context'
import { killByComment } from '../data/operations'
import { RESTORE_STAGING } from '../jobs/duplicate'
import { gateDepsFor } from '../masking/restricted'
import type { GateDeps } from '../masking/gate/context'
import {
  guardIndexBuild,
  guardIndexesReadable,
  guardInsert,
  guardValidator,
  guardViewSource,
  isIndexesRefusal,
} from '../masking/gate'
import { TargetWriter, type PendingDoc, type WriteCounts } from '../transfer/target-writer'
import { RejectedWriter } from '../transfer/rejected'
import { viewOrder } from '../transfer/collection-spec'
import { BATCH_BYTES, BATCH_DOCS, MAX_REPORT_ERRORS } from '../transfer/limits'
import { fileBytes, openArchive } from './pipeline'
import { slotKeysFor } from './keys/slot-keys'
import { spawnTool, toolFailure, withToolConfig } from './tools'
import type { ExpiryRule, PreparedRestore, RestorePair } from './restore-plan'
import { knownVersion, seriesAccess, serverVersionOf } from './series'

export { RESTORE_STAGING }

/** Jobs swapping their staged collections in: past that point a cancel no longer applies. */
const swapping = new Set<string>()

export interface RestoreJobParams {
  owner: string
  request: Omit<RestoreStart, 'password' | 'kit'>
  /** In memory only (see DumpJobParams). */
  password: string | null
  /** Phase 3d-3c, in memory only: a recovery kit's key given with the restore; wiped when the job ends. */
  kit: Buffer | null
  prepared: PreparedRestore
  /** Review of B6 (M1): the agent's turn the restore was started for (its end's row names it). */
  agent?: AgentVia | null
}

const stagingName = () => `mm_restore_${randomBytes(8).toString('hex')}`

/** Spec §5.3: what mongorestore restores and where; replace targets go to staging (never --drop). */
export function restoreToolArgs(
  pairs: Array<Pick<RestorePair, 'from' | 'to' | 'action'> & { meta?: Pick<RestorePair['meta'], 'type'> }>,
  staging: Map<string, string>,
  opts: { gzip: boolean; indexes: boolean; options: boolean; stopOnError: boolean; dryRun: boolean },
): string[] {
  const args = ['--archive', ...(opts.gzip ? ['--gzip'] : [])]
  for (const p of pairs) {
    const to = staging.get(`${p.to.db}.${p.to.coll}`) ?? p.to.coll
    args.push(
      `--nsInclude=${p.from.db}.${p.from.coll}`,
      `--nsFrom=${p.from.db}.${p.from.coll}`,
      `--nsTo=${p.to.db}.${to}`,
    )
    // Review of d7ddbaae: an archive of 6.0 to 8.2 keeps a series' buckets under system.buckets,
    // which the series' own rename does not reach: they went to the source's namespace on the
    // target, and mongorestore said it succeeded. They are renamed with it (a series is never
    // staged: timeseries_replace). From 8.3 the buckets are under the series' name, and this
    // names nothing in the archive.
    if (p.meta?.type === 'timeseries')
      args.push(
        `--nsFrom=${p.from.db}.system.buckets.${p.from.coll}`,
        `--nsTo=${p.to.db}.system.buckets.${p.to.coll}`,
      )
  }
  if (!opts.indexes) args.push('--noIndexRestore')
  if (!opts.options) args.push('--noOptionsRestore')
  if (opts.stopOnError) args.push('--stopOnError')
  if (opts.dryRun) args.push('--dryRun')
  return args
}
// Values stay as they were stored: no promotion of longs, binaries or regular expressions.
const DESER = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true } as const

interface Live {
  pair: RestorePair
  out: RestoreNamespaceReport
  writer: TargetWriter
  mode: 'insert' | 'upsert'
  into: string
  batch: PendingDoc[]
  bytes: number
  counts: WriteCounts
  /** The records of the batch being written that were not: refused, or already there. */
  unwritten: Set<PendingDoc>
  /** Records a refused document (or, in a dry run, one that would be refused). */
  fail: (doc: PendingDoc, reason: string, field?: string, code?: number) => Promise<void>
}

/** At most this much of a batch is sent in one count (a command holds at most 16 MiB). */
const EXPIRY_CHUNK_BYTES = 8 * 1024 * 1024

/**
 * Backup review M10, M2, M3: of these records, how many an age rule deletes as soon as they are
 * written. The server decides, as its TTL monitor does: the earliest date of an array, a path
 * through sub-documents, a partial filter, only dates.
 */
export async function countExpiring(
  db: Db,
  docs: Document[],
  rules: ExpiryRule[],
  now: number,
  options: { comment: string; maxTimeMS: number },
): Promise<number> {
  if (!rules.length || !docs.length) return 0
  const match = {
    $or: rules.map((r) => {
      const old = { [r.field]: { $lt: new Date(now - r.ms) } }
      return r.partial ? { $and: [r.partial, old] } : old
    }),
  }
  let n = 0
  let chunk: Document[] = []
  let bytes = 0
  const count = async () => {
    if (!chunk.length) return
    const [row] = await db
      .aggregate([{ $documents: { $literal: chunk } }, { $match: match }, { $count: 'n' }], options)
      .toArray()
    n += Number(row?.n ?? 0)
    chunk = []
    bytes = 0
  }
  for (const d of docs) {
    const size = BSON.calculateObjectSize(d)
    if (bytes + size > EXPIRY_CHUNK_BYTES) await count()
    chunk.push(d)
    bytes += size
  }
  await count()
  return n
}

/** Phase 3d-3a spec §5.2: the built-in restore. */
export function restoreKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  ctx: () => ServerContext
  kill?: (client: MongoClient, comment: string) => Promise<number>
}): JobKind<RestoreJobParams> {
  const kill = deps.kill ?? killByComment
  return {
    name: 'backup.restore',
    async run(job, p) {
      const ctx = deps.ctx()
      const { limits } = ctx.backup
      const started = ctx.now()
      const timeLeft = () => Math.max(1, limits.maxJobMs - (ctx.now() - started))
      const { prepared, request: r } = p
      const client = prepared.client
      const targetId = job.target.connectionId
      // Restricted on the target: each namespace is gated by its own lookups (gateOf; nit).
      const gate = prepared.targetMasker !== null
      // Seventeenth review of explain masking (nit): each namespace's own lookups, so a restore of many
      // collections is not refused as one query too complex.
      const gates = new Map<string, GateDeps>()
      const gateOf = (db: string, coll: string): GateDeps => {
        let g = gates.get(`${db}.${coll}`)
        if (!g)
          gates.set(
            `${db}.${coll}`,
            (g = gateDepsFor(prepared.targetMasker!, client, { comment: job.comment, timeLeft })),
          )
        return g
      }
      // Where a time series' buckets are written on the target (series.ts): read once, if any.
      const series = prepared.pairs.some((x) => x.meta.type === 'timeseries' && !x.skipped)
      const targetVersion = series ? await serverVersionOf(client) : null
      // Review of the CI fixes (minor 4): never a guess at where the target keeps a series' buckets.
      if (series && !knownVersion(targetVersion))
        throw Errors.conflict('The target does not say its version, so a time series cannot be written', {
          reason: 'series_version',
        })
      const report: RestoreReport = {
        kind: 'restore',
        dryRun: r.dryRun,
        mode: r.mode,
        engine: r.engine,
        source: { kind: r.source.kind, name: prepared.row.name },
        namespaces: [],
        views: [],
        rejectedFile: false,
        masked: Boolean(
          prepared.plan.summary.mongoManager?.masked || prepared.plan.summary.mongoManager?.anonymous,
        ),
        rulesAdded: prepared.addRules.length,
        versions: prepared.versions,
        restricted: { target: prepared.targetMasker !== null },
      }
      const rejected = new RejectedWriter({
        files: ctx.transfer.files,
        owner: p.owner,
        connectionId: targetId,
        jobId: job.id,
        format: 'ndjson',
        header: null,
        name: `${prepared.row.name}-restore`,
      })
      const byData = new Map<string, Live>()
      const staged: Array<{ db: string; name: string }> = []
      /** A staged copy took its target's place: what the tools wrote stays, in part. */
      let swappedAny = false
      // W4.4 (3d-3a U8): progress per target namespace, and the phases after the documents.
      const parts = new PartTracker((v) => job.setParts(v))
      const toName = (x: { to: { db: string; coll: string } }) => `${x.to.db}.${x.to.coll}`
      parts.start(prepared.pairs.filter((x) => !x.skipped && x.meta.type !== 'view').map(toName), 'restore')
      // A restricted caller's gate was built from the rules the plan saw (3d-2 spec §5.2).
      const assertRules = () => {
        if (gate && ctx.personalFields.get(targetId).version !== prepared.versions.target)
          throw Errors.conflict('The personal-field rules changed; start the restore again', {
            reason: 'rules_changed',
          })
      }
      /** Spec §5.3: mongorestore reads the archive from stdin; replace targets go to staging first. */
      const viaTools = async () => {
        const found = prepared.found
        const record = ctx.connections.get(targetId)
        if (!found || !record)
          throw Errors.conflict('The backup tools are not available', { reason: 'tools_unavailable' })
        const release = ctx.backup.tools.acquire()
        const live = prepared.pairs.filter((x) => !x.skipped)
        const staging = new Map<string, string>()
        if (!r.dryRun)
          for (const x of live.filter((x) => x.action === 'replace')) {
            const name = stagingName()
            staging.set(`${x.to.db}.${x.to.coll}`, name)
            staged.push({ db: x.to.db, name })
            job.setStaging(name, { connectionId: targetId, db: x.to.db })
          }
        const log: string[] = []
        try {
          const code = await withToolConfig(
            record.settings,
            async (configArgs) => {
              const { stdout, exit } = spawnTool(
                found.restore,
                [
                  ...configArgs,
                  ...restoreToolArgs(live, staging, {
                    gzip: prepared.container === 'gzip',
                    indexes: r.indexes,
                    options: r.options,
                    stopOnError: r.onError === 'stop',
                    dryRun: r.dryRun,
                  }),
                ],
                {
                  stdin: fileBytes(ctx.backup.store, prepared.row, {
                    follow: 'complete',
                    signal: job.signal,
                  }),
                  signal: job.signal,
                  timeoutMs: timeLeft(),
                  ...(ctx.backup.spawnImpl ? { spawnImpl: ctx.backup.spawnImpl } : {}),
                  onLine: (line) => {
                    log.push(line)
                    if (log.length > 50) log.shift()
                    // "2 document(s) restored successfully. 0 document(s) failed to restore."
                    const m = /(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed/.exec(
                      line,
                    )
                    if (m)
                      report.namespaces = [
                        {
                          from: '*',
                          to: '*',
                          type: 'collection',
                          read: Number(m[1]) + Number(m[2]),
                          inserted: Number(m[1]),
                          matched: 0,
                          modified: 0,
                          upserted: 0,
                          skipped: 0,
                          failed: Number(m[2]),
                          errors: [],
                          moreErrors: false,
                          indexes: { built: [], skipped: [] },
                          crc: 'ok',
                        },
                      ]
                  },
                },
              )
              stdout.resume()
              return exit
            },
            ctx.backup.toolsTmp,
          )
          report.toolLog = log
          if (job.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
          if (code !== 0)
            throw Errors.conflict(`mongorestore failed (exit ${code}): ${toolFailure(log)}`, {
              reason: 'tool_failed',
            })
          // Swapped in only after the tool succeeded: a failure leaves each target as it was.
          swapping.add(job.id)
          for (const [ns, name] of staging) {
            const db = ns.slice(0, ns.indexOf('.'))
            await client
              .db(db)
              .collection(name)
              .rename(ns.slice(db.length + 1), { dropTarget: true, comment: job.comment } as never)
            swappedAny = true
            staged.splice(
              staged.findIndex((s) => s.name === name),
              1,
            )
            job.setStaging(null)
          }
        } finally {
          release()
        }
      }
      let ok = false
      try {
        if (r.engine === 'tools') {
          // mongorestore tells its totals only at the end: every namespace runs until then.
          for (const x of prepared.pairs.filter((x) => !x.skipped && x.meta.type !== 'view'))
            parts.update(toName(x), { state: 'running' })
          await viaTools()
          for (const x of prepared.pairs.filter((x) => !x.skipped && x.meta.type !== 'view'))
            parts.update(toName(x), { state: 'done' })
          ok = true
          return
        }
        // Every pair's validator and indexes checked before anything is made for any (reviews of the
        // agent's gate, M-4, M-3), in a dry run too (they only read): a refusal stops the restore with
        // nothing made. A namespace the gate refuses whole (system.*) is left, for its indexes, to its
        // records' refusals; a validator refused there stops the restore, as it did before.
        if (gate)
          for (const pair of prepared.pairs.filter((x) => !x.skipped && x.meta.type !== 'view')) {
            const made = pair.action === 'replace' || !pair.exists
            const options = pair.create && 'options' in pair.create ? pair.create.options : {}
            const g = gateOf(pair.to.db, pair.to.coll)
            if (made && options.validator)
              await guardValidator(pair.to.db, pair.to.coll, options.validator as Document, g)
            try {
              await guardIndexesReadable(pair.to.db, pair.to.coll, g)
            } catch (e) {
              if (isIndexesRefusal(e) || !(e instanceof AppError)) throw e
            }
          }
        // Targets (or staging collections) exist before any document arrives.
        for (const pair of prepared.pairs.filter((x) => !x.skipped && x.meta.type !== 'view')) {
          const out: RestoreNamespaceReport = {
            from: `${pair.from.db}.${pair.from.coll}`,
            to: `${pair.to.db}.${pair.to.coll}`,
            type: pair.meta.type,
            read: 0,
            inserted: 0,
            matched: 0,
            modified: 0,
            upserted: 0,
            skipped: 0,
            failed: 0,
            errors: [],
            moreErrors: false,
            indexes: { built: [], skipped: [...(pair.indexes?.skipped ?? [])] },
            crc: 'absent',
          }
          report.namespaces.push(out)
          const db = client.db(pair.to.db)
          let into = pair.to.coll
          const options = pair.create && 'options' in pair.create ? pair.create.options : {}
          if (!r.dryRun && (pair.action === 'replace' || !pair.exists)) {
            if (pair.action === 'replace') {
              // Written aside, then swapped in: a failure leaves the target as it was.
              into = stagingName()
              staged.push({ db: pair.to.db, name: into })
              job.setStaging(into, { connectionId: targetId, db: pair.to.db })
            }
            await db.createCollection(into, { ...options, comment: job.comment } as never)
          }
          const data =
            pair.meta.type === 'timeseries' ? seriesAccess(into, targetVersion) : { coll: into, options: {} }
          const dataColl = data.coll
          const counts: WriteCounts = { inserted: 0, matched: 0, modified: 0, upserted: 0, skipped: 0 }
          const unwritten = new Set<PendingDoc>()
          const fail = async (doc: PendingDoc, reason: string, field?: string, code?: number) => {
            unwritten.add(doc)
            out.failed++
            if (out.errors.length < MAX_REPORT_ERRORS) {
              const error: RowError = { record: doc.n, reason }
              if (field !== undefined) error.field = field
              if (code !== undefined) error.code = code
              out.errors.push(error)
            } else out.moreErrors = true
            if (!r.dryRun) await rejected.write({ raw: EJSON.stringify(doc.doc, { relaxed: false }) })
            // A dry run predicts every refusal; it never stops at the first.
            if (r.onError === 'stop' && !r.dryRun)
              throw Errors.conflict('A document was refused; the restore stopped', { reason: 'stopped' })
          }
          // Buckets are written as they are; a new or staged collection takes plain inserts.
          const mode = pair.meta.type !== 'timeseries' && pair.action === 'upsert' ? 'upsert' : 'insert'
          const writer = new TargetWriter({
            collection: db.collection(dataColl),
            // Final review of explain masking (Minor 4): an upsert into a series is refused as there.
            targetDb: db,
            rawData: data.options.rawData === true,
            db: pair.to.db,
            coll: dataColl,
            mode,
            keys: r.keys,
            updateOnly: false,
            ordered: r.onError === 'stop',
            // A backed-up document whose _id is null comes back with it (data review round 2).
            keepNullIds: true,
            // A restore run again meets what it wrote: already there, not failed (backup review M9).
            identicalIsDone: true,
            onAlreadyThere: (p) => unwritten.add(p),
            // The plan skips a time series a restricted caller would write (its buckets pass no gate).
            gate: gate ? gateOf(pair.to.db, pair.to.coll) : null,
            codeOnly: gate,
            comment: job.comment,
            timeLeft,
            signal: job.signal,
            counts,
            fail,
            stopped: () => job.signal.aborted,
          })
          byData.set(`${pair.from.db}.${pair.dataFrom}`, {
            pair,
            out,
            writer,
            mode,
            into,
            batch: [],
            bytes: 0,
            counts,
            unwritten,
            fail,
          })
        }
        /**
         * Final review I7: a dry run predicts what the target would refuse — an _id already there (add
         * mode), the validator (evaluated by the server on the documents, nothing written), and for a
         * restricted caller a personal value. Unique indexes other than _id are left to the real run.
         */
        const idKey = (v: unknown) => EJSON.stringify({ v } as Document, { relaxed: false })
        const predict = async (l: Live, batch: PendingDoc[]) => {
          let taken = batch
          if (l.pair.meta.type === 'timeseries') return
          const db = client.db(l.pair.to.db)
          const opts = { comment: job.comment, maxTimeMS: timeLeft() }
          let rest = taken
          // Nineteenth review of explain masking (M-4): a record whose key matches is replaced, its
          // stored personal values kept as the run keeps them; only the others are inserted.
          let replaced = new Set<PendingDoc>()
          if (l.mode === 'upsert') {
            l.out.wouldMatch = (l.out.wouldMatch ?? 0) + (await l.writer.wouldMatch(taken))
            // A cancel stops the prediction too (nineteenth and twentieth reviews, nit, M-2).
            if (job.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
            // A record refused there (its empty key, the gate, MongoDB, several matches) is refused
            // once (data review round 2, Minor 1; eighteenth review of explain masking, M-1).
            rest = taken.filter((p) => !l.writer.dryRefused.has(p))
            replaced = l.writer.dryMatched
          } else if (l.pair.exists && l.pair.action !== 'replace') {
            // Backup review I2: a document stored as the backup has it is already there, as the real
            // run counts it — for a restricted caller only a record the gate lets through, as there.
            const allowed: PendingDoc[] = []
            for (const p of taken)
              if (!gate) allowed.push(p)
              else
                try {
                  await guardInsert(
                    l.pair.to.db,
                    l.pair.to.coll,
                    [p.doc],
                    gateOf(l.pair.to.db, l.pair.to.coll),
                  )
                  allowed.push(p)
                } catch (e) {
                  if (!(e instanceof AppError) || isIndexesRefusal(e)) throw e
                }
            const same = await l.writer.identical(allowed)
            taken = taken.filter((p) => !same.has(p))
            const ids = taken.map((p) => p.doc._id).filter((v) => v !== undefined)
            const there = new Set(
              (
                await db
                  .collection(l.pair.to.coll)
                  .find({ _id: { $in: ids } }, { ...opts, projection: { _id: 1 }, promoteValues: false })
                  .toArray()
              ).map((d) => idKey(d._id)),
            )
            rest = []
            for (const p of taken)
              if (p.doc._id !== undefined && there.has(idKey(p.doc._id)))
                await l.fail(p, 'A document with this _id is already there', '_id', 11000)
              else rest.push(p)
          }
          if (l.pair.validator && rest.length) {
            const refused = new Set(
              (
                await db
                  .aggregate(
                    [
                      { $documents: rest.map((p) => p.doc) },
                      { $match: { $nor: [l.pair.validator] } },
                      { $project: { _id: 1 } },
                    ],
                    { ...opts, promoteValues: false },
                  )
                  .toArray()
              ).map((d) => idKey(d._id)),
            )
            const passed: PendingDoc[] = []
            for (const p of rest)
              if (refused.has(idKey(p.doc._id)))
                await l.fail(p, "It does not pass the target's validator", undefined, 121)
              else passed.push(p)
            rest = passed
          }
          if (gate)
            for (const p of rest)
              try {
                if (replaced.has(p)) continue
                await guardInsert(l.pair.to.db, l.pair.to.coll, [p.doc], gateOf(l.pair.to.db, l.pair.to.coll))
              } catch (e) {
                if (!(e instanceof AppError) || isIndexesRefusal(e)) throw e
                await l.fail(p, e.message.slice(0, 300))
              }
        }
        let serverOffset: Promise<number> | undefined
        /** What the run wrote, into its report. */
        const reportCounts = (l: Live) =>
          Object.assign(l.out, {
            inserted: l.counts.inserted,
            matched: l.counts.matched,
            modified: l.counts.modified,
            upserted: l.counts.upserted,
            skipped: l.counts.skipped,
            ...(l.counts.alreadyThere ? { alreadyThere: l.counts.alreadyThere } : {}),
          })
        const flush = async (l: Live) => {
          const taken = l.batch
          l.batch = []
          l.bytes = 0
          if (!taken.length) return
          if (r.dryRun) await predict(l, taken)
          else {
            assertRules()
            // What was written is reported though a refusal stops the job mid-batch (next review, M-5);
            // a staged copy dropped when the job fails reports none (next round, M-1).
            try {
              await l.writer.write(taken)
            } finally {
              reportCounts(l)
            }
          }
          // Backup review M10: of what is (or would be) written, what an age rule deletes at once.
          const written = taken.filter((p) => !l.unwritten.has(p)).map((p) => p.doc)
          l.unwritten.clear()
          if (l.pair.expiry.length && written.length) {
            // The server's clock decides, as its TTL monitor runs by it: read once, then followed.
            serverOffset ??= client
              .db('admin')
              .command({ hello: 1 })
              .then((h): number => (h.localTime instanceof Date ? h.localTime.getTime() - Date.now() : 0))
            const offset = await serverOffset
            const n = await countExpiring(
              client.db(l.pair.to.db),
              written,
              l.pair.expiry,
              Date.now() + offset,
              {
                comment: job.comment,
                maxTimeMS: timeLeft(),
              },
            )
            if (n) l.out.expiring = (l.out.expiring ?? 0) + n
          }
          if (r.dryRun) {
            if (l.counts.alreadyThere)
              Object.assign(l.out, { skipped: l.counts.skipped, alreadyThere: l.counts.alreadyThere })
            return
          }
          reportCounts(l)
        }
        // Final review minor 3: progress in bytes of the stored file (a gzip or .mmbak file is
        // smaller than what it holds); a directory zip, read entry by entry, counts its documents.
        let fileRead = 0
        const { events } = await openArchive(ctx.backup.store, prepared.row, {
          ...(p.password !== null ? { password: p.password } : {}),
          keys: slotKeysFor(ctx, p.owner, p.kit),
          signal: job.signal,
          follow: 'complete',
          onFileBytes: (n) => (fileRead += n),
        })
        let read = 0
        const total = prepared.row.size
        for await (const e of events) {
          if (job.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
          if (ctx.now() - started > limits.maxJobMs)
            throw Errors.conflict('The restore ran longer than allowed')
          if (e.kind === 'doc') {
            const l = byData.get(`${e.db}.${e.coll}`)
            if (!l) continue
            l.out.read++
            read += e.raw.length
            l.batch.push({ n: l.out.read, doc: BSON.deserialize(e.raw, DESER) })
            l.bytes += e.raw.length
            if (l.batch.length >= BATCH_DOCS || l.bytes >= BATCH_BYTES) await flush(l)
            if (l.out.read === 1) parts.update(toName(l.pair), { state: 'running' })
            if (l.out.read % 1000 === 0) {
              job.progress(Math.min(total, prepared.container === 'directory' ? read : fileRead), total)
              parts.update(toName(l.pair), { done: l.out.read })
            }
          } else if (e.kind === 'end') {
            const l = byData.get(`${e.db}.${e.coll}`)
            if (!l) continue
            l.out.crc = e.crc
            if (e.crc === 'mismatch')
              throw Errors.badFile(
                `The backup is damaged: the checksum of ${e.db}.${e.coll} does not match`,
                {
                  reason: 'crc',
                },
              )
            await flush(l)
            parts.update(toName(l.pair), { state: 'done', done: l.out.read })
          }
        }
        if (job.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
        // Namespaces without an end (a directory zip) are flushed here.
        for (const l of byData.values()) {
          await flush(l)
          parts.update(toName(l.pair), { state: l.out.failed ? 'failed' : 'done', done: l.out.read })
        }
        if (!r.dryRun) {
          parts.phase('indexes')
          // Final review I3: all or nothing. Every namespace is checked first, then every index is
          // built on its staging collection, and only then are the replaced targets swapped in.
          for (const { out, counts } of byData.values()) {
            // Every document read was written or refused, or the targets are left as they were.
            const done = counts.inserted + counts.matched + counts.upserted + counts.skipped + out.failed
            if (done !== out.read)
              throw Errors.conflict(
                `The restore of ${out.to} is incomplete; the targets were left as they were`,
                {
                  reason: 'incomplete',
                },
              )
          }
          // Backup review I4: a capped collection drops its oldest documents past its cap. What
          // replaces a target holds every document written, or no target is replaced.
          for (const l of byData.values()) {
            const options = l.pair.create && 'options' in l.pair.create ? l.pair.create.options : null
            if (l.pair.action !== 'replace' || !options?.capped) continue
            const held = await client
              .db(l.pair.to.db)
              .collection(l.into)
              .countDocuments({}, { comment: job.comment, maxTimeMS: timeLeft() })
            if (held < l.counts.inserted)
              throw Errors.conflict(
                `${l.out.to} is capped: it kept ${held} of the ${l.counts.inserted} documents written; ` +
                  "restore it with the backup's options. The targets were left as they were",
                { reason: 'capped' },
              )
          }
          for (const l of byData.values()) {
            const { pair, out } = l
            // The backup's indexes, and a replaced target's own when the backup's are not restored.
            const kept = new Set(pair.kept?.build ?? [])
            for (const spec of [...(pair.indexes?.build ?? []), ...kept]) {
              if (job.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
              const { key, ...options } = spec
              try {
                if (gate)
                  await guardIndexBuild(
                    pair.to.db,
                    pair.to.coll,
                    key as Document,
                    options as never,
                    gateOf(pair.to.db, pair.to.coll),
                  )
                await client
                  .db(pair.to.db)
                  .collection(l.into)
                  .createIndex(
                    key as Document,
                    { ...options, comment: job.comment, maxTimeMS: timeLeft() } as never,
                  )
                out.indexes.built.push(String(spec.name))
              } catch (err) {
                // The server's own words and code, from under the driver's wrapper (first independent
                // review, Minor 5; second, Minor 1).
                // Review M4: the target keeps its own indexes, or it is not replaced (a unique one
                // the backup's documents break, say).
                if (kept.has(spec))
                  throw Errors.conflict(
                    `${out.to} could not keep its own index ${String(spec.name)}` +
                      (err instanceof AppError || !gate ? ` (${serverText(err).slice(0, 200)})` : '') +
                      '; the targets were left as they were',
                    { reason: 'kept_index' },
                  )
                out.indexes.skipped.push({
                  name: String(spec.name),
                  reason:
                    err instanceof AppError || !gate
                      ? serverText(err).slice(0, 300)
                      : `Index build refused (code ${String(serverCode(err) ?? 'unknown')})`,
                })
              }
            }
          }
          if (job.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
          // From here a cancel no longer applies: the swap is short and is not stopped halfway.
          swapping.add(job.id)
          const replaced: string[] = []
          for (const l of byData.values()) {
            const { pair } = l
            if (pair.action !== 'replace') continue
            try {
              await client
                .db(pair.to.db)
                .collection(l.into)
                .rename(pair.to.coll, { dropTarget: true, comment: job.comment } as never)
            } catch (err) {
              // The server's own words, from under the driver's wrapper (third independent review,
              // Minor 1), or its code alone for a restorer restricted on the target, who may replace
              // a namespace no rule covers (final review, Minor 1), as for an index it could not keep.
              const why =
                err instanceof AppError || !gate
                  ? serverText(err).slice(0, 200)
                  : `code ${String(serverCode(err) ?? 'unknown')}`
              throw Errors.conflict(
                `${pair.to.db}.${pair.to.coll} could not be put in place (${why})` +
                  (replaced.length
                    ? `; already replaced: ${replaced.join(', ')}`
                    : '; no target was changed'),
                { reason: 'swap', replaced },
              )
            }
            replaced.push(`${pair.to.db}.${pair.to.coll}`)
            staged.splice(
              staged.findIndex((x) => x.name === l.into),
              1,
            )
            job.setStaging(null)
          }
          // Views last, in dependency order, through the 3c view guard for a restricted caller.
          parts.phase('views')
          const { ordered, cyclic } = viewOrder(prepared.views.map((v) => ({ ...v.def })))
          for (const v of ordered) {
            const pair = prepared.views.find((x) => x.def.name === v.name)!.pair
            try {
              if (findServerJs(v.pipeline) && !ctx.config.allowServerJs)
                throw new Error('Its pipeline runs JavaScript on the server')
              if (gate) await guardViewSource(pair.to.db, v.viewOn, v.pipeline, gateOf(pair.to.db, v.name))
              await client.db(pair.to.db).createCollection(v.name, {
                viewOn: v.viewOn,
                pipeline: v.pipeline,
                comment: job.comment,
              } as never)
              report.views.push({ name: `${pair.to.db}.${v.name}`, created: true })
            } catch (err) {
              // The server's own, from under the driver's wrapper (second independent review, Minor 1).
              const code = serverCode(err)
              report.views.push({
                name: `${pair.to.db}.${v.name}`,
                created: false,
                reason:
                  gate && !(err instanceof AppError) && code !== undefined
                    ? `View creation refused (code ${String(code)})`
                    : serverText(err).slice(0, 300),
              })
            }
          }
          for (const name of cyclic)
            report.views.push({
              name,
              created: false,
              reason: 'Its definition reads itself through other views',
            })
        }
        report.rejectedFile = !r.dryRun && (await rejected.finish())
        ok = true
      } finally {
        p.kit?.fill(0)
        swapping.delete(job.id)
        if (!ok) await rejected.abort().catch(() => undefined)
        // What went into a staged copy dropped here was not written (next round, M-1).
        if (!ok)
          for (const l of byData.values())
            if (staged.some((s) => s.db === l.pair.to.db && s.name === l.into)) {
              Object.assign(l.out, { inserted: 0, matched: 0, modified: 0, upserted: 0, skipped: 0 })
              delete l.out.alreadyThere
              delete l.out.expiring
              // Nor the indexes built on it (nit).
              l.out.indexes.built = []
            }
        // Nor what the tools wrote into staged copies dropped here (M-2): only where every target was
        // staged and none swapped in yet; otherwise their total stays, what of it stays unknown.
        const allStaged = prepared.pairs
          .filter((x) => !x.skipped && x.meta.type !== 'view')
          .every((x) => x.action === 'replace')
        if (!ok && staged.length && allStaged && !swappedAny)
          for (const n of report.namespaces)
            if (n.from === '*') Object.assign(n, { inserted: 0, matched: 0, modified: 0, upserted: 0 })
        for (const s of staged)
          await client
            .db(s.db)
            .collection(s.name)
            .drop()
            .then(
              () => job.setStaging(null),
              () => undefined,
            )
        ctx.transfer.reports.save(job.id, p.owner, report, ctx.now() + limits.ttlMs)
        ctx.audit.append({
          action: 'backup.restore',
          outcome: ok ? 'success' : 'failure',
          userId: p.owner === 'local' ? null : p.owner,
          username: null,
          ip: null,
          connectionId: targetId,
          namespace: null,
          details: {
            ...(p.agent ? { agent: { ...p.agent } } : {}),
            job: job.id,
            mode: r.mode,
            engine: r.engine,
            dryRun: r.dryRun,
            namespaces: report.namespaces.map((n) => ({
              to: n.to,
              read: n.read,
              failed: n.failed,
              crc: n.crc,
            })),
          },
        })
      }
    },
    async cancel(job) {
      // Final review I3: a restore swapping its targets in finishes; "cancelled" would be untrue.
      if (swapping.has(job.id)) return false
      const client = await deps.client(job.target.connectionId).catch(() => null)
      if (client) await kill(client, job.comment).catch(() => 0)
      return true
    },
    recover: () => 'interrupted',
  }
}
