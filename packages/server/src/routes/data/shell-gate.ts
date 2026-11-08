// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'
import { Errors } from '../../errors'
import { mayUseShell } from '../../connections/access'

/**
 * The shell's own routes (history, snippets) need mayUseShell on top of the connection guard: a
 * connection admin, or an editor with the per-connection shell grant (phase 3a-1 §9).
 */
export function guardShell(request: FastifyRequest): void {
  if (!mayUseShell(request.server.ctx, request.principal!, request.connection!.id)) {
    throw Errors.forbidden('You may not use the shell on this connection')
  }
}
