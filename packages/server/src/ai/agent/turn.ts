import { randomUUID } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  AI_AGENT_APP_PAGES,
  AI_AGENT_LIMITS,
  AI_CHAT_LIMITS,
  agentToolKind,
  isAgentTool,
  permissionsFor,
  type AiAgentConnectionInfo,
  type AiAgentNote,
  type AiAgentStep,
  type AiAgentTool,
  type AiAgentStepBackup,
  type AiAgentStepRecord,
  type AiAgentTurn,
  type AiChatBlock,
  type AiChatTarget,
  type AiChatLine,
  type AiChatTurnRecord,
  type AiReason,
  type Permission,
  type Role,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../../errors'
import { effectiveRole } from '../../connections/access'
import type { Principal, ServerContext } from '../../http/context'
import type { ConnectionRecord } from '../../connections/repo'
import { chatOwner, sourceVersion, turnAccess } from '../access'
import { answerBlocks, placeAgentBlocks, stepTargets } from '../blocks'
import { namespaceCatalogue, type Catalogue } from '../catalogue'
import { cutAnswer, titleOf, type StoredChat } from '../chats'
import { buildHistory, type History } from '../history'
import {
  agentSystemPrompt,
  agentToolResult,
  agentUserMessage,
  chatMessages,
  chatSystemPrompt,
} from '../prompts'
import { ProviderError, callProvider, toProviderError, type WireTarget } from '../wire'
import { agentAuthOf } from './calls'
import { argsPlace, runTool, type AgentConnection, type ToolEnv } from './execute'
import { agentPolicy, refuseUnderPolicy } from './policy'
import type { ChangeEnd } from './runs'
import { toolSpecs } from './tools'
import { connectionLabels, namedOf } from '../labels'
import { ToolsUnsupportedError, callAgentProvider, type AgentMessage, type ToolResult } from './wire'

/** A model found unable to call tools is asked again with tools after this long (it may be updated). */
const UNSUPPORTED_MS = 60 * 60_000
/** How long a closing round may wait for the agent's minute after a change (W6.3 re-review). */
const ROUND_WAIT_MS = 65_000

/** W6.3: agent mode, per person (their own preference; off unless they turn it on). */
export const AGENT_PREFERENCE = 'ai.agent'
export const agentOwnerKey = (p: Principal) => chatOwner(p) ?? 'local'
export function agentModeOn(ctx: ServerContext, p: Principal): boolean {
  const v = ctx.preferences.get(agentOwnerKey(p), AGENT_PREFERENCE) as { on?: unknown } | null
  return v?.on === true
}

/**
 * Spec §1 (W6.3): the connections the agent is told of — by name only, never an address — each with
 * the person's access. A connection whose assistant is off is left out entirely; a local-only one
 * only when the provider is known to answer from the allowed networks (as the general chat's list).
 */
export function agentConnections(
  ctx: ServerContext,
  principal: Principal,
  providerLocal: boolean | null,
): AgentConnection[] {
  const usable = ctx.connections.list().flatMap((c) => {
    const e = eligible(ctx, principal, c, providerLocal)
    return e ? [{ record: c, ...e }] : []
  })
  // W6.3 security review (minor 4): connections of one name told apart, never by an address — as
  // the general chat names them (connectionLabels).
  const labels = connectionLabels(usable.map((u) => u.record))
  const out: AgentConnection[] = []
  for (const u of usable) {
    const c = u.record
    const label = labels.get(c.id)!
    out.push({
      id: c.id,
      label,
      record: c,
      role: u.role,
      permissions: u.permissions,
      full: u.full,
      info: infoOf(c, label, u.role, u.readOnly),
    })
  }
  return out
}

/**
 * The AI database manager (design 2026-10-25, A1): the collections an agent turn's steps used, by
 * the names its answer may give them ("<connection> / <db>.<coll>") — kept with the turn.
 */
function agentTargets(
  steps: readonly AiAgentStepRecord[],
  connections: readonly AgentConnection[],
): Map<string, AiChatTarget> {
  const names = new Map<string, AiChatTarget>()
  for (const target of stepTargets(steps)) {
    const c = connections.find((x) => x.id === target.connectionId)
    if (c) names.set(`${c.label} / ${target.db}.${target.coll}`, target)
  }
  return names
}

/** The fallback's targets its blocks name, kept out of the record when none (as a general turn's). */
function targetsOf(catalogue: Catalogue, blocks: AiChatBlock[]): { targets?: Record<string, AiChatTarget> } {
  const named = new Set(blocks.flatMap((b) => (b.target ? [JSON.stringify(b.target)] : [])))
  const targets = Object.fromEntries([...catalogue.entries].filter(([, t]) => named.has(JSON.stringify(t))))
  return Object.keys(targets).length ? { targets } : {}
}

