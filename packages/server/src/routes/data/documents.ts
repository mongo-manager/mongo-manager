// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import { calculateObjectSize } from 'bson'
import type { Collection, Document, Filter } from 'mongodb'
import {
  CountRequestSchema,
  FindRequestSchema,
  IdRequestSchema,
  InsertRequestSchema,
  ReplaceRequestSchema,
  UpdateRequestSchema,
  toWire,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor, toAppError, withMongo } from '../../data/mongo-errors'
import {
  READ_OPTIONS,
  exactId,
  fromClient,
  hashDocument,
  notRoundTrip,
  refuseHazards,
  toClient,
} from '../../data/ejson-io'
import { trackOperation } from '../../data/operations'
import { presenterFor } from '../../masking/present'
import { gateFor } from '../../masking/restricted'
import {
  guardCount,
  guardDocumentUpdate,
  guardFilterFor,
  guardFind,
  guardInsert,
  orderRefused,
  PERSONAL_FIELD,
  restoreReplacement,
} from '../../masking/gate'
import { safeEqual } from '../../http/security'
import { CollParams, assertNoServerJs } from './params'
import { rememberQuery } from './recent'
import { holdReadSlot } from '../../data/page'
import { refuseRepeats, repeatsRefused } from '../../masking/repeats'

/** Exact _id match: $eq keeps regex and object values literal (spec §4.2). */
const byId = (id: unknown) => ({ _id: { $eq: id } }) as Filter<Document>

const MAX_AUDITED_IDS = 100
/** One document by _id: a find's default time (security audit 2026-10-16, Important 2). */
const GET_MAX_TIME_MS = 30_000
/** A plugin's find (security audit 2026-10-16, minor). */
const PLUGIN_FIND_MS = 10_000
/** A pinned write matches the stored version byte for byte: no case- or accent-folding collation. */
const PINNED = { collation: { locale: 'simple' } }

