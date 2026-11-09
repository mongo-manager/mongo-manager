// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { BSON, MongoBulkWriteError, MongoServerError } from 'mongodb'
import type { AnyBulkWriteOperation, Collection, Db, Document } from 'mongodb'
import { AppError, Errors } from '../errors'
import { serverCode, UNAVAILABLE, writeRefusal } from '../data/mongo-errors'
import {
  guardBulkUpdate,
  guardFilterFor,
  guardInsert,
  isIndexesRefusal,
  restoreReplacement,
  seriesStoredByHidden,
  type GateDeps,
} from '../masking/gate'
import { READ_OPTIONS } from '../data/ejson-io'
import { getPath } from './mapping'
import type { Cell } from './formats/types'

/** A record on its way to MongoDB, with what the rejected-records file needs. */
export interface PendingDoc {
  n: number
  doc: Document
  cells?: Cell[]
  raw?: string
}

export interface WriteCounts {
  inserted: number
  matched: number
  modified: number
  upserted: number
  skipped: number
  /** Backup review M9: inserts refused for a duplicate key whose stored document is this one, byte for byte. */
  alreadyThere?: number
  /**
   * Review of the data fixes (I4): records of a batch the server failed as a whole (a cancel, a
   * time limit, a step-down) beyond what it reported written — they may or may not be stored.
   */
  uncertain?: number
}

export interface TargetWriterInput {
  collection: Collection
  db: string
  coll: string
  mode: 'insert' | 'upsert' | 'merge'
  keys: string[]
  updateOnly: boolean
  ordered: boolean
  /**
   * A record whose _id is null is inserted with that _id, not given a new one by the driver: a
   * restore puts back what was backed up (data review round 2, Minor 3).
   */
  keepNullIds?: boolean
  /**
   * Backup review M9: an insert refused for a duplicate key, where the stored document is the
   * record byte for byte, is already there (a restore run again) — counted, never failed.
   */
  identicalIsDone?: boolean
  /** Told of each record found already there (it was not written). */
  onAlreadyThere?: (p: PendingDoc) => void
  /**
   * CI 2026-10-18: the records are a time series' buckets, written and read through its own name
   * (MongoDB 8.3 on, see backup/series.ts): every operation says so.
   */
  rawData?: boolean
  /** The options a target not yet there will be created with (a dry run's copy; final review, M-4). */
  createdAs?: Document
  /**
   * The target's database: what kind of collection it is (a time series takes no single update).
   * Null where every write is an insert (final review, Minor 4: never left out by mistake).
   */
  targetDb: Db | null
  /** The gate for a restricted caller on this side, else null. */
  gate: GateDeps | null
  /** Code-only MongoDB reasons (a restricted caller on this side). */
  codeOnly: boolean
  comment: string
  timeLeft: () => number
  signal: AbortSignal
  counts: WriteCounts
  /** A record refused by MongoDB or the gate. */
  fail: (p: PendingDoc, reason: string, field?: string, code?: number) => Promise<void>
  stopped: () => boolean
}

/**
 * Final review C4: errors that are about the operation, not the record — a time limit, a cancel, and
 * the server, a shard or a primary not available (a shutdown, a step-down; review of the agent's
 * gate, M-4: one list with the routes' 503). They end the job; they are never a row error.
 */
const JOB_LEVEL = new Set([50, 262, 11601, ...UNAVAILABLE])
export const isJobLevel = (code: unknown): boolean => JOB_LEVEL.has(Number(code))

const isPlainDoc = (v: unknown): v is Document =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

/**
 * Phase 3d-1 spec §6.1 merge: "fields not in the record stay" — within sub-documents too. The record's
 * leaf fields become dotted $set paths; arrays, BSON values and sub-documents whose names could not be
 * a path ($-prefixed, dotted) are set whole. _id is never set (it is matched or set on insert).
 *
 * Data review 2026-10-13 (low): an empty sub-document has no fields to merge, so it changes nothing
 * stored (it replaced the stored one whole); it is made only when the document is new (`onInsert`).
 */
export function mergeSet(doc: Document): Document {
  return mergeParts(doc).set
}

