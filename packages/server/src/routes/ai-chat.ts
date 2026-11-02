import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import {
  AI_CHAT_LIMITS,
  AiChatCollectionTurnSchema,
  AiChatRenameSchema,
  AiChatTurnSchema,
  type AiChatBlock,
  type AiChatTarget,
  type AiChatMessageView,
  type AiChatView,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth } from '../http/guards'
import { requireConnection } from '../connections/access'
import { chatOwner, mayUseAi, turnAccess } from '../ai/access'
import { answerBlocks, placeAgentBlocks, stepTargets } from '../ai/blocks'
import { runChatTurn } from '../ai/chat'
import type { StoredChat } from '../ai/chats'
import { CollParams } from './data/params'

const ChatParams = z.strictObject({ chat: z.uuid() })

type BlocksOf = (
  answerId: string,
  text: string,
  allowServerJs: boolean,
  targets?: Readonly<Record<string, AiChatTarget>>,
  about?: string | null,
  anyCase?: boolean,
) => AiChatBlock[]

/**
 * Final review minor 10: an answer's blocks parsed once — a chat is read after every turn, and holds up
 * to 100 answers. Keyed by the answer's id and the JavaScript setting; the oldest go beyond `limit`.
 */
export function createBlockCache(
  limit: number,
  parse: (
    text: string,
    allowServerJs: boolean,
    targets?: Readonly<Record<string, AiChatTarget>>,
    about?: string | null,
    anyCase?: boolean,
  ) => AiChatBlock[] = answerBlocks,
): BlocksOf {
  const cache = new Map<string, AiChatBlock[]>()
  return (answerId, text, allowServerJs, targets, about = null, anyCase = false) => {
    const key = `${answerId}|${allowServerJs}|${targets ? Object.keys(targets).sort().join('\u0000') : '-'}|${about ?? '-'}|${anyCase}`
    const hit = cache.get(key)
    if (hit) {
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
    const blocks = parse(text, allowServerJs, targets, about, anyCase)
    cache.set(key, blocks)
    if (cache.size > limit) cache.delete(cache.keys().next().value!)
    return blocks
  }
}

/**
 * Spec §2.5: a stored chat as the panel shows it; the blocks parsed again (spec §1.4). Review M6: a
 * general turn's collections are named only while their connection may still travel (`may`).
 */
export function chatView(
  chat: StoredChat,
  allowServerJs: boolean,
  blocksOf: BlocksOf,
  may: (connectionId: string) => boolean = () => true,
): AiChatView {
  const messages: AiChatMessageView[] = []
  for (const t of chat.turns) {
    const kept = t.record.targets
      ? Object.fromEntries(Object.entries(t.record.targets).filter(([, where]) => may(where.connectionId)))
      : undefined
    const record = t.record.targets ? { ...t.record, targets: kept } : t.record
    // A general turn that had a list: its blocks name collections, or nowhere.
    const agent = !!t.record.agent
    // Review of A1 (nit): a list of none is still a list (a catalogue of 0 was taken for no list).
    const names = kept ?? (t.record.catalogue !== undefined || agent ? {} : undefined)
    // Design 2026-10-25 (A1): an agent turn's blocks naming none go to the collection it used last —
    // that one or none: where it may no longer go, nowhere, never an earlier one (review of A1, I2).
    const used =
      agent && t.record.catalogue === undefined ? (stepTargets(t.record.agent!.steps).at(-1) ?? null) : null
    const last = used && may(used.connectionId) ? used : null
    const parsed = t.answer.text
      ? blocksOf(
          t.answer.id,
          t.answer.text,
          allowServerJs,
          names,
          names ? null : t.record.namespace,
          agent && t.record.catalogue === undefined,
        )
      : []
    messages.push({
      id: t.user.id,
      role: 'user',
      text: t.user.text,
      createdAt: t.user.createdAt,
      turn: record,
    })
    messages.push({
      id: t.answer.id,
      role: 'assistant',
      text: t.answer.text,
      createdAt: t.answer.createdAt,
      blocks: agent ? placeAgentBlocks(parsed, last) : parsed,
    })
  }
  return {
    id: chat.id,
    title: chat.title,
    messages,
    full: chat.turns.length * 2 >= AI_CHAT_LIMITS.messagesPerChat,
  }
}

/** Phase 4a-2 spec §2.5. */
export async function aiChatRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const blocksOf = createBlockCache(2000)
  // Plan ruling 8: ai:use on the caller's role or on any connection's grant.
  const requireAi = async (request: FastifyRequest) => {
    if (!mayUseAi(ctx, request.principal!)) throw Errors.forbidden()
  }
  const owner = (request: FastifyRequest) => chatOwner(request.principal!)
  const access = (request: FastifyRequest) => turnAccess(ctx, request.principal!)
  // C1: another person's chat answers as one that does not exist.
  const chatOf = (request: FastifyRequest) => {
    const { chat } = parseInput(ChatParams, request.params)
    const found = ctx.ai.chats.get(owner(request), chat)
    if (!found) throw Errors.notFound('Chat not found')
    return found
  }
  const stream = (reply: FastifyReply, out: Readable) =>
    reply
      .header('content-type', 'application/x-ndjson; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(out)

  app.get('/ai/chats', { preHandler: [requireAuth, requireAi] }, async (request) =>
    ctx.ai.chats.list(owner(request)),
  )
  app.get('/ai/chats/:chat', { preHandler: [requireAuth, requireAi] }, async (request) =>
    chatView(chatOf(request), ctx.config.allowServerJs, blocksOf, (id) => !!access(request)(id)),
  )
  app.patch('/ai/chats/:chat', { preHandler: [requireAuth, requireAi] }, async (request) => {
    const chat = chatOf(request)
    const { title } = parseInput(AiChatRenameSchema, request.body)
    ctx.ai.chats.rename(owner(request), chat.id, title)
    return { id: chat.id, title }
  })
  // Deleting needs no AI right: a person who lost it can still remove their chats.
  app.delete(
    '/ai/chats/:chat',
    { preHandler: requireAuth, config: { audit: 'ai.chat.delete' } },
    async (request, reply) => {
      const { chat } = parseInput(ChatParams, request.params)
      if (!ctx.ai.chats.remove(owner(request), chat)) throw Errors.notFound('Chat not found')
      // AI history review I1: the chat's words go from the AI history too (its usage stays).
      ctx.ai.history.forgetChats(owner(request))
      request.auditInfo = { details: { chat, count: 1 } }
      return reply.status(204).send()
    },
  )
  app.delete(
    '/ai/chats',
    { preHandler: requireAuth, config: { audit: 'ai.chat.delete' } },
    async (request) => {
      const count = ctx.ai.chats.removeAll(owner(request))
      ctx.ai.history.forgetChats(owner(request))
      request.auditInfo = { details: { all: true, count } }
      return { removed: count }
    },
  )

  app.post(
    '/ai/chat',
    { preHandler: [requireAuth, requireAi], config: { audit: 'ai.chat' } },
    async (request, reply) => {
      const body = parseInput(AiChatTurnSchema, request.body ?? {})
      const out = await runChatTurn(request, reply, body, null)
      // The stream writes its own audit row when it ends (with its tokens and outcome).
      request.auditInfo = { quiet: true }
      return stream(reply, out)
    },
  )
  app.post(
    '/connections/:id/databases/:db/collections/:coll/ai/chat',
    { preHandler: requireConnection('ai:use'), config: { masking: 'guarded', audit: 'ai.chat' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(AiChatCollectionTurnSchema, request.body ?? {})
      const out = await runChatTurn(request, reply, body, { db, coll })
      request.auditInfo = { quiet: true }
      return stream(reply, out)
    },
  )
}
