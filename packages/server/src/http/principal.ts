// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Principal } from './context'
import { LOCAL_COOKIE_MAX_AGE_S } from '../auth/launch'
import { AGENT_CALL_HEADER } from '../ai/agent/calls'
import type { ServerContext } from './context'

export const SESSION_COOKIE_SECURE = '__Host-mm_sid'
/** `__Host-` requires Path=/; under a base path the secure cookie is `__Secure-` and scoped to it. */
export const SESSION_COOKIE_SECURE_SCOPED = '__Secure-mm_sid'
export const SESSION_COOKIE_PLAIN = 'mm_sid'

/**
 * The cookie of this name for this request: named by protocol (a plain cookie planted over HTTP
 * must not work over HTTPS) and scoped to basePath (other apps on the same host behind the proxy
 * never receive it).
 */
function cookieFor(request: FastifyRequest, base: string): { name: string; secure: boolean; path: string } {
  const path = request.server.ctx.config.basePath
  const secure = request.protocol === 'https'
  const name = !secure ? base : path === '/' ? `__Host-${base}` : `__Secure-${base}`
  return { name, secure, path }
}

/** The one cookie that carries the session for this request. */
export function sessionCookie(request: FastifyRequest): { name: string; secure: boolean; path: string } {
  return cookieFor(request, SESSION_COOKIE_PLAIN)
}

/**
 * Local mode: this browser's cookie (auth/launch), named for the installation, long-lived and
 * renewed whenever the app starts in it.
 */
export function setLocalCookie(request: FastifyRequest, reply: FastifyReply, value: string): void {
  const { launch } = request.server.ctx
  if (!launch) return
  const { name, secure, path } = cookieFor(request, launch.cookieName)
  reply.setCookie(name, value, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path,
    maxAge: LOCAL_COOKIE_MAX_AGE_S,
  })
}

export function clearLocalCookie(request: FastifyRequest, reply: FastifyReply): void {
  const { launch } = request.server.ctx
  if (!launch) return
  const { name, secure, path } = cookieFor(request, launch.cookieName)
  reply.clearCookie(name, { httpOnly: true, sameSite: 'strict', secure, path })
}

/** The local cookie this request carries. */
export function readLocalCookie(request: FastifyRequest): string | undefined {
  const { launch } = request.server.ctx
  return launch ? request.cookies[cookieFor(request, launch.cookieName).name] : undefined
}

export function readSessionId(request: FastifyRequest): string | undefined {
  return request.cookies[sessionCookie(request).name]
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, sessionId: string): void {
  const { name, secure, path } = sessionCookie(request)
  reply.setCookie(name, sessionId, { httpOnly: true, sameSite: 'strict', secure, path })
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  const path = request.server.ctx.config.basePath
  const secureName = path === '/' ? SESSION_COOKIE_SECURE : SESSION_COOKIE_SECURE_SCOPED
  reply.clearCookie(secureName, { path, secure: true, httpOnly: true, sameSite: 'strict' })
  reply.clearCookie(SESSION_COOKIE_PLAIN, { path, httpOnly: true, sameSite: 'strict' })
}

export function resolvePrincipal(request: FastifyRequest): Principal | null {
  const { ctx } = request.server
  // W6.3: a route the agent calls in process for the person (ai/agent/calls). The token is taken
  // once; the person is read again from their session or browser, as for any request of theirs.
  const agent = request.headers[AGENT_CALL_HEADER]
  if (agent !== undefined) {
    const auth = typeof agent === 'string' ? ctx.ai.agent.calls.take(agent) : null
    if (!auth) return null
    // B6: the turn the call is made for, for the route's audit row.
    request.agentVia = auth.via ?? null
    return auth.kind === 'user'
      ? principalOf(ctx, { sessionId: auth.sessionId })
      : principalOf(ctx, { localCookie: auth.localCookie })
  }
  return principalOf(ctx, { localCookie: readLocalCookie(request), sessionId: readSessionId(request) })
}

function principalOf(
  ctx: ServerContext,
  from: { localCookie?: string | undefined; sessionId?: string | undefined },
): Principal | null {
  if (!ctx.config.auth) {
    // Security audit 2026-10-16: the owner is a browser that opened a launch link — not every
    // process that reaches the port. Its page key is checked by the gate (http/app).
    const browser = ctx.launch?.browser(from.localCookie) ?? null
    if (!browser) return null
    return {
      kind: 'local',
      userId: 'local',
      username: 'owner',
      role: 'admin',
      csrfToken: ctx.localCsrfToken,
      browser,
    }
  }
  const sessionId = from.sessionId
  if (!sessionId) return null
  const session = ctx.sessions.get(sessionId)
  if (!session) return null
  const user = ctx.users.findById(session.userId)
  if (!user || user.disabled) {
    ctx.sessions.revoke(sessionId)
    return null
  }
  return {
    kind: 'user',
    userId: user.id,
    username: user.username,
    role: user.role,
    csrfToken: session.csrfToken,
    sessionId,
    sessionIdHash: session.idHash,
  }
}
