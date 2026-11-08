// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseInput } from '../validate'
import { ipThrottleKey } from '../auth/throttle'
import { setLocalCookie } from '../http/principal'
import { recordFailure } from './auth'
import { Errors } from '../errors'

const Params = z.object({ token: z.string().min(1).max(200) })

/**
 * Security audit 2026-10-16 (important 2): a local launch link. A valid token (once, unexpired) gives
 * this browser a cookie of its own (auth/launch); either way the browser goes on to an address
 * without the token (a redirect: the address bar and the history keep none). The token is never
 * logged (http/app's request serializer) nor audited.
 *
 * Review of the audit fixes: GET only — a HEAD took the token and set the cookie (minor 1); and
 * other accounts' guesses never hold a real link back nor get a JSON answer: a valid token is taken
 * whatever came before it, and the guesses, held back per address, only stop being audited (minor 2).
 */
export async function launchRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const base = ctx.config.basePath
  app.get('/launch/:token', { exposeHeadRoute: false }, async (request, reply) => {
    const { token } = parseInput(Params, request.params)
    reply.header('cache-control', 'no-store')
    if (ctx.launch?.take(token)) {
      ctx.audit.append({
        action: 'auth.launch',
        outcome: 'success',
        userId: null,
        username: null,
        ip: request.ip,
      })
      setLocalCookie(request, reply, ctx.launch.open(request.headers['user-agent']))
      return reply.redirect(base, 303)
    }
    const ipKey = `launch:${ipThrottleKey(request.ip)}`
    if (ctx.throttle.retryAfterMs(ipKey) === 0) {
      recordFailure(ctx, [ipKey])
      ctx.audit.append({
        action: 'auth.launch',
        outcome: 'denied',
        userId: null,
        username: null,
        ip: request.ip,
      })
    }
    return reply.redirect(`${base}open-link?link=expired`, 303)
  })

  /**
   * Second review (minor 3): `mongo-manager forget-browsers` asks the running server, with a one-time
   * token of its own kind made from the same secret, to sign every browser out — so the local shells,
   * and a command running in them, end at once too.
   */
  app.post('/launch/forget/:token', { config: { csrf: false } }, async (request) => {
    const { token } = parseInput(Params, request.params)
    const ipKey = `launch:${ipThrottleKey(request.ip)}`
    if (!ctx.launch?.take(token, 'forget')) {
      if (ctx.throttle.retryAfterMs(ipKey) === 0) recordFailure(ctx, [ipKey])
      throw Errors.unauthenticated('Not a valid request to sign the browsers out')
    }
    const removed = ctx.launch.forgetAll()
    ctx.audit.append({
      action: 'auth.local.signOutAll',
      outcome: 'success',
      userId: null,
      username: null,
      ip: request.ip,
      details: { removed, from: 'cli' },
    })
    return { removed }
  })
}
