// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'

/** The owner of what a user keeps (history, favourites, pipelines): null is local mode's single user. */
export const ownerOf = (request: FastifyRequest): string | null =>
  request.principal?.kind === 'user' ? request.principal.userId : null

/**
 * Items saved in local mode have no owner. They are the local user's own, and in team mode only
 * connection admins see them: they may hold personal data (final review 2a, I8).
 */
export const seesOwnerless = (request: FastifyRequest): boolean =>
  !request.server.ctx.config.auth || request.connectionRole === 'admin'
