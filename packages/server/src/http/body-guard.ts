import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * Security audit 2026-10-16 (Important 1): how long a request's body may take. Node's own
 * requestTimeout is one deadline for every request — a multi-GiB import upload streams for longer
 * than any sane bound — so the server keeps it off and bounds bodies here instead:
 * - no body byte for `bodyIdleMs` closes the connection (every request);
 * - an anonymous request (sign-in, setup: at most the 1 MiB JSON limit) has `anonymousBodyMs` in all;
 * - a signed-in request whose body is parsed in memory (JSON, a plugin archive) has `bodyMs` in all.
 * Routes that stream their body to disk (`config.streamBody`) are bounded by idleness only, as their
 * receivers already are (UPLOAD_IDLE_MS).
 */
export interface BodyLimits {
  bodyIdleMs: number
  anonymousBodyMs: number
  bodyMs: number
}

export const BODY_LIMITS: BodyLimits = {
  bodyIdleMs: 60_000,
  anonymousBodyMs: 30_000,
  bodyMs: 10 * 60_000,
}

/** How often a body's progress is looked at; a fraction of the shortest bound. */
const tickOf = (limits: BodyLimits) =>
  Math.max(10, Math.min(1_000, Math.floor(Math.min(limits.bodyIdleMs, limits.anonymousBodyMs) / 4)))

function hasBody(request: FastifyRequest): boolean {
  const length = request.headers['content-length']
  if (length !== undefined) return length !== '0'
  return request.headers['transfer-encoding'] !== undefined
}

/**
 * Starts a body's clock as soon as its head arrived (before the guards, so a refusal whose body Node
 * then drains is bounded too). Progress is read from the socket's byte count, never by listening for
 * the body's data, which would start it flowing before its parser is attached.
 */
export function guardBodies(app: FastifyInstance, limits: BodyLimits = BODY_LIMITS): void {
  const tick = tickOf(limits)
  app.addHook('onRequest', async (request) => {
    const raw = request.raw
    const socket = raw.socket as { bytesRead?: number; destroyed?: boolean } | null
    if (!hasBody(request) || !socket || typeof socket.bytesRead !== 'number') return
    const started = Date.now()
    let seen = socket.bytesRead
    let lastByteAt = started
    const stop = () => clearInterval(timer)
    const timer = setInterval(() => {
      if (raw.complete || raw.destroyed || socket.destroyed) return stop()
      const now = Date.now()
      const streamed = request.routeOptions.config?.streamBody === true
      // Independent review (minor): a streamed upload the server holds back (paused while a chunk is
      // written, its buffer full while it connects) is waiting on the server, not on its client.
      const heldBack = streamed && (raw.isPaused() || raw.readableLength >= raw.readableHighWaterMark)
      if (socket.bytesRead !== seen || heldBack) {
        seen = socket.bytesRead!
        lastByteAt = now
      }
      const total = request.principal ? (streamed ? Infinity : limits.bodyMs) : limits.anonymousBodyMs
      if (now - lastByteAt >= limits.bodyIdleMs || now - started >= total) {
        stop()
        request.log.info({ reqId: request.id }, 'request body too slow: connection closed')
        raw.destroy()
      }
    }, tick)
    timer.unref()
    raw.once('end', stop)
    raw.once('close', stop)
  })
}
