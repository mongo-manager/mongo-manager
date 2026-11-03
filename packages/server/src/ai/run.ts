import { PassThrough, type Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AI_PROMPTED, permissionsFor, type AiLine, type AiRequest, type AiSent } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import type { Egress } from '../net/egress'
import type { UploadGate } from '../transfer/upload-gate'
import { clientFor } from '../data/mongo-errors'
import { trackOperation } from '../data/operations'
import type { AiProviderRepo } from './providers'
import type { AiLimits } from './limits'
import type { ChatStore } from './chats'
import { buildContext } from './context'
import { systemPrompt, userMessage } from './prompts'
import { parseAnswer } from './answer'
import { callProvider, toProviderError } from './wire'
import type { AiHistoryRepo, AiPriceRepo } from './requests'
import { chatOwner } from './access'
import type { AgentServices } from './agent/services'

export interface AiMetrics {
  /** "action|outcome" → count. */
  requests: Map<string, number>
  tokens: { input: number; output: number }
}

export interface AiServices {
  providers: AiProviderRepo
  egress: Egress
  limits: AiLimits
  /** Plan ruling 12: provider tests, 10 a minute per administrator. */
  tests: UploadGate
  metrics: AiMetrics
  /** Final review minor 1: a provider test's deadline (tests lower it). */
  testMs: number
  /** Phase 4a-2: chats, and the chats answering now (one turn at a time per chat). */
  chats: ChatStore
  chatsRunning: Set<string>
  /** User review 2026-10-09: every request kept for its owner, and the providers' prices. */
  history: AiHistoryRepo
  prices: AiPriceRepo
  historySearches: UploadGate
  /** W6.3: the agentic assistant's calls, runs waiting for the person, and limits. */
  agent: AgentServices
}

/** The details of a refusal's audit row (the hook writes it with the status). */
function refused(request: FastifyRequest, body: AiRequest, e: unknown): never {
  const reason =
    e instanceof AppError
      ? e.code === 'RATE_LIMITED'
        ? 'rate_limited'
        : (e.details as { reason?: unknown } | undefined)?.reason
      : undefined
  request.auditInfo = { details: { action: body.action, ...(typeof reason === 'string' ? { reason } : {}) } }
  throw e
}

/**
 * Phase 4a-1 spec §1.2, §3.4: checks, the context, then the provider's answer relayed as NDJSON.
 * Everything that can be refused is refused before the stream starts (an ordinary JSON error).
 */
/** UI redesign R1 review: the actions whose answer is a short query, pipeline, validator or explanation. */
const QUICK_ACTIONS: ReadonlySet<string> = new Set(['query', 'pipeline', 'validation', 'explain'])

