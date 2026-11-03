import { afterEach, describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import type { AiModelsResult, AiProviderView } from '@mongo-manager/shared'
import { dataHarness, teamHarness } from './support/data'
import type { TestMongo } from './support/mongo'
import { startFakeAi, type FakeAi } from './support/fake-ai'
import { H } from './helpers'

/** Listing models never talks to MongoDB: the connection only has to exist. */
const NO_MONGO = { port: 1 } as TestMongo
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})
const json =
  (body: unknown, status = 200) =>
  (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

async function setup() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(NO_MONGO)
  closers.push(() => h.t.close())
  const models = (body: unknown) =>
    h.t.app.inject({ method: 'POST', url: '/api/ai/models', headers: h.headers, payload: body as object })
  return { fake, h, models }
}
const last = (fake: FakeAi) => fake.requests.at(-1)!

describe('the models a provider offers (user, 2026-10-09: "sağlayıcılara model seçimi ekle")', () => {
  it('lists an OpenAI-compatible provider’s models, sorted, with the key in its header', async () => {
    const { fake, models } = await setup()
    fake.reply(json({ data: [{ id: 'gpt-5-mini' }, { id: 'gpt-4.1' }, { id: 'gpt-5' }] }))
    const res = await models({ kind: 'openai', baseUrl: `${fake.url}/v1`, apiKey: 'sk-test' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as AiModelsResult).models.map((m) => m.id)).toEqual(['gpt-4.1', 'gpt-5', 'gpt-5-mini'])
    expect(last(fake).path).toBe('/v1/models')
    expect(last(fake).headers.authorization).toBe('Bearer sk-test')
  })

  it('reads Anthropic’s, Gemini’s and Ollama’s lists in their own shapes', async () => {
    const { fake, models } = await setup()
    fake.reply(json({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }))
    const a = (await models({ kind: 'anthropic', baseUrl: fake.url, apiKey: 'ak' })).json() as AiModelsResult
    expect(a.models).toEqual([{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }])
    expect(last(fake).path.split('?')[0]).toBe('/v1/models')
    expect(last(fake).headers['x-api-key']).toBe('ak')
    expect(last(fake).headers['anthropic-version']).toBeDefined()

    fake.reply(
      json({
        models: [
          {
            name: 'models/gemini-3-flash',
            displayName: 'Gemini 3 Flash',
            supportedGenerationMethods: ['generateContent'],
          },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    )
    const g = (await models({ kind: 'gemini', baseUrl: fake.url, apiKey: 'gk' })).json() as AiModelsResult
    expect(g.models).toEqual([{ id: 'gemini-3-flash', label: 'Gemini 3 Flash' }])
    expect(last(fake).path.startsWith('/v1beta/models')).toBe(true)
    // The key travels in its header, never in the URL.
    expect(last(fake).path).not.toContain('gk')
    expect(last(fake).headers['x-goog-api-key']).toBe('gk')

    fake.reply(json({ models: [{ name: 'llama3.3:70b' }, { name: 'qwen3:8b' }] }))
    const o = (await models({ kind: 'ollama', baseUrl: fake.url })).json() as AiModelsResult
    expect(o.models.map((m) => m.id)).toEqual(['llama3.3:70b', 'qwen3:8b'])
    expect(last(fake).path).toBe('/api/tags')
  })

  it('says why a provider gave no list, in its words never', async () => {
    const { fake, models } = await setup()
    fake.reply(json({ error: { message: 'Incorrect API key provided: sk-…secret' } }, 401))
    const res = (await models({ kind: 'openai', baseUrl: `${fake.url}/v1`, apiKey: 'bad' })).json()
    expect(res).toEqual({ outcome: 'key_refused', models: [] })
    expect(JSON.stringify(res)).not.toContain('secret')
  })

  it('keeps names it can show, and at most 500 of them', async () => {
    const { fake, models } = await setup()
    fake.reply(
      json({
        data: [
          ...Array.from({ length: 600 }, (_, i) => ({ id: `m-${String(i).padStart(3, '0')}` })),
          { id: 'x'.repeat(300) },
          { id: 'bad\nname' },
          { id: 42 },
          null,
        ],
      }),
    )
    const res = (await models({ kind: 'openai', baseUrl: `${fake.url}/v1` })).json() as AiModelsResult
    expect(res.models).toHaveLength(500)
    expect(res.models.every((m) => /^m-\d{3}$/.test(m.id))).toBe(true)
  })
})

describe('the models list, abuse cases', () => {
  it('sends a saved provider’s key to its own address only — never to another one', async () => {
    const { fake, h, models } = await setup()
    const other = await startFakeAi()
    closers.push(other.close)
    const saved = (
      await h.t.app.inject({
        method: 'POST',
        url: '/api/ai/providers',
        headers: h.headers,
        payload: {
          name: 'P',
          kind: 'openai',
          baseUrl: `${fake.url}/v1`,
          model: 'm',
          apiKey: 'sk-stored-secret',
        },
      })
    ).json() as AiProviderView
    fake.reply(json({ data: [{ id: 'a' }] }))
    other.reply(json({ data: [{ id: 'b' }] }))
    await models({ kind: 'openai', baseUrl: `${fake.url}/v1`, providerId: saved.id })
    expect(last(fake).headers.authorization).toBe('Bearer sk-stored-secret')
    // Pointed elsewhere (or at another kind), the stored key stays home.
    await models({ kind: 'openai', baseUrl: `${other.url}/v1`, providerId: saved.id })
    expect(last(other).headers.authorization).toBeUndefined()
    await models({ kind: 'ollama', baseUrl: `${fake.url}/v1`, providerId: saved.id })
    expect(last(fake).headers.authorization).toBeUndefined()
  })

  it('is for administrators only, refuses a bad address, and is rate limited', async () => {
    const h = await teamHarness(NO_MONGO)
    closers.push(() => h.t.close())
    const { ctx } = h.t.app
    const user = ctx.users.create({ username: 'viewer-x', passwordHash: 'x', role: 'viewer' })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const refused = await h.t.app.inject({
      method: 'POST',
      url: '/api/ai/models',
      headers: { ...H, 'x-csrf-token': session.csrfToken },
      cookies: { mm_sid: sessionId },
      payload: { kind: 'ollama' },
    })
    expect(refused.statusCode).toBe(403)
    const { fake, models } = await setup()
    expect((await models({ kind: 'openai', baseUrl: 'ftp://x' })).statusCode).toBe(400)
    expect((await models({ kind: 'openai', baseUrl: 'http://user:pw@127.0.0.1/' })).statusCode).toBe(400)
    expect((await models({ kind: 'nope' })).statusCode).toBe(400)
    fake.reply(json({ data: [] }))
    const codes: number[] = []
    for (let i = 0; i < 12; i++)
      codes.push((await models({ kind: 'openai', baseUrl: `${fake.url}/v1` })).statusCode)
    expect(codes).toContain(429)
  })
})
