import type { Readable } from 'node:stream'
import { AI_LIMITS, GEMINI_MODEL, type AiKind, type AiReason } from '@mongo-manager/shared'
import { EgressError, readBounded, scrubText, type Egress } from '../net/egress'
import { AI_NET } from './egress'

export interface WireTarget {
  kind: AiKind
  baseUrl: string
  model: string
  apiKey: string | null
  maxTokens: number
  /**
   * How long a thinking model may think. 'low' for the quick, structured actions (a query, a pipeline,
   * a validator): their answer is short and the user is waiting on it. Absent: the model's default.
   */
  effort?: 'low'
}
/** Phase 4a-2: one turn of a conversation, in the provider-neutral roles. */
export interface WireTurn {
  role: 'user' | 'assistant'
  content: string
}
export interface WireMessage {
  system: string
  /** Alternating, ending with the user's (every kind accepts that order). */
  messages: WireTurn[]
}
export interface WireUsage {
  input: number
  output: number
}

/** Spec §2.3: a provider's failure as a reason; its own words stay with the administrator's log. */
export class ProviderError extends Error {
  override name = 'ProviderError'
  constructor(
    readonly reason: AiReason,
    message: string,
    readonly detail?: { status?: number; excerpt?: string; remoteAddress?: string | null },
    readonly retryAfterMs?: number,
    /** Final review I4: refused or unreachable before the request was written. */
    readonly beforeSending = false,
    /** Tenth review (minor 2): the egress refused it for where it goes, not how it is written. */
    readonly outside = false,
  ) {
    super(message)
  }
}

/**
 * UI redesign R1 review: Gemini 3 and later think at length by default; Gemini 2.5 takes a budget
 * instead (Flash can turn thinking off, Pro thinks at least 128 tokens). Older models and Gemma take
 * no thinking settings at all, so none are sent.
 */
export function geminiThinking(model: string, effort: WireTarget['effort']): Record<string, unknown> | null {
  if (effort !== 'low') return null
  const version = /^gemini-(\d+)(?:\.(\d+))?/.exec(model)
  // Image and speech models take no thinking settings (final review Minor 10).
  if (!version || /-(image|tts)\b/.test(model)) return null
  const major = Number(version[1])
  const minor = Number(version[2] ?? 0)
  if (major >= 3) return { thinkingLevel: 'low' }
  if (major === 2 && minor === 5) return { thinkingBudget: /-pro\b/.test(model) ? 128 : 0 }
  return null
}
/**
 * Final review I4: the OpenAI models known to take a reasoning effort of "low" (o1, o3, o3-mini,
 * o4-mini, gpt-5, gpt-5-mini, gpt-5-nano, dated or not). Chat, pro and preview variants reject it or
 * only take "high"; GPT-5.1 and later default to no reasoning, so "low" would make them slower.
 */
export const OPENAI_REASONING = /^(o1|o3|o3-mini|o4-mini|gpt-5|gpt-5-mini|gpt-5-nano)(-\d{4}-\d{2}-\d{2})?$/

export function buildRequest(
  t: WireTarget,
  m: WireMessage,
): { url: string; headers: Record<string, string>; body: Buffer } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const json = (v: unknown) => Buffer.from(JSON.stringify(v))
  const messages = [{ role: 'system', content: m.system }, ...m.messages]
  switch (t.kind) {
    case 'anthropic':
      if (t.apiKey) headers['x-api-key'] = t.apiKey
      headers['anthropic-version'] = '2023-06-01'
      headers.accept = 'text/event-stream'
      return {
        url: `${t.baseUrl}/v1/messages`,
        headers,
        body: json({
          model: t.model,
          max_tokens: t.maxTokens,
          system: m.system,
          messages: m.messages,
          stream: true,
        }),
      }
    case 'openai':
      if (t.apiKey) headers.authorization = `Bearer ${t.apiKey}`
      headers.accept = 'text/event-stream'
      return {
        url: `${t.baseUrl}/chat/completions`,
        headers,
        body: json({
          model: t.model,
          max_tokens: t.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(t.effort === 'low' && OPENAI_REASONING.test(t.model) ? { reasoning_effort: 'low' } : {}),
          messages,
        }),
      }
    case 'ollama':
      // An Ollama behind a gateway may want a key; a plain one never gets one.
      if (t.apiKey) headers.authorization = `Bearer ${t.apiKey}`
      headers.accept = 'application/x-ndjson'
      return {
        url: `${t.baseUrl}/api/chat`,
        headers,
        body: json({ model: t.model, stream: true, options: { num_predict: t.maxTokens }, messages }),
      }
    case 'gemini': {
      // Spec §2.7, C11: the model is a path segment — checked again here, and encoded.
      if (!GEMINI_MODEL.test(t.model))
        throw new ProviderError('model_unknown', 'The model name is not valid', undefined, undefined, true)
      // The key travels in its header only, never in the URL.
      if (t.apiKey) headers['x-goog-api-key'] = t.apiKey
      headers.accept = 'text/event-stream'
      const thinking = geminiThinking(t.model, t.effort)
      return {
        url: `${t.baseUrl}/v1beta/models/${encodeURIComponent(t.model)}:streamGenerateContent?alt=sse`,
        headers,
        body: json({
          systemInstruction: { parts: [{ text: m.system }] },
          contents: m.messages.map((x) => ({
            role: x.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: x.content }],
          })),
          generationConfig: {
            maxOutputTokens: t.maxTokens,
            ...(thinking ? { thinkingConfig: thinking } : {}),
          },
        }),
      }
    }
  }
}

