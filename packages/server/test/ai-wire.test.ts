// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config'
import { createAiEgress } from '../src/ai/egress'
import { ProviderError, callProvider, reasonOfStatus, type WireTarget } from '../src/ai/wire'
import type { Egress } from '../src/net/egress'
import {
  anthropicReply,
  ollamaReply,
  openaiReply,
  rawReply,
  startFakeAi,
  statusReply,
  type FakeAi,
} from './support/fake-ai'

let egress: Egress
beforeAll(() => {
  egress = createAiEgress(resolveConfig({ cli: { auth: false, dataDir: '/tmp/x' } }))
})
const fakes: FakeAi[] = []
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close()
})
async function fake() {
  const f = await startFakeAi()
  fakes.push(f)
  return f
}
const target = (f: FakeAi, over: Partial<WireTarget> = {}): WireTarget => ({
  kind: 'openai',
  baseUrl: `${f.url}/v1`,
  model: 'm',
  apiKey: null,
  maxTokens: 256,
  ...over,
})
const message = { system: 'You help.', messages: [{ role: 'user' as const, content: 'Request: hello' }] }
async function call(f: FakeAi, over: Partial<WireTarget> = {}, signal = new AbortController().signal) {
  let text = ''
  const out = await callProvider(egress, target(f, over), message, {
    signal,
    privateOnly: false,
    onText: (d) => void (text += d),
  })
  return { text, ...out }
}
const failure = async (p: Promise<unknown>) => {
  try {
    await p
    return null
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError)
    return e as ProviderError
  }
}

