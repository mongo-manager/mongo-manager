import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  SavedPipelineBodySchema,
  SavedPipelineUpdateSchema,
  type SavedPipelineView,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { viewAwareMaskerFor } from '../../masking/restricted'
import type { Masker } from '../../masking/match'
import { maskPipelineDef } from '../../masking/definitions'
import { requireConnection } from '../../connections/access'
import { fromClient } from '../../data/ejson-io'
import {
  MAX_SAVED_BYTES,
  MAX_SAVED_PER_NAMESPACE,
  packPipeline,
  type SavedPipelineRow,
} from '../../aggregation/saved'
import type { PipelineAssistant } from '@mongo-manager/shared'
import { CollParams } from './params'
import { ownerOf, seesOwnerless } from './owners'
import { maskedEdit } from './masked-edit'

const BASE = '/connections/:id/databases/:db/collections/:coll/pipelines'
const ItemParams = CollParams.extend({ pipelineId: z.string().uuid() })

function view(
  request: FastifyRequest,
  row: SavedPipelineRow,
  masker: Masker | null = null,
): SavedPipelineView {
  const mine = row.ownerId === ownerOf(request)
  const stages = JSON.parse(row.text) as unknown[]
  // Phase 3c §4.6: someone else's literals at personal paths are hidden from a restricted user.
  // The view-aware masker of the listing (final review I3); none for the caller's own items.
  const hidden = mine ? null : masker
  return {
    id: row.id,
    name: row.name,
    stages: hidden ? (maskPipelineDef(stages, row.db, row.coll, hidden) as unknown[]) : stages,
    tags: row.tags,
    shared: row.shared,
    mine,
    owner: row.ownerName,
    updatedAt: new Date(row.updatedAt).toISOString(),
    // The steps are the owner's own words (and may name values): never given to anyone else.
    ...(mine && row.assistant ? { assistant: row.assistant } : {}),
  }
}

/**
 * The body's pipeline as stored: canonical EJSON text (with the assistant's steps, when given),
 * each pipeline checked to decode, the whole bounded in size.
 */
function storedText(stages: unknown[], assistant?: PipelineAssistant): string {
  fromClient(stages, 'stages')
  for (const step of assistant?.steps ?? []) fromClient(step.stages, 'assistant.steps.stages')
  const stagesText = JSON.stringify(stages)
  if (Buffer.byteLength(stagesText) > MAX_SAVED_BYTES)
    throw Errors.validation('This pipeline is too large to save (256 KiB at most)')
  // Final review Minor 5: the steps never stop a pipeline that fits alone — the oldest go first.
  const steps = [...(assistant?.steps ?? [])]
  let text = packPipeline(stagesText, steps.length ? { steps } : undefined)
  while (Buffer.byteLength(text) > MAX_SAVED_BYTES && steps.length) {
    steps.shift()
    text = packPipeline(stagesText, steps.length ? { steps } : undefined)
  }
  return text
}

/** Phase 2a spec §3.2: saved pipelines, private or shared with everyone who can use the connection. */
export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  const repo = () => app.ctx.savedPipelines

  /** A pipeline this user may see in this collection, or 404. */
  const visible = (request: FastifyRequest): SavedPipelineRow => {
    const { db, coll, pipelineId } = parseInput(ItemParams, request.params)
    const row = repo().get(pipelineId)
    const owner = ownerOf(request)
    if (
      !row ||
      row.connectionId !== request.connection!.id ||
      row.db !== db ||
      row.coll !== coll ||
      !(row.ownerId === owner || row.shared || (row.ownerId === null && seesOwnerless(request)))
    )
      throw Errors.notFound('Pipeline not found')
    return row
  }

  app.get(
    BASE,
    { preHandler: requireConnection('aggregation:run'), config: { masking: 'guarded' } },
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
      return { pipelines: rows.map((r) => view(request, r, masker)) }
    },
  )

  app.post(
    BASE,
    {
      preHandler: requireConnection('aggregation:run'),
      config: { masking: 'names-only', audit: 'pipelines.save' },
    },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(SavedPipelineBodySchema, request.body ?? {})
      request.auditInfo = { details: { name: body.name, tags: body.tags, shared: body.shared } }
      const text = storedText(body.stages, body.assistant)
      const owner = ownerOf(request)
      if (repo().countFor(owner, request.connection!.id, db, coll) >= MAX_SAVED_PER_NAMESPACE)
        throw Errors.conflict(`At most ${MAX_SAVED_PER_NAMESPACE} pipelines can be saved per collection`, {
          reason: 'limit',
          max: MAX_SAVED_PER_NAMESPACE,
        })
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
    `${BASE}/:pipelineId`,
    {
      preHandler: requireConnection('aggregation:run'),
      config: { masking: 'names-only', audit: 'pipelines.save' },
    },
    async (request) => {
      const row = visible(request)
      const body = parseInput(SavedPipelineUpdateSchema, request.body ?? {})
      request.auditInfo = {
        details: { name: body.name, ...(body.tags ? { tags: body.tags } : {}), shared: body.shared },
      }
      // Only its owner changes a pipeline; one saved in local mode (no owner) by a connection admin.
      const mayEdit =
        row.ownerId === ownerOf(request) || (row.ownerId === null && request.connectionRole === 'admin')
      if (!mayEdit) throw Errors.forbidden('Only the owner can change this pipeline')
      // A local-mode pipeline a connection admin was shown masked: what came back is kept as stored
      // (final review of the query parameters, Minor 9).
      const hidden =
        row.ownerId === ownerOf(request) ? null : await viewAwareMaskerFor(request, [[row.db, row.coll]])
      const stored = JSON.parse(row.text) as unknown[]
      const kept =
        hidden &&
        maskedEdit(maskPipelineDef(stored, row.db, row.coll, hidden), stored, body.stages, 'pipeline') ===
          'keep'
      const updated = repo().update(row.id, {
        name: body.name.trim(),
        ...(body.tags ? { tags: body.tags } : {}),
        // Final review I3: steps left out of a change (a rename, a share) stay as they are.
        text: kept
          ? storedText(stored, row.assistant)
          : storedText(body.stages, body.assistant ?? row.assistant),
        shared: body.shared,
      })
      return view(request, updated!)
    },
  )

  app.delete(
    `${BASE}/:pipelineId`,
    {
      preHandler: requireConnection('aggregation:run'),
      config: { masking: 'names-only', audit: 'pipelines.delete' },
    },
    async (request, reply) => {
      const row = visible(request)
      request.auditInfo = { details: { name: row.name } }
      const mayDelete = row.ownerId === ownerOf(request) || request.connectionRole === 'admin'
      if (!mayDelete) throw Errors.forbidden('Only the owner or a connection admin can delete this pipeline')
      repo().delete(row.id)
      return reply.status(204).send()
    },
  )
}