/** What the agent is told of a connection (names only). */
function infoOf(c: ConnectionRecord, label: string, role: Role, readOnly: boolean): AiAgentConnectionInfo {
  return {
    name: label,
    access: role,
    readOnly,
    policy: c.aiPolicy,
    writes: c.aiAgentWrites && !readOnly,
    defaultDatabase: c.settings.defaultDatabase || null,
    // C5: the tools an administrator turned off here, so the agent does not reach for them.
    ...(c.aiAgentToolsOff.length ? { toolsOff: c.aiAgentToolsOff } : {}),
  }
}

/**
 * Whether the agent may use a connection for this person now: its assistant on (local-only only for
 * a provider found local), the person's role there with the assistant and reading.
 */
function eligible(
  ctx: ServerContext,
  principal: Principal,
  c: ConnectionRecord,
  providerLocal: boolean | null,
): {
  role: Role
  readOnly: boolean
  permissions: ReadonlySet<Permission>
  full: ReadonlySet<Permission>
} | null {
  if (c.aiPolicy === 'off') return null
  if (c.aiPolicy === 'local' && providerLocal !== true) return null
  const role = effectiveRole(ctx, principal, c.id)
  if (!role) return null
  const readOnly = ctx.config.readOnly || c.readOnly
  const permissions = permissionsFor(role, { readOnly })
  if (!permissions.has('ai:use') || !permissions.has('documents:read') || !permissions.has('databases:read'))
    return null
  return { role, readOnly, permissions, full: permissionsFor(role) }
}

/**
 * W6.3 security review (I4): a connection as it is now, under the label the model was given — or null
 * when the agent may no longer use it (removed, its assistant turned off, local-only with a provider
 * not found local, the person's rights gone).
 */
export function recheckConnection(
  ctx: ServerContext,
  principal: Principal,
  providerId: string,
  c: AgentConnection,
): AgentConnection | null {
  const record = ctx.connections.get(c.id)
  if (!record) return null
  const e = eligible(ctx, principal, record, ctx.ai.providers.get(providerId)?.lastLocal ?? null)
  if (!e) return null
  return {
    ...c,
    record,
    role: e.role,
    permissions: e.permissions,
    full: e.full,
    info: infoOf(record, c.label, e.role, e.readOnly),
  }
}

function refused(request: FastifyRequest, body: AiAgentTurn, e: unknown): never {
  const reason =
    e instanceof AppError
      ? e.code === 'RATE_LIMITED'
        ? 'rate_limited'
        : (e.details as { reason?: unknown } | undefined)?.reason
      : undefined
  request.auditInfo = {
    details: { chat: body.chat ?? null, agent: true, ...(typeof reason === 'string' ? { reason } : {}) },
  }
  throw e
}

/** A reason as a code: a route's word, never its words (review of the history's steps, M4). */
const REASON_CODE = /^[a-z0-9_-]{1,64}$/i

/** What a step keeps: where, how it ended and why, counts and names (never values). */
function stepRecord(step: AiAgentStep): AiAgentStepRecord {
  const p = step.place
  return {
    tool: step.tool,
    connectionId: p?.connectionId ?? null,
    namespace: p?.db ? (p.coll ? `${p.db}.${p.coll}` : p.db) : null,
    state: step.state,
    ...(step.sent ? { sent: step.sent } : {}),
    ...(step.documents ? { documents: step.documents } : {}),
    ...kept(step.summary),
    ...(step.reason && REASON_CODE.test(step.reason) ? { reason: step.reason } : {}),
    // C4 (wave C e2e): the plan and its changes kept, so a stored turn says how each went.
    ...(step.plan ? { plan: step.plan } : {}),
    ...(step.planItem !== undefined ? { planItem: step.planItem } : {}),
    ...(step.backup
      ? { backup: { state: step.backup.state, ...(step.backup.job ? { job: step.backup.job } : {}) } }
      : {}),
  }
}

/**
 * What a step's summary keeps with the stored turn: its counts and names. A route's own words
 * (`message`, shown to the person live) may quote a value, so they are never stored.
 */
function kept(summary: AiAgentStep['summary']): { summary?: Record<string, number | string | boolean> } {
  if (!summary) return {}
  const { message: _words, ...rest } = summary
  return Object.keys(rest).length ? { summary: rest } : {}
}

/** B7: an earlier turn's steps told at most, and a name's length (in characters, never halved). */
const STEPS_TOLD = 12
const NAME_CHARS = 64
const cut = (s: string) => {
  const chars = [...s]
  return chars.length > NAME_CHARS ? `${chars.slice(0, NAME_CHARS).join('')}…` : s
}

/**
 * Design 2026-10-25 (B7): what an earlier turn's steps did, for a follow-up ("drop it", "the same on
 * Prod") — the tool, where (the connection by the name the person may use, the namespace), its end,
 * its counts and names; never a value nor a route's words (the stored steps hold none). Review of B7
 * (I1): data for the new turn's envelope (JSON, "<" escaped), every name cut by characters.
 */
