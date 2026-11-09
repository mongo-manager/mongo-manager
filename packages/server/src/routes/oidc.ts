// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AppError, Errors } from '../errors'
import { parseInput } from '../validate'
import { requirePermission, requireTeamMode } from '../http/guards'
import { personOf, requireConnection } from '../connections/access'
import { connectionProblem } from '../connections/policy'
import { ownOrigin } from '../http/security'
import { OidcFlowError, flowIdOf } from '../oidc/broker'
import type { OidcIdentity } from '../oidc/tokens'

/**
 * W7 (completion): MONGODB-OIDC sign-in, for the person asking. Anyone who may open a connection
 * signs themselves in on it — in team mode with their own tokens, never shared — and out again; its
 * administrators see who is signed in and revoke them all. The identity provider sends the browser
 * back to GET <base>/oidc/callback, outside the API (that navigation carries neither the page key
 * nor a strict cookie): what proves the browser is the flow's own binding cookie.
 */
const StartBody = z.object({
  flow: z.enum(['code', 'device']).default('code'),
  returnTo: z.string().max(512).optional(),
})
const CallbackQuery = z.object({
  state: z.string().max(512).default(''),
  code: z.string().max(4096).optional(),
  error: z.string().max(256).optional(),
})

const BINDING = 'mm_oidc'
const BINDING_MAX_AGE_S = 600

/**
 * The flow's cookie: one per flow (named by its id, so several sign-ins can wait at once), sent on
 * the IdP's top-level redirect. Security review Minor 1: on https at the root it is a __Host- cookie
 * (Secure, Path=/, no Domain: no other host or path can set it); under a base path __Secure-,
 * scoped to the callback.
 */
export function bindingCookie(o: { secure: boolean; basePath: string; flowId: string }): {
  name: string
  secure: boolean
  path: string
} {
  const base = `${BINDING}_${o.flowId}`
  if (o.secure && o.basePath === '/') return { name: `__Host-${base}`, secure: true, path: '/' }
  return { name: o.secure ? `__Secure-${base}` : base, secure: o.secure, path: `${o.basePath}oidc/` }
}
const cookieFor = (request: FastifyRequest, flowId: string) =>
  bindingCookie({
    secure: request.protocol === 'https',
    basePath: request.server.ctx.config.basePath,
    flowId,
  })

/** Where the browser goes back to: a path of this app only (never another host). */
function safeReturn(basePath: string, returnTo: string | undefined): string {
  if (!returnTo || !returnTo.startsWith(basePath) || /[\\\s]/.test(returnTo) || returnTo.startsWith('//'))
    return basePath
  try {
    const u = new URL(returnTo, 'http://app.invalid')
    return u.host === 'app.invalid' ? `${u.pathname}${u.search}` : basePath
  } catch {
    return basePath
  }
}

/** Security review I6: who signed in, as the audit log keeps it. */
const identityDetails = (i: OidcIdentity) => ({
  ...(i.name ? { signedInAs: i.name } : {}),
  ...(i.subject ? { subject: i.subject } : {}),
})

