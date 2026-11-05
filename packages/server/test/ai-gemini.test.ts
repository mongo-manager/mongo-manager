// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolveConfig } from '../src/config'
import { createAiEgress } from '../src/ai/egress'
import { ProviderError, buildRequest, callProvider, retryDelay, type WireTarget } from '../src/ai/wire'
import type { Egress } from '../src/net/egress'
import { H, makeApp, type TestApp } from './helpers'
import { echoReply, geminiReply, rawReply, startFakeAi, statusReply, type FakeAi } from './support/fake-ai'

let egress: Egress
beforeAll(() => {
  egress = createAiEgress(resolveConfig({ cli: { auth: false, dataDir: '/tmp/x' } }))
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})
async function fake(): Promise<FakeAi> {
  const f = await startFakeAi()
  closers.push(f.close)
  return f
}
const target = (f: FakeAi, over: Partial<WireTarget> = {}): WireTarget => ({
  kind: 'gemini',
  baseUrl: f.url,
  model: 'gemini-2.5-pro',
  apiKey: 'g-key-123',
  maxTokens: 512,
  ...over,
})
const conversation = {
  system: 'You help.',
  messages: [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' },
    { role: 'user' as const, content: 'second' },
  ],
}
async function call(f: FakeAi, over: Partial<WireTarget> = {}) {
  let text = ''
  const out = await callProvider(egress, target(f, over), conversation, {
    signal: new AbortController().signal,
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

describe('the Gemini kind (phase 4a-2 spec §2.7)', () => {
  it('speaks Gemini: the key in its header only, the system instruction, user and model turns, a stream', async () => {
    const f = await fake()
    f.reply(geminiReply('Merhaba — çok güzel.', { input: 33, output: 8 }, 3))
    const out = await call(f)
    expect(out.text).toBe('Merhaba — çok güzel.')
    expect(out.usage).toEqual({ input: 33, output: 8 })
    const req = f.requests[0]!
    expect(req.path).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
    expect(req.headers['x-goog-api-key']).toBe('g-key-123')
    expect(req.path).not.toContain('g-key-123')
    expect(req.body).toEqual({
      systemInstruction: { parts: [{ text: 'You help.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'reply' }] },
        { role: 'user', parts: [{ text: 'second' }] },
      ],
      generationConfig: { maxOutputTokens: 512 },
    })
  })

  it('never builds a request whose model name reshapes the URL (C11)', () => {
    for (const model of ['../v1/files', 'a/b', 'a?b', 'a#b', '..', '.', 'a b', '%2e%2e'])
      expect(() =>
        buildRequest(
          { kind: 'gemini', baseUrl: 'https://g', model, apiKey: 'k', maxTokens: 1 },
          conversation,
        ),
      ).toThrow(ProviderError)
  })

  it('says what each refusal means, never the provider’s words', async () => {
    const f = await fake()
    const cases: Array<[number, string, string]> = [
      [
        400,
        '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}],"message":"API key g-key-123 not valid"}}',
        'key_refused',
      ],
      [403, '{"error":{"status":"PERMISSION_DENIED"}}', 'key_refused'],
      [404, '{"error":{"status":"NOT_FOUND","message":"models/x is not found"}}', 'model_unknown'],
      [503, '{"error":{"status":"UNAVAILABLE"}}', 'overloaded'],
      [500, '{"error":{"status":"INTERNAL"}}', 'provider_error'],
    ]
    for (const [status, body, reason] of cases) {
      f.reply(statusReply(status, body))
      const e = await failure(call(f))
      expect([status, e?.reason]).toEqual([status, reason])
      expect(e?.detail?.excerpt ?? '').not.toContain('g-key-123')
    }
  })

  it('waits as long as a 429 asks, from Retry-After or Gemini’s retryDelay (at most an hour)', async () => {
    const f = await fake()
    f.reply(
      statusReply(
        429,
        '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"17s"}]}}',
      ),
    )
    expect((await failure(call(f)))?.retryAfterMs).toBe(17_000)
    f.reply(statusReply(429, '{}', { 'retry-after': '4' }))
    expect((await failure(call(f)))?.retryAfterMs).toBe(4000)
    expect(retryDelay('"retryDelay": "99999s"')).toBe(3_600_000)
    expect(retryDelay('nothing')).toBeUndefined()
  })

  it('reads a blocked prompt or a stopped answer as blocked', async () => {
    const f = await fake()
    f.reply(rawReply(`data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\n\n`))
    expect((await failure(call(f)))?.reason).toBe('blocked')
    for (const finishReason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) {
      f.reply(
        rawReply(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'par' }] }, finishReason }] })}\n\n`,
        ),
      )
      expect((await failure(call(f)))?.reason, finishReason).toBe('blocked')
    }
    f.reply(
      rawReply(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'MAX_TOKENS' }] })}\n\n`,
      ),
    )
    expect((await call(f)).text).toBe('ok')
  })

  it('ends on an error event or a malformed one', async () => {
    const f = await fake()
    f.reply(rawReply(`data: ${JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })}\n\n`))
    expect((await failure(call(f)))?.reason).toBe('rate_limited')
    f.reply(rawReply('data: {not json\n\n'))
    expect((await failure(call(f)))?.reason).toBe('provider_error')
  })

  it('sends every kind a whole conversation in its own roles', async () => {
    const f = await fake()
    f.reply(echoReply())
    for (const [kind, baseUrl, roles] of [
      ['gemini', f.url, '3 messages: user,model,user'],
      ['anthropic', f.url, '3 messages: user,assistant,user'],
      ['openai', `${f.url}/v1`, '4 messages: system,user,assistant,user'],
      ['ollama', f.url, '4 messages: system,user,assistant,user'],
    ] as const)
      expect((await call(f, { kind, baseUrl })).text, kind).toBe(roles)
  })
})

