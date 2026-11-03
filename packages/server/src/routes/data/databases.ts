import type { FastifyInstance } from 'fastify'
import { maskerFor } from '../../masking/request'
import { z } from 'zod'
import { CollectionNameSchema, ConfirmSchema, DatabaseNameSchema } from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import {
  assertNotDrillScratch,
  hostsKeyVault,
  isDrillScratch,
  requireConnection,
} from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { DbParams, SYSTEM_DATABASES, assertTargetAllowed } from './params'

const CreateBody = z.object({ name: DatabaseNameSchema, collection: CollectionNameSchema })

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/connections/:id/databases',
    { preHandler: requireConnection('databases:read'), config: { masking: 'names-only' } },
    async (request) => {
      const client = await clientFor(request)
      const result = await withMongo(() =>
        client.db('admin').admin().listDatabases({ nameOnly: false, authorizedDatabases: true }),
      )
      // W4 review C1: a restore drill's scratch database is no one's to open — nor counted in the total.
      const shown = result.databases.filter((d) => !isDrillScratch(d.name))
      const hidden = result.databases
        .filter((d) => isDrillScratch(d.name))
        .reduce((n, d) => n + Number(d.sizeOnDisk ?? 0), 0)
      // Ninth review of explain masking: a database where rules apply keeps its size from a
      // restricted user, and so does the total, which would tell it.
      const masker = maskerFor(request)
      const sized = (name: string) => !masker?.anyInDb(name)
      return {
        databases: shown
          .map((d) => ({
            name: d.name,
            sizeOnDisk: sized(d.name) ? Number(d.sizeOnDisk ?? 0) : null,
            empty: Boolean(d.empty),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        totalSize: shown.every((d) => sized(d.name))
          ? Math.max(0, Number(result.totalSize ?? 0) - hidden)
          : null,
      }
    },
  )

  app.post(
    '/connections/:id/databases',
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'names-only', audit: 'databases.create' },
    },
    async (request, reply) => {
      const body = parseInput(CreateBody, request.body)
      // W4 re-review (minor): a restore drill's scratch name is never made by hand.
      assertNotDrillScratch(body.name)
      assertTargetAllowed(request, body.name, body.collection)
      const client = await clientFor(request)
      await withMongo(() => client.db(body.name).createCollection(body.collection))
      request.auditInfo = { details: { database: body.name, collection: body.collection } }
      return reply.status(201).send({ name: body.name })
    },
  )

  app.delete(
    '/connections/:id/databases/:db',
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'names-only', audit: 'databases.drop' },
    },
    async (request, reply) => {
      const { db } = parseInput(DbParams, request.params)
      const { confirm } = parseInput(ConfirmSchema, request.body)
      if (SYSTEM_DATABASES.has(db)) throw Errors.validation('System databases cannot be dropped')
      // W8 re-review: the database holding a key vault takes every data key with it — a
      // connection administrator's to drop, as the key vault itself is.
      if (request.connectionRole !== 'admin' && hostsKeyVault(db))
        throw Errors.forbidden('This database holds encryption keys: only connection admins may drop it', {
          reason: 'system_namespace',
        })
      if (confirm !== db) throw Errors.validation('Type the database name to confirm')
      const client = await clientFor(request)
      await withMongo(() => client.db(db).dropDatabase())
      return reply.status(204).send()
    },
  )

  app.get(
    '/connections/:id/databases/:db/stats',
    { preHandler: requireConnection('databases:read'), config: { masking: 'names-only' } },
    async (request) => {
      const { db } = parseInput(DbParams, request.params)
      const client = await clientFor(request)
      const s = await withMongo(() => client.db(db).command({ dbStats: 1 }))
      const n = (v: unknown) => Number(v ?? 0)
      // Ninth review of explain masking: where rules apply in it, its counts alone.
      const hidden = maskerFor(request)?.anyInDb(db) === true
      const size = (v: unknown) => (hidden ? null : n(v))
      return {
        collections: n(s.collections),
        views: n(s.views),
        objects: n(s.objects),
        dataSize: size(s.dataSize),
        storageSize: size(s.storageSize),
        indexes: n(s.indexes),
        indexSize: size(s.indexSize),
        ...(hidden ? { sizesHidden: true } : {}),
      }
    },
  )
}