export async function runAction(
  request: FastifyRequest,
  reply: FastifyReply,
  db: string,
  coll: string,
  body: AiRequest,
): Promise<Readable> {
  const { ctx } = request.server
  const principal = request.principal!
  const connection = request.connection!
  let release: (() => void) | null = null
  let sent: AiSent
  const abort = new AbortController()
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) abort.abort()
  })
  let provider: NonNullable<ReturnType<typeof ctx.ai.providers.get>>
  let apiKey: string | null = null
  try {
    if (!ctx.config.ai.enabled)
      throw Errors.forbidden('The AI assistant is turned off on this server', { reason: 'ai_off' })
    if (connection.aiPolicy === 'off')
      throw Errors.forbidden('The AI assistant is off for this connection', { reason: 'ai_off' })
    if (!permissionsFor(request.connectionRole!).has('documents:read')) throw Errors.forbidden()
    if (AI_PROMPTED.has(body.action) && !body.prompt.trim())
      throw Errors.validation('Say what you need', { reason: 'prompt_required' })
    const chosen = body.provider ? ctx.ai.providers.get(body.provider) : ctx.ai.providers.byDefault()
    if (!chosen?.enabled) throw Errors.conflict('No AI provider is available', { reason: 'no_provider' })
    provider = chosen
    // Final review I1: the key is read with the address it belongs to, never later.
    apiKey = ctx.ai.providers.key(provider.id)
    // Final review I4: a provider found to answer from outside cannot serve a local-only connection.
    if (connection.aiPolicy === 'local' && provider.lastLocal === false)
      throw Errors.forbidden('This connection allows local AI providers only', { reason: 'ai_local_only' })
    if (body.samples && !provider.samples)
      throw Errors.conflict('This provider may not receive sample documents', { reason: 'samples_refused' })
    release = ctx.ai.limits.enter(principal.userId)
    // W8: what is read here goes to an AI provider: values as stored, never decrypted.
    const client = await clientFor(request, { asStored: true })
    const comment = trackOperation(request, reply, client)
    sent = await buildContext({
      ctx,
      principal,
      connectionId: connection.id,
      client,
      db,
      coll,
      request: body,
      comment,
      signal: abort.signal,
    })
  } catch (e) {
    release?.()
    refused(request, body, e)
  }

  const out = new PassThrough()
  const write = (line: AiLine) => {
    if (!out.destroyed) out.write(`${JSON.stringify(line)}\n`)
  }
  write({
    type: 'context',
    sent,
    provider: { id: provider.id, name: provider.name, model: provider.model, kind: provider.kind },
  })
  // UI redesign R1 review: a change needs something to change (the current query or pipeline).
  const change = body.refine === true && sent.current !== null
  void (async () => {
    let text = ''
    let outcome = 'ok'
    let local: boolean | null = null
    let result: unknown = null
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
          // A short, structured answer someone is waiting on: thinking models keep it brief.
          ...(QUICK_ACTIONS.has(body.action) ? { effort: 'low' as const } : {}),
        },
        {
          system: systemPrompt(body.action, body.language, change),
          messages: [{ role: 'user', content: userMessage(body.prompt, sent, change ? body.history : []) }],
        },
        {
          signal: abort.signal,
          // Plan ruling 1: a local-only connection's request may only connect inside the listed networks.
          privateOnly: connection.aiPolicy === 'local',
          onText: (delta) => {
            text += delta
            write({ type: 'text', delta })
          },
        },
      )
      Object.assign(usage, r.usage)
      local = r.remoteAddress ? ctx.ai.egress.listed(r.remoteAddress) : null
      if (local !== null) ctx.ai.providers.setLocal(provider.id, local)
      const parsed = parseAnswer(body.action, text, ctx.config.allowServerJs)
      result = parsed.result
      if (parsed.reason) outcome = parsed.reason
      // Final review I2: a change that carries hidden values ("***") back would write them as data;
      // the page asks before applying it.
      const warnings =
        change && parsed.result && JSON.stringify(parsed.result).includes('"***"')
          ? [...parsed.warnings, 'masked_values' as const]
          : parsed.warnings
      write({
        type: 'done',
        result: parsed.result,
        warnings,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        usage,
        local,
      })
    } catch (e) {
      const err = toProviderError(e)
      // Final review I4: refused at connect on a local-only connection: the policy, in its words.
      const reason =
        connection.aiPolicy === 'local' && err.reason === 'address_refused' ? 'ai_local_only' : err.reason
      outcome = abort.signal.aborted ? 'aborted' : reason
      // Final review minor 13: an HTTP error still says where the provider answered from.
      if (err.detail?.remoteAddress) local = ctx.ai.egress.listed(err.detail.remoteAddress)
      // The administrator's log keeps the status and a scrubbed excerpt; the browser gets the reason.
      if (err.detail)
        request.log.warn(
          { provider: provider.id, status: err.detail.status, excerpt: err.detail.excerpt },
          'AI provider refused a request',
        )
      write({
        type: 'error',
        reason: abort.signal.aborted ? 'aborted' : reason,
        ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
        ...(err.beforeSending && !abort.signal.aborted ? { nothingSent: true as const } : {}),
      })
    } finally {
      release?.()
      const key = `${body.action}|${outcome}`
      ctx.ai.metrics.requests.set(key, (ctx.ai.metrics.requests.get(key) ?? 0) + 1)
      ctx.ai.metrics.tokens.input += usage.input
      ctx.ai.metrics.tokens.output += usage.output
      // Spec §3.5: never the prompt, the context or the answer.
      ctx.audit.append({
        action: 'ai.request',
        // A "needs a pipeline" answer is a valid answer (final review Minor 9).
        outcome: outcome === 'ok' || outcome === 'needs_pipeline' ? 'success' : 'failure',
        userId: principal.userId,
        username: principal.username,
        ip: request.ip,
        connectionId: connection.id,
        namespace: `${db}.${coll}`,
        details: {
          action: body.action,
          provider: provider.id,
          kind: provider.kind,
          local,
          samples: sent.samples.length,
          maskedPaths: body.samples?.mask.length ?? 0,
          input: usage.input,
          output: usage.output,
          outcome,
        },
      })
      // User review 2026-10-09: kept for its owner — the words sealed, the tokens and cost in clear.
      try {
        ctx.ai.history.record({
          owner: chatOwner(principal),
          action: body.action,
          connectionId: connection.id,
          namespace: `${db}.${coll}`,
          provider: { id: provider.id, name: provider.name, kind: provider.kind, model: provider.model },
          outcome,
          usage,
          ms: Date.now() - started,
          price: ctx.ai.prices.get(provider.id),
          content: { prompt: body.prompt ?? '', answer: text, result, sent },
          thread: body.thread ?? null,
        })
      } catch (err) {
        request.log.warn({ err }, 'AI history: the request could not be kept')
      }
      out.end()
    }
  })()
  return out
}