export function mergeParts(doc: Document): { set: Document; onInsert: Document } {
  const set: Document = {}
  const onInsert: Document = {}
  const put = (to: Document, path: string, value: unknown) =>
    Object.defineProperty(to, path, { value, enumerable: true, writable: true, configurable: true })
  const walk = (node: Document, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      if (!prefix && k === '_id') continue
      const path = prefix ? `${prefix}.${k}` : k
      const plain = isPlainDoc(v)
      const keys = plain ? Object.keys(v) : []
      if (plain && !keys.length) put(onInsert, path, v)
      else if (keys.length && keys.every((x) => !x.startsWith('$') && !x.includes('.')))
        walk(v as Document, path)
      else put(set, path, v)
    }
  }
  walk(doc, '')
  return { set, onInsert }
}

/** Spec §6.1 merge: a top-level name that $set would read as a path, or as an operator (3d-1 final review M3). */
export const pathLikeField = (doc: Document): string | undefined =>
  Object.keys(doc).find((k) => k.includes('.') || k.startsWith('$'))

/** $eq: a key value that is a document ({ "$ne": null }) is a value to match, never an operator (3d-1 I4). */
export function keyFilter(keys: string[], doc: Document): Document {
  // Sixteenth review of explain masking (P-1): never an operator, whatever the request said.
  const operator = keys.find((k) => k.split('.').some((s) => s.startsWith('$')))
  if (operator !== undefined)
    throw Errors.validation(`The key "${operator.slice(0, 200)}" cannot start a segment with "$"`, {
      reason: 'bad_key',
    })
  return Object.fromEntries(keys.map((k) => [k, { $eq: getPath(doc, k) }]))
}

/**
 * The key field a record has no value for, in upsert and merge. Data review 2026-10-13 (H1):
 * `$eq: null` matches every stored document without the field — each such record replaced the same
 * unrelated document. A missing key, or a null one, is refused, never written — a null `_id` too
 * (data review M5): it names one document, but every record whose id is empty (a blank cell, a NULL
 * key) would be written into that one.
 */
export function emptyKey(doc: Document, keys: readonly string[]): string | undefined {
  return keys.find((k) => {
    const v = getPath(doc, k)
    return v === undefined || v === null
  })
}

/** Dry-run counts in flight at once (seventeenth review of explain masking, I-2). */
const DRY_COUNTS = 16

/** An upsert or merge into a time series, which MongoDB updates no single document of. */
const SERIES = 'Skipped: MongoDB changes no single document of a time series: only inserts reach one'

/** A restricted upsert or merge where an _id may repeat (final review of explain masking, I-A). */
const TWINS =
  'Skipped: documents here may share an _id, so while personal data is hidden a key cannot be tied to a single document'

/** A restricted write by a key that matches several documents (nineteenth review of explain masking). */
const SEVERAL = 'Skipped: its key matches several documents'

/**
 * Phase 3d-1/3d-2: writes records into a collection — insert, upsert (replace by key) or merge (leaf
 * $set by key) — in batches, or one by one through the 3c gate for a restricted caller. Refusals are
 * reported per record; the import and copy jobs share it.
 */
export class TargetWriter {
  constructor(private readonly input: TargetWriterInput) {}

  // Spec §8.2: MongoDB's message can quote values (E11000 quotes the key); restricted callers get the code.
  // The server's own either way, from under the driver's wrapper (second independent review, Minor 1).
  // A validator's refusal names its rules (research 2026-10-28), never the value that failed.
  private reason(refused: unknown): string {
    return writeRefusal(refused, this.input.codeOnly)
  }

  private filter(doc: Document): Document {
    return keyFilter(this.input.keys, doc)
  }

  /** The server, not the driver, gives an _id to a record without one: a null one stays null. */
  private keepIds(): { forceServerObjectId?: boolean } {
    return this.input.keepNullIds ? { forceServerObjectId: true } : {}
  }

  private raw(): { rawData?: true } {
    return this.input.rawData ? { rawData: true } : {}
  }

  private keyless(doc: Document): string | undefined {
    return this.input.mode === 'insert' ? undefined : emptyKey(doc, this.input.keys)
  }

  private refuseKeyless(p: PendingDoc, key: string): Promise<void> {
    return this.input.fail(
      p,
      key === '_id'
        ? 'The _id is empty: every record without one would be written into the same document; use insert'
        : `The key field "${key}" is empty: with no value it would match an unrelated document`,
      key,
    )
  }

