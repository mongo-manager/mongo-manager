// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { CreateIndexesOptions, Document, IndexSpecification, MongoClient } from 'mongodb'
import { withMongo } from '../data/mongo-errors'
import { currentOps, findOperation } from './current-op'
import type { JobContext, JobKind } from './types'

export interface IndexJobParams {
  key: IndexSpecification
  options: CreateIndexesOptions
}

/** The name MongoDB gives an index without one: each key and its value, joined by "_". */
export const defaultIndexName = (key: Record<string, unknown>): string =>
  Object.entries(key)
    .map(([k, v]) => `${k}_${String(v)}`)
    .join('_')

/** How often running builds are asked for their progress, per connection (phase 1h spec §3). */
export const PROGRESS_POLL_MS = 2_000

const buildOf = (ctx: JobContext): Document => ({
  ns: `${ctx.target.db}.${ctx.target.coll}`,
  $or: [
    { 'command.comment': ctx.comment },
    // The driver does not pass a comment to createIndexes: the build is found by its index name.
    { 'command.createIndexes': ctx.target.coll, 'command.indexes.name': ctx.target.target },
  ],
})

const count = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint' ? Number(v) : null)

/**
 * Index builds as jobs. MongoDB reports a build's progress in $currentOp, so the job carries
 * measured progress; a build is cancelled by dropping its index, which aborts it (MongoDB 4.4+,
 * so every supported server).
 */
export function indexCreateKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  pollMs?: number
}): JobKind<IndexJobParams> {
  const pollers = new Map<string, { timer: NodeJS.Timeout; jobs: Map<string, JobContext>; busy: boolean }>()
  // Builds whose createIndex call has returned, however it ended.
  const settled = new WeakSet<JobContext>()

  const poll = async (connectionId: string) => {
    const poller = pollers.get(connectionId)
    // A slow server answers after the next tick: never pile the questions up.
    if (!poller || poller.busy) return
    poller.busy = true
    try {
      await pollOnce(poller)
    } finally {
      poller.busy = false
    }
  }

  const pollOnce = async (poller: { jobs: Map<string, JobContext> }) => {
    const first = poller.jobs.values().next().value
    if (!first) return
    const client = await deps.client(first.target.connectionId).catch(() => null)
    if (!client) return
    for (const ctx of poller.jobs.values()) {
      const ops = await currentOps(client, buildOf(ctx), { internal: true })
      const measured = ops.find((op) => count((op.progress as Document | undefined)?.total) !== null)
      const progress = measured?.progress as Document | undefined
      const done = count(progress?.done)
      const total = count(progress?.total)
      if (done !== null && total !== null && total > 0) ctx.progress(Math.min(done, total), total)
    }
  }

  const watch = (ctx: JobContext) => {
    const id = ctx.target.connectionId
    let poller = pollers.get(id)
    if (!poller) {
      const timer = setInterval(() => void poll(id).catch(() => undefined), deps.pollMs ?? PROGRESS_POLL_MS)
      timer.unref()
      poller = { timer, jobs: new Map(), busy: false }
      pollers.set(id, poller)
    }
    poller.jobs.set(ctx.id, ctx)
  }

  const unwatch = (ctx: JobContext) => {
    const poller = pollers.get(ctx.target.connectionId)
    if (!poller) return
    poller.jobs.delete(ctx.id)
    if (poller.jobs.size === 0) {
      clearInterval(poller.timer)
      pollers.delete(ctx.target.connectionId)
    }
  }

  return {
    name: 'index.create',
    async run(ctx, params) {
      const client = await deps.client(ctx.target.connectionId)
      const collection = client.db(ctx.target.db).collection(ctx.target.coll)
      watch(ctx)
      try {
        await withMongo(() => collection.createIndex(params.key, { ...params.options, comment: ctx.comment }))
      } finally {
        settled.add(ctx)
        unwatch(ctx)
      }
    },
    async cancel(ctx) {
      const client = await deps.client(ctx.target.connectionId)
      // Only a build MongoDB still lists is dropped: a finished index is never undone.
      const op = await findOperation(client, buildOf(ctx), {
        ms: 2_000,
        internal: true,
        stillRunning: () => !settled.has(ctx),
      })
      if (!op || settled.has(ctx)) return false
      try {
        await client.db(ctx.target.db).collection(ctx.target.coll).dropIndex(ctx.target.target)
        return true
      } catch {
        return false
      }
    },
    recover: () => 'unknown',
  }
}
