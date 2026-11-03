import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Errors } from '../errors'
import { checkOrigin } from '../http/security'
import type { RealtimeHub } from '../realtime/hub'

/**
 * Phase 1h spec §4. A page on another site can open a WebSocket to us with the user's cookie
 * (cross-site WebSocket hijacking): the Origin is required and must be our own, before the
 * upgrade. The Host allowlist already ran for every request; the session is checked here, and the
 * CSRF token in the first message.
 */
async function guardUpgrade(request: FastifyRequest): Promise<void> {
  if (request.headers.origin === undefined) throw Errors.forbidden('Cross-origin request blocked')
  checkOrigin(request)
  if (!request.principal) throw Errors.unauthenticated()
}

export async function wsRoutes(app: FastifyInstance, opts: { hub: RealtimeHub }): Promise<void> {
  app.get('/ws', { websocket: true, preValidation: guardUpgrade }, (socket, request) => {
    opts.hub.attach(socket, request.principal!, request.ip)
  })
}
