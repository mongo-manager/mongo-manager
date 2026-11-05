// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { SnippetBodySchema, SnippetUpdateSchema, type SnippetView } from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import type { ByteBudget } from '../../queries/budget'
import {
  MAX_SNIPPET_BYTES,
  MAX_SNIPPETS_PER_CONNECTION,
  MAX_SNIPPETS_TOTAL_PER_CONNECTION,
  SNIPPET_LIST_BYTES,
  type SnippetRow,
} from '../../queries/snippets'
import { guardShell } from './shell-gate'
import { ownerOf, seesOwnerless } from './owners'

const BASE = '/connections/:id/snippets'
const ItemParams = z.object({ id: z.string().max(64), snippetId: z.string().uuid() })

function view(request: FastifyRequest, row: SnippetRow): SnippetView {
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    code: row.body.code,
    params: row.body.params,
    shared: row.shared,
    mine: row.ownerId === ownerOf(request),
    owner: row.ownerName,
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

/** The sealed body, bounded. */
function storedBody(body: { code: string; params: SnippetRow['body']['params'] }): SnippetRow['body'] {
  const stored = { code: body.code, params: body.params }
  if (Buffer.byteLength(JSON.stringify(stored)) > MAX_SNIPPET_BYTES)
    throw Errors.validation('This snippet is too large to save (64 KiB at most)')
  return stored
}

/**
 * Phase 3a-2 spec §3.5: shell snippets, private or shared with everyone who may use the shell on the
 * connection. The rules are those of favourites: only the owner changes a snippet (a connection
 * admin changes an ownerless one); the owner or a connection admin deletes it. The code is never
 * written to the audit log — only the name, tags and sharing.
 */
export async function snippetRoutes(app: FastifyInstance): Promise<void> {
  const repo = () => app.ctx.snippets

  const visible = (request: FastifyRequest): SnippetRow => {
    const { snippetId } = parseInput(ItemParams, request.params)
    const row = repo().get(snippetId)
    if (
      !row ||
      row.connectionId !== request.connection!.id ||
      !(row.ownerId === ownerOf(request) || row.shared || (row.ownerId === null && seesOwnerless(request)))
    )
      throw Errors.notFound('Snippet not found')
    return row
  }

  app.get(
    BASE,
    { preHandler: requireConnection('documents:read'), config: { masking: 'denied' } },
    async (request) => {
      guardShell(request)
      // Bounded by bytes opened: what does not fit is left out, and the answer says so (final review M8).
      const budget: ByteBudget = { left: SNIPPET_LIST_BYTES, exhausted: false }
      const rows = repo().list({
        ownerId: ownerOf(request),
        connectionId: request.connection!.id,
        ownerless: seesOwnerless(request),
        budget,
      })
      return { snippets: rows.map((r) => view(request, r)), ...(budget.exhausted ? { truncated: true } : {}) }
    },
  )

  // One snippet, for the shell to open without listing them all (final review M8).
  app.get(
    `${BASE}/:snippetId`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'denied' } },
    async (request) => {
      guardShell(request)
      return view(request, visible(request))
    },
  )

  app.post(
    BASE,
    {
      preHandler: requireConnection('documents:read'),
      config: { masking: 'denied', audit: 'snippets.save' },
    },
    async (request, reply) => {
      guardShell(request)
      const body = parseInput(SnippetBodySchema, request.body ?? {})
      request.auditInfo = { details: { name: body.name, tags: body.tags, shared: body.shared } }
      const owner = ownerOf(request)
      if (repo().countFor(owner, request.connection!.id) >= MAX_SNIPPETS_PER_CONNECTION)
        throw Errors.conflict(`At most ${MAX_SNIPPETS_PER_CONNECTION} snippets can be saved per connection`, {
          reason: 'limit',
          max: MAX_SNIPPETS_PER_CONNECTION,
        })
      if (repo().countAll(request.connection!.id) >= MAX_SNIPPETS_TOTAL_PER_CONNECTION)
        throw Errors.conflict(
          `This connection already has ${MAX_SNIPPETS_TOTAL_PER_CONNECTION} snippets, the most it keeps`,
          { reason: 'limit', max: MAX_SNIPPETS_TOTAL_PER_CONNECTION },
        )
      const row = repo().create({
        ownerId: owner,
        connectionId: request.connection!.id,
        name: body.name.trim(),
        tags: body.tags,
        body: storedBody(body),
        shared: body.shared,
      })
      return reply.status(201).send(view(request, row))
    },
  )

  app.put(
    `${BASE}/:snippetId`,
    {
      preHandler: requireConnection('documents:read'),
      config: { masking: 'denied', audit: 'snippets.save' },
    },
    async (request) => {
      guardShell(request)
      const row = visible(request)
      const body = parseInput(SnippetUpdateSchema, request.body ?? {})
      // W5: code and parameters are edited too; the log says whether they changed, never what they are.
      const codeChanged =
        body.code !== row.body.code || JSON.stringify(body.params) !== JSON.stringify(row.body.params)
      request.auditInfo = {
        details: {
          name: body.name,
          ...(body.tags ? { tags: body.tags } : {}),
          shared: body.shared,
          codeChanged,
        },
      }
      const mayEdit =
        row.ownerId === ownerOf(request) || (row.ownerId === null && request.connectionRole === 'admin')
      if (!mayEdit) throw Errors.forbidden('Only the owner can change this snippet')
      const updated = repo().update(row.id, {
        name: body.name.trim(),
        ...(body.tags ? { tags: body.tags } : {}),
        body: storedBody(body),
        shared: body.shared,
      })
      return view(request, updated!)
    },
  )

  app.delete(
    `${BASE}/:snippetId`,
    {
      preHandler: requireConnection('documents:read'),
      config: { masking: 'denied', audit: 'snippets.delete' },
    },
    async (request, reply) => {
      guardShell(request)
      const row = visible(request)
      request.auditInfo = { details: { name: row.name, tags: row.tags } }
      if (!(row.ownerId === ownerOf(request) || request.connectionRole === 'admin'))
        throw Errors.forbidden('Only the owner or a connection admin can delete this snippet')
      repo().delete(row.id)
      return reply.status(204).send()
    },
  )
}