export async function documentReadRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/databases/:db/collections/:coll'

  app.post(
    `${base}/find`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(FindRequestSchema, request.body)
      const filter = fromClient<Filter<Document>>(body.filter, 'filter')
      const projection = body.projection ? fromClient<Document>(body.projection, 'projection') : undefined
      const sort = body.sort ? fromClient<Document>(body.sort, 'sort') : undefined
      const collation = body.collation ? fromClient<Document>(body.collation, 'collation') : undefined
      const hint = typeof body.hint === 'object' ? fromClient<Document>(body.hint, 'hint') : body.hint
      assertNoServerJs(request, filter, projection)
      // Security review 2026-10-13 (M3): a few finds at once per user and on the server, each held
      // until its response is sent — taken before any work for it (round 2, Minor 6).
      const { slots, maxPageBytes } = request.server.ctx.documents
      holdReadSlot(request, reply, slots)
      const client = await clientFor(request)
      // Phase 3c §3: a restricted user's query goes through the gate; the page is masked on the way out.
      const gate = gateFor(request, client)
      const guarded = gate
        ? await withMongo(() =>
            guardFind(
              db,
              coll,
              {
                filter,
                ...(projection ? { projection } : {}),
                ...(sort ? { sort } : {}),
                ...(hint ? { hint } : {}),
                ...(collation ? { collation } : {}),
              },
              gate,
            ),
          )
        : null
      const shown = guarded ? guarded.projection : projection
      // Each page read with a byte cap as it comes — never up to 1001 documents of any size (a
      // projection can inflate each); the one past the page only says there is more (Minor 5).
      const comment = trackOperation(request, reply, client)
      const docs: Document[] = []
      let more = false
      const read = async (order: { sort?: Document; hint?: string | Document }) => {
        docs.length = 0
        more = false
        await withMongo(async () => {
          const cursor = client
            .db(db)
            .collection(coll)
            .find(guarded?.filter ?? filter, {
              ...READ_OPTIONS,
              ...(shown ? { projection: shown } : {}),
              // The gate's order and hint where rules apply: no hidden value's order (ninth review).
              ...(order.sort ? { sort: order.sort } : {}),
              ...(collation ? { collation: collation as never } : {}),
              ...(order.hint ? { hint: order.hint } : {}),
              skip: body.skip,
              limit: body.limit + 1,
              // Security audit 2026-10-16 (minor): a plugin's find (remember: false, sent by the host
              // for a plugin's read alone) runs for PLUGIN_FIND_MS at most, whatever it asked for.
              maxTimeMS: body.remember ? body.maxTimeMS : Math.min(body.maxTimeMS, PLUGIN_FIND_MS),
              comment,
            })
          try {
            let bytes = 0
            for await (const doc of cursor) {
              if (docs.length === body.limit) {
                more = true
                break
              }
              bytes += calculateObjectSize(doc)
              if (bytes > maxPageBytes)
                throw Errors.validation(
                  `This page is larger than ${Math.round(maxPageBytes / 1024 / 1024)} MiB; show fewer documents or fewer fields`,
                  { reason: 'page_too_large' },
                )
              docs.push(doc)
            }
          } finally {
            await cursor.close().catch(() => undefined)
          }
        })
      }
      await read(guarded ? { sort: guarded.sort, hint: guarded.hint } : { sort, hint })
      // Fifteenth review (Minor 5): a page refused for a document _id is read again in natural
      // order, where that tells nothing.
      let page: Document[]
      try {
        // Seventeenth and eighteenth reviews (I1, I-3): a time series' _ids are taken before the check
        // drops what it added, and asked about after it: its own refusal comes first, whatever the twins.
        const ids = guarded?.repeats ? docs.map((x) => x._id) : []
        page = guarded ? guarded.finish(docs) : docs
        if (guarded?.repeats)
          await withMongo(() =>
            refuseRepeats(client.db(db).collection(coll), ids, {
              comment,
              // The page's own time, a plugin's cap included (eighteenth review, Minor 2).
              maxTimeMS: body.remember ? body.maxTimeMS : Math.min(body.maxTimeMS, PLUGIN_FIND_MS),
              ...(collation ? { collation: collation as never } : {}),
            }),
          )
      } catch (e) {
        // Only a refusal for a document _id: another key's would be refused again (sixteenth
        // review, M1).
        const natural = guarded?.natural
        const d = (e as { details?: { reason?: unknown; field?: unknown } }).details
        if (!natural || d?.reason !== PERSONAL_FIELD || d.field !== '_id') throw e
        await read(natural)
        page = natural.finish(docs)
      }
      if (body.remember && body.record)
        rememberQuery(request, {
          filter: body.filter,
          ...(body.projection ? { projection: body.projection } : {}),
          ...(body.sort ? { sort: body.sort } : {}),
          ...(body.collation ? { collation: body.collation } : {}),
          ...(body.hint !== undefined ? { hint: body.hint } : {}),
        })
      const present = presenterFor(request, guarded?.output ?? null, {
        ns: `${db}.${coll}`,
        stored: !guarded || (!guarded.fromView && !projection),
      })
      return { documents: page.map(present.item), hasMore: more }
    },
  )

  app.post(
    `${base}/count`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(CountRequestSchema, request.body ?? {})
      const filter = fromClient<Filter<Document>>(body.filter, 'filter')
      assertNoServerJs(request, filter)
      const collation = body.collation
        ? { collation: fromClient<Document>(body.collation, 'collation') as never }
        : {}
      const hint =
        body.hint === undefined
          ? {}
          : { hint: typeof body.hint === 'object' ? fromClient<Document>(body.hint, 'hint') : body.hint }
      // Security audit 2026-10-16 (Important 2): a count scans as a find does — one of the same slots.
      holdReadSlot(request, reply, request.server.ctx.documents.slots)
      const client = await clientFor(request)
      const gate = gateFor(request, client)
      const counted = gate
        ? (await withMongo(() => guardCount(db, coll, filter, hint.hint, gate))).filter
        : filter
      const comment = trackOperation(request, reply, client)
      const collection = client.db(db).collection(coll)
      try {
        // A hint can restrict the documents (sparse, partial index): only an exact count honours it.
        if (Object.keys(filter).length === 0 && body.hint === undefined) {
          return {
            count: await collection.estimatedDocumentCount({ maxTimeMS: body.maxTimeMS, comment }),
            exact: false,
          }
        }
        return {
          count: await collection.countDocuments(counted, {
            maxTimeMS: body.maxTimeMS,
            comment,
            ...collation,
            ...hint,
          }),
          exact: true,
        }
      } catch (e) {
        if ((e as { code?: unknown }).code !== 50) throw toAppError(e)
        // Too slow to count exactly: report a cheap lower bound so the UI can show "≥ N" (spec §4.5).
        try {
          const atLeast = await collection.countDocuments(counted, {
            limit: 10_000,
            maxTimeMS: 2_000,
            comment,
            ...collation,
            ...hint,
          })
          return { count: null, exact: false, atLeast }
        } catch {
          return { count: null, exact: false }
        }
      }
    },
  )

  app.post(
    `${base}/documents/get`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { _id } = parseInput(IdRequestSchema, request.body)
      const id = exactId(_id)
      // Security audit 2026-10-16 (Important 2): by _id is quick on a collection, but on a view it
      // runs the view's pipeline — a read slot, and a time limit.
      holdReadSlot(request, reply, request.server.ctx.documents.slots)
      const client = await clientFor(request)
      // A personal _id cannot be named by a restricted user (phase 3c §2).
      const gate = gateFor(request, client)
      const guarded = gate ? await withMongo(() => guardFilterFor(db, coll, byId(id), gate)) : null
      const comment = trackOperation(request, reply, client)
      // Seventeenth and eighteenth reviews (I1-e, Minor 6): two read at once where an _id may
      // repeat, so equal ones are refused rather than the storage-first taken.
      const found = await withMongo(() =>
        client
          .db(db)
          .collection(coll)
          .find(guarded?.filter ?? byId(id), {
            ...READ_OPTIONS,
            maxTimeMS: GET_MAX_TIME_MS,
            comment,
            limit: guarded?.repeats ? 2 : 1,
          })
          .toArray(),
      )
      if (found.length > 1) throw repeatsRefused(`${db}.${coll}`)
      const doc = found[0]
      if (!doc) throw Errors.notFound('Document not found')
      return presenterFor(request, guarded?.output ?? null, {
        ns: `${db}.${coll}`,
        stored: !guarded?.fromView,
      }).item(doc)
    },
  )
}

