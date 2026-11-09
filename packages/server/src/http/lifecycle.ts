// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * Independent review of the security pass (I1, I2): when a route's handler is done with its work.
 * A response can close long before that (its client left, its socket was destroyed) while the
 * handler's MongoDB operation goes on; what it holds — a read slot, a connection — is given back
 * once both are over, never at the close alone.
 */
/** How a handler ended: its value, or what it threw (second review: an aborted request's audit). */
export type HandlerOutcome = { ok: true } | { ok: false; error: unknown }

const state = new WeakMap<
  FastifyRequest,
  { outcome: HandlerOutcome | null; callbacks: Array<(outcome: HandlerOutcome) => void> }
>()

const stateOf = (request: FastifyRequest) => {
  let s = state.get(request)
  if (!s) {
    s = { outcome: null, callbacks: [] }
    state.set(request, s)
  }
  return s
}

function settle(request: FastifyRequest, outcome: HandlerOutcome): void {
  const s = stateOf(request)
  s.outcome = outcome
  for (const callback of s.callbacks.splice(0)) callback(outcome)
}

/** Runs `callback` once the request's handler has returned or thrown (at once if it has). */
export function whenHandlerSettled(
  request: FastifyRequest,
  callback: (outcome: HandlerOutcome) => void,
): void {
  const s = stateOf(request)
  if (s.outcome) callback(s.outcome)
  else s.callbacks.push(callback)
}

/**
 * Wraps every route's handler to tell when it settled, and switches the socket's idle timeout off
 * while a handler works: a $out or a bulk update may run silently for hours (independent review I1);
 * the timeout is back as soon as the answer goes out, so an idle keep-alive socket and a client that
 * stops reading are still closed. Headers and bodies have their own bounds (body-guard.ts).
 */
export function trackHandlers(app: FastifyInstance, idleMs: number): void {
  app.addHook('onRoute', (route) => {
    // A WebSocket route's handler is called with the socket: the ws plugin manages it.
    if ((route as { websocket?: boolean }).websocket) return
    const handler = route.handler as (this: unknown, ...args: unknown[]) => unknown
    route.handler = function (this: unknown, ...args: unknown[]) {
      const request = args[0] as FastifyRequest
      let result: unknown
      try {
        result = handler.apply(this, args)
      } catch (error) {
        settle(request, { ok: false, error })
        throw error
      }
      if (result && typeof (result as PromiseLike<unknown>).then === 'function')
        Promise.resolve(result).then(
          () => settle(request, { ok: true }),
          (error: unknown) => settle(request, { ok: false, error }),
        )
      else settle(request, { ok: true })
      return result
    } as typeof route.handler
  })
  const idle = (request: FastifyRequest, ms: number) => {
    const socket = request.raw.socket as { setTimeout?: (ms: number) => unknown } | null
    if (typeof socket?.setTimeout === 'function') socket.setTimeout(ms)
  }
  app.addHook('preHandler', async (request) => idle(request, 0))
  app.addHook('onSend', async (request, _reply, payload) => {
    if (idleMs > 0) idle(request, idleMs)
    return payload
  })
}