  /**
   * Data review 2026-10-13 (I1): a record with an empty key is refused in its place — the records
   * before it are written first and, when the job stops at a refusal, none after it is.
   */
  async write(batch: PendingDoc[]): Promise<void> {
    let from = 0
    const over = () => this.input.stopped() || this.input.signal.aborted
    for (let i = 0; i < batch.length; i++) {
      const key = this.keyless(batch[i]!.doc)
      if (key === undefined) continue
      if (over()) return
      if (i > from) await this.send(batch.slice(from, i))
      if (over()) return
      await this.refuseKeyless(batch[i]!, key)
      from = i + 1
    }
    if (from < batch.length && !over()) await this.send(from ? batch.slice(from) : batch)
  }

  private async send(batch: PendingDoc[]): Promise<void> {
    if (this.input.mode !== 'insert' && (await this.seriesHere())) {
      for (const p of batch) {
        if (this.input.stopped() || this.input.signal.aborted) return
        await this.input.fail(p, SERIES)
      }
      return
    }
    if (this.input.gate) await this.restricted(batch, this.input.gate)
    else await this.bulk(batch)
  }

  /**
   * The last dry-run batch's records it refused, and those whose key matched a stored document
   * (eighteenth and nineteenth reviews of explain masking, M-1, I-1, M-4): only the last batch's,
   * so nothing is held past it.
   */
  dryRefused = new Set<PendingDoc>()
  dryMatched = new Set<PendingDoc>()

  private seriesAsked?: Promise<boolean>

  /**
   * Whether the target is (or a dry run's copy would create) a time series: MongoDB changes no single
   * document of one ("non-multi update", measured on 8.2), so an upsert or merge by key is refused
   * there, run and dry run alike (final review of explain masking, Minor 2). Asked by name only.
   */
  private seriesHere(): Promise<boolean> {
    const { targetDb, coll, createdAs } = this.input
    if (!targetDb) return Promise.resolve(false)
    this.seriesAsked ??= targetDb
      .listCollections(
        { name: coll },
        {
          nameOnly: true,
          authorizedCollections: true,
          maxTimeMS: this.input.timeLeft(),
          comment: this.input.comment,
        },
      )
      .toArray()
      .then(([info]) => (info ? info.type === 'timeseries' : createdAs?.timeseries !== undefined))
      .catch((e: unknown) => {
        this.seriesAsked = undefined
        throw e
      })
    return this.seriesAsked
  }

  private repeatsAsked?: Promise<boolean>

  /**
   * Whether an _id may repeat here in an order rules hide (asked once per writer; asked again after
   * a failure). A target a dry run's copy has not created is judged by its create options.
   */
  private repeatsHere(g: GateDeps): Promise<boolean> {
    const { db, coll, createdAs } = this.input
    this.repeatsAsked ??= (async () => {
      if ((await guardFilterFor(db, coll, {}, g)).idRepeats) return true
      const series = createdAs?.timeseries as Document | undefined
      if (!series || (await g.kind?.(db, coll)) !== 'missing') return false
      return seriesStoredByHidden(g.masker, db, coll, series)
    })().catch((e: unknown) => {
      this.repeatsAsked = undefined
      throw e
    })
    return this.repeatsAsked
  }

