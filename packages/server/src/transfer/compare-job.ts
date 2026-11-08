// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document, MongoClient } from 'mongodb'
import { serializeValue, type CompareCollectionReport, type CompareReport } from '@mongo-manager/shared'
import type { JobKind } from '../jobs/types'
import type { ServerContext } from '../http/context'
import { killByComment } from '../data/operations'
import { READ_OPTIONS } from '../data/ejson-io'
import { HIDDEN_JOB_ERROR } from '../jobs/visibility'
import { BATCH_DOCS } from './limits'
import { clip, clipRecord } from './clip'
import { Errors } from '../errors'
import { diffSample, mergeJoin, sameDocument } from './merge-join'
import { maskWith } from './copy-job'
import type { PreparedCompare } from './compare-access'

/** Final review I3: at most this many characters of samples in one comparison's report. */
const REPORT_CHARS = 1_500_000

export interface CompareJobParams {
  owner: string
  prepared: Omit<PreparedCompare, 'sourceClient' | 'targetClient'>
  source: { connectionId: string; db: string; coll: string | null }
  target: { connectionId: string; db: string; coll: string | null }
  /** The user's filter as they sent it (canonical EJSON), kept in the report for the sync. */
  filter: Record<string, unknown>
  ignore: string[]
  sampleLimit: { perGroup: number; total: number }
}

/** Both sides in _id order with the simple collation (spec §6.1). */
export function sorted(
  client: MongoClient,
  db: string,
  coll: string,
  filter: Document,
  comment: string,
  maxTimeMS: number,
) {
  return client
    .db(db)
    .collection(coll)
    .find(filter, {
      ...READ_OPTIONS,
      sort: { _id: 1 },
      collation: { locale: 'simple' },
      allowDiskUse: true,
      batchSize: BATCH_DOCS,
      comment,
      maxTimeMS,
    })
}

/** Phase 3d-2 spec §6: the compare job — counts per group, bounded samples, a report for the sync. */
export function compareKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  ctx: () => ServerContext
  /** Kills the operations tagged with a comment; tests replace it. */
  kill?: (client: MongoClient, comment: string) => Promise<number>
}): JobKind<CompareJobParams> {
  const kill = deps.kill ?? killByComment
  return {
    name: 'data.compare',
    async run(job, p) {
      const ctx = deps.ctx()
      const { limits, reports } = ctx.transfer
      const started = Date.now()
      const timeLeft = () => Math.max(1, limits.maxJobMs - (Date.now() - started))
      const source = await deps.client(p.source.connectionId)
      const target = await deps.client(p.target.connectionId)
      const masked = p.prepared.pairs.some((x) => x.union !== null)
      const report: CompareReport = {
        kind: 'compare',
        source: p.source,
        target: p.target,
        filter: p.filter,
        ignore: p.ignore,
        collections: [],
        masked,
        versions: p.prepared.versions,
        expiresAt: ctx.now() + limits.ttlMs,
        complete: false,
        missingRules: p.prepared.missingRules,
        restricted: { source: p.prepared.sourceMasker !== null, target: p.prepared.targetMasker !== null },
      }
      let samples = 0
      // Final review I3: the whole report stays bounded, whatever the documents hold.
      let reportLeft = REPORT_CHARS
      const take = <T>(list: T[], sample: T) => {
        const size = JSON.stringify(sample).length
        if (size > reportLeft) return
        reportLeft -= size
        list.push(sample)
        samples++
      }
      let threw = false
      try {
        for (const pair of p.prepared.pairs) {
          if (job.signal.aborted) break
          const out: CompareCollectionReport = {
            source: pair.source,
            target: pair.target,
            onlySource: 0,
            onlyTarget: 0,
            different: 0,
            same: 0,
            samples: { onlySource: [], onlyTarget: [], different: [] },
          }
          report.collections.push(out)
          // Spec §5.3: what the caller may see of each side, before anything is compared.
          const view = (d: Document) => (pair.union ? maskWith(d, pair.union) : d)
          const room = (list: unknown[]) =>
            list.length < p.sampleLimit.perGroup && samples < p.sampleLimit.total
          const total = await source
            .db(p.source.db)
            .collection(pair.source)
            .estimatedDocumentCount({ comment: job.comment, maxTimeMS: timeLeft() })
          const sampleId = (d: Document) => clip(serializeValue(view(d)._id), { left: 2_000 })
          const s = sorted(source, p.source.db, pair.source, pair.sourceFilter, job.comment, timeLeft())
          const t = sorted(target, p.target.db, pair.target, pair.targetFilter, job.comment, timeLeft())
          let seen = 0
          try {
            for await (const e of mergeJoin(s, t, (x, y) =>
              sameDocument(view(x), view(y), p.prepared.ignore),
            )) {
              if (job.signal.aborted) break
              // Final review C4: the job's own deadline, not only each operation's.
              if (timeLeft() <= 1) throw Errors.conflict('The comparison ran longer than allowed')
              if (e.kind === 'onlySource') {
                out.onlySource++
                if (room(out.samples.onlySource))
                  take(out.samples.onlySource, { id: sampleId(e.source), doc: clipRecord(view(e.source)) })
              } else if (e.kind === 'onlyTarget') {
                out.onlyTarget++
                if (room(out.samples.onlyTarget))
                  take(out.samples.onlyTarget, { id: sampleId(e.target), doc: clipRecord(view(e.target)) })
              } else if (e.kind === 'different') {
                out.different++
                if (room(out.samples.different))
                  take(out.samples.different, diffSample(view(e.source), view(e.target), p.prepared.ignore))
              } else out.same++
              if (e.kind !== 'onlyTarget') job.progress(++seen, Math.max(total, seen))
            }
          } catch (e) {
            out.failure = masked ? HIDDEN_JOB_ERROR : (e as Error).message.slice(0, 300)
            throw e
          } finally {
            await Promise.all([s.close().catch(() => undefined), t.close().catch(() => undefined)])
          }
        }
        // Final review I9: only a comparison that reached the end of every collection can be synced.
        report.complete = !job.signal.aborted
      } catch (e) {
        threw = true
        throw e
      } finally {
        reports.save(job.id, p.owner, report, report.expiresAt)
        ctx.audit.append({
          action: 'transfer.compare',
          outcome: threw || job.signal.aborted ? 'failure' : 'success',
          userId: p.owner === 'local' ? null : p.owner,
          username: null,
          ip: null,
          connectionId: p.source.connectionId,
          namespace: p.source.db,
          details: {
            job: job.id,
            target: p.target.connectionId,
            targetDb: p.target.db,
            collections: report.collections.map((c) => ({
              source: c.source,
              onlySource: c.onlySource,
              onlyTarget: c.onlyTarget,
              different: c.different,
              same: c.same,
            })),
          },
        })
      }
    },
    // Spec §8.1: cancel ends the reads on both connections.
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
