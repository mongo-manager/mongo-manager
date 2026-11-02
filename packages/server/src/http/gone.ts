import type { FastifyReply } from 'fastify'

/**
 * Aborted once the response's client is gone before it was sent. A request's own 'close' fires once
 * its body is read (Node 16+), not when its client leaves: the response's is the one to follow.
 */
export function abortOnGone(reply: FastifyReply): AbortController {
  const ctl = new AbortController()
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) ctl.abort()
  })
  return ctl
}