describe('the wire formats (phase 4a-1 spec §2.3)', () => {
  it('speaks Anthropic’s Messages API: the key in x-api-key, the version, a system prompt, a stream', async () => {
    const f = await fake()
    f.reply(anthropicReply('Hello there, friend.', { input: 30, output: 9 }))
    const r = await call(f, {
      kind: 'anthropic',
      baseUrl: f.url,
      apiKey: 'sk-ant-1',
      model: 'claude-sonnet-5',
    })
    expect(r).toMatchObject({
      text: 'Hello there, friend.',
      usage: { input: 30, output: 9 },
      remoteAddress: '127.0.0.1',
    })
    const sent = f.requests[0]!
    expect(sent.path).toBe('/v1/messages')
    expect(sent.headers['x-api-key']).toBe('sk-ant-1')
    expect(sent.headers['anthropic-version']).toBe('2023-06-01')
    expect(sent.headers.authorization).toBeUndefined()
    expect(sent.body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 256,
      system: 'You help.',
      messages: [{ role: 'user', content: 'Request: hello' }],
      stream: true,
    })
  })

  it('speaks the OpenAI-compatible chat API, with a bearer key only when one is stored', async () => {
    const f = await fake()
    f.reply(openaiReply('Ready.', { input: 4, output: 2 }))
    expect(await call(f)).toMatchObject({ text: 'Ready.', usage: { input: 4, output: 2 } })
    expect(f.requests[0]!.headers.authorization).toBeUndefined()
    await call(f, { apiKey: 'sk-1' })
    expect(f.requests[1]!).toMatchObject({
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-1' },
      body: {
        model: 'm',
        max_tokens: 256,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: 'You help.' },
          { role: 'user', content: 'Request: hello' },
        ],
      },
    })
  })

  it('speaks Ollama’s chat API (NDJSON)', async () => {
    const f = await fake()
    f.reply(ollamaReply('Local answer.', { input: 8, output: 3 }))
    expect(await call(f, { kind: 'ollama', baseUrl: f.url, model: 'llama3.3' })).toMatchObject({
      text: 'Local answer.',
      usage: { input: 8, output: 3 },
    })
    expect(f.requests[0]!).toMatchObject({
      path: '/api/chat',
      body: { model: 'llama3.3', stream: true, options: { num_predict: 256 } },
    })
  })

  // 728 slices a millisecond apart: 11 s on Windows, whose timers tick every 15 ms, of the 20 s a
  // test has. The slices stay apart, so each arrives on its own (review of the open's stop,
  // important 1): the limit is the test's own.
  it('joins events and characters split across chunks', { timeout: 60_000 }, async () => {
    const f = await fake()
    const text = 'Çok güzel: ğüşıöç — 🚀✨ done.'
    for (const [kind, reply, base] of [
      ['anthropic', anthropicReply(text, undefined, 3), f.url],
      ['openai', openaiReply(text, undefined, 3), `${f.url}/v1`],
      ['ollama', ollamaReply(text, undefined, 3), f.url],
    ] as const) {
      f.reply(reply)
      expect((await call(f, { kind, baseUrl: base })).text, kind).toBe(text)
    }
  })

  it('says what went wrong in reasons, never with the provider’s words', async () => {
    const f = await fake()
    const cases: Array<[number, string, Record<string, string>, string]> = [
      [401, '{"error":"bad key sk-ant-REDACTED-THIS-0123456789abcdef0123456789abcdef"}', {}, 'key_refused'],
      [403, '{}', {}, 'key_refused'],
      [404, '{"error":{"message":"model not found"}}', {}, 'model_unknown'],
      [400, '{"error":{"message":"The model `x` does not exist"}}', {}, 'model_unknown'],
      [400, '{"error":{"message":"maximum context length is 8192 tokens"}}', {}, 'too_long'],
      [429, '{}', { 'retry-after': '7' }, 'rate_limited'],
      [529, '{}', {}, 'overloaded'],
      [503, '{}', {}, 'overloaded'],
      [500, 'boom', {}, 'provider_error'],
    ]
    for (const [status, body, headers, reason] of cases) {
      f.reply(statusReply(status, body, headers))
      const e = (await failure(call(f)))!
      expect(e.reason, String(status)).toBe(reason)
      expect(e.detail?.status).toBe(status)
      expect(e.detail?.excerpt ?? '').not.toMatch(/0123456789abcdef0123456789abcdef/)
      if (status === 429) expect(e.retryAfterMs).toBe(7000)
    }
    expect(reasonOfStatus(413, '')).toBe('too_long')
  })

  it('ends on a malformed event, on an error event, and on an endless line', async () => {
    const f = await fake()
    f.reply(rawReply('data: {not json\n\n'))
    expect((await failure(call(f)))!.reason).toBe('provider_error')
    f.reply(
      rawReply(
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } })}\n\n`,
      ),
    )
    expect((await failure(call(f, { kind: 'anthropic', baseUrl: f.url, apiKey: 'k' })))!.reason).toBe(
      'overloaded',
    )
    f.reply(rawReply(`data: ${'x'.repeat(70 * 1024)}`))
    expect((await failure(call(f)))!.reason).toBe('provider_error')
  })

  it('stops reading an answer larger than 512 KiB', async () => {
    const f = await fake()
    f.reply(openaiReply('y'.repeat(600 * 1024)))
    expect((await failure(call(f)))!.reason).toBe('too_long')
  })

  it('refuses a redirect, and ends when it is stopped', async () => {
    const f = await fake()
    f.reply(statusReply(302, '', { location: 'http://169.254.169.254/' }))
    expect((await failure(call(f)))!.reason).toBe('provider_error')
    f.reply(async (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`)
      // never ends
    })
    const stop = new AbortController()
    const p = call(f, {}, stop.signal)
    setTimeout(() => stop.abort(), 50)
    expect((await failure(p))!.reason).toBe('aborted')
  })

  it('refuses an address the policy keeps local, before anything is sent', async () => {
    const team = createAiEgress(resolveConfig({ cli: { auth: true, dataDir: '/tmp/x' } }))
    const f = await fake()
    const e = await failure(
      callProvider(team, target(f), message, {
        signal: new AbortController().signal,
        privateOnly: true,
        onText: () => {},
      }),
    )
    expect(e!.reason).toBe('address_refused')
    expect(f.requests).toHaveLength(0)
  })
})