  /** Dry run: how many records' keys match a stored document (upsert and merge). */
  async wouldMatch(all: PendingDoc[]): Promise<number> {
    const { mode, gate, db, coll, collection, comment } = this.input
    // This call's own sets, whatever another call does meanwhile (twentieth review, nit).
    const refused = (this.dryRefused = new Set<PendingDoc>())
    const matchedSet = (this.dryMatched = new Set<PendingDoc>())
    // A record with an empty key matches nothing: it is refused, and the dry run says so (data
    // review M4). Every refusal is said in record order, and with "stop" nothing after the one the
    // real run stops at (round 2, Minor 2; eleventh review of explain masking, M2); nothing is read
    // before the first keyed record (twelfth review, M-3).
    // Tenth review of explain masking (Minor 3): a dry run predicts the refusal of a key that
    // matches several documents where rules apply, as the run makes it.
    const ruled = gate !== null && gate.masker.forNs(db, coll).any
    // As the run refuses it (final review of explain masking, I-A, Minor 2).
    const series = mode !== 'insert' && (await this.seriesHere())
    const twins = !series && gate !== null && mode !== 'insert' && ruled && (await this.repeatsHere(gate))
    // Seventeenth review of explain masking (I-2, M-2): a few counted at once, read in record order;
    // a record the gate or MongoDB refuses is that record's failure, as in the run.
    type Counted = { n: number } | { error: unknown } | { skipped: true } | { refusal: string }
    const counts = new Map<PendingDoc, Promise<Counted>>()
    // Eighteenth review of explain masking (M-2): once the dry run is over (stopped, cancelled,
    // failed), no count starts, and those started are waited for.
    let over = false
    const countOf = (p: PendingDoc): Promise<Counted> => {
      let c = counts.get(p)
      if (!c) {
        c = (async (): Promise<Counted> => {
          try {
            const filter = this.filter(p.doc)
            const guarded = gate ? (await guardFilterFor(db, coll, filter, gate)).filter : filter
            if (over || this.input.signal.aborted) return { skipped: true }
            // Nineteenth review (M-1): a cancel also ends the counts already sent.
            const options = {
              comment,
              maxTimeMS: this.input.timeLeft(),
              signal: this.input.signal,
              ...this.raw(),
            }
            const n = await collection.countDocuments(guarded, { ...options, limit: 2 })
            if (gate && ruled && mode === 'upsert' && n === 1) {
              // Nineteenth and twentieth reviews (M-4, I-1): the one a key matches, where rules
              // apply, is checked as the run checks it (its stored personal values kept or the
              // record refused): read whole, one at a time, never 16 at once.
              const checked = await oneAtATime(async () => {
                // Twenty-first review (Minors 1, 2): none after the dry run is over, in the time
                // left when it starts.
                if (over || this.input.signal.aborted) return false
                const [current] = await collection
                  .find(guarded, { ...READ_OPTIONS, ...options, maxTimeMS: this.input.timeLeft(), limit: 1 })
                  .toArray()
                if (current) await restoreReplacement(db, coll, current, p.doc, gate)
                return true
              })
              // Twenty-second review (M-3): a match not checked is not counted.
              if (!checked) return { skipped: true }
            }
            if (gate && ruled && mode === 'merge' && n === 1) {
              // As the run sets the record's fields: a change of what is hidden is refused.
              const set = mergeSet(p.doc)
              if (Object.keys(set).length) {
                const update = await guardBulkUpdate(db, coll, filter, { $set: set }, gate)
                if ((await collection.countDocuments(update.filter, { ...options, limit: 1 })) === 0)
                  return { refusal: 'Skipped: a field it would change holds personal data' }
              }
            }
            return { n }
          } catch (error) {
            return { error }
          }
        })()
        counts.set(p, c)
      }
      return c
    }
    // Whole documents are read one at a time (twentieth review, I-1).
    let reading: Promise<unknown> = Promise.resolve()
    const oneAtATime = (read: () => Promise<boolean>): Promise<boolean> => {
      const done = reading.then(read)
      reading = done.catch(() => undefined)
      return done
    }
    const keyed = mode === 'insert' ? [] : all.filter((p) => this.keyless(p.doc) === undefined)
    let next = 0
    let at = 0
    let matched = 0
    // Eighteenth review (M-1): the records refused here, so a caller does not refuse them again.
    const refuse = async (p: PendingDoc, reason: string, field?: string, code?: number) => {
      refused.add(p)
      await this.input.fail(p, reason, field, code)
    }
    try {
      for (const p of all) {
        // Seventeenth review (M-1): a cancel stops it as it stops the run.
        if (this.input.stopped() || this.input.signal.aborted) break
        const empty = this.keyless(p.doc)
        if (empty !== undefined) {
          refused.add(p)
          await this.refuseKeyless(p, empty)
          continue
        }
        if (mode === 'insert') continue
        if (series || twins) {
          await refuse(p, series ? SERIES : TWINS)
          continue
        }
        // The keyed records are in record order: this one is keyed[at].
        while (next < keyed.length && next < at + DRY_COUNTS) void countOf(keyed[next++]!)
        at++
        const counted = await countOf(p)
        if ('skipped' in counted) break
        if ('refusal' in counted) {
          await refuse(p, counted.refusal)
          continue
        }
        if ('error' in counted) {
          const e = counted.error
          // A cancel that ended a count ends the dry run as a cancel at the top does (twentieth
          // review, M-1).
          if (this.input.signal.aborted) break
          // As the run: indexes that cannot be read stop it (next review, M-3).
          if (isIndexesRefusal(e)) throw e
          if (e instanceof AppError && e.statusCode === 403) await refuse(p, e.message)
          else if (e instanceof MongoServerError && !isJobLevel(e.code))
            await refuse(p, this.reason(e), undefined, Number(e.code))
          else throw e
          continue
        }
        // Sixteenth review (C-1, I-1): counted by MongoDB, under the target's own collation, two at
        // most, in the time left: nothing of MongoDB's matching guessed here; of the records, only
        // this batch's refused and matched ones are held.
        const n = counted.n
        if (ruled && n > 1) await refuse(p, SEVERAL)
        else if (n > 0) {
          matched++
          matchedSet.add(p)
        }
      }
    } finally {
      over = true
      await Promise.all(counts.values())
    }
    return matched
  }

