// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  AI_CHAT_LIMITS,
  permissionsFor,
  type AiChatCollectionTurn,
  type AiChatLine,
  type AiChatTarget,
  type AiChatTurn,
  type AiChatTurnRecord,
  type AiSent,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { clientFor } from '../data/mongo-errors'
import { trackOperation } from '../data/operations'
import { aiRulesVersion, chatOwner, sourceVersion, turnAccess } from './access'
import { isAdminOnlyNs } from '../connections/access'
import { answerBlocks } from './blocks'
import { connectionNaming, namespaceCatalogue, type Catalogue, type Naming } from './catalogue'
import { namedOf } from './labels'
import { cutAnswer, titleOf, type StoredChat } from './chats'
import { contextFor } from './context'
import { buildHistory, type History } from './history'
import { chatMessages, chatSystemPrompt } from './prompts'
import { callProvider, toProviderError } from './wire'

/** User report 2026-10-25: the line an answer ends with when the agent makes the change asked. */
const AGENT_MARK = '[[agent]]'
/** The answer without that line, and whether it had it (review of the chat entry, I3: no regex). */
export function withoutAgentLine(text: string): { text: string; asked: boolean } {
  const end = text.trimEnd()
  // Re-review (M8): on a line of its own, as the panel takes it — never the end of a sentence.
  const at = end.lastIndexOf('\n')
  if (end.slice(at + 1).trim() !== AGENT_MARK) return { text, asked: false }
  return { text: at < 0 ? '' : end.slice(0, at).trimEnd(), asked: true }
}

type Turn = AiChatTurn | AiChatCollectionTurn
const aboutCollection = (b: Turn): b is AiChatCollectionTurn => 'parts' in b

/** The details of a refused turn's audit row (the hook writes it with the status). */
function refused(request: FastifyRequest, body: Turn, e: unknown): never {
  const reason =
    e instanceof AppError
      ? e.code === 'RATE_LIMITED'
        ? 'rate_limited'
        : (e.details as { reason?: unknown } | undefined)?.reason
      : undefined
  request.auditInfo = {
    details: { chat: body.chat ?? null, ...(typeof reason === 'string' ? { reason } : {}) },
  }
  throw e
}

/** What a turn says it named: the collections and connections of a general turn, a turn about one its connections. */
const told = (catalogue: Catalogue | null, naming: Naming | null) =>
  catalogue
    ? { catalogue: catalogue.entries.size, connectionNames: catalogue.names.length }
    : naming
      ? { connectionNames: naming.names.length }
      : {}

/**
 * Phase 4a-2 spec §1.2, §2.2–§2.6: one turn. Everything that can be refused is refused before the
 * stream starts, and a refused turn stores nothing; once the stream starts, the turn is stored when
 * it ends — done, failed, or stopped because the client went away (plan ruling 2).
 */
