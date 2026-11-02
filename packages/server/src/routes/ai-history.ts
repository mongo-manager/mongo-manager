import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AiHistoryQuerySchema,
  AiHistorySettingsSchema,
  AiUsageQuerySchema,
  type AiHistoryItem,
  type AiHistoryPage,
  type AiHistoryThread,
  type AiHistorySettings,
  type AiHistorySharing,
  type AiUsage,
  permissionsFor,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth, requirePermission } from '../http/guards'
import { chatOwner, mayUseAi } from '../ai/access'
import { effectiveRole, isRestricted } from '../connections/access'
import type { MayRead, SharedAccess } from '../ai/requests'
import type { Principal } from '../http/context'

const IdParams = z.strictObject({ id: z.uuid() })
const ThreadParams = z.strictObject({ thread: z.uuid() })

/**
 * User review 2026-10-09: the AI history — each user reads and removes their own requests (never
 * another's, an administrator's included); an administrator sees everyone's usage (tokens and cost,
 * never the words) and sets how long requests are kept and whether their words are.
 */
export async function aiHistoryRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const admin = requirePermission('settings:manage')

  /**
   * User review 2026-10-09 ("isterse AI geçmişini paylaşabilsin … ekip modu … birden fazla ekip
   * üyesi"): sharing is for team mode, with someone to share with.
   */
  const sharingAvailable = (p: Principal) => p.kind === 'user' && ctx.users.countActive() > 1
  /**
   * A teammate reads a shared entry only while they may read, unmasked, every connection its answer
   * drew on (a masked user would see through the words what the rules hide; share review C1) — as
   * that connection's admin when it touched a credential collection (share review I2); an entry that
   * drew on none (a general chat turn), while they may use the AI.
   */
  const reads = (p: Principal) => (connectionId: string) => {
    if (!ctx.connections.get(connectionId)) return false
    const role = effectiveRole(ctx, p, connectionId)
    return !!role && permissionsFor(role).has('documents:read') && !isRestricted(ctx, p, connectionId)
  }
  const administers = (p: Principal) => (connectionId: string) =>
    !!ctx.connections.get(connectionId) && effectiveRole(ctx, p, connectionId) === 'admin'
  const reader = (p: Principal): MayRead | undefined => {
    if (p.kind !== 'user') return undefined
    const ai = mayUseAi(ctx, p)
    const may = reads(p)
    const admin = administers(p)
    return ({ connections, credential }) =>
      connections.length === 0 ? ai : connections.every(may) && (!credential || connections.every(admin))
  }
  const sharedAccess = (p: Principal): SharedAccess | null => {
    if (p.kind !== 'user') return null
    const ids = ctx.connections.list().map((c) => c.id)
    return {
      readable: ids.filter(reads(p)),
      admin: ids.filter(administers(p)),
      noConnection: mayUseAi(ctx, p),
    }
  }

  app.get('/ai/history/sharing', { preHandler: requireAuth }, async (request): Promise<AiHistorySharing> => ({
    available: sharingAvailable(request.principal!),
  }))

  for (const [method, on] of [
    ['post', true],
    ['delete', false],
  ] as const)
    app[method](
      '/ai/history/:id/share',
      { preHandler: requireAuth, config: { audit: on ? 'ai.history.share' : 'ai.history.unshare' } },
      async (request): Promise<{ shared: boolean }> => {
        const { id } = parseInput(IdParams, request.params)
        const principal = request.principal!
        // Not a permission: there is no one to share with (local mode, or the only active user).
        // Taking a share back is always the owner's to do (share review I3).
        if (on && !sharingAvailable(principal))
          throw Errors.conflict('Sharing needs team mode and a teammate')
        const done = ctx.ai.history.share(chatOwner(principal), id, on)
        // Another user's request answers exactly like a missing one.
        if (!done) throw Errors.notFound('Request not found')
        if (done === 'unknown')
          throw Errors.conflict(
            'This chat turn was kept before sharing existed: what it drew on is not known',
          )
        request.auditInfo = { details: { id } }
        return done
      },
    )

  // The steps of the entry a request is in: the asker's own, or a teammate's shared one they may read.
  app.get('/ai/history/:id/chain', { preHandler: requireAuth }, async (request): Promise<AiHistoryThread> => {
    const { id } = parseInput(IdParams, request.params)
    const principal = request.principal!
    const steps = ctx.ai.history.chainOf(chatOwner(principal), id, reader(principal))
    if (!steps.length) throw Errors.notFound('Request not found')
    return { steps }
  })

  app.get('/ai/history', { preHandler: requireAuth }, async (request): Promise<AiHistoryPage> => {
    const q = parseInput(AiHistoryQuerySchema, request.query)
    const owner = chatOwner(request.principal!)
    // Shared with the asker: only teammates' entries they may read (none in local mode).
    let shared: SharedAccess | undefined
    if (q.shared) {
      const access = sharedAccess(request.principal!)
      if (!access) return { items: [], next: null }
      shared = access
    }
    if (!q.q) return ctx.ai.history.list(owner, q, shared)
    const release = ctx.ai.historySearches.enter(owner ?? 'local')
    try {
      return ctx.ai.history.list(owner, q, shared)
    } finally {
      release()
    }
  })

  // Everyone may read how long their own requests are kept; only an administrator changes it.
  app.get('/ai/history/settings', { preHandler: requireAuth }, async (): Promise<AiHistorySettings> =>
    ctx.ai.history.settings(),
  )

  app.put(
    '/ai/history/settings',
    { preHandler: admin, config: { audit: 'ai.history.settings' } },
    async (request): Promise<AiHistorySettings> => {
      const body = parseInput(AiHistorySettingsSchema, request.body)
      request.auditInfo = { details: { ...body } }
      const saved = ctx.ai.history.setSettings(body)
      // Fewer days take effect at once.
      ctx.ai.history.sweep()
      return saved
    },
  )

  // User review 2026-10-09: a chain's steps, the owner's only (another's answers as one missing).
  app.get(
    '/ai/history/threads/:thread',
    { preHandler: requireAuth },
    async (request): Promise<AiHistoryThread> => {
      const { thread } = parseInput(ThreadParams, request.params)
      const steps = ctx.ai.history.thread(chatOwner(request.principal!), thread)
      if (!steps.length) throw Errors.notFound('Chain not found')
      return { steps }
    },
  )

  app.delete(
    '/ai/history/threads/:thread',
    { preHandler: requireAuth, config: { audit: 'ai.history.delete' } },
    async (request, reply) => {
      const { thread } = parseInput(ThreadParams, request.params)
      const removed = ctx.ai.history.removeThread(chatOwner(request.principal!), thread)
      if (!removed) throw Errors.notFound('Chain not found')
      request.auditInfo = { details: { removed } }
      return reply.status(204).send()
    },
  )

  app.get('/ai/history/:id', { preHandler: requireAuth }, async (request): Promise<AiHistoryItem> => {
    const { id } = parseInput(IdParams, request.params)
    const principal = request.principal!
    const item = ctx.ai.history.get(chatOwner(principal), id, reader(principal))
    // Another user's request (not shared, or not theirs to read) answers exactly like a missing one.
    if (!item) throw Errors.notFound('Request not found')
    return item
  })

  app.delete(
    '/ai/history/:id',
    { preHandler: requireAuth, config: { audit: 'ai.history.delete' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      if (!ctx.ai.history.remove(chatOwner(request.principal!), id))
        throw Errors.notFound('Request not found')
      request.auditInfo = { details: { removed: 1 } }
      return reply.status(204).send()
    },
  )

  app.delete(
    '/ai/history',
    { preHandler: requireAuth, config: { audit: 'ai.history.delete' } },
    async (request, reply) => {
      const removed = ctx.ai.history.removeAll(chatOwner(request.principal!))
      request.auditInfo = { details: { removed } }
      return reply.status(204).send()
    },
  )

  app.get('/ai/usage', { preHandler: requireAuth }, async (request): Promise<AiUsage> => {
    const q = parseInput(AiUsageQuerySchema, request.query)
    const principal = request.principal!
    // Everyone's usage is an administrator's to see (the same right as the AI settings).
    if (q.all) await admin(request)
    return ctx.ai.history.usage(q.all ? 'all' : chatOwner(principal), q.days, q.tz)
  })
}
