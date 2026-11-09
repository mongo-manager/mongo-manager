// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { PreImagesSchema } from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { READ_OPTIONS } from '../../data/ejson-io'
import { CollParams, assertTargetAllowed } from './params'

/**
 * W4.7 (completion design §2 W4.7): a collection's pre- and post-images, turned on or off from the
 * Watch page (`collMod … changeStreamPreAndPostImages`). They let a feed show each change's document
 * before and after it, and a two-way live sync compare and settle changes. Changing a collection's
 * options needs `databases:write`, as validation rules do; a read-only connection refuses it; a view or
 * a credential collection is refused; MongoDB 6.0 or later is required (MongoDB says so otherwise).
 */
export async function preImageRoutes(app: FastifyInstance): Promise<void> {
  app.put(
    '/connections/:id/databases/:db/collections/:coll/pre-images',
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'names-only', audit: 'collections.preimages' },
    },
    async (request): Promise<{ enabled: boolean }> => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { enabled } = parseInput(PreImagesSchema, request.body ?? {})
      assertTargetAllowed(request, db, coll)
      request.auditInfo = { details: { enabled } }
      const database = (await clientFor(request)).db(db)
      const [info] = (await withMongo(() =>
        database.listCollections({ name: coll }, { ...READ_OPTIONS } as never).toArray(),
      )) as Array<{ type?: string; options?: Document }>
      if (!info) throw Errors.notFound('Collection not found')
      if (info.type === 'view')
        throw Errors.conflict('A view keeps no images: turn them on for the collection it reads', {
          reason: 'view',
        })
      await withMongo(() => database.command({ collMod: coll, changeStreamPreAndPostImages: { enabled } }))
      return { enabled }
    },
  )
}