export function stepsTold(
  steps: readonly AiAgentStepRecord[] | undefined,
  labelOf: (connectionId: string) => string | null,
): Array<Record<string, unknown>> | null {
  if (!steps?.length) return null
  const told: Array<Record<string, unknown>> = steps.slice(0, STEPS_TOLD).map((s) => {
    const label = s.connectionId ? labelOf(s.connectionId) : null
    const counts = Object.fromEntries(
      Object.entries(s.summary ?? {})
        .slice(0, 8)
        .map(([k, v]) => [cut(k), typeof v === 'string' ? cut(v) : v]),
    )
    return {
      tool: s.tool,
      ...(s.connectionId ? (label ? { on: cut(label) } : { on: 'a connection not offered to you' }) : {}),
      ...(s.namespace ? { namespace: cut(s.namespace) } : {}),
      state: s.state,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(Object.keys(counts).length ? { counts } : {}),
    }
  })
  if (steps.length > STEPS_TOLD) told.push({ more: steps.length - STEPS_TOLD })
  return told
}

/** What a step's end tells the model. */
function endContent(end: ChangeEnd): Record<string, unknown> {
  switch (end.state) {
    case 'done':
      return { done: true, ...end.result }
    case 'declined':
      return {
        declined: true,
        note: 'The person declined this change; nothing was changed. Do not propose it again unless they ask.',
      }
    case 'expired':
      return { expired: true, note: 'The person did not answer in time; nothing was changed.' }
    case 'cancelled':
      return { cancelled: true, note: 'The turn was stopped; nothing was changed.' }
    case 'error':
      return { error: end.reason }
  }
}

/**
 * W6.3: one turn of the agent. Everything that can be refused is refused before the stream starts
 * (nothing is stored then). The model's tool calls run through the app's routes as the person; a
 * change waits for the person's answer on its card (`decide`); the turn is stored when it ends.
 */
