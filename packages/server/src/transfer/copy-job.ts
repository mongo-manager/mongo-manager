// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomBytes } from 'node:crypto'
import { MongoServerError, type Collection, type Db, type Document, type MongoClient } from 'mongodb'
import { calculateObjectSize } from 'bson'
import {
  deserializeValue,
  findServerJs,
  type CopyCollectionReport,
  type CopyReport,
  type PersonalRule,
  type RowError,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import type { JobContext, JobKind } from '../jobs/types'
import { PartTracker } from '../jobs/parts'
import type { ServerContext } from '../http/context'
import { killByComment } from '../data/operations'
import { serverCode, serverText } from '../data/mongo-errors'
import { READ_OPTIONS, toClient } from '../data/ejson-io'
import { ejsonText } from './bson-kind'
import { maskDocument } from '../masking/document'
import { gateDepsFor } from '../masking/restricted'
import { guardIndexBuild, guardIndexesReadable, guardValidator, guardViewSource } from '../masking/gate'
import { nsMaskerFrom, type Masker, type Pattern } from '../masking/match'
import { BATCH_BYTES, BATCH_DOCS, MAX_REPORT_ERRORS } from './limits'
import { RejectedWriter } from './rejected'
import { TargetWriter, pathLikeField, type PendingDoc, type WriteCounts } from './target-writer'
import type { CopyOptions, CopyPair } from './copy-plan'
import type { ExportPlan } from './export-job'
import { viewOrder, type ViewDef } from './collection-spec'
import { refuseAnyRepeat } from '../masking/repeats'
import { isIndexesRefusal, isOrderRefusal } from '../masking/gate'

export interface CopyJobParams {
  owner: string
  request: CopyOptions & { views?: boolean }
  pairs: CopyPair[]
  views: ViewDef[]
  sourcePlan: ExportPlan | null
  sourceMasker: Masker | null
  targetMasker: Masker | null
  versions: { source: number; target: number }
  targetDb: string
  addRules: PersonalRule[]
  /**
   * Phase 3e-2 final review I2: a live sync's copy reads the primary, where T0 was read — a
   * secondary may not have applied every write before T0 yet.
   */
  primaryReads?: boolean
}

/** The copy's read options for the source (final review I2). */
export function sourceReadOptions(p: { primaryReads?: boolean }): { readPreference?: 'primary' } {
  return p.primaryReads ? { readPreference: 'primary' } : {}
}

const MAX_DOC = 16 * 1024 * 1024

/** Staging collections of copies: only names of this form are ever dropped (Task 2, COPY_STAGING). */
export const stagingName = () => `mm_copy_${randomBytes(8).toString('hex')}`

/** A document with every value at these paths replaced by "***" (canonical EJSON walk, 3d-1 C1). */
export function maskWith(doc: Document, patterns: Pattern[]): Document {
  return deserializeValue<Document>(maskDocument(toClient(doc), nsMaskerFrom(patterns)))
}

const blankReport = (p: CopyPair): CopyCollectionReport => ({
  source: p.source,
  target: p.target,
  path: p.path,
  read: 0,
  inserted: 0,
  matched: 0,
  modified: 0,
  upserted: 0,
  skipped: 0,
  failed: 0,
  errors: [],
  moreErrors: false,
  indexes: { built: [], skipped: [...(p.indexes?.skipped ?? [])] },
})

interface PairRun {
  job: JobContext
  p: CopyJobParams
  pair: CopyPair
  out: CopyCollectionReport
  source: MongoClient
  target: MongoClient
  timeLeft: () => number
  rejected: RejectedWriter
  ctx: ServerContext
  /** W4.3: this collection's progress among the copy's collections. */
  parts: PartTracker
}

/** The source cursor: the route's find/aggregate plan for a collection copy, else the whole collection. */
function openSource(run: PairRun) {
  const { job, p, pair } = run
  const coll = run.source.db(job.target.db).collection(pair.source)
  const common = {
    ...READ_OPTIONS,
    ...sourceReadOptions(p),
    batchSize: BATCH_DOCS,
    comment: job.comment,
    maxTimeMS: run.timeLeft(),
  }
  const plan = p.sourcePlan ?? pair.read
  if (plan?.kind === 'aggregate') return coll.aggregate(plan.stages, { ...common, allowDiskUse: true })
  if (plan?.kind === 'find') return coll.find(plan.filter, { ...plan.options, ...common })
  return coll.find({}, common)
}

/** Builds the planned indexes one by one, so one that fails is reported and the others still build. */
async function buildIndexes(coll: Collection, run: PairRun): Promise<void> {
  const { pair, out, job, p } = run
  // Final review C3: a caller restricted on the target builds only what 3c lets them build there
  // (a unique, TTL or typed index over hidden values would answer questions about them).
  const gate = p.targetMasker
    ? gateDepsFor(p.targetMasker, run.target, { comment: run.job.comment, timeLeft: run.timeLeft })
    : null
  for (const spec of pair.indexes?.build ?? []) {
    const { key, ...options } = spec
    try {
      if (gate) await guardIndexBuild(p.targetDb, pair.target, key as Document, options as never, gate)
      await coll.createIndex(
        key as Document,
        { ...options, comment: job.comment, maxTimeMS: run.timeLeft() } as never,
      )
      out.indexes.built.push(String(spec.name))
    } catch (e) {
      // 3c: MongoDB's text can quote values; a caller restricted on the target gets the code. Both
      // the server's own, from under the driver's wrapper (second independent review, Minor 1).
      const reason =
        e instanceof AppError
          ? e.message.slice(0, 300)
          : p.targetMasker
            ? `Index build refused (code ${String(serverCode(e) ?? 'unknown')})`
            : serverText(e).slice(0, 300)
      out.indexes.skipped.push({ name: String(spec.name), reason })
    }
  }
}

/** Drops a staging collection; forgets it only once it is surely gone (code 26: it never existed). */
async function dropStaging(client: MongoClient, job: JobContext, db: string, name: string): Promise<void> {
  const gone = await client
    .db(db)
    .collection(name)
    .drop()
    .then(
      () => true,
      (e: { code?: unknown }) => e.code === 26,
    )
  if (gone) job.setStaging(null)
}

/**
 * Data review 2026-10-13 (M5): a collection made for a copy gets its validator after the load, as
 * MongoDB's own copy does — documents stored before the source had it (which it would refuse) are
 * copied too. The returned function sets it (once). Where the target's user may not change it later
 * (readWrite has no collMod: review I2), it is set now, as before, and the report says so.
 */
async function createForLoad(
  targetDb: Db,
  name: string,
  options: Document,
  comment: string,
  out: { validatorBeforeLoad?: boolean },
): Promise<() => Promise<void>> {
  const { validator, validationLevel, validationAction, ...rest } = options
  const noop = async () => undefined
  if (!validator) {
    await targetDb.createCollection(name, { ...rest, comment } as never)
    return noop
  }
  await targetDb.createCollection(name, { ...rest, comment } as never)
  try {
    await targetDb.command({ collMod: name, comment })
  } catch (e) {
    if (!(e instanceof MongoServerError) || (e.code !== 13 && e.codeName !== 'Unauthorized')) throw e
    await targetDb.collection(name).drop({ comment } as never)
    await targetDb.createCollection(name, { ...options, comment } as never)
    out.validatorBeforeLoad = true
    return noop
  }
  let set = false
  return async () => {
    if (set) return
    set = true
    await targetDb.command({
      collMod: name,
      validator,
      ...(validationLevel ? { validationLevel } : {}),
      ...(validationAction ? { validationAction } : {}),
      comment,
    })
  }
}

/**
 * Spec §7.1: on one connection, with nothing to mask, MongoDB copies by itself — $out into a staging
 * collection then a rename (a new target, or "replace"), or $merge on _id (upsert). The validator is
 * set and the indexes built on the staging collection before it takes the target's name.
 */
async function shortcut(run: PairRun): Promise<void> {
  const { job, p, pair, out } = run
  const r = p.request
  const sourceDb = run.source.db(job.target.db)
  const targetDb = run.target.db(p.targetDb)
  const match = p.sourcePlan?.kind === 'find' ? p.sourcePlan.filter : {}
  const options = { comment: job.comment, maxTimeMS: run.timeLeft(), allowDiskUse: true }
  out.read = await sourceDb
    .collection(pair.source)
    .countDocuments(match, { comment: job.comment, maxTimeMS: run.timeLeft() })
  job.setEstimate(out.read)
  run.parts.update(pair.source, { total: out.read })
  const create = pair.create && 'options' in pair.create ? pair.create.options : {}
  if (r.mode === 'upsert') {
    // Review of the data fixes (Minor 8): a new collection gets its validator after the load here too.
    const setValidator = pair.exists
      ? async () => undefined
      : await createForLoad(targetDb, pair.target, create, job.comment, out)
    await sourceDb
      .collection(pair.source)
      .aggregate(
        [
          { $match: match },
          {
            $merge: {
              into: { db: p.targetDb, coll: pair.target },
              on: '_id',
              whenMatched: 'replace',
              whenNotMatched: 'insert',
            },
          },
        ],
        options,
      )
      .toArray()
    await setValidator()
    await buildIndexes(targetDb.collection(pair.target), run)
    return
  }
  const staging = stagingName()
  job.setStaging(staging, { connectionId: job.target.targetConnectionId!, db: p.targetDb })
  try {
    await sourceDb
      .collection(pair.source)
      .aggregate([{ $match: match }, { $out: { db: p.targetDb, coll: staging } }], options)
      .toArray()
    if (create.validator)
      await targetDb.command({
        collMod: staging,
        validator: create.validator,
        ...(create.validationLevel ? { validationLevel: create.validationLevel } : {}),
        ...(create.validationAction ? { validationAction: create.validationAction } : {}),
        comment: job.comment,
      })
    await buildIndexes(targetDb.collection(staging), run)
    await targetDb
      .collection(staging)
      .rename(pair.target, { dropTarget: r.mode === 'replace', comment: job.comment } as never)
    job.setStaging(null)
    out.inserted = out.read
  } catch (e) {
    await dropStaging(run.target, job, p.targetDb, staging)
    throw e
  }
}

/**
 * Phase 3d-2 spec §7.2: one collection streamed through the server — read, masked where §5.2 asks,
 * checked, and written by the TargetWriter one batch behind the reads. Returns the record it
 * stopped at ("stop" mode), or 0.
 */
async function copyPair(run: PairRun): Promise<number> {
  const { job, p, pair, out, timeLeft, rejected, ctx } = run
  const r = p.request
  const ordered = r.onError === 'stop'
  let stoppedAt = 0
  const fail = async (doc: PendingDoc, reason: string, field?: string, code?: number) => {
    out.failed++
    if (out.errors.length < MAX_REPORT_ERRORS) {
      const error: RowError = { record: doc.n, reason }
      if (field !== undefined) error.field = field
      if (code !== undefined) error.code = code
      out.errors.push(error)
    } else out.moreErrors = true
    if (!r.dryRun) await rejected.write({ raw: doc.raw ?? ejsonText(doc.doc, { relaxed: false }) })
    if (ordered && !stoppedAt) stoppedAt = doc.n
  }
  if (pair.path === 'shortcut' && !r.dryRun) {
    await shortcut(run)
    return 0
  }
  // Eighteenth and nineteenth reviews (I-2, I4, Minor 3, 4, 9): a time series whose _id may repeat
  // is asked once, before anything is made, read or written (the target, the rejected records
  // too), with the read's collation and read preference, whether one does; if one does, that
  // collection alone fails, and the copy goes on.
  const plan = p.sourcePlan ?? pair.read
  if (plan?.kind === 'find' && plan.repeats)
    try {
      await refuseAnyRepeat(
        run.source.db(job.target.db).collection(pair.source),
        {
          comment: job.comment,
          maxTimeMS: timeLeft(),
          ...sourceReadOptions(p),
          ...(plan.options.collation ? { collation: plan.options.collation } : {}),
        },
        plan.checksId === true,
      )
    } catch (e) {
      // A query's copy (of one collection) fails as a whole; a database copy leaves this one out
      // and goes on (tenth and eleventh reviews, Minor 5, M1).
      if (!isOrderRefusal(e) || p.sourcePlan !== null) throw e
      out.failure = (e as Error).message.slice(0, 300)
      return 0
    }
  // Spec §7.3: a new target is created with the source's options; "replace" writes into a staging
  // collection that takes the target's place only once the copy is complete.
  const targetDb = run.target.db(p.targetDb)
  const createOptions = pair.create && 'options' in pair.create ? pair.create.options : {}
  // A dry run's too: the check only reads (review of the agent's gate, M-4).
  if (p.targetMasker && createOptions.validator)
    try {
      await guardValidator(
        p.targetDb,
        pair.target,
        createOptions.validator as Document,
        gateDepsFor(p.targetMasker, run.target, { comment: job.comment, timeLeft }),
      )
    } catch (e) {
      if (!(e instanceof AppError)) throw e
      out.failure = e.message.slice(0, 300)
      return 0
    }
  let into = pair.target
  let setValidator: () => Promise<void> = async () => undefined
  const writeGate = p.targetMasker
    ? gateDepsFor(p.targetMasker, run.target, { comment: job.comment, timeLeft })
    : null
  // Its indexes readable before a new target is made (reviews of the agent's gate, M-C, M-3), a dry
  // run's too (it only reads): a database copy leaves out a collection the gate refuses there (its
  // indexes, a GridFS bucket's chunks; I-1), as for its other refusals; a collection copy fails.
  // An existing target's too: the run would leave it out (M-4).
  if (writeGate && r.mode !== 'replace')
    try {
      await guardIndexesReadable(p.targetDb, pair.target, writeGate)
    } catch (e) {
      if (!(e instanceof AppError && e.statusCode === 403) || p.sourcePlan !== null) throw e
      out.failure ??= e.message.slice(0, 300)
      return 0
    }
  if (!r.dryRun) {
    if (r.mode === 'replace') {
      into = stagingName()
      job.setStaging(into, { connectionId: job.target.targetConnectionId!, db: p.targetDb })
      setValidator = await createForLoad(targetDb, into, createOptions, job.comment, out)
    } else if (!pair.exists && pair.create && 'options' in pair.create)
      // What the gate saw before it was made (kind missing, no index) stands for the load: only _id's
      // index is there until the indexes are built after it (next round, nit).
      setValidator = await createForLoad(targetDb, pair.target, createOptions, job.comment, out)
  }
  let placed = into === pair.target
  const coll: Collection = targetDb.collection(into)
  const writer = new TargetWriter({
    collection: coll,
    db: p.targetDb,
    coll: into,
    mode: r.mode === 'replace' ? 'insert' : r.mode,
    keys: r.keys,
    updateOnly: r.updateOnly,
    ordered,
    gate: writeGate,
    codeOnly: p.targetMasker !== null,
    // A dry run creates nothing: the target it would create is judged by its options (final
    // review of explain masking, M-4).
    ...(r.dryRun && !pair.exists ? { createdAs: createOptions as Document } : {}),
    targetDb,
    comment: job.comment,
    timeLeft,
    signal: job.signal,
    counts: out as unknown as WriteCounts,
    fail,
    stopped: () => stoppedAt > 0,
  })
  const total = await run.source
    .db(job.target.db)
    .collection(pair.source)
    .estimatedDocumentCount({ comment: job.comment, maxTimeMS: timeLeft() })
  job.setEstimate(total)
  run.parts.update(pair.source, { total })
  const finish = plan?.kind === 'find' ? plan.finish : null
  const cursor = openSource(run)
  let batch: PendingDoc[] = []
  let bytes = 0
  // Spec §7.2: one batch is written while the next is read, never more.
  let inFlight: Promise<void> = Promise.resolve()
  // Final review I1: never a rejection without a handler while the next batch is read.
  let writeError: unknown = null
  const settle = async () => {
    await inFlight
    if (writeError) throw writeError
  }
  const flush = async () => {
    const taken = batch
    batch = []
    bytes = 0
    await settle()
    // W4.3: per batch, not per document (the view is rebuilt at each change).
    run.parts.update(pair.source, { done: out.read, total: Math.max(total, out.read) })
    if (!taken.length || stoppedAt) return
    if (r.dryRun) {
      if (r.mode === 'upsert' || r.mode === 'merge')
        out.wouldMatch = (out.wouldMatch ?? 0) + (await writer.wouldMatch(taken))
      return
    }
    // Spec §5.2: an unmasked copy stops when the source's rules change under it.
    if (pair.mask === null && ctx.personalFields.get(job.target.connectionId).version !== p.versions.source)
      throw Errors.conflict('The personal-field rules changed; start the copy again', {
        reason: 'rules_changed',
      })
    inFlight = writer.write(taken).catch((e: unknown) => {
      writeError ??= e
    })
  }
  /**
   * With "stop", what was read before a refusal is written first — and finished, so a record of it
   * refused on the way is the one the copy stops at (data review round 2, I4). Whether it stopped.
   */
  const written = async (): Promise<boolean> => {
    await flush()
    await settle()
    return stoppedAt > 0
  }
  try {
    for await (const read of cursor) {
      if (job.signal.aborted || stoppedAt) break
      // Final review C4: the job's own deadline, not only each operation's.
      if (timeLeft() <= 1) throw Errors.conflict('The copy ran longer than allowed')
      // 3c §3.7: a guarded sort's check and the removal of the keys the gate added.
      const raw = finish ? finish([read as Document])[0] : (read as Document)
      if (!raw) continue
      out.read++
      const doc = pair.mask ? maskWith(raw, pair.mask) : raw
      const item: PendingDoc = { n: out.read, doc }
      const pathLike = r.mode === 'merge' ? pathLikeField(doc) : undefined
      if (pathLike !== undefined) {
        if (ordered && (await written())) break
        await fail(
          item,
          'A merge cannot set a field whose name holds "." or starts with "$"; use upsert',
          pathLike.slice(0, 200),
        )
        continue
      }
      const size = calculateObjectSize(doc)
      if (size > MAX_DOC) {
        if (ordered && (await written())) break
        await fail(item, 'The document is larger than 16 MiB once masked')
        continue
      }
      batch.push(item)
      bytes += size
      if (batch.length >= BATCH_DOCS || bytes >= BATCH_BYTES) await flush()
      job.progress(out.read, Math.max(total, out.read))
    }
    if (!job.signal.aborted && !stoppedAt) await flush()
    await settle()
    if (!r.dryRun && !stoppedAt && !job.signal.aborted) {
      if (!placed) {
        // Final review C4: every document read is written or refused, or the target stays as it was.
        if (out.inserted + out.failed !== out.read)
          throw Errors.conflict('The copy is incomplete; the target was left as it was')
        // Data review 2026-10-13 (M5): a refused document would be missing from the new target —
        // said before the validator and the indexes are set on a copy that will not be used (Minor 9).
        if (out.failed > 0)
          throw Errors.conflict(
            `${out.failed} document${out.failed === 1 ? ' was' : 's were'} refused; the target was left as it was`,
            { reason: 'incomplete' },
          )
      }
      await setValidator()
      await buildIndexes(coll, run)
      if (!placed) {
        // The copy takes the target's place only now that it is complete (spec §2 "replace target").
        await coll.rename(pair.target, { dropTarget: true, comment: job.comment } as never)
        job.setStaging(null)
        placed = true
      }
    }
  } finally {
    await cursor.close().catch(() => undefined)
    await inFlight.catch(() => undefined)
    // Review of the data fixes (I3): a new collection kept after a stop, a failure or a cancel gets
    // its validator too — what is in it was copied.
    if (placed && !r.dryRun)
      await setValidator().catch((e: unknown) => {
        out.failure ??= `The validator could not be set: ${String((e as Error).message ?? e).slice(0, 200)}`
      })
    // A staging collection that was not put in place (a failure, a stop, a cancel) is dropped; a drop
    // that fails keeps the name, for dropLeftoverStaging at the next open.
    if (!placed && !r.dryRun) {
      await dropStaging(run.target, job, p.targetDb, into)
      // What went into it was not written (review of the agent's gate, M-2).
      if (into !== pair.target) {
        Object.assign(out, { inserted: 0, matched: 0, modified: 0, upserted: 0, skipped: 0 })
        // Nor the indexes built on it (nit).
        if (out.indexes) out.indexes.built = []
      }
    }
  }
  return stoppedAt
}

/**
 * Spec §7.3: a database copy's views, after its collections, in dependency order. A pipeline that
 * runs JavaScript (when the server forbids it) or writes is refused; a restricted target user's view
 * must not read personal data (3c guardViewSource). Each view's outcome goes to the report.
 */
async function createViews(
  target: MongoClient,
  job: JobContext,
  p: CopyJobParams,
  ctx: ServerContext,
  /** The job's time left: its views' gate keeps to it (review of the agent's gate, M-5). */
  timeLeft: () => number,
): Promise<CopyReport['views']> {
  const { ordered, cyclic } = viewOrder(p.views)
  const db = target.db(p.targetDb)
  const gate = p.targetMasker ? gateDepsFor(p.targetMasker, target, { comment: job.comment, timeLeft }) : null
  const out: CopyReport['views'] = []
  for (const v of ordered) {
    try {
      const js = findServerJs(v.pipeline)
      if (js && !ctx.config.allowServerJs)
        throw new Error(`Its pipeline uses ${js}, which runs JavaScript on the server`)
      if (v.pipeline.some((stage) => '$out' in stage || '$merge' in stage))
        throw new Error('Its pipeline writes')
      if (gate) await guardViewSource(p.targetDb, v.viewOn, v.pipeline, gate)
      await db.createCollection(v.name, {
        viewOn: v.viewOn,
        pipeline: v.pipeline,
        comment: job.comment,
      } as never)
      const copied = p.pairs.some((x) => x.target === v.viewOn) || p.views.some((x) => x.name === v.viewOn)
      out.push(
        copied
          ? { name: v.name, created: true }
          : { name: v.name, created: true, reason: 'Its source was not copied' },
      )
    } catch (e) {
      // 3c: MongoDB's text can quote values; a caller restricted on the target gets the code. Both
      // the server's own, from under the driver's wrapper (second independent review, Minor 1).
      const code = serverCode(e)
      const reason =
        p.targetMasker && !(e instanceof AppError) && code !== undefined
          ? `View creation refused (code ${String(code)})`
          : serverText(e).slice(0, 300)
      out.push({ name: v.name, created: false, reason })
    }
  }
  for (const name of cyclic)
    out.push({ name, created: false, reason: 'Its definition reads itself through other views' })
  return out
}

/** Phase 3d-2 spec §7, §8.1: the copy job, one collection or a database's chosen collections. */
export function copyKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  ctx: () => ServerContext
  /** Kills the operations tagged with a comment; tests replace it. */
  kill?: (client: MongoClient, comment: string) => Promise<number>
}): JobKind<CopyJobParams> {
  const kill = deps.kill ?? killByComment
  return {
    name: 'data.copy',
    async run(job, p) {
      const ctx = deps.ctx()
      const { files, reports, limits } = ctx.transfer
      const started = Date.now()
      const timeLeft = () => Math.max(1, limits.maxJobMs - (Date.now() - started))
      const source = await deps.client(job.target.connectionId)
      const target = await deps.client(job.target.targetConnectionId!)
      const r = p.request
      const report: CopyReport = {
        kind: 'copy',
        dryRun: r.dryRun,
        mode: r.mode,
        collections: [],
        views: [],
        masked: p.pairs.some((x) => x.mask !== null && p.sourceMasker !== null),
        anonymous: r.anonymous,
        rulesAdded: p.addRules.length,
        rejectedFile: false,
        versions: p.versions,
        restricted: { source: p.sourceMasker !== null, target: p.targetMasker !== null },
      }
      const rejected = new RejectedWriter({
        files,
        owner: p.owner,
        connectionId: job.target.connectionId,
        jobId: job.id,
        format: 'ndjson',
        header: null,
        name: `${job.target.db}-rejected`,
      })
      let threw = false
      // W4.3: progress per collection, shown while the copy runs.
      const parts = new PartTracker((v) => job.setParts(v))
      parts.start(
        p.pairs.map((x) => x.source),
        'copy',
      )
      try {
        for (const pair of p.pairs) {
          if (job.signal.aborted) break
          const out = blankReport(pair)
          report.collections.push(out)
          if (pair.create && 'skip' in pair.create) {
            out.failure = pair.create.skip
            parts.update(pair.source, { state: 'skipped' })
            continue
          }
          parts.update(pair.source, { state: 'running' })
          let stop: number
          try {
            stop = await copyPair({ job, p, pair, out, source, target, timeLeft, rejected, ctx, parts })
          } catch (e) {
            parts.update(pair.source, { state: 'failed', done: out.read })
            // A database copy leaves out a collection whose indexes cannot be read and goes on, as for
            // its other refusals (next review of the agent's gate, M-4).
            if (!isIndexesRefusal(e) || p.sourcePlan !== null) throw e
            out.failure ??= (e as Error).message.slice(0, 300)
            continue
          }
          parts.update(pair.source, {
            state: stop || out.failure ? 'failed' : 'done',
            done: out.read,
            total: Math.max(out.read, parts.view().items.find((i) => i.name === pair.source)?.total ?? 0),
          })
          if (stop) {
            report.stoppedAt = { collection: pair.source, record: stop }
            break
          }
        }
        if (!r.dryRun && !report.stoppedAt && !job.signal.aborted && p.views.length) {
          parts.phase('views')
          report.views = await createViews(target, job, p, ctx, timeLeft)
        }
        if (report.stoppedAt)
          throw Errors.conflict(
            `Stopped at ${report.stoppedAt.collection}, record ${report.stoppedAt.record}; the report says why`,
          )
      } catch (e) {
        threw = true
        throw e
      } finally {
        report.rejectedFile = await rejected.finish().catch(async () => {
          await rejected.abort()
          return false
        })
        if (rejected.dropped) report.rejectedDropped = true
        reports.save(job.id, p.owner, report, ctx.now() + limits.ttlMs)
        ctx.audit.append({
          action: 'transfer.copy',
          outcome: threw || job.signal.aborted ? 'failure' : 'success',
          userId: p.owner === 'local' ? null : p.owner,
          username: null,
          ip: null,
          connectionId: job.target.connectionId,
          namespace: job.target.db,
          details: {
            job: job.id,
            target: job.target.targetConnectionId,
            targetDb: p.targetDb,
            mode: r.mode,
            dryRun: r.dryRun,
            masked: report.masked,
            anonymous: r.anonymous,
            collections: report.collections.map((c) => ({
              source: c.source,
              target: c.target,
              read: c.read,
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