  private async bulk(all: PendingDoc[]): Promise<void> {
    const { mode, updateOnly, ordered, collection, comment, counts } = this.input
    // Backup review I1: an ordered batch stops at its first error, so a record already there would
    // stop it although nothing failed. Those are found first; one that appears meanwhile (another
    // writer) stops the batch, and what follows it is sent again.
    let batch = all
    if (ordered && this.identicalApplies()) {
      const there = await this.identical(all)
      batch = all.filter((p) => !there.has(p))
    }
    // The records sent, as the operations are numbered; and those of a merge with nothing to set,
    // which change nothing stored — counted as skipped, as the one-by-one path counts them (review of
    // the data fixes): with "update only" they are not even sent.
    const sent: PendingDoc[] = []
    const empties: number[] = []
    const ops: AnyBulkWriteOperation[] = []
    for (const p of batch) {
      if (mode === 'insert') ops.push({ insertOne: { document: p.doc } })
      // "Update only" holds for upsert too (data review 2026-10-13): a record with no match is skipped.
      else if (mode === 'upsert')
        ops.push({ replaceOne: { filter: this.filter(p.doc), replacement: p.doc, upsert: !updateOnly } })
      else {
        const { set, onInsert } = mergeParts(p.doc)
        const update: Document = {}
        if (Object.keys(set).length) update.$set = set
        else if (updateOnly) {
          counts.skipped++
          continue
        } else empties.push(ops.length)
        const insertOnly = { ...onInsert, ...(p.doc._id !== undefined ? { _id: p.doc._id } : {}) }
        if (Object.keys(insertOnly).length) update.$setOnInsert = insertOnly
        ops.push({ updateOne: { filter: this.filter(p.doc), update, upsert: !updateOnly } })
      }
      sent.push(p)
    }
    if (!ops.length) return
    /** Of the merges with nothing to set that were tried, those not inserted matched: nothing changed. */
    const nothingChanged = (upserted: Record<number, unknown> | undefined, tried: (i: number) => boolean) => {
      const n = empties.filter((i) => tried(i) && upserted?.[i] === undefined).length
      counts.matched -= n
      counts.skipped += n
    }
    try {
      const r = await collection.bulkWrite(ops, {
        ordered,
        comment,
        maxTimeMS: this.input.timeLeft(),
        ...this.keepIds(),
        ...this.raw(),
      })
      counts.inserted += r.insertedCount
      counts.matched += r.matchedCount
      counts.modified += r.modifiedCount
      counts.upserted += r.upsertedCount
      // Review of the data fixes (I3): with "update only", a record that matched nothing is skipped —
      // counted, as the one-by-one path counts it, so every record read is accounted for.
      if (updateOnly && mode !== 'insert') counts.skipped += ops.length - r.matchedCount - r.upsertedCount
      nothingChanged(r.upsertedIds, () => true)
    } catch (e) {
      // Review of the data fixes (I4): what the server reported written is counted before anything
      // else; the rest of a batch failed as a whole may or may not be stored.
      const known = e instanceof MongoBulkWriteError ? e.result : null
      if (known) {
        counts.inserted += known.insertedCount
        counts.matched += known.matchedCount
        counts.modified += known.modifiedCount
        counts.upserted += known.upsertedCount
      }
      if (!(e instanceof MongoBulkWriteError)) {
        counts.uncertain = (counts.uncertain ?? 0) + ops.length
        throw e
      }
      // Final review C4: the driver wraps a command-level failure (network, time limit, step-down, or
      // a batch MongoDB refused as IllegalOperation under its own wrapper) as a bulk error with no
      // write errors — nothing says which records were written: the job fails, with the server's
      // reason (third independent review, nit 5).
      const writeErrors = Array.isArray(e.writeErrors) ? e.writeErrors : e.writeErrors ? [e.writeErrors] : []
      if (writeErrors.length === 0 || writeErrors.some((w) => isJobLevel(w.code))) {
        const written = e.result.insertedCount + e.result.matchedCount + e.result.upsertedCount
        counts.uncertain = (counts.uncertain ?? 0) + Math.max(0, ops.length - written)
        throw e
      }
      if (updateOnly && mode !== 'insert') {
        // Ordered, the batch stopped at its first error; unordered, every record was tried.
        const tried = ordered ? writeErrors[0]!.index + 1 : ops.length
        counts.skipped += Math.max(
          0,
          tried - e.result.matchedCount - e.result.upsertedCount - writeErrors.length,
        )
      }
      const failed = new Set(writeErrors.map((w) => w.index))
      const stop = ordered ? writeErrors[0]!.index : Infinity
      nothingChanged(e.result.upsertedIds, (i) => i < stop && !failed.has(i))
      // Backup review M9: a document already stored as the record has it is already there.
      const there = await this.alreadyThere(writeErrors.map((w) => ({ code: w.code, p: sent[w.index]! })))
      for (const w of writeErrors) {
        const p = sent[w.index]!
        if (there.has(p)) continue
        await this.input.fail(p, this.reason(w), undefined, Number(w.code))
      }
      // Backup review I1: stopped at a record that was already there, nothing failed: the rest goes.
      if (ordered && there.has(sent[stop]!) && stop + 1 < sent.length && !this.input.stopped())
        await this.bulk(sent.slice(stop + 1))
    }
  }