describe('Gemini providers (spec §2.7)', () => {
  let t: TestApp
  afterEach(async () => {
    await t?.close()
  })
  const post = (payload: object) =>
    t.app.inject({
      method: 'POST',
      url: '/api/ai/providers',
      headers: {
        host: 'localhost:4321',
        origin: 'http://localhost:4321',
        cookie: H.cookie,
        'x-mm-local': H['x-mm-local'],
        'x-csrf-token': t.app.ctx.localCsrfToken,
      },
      payload,
    })

  it('needs a key and a path-safe model; keeps the key on a move only when given again', async () => {
    t = await makeApp()
    const name = () => `G${randomUUID().slice(0, 4)}`
    expect((await post({ name: name(), kind: 'gemini', model: 'gemini-2.5-pro' })).json()).toMatchObject({
      details: { reason: 'key_required' },
    })
    expect((await post({ name: name(), kind: 'gemini', apiKey: 'k' })).json()).toMatchObject({
      details: { reason: 'model_required' },
    })
    expect(
      (await post({ name: name(), kind: 'gemini', apiKey: 'k', model: '../files' })).json(),
    ).toMatchObject({
      details: { reason: 'model_invalid' },
    })
    const ok = (await post({ name: name(), kind: 'gemini', apiKey: 'k', model: 'gemini-2.5-pro' })).json()
    expect(ok).toMatchObject({
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      keyStored: true,
      samples: false,
    })
    const patch = (payload: object) =>
      t.app.inject({
        method: 'PATCH',
        url: `/api/ai/providers/${ok.id}`,
        headers: {
          host: 'localhost:4321',
          origin: 'http://localhost:4321',
          cookie: H.cookie,
          'x-mm-local': H['x-mm-local'],
          'x-csrf-token': t.app.ctx.localCsrfToken,
        },
        payload,
      })
    expect((await patch({ model: 'a/b' })).json()).toMatchObject({ details: { reason: 'model_invalid' } })
    expect((await patch({ apiKey: null })).json()).toMatchObject({ details: { reason: 'key_required' } })
    expect((await patch({ baseUrl: 'https://gateway.example' })).json()).toMatchObject({
      details: { reason: 'key_required' },
    })
    // Another kind's model name is checked when the provider becomes Gemini.
    const o = (await post({ name: name(), kind: 'ollama', model: 'llama3.3:70b' })).json()
    const toGemini = await t.app.inject({
      method: 'PATCH',
      url: `/api/ai/providers/${o.id}`,
      headers: {
        host: 'localhost:4321',
        origin: 'http://localhost:4321',
        cookie: H.cookie,
        'x-mm-local': H['x-mm-local'],
        'x-csrf-token': t.app.ctx.localCsrfToken,
      },
      payload: { kind: 'gemini', apiKey: 'k' },
    })
    expect(toGemini.json()).toMatchObject({ details: { reason: 'model_invalid' } })
  })
})

