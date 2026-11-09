// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { EJSON } from 'bson'
import type { Document, MongoClient } from 'mongodb'
import {
  LIVE_SYNC_LIMITS,
  serializeValue,
  type LiveSyncVerify,
  type LiveSyncVerifyPair,
} from '@mongo-manager/shared'
import type { ServerContext } from '../http/context'
import { sorted } from '../transfer/compare-job'
import { diffSample, mergeJoin, sameDocument } from '../transfer/merge-join'
import { clip, clipRecord } from '../transfer/clip'
import { maskWith } from '../transfer/copy-job'
import { checkSync, errorTextFor } from './checks'
import { idKey } from './apply'
import { operationTime } from './plan'
import type { LiveSyncRecord } from './repo'

/** Up to this many `_id`s still different after settling, per collection (no document bodies). */
export const SAMPLE_IDS = 20
/** W4.6: samples per group and collection, and characters of samples in one verification. */
export const SAMPLES_PER_GROUP = 10
export const SAMPLE_CHARS = 300_000
const RECHECK_CHUNK = 1000

export interface VerifyDeps {
  ctx: ServerContext
  /** Resolves true once the sync applied every change up to `time` (read at `since`), false if it gave up. */
  settled(time: string, since: number, signal: AbortSignal): Promise<boolean>
  maxTimeMS?: number
}

class Aborted extends Error {}

async function byIds(
  client: MongoClient,
  db: string,
  coll: string,
  ids: unknown[],
): Promise<Map<string, Document>> {
  const out = new Map<string, Document>()
  for (let i = 0; i < ids.length; i += RECHECK_CHUNK) {
    const docs = await client
      .db(db)
      .collection(coll)
      .find({ _id: { $in: ids.slice(i, i + RECHECK_CHUNK) } } as Document, { comment: 'mm-live-verify' })
      .toArray()
    for (const d of docs) out.set(idKey(d._id), d)
  }
  return out
}

/**
 * Phase 3e-2 spec §1.5, plan ruling 8: the 3d-2 merge join between source and target, then the
 * suspects (at most 10,000 per collection) read again once the sync applied everything up to the
 * comparison's end. A masked sync compares the masked source. The report keeps `_id`s, never bodies.
 */
export async function verifySync(
  d: VerifyDeps,
  r: LiveSyncRecord,
  signal: AbortSignal,
  settle: boolean,
): Promise<LiveSyncVerify> {
  const { ctx } = d
  const startedAt = Date.now()
  try {
    const check = checkSync(ctx, r)
    if (!check.ok)
      return { state: 'failed', startedAt, finishedAt: Date.now(), pairs: [], error: check.reason }
    const [source, target] = await Promise.all([
      ctx.manager.getClient(r.source.connectionId),
      ctx.manager.getClient(r.target.connectionId),
    ])
    const maxTime = d.maxTimeMS ?? 3_600_000
    const comment = `mm-live-verify:${r.id}`
    const pairs: LiveSyncVerifyPair[] = []
    let settledAll = true
    const budget = { left: SAMPLE_CHARS }
    const ctxRules = {
      source: ctx.personalFields.get(r.source.connectionId).version,
      target: ctx.personalFields.get(r.target.connectionId).version,
    }
    // Final review m13: one collection at a time — joined, settled and read again — so at most one
    // collection's suspects are held at once.
    for (const [s, t] of r.options.pairs) {
      const mask = check.maskFor(r.source.db, s)
      const view = (doc: Document) => (mask ? maskWith(doc, mask) : doc)
      const pair: LiveSyncVerifyPair = {
        source: s,
        target: t,
        same: 0,
        different: 0,
        onlySource: 0,
        onlyTarget: 0,
        unsettled: 0,
        ids: [],
      }
      const suspects: unknown[] = []
      const join = mergeJoin(
        sorted(source, r.source.db, s, {}, comment, maxTime),
        sorted(target, r.target.db, t, {}, comment, maxTime),
        (x, y) => sameDocument(view(x), y, []),
      )
      for await (const e of join) {
        if (signal.aborted) throw new Aborted()
        if (e.kind === 'same') pair.same++
        else if (suspects.length < LIVE_SYNC_LIMITS.verifySuspects)
          suspects.push(e.kind === 'onlyTarget' ? e.target._id : e.source._id)
        else {
          pair[e.kind]++
          pair.unsettled++
        }
      }
      // Settling: what the sync had not applied yet when the join passed it is read again.
      if (settle && suspects.length) {
        const since = Date.now()
        const time = await operationTime(source)
        if (!(await d.settled(time, since, signal))) settledAll = false
      }
      if (signal.aborted) throw new Aborted()
      const [inSource, inTarget] = await Promise.all([
        byIds(source, r.source.db, pair.source, suspects),
        byIds(target, r.target.db, pair.target, suspects),
      ])
      for (const id of suspects) {
        const key = idKey(id)
        const s = inSource.get(key)
        const t = inTarget.get(key)
        if (!s && !t) continue
        const kind = !t
          ? 'onlySource'
          : !s
            ? 'onlyTarget'
            : sameDocument(mask ? maskWith(s, mask) : s, t, [])
              ? 'same'
              : 'different'
        pair[kind]++
        if (kind !== 'same' && pair.ids.length < SAMPLE_IDS)
          pair.ids.push(EJSON.serialize(id, { relaxed: false }))
        // W4.6: what differs, as the 3d-2 compare report shows it — the source as the sync writes it
        // (masked when it masks), bounded per group and across the verification.
        if (kind !== 'same' && budget.left > 0) {
          const samples = (pair.samples ??= { onlySource: [], onlyTarget: [], different: [] })
          const list = samples[kind]
          if (list.length < SAMPLES_PER_GROUP) {
            const sample =
              kind === 'different'
                ? diffSample(view(s!), t!, [])
                : {
                    id: clip(serializeValue(id), { left: 2_000 }),
                    doc: clipRecord(kind === 'onlySource' ? view(s!) : t!),
                  }
            budget.left -= JSON.stringify(sample).length
            ;(list as unknown[]).push(sample)
          }
        }
      }
      pairs.push(pair)
    }
    return {
      state: 'done',
      startedAt,
      finishedAt: Date.now(),
      pairs,
      versions: ctxRules,
      ...(settledAll ? {} : { error: 'not_settled' }),
    }
  } catch (e) {
    // Final review m13: either side may have raised it.
    const error = e instanceof Aborted ? 'aborted' : errorTextFor(ctx, r, 'either', e)
    return { state: 'failed', startedAt, finishedAt: Date.now(), pairs: [], error }
  }
}