export async function runChatTurn(
  request: FastifyRequest,
  reply: FastifyReply,
  body: Turn,
  target: { db: string; coll: string } | null,
): Promise<Readable> {
  const { ctx } = request.server
  const principal = request.principal!
  const owner = chatOwner(principal)
  const connection = target ? request.connection! : null
  const abort = new AbortController()
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) abort.abort()
  })
  let release: (() => void) | null = null
  let held: string | null = null
  let chatId = body.chat ?? null
  let title = ''
  let sent: AiSent | null = null
  let history: History
  let provider: NonNullable<ReturnType<typeof ctx.ai.providers.get>>
  let apiKey: string | null = null
  let rulesVersion: number | null = null
  /** A general turn: the collections the person may open, by name (user request 2026-10-10). */
  let catalogue: Catalogue | null = null
  /** Fifth review (M5): the connections named with a turn about a collection. */
  let naming: Naming | null = null
  try {
    if (!ctx.config.ai.enabled)
      throw Errors.forbidden('The AI assistant is turned off on this server', { reason: 'ai_off' })
    if (connection?.aiPolicy === 'off')
      throw Errors.forbidden('The AI assistant is off for this connection', { reason: 'ai_off' })
    if (connection && !permissionsFor(request.connectionRole!).has('documents:read')) throw Errors.forbidden()
    let stored: StoredChat | undefined
    if (chatId) {
      stored = ctx.ai.chats.get(owner, chatId)
      if (!stored) throw Errors.notFound('Chat not found')
      // Spec §2.4: one turn at a time per chat — checked and taken in the same tick.
      if (ctx.ai.chatsRunning.has(chatId))
        throw Errors.conflict('This chat is answering already', { reason: 'chat_busy' })
      ctx.ai.chatsRunning.add(chatId)
      held = chatId
      title = stored.title ?? ''
      const last = stored.turns.at(-1)
      if (body.retry && (!last || last.record.state === 'done'))
        throw Errors.validation('There is nothing to try again', { reason: 'nothing_to_retry' })
      if ((stored.turns.length - (body.retry ? 1 : 0)) * 2 >= AI_CHAT_LIMITS.messagesPerChat)
        throw Errors.conflict('This chat is full; start a new one', { reason: 'chat_full' })
    } else if (body.retry)
      throw Errors.validation('There is nothing to try again', { reason: 'nothing_to_retry' })
    const chosen = body.provider ? ctx.ai.providers.get(body.provider) : ctx.ai.providers.byDefault()
    if (!chosen?.enabled) throw Errors.conflict('No AI provider is available', { reason: 'no_provider' })
    provider = chosen
    // 4a-1 final review I1: the key is read with the address it belongs to, never later.
    apiKey = ctx.ai.providers.key(provider.id)
    if (connection?.aiPolicy === 'local' && provider.lastLocal === false)
      throw Errors.forbidden('This connection allows local AI providers only', { reason: 'ai_local_only' })
    const samples = aboutCollection(body) ? body.samples : undefined
    if (samples && !provider.samples)
      throw Errors.conflict('This provider may not receive sample documents', { reason: 'samples_refused' })
    release = ctx.ai.limits.enter(principal.userId)
    if (connection && target && aboutCollection(body)) {
      rulesVersion = aiRulesVersion(ctx, principal, connection.id)
      // W8: what is read here goes to an AI provider: values as stored, never decrypted.
      const client = await clientFor(request, { asStored: true })
      const comment = trackOperation(request, reply, client)
      sent = await contextFor(
        {
          ctx,
          principal,
          connectionId: connection.id,
          client,
          db: target.db,
          coll: target.coll,
          current: body.parts.current ? body.current : undefined,
          samples,
          comment,
          signal: abort.signal,
        },
        { plan: false, indexes: body.parts.indexes, validator: body.parts.validator },
      )
    }
    if (!connection) catalogue = await namespaceCatalogue(ctx, principal, provider.lastLocal, abort.signal)
    else naming = connectionNaming(ctx, principal, provider.lastLocal)
    // Plan ruling 3: the failed turn goes only now that nothing more can be refused.
    if (stored && body.retry) {
      ctx.ai.chats.dropFailedLast(owner, stored.id)
      stored = ctx.ai.chats.get(owner, stored.id)
    }
    history = buildHistory(
      stored?.turns ?? [],
      turnAccess(ctx, principal),
      provider.lastLocal === false,
      provider.samples,
      (id) => ctx.connections.get(id)?.aiPolicy ?? null,
    )
    if (!chatId) {
      title = titleOf(body.message)
      chatId = ctx.ai.chats.create(owner, title).id
      ctx.ai.chatsRunning.add(chatId)
      held = chatId
    }
  } catch (e) {
    release?.()
    if (held) ctx.ai.chatsRunning.delete(held)
    refused(request, body, e)
  }

  const id = chatId!
  // Spec §2.2: a local-only connection — this turn's or one in the history — keeps the request inside.
  // A local-only connection's collection names count too.
  const privateOnly =
    connection?.aiPolicy === 'local' || history.privateOnly || !!(catalogue ?? naming)?.local
  const ref = { id: provider.id, name: provider.name, model: provider.model, kind: provider.kind }
  const out = new PassThrough()
  const write = (line: AiChatLine) => {
    if (!out.destroyed) out.write(`${JSON.stringify(line)}\n`)
  }
  // Final review I2: the stored turn's id, so the panel keeps what was sent beside it.
  const ids = { user: randomUUID(), answer: randomUUID() }
  write({ type: 'chat', id, title, turn: ids.user })
  write({
    type: 'context',
    sent,
    provider: ref,
    history: { sent: history.sent, leftOut: history.leftOut },
    ...told(catalogue, naming),
  })
  void (async () => {
    let text = ''
    let agentAsked = false
    let outcome = 'ok'
    let state: AiChatTurnRecord['state'] = 'done'
    let local: boolean | null = null
    let nothingSent = false
    /** The collections the answer's blocks named, kept with the turn. */
    let targets: Record<string, AiChatTarget> = {}
    const started = Date.now()
    const usage = { input: 0, output: 0 }
    try {
      const r = await callProvider(
        ctx.ai.egress,
        {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey,
          maxTokens: provider.maxTokens,
        },
        {
          system: chatSystemPrompt(body.language),
          messages: chatMessages(
            history.messages,
            body.message,
            sent,
            catalogue ? [...catalogue.entries.keys()] : [],
            (catalogue ?? naming)?.names ?? [],
          ),
        },
        {
          signal: abort.signal,
          privateOnly,
          onText: (delta) => {
            text += delta
            write({ type: 'text', delta })
          },
        },
      )
      Object.assign(usage, r.usage)
      local = r.remoteAddress ? ctx.ai.egress.listed(r.remoteAddress) : null
      if (local !== null) ctx.ai.providers.setLocal(provider.id, local)
      // User report 2026-10-25: an answer that says the agent makes the change ends with its line;
      // the line is the panel's, never the person's to read.
      ;({ text, asked: agentAsked } = withoutAgentLine(text))
      const blocks = answerBlocks(
        text,
        ctx.config.allowServerJs,
        catalogue?.entries ?? null,
        target ? `${target.db}.${target.coll}` : null,
      )
      const named = new Set(blocks.flatMap((b) => (b.target ? [JSON.stringify(b.target)] : [])))
      targets = Object.fromEntries(
        [...(catalogue?.entries ?? [])].filter(([, t]) => named.has(JSON.stringify(t))),
      )
      write({ type: 'done', blocks, usage, local, ...(agentAsked ? { agentAsked: true as const } : {}) })
    } catch (e) {
      const err = toProviderError(e)
      const outside = privateOnly && err.outside && !abort.signal.aborted
      // Final review minor 6: refused for being outside the listed networks, the provider is known cloud
      // from now on — so the next turn leaves local-only history out instead of failing the same way.
      if (outside) ctx.ai.providers.setLocal(provider.id, false)
      const reason = abort.signal.aborted
        ? 'aborted'
        : outside
          ? connection?.aiPolicy === 'local'
            ? 'ai_local_only'
            : history.privateOnly
              ? 'history_local'
              : 'names_local'
          : err.reason
      state = abort.signal.aborted ? 'stopped' : 'error'
      outcome = reason
      nothingSent = err.beforeSending && !abort.signal.aborted
      if (err.detail?.remoteAddress) local = ctx.ai.egress.listed(err.detail.remoteAddress)
      if (err.detail)
        request.log.warn(
          { provider: provider.id, status: err.detail.status, excerpt: err.detail.excerpt },
          'AI provider refused a request',
        )
      write({
        type: 'error',
        reason,
        ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
        ...(nothingSent ? { nothingSent: true as const } : {}),
      })
    } finally {
      release?.()
      // Review of the chat entry (M9): a turn stopped after the line keeps none of it either.
      if (!agentAsked) ({ text, asked: agentAsked } = withoutAgentLine(text))
      const answer = cutAnswer(text)
      // Plan ruling 18: this turn's connection and every connection its history carried.
      const sources = new Map<string, number>()
      if (connection && rulesVersion !== null) sources.set(connection.id, rulesVersion)
      for (const s of history.sources) sources.set(s.connectionId, s.rulesVersion)
      // Review I1: the connections whose collection names went count too — a later turn weighs them.
      for (const id of catalogue?.connections ?? [])
        // At the version earlier turns are weighed with (turnAccess): hiding one's own counted.
        if (!sources.has(id)) sources.set(id, sourceVersion(ctx, principal, id))
      const namespace = target ? `${target.db}.${target.coll}` : null
      const credential = isAdminOnlyNs(namespace) || history.credential
      const record: AiChatTurnRecord = {
        connectionId: connection?.id ?? null,
        namespace,
        rulesVersion,
        sources: [...sources].map(([connectionId, rulesVersion]) => ({ connectionId, rulesVersion })),
        // Fifth review (M4): the person's words name a connection as much as the answer does.
        ...namedOf(
          `${body.message}\n${answer.text}`,
          (catalogue ?? naming)?.labelled ?? [],
          history.named,
          sources,
        ),
        credential: credential,
        parts: {
          schema: !!sent,
          current: !!sent?.current,
          indexes: sent?.indexes != null,
          validator: sent?.validator != null,
          samples: sent?.samples.length ?? 0,
        },
        provider: ref,
        local,
        usage,
        state,
        ...(state !== 'done' ? { reason: outcome } : {}),
        ...(answer.cut ? { cut: true as const } : {}),
        ...(nothingSent ? { nothingSent: true as const } : {}),
        history: { sent: history.sent, leftOut: history.leftOut },
        ...(agentAsked ? { agentAsked: true as const } : {}),
        ...(Object.keys(targets).length ? { targets } : {}),
        ...told(catalogue, naming),
      }
      try {
        ctx.ai.chats.append(owner, id, { user: body.message, answer: answer.text, record, ids })
      } catch (err) {
        // Deleted while it answered: nothing to keep.
        request.log.warn({ err }, 'AI chat: the turn could not be stored')
      }
      ctx.ai.chatsRunning.delete(id)
      const key = `chat|${outcome}`
      ctx.ai.metrics.requests.set(key, (ctx.ai.metrics.requests.get(key) ?? 0) + 1)
      ctx.ai.metrics.tokens.input += usage.input
      ctx.ai.metrics.tokens.output += usage.output
      // Spec §2.6: never the words, the context or the answer.
      ctx.audit.append({
        action: 'ai.chat',
        outcome: outcome === 'ok' ? 'success' : 'failure',
        userId: principal.userId,
        username: principal.username,
        ip: request.ip,
        connectionId: connection?.id ?? null,
        namespace: record.namespace,
        details: {
          chat: id,
          provider: provider.id,
          kind: provider.kind,
          local,
          parts: record.parts,
          samples: record.parts.samples,
          maskedPaths: (aboutCollection(body) && body.samples?.mask.length) || 0,
          history: history.sent,
          leftOut: history.leftOut,
          input: usage.input,
          output: usage.output,
          outcome,
        },
      })
      // User review 2026-10-09: the turn kept in the AI history too, linked to its chat.
      try {
        ctx.ai.history.record({
          owner,
          action: 'chat',
          chatId: id,
          // User reports 2026-10-25: a chat is one entry of the history, every turn of it in order.
          thread: id,
          connectionId: connection?.id ?? null,
          namespace: record.namespace,
          // Share review C1: every connection the answer drew on — its own whenever it has one (share
          // re-check 1), and its history's — and whether a credential collection.
          sources: [...new Set([...(connection ? [connection.id] : []), ...sources.keys()])],
          credential,
          provider: ref,
          outcome,
          usage,
          ms: Date.now() - started,
          price: ctx.ai.prices.get(provider.id),
          // Chats kept in the server's memory only (MM_AI_CHAT_DAYS=0) leave no words on disk here either.
          content:
            ctx.config.ai.chatDays === 0
              ? null
              : { prompt: body.message, answer: answer.text, ...(sent ? { sent } : {}) },
        })
      } catch (err) {
        request.log.warn({ err }, 'AI history: the turn could not be kept')
      }
      out.end()
    }
  })()
  return out
}