describe('thinking kept short for quick actions (UI redesign R1 review: Ask was slow)', () => {
  const body = (model: string, effort?: 'low') =>
    JSON.parse(
      buildRequest(
        {
          kind: 'gemini',
          baseUrl: 'https://g.example',
          model,
          apiKey: 'k',
          maxTokens: 512,
          ...(effort ? { effort } : {}),
        },
        { system: 's', messages: [{ role: 'user', content: 'q' }] },
      ).body.toString(),
    ) as { generationConfig: { thinkingConfig?: Record<string, unknown> } }

  it('asks Gemini 3 and later for a low thinking level', () => {
    expect(body('gemini-3-flash-preview', 'low').generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'low',
    })
    expect(body('gemini-3.8-flash', 'low').generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    expect(body('gemini-3-pro', 'low').generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
  })

  it('gives Gemini 2.5 the smallest thinking budget each model accepts', () => {
    expect(body('gemini-2.5-flash', 'low').generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
    expect(body('gemini-2.5-flash-lite', 'low').generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 0,
    })
    expect(body('gemini-2.5-pro', 'low').generationConfig.thinkingConfig).toEqual({ thinkingBudget: 128 })
  })

  it('leaves other models and longer actions to their defaults', () => {
    expect(body('gemini-2.0-flash', 'low').generationConfig.thinkingConfig).toBeUndefined()
    expect(body('gemma-3-27b-it', 'low').generationConfig.thinkingConfig).toBeUndefined()
    // Final review Minor 10: image and speech models take no thinking settings.
    expect(body('gemini-2.5-flash-image', 'low').generationConfig.thinkingConfig).toBeUndefined()
    expect(body('gemini-2.5-flash-preview-tts', 'low').generationConfig.thinkingConfig).toBeUndefined()
    expect(body('gemini-3-pro-image-preview', 'low').generationConfig.thinkingConfig).toBeUndefined()
    expect(body('gemini-3-flash-preview').generationConfig.thinkingConfig).toBeUndefined()
  })

  it('asks OpenAI reasoning models for low effort, and leaves the others alone', () => {
    const openai = (model: string) =>
      JSON.parse(
        buildRequest(
          { kind: 'openai', baseUrl: 'https://o.example', model, apiKey: 'k', maxTokens: 512, effort: 'low' },
          { system: 's', messages: [{ role: 'user', content: 'q' }] },
        ).body.toString(),
      ) as Record<string, unknown>
    expect(openai('gpt-5-mini').reasoning_effort).toBe('low')
    expect(openai('o4-mini').reasoning_effort).toBe('low')
    expect(openai('o3-2025-04-16').reasoning_effort).toBe('low')
    expect(openai('gpt-4.1')).not.toHaveProperty('reasoning_effort')
    // Final review I4: models that reject "low", or would think more with it.
    for (const model of [
      'gpt-5-chat-latest',
      'gpt-5-pro',
      'o1-mini',
      'o1-preview',
      'gpt-5.1',
      'gpt-5.2-mini',
    ])
      expect(openai(model), model).not.toHaveProperty('reasoning_effort')
  })
})