/**
 * The answer's lines, decoded as UTF-8 across chunks (a character split between two chunks is
 * joined). Bounded: the whole answer (512 KiB) and each line (64 KiB).
 */
export async function* lines(
  body: Readable,
  maxLine: number = AI_LIMITS.lineBytes,
  maxTotal: number = AI_LIMITS.answerBytes,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8')
  let rest = ''
  let total = 0
  const tooLong = () => new ProviderError('provider_error', 'A line of the answer is too long')
  for await (const chunk of body) {
    total += (chunk as Buffer).length
    if (total > maxTotal) throw new ProviderError('too_long', 'The answer is larger than allowed')
    rest += decoder.decode(chunk as Buffer, { stream: true })
    let at: number
    while ((at = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, at)
      rest = rest.slice(at + 1)
      if (line.length > maxLine) throw tooLong()
      yield line.endsWith('\r') ? line.slice(0, -1) : line
    }
    if (rest.length > maxLine) throw tooLong()
  }
  rest += decoder.decode()
  if (rest) yield rest.endsWith('\r') ? rest.slice(0, -1) : rest
}

/** Server-sent events: each event's data (data lines joined), comments and other fields skipped. */
export async function* sseData(body: Readable): AsyncGenerator<string> {
  let data: string[] = []
  for await (const line of lines(body)) {
    if (line === '') {
      if (data.length) yield data.join('\n')
      data = []
    } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (data.length) yield data.join('\n')
}

export type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export const parseEvent = (text: string): Json => {
  try {
    const v = JSON.parse(text) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json
  } catch {
    // below
  }
  throw new ProviderError('provider_error', 'The provider sent a malformed event')
}
export const count = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback

/** Spec §2.7: why Gemini may end an answer that is not ours to show. */
export const GEMINI_BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'])

/** Reads a streamed answer, handing its text over as it comes; the token counts at the end. */
export async function readAnswer(
  kind: AiKind,
  body: Readable,
  onText: (delta: string) => void,
): Promise<WireUsage> {
  const usage: WireUsage = { input: 0, output: 0 }
  if (kind === 'anthropic') {
    for await (const data of sseData(body)) {
      const ev = parseEvent(data)
      if (ev.type === 'message_start') {
        usage.input = count(ev.message?.usage?.input_tokens, 0)
        usage.output = count(ev.message?.usage?.output_tokens, 0)
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (typeof ev.delta.text === 'string') onText(ev.delta.text)
      } else if (ev.type === 'message_delta') usage.output = count(ev.usage?.output_tokens, usage.output)
      else if (ev.type === 'error') {
        const type = String(ev.error?.type ?? '')
        throw new ProviderError(
          type === 'overloaded_error'
            ? 'overloaded'
            : type === 'rate_limit_error'
              ? 'rate_limited'
              : 'provider_error',
          'The provider ended its answer with an error',
        )
      } else if (ev.type === 'message_stop') break
    }
    return usage
  }
  if (kind === 'gemini') {
    for await (const data of sseData(body)) {
      const ev = parseEvent(data)
      if (ev.error) {
        const code = Number(ev.error.code)
        throw new ProviderError(
          code === 429 ? 'rate_limited' : code === 503 ? 'overloaded' : 'provider_error',
          'The provider ended its answer with an error',
        )
      }
      if (ev.promptFeedback?.blockReason)
        throw new ProviderError('blocked', 'The provider declined the request')
      const candidate = ev.candidates?.[0]
      const parts: unknown = candidate?.content?.parts
      if (Array.isArray(parts))
        for (const p of parts as Json[])
          // Plan ruling 13: a thinking model's thoughts are not the answer.
          if (p && p.thought !== true && typeof p.text === 'string' && p.text) onText(p.text)
      if (ev.usageMetadata) {
        usage.input = count(ev.usageMetadata.promptTokenCount, usage.input)
        usage.output = count(ev.usageMetadata.candidatesTokenCount, usage.output)
      }
      if (typeof candidate?.finishReason === 'string' && GEMINI_BLOCKED.has(candidate.finishReason))
        throw new ProviderError('blocked', 'The provider stopped its answer')
    }
    return usage
  }
  if (kind === 'openai') {
    for await (const data of sseData(body)) {
      if (data.trim() === '[DONE]') break
      const ev = parseEvent(data)
      if (ev.error) throw new ProviderError('provider_error', 'The provider ended its answer with an error')
      const delta = ev.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) onText(delta)
      if (ev.usage) {
        usage.input = count(ev.usage.prompt_tokens, usage.input)
        usage.output = count(ev.usage.completion_tokens, usage.output)
      }
    }
    return usage
  }
  for await (const line of lines(body)) {
    if (!line.trim()) continue
    const ev = parseEvent(line)
    if (ev.error)
      throw new ProviderError(
        /not found/i.test(String(ev.error)) ? 'model_unknown' : 'provider_error',
        'The provider ended its answer with an error',
      )
    const delta = ev.message?.content
    if (typeof delta === 'string' && delta) onText(delta)
    if (ev.done === true) {
      usage.input = count(ev.prompt_eval_count, 0)
      usage.output = count(ev.eval_count, 0)
      break
    }
  }
  return usage
}

