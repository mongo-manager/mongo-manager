import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { CreateIndexesOptions, Document, IndexSpecification } from 'mongodb'
import { CreateIndexSchema } from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { maskerFor } from '../../masking/request'
import { maskIndexOptions } from '../../masking/definitions'
import { gateFor } from '../../masking/restricted'
import { guardIndexBuild } from '../../masking/gate'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { defaultIndexName } from '../../jobs/index-create'
import { toView } from '../../jobs/visibility'
import { currentOps } from '../../jobs/current-op'
import { fromClient, toClient } from '../../data/ejson-io'
import { CollParams } from './params'

// "*" means "every index" to dropIndex; it is never a real index name here.
const IndexParams = CollParams.extend({
  name: z
    .string()
    .min(1)
    .max(512)
    .refine((n) => n !== '*', 'Invalid index name'),
})
const HideBody = z.object({ hidden: z.boolean() })

const indexNames = (op: Document): string[] => {
  const indexes = (op.command as { indexes?: unknown } | undefined)?.indexes
  return Array.isArray(indexes) ? indexes.map((i: { name?: unknown }) => String(i?.name)) : []
}

const count = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint' ? Number(v) : null)

/**
 * Index builds as a message and numbers. Twelfth review of explain masking (M8): a build counts
 * keys, and over a multikey index on a hidden array the count tells how many values documents
 * hold; where rules apply to the caller, the numbers are left out, from the message too.
 */
export function buildsShown(
  ops: readonly Document[],
  hidden: boolean,
): Array<{ message: string; done: number | null; total: number | null }> {
  return ops.map((op) => {
    const message = typeof op.msg === 'string' ? op.msg.slice(0, 200) : ''
    const progress = op.progress as Document | undefined
    return hidden
      ? {
          message: message
            .replace(/\d[\d,./]*\s*%?/g, '')
            .replace(/\s+/g, ' ')
            .trim(),
          done: null,
          total: null,
        }
      : { message, done: count(progress?.done), total: count(progress?.total) }
  })
}

export async function indexRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/databases/:db/collections/:coll/indexes'
  const manage = requireConnection('indexes:write')

  app.get(
    base,
    { preHandler: requireConnection('databases:read'), config: { masking: 'guarded' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const collection = (await clientFor(request)).db(db).collection(coll)
      const indexes = await withMongo(() => collection.listIndexes().toArray())
      // Phase 3c §4.5: a partial filter someone wrote can hold a personal value.
      const masker = maskerFor(request)
      let usage = new Map<string, { ops: number; since: string }>()
      try {
        const stats = await collection
          .aggregate<{ name: string; accesses: { ops: unknown; since: Date } }>([{ $indexStats: {} }])
          .toArray()
        usage = new Map(
          stats.map((s) => [
            s.name,
            { ops: Number(s.accesses.ops), since: new Date(s.accesses.since).toISOString() },
          ]),
        )
      } catch {
        // views and restricted users have no index stats
      }
      return indexes.map((index: Document) => {
        const { name, key, v: _version, ...options } = index
        const shown = masker ? maskIndexOptions(toClient(options), db, coll, masker) : toClient(options)
        return { name, key: toClient(key), options: shown, usage: usage.get(name) ?? null }
      })
    },
  )

  /**
   * Index builds running on this collection, as a message and numbers only (never the command,
   * client or user). All operations when the account may see them, else its own; the empty list
   * when neither can be read.
   */
  app.get(
    `${base}/progress`,
    { preHandler: requireConnection('databases:read'), config: { masking: 'names-only' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      // A build's own thread carries its numbers; the client's createIndexes call only says it waits.
      // Where a build's thread is listed, its client call is left out, so each build shows once.
      const ops = await currentOps(
        await clientFor(request),
        {
          ns: `${db}.${coll}`,
          $or: [{ 'command.createIndexes': { $exists: true } }, { msg: { $regex: '^Index Build' } }],
        },
        { internal: true },
      )
      const threads = ops.filter((op) => typeof op.msg === 'string' && op.msg.startsWith('Index Build'))
      const building = new Set(threads.flatMap((op) => indexNames(op)))
      const shown = [
        ...threads,
        ...ops.filter((op) => !threads.includes(op) && !indexNames(op).some((n) => building.has(n))),
      ]
      return { builds: buildsShown(shown, maskerFor(request)?.forNs(db, coll).any === true) }
    },
  )

  /**
   * Starts the build and answers at once (202): a build of hours never meets a request timeout
   * (reverse proxy, browser). The build holds its connection until it ends; its outcome is read
   * from the jobs route.
   */
  app.post(
    base,
    { preHandler: manage, config: { masking: 'guarded', audit: 'indexes.create' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(CreateIndexSchema, request.body)
      const options = fromClient<CreateIndexesOptions>(body.options, 'options')
      // Phase 3c §5.4: no unique build over personal data, no partial filter on it.
      const gate = gateFor(request, await clientFor(request))
      if (gate)
        await withMongo(() =>
          guardIndexBuild(
            db,
            coll,
            body.key,
            options as { unique?: boolean; expireAfterSeconds?: number; partialFilterExpression?: Document },
            gate,
          ),
        )
      const name = body.options.name ?? defaultIndexName(body.key)
      const principal = request.principal!
      const job = app.ctx.jobs.start(
        app.ctx.jobKinds['index.create'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: request.connection!.id,
          db,
          coll,
          target: name,
        },
        { key: body.key as IndexSpecification, options },
      )
      request.auditInfo = { details: { index: name, job: job.id } }
      return reply.status(202).send({ job: toView(app.ctx, principal, job) })
    },
  )

  // Builds of this collection and how they ended; failure messages can quote document values.
  app.get(
    `${base}/jobs`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const principal = request.principal!
      const jobs = app.ctx.jobs.list({ connectionId: request.connection!.id, db, coll, limit: 200 })
      return { jobs: jobs.filter((j) => j.kind === 'index.create').map((j) => toView(app.ctx, principal, j)) }
    },
  )

  app.delete(
    `${base}/:name`,
    { preHandler: manage, config: { masking: 'names-only', audit: 'indexes.drop' } },
    async (request, reply) => {
      const { db, coll, name } = parseInput(IndexParams, request.params)
      if (name === '_id_') throw Errors.validation('The _id index cannot be dropped')
      await withMongo(async () => (await clientFor(request)).db(db).collection(coll).dropIndex(name))
      return reply.status(204).send()
    },
  )

  app.patch(
    `${base}/:name`,
    { preHandler: manage, config: { masking: 'names-only', audit: 'indexes.hide' } },
    async (request) => {
      const { db, coll, name } = parseInput(IndexParams, request.params)
      const { hidden } = parseInput(HideBody, request.body)
      await withMongo(async () =>
        (await clientFor(request)).db(db).command({ collMod: coll, index: { name, hidden } }),
      )
      return { name, hidden }
    },
  )
}
