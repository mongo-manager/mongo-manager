import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { CreateCollectionOptions, Document } from 'mongodb'
import {
  CollectionNameSchema,
  CollectionOptionsSchema,
  ConfirmSchema,
  CreateCollectionSchema,
  UpdateViewSchema,
  toWire,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../../errors'
import { parseInput } from '../../validate'
import { isEncryptionNamespace, requireConnection } from '../../connections/access'
import { clientFor, toAppError, withMongo } from '../../data/mongo-errors'
import { READ_OPTIONS, fromClient, toClient } from '../../data/ejson-io'
import { CollParams, DbParams, assertSourceAllowed, assertTargetAllowed } from './params'
import { inspectPipeline } from '../../aggregation/inspect'
import { maskerFor } from '../../masking/request'
import { gateFor, viewAwareMaskerFor } from '../../masking/restricted'
import { guardViewSource, notSupported } from '../../masking/gate'
import { maskCollectionOptions } from '../../masking/definitions'
import { assertWriteTargetFree } from '../../masking/modes'

const ListQuery = z.object({ system: z.enum(['true', 'false']).default('false') })
const RenameBody = z.object({ to: CollectionNameSchema })

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/connections/:id/databases/:db/collections',
    { preHandler: requireConnection('databases:read'), config: { masking: 'guarded' } },
    async (request) => {
      const { db } = parseInput(DbParams, request.params)
      const { system } = parseInput(ListQuery, request.query)
      const client = await clientFor(request)
      const database = client.db(db)
      let infos: Array<{ name: string; type?: string; options?: Document; info?: { readOnly?: boolean } }>
      try {
        infos = await database.listCollections({}, { nameOnly: false }).toArray()
      } catch (e) {
        if ((e as { code?: unknown }).code !== 13) throw toAppError(e)
        // Users limited to specific collections may only list names (authorizedCollections needs nameOnly).
        infos = await withMongo(() =>
          database.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray(),
        )
      }
      // Phase 3c §4.5: validators and view pipelines someone wrote can hold personal values.
      const own = maskerFor(request)
      // Final review I3: a view's pipeline is masked by its source's rules, through view chains.
      const masker = own
        ? await viewAwareMaskerFor(
            request,
            infos.flatMap((c) =>
              c.type === 'view' && typeof c.options?.viewOn === 'string'
                ? [[db, c.options.viewOn] as const]
                : [],
            ),
          )
        : null
      return (
        infos
          .filter((c) => system === 'true' || !c.name.startsWith('system.'))
          // Security review C1: the key vault and Queryable Encryption metadata are a connection
          // admin's only; nobody else is shown them (opening one would be refused anyway).
          .filter((c) => request.connectionRole === 'admin' || !isEncryptionNamespace(db, c.name))
          .map((c) => ({
            name: c.name,
            type: c.type ?? 'collection',
            options: masker
              ? maskCollectionOptions(toClient(c.options ?? {}), db, c.name, masker, own ?? masker)
              : toClient(c.options ?? {}),
            readOnly: Boolean(c.info?.readOnly),
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      )
    },
  )

  app.post(
    '/connections/:id/databases/:db/collections',
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'guarded', audit: 'collections.create' },
    },
    async (request, reply) => {
      const { db } = parseInput(DbParams, request.params)
      const body = parseInput(CreateCollectionSchema, request.body)
      let options: CreateCollectionOptions = {}
      switch (body.kind) {
        case 'collection':
          if (body.clustered) options = { clusteredIndex: { key: { _id: 1 }, unique: true } }
          break
        case 'capped':
          options = { capped: true, size: body.size, ...(body.max ? { max: body.max } : {}) }
          break
        case 'timeseries':
          options = {
            timeseries: {
              timeField: body.timeField,
              ...(body.metaField ? { metaField: body.metaField } : {}),
              ...(body.granularity ? { granularity: body.granularity } : {}),
            },
            ...(body.expireAfterSeconds ? { expireAfterSeconds: body.expireAfterSeconds } : {}),
          }
          break
        case 'view': {
          const pipeline = fromClient<Document[]>(body.pipeline, 'pipeline')
          // Phase 2a: the same inspection as the aggregation builder (it creates views from pipelines).
          if (inspectPipeline(request, pipeline, db).write)
            throw Errors.validation('A view cannot write: remove the $out or $merge stage')
          // Phase 3c §5.3: a restricted user's view may read no namespace with rules.
          const gate = gateFor(request, await clientFor(request))
          if (gate) await withMongo(() => guardViewSource(db, body.viewOn, pipeline, gate))
          assertSourceAllowed(request, db, body.viewOn)
          options = { viewOn: body.viewOn, pipeline }
          break
        }
      }
      // W2.4: a default collation, and change-stream pre/post images from the start.
      if (body.collation) options.collation = body.collation
      if ('changeStreamPreAndPostImages' in body && body.changeStreamPreAndPostImages)
        options.changeStreamPreAndPostImages = { enabled: true }
      assertTargetAllowed(request, db, body.name)
      const client = await clientFor(request)
      // MongoDB 7+ accepts re-creating an identical collection silently; users expect "already exists".
      const existing = await withMongo(() =>
        client.db(db).listCollections({ name: body.name }, { nameOnly: true }).toArray(),
      )
      if (existing.length > 0) throw Errors.conflict('A collection or view with that name already exists')
      await withMongo(() => client.db(db).createCollection(body.name, options))
      request.auditInfo = {
        details: {
          collection: body.name,
          kind: body.kind,
          ...(body.collation ? { collation: body.collation.locale } : {}),
          ...(options.changeStreamPreAndPostImages ? { changeStreamPreAndPostImages: true } : {}),
        },
      }
      return reply.status(201).send({ name: body.name })
    },
  )

  /** The collection's type as listCollections gives it, or null when there is none of that name. */
  const typeOf = async (request: FastifyRequest, db: string, coll: string): Promise<string | null> => {
    const client = await clientFor(request)
    const [info] = await withMongo(() =>
      client.db(db).listCollections({ name: coll }, { nameOnly: false }).toArray(),
    )
    return info ? ((info as { type?: string }).type ?? 'collection') : null
  }

  /**
   * W2.4 (2026-10-16): change-stream pre/post images turned on or off (collMod). The collection is
   * named in the body as well as the path, so a request meant for another tab's collection changes
   * nothing. No document value goes in or out.
   */
  app.patch(
    '/connections/:id/databases/:db/collections/:coll/options',
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'names-only', audit: 'collections.modify' },
    },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(CollectionOptionsSchema, request.body)
      if (body.confirm !== coll) throw Errors.validation('Name the collection to confirm')
      if (coll.startsWith('system.')) throw Errors.validation('System collections cannot be changed here')
      assertTargetAllowed(request, db, coll)
      const type = await typeOf(request, db, coll)
      if (type === null) throw Errors.notFound('No such collection')
      if (type !== 'collection')
        throw Errors.validation('Change-stream pre- and post-images are for collections only')
      const client = await clientFor(request)
      await withMongo(() =>
        client.db(db).command({
          collMod: coll,
          changeStreamPreAndPostImages: { enabled: body.changeStreamPreAndPostImages },
        }),
      )
      request.auditInfo = { details: { changeStreamPreAndPostImages: body.changeStreamPreAndPostImages } }
      return { changeStreamPreAndPostImages: body.changeStreamPreAndPostImages }
    },
  )

  /**
   * Re-review (minor 3): a view's definition to edit, read as stored (promoteValues off: a double
   * 1.0 stays a double, a small Long a Long) — the listing promotes them, and writing what it shows
   * back would change their types. Masked for a restricted user as the listing is.
   */
  app.get(
    '/connections/:id/databases/:db/collections/:coll/view',
    { preHandler: requireConnection('databases:read'), config: { masking: 'guarded' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const client = await clientFor(request)
      const [info] = await withMongo(() =>
        client
          .db(db)
          .listCollections({ name: coll }, { nameOnly: false, ...READ_OPTIONS })
          .toArray(),
      )
      if (!info) throw Errors.notFound('No such view')
      const options = ((info as { options?: Document }).options ?? {}) as {
        viewOn?: unknown
        pipeline?: unknown
      }
      if (info.type !== 'view' || typeof options.viewOn !== 'string')
        throw Errors.validation('Only a view has a pipeline to edit')
      const shown = toClient({ viewOn: options.viewOn, pipeline: options.pipeline ?? [] }) as Record<
        string,
        unknown
      >
      const own = maskerFor(request)
      if (!own) return shown
      const masker = (await viewAwareMaskerFor(request, [[db, options.viewOn]])) ?? own
      return maskCollectionOptions(shown, db, coll, masker, own)
    },
  )

  /**
   * W2.2 (2026-10-16): a view's source and pipeline replaced in place (collMod viewOn/pipeline),
   * checked as a new view is: no stage that writes, no server JavaScript, and for a restricted user
   * no source with rules. The view is named in the body as well as the path.
   */
  app.put(
    '/connections/:id/databases/:db/collections/:coll/view',
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'guarded', audit: 'collections.view.update' },
    },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(UpdateViewSchema, request.body)
      if (body.confirm !== coll) throw Errors.validation('Name the view to confirm')
      const pipeline = fromClient<Document[]>(body.pipeline, 'pipeline')
      // inspectPipeline refuses server JavaScript too.
      if (inspectPipeline(request, pipeline, db).write)
        throw Errors.validation('A view cannot write: remove the $out or $merge stage')
      assertTargetAllowed(request, db, coll)
      assertSourceAllowed(request, db, body.viewOn)
      const client = await clientFor(request)
      const [info] = await withMongo(() =>
        // Re-review (minor 3): as stored — a double stays a double, a Long a Long.
        client
          .db(db)
          .listCollections({ name: coll }, { nameOnly: false, ...READ_OPTIONS })
          .toArray(),
      )
      if (!info) throw Errors.notFound('No such view')
      if (info.type !== 'view') throw Errors.validation('Only a view has a pipeline to change')
      // Phase 3c §5.3: a restricted user's view may read no namespace with rules.
      const gate = gateFor(request, client)
      if (gate) {
        await withMongo(() => guardViewSource(db, body.viewOn, pipeline, gate))
        // A definition this user was shown masked is not theirs to rewrite: what they would send back
        // holds the masks, not the values (the stored one stays as it is).
        const stored = toClient((info as { options?: Document }).options ?? {}) as Record<string, unknown>
        const own = maskerFor(request)!
        const viewOn = typeof stored.viewOn === 'string' ? stored.viewOn : null
        const masker = (await viewAwareMaskerFor(request, viewOn ? [[db, viewOn]] : [])) ?? own
        if (toWire(maskCollectionOptions(stored, db, coll, masker, own)) !== toWire(stored))
          throw notSupported('Changing a view whose definition is partly hidden', `${db}.${coll}`)
      }
      // W2 review (I1): the edit started from the definition stored now, or it would undo a change
      // made meanwhile (compared as BSON: the page's canonical EJSON, decoded).
      const stored = (info as { options?: { viewOn?: unknown; pipeline?: unknown } }).options ?? {}
      const started = fromClient<Document>(body.base, 'base')
      if (toWire({ viewOn: stored.viewOn, pipeline: stored.pipeline ?? [] }) !== toWire(started))
        throw new AppError('CONFLICT', 'The view was changed since this edit began; load it again', 409, {
          reason: 'view_changed',
        })
      await withMongo(() => client.db(db).command({ collMod: coll, viewOn: body.viewOn, pipeline }))
      request.auditInfo = {
        details: {
          viewOn: body.viewOn,
          previousViewOn: typeof stored.viewOn === 'string' ? stored.viewOn : null,
          stages: pipeline.length,
        },
      }
      return { name: coll, viewOn: body.viewOn }
    },
  )

  app.delete(
    '/connections/:id/databases/:db/collections/:coll',
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'names-only', audit: 'collections.drop' },
    },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { confirm } = parseInput(ConfirmSchema, request.body)
      if (coll.startsWith('system.')) throw Errors.validation('System collections cannot be dropped')
      if (confirm !== coll) throw Errors.validation('Type the collection name to confirm')
      const client = await clientFor(request)
      await withMongo(() => client.db(db).collection(coll).drop())
      return reply.status(204).send()
    },
  )

  app.post(
    '/connections/:id/databases/:db/collections/:coll/rename',
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'denied-when-ruled', audit: 'collections.rename' },
    },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { to } = parseInput(RenameBody, request.body)
      assertTargetAllowed(request, db, to)
      assertWriteTargetFree(request, db, to)
      const client = await clientFor(request)
      await withMongo(() => client.db(db).collection(coll).rename(to, { dropTarget: false }))
      request.auditInfo = { details: { to } }
      return { name: to }
    },
  )

  app.get(
    '/connections/:id/databases/:db/collections/:coll/stats',
    { preHandler: requireConnection('databases:read'), config: { masking: 'names-only' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const client = await clientFor(request)
      const each = await withMongo(() =>
        client
          .db(db)
          .collection(coll)
          .aggregate([{ $collStats: { storageStats: {}, count: {} } }])
          .toArray(),
      )
      const n = (v: unknown) => Number(v ?? 0)
      // Review of C6 (I1): through mongos, one document a shard — their sums are the collection's.
      const parts = each.map((d) => (d.storageStats ?? {}) as Record<string, unknown>)
      const sum = (key: string) => parts.reduce((t, p) => t + n(p[key]), 0)
      // Re-review of C6 (M-5): by name in a map (an index may be named constructor or __proto__).
      const sizes = new Map<string, number>()
      for (const p of parts)
        for (const [name, bytes] of Object.entries((p.indexSizes ?? {}) as Record<string, unknown>))
          sizes.set(name, (sizes.get(name) ?? 0) + n(bytes))
      const indexSizes = Object.fromEntries(sizes)
      const total = each.reduce((t, d, i) => t + n(d.count ?? parts[i]!.count), 0)
      const s = {
        size: sum('size'),
        storageSize: sum('storageSize'),
        totalIndexSize: sum('totalIndexSize'),
        // One document (no shards): the server's own.
        avgObjSize:
          parts.length === 1 ? n(parts[0]!.avgObjSize) : total ? Math.floor(sum('size') / total) : 0,
        nindexes: Math.max(0, ...parts.map((p) => n(p.nindexes))),
        capped: parts.some((p) => Boolean(p.capped)),
        indexSizes,
      }
      const stats = { count: total }
      // Ninth review of explain masking: a size tells the length of what rules hide (read while a
      // document is written): a restricted user sees the counts alone where rules apply.
      const masker = await viewAwareMaskerFor(request, [[db, coll]])
      const hidden = masker?.forNs(db, coll).any === true
      const size = (v: unknown) => (hidden ? null : n(v))
      return {
        count: stats.count,
        size: size(s.size),
        storageSize: size(s.storageSize),
        avgObjSize: size(s.avgObjSize),
        totalIndexSize: size(s.totalIndexSize),
        nindexes: n(s.nindexes),
        capped: Boolean(s.capped),
        // Phase 1i: bytes per index, for the overview chart.
        indexSizes: hidden ? {} : s.indexSizes,
        ...(hidden ? { sizesHidden: true } : {}),
      }
    },
  )
}