const flowError = (e: unknown): unknown =>
  e instanceof OidcFlowError ? Errors.conflict(e.message, { reason: e.reason }) : e

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const manage = requirePermission('connections:manage')

  /** A connection that signs people in with OIDC here (not a workload identity, not refused). */
  const personal = (request: FastifyRequest) => {
    const s = request.connection!.settings
    if (s.auth.mechanism !== 'MONGODB-OIDC')
      throw Errors.conflict('This connection does not sign in with OIDC', { reason: 'not_oidc' })
    if (s.auth.oidc?.environment)
      throw Errors.conflict('This connection signs in with a workload identity, not a person', {
        reason: 'oidc_workload',
      })
    const problem = connectionProblem(s, ctx.policy())
    if (problem) throw Errors.validation(problem.message, { reason: problem.reason })
  }

  app.get(
    '/connections/:id/oidc',
    { preHandler: requireConnection('connections:read'), config: { masking: 'names-only' } },
    async (request) => {
      const s = request.connection!.settings
      if (s.auth.mechanism !== 'MONGODB-OIDC') return { signIn: 'none' as const, signedIn: false }
      if (s.auth.oidc?.environment) return { signIn: 'workload' as const, signedIn: true }
      const user = personOf(request.principal!)
      const { completed, ...status } = await ctx.oidc.poll(request.connection!.id, user)
      // Security review I6: a device sign-in that completed now is recorded with who signed in.
      if (completed)
        ctx.audit.append({
          action: 'connections.oidc.signIn',
          outcome: 'success',
          userId: user !== 'local' ? user : null,
          username: user !== 'local' ? (ctx.users.findById(user)?.username ?? null) : null,
          ip: request.ip,
          connectionId: request.connection!.id,
          namespace: null,
          details: { flow: 'device', ...identityDetails(completed) },
        })
      return { signIn: 'person' as const, ...status }
    },
  )

  app.post(
    '/connections/:id/oidc/start',
    {
      preHandler: requireConnection('connections:read'),
      config: { masking: 'names-only', audit: 'connections.oidc.start' },
    },
    async (request, reply) => {
      const body = parseInput(StartBody, request.body)
      personal(request)
      const connectionId = request.connection!.id
      const user = personOf(request.principal!)
      request.auditInfo = { details: { flow: body.flow } }
      // Security review I5: the person is shown where their token goes before they are sent anywhere.
      const tokenHosts = request.connection!.settings.hosts.map((h) => h.host)
      try {
        if (body.flow === 'device') {
          // Security review I6: whoever approves the code signs in — off in team mode unless allowed.
          if (!(ctx.config.oidcDeviceFlow ?? !ctx.config.auth))
            throw new OidcFlowError(
              'oidc_device_off',
              'Sign-in with a code is turned off on this server (MM_OIDC_DEVICE_FLOW)',
            )
          const device = await ctx.oidc.startDevice({ connectionId, user })
          return { flow: 'device' as const, device, issuer: device.issuer, tokenHosts }
        }
        const { basePath } = ctx.config
        const own = `${ownOrigin(request)}${basePath}oidc/callback`
        const named = request.connection!.settings.auth.oidc?.redirectUri
        // Security review Minor 5: in team mode the code comes back to this server only.
        if (named && ctx.config.auth && new URL(named).origin !== ownOrigin(request))
          throw new OidcFlowError(
            'oidc_redirect_foreign',
            'In team mode the identity provider sends people back to this server only: clear the connection’s redirect address',
          )
        const { authorizeUrl, binding, flowId, issuer } = await ctx.oidc.startCode({
          connectionId,
          user,
          redirectUri: named ?? own,
          returnTo: safeReturn(basePath, body.returnTo),
        })
        const cookie = cookieFor(request, flowId)
        // Lax, so the identity provider's redirect (a top-level GET) brings it back; HttpOnly; ten
        // minutes; only the callback's path (or a __Host- cookie at the root).
        reply.setCookie(cookie.name, binding, {
          httpOnly: true,
          sameSite: 'lax',
          secure: cookie.secure,
          path: cookie.path,
          maxAge: BINDING_MAX_AGE_S,
        })
        return { flow: 'code' as const, authorizeUrl, issuer, tokenHosts }
      } catch (e) {
        throw flowError(e)
      }
    },
  )

  app.delete(
    '/connections/:id/oidc',
    {
      preHandler: requireConnection('connections:read'),
      config: { masking: 'names-only', audit: 'connections.oidc.signOut' },
    },
    async (request, reply) => {
      await ctx.oidc.signOut(request.connection!.id, personOf(request.principal!))
      return reply.status(204).send()
    },
  )

  app.get(
    '/connections/:id/oidc/sessions',
    {
      preHandler: [requireTeamMode, requireConnection('connections:read'), manage],
      config: { masking: 'names-only' },
    },
    async (request) =>
      ctx.oidc.people(request.connection!.id).map((p) => ({
        userId: p.user,
        username: ctx.users.findById(p.user)?.username ?? null,
        issuer: p.issuer,
        updatedAt: p.updatedAt,
        // Security review I6: as whom they signed in at the identity provider.
        signedInAs: p.identity?.name ?? null,
        subject: p.identity?.subject || null,
      })),
  )

  app.delete(
    '/connections/:id/oidc/sessions',
    {
      preHandler: [requireTeamMode, requireConnection('connections:read'), manage],
      config: { masking: 'names-only', audit: 'connections.oidc.revokeAll' },
    },
    async (request, reply) => {
      const id = request.connection!.id
      const people = ctx.oidc.people(id)
      for (const p of people) await ctx.oidc.signOut(id, p.user)
      request.auditInfo = { details: { revoked: people.length } }
      return reply.status(204).send()
    },
  )
}

export async function oidcCallbackRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  app.get('/oidc/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = CallbackQuery.safeParse(request.query)
    // The flow's own cookie, named by the flow the state names (security review Minor 1).
    const cookie = cookieFor(request, flowIdOf(query.success ? query.data.state : ''))
    const binding = request.cookies[cookie.name]
    reply.clearCookie(cookie.name, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookie.secure,
      path: cookie.path,
    })
    reply.header('cache-control', 'no-store')
    const { basePath } = ctx.config
    const audit = (
      outcome: 'success' | 'failure' | 'denied',
      user: string | null,
      details: Record<string, unknown>,
    ) =>
      ctx.audit.append({
        action: 'connections.oidc.callback',
        outcome,
        userId: user && user !== 'local' ? user : null,
        username: user && user !== 'local' ? (ctx.users.findById(user)?.username ?? null) : null,
        ip: request.ip,
        connectionId: typeof details.connectionId === 'string' ? details.connectionId : null,
        namespace: null,
        details,
      })
    try {
      if (!query.success) throw new OidcFlowError('oidc_state', 'This sign-in is not valid')
      const done = await ctx.oidc.finishCode({ ...query.data, binding })
      audit('success', done.user, {
        connectionId: done.connectionId,
        ...(done.identity ? identityDetails(done.identity) : {}),
      })
      const sep = done.returnTo.includes('?') ? '&' : '?'
      return reply.code(303).header('location', `${done.returnTo}${sep}oidc=signed-in`).send()
    } catch (e) {
      const reason = e instanceof OidcFlowError ? e.reason : 'oidc_error'
      audit(reason === 'oidc_state' ? 'denied' : 'failure', null, { reason })
      if (!(e instanceof OidcFlowError) && !(e instanceof AppError))
        request.log.warn({ reason }, 'OIDC: a sign-in failed')
      return reply.code(303).header('location', `${basePath}?oidc_error=${reason}`).send()
    }
  })
}
