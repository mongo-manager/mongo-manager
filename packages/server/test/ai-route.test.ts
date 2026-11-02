import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import type { AddressInfo } from 'node:net'
import { request } from 'node:http'
import type { AiLine, AiProviderView, AiStatus } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'
import { openaiReply, startFakeAi, statusReply } from './support/fake-ai'
import { AiLimits } from '../src/ai/limits'

let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
})
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})
const lines = (payload: string) =>
  payload
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as AiLine)

async function local(env: Record<string, string> = {}) {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo, { ...(env.MM_AI === '0' ? { ai: { enabled: false } } : {}) } as never)
  closers.push(h.t.close)
  const db = `ai${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([
      { qty: 1, email: 'a@x' },
      { qty: 9, email: 'b@x' },
    ])
  const post = (path: string, payload: unknown) =>
    h.t.app.inject({ method: 'POST', url: `/api/${path}`, headers: h.headers, payload: payload as object })
  const provider = async (over: Record<string, unknown> = {}) =>
    (
      await post('ai/providers', {
        name: `P${randomUUID().slice(0, 4)}`,
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
        ...over,
      })
    ).json() as AiProviderView
  const ask = (payload: unknown) => h.call('POST', `/databases/${db}/collections/orders/ai`, payload)
  return { h, fake, db, post, provider, ask }
}

describe('the AI routes (phase 4a-1 spec §3.4)', () => {
  it('answers an action as a stream: what was sent, the text, the parsed result; audited without content', async () => {
    const { h, fake, provider, ask } = await local()
    await provider()
    fake.reply(
      openaiReply('Orders over five:\n```json\n{ filter: { qty: { $gt: 5 } } }\n```', {
        input: 40,
        output: 12,
      }),
    )
    const res = await ask({ action: 'query', prompt: 'orders over five', language: 'en' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    const out = lines(res.payload)
    expect(out[0]).toMatchObject({ type: 'context', sent: { namespace: expect.stringMatching(/\.orders$/) } })
    expect(
      out
        .filter((l) => l.type === 'text')
        .map((l) => (l as { delta: string }).delta)
        .join(''),
    ).toMatch(/Orders over five/)
    expect(out.at(-1)).toMatchObject({
      type: 'done',
      result: { kind: 'query', filter: { qty: { $gt: { $numberInt: '5' } } } },
      warnings: [],
      usage: { input: 40, output: 12 },
      local: true,
    })
    const sent = JSON.stringify(fake.requests.at(-1)!.body)
    expect(sent).toContain('orders over five')
    const row = h.t.app.ctx.audit.list({ action: 'ai.request' }).at(0)!
    expect(row).toMatchObject({ outcome: 'success', namespace: expect.stringMatching(/\.orders$/) })
    expect(row.details).toMatchObject({
      action: 'query',
      kind: 'openai',
      local: true,
      samples: 0,
      input: 40,
      output: 12,
      outcome: 'ok',
    })
    expect(JSON.stringify(row)).not.toContain('orders over five')
  })

  it('tells the browser what the provider’s failure means, never its words', async () => {
    const { fake, provider, ask } = await local()
    await provider()
    fake.reply(statusReply(429, '{"error":"slow down, account 1234"}', { 'retry-after': '3' }))
    const out = lines((await ask({ action: 'describe' })).payload)
    expect(out.at(-1)).toEqual({ type: 'error', reason: 'rate_limited', retryAfterMs: 3000 })
    expect(JSON.stringify(out)).not.toContain('account 1234')
  })

  it('refuses before anything is sent: no words, no provider, samples not allowed, the switch, the policy', async () => {
    const { h, fake, provider, ask } = await local()
    expect((await ask({ action: 'describe' })).json()).toMatchObject({ details: { reason: 'no_provider' } })
    await provider({ samples: false })
    expect((await ask({ action: 'query' })).json()).toMatchObject({ details: { reason: 'prompt_required' } })
    expect((await ask({ action: 'describe', samples: { count: 1 } })).json()).toMatchObject({
      details: { reason: 'samples_refused' },
    })
    h.t.app.ctx.connections.setAiPolicy(h.connectionId, 'off')
    expect((await ask({ action: 'describe' })).statusCode).toBe(403)
    expect(fake.requests).toHaveLength(0)
    const rows = h.t.app.ctx.audit.list({ action: 'ai.request' })
    expect(rows.find((r) => r.outcome === 'denied')!.details).toMatchObject({ reason: 'ai_off' })
  })

  it('is off everywhere when the server turns it off', async () => {
    const { provider, ask, h } = await local({ MM_AI: '0' })
    await provider()
    expect((await ask({ action: 'describe' })).json()).toMatchObject({ details: { reason: 'ai_off' } })
    const status = (await h.get('/api/ai/status')).json() as AiStatus
    expect(status).toMatchObject({ enabled: false, providers: [] })
  })

  it('counts requests per user per minute and per day', async () => {
    const fake = await startFakeAi()
    closers.push(fake.close)
    const h = await dataHarness(mongo, { ai: { perMinute: 2, perDay: 3 } } as never)
    closers.push(h.t.close)
    await h.t.app.inject({
      method: 'POST',
      url: '/api/ai/providers',
      headers: h.headers,
      payload: { name: 'P', kind: 'openai', baseUrl: `${fake.url}/v1`, model: 'm' },
    })
    const db = `ai${randomUUID().slice(0, 8)}`
    await client.db(db).collection('c').insertOne({ a: 1 })
    const ask = () => h.call('POST', `/databases/${db}/collections/c/ai`, { action: 'describe' })
    expect((await ask()).statusCode).toBe(200)
    expect((await ask()).statusCode).toBe(200)
    const third = await ask()
    expect(third.statusCode).toBe(429)
    expect(third.json()).toMatchObject({ details: { retryAfterMs: expect.any(Number) } })
    h.t.clock.now += 61_000
    expect((await ask()).statusCode).toBe(200)
    h.t.clock.now += 61_000
    expect((await ask()).statusCode).toBe(429)
  })

  it('aborts the provider and gives the slot back when the client goes away', async () => {
    const { h, fake, provider, db } = await local()
    await provider()
    let closed = false
    fake.reply(async (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Thinking…' } }] })}\n\n`)
      res.once('close', () => void (closed = true))
    })
    await h.t.app.listen({ port: 0, host: '127.0.0.1' })
    const port = (h.t.app.server.address() as AddressInfo).port
    // node:http, not fetch: the Host header must name the port (S20), which fetch does not let one set.
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/api/connections/${h.connectionId}/databases/${db}/collections/orders/ai`,
      headers: {
        ...h.headers,
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
        'content-type': 'application/json',
      },
    })
    const firstChunk = new Promise<void>((resolve) =>
      req.on('response', (res) => res.once('data', () => resolve())),
    )
    req.end(JSON.stringify({ action: 'describe' }))
    await firstChunk
    req.destroy()
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20))
      expect(ok()).toBe(true)
    }
    await until(() => closed)
    await until(() => h.t.app.ctx.ai.limits.running('local') === 0)
    await until(() => h.t.app.ctx.audit.list({ action: 'ai.request' }).length > 0)
    expect(h.t.app.ctx.audit.list({ action: 'ai.request' }).at(0)!.details).toMatchObject({
      outcome: 'aborted',
    })
  })

  it('lets administrators manage providers, never showing a key, and test one', async () => {
    const { h, fake, post } = await local()
    const created = (
      await post('ai/providers', {
        name: 'Claude',
        kind: 'anthropic',
        baseUrl: fake.url,
        apiKey: 'sk-ant-zz',
      })
    ).json() as AiProviderView
    expect(created).toMatchObject({ keyStored: true, isDefault: true, model: 'claude-sonnet-5' })
    const list = await h.get('/api/ai/providers')
    expect(list.payload).not.toContain('sk-ant-zz')
    const moved = await h.t.app.inject({
      method: 'PATCH',
      url: `/api/ai/providers/${created.id}`,
      headers: h.headers,
      payload: { baseUrl: 'https://other.example' },
    })
    expect(moved.json()).toMatchObject({ details: { reason: 'key_required' } })
    fake.reply(statusReply(401, '{}'))
    const test = (await post(`ai/providers/${created.id}/test`, {})).json() as {
      outcome: string
      local: boolean | null
    }
    expect(test.outcome).toBe('key_refused')
    expect(((await h.get('/api/ai/providers')).json() as AiProviderView[])[0]).toMatchObject({
      lastTest: 'key_refused',
    })
    for (const action of ['ai.provider.create', 'ai.provider.test'])
      expect(JSON.stringify(h.t.app.ctx.audit.list({ action }))).not.toContain('sk-ant-zz')
    expect(
      (await h.t.app.inject({ method: 'DELETE', url: `/api/ai/providers/${created.id}`, headers: h.headers }))
        .statusCode,
    ).toBe(204)
  })

  it('tells signed-in users what they may use; nothing to those without ai:use', async () => {
    const fake = await startFakeAi()
    closers.push(fake.close)
    const team = await teamHarness(mongo, { ai: { privateNetworks: ['127.0.0.1/32'] } } as never)
    closers.push(team.t.close)
    team.t.app.ctx.ai.providers.create(
      {
        name: 'Local',
        kind: 'ollama',
        baseUrl: fake.url,
        model: 'm',
        maxTokens: 2048,
        enabled: true,
        isDefault: false,
      },
      null,
    )
    const editor = team.user('editor')
    const viewer = team.user('viewer')
    expect(((await editor.get('/api/ai/status')).json() as AiStatus).providers).toHaveLength(1)
    expect((await viewer.get('/api/ai/status')).json() as AiStatus).toMatchObject({
      enabled: false,
      providers: [],
    })
    expect(
      (await viewer.call('POST', '/databases/d/collections/c/ai', { action: 'describe' })).statusCode,
    ).toBe(403)
  })

  it('saves a connection’s policy with the connection, without touching its settings', async () => {
    const { h } = await local()
    const before = h.t.app.ctx.connections.get(h.connectionId)!
    const res = await h.t.app.inject({
      method: 'PATCH',
      url: `/api/connections/${h.connectionId}`,
      headers: h.headers,
      payload: { aiPolicy: 'local' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ aiPolicy: 'local' })
    const after = h.t.app.ctx.connections.get(h.connectionId)!
    expect(after.settings).toEqual(before.settings)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  it('counts requests and tokens for Prometheus, with no names', async () => {
    const { fake, provider, ask, h } = await local()
    await provider()
    fake.reply(openaiReply('Fine.', { input: 5, output: 2 }))
    await ask({ action: 'describe' })
    const m = h.t.app.ctx.ai.metrics
    expect(m.requests.get('describe|ok')).toBe(1)
    expect(m.tokens).toEqual({ input: 5, output: 2 })
  })
})

describe('AI limits (phase 4a-1 spec §3.3)', () => {
  it('allows two at once per user and the server’s maximum', () => {
    const clock = { now: 0 }
    const l = new AiLimits(() => clock.now, { perMinute: 100, perDay: 100, perUser: 2, server: 3 })
    const a1 = l.enter('a')
    l.enter('a')
    expect(() => l.enter('a')).toThrow(/busy/)
    l.enter('b')
    expect(() => l.enter('c')).toThrow(/busy/)
    a1()
    a1()
    expect(l.running('a')).toBe(1)
    expect(() => l.enter('c')).not.toThrow()
  })
})

describe('quick actions think briefly (UI redesign R1 review: Ask was slow)', () => {
  it('asks a reasoning model for low effort on a query, and leaves a description to its default', async () => {
    const { fake, provider, ask } = await local()
    await provider({ model: 'gpt-5-mini' })
    fake.reply(openaiReply('Here:\n```json\n{ "filter": { "qty": 1 } }\n```'))
    await ask({ action: 'query', prompt: 'qty one', language: 'en' })
    expect(fake.requests.at(-1)!.body.reasoning_effort).toBe('low')
    fake.reply(openaiReply('Orders.'))
    await ask({ action: 'describe', language: 'en' })
    expect(fake.requests.at(-1)!.body).not.toHaveProperty('reasoning_effort')
  })
})

describe('related collections (UI redesign R1 review: "2 collection birbirine bağlıyor mu?")', () => {
  it('sends the schema of the collections its id fields refer to — names and types, never values', async () => {
    const { fake, db, provider, ask } = await local()
    const customer = new ObjectId()
    await client
      .db(db)
      .collection('customers')
      .insertOne({ _id: customer, name: 'Ada Secret', email: 'ada@secret.example' })
    await client
      .db(db)
      .collection('orders')
      .updateMany({}, { $set: { customerId: customer, status: 'shipped' } })
    await provider()
    fake.reply(openaiReply('Here:\n```json\n[{ "$match": { "status": "shipped" } }]\n```'))
    const res = await ask({
      action: 'pipeline',
      prompt: 'shipped orders with their customers',
      language: 'en',
    })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    expect(context.sent.related).toEqual([
      expect.objectContaining({ namespace: `${db}.customers`, via: 'customerId' }),
    ])
    expect(context.sent.related![0]!.schema.fields.map((f) => f.path)).toEqual(
      expect.arrayContaining(['_id', 'name', 'email']),
    )
    const sent = JSON.stringify(fake.requests.at(-1)!.body)
    expect(sent).toContain('customers')
    expect(sent).not.toContain('Ada Secret')
    expect(sent).not.toContain('ada@secret.example')
  })

  it('sends no related collections where none is referred to, nor for a description', async () => {
    const { fake, provider, ask } = await local()
    await provider()
    fake.reply(openaiReply('Orders.'))
    const res = await ask({ action: 'describe', language: 'en' })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    expect(context.sent.related ?? []).toEqual([])
  })

  it('says when a find cannot answer the request, so the user is sent to a pipeline', async () => {
    const { h, fake, provider, ask } = await local()
    await provider()
    fake.reply(openaiReply('This needs the customers collection.\n```json\n{ "needsPipeline": true }\n```'))
    const res = await ask({ action: 'query', prompt: 'shipped orders with customer names', language: 'en' })
    expect(lines(res.payload).at(-1)).toMatchObject({ type: 'done', result: null, reason: 'needs_pipeline' })
    expect(JSON.stringify(fake.requests.at(-1)!.body)).toContain('needsPipeline')
    // Final review Minor 9: a valid answer, audited as one.
    const row = h.t.app.ctx.audit.list({ action: 'ai.request' }).at(0)!
    expect(row.outcome).toBe('success')
    expect(row.details).toMatchObject({ outcome: 'needs_pipeline' })
  })
})

describe('related collections, abuse cases', () => {
  it('marks a related collection’s personal fields by its own rules, and never looks at system collections', async () => {
    const { h, fake, db, provider, ask } = await local()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'customers', field: 'email' }])
    const id = new ObjectId()
    await client.db(db).collection('customers').insertOne({ _id: id, name: 'N', email: 'hidden@example.com' })
    await client
      .db(db)
      .collection('system.js')
      .insertOne({ _id: 'f', value: 'x' } as never)
      .catch(() => {})
    await client
      .db(db)
      .collection('orders')
      .updateMany({}, { $set: { customerId: id, jsId: 'f' } })
    await provider()
    fake.reply(openaiReply('```json\n[]\n```'))
    const res = await ask({ action: 'pipeline', prompt: 'join', language: 'en' })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    expect(context.sent.related!.map((r) => r.namespace)).toEqual([`${db}.customers`])
    const email = context.sent.related![0]!.schema.fields.find((f) => f.path === 'email')
    expect(email?.personal).toBe(true)
    expect(JSON.stringify(fake.requests.at(-1)!.body)).not.toContain('hidden@example.com')
  })
})

describe('related collections inside arrays (UI redesign R1 review: products were not joined)', () => {
  it('names an id inside an array of documents by its MongoDB path, and tells the model how to join it', async () => {
    const { fake, db, provider, ask } = await local()
    const product = new ObjectId()
    await client.db(db).collection('products').insertOne({ _id: product, name: 'Oak Lamp', price: 12 })
    await client
      .db(db)
      .collection('orders')
      .updateMany({}, { $set: { items: [{ productId: product, qty: 2 }] } })
    await provider()
    fake.reply(openaiReply('```json\n[]\n```'))
    const res = await ask({ action: 'pipeline', prompt: 'orders with their products', language: 'en' })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    expect(context.sent.related).toEqual([
      expect.objectContaining({ namespace: `${db}.products`, via: 'items.productId', inArray: true }),
    ])
    const system = JSON.stringify(fake.requests.at(-1)!.body)
    expect(system).toContain('$map')
  })
})

describe('changing a pipeline step by step (UI redesign R1 review: "yazdığı pipeline editleyebilmesi lazım")', () => {
  it('asks the model to change the current pipeline, keeping the rest, with the earlier requests', async () => {
    const { fake, provider, ask } = await local()
    await provider()
    fake.reply(openaiReply('Added the product names.\n```json\n[{ "$match": { "status": "shipped" } }]\n```'))
    const res = await ask({
      action: 'pipeline',
      prompt: 'also show the product names',
      language: 'en',
      refine: true,
      history: ['shipped orders with their customers'],
      current: { pipeline: [{ $match: { status: 'shipped' } }] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.stringify(fake.requests.at(-1)!.body)
    expect(body).toContain('Change the current pipeline')
    expect(body).toContain('Keep every stage')
    expect(body).toContain('shipped orders with their customers')
    expect(body).toContain('also show the product names')
    expect(lines(res.payload).at(-1)).toMatchObject({ type: 'done', result: { kind: 'pipeline' } })
  })

  it('writes from scratch when there is no current pipeline to change', async () => {
    const { fake, provider, ask } = await local()
    await provider()
    fake.reply(openaiReply('```json\n[]\n```'))
    await ask({ action: 'pipeline', prompt: 'orders', language: 'en', refine: true })
    expect(JSON.stringify(fake.requests.at(-1)!.body)).not.toContain('Change the current pipeline')
  })

  it('bounds the earlier requests it accepts', async () => {
    const { ask } = await local()
    const res = await ask({
      action: 'pipeline',
      prompt: 'x',
      language: 'en',
      refine: true,
      history: Array.from({ length: 9 }, (_, i) => `step ${i}`),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('related collections are optional (final review I1)', () => {
  it('answers without a related collection whose schema cannot be read', async () => {
    const { fake, db, provider, ask } = await local()
    // A view whose pipeline fails when read: its schema pass throws.
    await client.db(db).createCollection('customers', {
      viewOn: 'orders',
      pipeline: [{ $project: { broken: { $divide: [1, 0] } } }],
    })
    await client
      .db(db)
      .collection('orders')
      .updateMany({}, { $set: { customerId: new ObjectId() } })
    await provider()
    fake.reply(openaiReply('```json\n[{ "$limit": 5 }]\n```'))
    const res = await ask({ action: 'pipeline', prompt: 'orders with customers', language: 'en' })
    expect(res.statusCode).toBe(200)
    const out = lines(res.payload)
    expect(out[0]).toMatchObject({ type: 'context' })
    expect((out[0] as Extract<AiLine, { type: 'context' }>).sent.related ?? []).toEqual([])
    expect(out.at(-1)).toMatchObject({ type: 'done', result: { kind: 'pipeline' } })
  })
})

describe('hidden values in a change (final review I2)', () => {
  it('tells the model to keep "***" as it is, and flags a change that carries it back', async () => {
    const { fake, provider, ask } = await local()
    await provider()
    fake.reply(openaiReply('```json\n[{ "$match": { "email": "***", "qty": { "$gt": 1 } } }]\n```'))
    const res = await ask({
      action: 'pipeline',
      prompt: 'only more than one',
      language: 'en',
      refine: true,
      current: { pipeline: [{ $match: { email: '***' } }] },
    })
    expect(JSON.stringify(fake.requests.at(-1)!.body)).toContain('exactly where it is')
    expect(lines(res.payload).at(-1)).toMatchObject({
      type: 'done',
      warnings: expect.arrayContaining(['masked_values']),
    })
  })

  it('does not flag a change without hidden values, nor a pipeline written from scratch', async () => {
    const { fake, provider, ask } = await local()
    await provider()
    fake.reply(openaiReply('```json\n[{ "$match": { "qty": { "$gt": 1 } } }]\n```'))
    const change = await ask({
      action: 'pipeline',
      prompt: 'only more than one',
      language: 'en',
      refine: true,
      current: { pipeline: [{ $match: { qty: 1 } }] },
    })
    expect((lines(change.payload).at(-1) as { warnings: string[] }).warnings).not.toContain('masked_values')
    fake.reply(openaiReply('```json\n[{ "$match": { "email": "***" } }]\n```'))
    const fresh = await ask({ action: 'pipeline', prompt: 'x', language: 'en' })
    expect((lines(fresh.payload).at(-1) as { warnings: string[] }).warnings).not.toContain('masked_values')
  })
})

describe('which id fields name a related collection (final review Minor 7, Minor 8)', () => {
  it('follows customer._id, and ignores a one-letter base such as PID', async () => {
    const { fake, db, provider, ask } = await local()
    await client.db(db).collection('customers').insertOne({ name: 'N' })
    await client.db(db).collection('ps').insertOne({ x: 1 })
    await client.db(db).collection('p').insertOne({ x: 1 })
    await client
      .db(db)
      .collection('orders')
      .updateMany({}, { $set: { customer: { _id: new ObjectId() }, PID: 7 } })
    await provider()
    fake.reply(openaiReply('```json\n[]\n```'))
    const res = await ask({ action: 'pipeline', prompt: 'join', language: 'en' })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    expect(context.sent.related?.map((r) => [r.namespace, r.via])).toEqual([
      [`${db}.customers`, 'customer._id'],
    ])
  })

  it('no longer tells the model it cannot know earlier requests', async () => {
    const { fake, provider, ask } = await local()
    await provider()
    fake.reply(openaiReply('```json\n[]\n```'))
    await ask({ action: 'pipeline', prompt: 'x', language: 'en' })
    const body = JSON.stringify(fake.requests.at(-1)!.body)
    expect(body).not.toContain('remember earlier requests')
    expect(body).toContain('earlier requests only when they are given to you')
  })
})

describe('a related view is masked by its source’s rules (final review Minor 11)', () => {
  it('marks a view’s personal fields as its collection’s are', async () => {
    const { h, fake, db, provider, ask } = await local()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    await client.db(db).collection('people').insertOne({ name: 'N', email: 'view-secret@example.com' })
    await client.db(db).createCollection('customers', { viewOn: 'people', pipeline: [] })
    await client
      .db(db)
      .collection('orders')
      .updateMany({}, { $set: { customerId: new ObjectId() } })
    await provider()
    fake.reply(openaiReply('```json\n[]\n```'))
    const res = await ask({ action: 'pipeline', prompt: 'join', language: 'en' })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    expect(context.sent.related?.map((r) => r.namespace)).toEqual([`${db}.customers`])
    expect(context.sent.related![0]!.schema.fields.find((f) => f.path === 'email')?.personal).toBe(true)
    expect(JSON.stringify(fake.requests.at(-1)!.body)).not.toContain('view-secret@example.com')
  })
})

describe('collections that refer to this one (user, 2026-10-08: "Copper Bowl ürününün ödemesini yapan müşteriler")', () => {
  /** products ← orders.items.productId, orders.customerId → customers; asked from products. */
  async function shop() {
    const t = await local()
    const product = new ObjectId()
    const customer = new ObjectId()
    await client.db(t.db).collection('products').insertOne({ _id: product, name: 'Copper Bowl', sku: 'S1' })
    await client
      .db(t.db)
      .collection('customers')
      .insertOne({ _id: customer, name: 'Ada Secret', email: 'ada@secret.example' })
    await client
      .db(t.db)
      .collection('orders')
      .updateMany(
        {},
        { $set: { customerId: customer, status: 'paid', items: [{ productId: product, qty: 1 }] } },
      )
    await t.provider()
    t.fake.reply(openaiReply('```json\n[{ "$limit": 5 }]\n```'))
    const askProducts = (payload: unknown) =>
      t.h.call('POST', `/databases/${t.db}/collections/products/ai`, payload)
    return { ...t, askProducts }
  }

  it('sends the collections that refer to this one, and where they lead, by their schema only', async () => {
    const { fake, db, askProducts } = await shop()
    const res = await askProducts({
      action: 'pipeline',
      prompt: 'customers who paid for Copper Bowl',
      language: 'en',
    })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    expect(context.sent.related).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: `${db}.orders`,
          via: 'items.productId',
          inArray: true,
          refersHere: true,
        }),
        expect.objectContaining({ namespace: `${db}.customers`, via: 'customerId', from: `${db}.orders` }),
      ]),
    )
    const body = JSON.stringify(fake.requests.at(-1)!.body)
    // The model is told how to join a collection that refers to this one.
    expect(body).toContain('refersHere')
    expect(body).toContain('foreignField')
    // Names and types only: no value of any collection leaves.
    expect(body).not.toContain('Ada Secret')
    expect(body).not.toContain('ada@secret.example')
    expect(body).not.toContain('Copper Bowl"')
  })

  it('sends a collection reached from two places once', async () => {
    const { db, askProducts } = await shop()
    await client
      .db(db)
      .createCollection('paid_orders', { viewOn: 'orders', pipeline: [{ $match: { status: 'paid' } }] })
    const res = await askProducts({ action: 'pipeline', prompt: 'customers who paid', language: 'en' })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    const names = context.sent.related!.map((r) => r.namespace)
    expect(names).toEqual(expect.arrayContaining([`${db}.orders`, `${db}.paid_orders`, `${db}.customers`]))
    expect(names.filter((n) => n === `${db}.customers`)).toHaveLength(1)
  })

  it('marks personal fields of a collection it reaches by its own rules', async () => {
    const { h, db, askProducts } = await shop()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'customers', field: 'email' }])
    const res = await askProducts({ action: 'query', prompt: 'customers who paid', language: 'en' })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    const customers = context.sent.related!.find((r) => r.namespace === `${db}.customers`)!
    expect(customers.schema.fields.find((f) => f.path === 'email')?.personal).toBe(true)
  })

  it('looks at no system collection and no other database, and nothing for a description', async () => {
    const { db, askProducts } = await shop()
    await client
      .db(db)
      .collection('system.js')
      .insertOne({ _id: 'f', productId: 1 } as never)
      .catch(() => {})
    await client.db(`${db}x`).collection('orders').insertOne({ productId: new ObjectId() })
    const res = await askProducts({ action: 'pipeline', prompt: 'x', language: 'en' })
    const context = lines(res.payload)[0] as Extract<AiLine, { type: 'context' }>
    expect(context.sent.related!.every((r) => r.namespace.startsWith(`${db}.`))).toBe(true)
    expect(context.sent.related!.some((r) => r.namespace.includes('system.'))).toBe(false)
    const described = await askProducts({ action: 'describe', language: 'en' })
    const none = lines(described.payload)[0] as Extract<AiLine, { type: 'context' }>
    expect(none.sent.related ?? []).toEqual([])
    await client.db(`${db}x`).dropDatabase()
  })
})