  private identicalApplies(): boolean {
    return this.input.identicalIsDone === true && this.input.mode === 'insert'
  }

  /**
   * Backup review I2: the records whose _id is stored with the very same document — already there,
   * as the real run counts them (a dry run asks before writing).
   */
  identical(batch: PendingDoc[]): Promise<Set<PendingDoc>> {
    return this.alreadyThere(batch.map((p) => ({ code: 11000, p })))
  }

  /**
   * Backup review M9: of the inserts refused for a duplicate key, those whose stored document is the
   * record byte for byte (same fields, order and types) — counted as already there.
   */
  private async alreadyThere(refused: Array<{ code: unknown; p: PendingDoc }>): Promise<Set<PendingDoc>> {
    const out = new Set<PendingDoc>()
    if (!this.identicalApplies()) return out
    const dupes = refused.filter((r) => Number(r.code) === 11000 && r.p.doc._id !== undefined).map((r) => r.p)
    if (!dupes.length) return out
    const bson = (d: Document) => Buffer.from(BSON.serialize(d))
    const idKey = (id: unknown) => bson({ _id: id }).toString('hex')
    const byId = new Map(dupes.map((p) => [idKey(p.doc._id), p]))
    // Review M7: within the job's time, and compared one by one as they come (a stored document may
    // be much larger than the record).
    const stored = this.input.collection.find(
      { _id: { $in: dupes.map((p) => p.doc._id) } },
      { ...READ_OPTIONS, comment: this.input.comment, maxTimeMS: this.input.timeLeft(), ...this.raw() },
    )
    for await (const d of stored) {
      const p = byId.get(idKey(d._id))
      if (p && bson(d).equals(bson(p.doc))) out.add(p)
    }
    this.input.counts.alreadyThere = (this.input.counts.alreadyThere ?? 0) + out.size
    this.input.counts.skipped += out.size
    for (const p of out) this.input.onAlreadyThere?.(p)
    return out
  }

