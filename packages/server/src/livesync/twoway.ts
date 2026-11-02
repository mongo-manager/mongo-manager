import { createHash } from 'node:crypto'
import type { ClientSession, Collection, Document } from 'mongodb'
import { sameDocument } from '../transfer/merge-join'
import { idKey } from './apply'
import { tsText } from './repo'
import { READ_OPTIONS } from '../data/ejson-io'

/**
 * W4.6 (completion design §2 W4.6): two-way sync — two linked one-way syncs between the same two
 * collections, each the other's mirror image, and what they share while they run.
 *
 * - **Loop prevention marks.** Each direction writes inside transactions of its own session; MongoDB
 *   puts that session's id (`lsid`) and the transaction's number (`txnNumber`) on the change events
 *   of those writes, so the other direction knows them as echoes and skips them: the session's id,
 *   with a transaction number above the one it had when the direction took it (W4 review: a pooled
 *   session id may have carried other writes before). Nothing is added to the documents.
 * - **Conditional writes.** A change is applied only where the other side still holds what the source
 *   held before it (the change's pre-image), compared whole with `$$ROOT`. Otherwise both sides
 *   changed the document: a conflict.
 * - **Last writer wins.** A conflict is settled when the other side's change arrives: the later wall
 *   time wins (a tie: the forward direction's source), the winner's document goes to the loser's side,
 *   and the conflict is listed. When no change of the other side arrives once the other direction's
 *   stream has read past the moment the mismatch was seen, the other side simply differed: the
 *   change, the latest known, is applied.
 * - **Settled on cluster time** (W4 review C2). The mismatch is read in a snapshot transaction on the
 *   other side's cluster; its operation time is that cluster's own clock. The other direction reads
 *   that very cluster's change stream, so once its stream has passed that time, every change the
 *   read saw has been delivered to it — no wall clock (the app host's, or either cluster's) decides
 *   when a change is "not a conflict". Wall times decide only which of two conflicting changes wins.
 * - A change already applied (a batch read again after a restart) is recognised by its result being
 *   there already; a change that lost is remembered (by a hash of its `_id` and its time) so a batch
 *   read again does not bring it back.
 */
export type Side = 'forward' | 'reverse'
export const otherSide = (s: Side): Side => (s === 'forward' ? 'reverse' : 'forward')

/** Losing changes remembered per direction, and for how long. */
export const LOST_KEPT = 1_000
export const LOST_KEPT_MS = 24 * 3600_000

export interface Pending {
  side: Side
  /** The change's wall time (ms): which of two conflicting changes wins. */
  at: number
  /** The change's cluster time on its own side ("t.i"): a refused change is skipped by it. */
  time: string
  /**
   * W4 review C2: the cluster time ("t.i") of the other side when the mismatch was read there. Due
   * once the other direction's stream has read through it (TwoWayPair.read).
   */
  seen: string
  /** What its side holds now: the document, or null for a delete. */
  post: Document | null
  /** The `_id` itself (to write by). */
  id: unknown
  /**
   * W4 re-review I2: what the other side held when last read — written over only while it still does
   * (undefined: not known, written as before).
   */
  expected?: Document | null
  /** waiting: for the other side's change, or for it to read past; won: the other side lost to it. */
  state: 'waiting' | 'won'
  /** The registry key (the `_id` as canonical EJSON). */
  key: string
  /** Where its stream stood just before it: the place a restart holds while it waits (null: the start). */
  held: Place | null
}

/** A place in a stream: a resume token and its cluster time ("t.i"). */
export interface Place {
  token: unknown
  time: string
}

export interface ConflictNote {
  /** Canonical EJSON of the `_id`, cut (never a field value). */
  id: string
  winner: Side
  winnerAt: number
  loserAt: number
  /** "both": both sides changed it; "differed": the other side differed with no change seen. */
  kind: 'both' | 'differed'
}

/** The two directions' shared state, kept by the runner while either runs. */
export class TwoWayPair {
  readonly pending = new Map<string, Pending>()
  /**
   * W4 review C2: how far each direction's stream has read its source, as that cluster's time ("t.i"):
   * every change up to it, included, has been through the direction.
   */
  readonly read: Record<Side, string> = { forward: '0.0', reverse: '0.0' }
  /**
   * Both directions' session ids (hex), with the transaction number each had when taken: their
   * writes (a higher number) come back as echoes.
   */
  readonly echo = new Map<string, number>()
}

/** W4 review (minor): an echo mark as kept with a sync ("hex:txn"; a bare id, from before: any txn). */
export const echoMark = (hex: string, txn: number) => `${hex}:${txn}`
export function readEchoMark(mark: string): [string, number] {
  const [hex, txn] = mark.split(':')
  const n = Number(txn)
  return [hex!, txn === undefined || !Number.isSafeInteger(n) ? -1 : n]
}

/** The cluster time just before `time` ("t.i"): what a stream has read through when `time` may go on. */
export function before(time: string): string {
  const [t, i] = time.split('.').map(Number) as [number, number]
  return i > 0 ? `${t}.${i - 1}` : `${Math.max(0, t - 1)}.4294967295`
}

export const lostKey = (id: unknown) => createHash('sha256').update(idKey(id)).digest('hex').slice(0, 32)

const ID_TEXT = 200
const cut = (id: unknown) => idKey(id).slice(0, ID_TEXT)

/** The session id of a change event's transaction (hex), or null. */
export function lsidOf(e: Document): string | null {
  const id = (e.lsid as { id?: { buffer?: Uint8Array; toString(enc: string): string } } | undefined)?.id
  return id && typeof id.toString === 'function' ? id.toString('hex') : null
}

