// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { GEMINI_MODEL, type AiKind } from '@mongo-manager/shared'
import { readBounded, scrubText, type Egress } from '../../net/egress'
import { AI_NET } from '../egress'
import {
  GEMINI_BLOCKED,
  ProviderError,
  count,
  lines,
  parseEvent,
  reasonOfStatus,
  retryAfter,
  retryDelay,
  sseData,
  toProviderError,
  type Json,
  type WireTarget,
  type WireUsage,
} from '../wire'

/**
 * W6.3: tool calling, per provider. The conversation is kept in neutral roles; each kind's request
 * and streamed answer are translated here. Arguments are parsed as JSON and nothing else: a call
 * whose arguments do not parse is marked invalid and answered with an error, never guessed at.
 */

/** A JSON Schema object, as a tool's parameters. */
export type JsonSchema = Record<string, unknown>
export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}
export interface AgentCall {
  id: string
  name: string
  args: unknown
  /** The arguments were not JSON: the call is answered with an error. */
  invalid?: true
}
export interface ToolResult {
  id: string
  name: string
  content: string
  isError?: boolean
}
export type AgentMessage =
  | { role: 'user'; content: string }
  /** `raw`: Gemini's own parts (thought signatures included), echoed back as they came. */
  | { role: 'assistant'; text: string; calls: AgentCall[]; raw?: unknown }
  | { role: 'tool'; results: ToolResult[] }

/** A model that cannot call tools: the turn falls back to a plain answer. */
export class ToolsUnsupportedError extends ProviderError {
  override name = 'ToolsUnsupportedError'
}

const UNSUPPORTED =
  /(does not support tools|tools? (?:are|is) not supported|not support(?:ed)? (?:for )?tool|--jinja|--enable-auto-tool-choice|function calling is not (?:enabled|supported)|does not support function)/i

/** Whether a refusal says the model (or the server in front of it) cannot call tools. */
export function toolsUnsupported(status: number, text: string): boolean {
  return [400, 404, 422, 500, 501].includes(status) && UNSUPPORTED.test(text)
}

/** Gemini's function declarations take a subset of OpenAPI's schema; the rest is left out. */
const GEMINI_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
])
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_KEYS.has(k)) continue
    if (k === 'properties' && v && typeof v === 'object')
      out[k] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, geminiSchema(s)]),
      )
    else out[k] = k === 'items' ? geminiSchema(v) : v
  }
  return out
}

const argsText = (args: unknown) => JSON.stringify(args ?? {})

