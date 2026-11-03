import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AI_CHAT_LIMITS,
  AI_DEFAULT_BASE_URL,
  AiModelsRequestSchema,
  AiProviderInputSchema,
  AiProviderPatchSchema,
  AiRequestSchema,
  type AiModelsResult,
  type AiProviderView,
  type AiStatus,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth, requirePermission } from '../http/guards'
import { requireConnection } from '../connections/access'
import { normaliseBaseUrl, type AiProviderRecord } from '../ai/providers'
import { runAction } from '../ai/run'
import { mayUseAi } from '../ai/access'
import { callProvider, toProviderError } from '../ai/wire'
import { listModels } from '../ai/models'
import { CollParams } from './data/params'

const IdParams = z.strictObject({ id: z.uuid() })

/** Phase 4a-1 spec §3.4. */
export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const admin = requirePermission('settings:manage')
  // User review 2026-10-09: a provider is shown with its price (kept beside it).
  const view = ({ createdAt: _c, updatedAt: _u, ...rest }: AiProviderRecord): AiProviderView => ({
    ...rest,
    price: ctx.ai.prices.get(rest.id),
  })
  const providerOf = (params: unknown) => {
    const { id } = parseInput(IdParams, params)
    const p = ctx.ai.providers.get(id)
    if (!p) throw Errors.notFound('Provider not found')
    return p
  }

  app.get('/ai/status', { preHandler: requireAuth }, async (request): Promise<AiStatus> => {
    // Final review minor 12: rights are per connection (a viewer may hold an editor grant somewhere).
    const principal = request.principal!
    const may = ctx.config.ai.enabled && mayUseAi(ctx, principal)
    const providers = may ? ctx.ai.providers.list().filter((p) => p.enabled) : []
    return {
      enabled: providers.length > 0,
      allowServerJs: ctx.config.allowServerJs,
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        model: p.model,
        local: p.lastLocal,
        samples: p.samples,
        isDefault: p.isDefault,
      })),
      limits: {
        perMinute: ctx.config.ai.perMinute,
        perDay: ctx.config.ai.perDay,
        perUser: 2,
        concurrent: ctx.config.ai.maxConcurrent,
      },
      chat: {
        days: ctx.config.ai.chatDays,
        chats: AI_CHAT_LIMITS.chatsPerUser,
        messages: AI_CHAT_LIMITS.messagesPerChat,
      },
    }
  })

  app.get('/ai/providers', { preHandler: admin }, async () => ctx.ai.providers.list().map(view))

  app.post(
    '/ai/providers',
    { preHandler: admin, config: { audit: 'ai.provider.create' } },
    async (request, reply) => {
      const body = parseInput(AiProviderInputSchema, request.body)
      const p = ctx.ai.providers.create(
        body,
        request.principal!.kind === 'user' ? request.principal!.userId : null,
      )
      if (body.price) {
        ctx.ai.prices.set(p.id, body.price)
        ctx.ai.history.priceUnpriced(p, body.price)
      }
      request.auditInfo = {
        details: {
          provider: p.id,
          name: p.name,
          kind: p.kind,
          baseUrl: p.baseUrl,
          model: p.model,
          samples: p.samples,
        },
      }
      return reply.status(201).send(view(p))
    },
  )

  app.patch(
    '/ai/providers/:id',
    { preHandler: admin, config: { audit: 'ai.provider.update' } },
    async (request) => {
      const before = providerOf(request.params)
      const body = parseInput(AiProviderPatchSchema, request.body)
      const p = ctx.ai.providers.update(before.id, body)
      if (body.price !== undefined) ctx.ai.prices.set(p.id, body.price)
      if (body.price) ctx.ai.history.priceUnpriced(p, body.price)
      request.auditInfo = {
        details: {
          provider: p.id,
          fields: Object.keys(body).filter((k) => k !== 'apiKey'),
          key: body.apiKey === undefined ? 'kept' : body.apiKey === null ? 'removed' : 'replaced',
          baseUrl: p.baseUrl,
        },
      }
      return view(p)
    },
  )

  app.delete(
    '/ai/providers/:id',
    { preHandler: admin, config: { audit: 'ai.provider.delete' } },
    async (request, reply) => {
      const p = providerOf(request.params)
      ctx.ai.providers.remove(p.id)
      request.auditInfo = { details: { provider: p.id, name: p.name } }
      return reply.status(204).send()
    },
  )

  // User review 2026-10-09: the models a provider offers, for the editor's model choice.
  app.post('/ai/models', { preHandler: admin }, async (request): Promise<AiModelsResult> => {
    const body = parseInput(AiModelsRequestSchema, request.body ?? {})
    const baseUrl = normaliseBaseUrl(body.baseUrl ?? AI_DEFAULT_BASE_URL[body.kind])
    // A saved key goes only where it was saved for: the same kind at the same address.
    let apiKey = body.apiKey ?? null
    if (apiKey === null && body.providerId) {
      const saved = ctx.ai.providers.get(body.providerId)
      if (saved && saved.kind === body.kind && saved.baseUrl === baseUrl)
        apiKey = ctx.ai.providers.key(saved.id)
    }
    const release = ctx.ai.tests.enter(request.principal!.userId)
    try {
      return {
        outcome: 'ok',
        models: await listModels(ctx.ai.egress, { kind: body.kind, baseUrl, apiKey }, ctx.ai.testMs),
      }
    } catch (e) {
      return { outcome: toProviderError(e).reason, models: [] }
    } finally {
      release()
    }
  })

  app.post(
    '/ai/providers/:id/test',
    { preHandler: admin, config: { audit: 'ai.provider.test' } },
    async (request) => {
      const p = providerOf(request.params)
      const release = ctx.ai.tests.enter(request.principal!.userId)
      try {
        const started = Date.now()
        let outcome = 'ok'
        let local: boolean | null = null
        try {
          const r = await callProvider(
            ctx.ai.egress,
            {
              kind: p.kind,
              baseUrl: p.baseUrl,
              model: p.model,
              apiKey: ctx.ai.providers.key(p.id),
              maxTokens: 16,
            },
            { system: 'Answer with OK.', messages: [{ role: 'user', content: 'Answer with OK.' }] },
            // Final review minor 1: a deadline, not an abort, so a slow provider reads as too slow.
            {
              signal: new AbortController().signal,
              privateOnly: false,
              onText: () => {},
              deadlineMs: ctx.ai.testMs,
            },
          )
          local = r.remoteAddress ? ctx.ai.egress.listed(r.remoteAddress) : null
        } catch (e) {
          outcome = toProviderError(e).reason
        }
        ctx.ai.providers.setTest(p.id, { outcome, local })
        request.auditInfo = { details: { provider: p.id, outcome, local } }
        return { outcome, local, ms: Date.now() - started }
      } finally {
        release()
      }
    },
  )

  app.post(
    '/connections/:id/databases/:db/collections/:coll/ai',
    { preHandler: requireConnection('ai:use'), config: { masking: 'guarded', audit: 'ai.request' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(AiRequestSchema, request.body ?? {})
      const stream = await runAction(request, reply, db, coll, body)
      // The stream writes its own audit row when it ends (with its tokens and outcome).
      request.auditInfo = { quiet: true }
      return reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(stream)
    },
  )
}