export interface TwoWayChange {
  id: unknown
  key: string
  op: 'insert' | 'update' | 'replace' | 'delete'
  at: number
  /** Its cluster time ("t.i"). */
  time: string
  pre: Document | null
  post: Document | null
  /** Where the stream stood just before this change (null: at the sync's start). */
  before: Place | null
}

/** The data events of a batch as two-way changes; echoes of the pair's own writes are left out. */
export function changesOf(
  events: Document[],
  echo: ReadonlyMap<string, number>,
  start: Place | null,
): {
  changes: TwoWayChange[]
  echoes: number
} {
  const changes: TwoWayChange[] = []
  let echoes = 0
  let before = start
  for (const e of events) {
    const time = e.clusterTime ? tsText(e.clusterTime as never) : null
    const op = String(e.operationType)
    if (op === 'insert' || op === 'update' || op === 'replace' || op === 'delete') {
      const lsid = lsidOf(e)
      const taken = lsid === null ? undefined : echo.get(lsid)
      if (taken !== undefined && txnOf(e) > taken) echoes++
      else {
        const id = (e.documentKey as { _id?: unknown } | undefined)?._id
        changes.push({
          id,
          key: idKey(id),
          op,
          at: e.wallTime instanceof Date ? e.wallTime.getTime() : 0,
          time: time ?? '0.0',
          pre: (e.fullDocumentBeforeChange as Document | null | undefined) ?? null,
          post: op === 'delete' ? null : ((e.fullDocument as Document | null | undefined) ?? null),
          before,
        })
      }
    }
    if (time) before = { token: e._id, time }
  }
  return { changes, echoes }
}

/** A change event's transaction number (-1: none). */
function txnOf(e: Document): number {
  const n = Number((e.txnNumber as { toString(): string } | number | undefined)?.toString() ?? -1)
  return Number.isSafeInteger(n) ? n : -1
}

/** A mismatch says what the other side holds (W4 re-review I2: a later write is made only over it). */
export type Outcome = { kind: 'applied' } | { kind: 'already' } | { kind: 'mismatch'; holds: Document | null }

/**
 * One change as a conditional write on the other side (inside the caller's snapshot transaction):
 * applied where the other side holds the pre-image, "already" where it holds the result, else a
 * mismatch. W4 re-review 2 (I1): the document there is read and compared here — with their values'
 * types (READ_OPTIONS, as the change stream reads them: W4 final review), so a Double that holds an
 * integer is not the Int32 (a JavaScript object puts number-like field names first, at any depth:
 * a comparison MongoDB made in field order would never match such a document) — then written by
 * `_id` alone — the
 * snapshot transaction's write-conflict check keeps the read and the write one.
 */
export async function applyOne(coll: Collection, c: TwoWayChange, session: ClientSession): Promise<Outcome> {
  const there = await coll.findOne({ _id: c.id } as Document, { session, ...READ_OPTIONS })
  if (c.op === 'insert') {
    if (there === null) {
      await coll.insertOne(c.post!, { session })
      return { kind: 'applied' }
    }
    return same(there, c.post) ? { kind: 'already' } : { kind: 'mismatch', holds: there }
  }
  if (c.pre && there !== null && same(there, c.pre)) {
    if (c.op === 'delete') await coll.deleteOne({ _id: c.id } as Document, { session })
    else await coll.replaceOne({ _id: c.id } as Document, c.post!, { session })
    return { kind: 'applied' }
  }
  if (c.op === 'delete') return there === null ? { kind: 'already' } : { kind: 'mismatch', holds: there }
  return same(there, c.post) ? { kind: 'already' } : { kind: 'mismatch', holds: there }
}

/** Two documents as the driver reads them, the same (null only with null). */
const same = (doc: Document | null, want: Document | null) =>
  doc === null || want === null ? doc === want : sameDocument(doc, want, [])

/**
 * W4 re-review I2: a change written where the other side still holds `expected` (what it held when
 * last read: the mismatch, or the change that lost), and nowhere else — compared here, then written by
 * `_id` alone (W4 re-review 2, I1). Inside the caller's snapshot transaction. Answers what the other
 * side holds when it did not.
 */
export async function forceIf(
  coll: Collection,
  id: unknown,
  post: Document | null,
  expected: Document | null,
  session: ClientSession,
): Promise<{ ok: true } | { ok: false; holds: Document | null }> {
  const there = await coll.findOne({ _id: id } as Document, { session, ...READ_OPTIONS })
  if (!same(there, expected)) return { ok: false, holds: there }
  if (post === null) {
    if (there !== null) await coll.deleteOne({ _id: id } as Document, { session })
  } else if (there === null) await coll.insertOne(post, { session })
  else await coll.replaceOne({ _id: id } as Document, post, { session })
  return { ok: true }
}

/** A winner's document written over whatever the other side holds (inside the caller's transaction). */
export async function force(
  coll: Collection,
  id: unknown,
  post: Document | null,
  session: ClientSession,
): Promise<void> {
  if (post === null) await coll.deleteOne({ _id: id } as Document, { session })
  else await coll.replaceOne({ _id: id } as Document, post, { upsert: true, session })
}

export const conflictNote = (
  id: unknown,
  winner: Side,
  winnerAt: number,
  loserAt: number,
  kind: ConflictNote['kind'],
): ConflictNote => ({ id: cut(id), winner, winnerAt, loserAt, kind })
