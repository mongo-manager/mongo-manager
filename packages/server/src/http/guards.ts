// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'
import { DATA_WRITE_PERMISSIONS, permissionsFor, type Permission } from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { Principal } from './context'

export async function requireAuth(request: FastifyRequest): Promise<void> {
  if (!request.principal) throw Errors.unauthenticated()
}

export async function requireTeamMode(request: FastifyRequest): Promise<void> {
  if (!request.server.ctx.config.auth) {
    throw Errors.conflict('This endpoint is only available in team mode (--auth)')
  }
}

export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest): Promise<void> => {
    const principal = request.principal
    if (!principal) throw Errors.unauthenticated()
    const { readOnly } = request.server.ctx.config
    if (permissionsFor(principal.role, { readOnly }).has(permission)) return
    if (
      readOnly &&
      DATA_WRITE_PERMISSIONS.has(permission) &&
      permissionsFor(principal.role).has(permission)
    ) {
      throw Errors.readOnly()
    }
    throw Errors.forbidden()
  }
}

export function userPrincipal(request: FastifyRequest): Extract<Principal, { kind: 'user' }> {
  const principal = request.principal
  if (principal?.kind !== 'user') throw Errors.unauthenticated()
  return principal
}
