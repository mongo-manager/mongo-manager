// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { LOCAL_KEY_HEADER } from '../../auth/launch'
import { readLocalCookie } from '../../http/principal'

/**
 * W6.3: the agent's tools act through the app's own routes — their permission checks, read-only mode,
 * masking gate, rate limits and audit — as the person who asked, never through the driver directly.
 *
 * A route is called in process (Fastify's inject) with a token in this header. The token is random
 * (256 bits), held in memory only, never sent anywhere, taken once, and good for a minute: it stands
 * for the person's session (or local browser), which is read again for every call — a session
 * revoked meanwhile, or a user disabled, is refused like any request of theirs.
 */
export const AGENT_CALL_HEADER = 'x-mm-agent-call'
const TOKEN_MS = 60_000

/**
 * Design 2026-10-25 (B6): the turn a call is made for — its run, its chat and the call (the step) —
 * written with the routes' own audit rows. Held with the token in the process only: no request can say
 * it of itself.
 */
export interface AgentVia {
  run: string
  chat?: string
  call?: string
}

/** Who the agent acts as: the session (team mode) or the browser (local mode), and where from. */
export type AgentAuth = { ip: string; host: string | undefined; via?: AgentVia } & (
  | { kind: 'user'; sessionId: string }
  | { kind: 'local'; localCookie: string | undefined; localKey: string | undefined }
)

/** The person behind a request, for the calls made on their behalf. */
export function agentAuthOf(request: FastifyRequest): AgentAuth {
  const principal = request.principal!
  // W6.3 security review (minor 9): the name the request was accepted under — behind a trusted proxy
  // the forwarded one — never the raw Host header (an internal name the allowlist does not hold).
  // The calls go through the same host check with it.
  const host = request.host || undefined
  if (principal.kind === 'user') return { kind: 'user', sessionId: principal.sessionId, ip: request.ip, host }
  const key = request.headers[LOCAL_KEY_HEADER]
  return {
    kind: 'local',
    localCookie: readLocalCookie(request),
    localKey: typeof key === 'string' ? key : undefined,
    ip: request.ip,
    host,
  }
}

export class AgentCalls {
  private readonly live = new Map<string, { auth: AgentAuth; until: number }>()
  constructor(private readonly now: () => number) {}

  issue(auth: AgentAuth): string {
    const t = this.now()
    for (const [k, v] of this.live) if (v.until <= t) this.live.delete(k)
    const token = randomBytes(32).toString('base64url')
    this.live.set(token, { auth, until: t + TOKEN_MS })
    return token
  }

  /** The person a token stands for, once; null for a token unknown, used or expired. */
  take(token: string): AgentAuth | null {
    const hit = this.live.get(token)
    if (!hit) return null
    this.live.delete(token)
    return hit.until > this.now() ? hit.auth : null
  }
}

export interface RouteAnswer {
  status: number
  /** The JSON answer, or null (none, or not JSON). */
  body: unknown
  text: string
}

/** One call of an API route (`path` under /api) as the person. */
export async function callRoute(
  app: FastifyInstance,
  auth: AgentAuth,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<RouteAnswer> {
  const { ctx } = app
  const prefix = ctx.config.basePath.replace(/\/$/, '')
  const token = ctx.ai.agent.calls.issue(auth)
  const headers: Record<string, string> = { [AGENT_CALL_HEADER]: token }
  if (auth.host) headers.host = auth.host
  // The person's own CSRF token, as their page would send it (the route checks it as usual).
  const csrf = auth.kind === 'user' ? ctx.sessions.get(auth.sessionId)?.csrfToken : ctx.localCsrfToken
  if (csrf) headers['x-csrf-token'] = csrf
  if (auth.kind === 'local' && auth.localKey) headers[LOCAL_KEY_HEADER] = auth.localKey
  const res = await app.inject({
    method,
    url: `${prefix}/api${path}`,
    headers,
    remoteAddress: auth.ip,
    ...(body !== undefined ? { payload: body as object } : {}),
  })
  let parsed: unknown
  try {
    parsed = res.payload ? (JSON.parse(res.payload) as unknown) : null
  } catch {
    parsed = null
  }
  return { status: res.statusCode, body: parsed, text: res.payload }
}