export async function documentWriteRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/databases/:db/collections/:coll'
  const write = requireConnection('documents:write')

  const changed = () =>
    new AppError(
      'DOCUMENT_CHANGED',
      'The document was changed by someone else since you loaded it; reload and try again',
      409,
    )

  /**
   * Why a pinned write matched nothing. Data review 2026-10-13 round 2 (I1, I2): a version still the
   * one read is one the app cannot match exactly (the old undefined type, a reference with its
   * fields in another order) — said as such, never "changed by someone else", which a reload would
   * only repeat.
   */
  const missed = async (
    collection: Collection,
    id: unknown,
    hash: string,
    read: { repeats: boolean; comment?: string },
  ): Promise<AppError> => {
    // Final review of explain masking (M-A): where an _id may repeat, two read, never the first.
    const found = await withMongo(() =>
      collection
        .find(byId(id), {
          ...READ_OPTIONS,
          limit: read.repeats ? 2 : 1,
          maxTimeMS: GET_MAX_TIME_MS,
          ...(read.comment ? { comment: read.comment } : {}),
        })
        .toArray(),
    )
    if (found.length > 1) return repeatsRefused(collection.namespace)
    const now = found[0]
    return now && safeEqual(hashDocument(now, app.ctx.docPinKey, collection.namespace), hash)
      ? notRoundTrip({ path: '', kind: 'unmatched' })
      : changed()
  }

  /** Loads the current version, checks it against the client's hash, returns a filter that pins it. */
  const pinnedFilter = async (
    collection: Collection,
    id: unknown,
    hash: string,
    read: { repeats: boolean; comment?: string },
  ): Promise<{ filter: Filter<Document>; current: Document }> => {
    // Eighteenth review and final review of explain masking (I-4, M-A): where an _id may repeat,
    // equal ones are refused in the read itself, never the storage-first one taken.
    const found = await withMongo(() =>
      collection
        .find(byId(id), {
          ...READ_OPTIONS,
          limit: read.repeats ? 2 : 1,
          maxTimeMS: GET_MAX_TIME_MS,
          ...(read.comment ? { comment: read.comment } : {}),
        })
        .toArray(),
    )
    if (found.length > 1) throw repeatsRefused(collection.namespace)
    const current = found[0]
    if (!current) throw Errors.notFound('Document not found')
    // An HMAC since phase 3c: compared in constant time like any keyed digest.
    if (!safeEqual(hashDocument(current, app.ctx.docPinKey, collection.namespace), hash)) throw changed()
    // Atomic: the write only applies if the stored document is still exactly this version.
    const filter = { _id: { $eq: id }, $expr: { $eq: ['$$ROOT', { $literal: current }] } } as Filter<Document>
    return { filter, current }
  }

  app.post(
    `${base}/documents`,
    { preHandler: write, config: { masking: 'guarded', audit: 'documents.insert' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(InsertRequestSchema, request.body)
      const docs = body.documents.map((d, i) => fromClient<Document>(d, `documents[${i}]`))
      const client = await clientFor(request)
      // Phase 3c §5.1: a restricted editor's new documents hold no personal value.
      const gate = gateFor(request, client)
      // A unique index a duplicate key would answer for included (final review of the agent's gate, M-C).
      if (gate) await withMongo(() => guardInsert(db, coll, docs, gate))
      const result = await withMongo(() => client.db(db).collection(coll).insertMany(docs, { ordered: true }))
      const ids = Object.values(result.insertedIds).map(toClient)
      request.auditInfo = { details: { count: docs.length, ids: ids.slice(0, MAX_AUDITED_IDS) } }
      return { insertedIds: ids }
    },
  )

  app.post(
    `${base}/documents/update`,
    { preHandler: write, config: { masking: 'guarded', audit: 'documents.update' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(UpdateRequestSchema, request.body)
      const id = exactId(body._id)
      request.auditInfo = { details: { _id: toClient(id), set: Object.keys(body.set), unset: body.unset } }
      const set = fromClient<Document>(body.set, 'set')
      assertNoServerJs(request, set)
      const update: Document = {}
      if (Object.keys(set).length > 0) update.$set = set
      if (body.unset.length > 0) update.$unset = Object.fromEntries(body.unset.map((p) => [p, '']))
      const client = await clientFor(request)
      const gate = gateFor(request, client)
      // Phase 3c §5.1: a personal _id cannot be named; personal values are never changed.
      const named = gate ? await withMongo(() => guardFilterFor(db, coll, byId(id), gate)) : null
      const collection = client.db(db).collection(coll)
      // Eighteenth review (I-4): equal _ids are refused rather than the storage-first changed.
      const read = {
        repeats: named?.repeats === true,
        ...(named?.repeats ? { comment: trackOperation(request, reply, client) } : {}),
      }
      const { filter, current } = await pinnedFilter(collection, id, body.hash, read)
      if (gate) await withMongo(() => guardDocumentUpdate(db, coll, current, set, body.unset, gate))
      // Data review 2026-10-13 (H3, I2): written back from here, a field that does not read back as
      // it is would change (named like Extended JSON, it becomes a typed value, its siblings lost).
      // An update rewrites only the paths it changes: one that leaves such a field alone goes through.
      refuseHazards(
        current,
        { set: Object.keys(body.set), unset: body.unset },
        gate ? gate.masker.forNs(db, coll) : null,
      )
      // The pin compares exactly, whatever the collection's default collation (final review M5).
      const result = await withMongo(() => collection.updateOne(filter, update, PINNED))
      if (result.matchedCount === 0) throw await missed(collection, id, body.hash, read)
      return { modified: result.modifiedCount }
    },
  )

  app.post(
    `${base}/documents/replace`,
    { preHandler: write, config: { masking: 'guarded', audit: 'documents.replace' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(ReplaceRequestSchema, request.body)
      const id = exactId(body._id)
      request.auditInfo = { details: { _id: toClient(id) } }
      const document = fromClient<Document>(body.document, 'document')
      if ('_id' in document && toWire(document._id) !== toWire(id))
        throw Errors.validation('The _id of a document cannot be changed')
      const { _id: _ignored, ...submitted } = document
      const client = await clientFor(request)
      const gate = gateFor(request, client)
      const named = gate ? await withMongo(() => guardFilterFor(db, coll, byId(id), gate)) : null
      const collection = client.db(db).collection(coll)
      const read = {
        repeats: named?.repeats === true,
        ...(named?.repeats ? { comment: trackOperation(request, reply, client) } : {}),
      }
      const { filter, current } = await pinnedFilter(collection, id, body.hash, read)
      // Phase 3c §5.1: "***" where the stored personal values are; they are put back as stored.
      const replacement = gate
        ? await withMongo(() => restoreReplacement(db, coll, current, submitted, gate))
        : submitted
      // Data review 2026-10-13 (H3): a replace rewrites every field; a hidden one is put back as stored.
      refuseHazards(current, null, gate ? gate.masker.forNs(db, coll) : null)
      const result = await withMongo(() => collection.replaceOne(filter, replacement, PINNED))
      if (result.matchedCount === 0) throw await missed(collection, id, body.hash, read)
      return { modified: result.modifiedCount }
    },
  )

  app.post(
    `${base}/documents/delete`,
    { preHandler: write, config: { masking: 'guarded', audit: 'documents.delete' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { _id } = parseInput(IdRequestSchema, request.body)
      const id = exactId(_id)
      request.auditInfo = { details: { _id: toClient(id) } }
      const client = await clientFor(request)
      // Deleting by a personal _id would tell whether that value exists (phase 3c §2).
      const gate = gateFor(request, client)
      const named = gate ? await withMongo(() => guardFilterFor(db, coll, byId(id), gate)) : null
      const collection = client.db(db).collection(coll)
      // Final reviews of explain masking (I-B, I-1): where an _id may repeat in an order rules hide,
      // a delete by it would take the storage-first of twins added at any moment, and no filter can
      // pin the one read (a series' delete evaluates $expr on its buckets, not its measurements:
      // measured on 8.2; a stored field name put in a filter would be a path or an operator).
      if (named?.idRepeats)
        throw orderRefused(
          'Deleting one document by _id where documents may share it (a bulk delete by a filter deletes each it matches)',
          `${db}.${coll}`,
        )
      const result = await withMongo(() => collection.deleteOne(byId(id)))
      if (result.deletedCount === 0) throw Errors.notFound('Document not found')
      return reply.status(204).send()
    },
  )
}
