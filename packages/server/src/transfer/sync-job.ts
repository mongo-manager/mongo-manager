import { EJSON } from 'bson'
import { MongoServerError, type Collection, type Document, type MongoClient } from 'mongodb'
import type { RowError, SyncCollectionReport, SyncReport } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import type { JobContext, JobKind } from '../jobs/types'
import type { ServerContext } from '../http/context'
import { killByComment } from '../data/operations'
import { serverCode, writeRefusal } from '../data/mongo-errors'
import { gateDepsFor } from '../masking/restricted'
import { isIndexesRefusal, restoreReplacement } from '../masking/gate'
import { fieldOf, fieldsOf, isDocument } from '../masking/gate/values'
import { nsMaskerFrom, type Pattern } from '../masking/match'
import { BATCH_DOCS, MAX_REPORT_ERRORS } from './limits'
import { mergeJoin, sameDocument } from './merge-join'
import { maskWith } from './copy-job'
import { sorted } from './compare-job'
import { isJobLevel, TargetWriter, type PendingDoc, type WriteCounts } from './target-writer'
import type { PreparedCompare } from './compare-access'

export interface SyncJobParams {
  owner: string
  compareJobId: string
  prepared: Omit<PreparedCompare, 'sourceClient' | 'targetClient'>
  source: { connectionId: string; db: string; coll: string | null }
  target: { connectionId: string; db: string; coll: string | null }
  switches: { insert: boolean; replace: boolean; delete: boolean }
  /** The comparison's "only in target" count per collection: the deletion growth guard (spec §6.4). */
  compared: Array<{ source: string; onlyTarget: number }>
}

/** Target documents a sync asks the source about at once before deleting them (review I6). */
const DELETE_BATCH = 500

/** The filter that matches a document only as it was read (spec §6.4). */
const pinned = (current: Document) => ({
  _id: { $eq: current._id },
  $expr: { $eq: ['$$ROOT', { $literal: current }] },
})

/** Writes only if the stored document is still the version read (spec §6.4). */
export async function pinnedReplace(
  coll: Collection,
  current: Document,
  replacement: Document,
  comment: string,
  maxTimeMS: number,
): Promise<boolean> {
  const r = await coll.replaceOne(pinned(current), replacement, {
    collation: { locale: 'simple' },
    comment,
    maxTimeMS,
  })
  return r.matchedCount === 1
}

/** Deletes only if the stored document is still the version read (spec §6.4). */
export async function pinnedDelete(
  coll: Collection,
  current: Document,
  comment: string,
  maxTimeMS: number,
): Promise<boolean> {
  const r = await coll.deleteOne(pinned(current), { collation: { locale: 'simple' }, comment, maxTimeMS })
  return r.deletedCount === 1
}