export function buildAgentRequest(
  t: WireTarget,
  system: string,
  messages: AgentMessage[],
  tools: ToolSpec[],
): { url: string; headers: Record<string, string>; body: Buffer } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const json = (v: unknown) => Buffer.from(JSON.stringify(v))
  switch (t.kind) {
    case 'anthropic': {
      if (t.apiKey) headers['x-api-key'] = t.apiKey
      headers['anthropic-version'] = '2023-06-01'
      headers.accept = 'text/event-stream'
      const out = messages.map((m) => {
        if (m.role === 'user') return { role: 'user', content: m.content }
        if (m.role === 'assistant')
          return {
            role: 'assistant',
            content: [
              ...(m.text ? [{ type: 'text', text: m.text }] : []),
              ...m.calls.map((c) => ({
                type: 'tool_use',
                id: c.id,
                name: c.name,
                input: c.invalid ? {} : (c.args ?? {}),
              })),
            ],
          }
        return {
          role: 'user',
          content: m.results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        }
      })
      return {
        url: `${t.baseUrl}/v1/messages`,
        headers,
        body: json({
          model: t.model,
          max_tokens: t.maxTokens,
          system,
          tools: tools.map((x) => ({ name: x.name, description: x.description, input_schema: x.parameters })),
          messages: out,
          stream: true,
        }),
      }
    }
    case 'openai': {
      if (t.apiKey) headers.authorization = `Bearer ${t.apiKey}`
      headers.accept = 'text/event-stream'
      const out: unknown[] = [{ role: 'system', content: system }]
      for (const m of messages) {
        if (m.role === 'user') out.push({ role: 'user', content: m.content })
        else if (m.role === 'assistant')
          out.push({
            role: 'assistant',
            content: m.text || null,
            ...(m.calls.length
              ? {
                  tool_calls: m.calls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: c.invalid ? '{}' : argsText(c.args) },
                  })),
                }
              : {}),
          })
        else for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content })
      }
      return {
        url: `${t.baseUrl}/chat/completions`,
        headers,
        body: json({
          model: t.model,
          max_tokens: t.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          tools: tools.map((x) => ({
            type: 'function',
            function: { name: x.name, description: x.description, parameters: x.parameters },
          })),
          messages: out,
        }),
      }
    }
    case 'ollama': {
      if (t.apiKey) headers.authorization = `Bearer ${t.apiKey}`
      headers.accept = 'application/x-ndjson'
      const out: unknown[] = [{ role: 'system', content: system }]
      for (const m of messages) {
        if (m.role === 'user') out.push({ role: 'user', content: m.content })
        else if (m.role === 'assistant')
          out.push({
            role: 'assistant',
            content: m.text,
            ...(m.calls.length
              ? {
                  tool_calls: m.calls.map((c) => ({
                    function: { name: c.name, arguments: c.invalid ? {} : (c.args ?? {}) },
                  })),
                }
              : {}),
          })
        else for (const r of m.results) out.push({ role: 'tool', content: r.content, tool_name: r.name })
      }
      return {
        url: `${t.baseUrl}/api/chat`,
        headers,
        body: json({
          model: t.model,
          stream: true,
          options: { num_predict: t.maxTokens },
          tools: tools.map((x) => ({
            type: 'function',
            function: { name: x.name, description: x.description, parameters: x.parameters },
          })),
          messages: out,
        }),
      }
    }
    case 'gemini': {
      // Phase 4a-2 C11: the model is one path segment — checked again here, and encoded.
      if (!GEMINI_MODEL.test(t.model))
        throw new ProviderError('model_unknown', 'The model name is not valid', undefined, undefined, true)
      if (t.apiKey) headers['x-goog-api-key'] = t.apiKey
      headers.accept = 'text/event-stream'
      // A call's id is echoed only when Gemini gave one (one it made up here never travels).
      const given = new Set<string>()
      const contents = messages.map((m) => {
        if (m.role === 'user') return { role: 'user', parts: [{ text: m.content }] }
        if (m.role === 'assistant') {
          const raw = Array.isArray(m.raw) ? (m.raw as Json[]) : null
          for (const p of raw ?? [])
            if (typeof p?.functionCall?.id === 'string') given.add(p.functionCall.id as string)
          return {
            role: 'model',
            parts: raw ?? [
              ...(m.text ? [{ text: m.text }] : []),
              ...m.calls.map((c) => ({
                functionCall: { name: c.name, args: c.invalid ? {} : (c.args ?? {}) },
              })),
            ],
          }
        }
        return {
          role: 'user',
          parts: m.results.map((r) => ({
            functionResponse: {
              ...(given.has(r.id) ? { id: r.id } : {}),
              name: r.name,
              response: { result: r.content },
            },
          })),
        }
      })
      return {
        url: `${t.baseUrl}/v1beta/models/${encodeURIComponent(t.model)}:streamGenerateContent?alt=sse`,
        headers,
        body: json({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          tools: [
            {
              functionDeclarations: tools.map((x) => ({
                name: x.name,
                description: x.description,
                parameters: geminiSchema(x.parameters),
              })),
            },
          ],
          generationConfig: { maxOutputTokens: t.maxTokens },
        }),
      }
    }
  }
}