export async function runAgentTurn(
  request: FastifyRequest,
  reply: FastifyReply,
  body: AiAgentTurn,
): Promise<Readable> {
  const { ctx } = request.server
  const app = request.server
  const principal = request.principal!
  const owner = chatOwner(principal)
  const abort = new AbortController()
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) abort.abort()
  })
  let release: (() => void) | null = null
  let held: string | null = null
  let chatId = body.chat ?? null
  let title = ''
  let history: History
  let provider: NonNullable<ReturnType<typeof ctx.ai.providers.get>>
  let apiKey: string | null = null
  let connections: AgentConnection[] = []
  try {
    if (!ctx.config.ai.enabled)
      throw Errors.forbidden('The AI assistant is turned off on this server', { reason: 'ai_off' })
    if (!agentModeOn(ctx, principal))
      throw Errors.forbidden('Agent mode is off: turn it on in the assistant first', { reason: 'agent_off' })
    // A2: an administrator may have turned the agent off for everyone.
    refuseUnderPolicy(ctx, false)
    let stored: StoredChat | undefined
    if (chatId) {
      stored = ctx.ai.chats.get(owner, chatId)
      if (!stored) throw Errors.notFound('Chat not found')
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
    apiKey = ctx.ai.providers.key(provider.id)
    // Documents' values go only with the person's consent and to a provider that may receive them.
    if (body.documents && !provider.samples)
      throw Errors.conflict('This provider may not receive documents', { reason: 'samples_refused' })
    release = ctx.ai.limits.enter(principal.userId)
    connections = agentConnections(ctx, principal, provider.lastLocal)
    if (stored && body.retry) {
      ctx.ai.chats.dropFailedLast(owner, stored.id)
      stored = ctx.ai.chats.get(owner, stored.id)
    }
    // W6.3 security review (minor 6): an answer written from documents goes only to a provider that
    // may receive them.
    history = buildHistory(
      stored?.turns ?? [],
      turnAccess(ctx, principal),
      provider.lastLocal === false,
      provider.samples,
      (id) => ctx.connections.get(id)?.aiPolicy ?? null,
      // B7: what the earlier turns' steps did, for a follow-up (names and counts only).
      (record) => stepsTold(record.agent?.steps, (id) => connections.find((c) => c.id === id)?.label ?? null),
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
  const runId = randomUUID()
  const runOwner = agentOwnerKey(principal)
  ctx.ai.agent.runs.open(runId, runOwner)
  // Stop (the client gone): a change still waiting is cancelled at once; its answer finds nothing.
  abort.signal.addEventListener('abort', () => ctx.ai.agent.runs.close(runId), { once: true })
  const ref = { id: provider.id, name: provider.name, model: provider.model, kind: provider.kind }
  // Spec §1, 4a-2 §2.2: a local-only connection named, or local-only history, keeps the request inside.
  // W6.3 security review (I4): read again for every request — a connection made local-only mid-turn
  // keeps the rest of the turn inside.
  const privateNow = () =>
    history.privateOnly || connections.some((c) => ctx.connections.get(c.id)?.aiPolicy === 'local')
  /** Whether the request last sent had to stay on the listed networks. */
  let sentPrivate = false
  const target: WireTarget = {
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey,
    maxTokens: provider.maxTokens,
  }
  const out = new PassThrough()
  const write = (line: AiChatLine) => {
    if (!out.destroyed) out.write(`${JSON.stringify(line)}\n`)
  }
  const ids = { user: randomUUID(), answer: randomUUID() }
  const infos = connections.map((c) => c.info)
  write({ type: 'chat', id, title, turn: ids.user, run: runId })
  write({
    type: 'context',
    sent: null,
    provider: ref,
    history: { sent: history.sent, leftOut: history.leftOut },
    agent: { connections: infos, documents: body.documents },
  })
  const focus = body.focus?.connectionId
    ? connections.find((c) => c.id === body.focus!.connectionId)
    : undefined
  const appPage = !!body.focus?.page && (AI_AGENT_APP_PAGES as readonly string[]).includes(body.focus.page)
  const env: ToolEnv = {
    app,
    ctx,
    principal,
    // B6: the routes' audit rows say which turn they were made for.
    auth: { ...agentAuthOf(request), via: { run: runId, chat: id } },
    connections,
    recheck: (c) => recheckConnection(ctx, principal, provider.id, c),
    documents: body.documents,
    language: body.language,
    ...(body.timeZone ? { timeZone: body.timeZone } : {}),
  }

  void (async () => {
    let text = ''
    let outcome = 'ok'
    let state: AiChatTurnRecord['state'] = 'done'
    let local: boolean | null = null
    let nothingSent = false
    let fallback = false
    /** The fallback's list of names: its blocks point where they name, and the turn says what went. */
    let fallbackCatalogue: Catalogue | null = null
    let targetNames = new Map<string, AiChatTarget>()
    let blocks: AiChatBlock[] = []
    const started = Date.now()
    const usage = { input: 0, output: 0 }
    const steps: AiAgentStepRecord[] = []
    /** How many documents' values went to the provider in this turn. */
    let documentsSent = 0
    /** A change was made in this turn: its closing round must not be lost to the minute's limit. */
    let changed = false
    /**
     * W6.3 re-review (minor 3): a further round, counted against the agent's own minute. Once a change
     * was made, a full minute (or a busy server) is waited out — the person is told what was done —
     * rather than ending the turn without a word; the day's limit is never waited for.
     */
    const takeRound = async (): Promise<() => void> => {
      const until = Date.now() + ROUND_WAIT_MS
      let pinged = Date.now()
      for (;;) {
        try {
          return ctx.ai.limits.enter(principal.userId, 'round')
        } catch (e) {
          const wait = (e as AppError).details as { retryAfterMs?: number; reason?: string } | undefined
          const waitable =
            e instanceof AppError &&
            (e.code === 'RATE_LIMITED'
              ? (wait?.retryAfterMs ?? Infinity) <= ROUND_WAIT_MS
              : wait?.reason === 'busy')
          if (!changed || !waitable || abort.signal.aborted || Date.now() > until) throw e
          if (Date.now() - pinged >= AI_AGENT_LIMITS.pingMs) {
            write({ type: 'ping' })
            pinged = Date.now()
          }
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    }
    const touched = new Set<string>()
    const notes = new Set<AiAgentNote>()
    let calls = 0
    /** C4: the turn's plan of changes — their tools in order, the next, and whether it stopped. */
    let plan: { tools: AiAgentTool[]; next: number; stopped: boolean } | null = null
    const note = (n: AiAgentNote) => {
      if (notes.has(n)) return
      notes.add(n)
      write({ type: 'note', note: n })
    }
    const audit = (step: AiAgentStep, ns: string | null) =>
      ctx.audit.append({
        action: 'ai.agent.tool',
        outcome: step.state === 'done' ? 'success' : step.state === 'refused' ? 'denied' : 'failure',
        userId: principal.userId,
        username: principal.username,
        ip: request.ip,
        connectionId: step.place?.connectionId ?? null,
        namespace: ns,
        // The tool and how it ended — never its arguments or what it read (spec §4).
        details: {
          chat: id,
          run: runId,
          tool: step.tool,
          kind: step.kind,
          state: step.state,
          ...(step.reason ? { reason: step.reason } : {}),
          ...(step.documents ? { documents: step.documents } : {}),
        },
      })
    const messages: AgentMessage[] = [
      ...history.messages.map((m): AgentMessage =>
        m.role === 'user'
          ? { role: 'user', content: m.content }
          : { role: 'assistant', text: m.content, calls: [] },
      ),
      {
        role: 'user',
        content: agentUserMessage(body.message, {
          connections: infos,
          // B7: the page the person is on goes with it — an app page alone, a connection's section only
          // with its connection (review of B7, M2).
          ...(focus || appPage
            ? {
                focus: {
                  ...(focus ? { connection: focus.label } : {}),
                  ...(focus && body.focus?.db ? { database: body.focus.db } : {}),
                  ...(focus && body.focus?.coll ? { collection: body.focus.coll } : {}),
                  ...(body.focus?.page ? { page: body.focus.page } : {}),
                },
              }
            : {}),
          documents: body.documents,
          ...(body.timeZone ? { timeZone: body.timeZone } : {}),
          // B7 (review I1): what the earlier turns' steps did, as data.
          ...(history.earlier.length ? { earlier: history.earlier } : {}),
        }),
      },
    ]
    /** The text of the round being answered (each round's own, for the model's next request). */
    let roundText = ''
    const onText = (delta: string) => {
      text += delta
      roundText += delta
      write({ type: 'text', delta })
    }
    try {
      // Review of A2 (minor 8): under read only, the model is offered no change (the call is refused
      // all the same: runTool reads the policy again).
      const readOnly = agentPolicy(ctx) === 'read'
      const tools = toolSpecs().filter(
        (s) =>
          !readOnly ||
          !isAgentTool(s.name) ||
          (agentToolKind(s.name) !== 'write' && s.name !== 'plan_changes'),
      )
      const unsupportedKey = `${provider.id}|${provider.model}`
      let round = 0
      let pendingCalls = false
      while (round < AI_AGENT_LIMITS.steps && !abort.signal.aborted) {
        round++
        if (round > 1 && text && !text.endsWith('\n')) onText('\n\n')
        roundText = ''
        // W6.3 security review (I5): every request to the provider takes a slot of the assistant's
        // limits (at once per person and on the server) and counts against the minute and the day; the
        // first one's was taken before the answer began. Refused, the turn ends saying why.
        if (!release) release = await takeRound()
        const privateOnly = privateNow()
        sentPrivate = false
        let answer
        try {
          if (ctx.now() - (ctx.ai.agent.unsupported.get(unsupportedKey) ?? -Infinity) < UNSUPPORTED_MS)
            throw new ToolsUnsupportedError('provider_error', 'known')
          answer = await callAgentProvider(
            ctx.ai.egress,
            target,
            agentSystemPrompt(body.language, readOnly),
            messages,
            tools,
            {
              signal: abort.signal,
              privateOnly: (sentPrivate = privateOnly),
              onText,
            },
          )
        } catch (e) {
          if (!(e instanceof ToolsUnsupportedError) || round > 1) throw e
          // Spec §2 (W6.3): a model that cannot call tools answers as the read-only assistant does.
          ctx.ai.agent.unsupported.set(unsupportedKey, ctx.now())
          fallback = true
          note('tools_unsupported')
          const catalogue = await namespaceCatalogue(ctx, principal, provider.lastLocal, abort.signal)
          fallbackCatalogue = catalogue
          for (const cid of catalogue.connections) touched.add(cid)
          // What goes now is said (second review, M-3): the names, as a general turn says them.
          write({
            type: 'context',
            sent: null,
            provider: ref,
            history: { sent: history.sent, leftOut: history.leftOut },
            agent: { connections: infos, documents: body.documents },
            catalogue: catalogue.entries.size,
            connectionNames: catalogue.names.length,
          })
          const r = await callProvider(
            ctx.ai.egress,
            target,
            {
              // Review of fa862922 (minor 5): agent mode is on — the model cannot call tools.
              system: chatSystemPrompt(body.language, true),
              // User report 2026-10-24: the connections by name, collections or not.
              messages: chatMessages(
                history.messages,
                body.message,
                null,
                [...catalogue.entries.keys()],
                catalogue.names,
              ),
            },
            { signal: abort.signal, privateOnly: (sentPrivate = privateOnly || catalogue.local), onText },
          )
          Object.assign(usage, r.usage)
          if (r.remoteAddress) local = ctx.ai.egress.listed(r.remoteAddress)
          pendingCalls = false
          break
        }
        // The slot is held for the provider's answer only: tools and cards run without it.
        release?.()
        release = null
        usage.input += answer.usage.input
        usage.output += answer.usage.output
        if (answer.remoteAddress) {
          local = ctx.ai.egress.listed(answer.remoteAddress)
          ctx.ai.providers.setLocal(provider.id, local)
        }
        messages.push({
          role: 'assistant',
          text: roundText.trim(),
          calls: answer.calls,
          ...(answer.raw ? { raw: answer.raw } : {}),
        })
        pendingCalls = answer.calls.length > 0
        if (!pendingCalls) break
        const results: ToolResult[] = []
        let changes = 0
        for (const call of answer.calls) {
          const stepId = `${round}.${results.length + 1}`
          const tool = isAgentTool(call.name) ? call.name : null
          const refuse = (reason: string): ToolResult => {
            if (tool) {
              // Review of the history's steps (M4): where it was asked, kept with why it was refused.
              const place = call.invalid ? null : argsPlace(env, call.args)
              const step: AiAgentStep = {
                id: stepId,
                tool,
                kind: agentToolKind(tool),
                place,
                state: 'refused',
                reason,
              }
              write({ type: 'step', step })
              steps.push(stepRecord(step))
              if (place) touched.add(place.connectionId)
              audit(step, steps.at(-1)!.namespace)
            } else
              // W6.3 security review (minor 8): a tool the model made up is in the audit too (its name only).
              ctx.audit.append({
                action: 'ai.agent.tool',
                outcome: 'denied',
                userId: principal.userId,
                username: principal.username,
                ip: request.ip,
                connectionId: null,
                namespace: null,
                details: { chat: id, run: runId, tool: call.name.slice(0, 128), state: 'refused', reason },
              })
            return {
              id: call.id,
              name: call.name,
              content: agentToolResult(call.name, { refused: reason }),
              isError: true,
            }
          }
          if (abort.signal.aborted) {
            results.push({
              id: call.id,
              name: call.name,
              content: agentToolResult(call.name, { cancelled: true }),
              isError: true,
            })
            continue
          }
          // Spec §4: tool calls per turn, and a minute, per person.
          if (calls >= AI_AGENT_LIMITS.callsPerTurn) {
            note('calls_limit')
            results.push(refuse('calls_limit'))
            continue
          }
          calls++
          if (!tool) {
            results.push(refuse('unknown_tool'))
            continue
          }
          if (!ctx.ai.agent.window.take(principal.userId)) {
            results.push(refuse('rate_limited'))
            continue
          }
          if (call.invalid) {
            results.push(refuse('invalid_arguments'))
            continue
          }
          const kind = agentToolKind(tool)
          if (kind === 'write' && changes >= 1) {
            results.push(refuse('one_change_at_a_time'))
            continue
          }
          // Design 2026-10-25 (C4): a plan holds the turn's changes to it, in its order; one declined
          // or refused stops the rest. A second plan waits for the first to end.
          const inPlan = kind === 'write' && plan !== null
          if (inPlan && plan!.stopped) {
            results.push(refuse('plan_stopped'))
            continue
          }
          if (inPlan && plan!.tools[plan!.next] !== tool) {
            results.push(refuse('not_in_plan'))
            continue
          }
          if (tool === 'plan_changes' && plan !== null) {
            results.push(refuse(plan.stopped ? 'plan_stopped' : 'plan_active'))
            continue
          }
          // Final review of wave C (nit 6): a plan comes before the changes of its round, not after one.
          if (tool === 'plan_changes' && changes >= 1) {
            results.push(refuse('plan_first'))
            continue
          }
          write({ type: 'step', step: { id: stepId, tool, kind, place: null, state: 'running' } })
          let ran
          try {
            // C6: what the step says while it runs (a whole-collection scan, before it does).
            ran = await runTool(
              {
                ...env,
                progress: (summary) =>
                  write({
                    type: 'step',
                    step: { id: stepId, tool, kind, place: null, state: 'running', summary },
                  }),
              },
              tool,
              call.args,
            )
          } catch (e) {
            request.log.warn({ err: e, tool }, 'AI agent: a tool failed')
            ran = {
              type: 'result' as const,
              step: { place: null, state: 'error' as const, reason: 'tool_failed' },
              content: { error: 'tool_failed' },
            }
          }
          let step: AiAgentStep = { id: stepId, tool, kind, ...ran.step }
          let content: Record<string, unknown> = 'content' in ran ? ran.content : {}
          const planItem = inPlan ? plan!.next : undefined
          if (planItem !== undefined) step = { ...step, planItem }
          // C4: the backup the card made, said with its end.
          let backup: AiAgentStepBackup | undefined
          if (ran.type === 'proposal') {
            changes++
            let end: ChangeEnd
            // Second re-review (minor 1): narrowed while the change was being prepared — no card is
            // left waiting for a confirmation that would be refused.
            const policyNow = agentPolicy(ctx)
            if (policyNow !== 'full') end = { state: 'error', reason: `agent_policy_${policyNow}` }
            else {
              step = { ...step, proposal: ran.proposal }
              write({ type: 'step', step })
              let waiting = true
              // Spec §3: nothing is written without the person's click; the turn waits for it.
              const ping = setInterval(() => write({ type: 'ping' }), AI_AGENT_LIMITS.pingMs)
              ping.unref?.()
              try {
                end = await ctx.ai.agent.runs.wait(runId, {
                  callId: stepId,
                  chat: id,
                  connectionId: ran.touched,
                  ...(ran.proposal.typed ? { typed: ran.proposal.typed } : {}),
                  ...(ran.proposal.password ? { password: true } : {}),
                  ...(ran.proposal.opening ? { opening: true } : {}),
                  ...(ran.proposal.passwordFor ? { passwordFor: ran.proposal.passwordFor } : {}),
                  ...(ran.proposal.plain ? { plain: true } : {}),
                  run: ran.run,
                  tool,
                  ...(ran.backup
                    ? {
                        backup: ran.backup,
                        notify: (b: AiAgentStepBackup) => {
                          if (!waiting) return
                          backup = b
                          step = { ...step, backup: b }
                          write({ type: 'step', step })
                        },
                      }
                    : {}),
                })
              } finally {
                waiting = false
                clearInterval(ping)
              }
              // Final review of wave C (minor 4): the backup's end not heard before the change's —
              // its job read once; one still running is kept as started (its job says how it ends).
              if (backup?.state === 'running' && backup.job) {
                const j = ctx.jobs.get(backup.job)
                if (j && j.state === 'done') backup = { state: 'done', job: backup.job }
                else if (j && j.state !== 'running')
                  backup = { state: 'error', job: backup.job, reason: 'backup_failed' }
              }
            }
            step = {
              id: stepId,
              tool,
              kind,
              place: step.place,
              state: end.state,
              sent: 'outcome',
              ...(end.state === 'done' ? { summary: end.summary } : {}),
              ...(end.state === 'error' ? { reason: end.reason } : {}),
              ...(planItem !== undefined ? { planItem } : {}),
              ...(backup ? { backup } : {}),
            }
            content = endContent(end)
            if (backup)
              content = {
                ...content,
                backup: { state: backup.state, ...(backup.job ? { job: backup.job } : {}) },
              }
            if (end.state === 'done') changed = true
            touched.add(ran.touched)
          } else if (ran.type === 'open') {
            write({ type: 'open', target: ran.target })
          } else if (ran.touched)
            for (const cid of typeof ran.touched === 'string' ? [ran.touched] : ran.touched) touched.add(cid)
          // C4: the plan goes on with the change after; one not done stops it, said to the model.
          if (tool === 'plan_changes' && step.state === 'done' && step.plan)
            plan = { tools: step.plan.changes.map((x) => x.tool), next: 0, stopped: false }
          else if (planItem !== undefined) {
            plan!.next++
            if (step.state !== 'done') {
              plan!.stopped = true
              content = { ...content, planStopped: true }
            } else if (plan!.next >= plan!.tools.length) plan = null
          }
          write({ type: 'step', step })
          steps.push(stepRecord(step))
          // Review of the history's steps (I1): whatever its end, the step's connection is the turn's
          // source — a request shared is read only by who may read every connection its steps name.
          if (step.place) touched.add(step.place.connectionId)
          documentsSent += step.documents ?? 0
          audit(step, steps.at(-1)!.namespace)
          results.push({
            id: call.id,
            name: call.name,
            content: agentToolResult(tool, content),
            ...(step.state === 'refused' || step.state === 'error' ? { isError: true } : {}),
          })
        }
        messages.push({ role: 'tool', results })
        if (abort.signal.aborted) break
      }
      if (pendingCalls && round >= AI_AGENT_LIMITS.steps) note('steps_limit')
      // Review of C4 (I1): a plan the turn ended before its last change — said, so it is asked again.
      if (plan && !plan.stopped && plan.next < plan.tools.length) note('plan_unfinished')
      if (abort.signal.aborted) {
        state = 'stopped'
        outcome = 'aborted'
      }
      targetNames = agentTargets(steps, connections)
      // A1: a block naming none goes where its answer named, else to the collection used last — the
      // fallback's included (it used none): never into whatever tab is open (review of A1, minor 3).
      blocks = placeAgentBlocks(
        answerBlocks(
          text,
          ctx.config.allowServerJs,
          fallbackCatalogue?.entries ?? targetNames,
          null,
          !fallbackCatalogue,
        ),
        fallbackCatalogue ? null : (stepTargets(steps).at(-1) ?? null),
      )
      if (!abort.signal.aborted) write({ type: 'done', blocks, usage, local })
    } catch (e) {
      // A round refused by the assistant's limits (I5): said as the limits say it, nothing sent.
      const err =
        e instanceof AppError
          ? new ProviderError(
              e.code === 'RATE_LIMITED'
                ? 'rate_limited'
                : ((e.details as { reason?: AiReason } | undefined)?.reason ?? 'busy'),
              e.message,
              undefined,
              (e.details as { retryAfterMs?: number } | undefined)?.retryAfterMs,
              true,
            )
          : toProviderError(e)
      // Eighth review (M2): as the request that failed was sent — the fallback's names too, a
      // local-only connection made while the turn runs named by it alone (ninth review, nit 4).
      const outside = sentPrivate && err.outside && !abort.signal.aborted
      if (outside) ctx.ai.providers.setLocal(provider.id, false)
      const reason = abort.signal.aborted
        ? 'aborted'
        : outside
          ? history.privateOnly
            ? 'history_local'
            : 'names_local'
          : err.reason
      state = abort.signal.aborted ? 'stopped' : 'error'
      outcome = reason
      nothingSent = err.beforeSending && !abort.signal.aborted && steps.length === 0
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
      ctx.ai.agent.runs.close(runId)
      const answer = cutAnswer(text)
      const sources = new Map<string, number>()
      for (const s of history.sources) sources.set(s.connectionId, s.rulesVersion)
      for (const cid of touched) if (!sources.has(cid)) sources.set(cid, sourceVersion(ctx, principal, cid))
      const record: AiChatTurnRecord = {
        connectionId: null,
        namespace: null,
        rulesVersion: null,
        sources: [...sources].map(([connectionId, rulesVersion]) => ({ connectionId, rulesVersion })),
        // The connections it was told of that its answer names, no source (a local-only one too:
        // its name stays inside — third review, M-2).
        // The person's words name one as much as the answer does (fifth review, M4).
        ...namedOf(
          `${body.message}\n${answer.text}`,
          [
            ...connections.map((c) => ({ id: c.id, label: c.label, name: c.record.name })),
            ...(fallbackCatalogue?.labelled ?? []),
          ],
          history.named,
          sources,
        ),
        credential: history.credential,
        // W6.3 security review (minor 6): what went, as precisely as a chat turn records it — documents
        // above all, so that a provider not allowed samples is never handed this answer again.
        parts: {
          schema: steps.some((x) => x.sent === 'schema'),
          current: false,
          indexes: steps.some((x) => x.sent === 'indexes'),
          validator: false,
          samples: documentsSent,
        },
        provider: ref,
        local,
        usage,
        state,
        ...(state !== 'done' ? { reason: outcome } : {}),
        ...(answer.cut ? { cut: true as const } : {}),
        ...(nothingSent ? { nothingSent: true as const } : {}),
        history: { sent: history.sent, leftOut: history.leftOut },
        agent: {
          steps: steps.slice(0, AI_AGENT_LIMITS.callsPerTurn),
          connections: connections.length,
          documents: body.documents,
          ...(fallback ? { fallback: true as const } : {}),
        },
        ...(fallbackCatalogue
          ? {
              catalogue: fallbackCatalogue.entries.size,
              connectionNames: fallbackCatalogue.names.length,
              ...targetsOf(fallbackCatalogue, blocks),
            }
          : // A1: where its blocks may name, so a chat read again places them as now.
            targetNames.size
            ? { targets: Object.fromEntries(targetNames) }
            : {}),
      }
      try {
        ctx.ai.chats.append(owner, id, { user: body.message, answer: answer.text, record, ids })
      } catch (err) {
        request.log.warn({ err }, 'AI agent: the turn could not be stored')
      }
      ctx.ai.chatsRunning.delete(id)
      const key = `agent|${outcome}`
      ctx.ai.metrics.requests.set(key, (ctx.ai.metrics.requests.get(key) ?? 0) + 1)
      ctx.ai.metrics.tokens.input += usage.input
      ctx.ai.metrics.tokens.output += usage.output
      // 4a-2 §2.6: never the words, the context or the answer.
      ctx.audit.append({
        action: 'ai.chat',
        outcome: outcome === 'ok' ? 'success' : 'failure',
        userId: principal.userId,
        username: principal.username,
        ip: request.ip,
        connectionId: null,
        namespace: null,
        details: {
          chat: id,
          agent: true,
          run: runId,
          provider: provider.id,
          kind: provider.kind,
          local,
          steps: steps.length,
          connections: connections.length,
          documents: body.documents,
          ...(fallback ? { fallback: true } : {}),
          history: history.sent,
          leftOut: history.leftOut,
          input: usage.input,
          output: usage.output,
          outcome,
        },
      })
      try {
        ctx.ai.history.record({
          owner,
          action: 'chat',
          chatId: id,
          // User reports 2026-10-25: the agent's turns join the chat's entry, as its plain ones do.
          thread: id,
          connectionId: null,
          namespace: null,
          sources: [...sources.keys()],
          credential: history.credential,
          provider: ref,
          outcome,
          usage,
          ms: Date.now() - started,
          price: ctx.ai.prices.get(provider.id),
          // User report 2026-10-25: the request keeps what each step did, as the chat does.
          content:
            ctx.config.ai.chatDays === 0
              ? null
              : {
                  prompt: body.message,
                  answer: answer.text,
                  ...(record.agent?.steps.length ? { steps: record.agent.steps } : {}),
                },
        })
      } catch (err) {
        request.log.warn({ err }, 'AI history: the agent turn could not be kept')
      }
      out.end()
    }
  })().catch((err: unknown) => {
    // Whatever failed while the turn was kept (the server stopping), the chat is freed and the answer ends.
    request.log.warn({ err }, 'AI agent: the turn could not be finished')
    ctx.ai.chatsRunning.delete(id)
    out.end()
  })
  return out
}
