import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  FavouriteBodySchema,
  FavouriteUpdateSchema,
  type FavouriteQuery,
  type FavouriteView,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { viewAwareMaskerFor } from '../../masking/restricted'
import type { Masker } from '../../masking/match'
import { maskFindDef } from '../../masking/definitions'
import { requireConnection } from '../../connections/access'
import { fromClient } from '../../data/ejson-io'
import { MAX_FAVOURITE_BYTES, MAX_FAVOURITES_PER_NAMESPACE } from '../../queries/favourites'
import type { SealedItemRow } from '../../queries/sealed-items'
import { CollParams, assertNoServerJs } from './params'
import { ownerOf, seesOwnerless } from './owners'
import { maskedEdit } from './masked-edit'

const BASE = '/connections/:id/databases/:db/collections/:coll/favourites'
const ItemParams = CollParams.extend({ favId: z.string().uuid() })

function view(request: FastifyRequest, row: SealedItemRow, masker: Masker | null = null): FavouriteView {
  const mine = row.ownerId === ownerOf(request)
  const query = JSON.parse(row.text) as FavouriteQuery
  // Phase 3c §4.6: someone else's literals at personal paths are hidden from a restricted user.
  // The view-aware masker of the listing (final review I3); none for the caller's own items.
  const hidden = mine ? null : masker
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    query: hidden ? (maskFindDef(query, row.db, row.coll, hidden) as FavouriteQuery) : query,
    shared: row.shared,
    mine,
    owner: row.ownerName,
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

/** The query as stored: canonical EJSON text, checked to decode, free of server JS, bounded. */
function storedText(request: FastifyRequest, query: FavouriteQuery): string {
  assertNoServerJs(request, fromClient(query, 'query'))
  const text = JSON.stringify(query)
  if (Buffer.byteLength(text) > MAX_FAVOURITE_BYTES)
    throw Errors.validation('This query is too large to save (64 KiB at most)')
  return text
}

/** Phase 2c spec §2.2: favourite finds, private or shared with everyone who can use the connection. */
export async function favouriteRoutes(app: FastifyInstance): Promise<void> {
  const repo = () => app.ctx.favourites

  const visible = (request: FastifyRequest): SealedItemRow => {
    const { db, coll, favId } = parseInput(ItemParams, request.params)
    const row = repo().get(favId)
    if (
      !row ||
      row.connectionId !== request.connection!.id ||
      row.db !== db ||
      row.coll !== coll ||
      !(row.ownerId === ownerOf(request) || row.shared || (row.ownerId === null && seesOwnerless(request)))
    )
      throw Errors.notFound('Favourite not found')
    return row
  }

  app.get(
    BASE,
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const rows = repo().list({
        ownerId: ownerOf(request),
        connectionId: request.connection!.id,
        db,
        coll,
        ownerless: seesOwnerless(request),
      })
      const owner = ownerOf(request)
      const masker = await viewAwareMaskerFor(
        request,
        rows.some((r) => r.ownerId !== owner) ? [[db, coll] as const] : [],
      )
      return { favourites: rows.map((r) => view(request, r, masker)) }
    },
  )

  app.post(
    BASE,
    {
      preHandler: requireConnection('documents:read'),
      config: { masking: 'names-only', audit: 'favourites.save' },
    },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(FavouriteBodySchema, request.body ?? {})
      request.auditInfo = { details: { name: body.name, tags: body.tags, shared: body.shared } }
      const text = storedText(request, body.query)
      const owner = ownerOf(request)
      if (repo().countFor(owner, request.connection!.id, db, coll) >= MAX_FAVOURITES_PER_NAMESPACE)
        throw Errors.conflict(
          `At most ${MAX_FAVOURITES_PER_NAMESPACE} favourites can be saved per collection`,
          { reason: 'limit', max: MAX_FAVOURITES_PER_NAMESPACE },
        )
      const row = repo().create({
        ownerId: owner,
        connectionId: request.connection!.id,
        db,
        coll,
        name: body.name.trim(),
        tags: body.tags,
        text,
        shared: body.shared,
      })
      return reply.status(201).send(view(request, row))
    },
  )

  app.put(
    `${BASE}/:favId`,
    {
      preHandler: requireConnection('documents:read'),
      config: { masking: 'names-only', audit: 'favourites.save' },
    },
    async (request) => {
      const row = visible(request)
      const body = parseInput(FavouriteUpdateSchema, request.body ?? {})
      request.auditInfo = {
        details: { name: body.name, ...(body.tags ? { tags: body.tags } : {}), shared: body.shared },
      }
      const mayEdit =
        row.ownerId === ownerOf(request) || (row.ownerId === null && request.connectionRole === 'admin')
      if (!mayEdit) throw Errors.forbidden('Only the owner can change this favourite')
      // A local-mode favourite a connection admin was shown masked: what came back is kept as stored.
      const hidden =
        row.ownerId === ownerOf(request) ? null : await viewAwareMaskerFor(request, [[row.db, row.coll]])
      const stored = JSON.parse(row.text) as FavouriteQuery
      const kept =
        hidden &&
        maskedEdit(maskFindDef(stored, row.db, row.coll, hidden), stored, body.query, 'favourite') === 'keep'
      const updated = repo().update(row.id, {
        name: body.name.trim(),
        ...(body.tags ? { tags: body.tags } : {}),
        text: kept ? row.text : storedText(request, body.query),
        shared: body.shared,
      })
      return view(request, updated!)
    },
  )

  app.delete(
    `${BASE}/:favId`,
    {
      preHandler: requireConnection('documents:read'),
      config: { masking: 'names-only', audit: 'favourites.delete' },
    },
    async (request, reply) => {
      const row = visible(request)
      request.auditInfo = { details: { name: row.name, tags: row.tags } }
      if (!(row.ownerId === ownerOf(request) || request.connectionRole === 'admin'))
        throw Errors.forbidden('Only the owner or a connection admin can delete this favourite')
      repo().delete(row.id)
      return reply.status(204).send()
    },
  )
}