  // 3d-1 plan ruling 7: a restricted merge finds first with the guarded filter and never upserts.
  private async restricted(batch: PendingDoc[], g: GateDeps): Promise<void> {
    const { mode, updateOnly, db, coll: collName, collection, comment, counts, fail } = this.input
    const ruled = g.masker.forNs(db, collName).any
    // Final review of explain masking (I-A): where an _id may repeat in an order rules hide, a key's
    // match is no one document, whatever pins it: an upsert or merge by key is refused.
    const twins = mode !== 'insert' && ruled && (await this.repeatsHere(g))
    for (const p of batch) {
      if (this.input.stopped() || this.input.signal.aborted) return
      if (twins) {
        await fail(p, TWINS)
        continue
      }
      const options = { comment, maxTimeMS: this.input.timeLeft(), ...this.keepIds(), ...this.raw() }
      try {
        if (mode === 'insert') {
          await guardInsert(db, collName, [p.doc], g)
          try {
            await collection.insertOne(p.doc, options)
          } catch (e) {
            if (e instanceof MongoServerError && (await this.alreadyThere([{ code: e.code, p }])).has(p))
              continue
            throw e
          }
          counts.inserted++
          continue
        }
        const filter = (await guardFilterFor(db, collName, this.filter(p.doc), g)).filter
        if (mode === 'upsert') {
          // 3d-1 final review I3: a replacement, as the documents view makes one: stored personal
          // values must stay where they are, and the write applies only to the version read.
          // Nineteenth and tenth reviews of explain masking (I3, Minors 2, 4): the first a key
          // matches is in an order that may follow a hidden value (an index's, a time series'
          // storage): where rules apply, a key that matches several documents is refused, read once.
          // Twenty-first review of explain masking (nit): where rules apply, the matches are told by
          // their _ids; one document at most is read whole.
          const ids = ruled
            ? await collection
                .find(filter, { ...READ_OPTIONS, projection: { _id: 1 }, ...options, limit: 2 })
                .toArray()
            : null
          if (ids && ids.length > 1) {
            await fail(p, SEVERAL)
            continue
          }
          const one = ids ? (ids[0] ? { $and: [filter, { _id: { $eq: ids[0]._id } }] } : null) : filter
          const [current] = one
            ? await collection.find(one, { ...READ_OPTIONS, ...options, limit: 1 }).toArray()
            : []
          // Twenty-second review (M-2): one it matched a moment ago, gone now, is not inserted.
          if (!current && ids?.length === 1 && !updateOnly) {
            await fail(p, 'Skipped: the document changed while it was imported')
            continue
          }
          if (current) {
            const replacement = await restoreReplacement(db, collName, current, p.doc, g)
            const pinned = {
              _id: { $eq: current._id },
              $expr: { $eq: ['$$ROOT', { $literal: current }] },
            }
            const r = await collection.replaceOne(pinned, replacement, {
              ...options,
              collation: { locale: 'simple' },
            })
            if (r.matchedCount === 0) {
              await fail(p, 'Skipped: the document changed while it was imported')
              continue
            }
            counts.matched += r.matchedCount
            counts.modified += r.modifiedCount
          } else if (updateOnly) counts.skipped++
          else {
            await guardInsert(db, collName, [p.doc], g)
            await collection.insertOne(p.doc, options)
            counts.upserted++
          }
          continue
        }
        const matched = await collection
          .find(filter, { ...READ_OPTIONS, projection: { _id: 1 }, ...options, limit: 2 })
          .toArray()
        if (ruled && matched.length > 1) {
          await fail(p, SEVERAL)
          continue
        }
        const exists = matched[0]
        if (exists) {
          const set = mergeSet(p.doc)
          if (!Object.keys(set).length) {
            counts.skipped++
            continue
          }
          const guarded = await guardBulkUpdate(db, collName, this.filter(p.doc), { $set: set }, g)
          // Final review of explain masking (I-1): where rules apply, the one checked, never a twin
          // added since, which would come first in a hidden index's order.
          const checked = { _id: { $eq: exists._id } }
          const r = await collection.updateOne(
            ruled ? { $and: [guarded.filter, checked] } : guarded.filter,
            guarded.update as Document,
            options,
          )
          if (r.matchedCount === 0) {
            // Final review (M-2): gone or re-keyed since, it changed; there, a hidden field it
            // would change.
            const there = ruled
              ? await collection.countDocuments({ $and: [filter, checked] }, { ...options, limit: 1 })
              : 0
            await fail(
              p,
              there
                ? 'Skipped: a field it would change holds personal data'
                : 'Skipped: the document changed while it was imported',
            )
            continue
          }
          counts.matched += r.matchedCount
          counts.modified += r.modifiedCount
        } else if (!updateOnly) {
          await guardInsert(db, collName, [p.doc], g)
          await collection.insertOne(p.doc, options)
          counts.upserted++
        } else counts.skipped++
      } catch (e) {
        // Indexes that could not be read refuse every record alike: the job's (review of the agent's gate).
        if (isIndexesRefusal(e)) throw e
        if (e instanceof AppError && e.statusCode === 403) await fail(p, e.message)
        else if (e instanceof MongoServerError && !isJobLevel(serverCode(e)))
          await fail(p, this.reason(e), undefined, Number(serverCode(e)))
        else throw e
      }
    }
  }
}