export function reasonOfStatus(status: number, text: string): AiReason {
  if (status === 401 || status === 403) return 'key_refused'
  if (status === 404) return 'model_unknown'
  if (status === 429) return 'rate_limited'
  if (status === 503 || status === 529) return 'overloaded'
  if (status === 413) return 'too_long'
  if (status === 400) {
    // Plan ruling 11: Gemini's invalid key (harmless for the other kinds).
    if (/API_KEY_INVALID/.test(text)) return 'key_refused'
    if (/model/i.test(text) && /(not found|does not exist|unknown|invalid)/i.test(text))
      return 'model_unknown'
    if (/(too long|context length|maximum context|too many tokens)/i.test(text)) return 'too_long'
  }
  return 'provider_error'
}

/** Retry-After as milliseconds (seconds or a date), at most an hour. */
export function retryAfter(h: string | string[] | undefined): number | undefined {
  const v = Array.isArray(h) ? h[0] : h
  if (!v) return undefined
  const s = Number(v)
  if (Number.isFinite(s) && s >= 0) return Math.min(s, 3600) * 1000
  const d = Date.parse(v)
  return Number.isFinite(d) ? Math.max(0, Math.min(d - Date.now(), 3_600_000)) : undefined
}

/** Gemini's RetryInfo ("retryDelay": "30s") as milliseconds, at most an hour. */
export function retryDelay(text: string): number | undefined {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text)
  return m ? Math.min(Number(m[1]), 3600) * 1000 : undefined
}

export function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e
  if (e instanceof EgressError)
    switch (e.reason) {
      case 'address_refused':
      case 'address_never':
      case 'http_refused':
        return new ProviderError('address_refused', e.message, undefined, undefined, true, true)
      case 'bad_url':
        return new ProviderError('address_refused', e.message, undefined, undefined, true)
      case 'dns':
      case 'connect':
      case 'tls':
        return new ProviderError('unreachable', e.message, undefined, undefined, true)
      case 'timeout':
        return new ProviderError('timeout', e.message)
      case 'aborted':
        return new ProviderError('aborted', e.message)
      case 'too_large':
        return new ProviderError('too_long', e.message)
      case 'redirect':
        return new ProviderError('provider_error', e.message)
      default:
        return new ProviderError('unreachable', e.message)
    }
  if ((e as Error | undefined)?.name === 'AbortError')
    return new ProviderError('aborted', 'The request was stopped')
  return new ProviderError('provider_error', 'The provider’s answer could not be read')
}

/** One request to a provider, its text handed over as it streams (spec §2.3). */
export async function callProvider(
  egress: Egress,
  target: WireTarget,
  message: WireMessage,
  opts: {
    signal: AbortSignal
    privateOnly: boolean
    onText(delta: string): void
    /** The whole exchange's deadline (a provider test is shorter). */
    deadlineMs?: number
  },
): Promise<{ usage: WireUsage; remoteAddress: string | null }> {
  const req = buildRequest(target, message)
  let res: Awaited<ReturnType<Egress['request']>>
  try {
    res = await egress.request({
      method: 'POST',
      url: req.url,
      headers: { ...req.headers, 'content-length': String(req.body.length) },
      body: req.body,
      signal: opts.signal,
      deadlineMs: opts.deadlineMs ?? AI_NET.totalMs,
      privateOnly: opts.privateOnly,
    })
  } catch (e) {
    throw toProviderError(e)
  }
  if (res.status < 200 || res.status >= 300) {
    const text = (
      await readBounded(res.body, 4096, { truncate: true, ms: 10_000 }).catch(() => Buffer.alloc(0))
    ).toString('utf8')
    throw new ProviderError(
      reasonOfStatus(res.status, text),
      `The provider answered ${res.status}`,
      {
        status: res.status,
        // Final review minor 14: a gateway may echo the key; it never reaches the log.
        excerpt: scrubText(target.apiKey ? text.split(target.apiKey).join('[redacted]') : text).slice(0, 200),
        remoteAddress: res.remoteAddress ?? null,
      },
      res.status === 429 ? (retryAfter(res.headers['retry-after']) ?? retryDelay(text)) : undefined,
    )
  }
  try {
    const usage = await readAnswer(target.kind, res.body, opts.onText)
    return { usage, remoteAddress: res.remoteAddress ?? null }
  } catch (e) {
    throw toProviderError(e)
  } finally {
    res.body.destroy()
  }
}
