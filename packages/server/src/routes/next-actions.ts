// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import {
  NextActionsRankSchema,
  permissionsFor,
  type NextActionFacts,
  type NextActionsRanked,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth } from '../http/guards'
import { effectiveRole } from '../connections/access'
import { chatOwner, mayUseAi } from '../ai/access'
import { callProvider, toProviderError } from '../ai/wire'
import { nextActionsMessage, nextActionsSystem, readNextActions } from '../ai/nextActions'

/** Twelve steps of names and counts are well under this. */
const BODY_BYTES = 16 * 1024
/** A short answer someone is waiting on (the Overview shows its own order meanwhile). */
const ANSWER_TOKENS = 600

/**
 * completion W6.2: the Overview's next steps, put in order and titled by the AI — only when the
 * user asked for it, the assistant is on, a provider is set up and each step's connection allows it.
 * A step is sent only where the user may use the assistant on its connection and the connection's AI
 * policy is not "off"; a local-only connection's only to a provider known to answer from the local
 * network, over the local network. The steps are names, kinds and counts (checked by the schema);
 * the audit keeps how many, never the names; the AI history keeps the usage, never the words.
 */
export async function nextActionRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  app.post(
    '/me/next-actions/rank',
    { preHandler: requireAuth, bodyLimit: BODY_BYTES, config: { audit: 'ai.request' } },
    async (request, reply): Promise<NextActionsRanked> => {
      const principal = request.principal!
      request.auditInfo = { details: { action: 'nextActions' } }
      const body = parseInput(NextActionsRankSchema, request.body)
      if (!ctx.config.ai.enabled)
        throw Errors.forbidden('The AI assistant is turned off on this server', { reason: 'ai_off' })
      if (!mayUseAi(ctx, principal)) throw Errors.forbidden()
      const provider = ctx.ai.providers.byDefault()
      if (!provider?.enabled) throw Errors.conflict('No AI provider is available', { reason: 'no_provider' })

      // What each step's connection allows.
      let privateOnly = false
      const allowed: NextActionFacts[] = []
      const withheld: string[] = []
      for (const item of body.items) {
        if (!item.connectionId) {
          allowed.push(item)
          continue
        }
        const c = ctx.connections.get(item.connectionId)
        const role = c ? effectiveRole(ctx, principal, c.id) : null
        const may = role ? permissionsFor(role) : null
        const ok =
          !!c &&
          !!may?.has('ai:use') &&
          may.has('databases:read') &&
          c.aiPolicy !== 'off' &&
          (c.aiPolicy !== 'local' || provider.lastLocal === true)
        if (!ok) {
          withheld.push(item.id)
          continue
        }
        if (c.aiPolicy === 'local') privateOnly = true
        allowed.push(item)
      }
      const shown = { name: provider.name, model: provider.model }
      if (allowed.length === 0) {
        request.auditInfo = { details: { action: 'nextActions', items: 0, outcome: 'nothing_allowed' } }
        return { order: [], titles: {}, withheld, provider: shown, reason: 'nothing_allowed' }
      }

      const release = ctx.ai.limits.enter(principal.userId)
      const abort = new AbortController()
      // Review minor 1: the request's own 'close' fires once its body is read (Node 24); the reply's
      // tells that the browser went away before the answer.
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) abort.abort()
      })
      const started = Date.now()
      const usage = { input: 0, output: 0 }
      let text = ''
      let outcome = 'ok'
      let local: boolean | null = null
      try {
        try {
          const r = await callProvider(
            ctx.ai.egress,
            {
              kind: provider.kind,
              baseUrl: provider.baseUrl,
              model: provider.model,
              apiKey: ctx.ai.providers.key(provider.id),
              maxTokens: Math.min(provider.maxTokens, ANSWER_TOKENS),
              effort: 'low',
            },
            {
              system: nextActionsSystem(body.language),
              messages: [
                {
                  role: 'user',
                  content: nextActionsMessage(allowed, (id) => ctx.connections.get(id)?.name ?? null),
                },
              ],
            },
            { signal: abort.signal, privateOnly, onText: (delta) => (text += delta) },
          )
          Object.assign(usage, r.usage)
          local = r.remoteAddress ? ctx.ai.egress.listed(r.remoteAddress) : null
          if (local !== null) ctx.ai.providers.setLocal(provider.id, local)
        } catch (e) {
          const err = toProviderError(e)
          outcome = abort.signal.aborted
            ? 'aborted'
            : privateOnly && err.reason === 'address_refused'
              ? 'ai_local_only'
              : err.reason
          if (err.detail)
            request.log.warn(
              { provider: provider.id, status: err.detail.status, excerpt: err.detail.excerpt },
              'AI provider refused a request',
            )
          throw new AppError('UPSTREAM_ERROR', 'The AI provider did not answer', 502, {
            reason: outcome,
            ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
          })
        }
        const read = readNextActions(text, new Set(allowed.map((i) => i.id)))
        if (!read) outcome = 'unreadable'
        return {
          order: read?.order ?? [],
          titles: read?.titles ?? {},
          withheld,
          provider: shown,
          ...(read ? {} : { reason: 'unreadable' as const }),
        }
      } finally {
        release()
        const key = `nextActions|${outcome}`
        ctx.ai.metrics.requests.set(key, (ctx.ai.metrics.requests.get(key) ?? 0) + 1)
        ctx.ai.metrics.tokens.input += usage.input
        ctx.ai.metrics.tokens.output += usage.output
        request.auditInfo = {
          details: {
            action: 'nextActions',
            provider: provider.id,
            kind: provider.kind,
            local,
            items: allowed.length,
            withheld: withheld.length,
            input: usage.input,
            output: usage.output,
            outcome,
          },
        }
        try {
          ctx.ai.history.record({
            owner: chatOwner(principal),
            action: 'nextActions',
            connectionId: null,
            namespace: null,
            provider: { id: provider.id, name: provider.name, kind: provider.kind, model: provider.model },
            outcome,
            usage,
            ms: Date.now() - started,
            price: ctx.ai.prices.get(provider.id),
            // The steps' names are not kept: only the usage counts.
            content: null,
          })
        } catch (err) {
          request.log.warn({ err }, 'AI history: the request could not be kept')
        }
      }
    },
  )
}