/** Plan ruling 9: masked paths keep the target's stored value, so a sync never writes "***" over it. */
export function keepTargetValues(source: Document, target: Document, patterns: Pattern[]): Document {
  const ns = nsMaskerFrom(patterns)
  const walk = (s: unknown, t: unknown, path: string[]): unknown => {
    if (path.length && ns.matches(path)) return t === undefined ? s : t
    if (!isDocument(s) || (path.length && !ns.under(path))) return s
    const out: Document = {}
    for (const [k, v] of Object.entries(fieldsOf(s))) {
      const tv = isDocument(t) ? fieldOf(t, k)?.value : undefined
      Object.defineProperty(out, k, {
        value: walk(v, tv, [...path, k]),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  return walk(source, target, []) as Document
}

const blank = (source: string, target: string): SyncCollectionReport => ({
  source,
  target,
  inserted: 0,
  replaced: 0,
  deleted: 0,
  changedMeanwhile: 0,
  failed: 0,
  errors: [],
  moreErrors: false,
})

/** Phase 3d-2 spec §6.4: a sync — the comparison done again, and acted on as it reads now. */
export function syncKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  ctx: () => ServerContext
  /** Kills the operations tagged with a comment; tests replace it. */
  kill?: (client: MongoClient, comment: string) => Promise<number>
}): JobKind<SyncJobParams> {
  const kill = deps.kill ?? killByComment
  return {
    name: 'data.sync',
    async run(job, p) {
      const ctx = deps.ctx()
      const { limits, reports } = ctx.transfer
      const started = Date.now()
      const timeLeft = () => Math.max(1, limits.maxJobMs - (Date.now() - started))
      const source = await deps.client(p.source.connectionId)
      const target = await deps.client(p.target.connectionId)
      const report: SyncReport = {
        kind: 'sync',
        compareJobId: p.compareJobId,
        collections: [],
        masked: p.prepared.pairs.some((x) => x.union !== null),
        versions: p.prepared.versions,
        restricted: { source: p.prepared.sourceMasker !== null, target: p.prepared.targetMasker !== null },
      }
      let threw = false
      try {
        for (const pair of p.prepared.pairs) {
          if (job.signal.aborted) break
          const out = blank(pair.source, pair.target)
          report.collections.push(out)
          await syncPair({ job, p, pair, out, source, target, timeLeft })
        }
      } catch (e) {
        threw = true
        throw e
      } finally {
        reports.save(job.id, p.owner, report, ctx.now() + limits.ttlMs)
        ctx.audit.append({
          action: 'transfer.sync',
          outcome: threw || job.signal.aborted ? 'failure' : 'success',
          userId: p.owner === 'local' ? null : p.owner,
          username: null,
          ip: null,
          connectionId: p.source.connectionId,
          namespace: p.source.db,
          details: {
            job: job.id,
            compareJobId: p.compareJobId,
            target: p.target.connectionId,
            targetDb: p.target.db,
            delete: p.switches.delete,
            collections: report.collections.map((c) => ({
              source: c.source,
              inserted: c.inserted,
              replaced: c.replaced,
              deleted: c.deleted,
              changedMeanwhile: c.changedMeanwhile,
              ...(c.outsideFilter ? { outsideFilter: c.outsideFilter } : {}),
              failed: c.failed,
            })),
          },
        })
      }
    },
    // Spec §8.1: cancel ends the reads and writes on both connections.
    async cancel(job) {
      for (const id of new Set([
        job.target.connectionId,
        job.target.targetConnectionId ?? job.target.connectionId,
      ])) {
        const client = await deps.client(id).catch(() => null)
        if (client) await kill(client, job.comment).catch(() => 0)
      }
      return true
    },
    recover: () => 'interrupted',
  }
}

async function syncPair(run: {
  job: JobContext
  p: SyncJobParams
  pair: SyncJobParams['prepared']['pairs'][number]
  out: SyncCollectionReport
  source: MongoClient
  target: MongoClient
  timeLeft: () => number
}): Promise<void> {
  const { job, p, pair, out, timeLeft } = run
  const { switches } = p
  const coll = run.target.db(p.target.db).collection(pair.target)
  const targetMasker = p.prepared.targetMasker
  const gate = targetMasker ? gateDepsFor(targetMasker, run.target, { comment: job.comment, timeLeft }) : null
  const codeOnly = targetMasker !== null
  let record = 0
  const fail = async (doc: PendingDoc, reason: string, field?: string, code?: number) => {
    out.failed++
    if (out.errors.length < MAX_REPORT_ERRORS) {
      const error: RowError = { record: doc.n, reason }
      if (field !== undefined) error.field = field
      if (code !== undefined) error.code = code
      out.errors.push(error)
    } else out.moreErrors = true
  }
  // The server's own either way, from under the driver's wrapper (second independent review, Minor 1).
  const reason = (refused: unknown) => writeRefusal(refused, codeOnly)

  // Spec §6.4: deletions are refused outright when the source reads no documents.
  if (switches.delete) {
    const any = await run.source
      .db(p.source.db)
      .collection(pair.source)
      .countDocuments(pair.sourceFilter, { limit: 1, comment: job.comment, maxTimeMS: timeLeft() })
    if (any === 0)
      throw Errors.conflict('The source reads no documents; deletions are refused', {
        reason: 'source_empty',
      })
  }
  const compared = p.compared.find((c) => c.source === pair.source)?.onlyTarget ?? 0
  const deletionLimit = compared + Math.max(100, Math.ceil(compared * 0.1))
  let deletesTried = 0
  // Data review 2026-10-13 (M10): with a filter, "only in the target" may be a document whose
  // source still exists but left the filter. Before deleting, the source is asked about them a
  // batch at a time (review I6); one still there is kept and counted.
  const filtered = pair.filtered ?? Object.keys(pair.sourceFilter).length > 0
  const sourceColl = run.source.db(p.source.db).collection(pair.source)
  const idKey = (v: unknown) => EJSON.stringify({ v } as Document, { relaxed: false })
  let doomed: Array<{ item: PendingDoc; target: Document }> = []
  const settleDeletes = async () => {
    const taken = doomed
    doomed = []
    if (!taken.length) return
    const there = new Set<string>()
    if (filtered)
      for (const d of await sourceColl
        .find({ _id: { $in: taken.map((t) => t.target._id) } } as Document, {
          projection: { _id: 1 },
          promoteValues: false,
          collation: { locale: 'simple' },
          comment: job.comment,
          maxTimeMS: timeLeft(),
        })
        .toArray())
        there.add(idKey(d._id))
    for (const { item, target } of taken) {
      if (there.has(idKey(target._id))) {
        out.outsideFilter = (out.outsideFilter ?? 0) + 1
        continue
      }
      if (++deletesTried > deletionLimit) {
        out.deletionStopped = true
        continue
      }
      try {
        if (await pinnedDelete(coll, target, job.comment, timeLeft())) out.deleted++
        else out.changedMeanwhile++
      } catch (err) {
        // Indexes that cannot be read stop the sync, as they would each document (next review, M-3).
        if (isIndexesRefusal(err)) throw err
        if (err instanceof AppError && err.statusCode === 403) await fail(item, err.message)
        // A server's own failure stops the sync, as it does the writer's (next round, M-A).
        else if (err instanceof MongoServerError && !isJobLevel(serverCode(err)))
          await fail(item, reason(err), undefined, Number(serverCode(err)))
        else throw err
      }
    }
  }

  const counts: WriteCounts = { inserted: 0, matched: 0, modified: 0, upserted: 0, skipped: 0 }
  const writer = new TargetWriter({
    collection: coll,
    // Its writes are inserts: what kind the target is changes none of them.
    targetDb: null,
    db: p.target.db,
    coll: pair.target,
    mode: 'insert',
    keys: ['_id'],
    updateOnly: false,
    ordered: false,
    gate,
    codeOnly,
    comment: job.comment,
    timeLeft,
    signal: job.signal,
    counts,
    fail,
    stopped: () => false,
  })
  let batch: PendingDoc[] = []
  const flush = async () => {
    const taken = batch
    batch = []
    if (taken.length) await writer.write(taken)
    out.inserted = counts.inserted
  }
  // What the caller may see of each side (spec §5.3), and what a sync writes from the source.
  const view = (d: Document) => (pair.union ? maskWith(d, pair.union) : d)
  const write = (d: Document) => (pair.writeMask ? maskWith(d, pair.writeMask) : d)
  const s = sorted(run.source, p.source.db, pair.source, pair.sourceFilter, job.comment, timeLeft())
  const t = sorted(run.target, p.target.db, pair.target, pair.targetFilter, job.comment, timeLeft())
  try {
    for await (const e of mergeJoin(s, t, (x, y) => sameDocument(view(x), view(y), p.prepared.ignore))) {
      if (job.signal.aborted) break
      // Final review C4: the job's own deadline, not only each operation's.
      if (timeLeft() <= 1) throw Errors.conflict('The sync ran longer than allowed')
      if (e.kind === 'same') continue
      const item: PendingDoc = { n: ++record, doc: e.kind === 'onlyTarget' ? e.target : e.source }
      if (e.kind === 'onlySource') {
        if (!switches.insert) continue
        batch.push({ ...item, doc: write(e.source) })
        if (batch.length >= BATCH_DOCS) await flush()
        continue
      }
      try {
        if (e.kind === 'different') {
          if (!switches.replace) continue
          let replacement = pair.writeMask
            ? keepTargetValues(write(e.source), e.target, pair.writeMask)
            : e.source
          // 3c: a caller restricted on the target replaces as the documents view does.
          if (gate)
            replacement = await restoreReplacement(p.target.db, pair.target, e.target, replacement, gate)
          if (await pinnedReplace(coll, e.target, replacement, job.comment, timeLeft())) out.replaced++
          else out.changedMeanwhile++
        } else if (switches.delete) {
          // Past the limit, nothing more is looked up or deleted.
          if (out.deletionStopped) continue
          doomed.push({ item, target: e.target })
          if (doomed.length >= DELETE_BATCH) await settleDeletes()
        }
      } catch (err) {
        // Indexes that cannot be read stop the sync, as they would each document (next review, M-3).
        if (isIndexesRefusal(err)) throw err
        if (err instanceof AppError && err.statusCode === 403) await fail(item, err.message)
        // A server's own failure stops the sync, as it does the writer's (next round, M-A).
        else if (err instanceof MongoServerError && !isJobLevel(serverCode(err)))
          await fail(item, reason(err), undefined, Number(serverCode(err)))
        else throw err
      }
    }
    if (!job.signal.aborted) {
      await settleDeletes()
      await flush()
    }
  } finally {
    await Promise.all([s.close().catch(() => undefined), t.close().catch(() => undefined)])
  }
}
