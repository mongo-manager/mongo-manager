// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { MongoServerError } from 'mongodb'
import {
  CreateSearchIndexSchema,
  SearchIndexNameSchema,
  UpdateSearchIndexSchema,
  VECTOR_PROBLEMS,
  vectorDefinitionProblem,
} from '@mongo-manager/shared'
import { MASK } from '../../masking/document'
import { maskerFor } from '../../masking/request'
import { gateFor } from '../../masking/restricted'
import { sourceShape } from '../../masking/gate/pipeline'
import { newCtx } from '../../masking/gate/context'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { fromClient, toClient } from '../../data/ejson-io'
import { CollParams, assertNoServerJs } from './params'

const IndexParams = CollParams.extend({ name: SearchIndexNameSchema })

/**
 * Answers that mean "this server has no search": Atlas's SearchNotEnabled (a tier or a server
 * without mongot), an unknown $listSearchIndexes stage (older servers), a command the server does
 * not have.
 */
const NO_SEARCH = new Map<number, 'not_enabled' | 'unsupported'>([
  [31082, 'not_enabled'],
  // W2 review (minor 10): MongoDB 7.0 Community, "only allowed on MongoDB Atlas".
  [6047401, 'not_enabled'],
  [40324, 'unsupported'],
  [115, 'unsupported'],
  [59, 'unsupported'],
])
const MAX_MESSAGE = 500

/** A vector definition's problem, refused in the server's words with its code for the page. */
function checkVector(definition: Document): void {
  const problem = vectorDefinitionProblem(definition)
  if (problem) throw Errors.validation(VECTOR_PROBLEMS[problem], { reason: problem })
}

/**
 * W2 review (minor 11): analysers and synonym mappings can hold words someone chose (stop words,
 * character mappings, synonym sources). A restricted user sees them masked where personal-data rules
 * apply; the fields an index covers, which are names, stay shown.
 */
function shownDefinition(definition: Document, restricted: boolean): unknown {
  const shown = toClient(definition) as Record<string, unknown>
  if (!restricted) return shown
  const out = { ...shown }
  for (const key of ['analyzers', 'synonyms', 'searchAnalyzer', 'analyzer'])
    if (out[key] !== undefined) out[key] = MASK
  return out
}

/**
 * W2.6 (2026-10-16): Atlas Search and Vector Search indexes of a collection — listed with their
 * status, created, updated, dropped (Atlas, or a self-managed MongoDB with MongoDB Search, mongot).
 * Definitions name fields and analysis settings, never document values; a restricted user may read them, and may change
 * none where personal-data rules apply (an index over a hidden field would make it searchable).
 */
export async function searchIndexRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/databases/:db/collections/:coll/search-indexes'
  const manage = requireConnection('indexes:write')

  app.get(
    base,
    { preHandler: requireConnection('databases:read'), config: { masking: 'names-only' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const collection = (await clientFor(request)).db(db).collection(coll)
      let found: Document[]
      try {
        found = await collection.listSearchIndexes().toArray()
      } catch (e) {
        const reason = e instanceof MongoServerError ? NO_SEARCH.get(Number(e.code)) : undefined
        if (reason) return { supported: false, reason, indexes: [] }
        // Anything else (a lost connection, a denied command) is an error, said as such.
        return withMongo(async () => {
          throw e
        })
      }
      // Re-review (minor 2): masked only where rules apply, as writes are refused only there (the
      // same test as denied-when-ruled); elsewhere the user edits what they see, whole.
      const gate = maskerFor(request) ? gateFor(request, await clientFor(request)) : null
      // A namespace the gate cannot resolve (a closed view) is treated as ruled: in doubt, mask.
      const restricted = gate
        ? await sourceShape(db, coll, newCtx(gate, db)).then(
            (shape) => shape.any,
            () => true,
          )
        : false
      return {
        supported: true,
        indexes: found.map((index) => ({
          name: String(index.name),
          type: index.type === 'vectorSearch' ? 'vectorSearch' : 'search',
          status: typeof index.status === 'string' ? index.status : 'UNKNOWN',
          queryable: index.queryable === true,
          ...(typeof index.message === 'string' && index.message
            ? { message: index.message.slice(0, MAX_MESSAGE) }
            : {}),
          definition: shownDefinition(index.latestDefinition ?? {}, restricted),
        })),
      }
    },
  )

  app.post(
    base,
    { preHandler: manage, config: { masking: 'denied-when-ruled', audit: 'searchIndexes.create' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(CreateSearchIndexSchema, request.body)
      const definition = fromClient<Document>(body.definition, 'definition')
      assertNoServerJs(request, definition)
      if (body.type === 'vectorSearch') checkVector(definition)
      request.auditInfo = { details: { name: body.name, type: body.type } }
      const collection = (await clientFor(request)).db(db).collection(coll)
      const name = await withMongo(() =>
        collection.createSearchIndex({ name: body.name, type: body.type, definition }),
      )
      return reply.status(201).send({ name })
    },
  )

  app.patch(
    `${base}/:name`,
    { preHandler: manage, config: { masking: 'denied-when-ruled', audit: 'searchIndexes.update' } },
    async (request) => {
      const { db, coll, name } = parseInput(IndexParams, request.params)
      const body = parseInput(UpdateSearchIndexSchema, request.body)
      const definition = fromClient<Document>(body.definition, 'definition')
      assertNoServerJs(request, definition)
      request.auditInfo = { details: { name } }
      const collection = (await clientFor(request)).db(db).collection(coll)
      // W2 review (minor 8): an edited vector index is checked as a new one is.
      // (A server that cannot list them answers the update itself, as it would without this check.)
      const listed: Document[] = await collection
        .listSearchIndexes(name)
        .toArray()
        .catch((): Document[] => [])
      if (listed.find((i) => i.name === name)?.type === 'vectorSearch') checkVector(definition)
      await withMongo(() => collection.updateSearchIndex(name, definition))
      return { name }
    },
  )

  app.delete(
    `${base}/:name`,
    { preHandler: manage, config: { masking: 'names-only', audit: 'searchIndexes.drop' } },
    async (request, reply) => {
      const { db, coll, name } = parseInput(IndexParams, request.params)
      request.auditInfo = { details: { name } }
      const collection = (await clientFor(request)).db(db).collection(coll)
      await withMongo(() => collection.dropSearchIndex(name))
      return reply.status(204).send()
    },
  )
}