/** A call's JSON arguments, or an invalid call. */
function parsedCall(id: string, name: string, text: string): AgentCall {
  if (!text.trim()) return { id, name, args: {} }
  try {
    return objectCall(id, name, JSON.parse(text) as unknown)
  } catch {
    return { id, name, args: null, invalid: true }
  }
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
/**
 * W6.3 security review (minor 7): arguments are an object or the call is invalid — an array, a
 * number or a string echoed back made the provider refuse the next request, and the turn died.
 */
function objectCall(id: string, name: string, args: unknown): AgentCall {
  if (args === undefined) return { id, name, args: {} }
  return isObject(args) ? { id, name, args } : { id, name, args: null, invalid: true }
}
const nameOf = (v: unknown) => (typeof v === 'string' ? v.slice(0, 128) : '')

export interface AgentAnswer {
  usage: WireUsage
  calls: AgentCall[]
  /** Gemini: the model's parts, to echo back. */
  raw?: unknown
}

/** At most this many calls are read from one answer; the rest are not looked at. */
const MAX_CALLS = 32

export async function readAgentAnswer(
  kind: AiKind,
  body: Readable,
  onText: (delta: string) => void,
): Promise<AgentAnswer> {
  const usage: WireUsage = { input: 0, output: 0 }
  const calls: AgentCall[] = []
  if (kind === 'anthropic') {
    const open = new Map<number, { id: string; name: string; json: string }>()
    for await (const data of sseData(body)) {
      const ev = parseEvent(data)
      if (ev.type === 'message_start') {
        usage.input = count(ev.message?.usage?.input_tokens, 0)
        usage.output = count(ev.message?.usage?.output_tokens, 0)
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        if (open.size + calls.length < MAX_CALLS)
          open.set(Number(ev.index), {
            id: nameOf(ev.content_block.id) || randomUUID(),
            name: nameOf(ev.content_block.name),
            json: '',
          })
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') onText(ev.delta.text)
        else if (ev.delta?.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
          const block = open.get(Number(ev.index))
          if (block) block.json += ev.delta.partial_json
        }
      } else if (ev.type === 'content_block_stop') {
        const block = open.get(Number(ev.index))
        if (block) {
          open.delete(Number(ev.index))
          calls.push(parsedCall(block.id, block.name, block.json))
        }
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
    return { usage, calls }
  }
  if (kind === 'gemini') {
    const raw: Json[] = []
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
        for (const p of parts as Json[]) {
          if (!p || typeof p !== 'object') continue
          // Plan ruling 13 of 4a-2: thoughts are not the answer, and are not echoed.
          if (p.thought === true) continue
          raw.push(p)
          if (typeof p.text === 'string' && p.text) onText(p.text)
          if (p.functionCall && calls.length < MAX_CALLS) {
            const call = objectCall(
              nameOf(p.functionCall.id) || randomUUID(),
              nameOf(p.functionCall.name),
              p.functionCall.args,
            )
            // The part is echoed back as it came: with arguments that are an object, or none.
            if (call.invalid) p.functionCall = { ...p.functionCall, args: {} }
            calls.push(call)
          }
        }
      if (ev.usageMetadata) {
        usage.input = count(ev.usageMetadata.promptTokenCount, usage.input)
        usage.output = count(ev.usageMetadata.candidatesTokenCount, usage.output)
      }
      if (typeof candidate?.finishReason === 'string' && GEMINI_BLOCKED.has(candidate.finishReason))
        throw new ProviderError('blocked', 'The provider stopped its answer')
    }
    return { usage, calls, raw }
  }
  if (kind === 'openai') {
    const open = new Map<number, { id: string; name: string; json: string }>()
    for await (const data of sseData(body)) {
      if (data.trim() === '[DONE]') break
      const ev = parseEvent(data)
      if (ev.error) throw new ProviderError('provider_error', 'The provider ended its answer with an error')
      const delta = ev.choices?.[0]?.delta
      if (typeof delta?.content === 'string' && delta.content) onText(delta.content)
      if (Array.isArray(delta?.tool_calls))
        for (const c of delta.tool_calls as Json[]) {
          const index = Number(c?.index ?? 0)
          let block = open.get(index)
          if (!block) {
            if (open.size >= MAX_CALLS) continue
            block = { id: nameOf(c?.id) || randomUUID(), name: '', json: '' }
            open.set(index, block)
          }
          if (typeof c?.function?.name === 'string') block.name += c.function.name
          if (typeof c?.function?.arguments === 'string') block.json += c.function.arguments
        }
      if (ev.usage) {
        usage.input = count(ev.usage.prompt_tokens, usage.input)
        usage.output = count(ev.usage.completion_tokens, usage.output)
      }
    }
    for (const [, b] of [...open].sort((a, z) => a[0] - z[0]))
      calls.push(parsedCall(b.id, nameOf(b.name), b.json))
    return { usage, calls }
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
    if (Array.isArray(ev.message?.tool_calls))
      for (const c of ev.message.tool_calls as Json[]) {
        if (calls.length >= MAX_CALLS) break
        const args = c?.function?.arguments
        if (typeof args === 'string') calls.push(parsedCall(randomUUID(), nameOf(c?.function?.name), args))
        else calls.push(objectCall(randomUUID(), nameOf(c?.function?.name), args))
      }
    if (ev.done === true) {
      usage.input = count(ev.prompt_eval_count, 0)
      usage.output = count(ev.eval_count, 0)
      break
    }
  }
  return { usage, calls }
}

/** One request with tools; the text handed over as it streams, the calls at the end. */
export async function callAgentProvider(
  egress: Egress,
  target: WireTarget,
  system: string,
  messages: AgentMessage[],
  tools: ToolSpec[],
  opts: { signal: AbortSignal; privateOnly: boolean; onText(delta: string): void },
): Promise<AgentAnswer & { remoteAddress: string | null }> {
  const req = buildAgentRequest(target, system, messages, tools)
  let res: Awaited<ReturnType<Egress['request']>>
  try {
    res = await egress.request({
      method: 'POST',
      url: req.url,
      headers: { ...req.headers, 'content-length': String(req.body.length) },
      body: req.body,
      signal: opts.signal,
      deadlineMs: AI_NET.totalMs,
      privateOnly: opts.privateOnly,
    })
  } catch (e) {
    throw toProviderError(e)
  }
  if (res.status < 200 || res.status >= 300) {
    const text = (
      await readBounded(res.body, 4096, { truncate: true, ms: 10_000 }).catch(() => Buffer.alloc(0))
    ).toString('utf8')
    const detail = {
      status: res.status,
      // Phase 4a-1 final review minor 14: a gateway may echo the key; it never reaches the log.
      excerpt: scrubText(target.apiKey ? text.split(target.apiKey).join('[redacted]') : text).slice(0, 200),
      remoteAddress: res.remoteAddress ?? null,
    }
    if (toolsUnsupported(res.status, text))
      throw new ToolsUnsupportedError('provider_error', 'The model cannot call tools', detail)
    throw new ProviderError(
      reasonOfStatus(res.status, text),
      `The provider answered ${res.status}`,
      detail,
      res.status === 429 ? (retryAfter(res.headers['retry-after']) ?? retryDelay(text)) : undefined,
    )
  }
  try {
    const answer = await readAgentAnswer(target.kind, res.body, opts.onText)
    return { ...answer, remoteAddress: res.remoteAddress ?? null }
  } catch (e) {
    throw toProviderError(e)
  } finally {
    res.body.destroy()
  }
}
