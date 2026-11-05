// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Admin, MongoClient, MongoServerError } from 'mongodb'
import type { AiAgentStep, AiChatLine, AiChatView, AiProviderView } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { openaiReply, startFakeAi, statusReply, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf, namedConnection } from './support/agent'
import { restrictedApp } from './support/restricted'
import { H } from './helpers'
import { agentSystemPrompt } from '../src/ai/prompts'
import { setAgentPolicy } from '../src/ai/agent/policy'
import { routeError } from '../src/ai/agent/execute'
import { ConnectionError } from '../src/connections/errors'
import { AI_AGENT_WRITE_TOOLS, MAX_SCHEDULES_PER_USER } from '@mongo-manager/shared'
import { waitJob } from './support/jobs'
import { JobRepo } from '../src/jobs/repo'
import { mkdtempSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The AI database manager (design 2026-10-25): agent mode finished — what it shows, follows,
 * schedules and connects, and who may turn it off.
 */
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
  vi.restoreAllMocks()
  for (const c of closers.splice(0).reverse()) await c()
})

const lines = (payload: string) =>
  payload
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AiChatLine)
const steps = (out: AiChatLine[]): AiAgentStep[] =>
  out.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))

async function agent(overrides: Record<string, unknown> = {}) {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo, overrides as never)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  const provider = (
    await inject('POST', 'ai/providers', {
      name: 'Fake',
      kind: 'openai',
      baseUrl: `${fake.url}/v1`,
      model: 'm',
    })
  ).json() as AiProviderView
  expect((await inject('PUT', 'me/ai-agent', { on: true })).statusCode).toBe(200)
  const db = `mgr${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([
      { status: 'shipping', total: 5 },
      { status: 'delivered', total: 9 },
    ])
  /** The model calls these, then says it is done. */
  const once = (calls: FakeCall[], text = 'Done.') =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text })))
  const turn = async (message: string, extra: object = {}) =>
    lines((await inject('POST', 'ai/agent', { message, ...extra })).payload)
  return { fake, h, inject, provider, db, once, turn }
}

describe('A1: what the person asked for, shown in the app with its query (design 2026-10-25)', () => {
  it('opens the collection with the find applied, the model told only that it opened', async () => {
    const { fake, db, once, turn } = await agent()
    once([
      {
        name: 'open_in_app',
        args: {
          connection: 'Test',
          database: db,
          collection: 'orders',
          filter: '{ "status": "shipping" }',
          sort: '{ "total": -1 }',
          projection: '{ "status": 1, "total": 1 }',
        },
      },
    ])
    const out = await turn('Test bağlantısındaki orderlarda shipping olanları getir')
    const open = out.find((l) => l.type === 'open') as Extract<AiChatLine, { type: 'open' }>
    expect(open.target).toEqual({
      connectionId: expect.any(String),
      db,
      coll: 'orders',
      section: 'documents',
      show: {
        kind: 'query',
        filter: { status: 'shipping' },
        sort: { total: { $numberInt: '-1' } },
        projection: { status: { $numberInt: '1' }, total: { $numberInt: '1' } },
      },
    })
    expect(steps(out)[0]).toMatchObject({ tool: 'open_in_app', state: 'done', sent: 'nothing' })
    // Nothing of the documents went back: it opened, no more.
    const result = conversationOf(fake.requests[1]!.body).results[0]!
    expect(result).toContain('"opened":true')
    expect(result).not.toContain('delivered')
    expect(result).not.toContain('shipping')
  })

  it('opens a pipeline in the builder, one that writes marked never to run on arrival', async () => {
    const { db, once, turn } = await agent()
    once([
      {
        name: 'open_in_app',
        args: {
          connection: 'Test',
          database: db,
          collection: 'orders',
          pipeline: `[{ "$match": { "status": "shipping" } }, { "$out": "copied" }]`,
        },
      },
    ])
    const out = await turn('copy the shipping ones')
    const open = out.find((l) => l.type === 'open') as Extract<AiChatLine, { type: 'open' }>
    expect(open.target).toMatchObject({
      section: 'aggregations',
      show: {
        kind: 'pipeline',
        stages: [{ $match: { status: 'shipping' } }, { $out: 'copied' }],
        writes: true,
      },
    })
    expect(await client.db(db).listCollections({ name: 'copied' }).toArray()).toHaveLength(0)
  })

  it('refuses server JavaScript, a system collection, a query with no collection, and both at once', async () => {
    const { db, once, turn } = await agent()
    const tries: Array<[Record<string, unknown>, string]> = [
      [{ collection: 'orders', filter: '{ "$where": "this.total > 1" }' }, 'server_js'],
      [{ collection: 'system.views', filter: '{}' }, 'credential_collection'],
      [{ filter: '{ "status": "shipping" }' }, 'invalid_arguments'],
      [{ collection: 'orders', filter: '{}', pipeline: '[{ "$match": {} }]' }, 'invalid_arguments'],
    ]
    for (const [args, reason] of tries) {
      once([{ name: 'open_in_app', args: { connection: 'Test', database: db, ...args } }])
      const out = await turn('open it')
      expect(out.some((l) => l.type === 'open')).toBe(false)
      expect(steps(out)[0]).toMatchObject({ tool: 'open_in_app', state: 'refused', reason })
    }
  })

  it('places a query block of its answer on the collection its steps touched, else nowhere', async () => {
    const { db, fake, turn, inject } = await agent()
    const block = '```json\n{ "filter": { "status": "shipping" } }\n```'
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                { name: 'count_documents', args: { connection: 'Test', database: db, collection: 'orders' } },
              ],
            }
          : { text: `Here:\n${block}` },
      ),
    )
    const first = await turn('how many?')
    let done = first.at(-1) as Extract<AiChatLine, { type: 'done' }>
    expect(done.blocks[0]).toMatchObject({ target: { db, coll: 'orders' } })
    const id = (first[0] as { id: string }).id
    // A later turn of the chat that used no collection: its block goes nowhere.
    fake.reply(agentReply(() => ({ text: `Try:\n${block}` })))
    done = (await turn('a query?', { chat: id })).at(-1) as Extract<AiChatLine, { type: 'done' }>
    expect(done.blocks[0]).toMatchObject({ unresolved: true })
    // The same once the chat is read again.
    const view = (await inject('GET', `ai/chats/${id}`)).json() as AiChatView
    const answers = view.messages.filter((m) => m.role === 'assistant')
    expect(answers[0]!.blocks![0]).toMatchObject({ target: { db, coll: 'orders' } })
    expect(answers[1]!.blocks![0]).toMatchObject({ unresolved: true })
  })

  it('places a block naming one of the collections its steps used there', async () => {
    const { db, fake, turn } = await agent()
    await client.db(db).collection('users').insertOne({ a: 1 })
    const named = `\`\`\`json\n{ "namespace": "Test / ${db}.orders", "filter": {} }\n\`\`\``
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                { name: 'count_documents', args: { connection: 'Test', database: db, collection: 'orders' } },
                { name: 'count_documents', args: { connection: 'Test', database: db, collection: 'users' } },
              ],
            }
          : { text: `Here:\n${named}` },
      ),
    )
    const done = (await turn('how many?')).at(-1) as Extract<AiChatLine, { type: 'done' }>
    expect(done.blocks[0]).toMatchObject({ target: { db, coll: 'orders' } })
  })

  it('is told to show documents by opening them with the query', () => {
    expect(agentSystemPrompt('tr')).toMatch(/open_in_app/)
    expect(agentSystemPrompt('tr')).toMatch(/show .*documents.*open/i)
  })
})

describe('A1, reviewed: where blocks go, and what open_in_app accepts', () => {
  const answerWith = (fake: Awaited<ReturnType<typeof agent>>['fake'], calls: FakeCall[], text: string) =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text })))
  const doneOf = (out: AiChatLine[]) => out.at(-1) as Extract<AiChatLine, { type: 'done' }>
  const unnamed = '```json\n{ "filter": {} }\n```'

  it('counts only the steps that did something as the collections used', async () => {
    const { db, fake, turn } = await agent()
    answerWith(
      fake,
      [
        { name: 'count_documents', args: { connection: 'Test', database: db, collection: 'orders' } },
        {
          name: 'find_documents',
          args: { connection: 'Test', database: 'admin', collection: 'system.users' },
        },
      ],
      `Here:\n${unnamed}`,
    )
    const done = doneOf(await turn('look'))
    expect(done.blocks[0]).toMatchObject({ target: { db, coll: 'orders' } })
  })

  it('leaves a block naming a collection the turn did not use unplaced', async () => {
    const { db, fake, turn } = await agent()
    answerWith(
      fake,
      [{ name: 'count_documents', args: { connection: 'Test', database: db, collection: 'orders' } }],
      `Here:\n\`\`\`json\n{ "namespace": "Test / ${db}.elsewhere", "filter": {} }\n\`\`\``,
    )
    expect(doneOf(await turn('look')).blocks[0]).toMatchObject({ unresolved: true })
  })

  it('leaves a block whose name in another letter case fits two collections unplaced', async () => {
    const { db, fake, turn } = await agent()
    await client.db(db).collection('Users').insertOne({ a: 1 })
    await client.db(db).collection('users').insertOne({ a: 1 })
    answerWith(
      fake,
      [
        { name: 'count_documents', args: { connection: 'Test', database: db, collection: 'Users' } },
        { name: 'count_documents', args: { connection: 'Test', database: db, collection: 'users' } },
      ],
      `Here:\n\`\`\`json\n{ "namespace": "TEST / ${db}.USERS", "filter": {} }\n\`\`\``,
    )
    expect(doneOf(await turn('look')).blocks[0]).toMatchObject({ unresolved: true })
  })

  it('reads a fallback turn again with its unnamed blocks unplaced', async () => {
    const { fake, turn, inject } = await agent()
    fake.reply((res, req) =>
      (req.body as { tools?: unknown }).tools
        ? statusReply(400, '{"error":"m does not support tools"}')(res, req)
        : openaiReply(`Try:\n${unnamed}`)(res, req),
    )
    const out = await turn('a query?')
    const id = (out[0] as { id: string }).id
    const view = (await inject('GET', `ai/chats/${id}`)).json() as AiChatView
    expect(view.messages.find((m) => m.role === 'assistant')!.blocks![0]).toMatchObject({ unresolved: true })
  })

  it('places a block by its name in any letter case, and again when the chat is read', async () => {
    const { db, fake, turn, inject } = await agent()
    answerWith(
      fake,
      [{ name: 'count_documents', args: { connection: 'Test', database: db, collection: 'orders' } }],
      `Here:\n\`\`\`json\n{ "namespace": "test / ${db}.orders", "filter": {} }\n\`\`\``,
    )
    const out = await turn('look')
    expect(doneOf(out).blocks[0]).toMatchObject({ target: { db, coll: 'orders' } })
    const id = (out[0] as { id: string }).id
    const view = (await inject('GET', `ai/chats/${id}`)).json() as AiChatView
    expect(view.messages.find((m) => m.role === 'assistant')!.blocks![0]).toMatchObject({
      target: { db, coll: 'orders' },
    })
  })

  it('read again, a block whose last collection may no longer go anywhere stays unplaced', async () => {
    const { db, fake, turn, inject, h } = await agent()
    const second = namedConnection(h.t.app, mongo.port, 'Second')
    answerWith(
      fake,
      [
        { name: 'count_documents', args: { connection: 'Test', database: db, collection: 'orders' } },
        { name: 'count_documents', args: { connection: 'Second', database: db, collection: 'orders' } },
      ],
      `Here:\n${unnamed}`,
    )
    const out = await turn('look')
    expect(doneOf(out).blocks[0]).toMatchObject({ target: { connectionId: second } })
    h.t.app.ctx.connections.setAiPolicy(second, 'off')
    const id = (out[0] as { id: string }).id
    const view = (await inject('GET', `ai/chats/${id}`)).json() as AiChatView
    const block = view.messages.find((m) => m.role === 'assistant')!.blocks![0]!
    expect(block).toMatchObject({ unresolved: true })
    expect(block.target).toBeUndefined()
  })

  it('refuses a $lookup into credentials, and a $function inside $expr', async () => {
    const { db, once, turn } = await agent()
    const tries: Array<[Record<string, unknown>, string]> = [
      [
        {
          pipeline:
            '[{ "$lookup": { "from": "system.users", "localField": "a", "foreignField": "b", "as": "c" } }]',
        },
        'credential_collection',
      ],
      [
        {
          filter:
            '{ "$expr": { "$function": { "body": "function() { return true }", "args": [], "lang": "js" } } }',
        },
        'server_js',
      ],
    ]
    for (const [args, reason] of tries) {
      once([
        { name: 'open_in_app', args: { connection: 'Test', database: db, collection: 'orders', ...args } },
      ])
      const out = await turn('open it')
      expect(steps(out)[0]).toMatchObject({ state: 'refused', reason })
    }
  })

  it('takes blank optional fields for none, and a limit within bounds', async () => {
    const { db, once, turn } = await agent()
    once([
      {
        name: 'open_in_app',
        args: {
          connection: 'Test',
          database: db,
          collection: 'orders',
          filter: '{ "a": 1 }',
          sort: '',
          pipeline: ' ',
          limit: 25,
        },
      },
    ])
    let out = await turn('open it')
    const open = out.find((l) => l.type === 'open') as Extract<AiChatLine, { type: 'open' }>
    expect(open.target.show).toEqual({ kind: 'query', filter: { a: { $numberInt: '1' } }, limit: 25 })
    once([
      {
        name: 'open_in_app',
        args: { connection: 'Test', database: db, collection: 'orders', filter: '{}', limit: 0 },
      },
    ])
    out = await turn('open it')
    expect(steps(out)[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
  })

  // Re-review (M3): a limit alone opens a find of that many; with a pipeline it is refused.
  it('takes a limit alone for a find, and refuses one beside a pipeline', async () => {
    const { db, once, turn } = await agent()
    once([
      { name: 'open_in_app', args: { connection: 'Test', database: db, collection: 'orders', limit: 5 } },
    ])
    let out = await turn('the first five')
    expect((out.find((l) => l.type === 'open') as Extract<AiChatLine, { type: 'open' }>).target.show).toEqual(
      {
        kind: 'query',
        filter: {},
        limit: 5,
      },
    )
    once([
      {
        name: 'open_in_app',
        args: {
          connection: 'Test',
          database: db,
          collection: 'orders',
          pipeline: '[{ "$match": {} }]',
          limit: 5,
        },
      },
    ])
    out = await turn('group five')
    expect(steps(out)[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
  })

  // Second re-review (minor 6): a limit filled in beside another section, or with no collection, is
  // no find — left alone, as before.
  it('leaves a limit alone beside another section or without a collection', async () => {
    const { db, once, turn } = await agent()
    once([
      {
        name: 'open_in_app',
        args: { connection: 'Test', database: db, collection: 'orders', section: 'indexes', limit: 20 },
      },
    ])
    let out = await turn('indexes')
    expect(
      (out.find((l) => l.type === 'open') as Extract<AiChatLine, { type: 'open' }>).target,
    ).toMatchObject({
      section: 'indexes',
    })
    once([{ name: 'open_in_app', args: { connection: 'Test', database: db, limit: 20 } }])
    out = await turn('the database')
    expect((out.find((l) => l.type === 'open') as Extract<AiChatLine, { type: 'open' }>).target).toEqual({
      connectionId: expect.any(String),
      db,
    })
  })

  // Re-review (M4): a blank database, collection or section is none, as the other fields are.
  it('takes a blank database, collection or section for none', async () => {
    const { once, turn } = await agent()
    once([{ name: 'open_in_app', args: { connection: 'Test', database: '', collection: ' ', section: '' } }])
    const out = await turn('open Test')
    expect((out.find((l) => l.type === 'open') as Extract<AiChatLine, { type: 'open' }>).target).toEqual({
      connectionId: expect.any(String),
    })
  })

  it('refuses a section the show does not open', async () => {
    const { db, once, turn } = await agent()
    once([
      {
        name: 'open_in_app',
        args: { connection: 'Test', database: db, collection: 'orders', filter: '{}', section: 'indexes' },
      },
    ])
    expect(steps(await turn('open it'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
  })

  it('treats a pipeline that writes as a change: the agent’s writes, the person’s rights, the policy, its target', async () => {
    const { db, once, turn, inject, h } = await agent()
    const writes = (into: string) =>
      once([
        {
          name: 'open_in_app',
          args: {
            connection: 'Test',
            database: db,
            collection: 'orders',
            pipeline: `[{ "$match": {} }, { "$out": ${into} }]`,
          },
        },
      ])
    writes('{ "db": "admin", "coll": "kept" }')
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'system_namespace' })
    writes('"system.views"')
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'system_namespace' })
    // Re-review of A1/A2 (M1): every write stage's target, not the first one's only.
    const pipeline = (stages: string) =>
      once([
        {
          name: 'open_in_app',
          args: { connection: 'Test', database: db, collection: 'orders', pipeline: stages },
        },
      ])
    // A write stage before the last is no pipeline at all: refused as such, before any target.
    pipeline('[{ "$out": "fine" }, { "$merge": { "into": { "db": "admin", "coll": "x" } } }]')
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    pipeline('[{ "$merge": "merged" }]')
    expect(steps(await turn('merge'))[0]).toMatchObject({ state: 'done' })
    pipeline('[{ "$merge": { "into": { "db": "local", "coll": "x" } } }]')
    expect(steps(await turn('merge'))[0]).toMatchObject({ state: 'refused', reason: 'system_namespace' })
    pipeline('[{ "$merge": { "into": { "db": "other" } } }]')
    expect(steps(await turn('merge'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    await inject('PUT', 'ai/agent-policy', { policy: 'read' })
    writes('"copied"')
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'agent_policy_read' })
    await inject('PUT', 'ai/agent-policy', { policy: 'full' })
    // The person's own right to write documents: read-only mode said as such.
    h.t.app.ctx.connections.update(h.connectionId, { readOnly: true })
    writes('"copied"')
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'read_only' })
    h.t.app.ctx.connections.update(h.connectionId, { readOnly: false })
    h.t.app.ctx.connections.setAiAgentWrites(h.connectionId, false)
    writes('"copied"')
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'agent_writes_off' })
  })

  it('leaves an unnamed block of the plain assistant fallback unplaced, never in the open tab', async () => {
    const { fake, turn } = await agent()
    fake.reply((res, req) =>
      (req.body as { tools?: unknown }).tools
        ? statusReply(400, '{"error":"m does not support tools"}')(res, req)
        : openaiReply(`Try:\n${unnamed}`)(res, req),
    )
    expect(doneOf(await turn('a query?')).blocks[0]).toMatchObject({ unresolved: true })
  })
})

describe('A2: the agent switched off or read-only for everyone by an administrator (design 2026-10-25)', () => {
  const policy = (
    inject: (m: 'GET' | 'PUT', p: string, b?: object) => Promise<{ statusCode: number; json(): unknown }>,
  ) => ({
    get: async () => (await inject('GET', 'ai/agent-policy')).json() as { policy: string },
    set: (value: string) => inject('PUT', 'ai/agent-policy', { policy: value }),
  })

  it('is full by default, set by an administrator and audited', async () => {
    const { h, inject } = await agent()
    expect(await policy(inject).get()).toEqual({ policy: 'full' })
    expect((await policy(inject).set('read')).statusCode).toBe(200)
    expect(await policy(inject).get()).toEqual({ policy: 'read' })
    expect(h.t.app.ctx.audit.list({ action: 'ai.agent.policy' })[0]).toMatchObject({
      details: { policy: 'read', from: 'full' },
    })
    // Review of A2 (minor 9): a save of the same value changes nothing, and records nothing.
    expect((await policy(inject).set('read')).statusCode).toBe(200)
    expect(h.t.app.ctx.audit.list({ action: 'ai.agent.policy' })).toHaveLength(1)
    expect((await policy(inject).set('everything')).statusCode).toBe(400)
  })

  it('is no one else’s to change', async () => {
    const { t, as } = await restrictedApp(mongo, [])
    closers.push(t.close)
    const editor = as('editor')
    expect((await editor.get('/api/ai/agent-policy')).statusCode).toBe(403)
    const s = t.app.ctx.sessions.create(editor.id, {})
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/ai/agent-policy',
      headers: { ...H, 'x-csrf-token': s.session.csrfToken, cookie: `mm_sid=${s.sessionId}` },
      payload: { policy: 'full' },
    })
    expect(put.statusCode).toBe(403)
  })

  it('off: the switch is not offered, a turn is refused, and the person’s own switch cannot override it', async () => {
    const { inject } = await agent()
    await policy(inject).set('off')
    // The person's own switch, turned on again, changes nothing.
    await inject('PUT', 'me/ai-agent', { on: true })
    expect((await inject('GET', 'me/ai-agent')).json()).toEqual({
      on: true,
      available: false,
      assistant: true,
      policy: 'off',
    })
    const out = await inject('POST', 'ai/agent', { message: 'hi' })
    expect(out.statusCode).toBe(403)
    expect(out.json()).toMatchObject({ details: { reason: 'agent_policy_off' } })
  })

  // Review of A2: the assistant itself stays when the agent is off.
  it('off: the plain assistant still answers', async () => {
    const { inject, fake } = await agent()
    await policy(inject).set('off')
    fake.reply(openaiReply('Hello.'))
    const out = lines((await inject('POST', 'ai/chat', { message: 'hi' })).payload)
    expect(out.at(-1)).toMatchObject({ type: 'done' })
  })

  // Review of A2 (minor 7): a value that does not read is no permission — off, not full.
  it('reads an unreadable stored policy as off', async () => {
    const { h, inject } = await agent()
    h.t.app.ctx.store.db
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('ai.agent.policy', JSON.stringify({ policy: 'everything' }), Date.now())
    expect(await policy(inject).get()).toEqual({ policy: 'off' })
    expect((await inject('GET', 'me/ai-agent')).json()).toMatchObject({ available: false, policy: 'off' })
  })

  // Review of A2 (minor 6): turned off while a turn runs, the next call is refused — as a refusal.
  it('refuses the next call once turned off while the turn runs', async () => {
    const { db, h, fake, turn } = await agent()
    const count = {
      name: 'count_documents',
      args: { connection: 'Test', database: db, collection: 'orders' },
    }
    fake.reply(
      agentReply((c) => {
        if (c.results.length === 1) setAgentPolicy(h.t.app.ctx, 'off')
        return c.results.length < 2 ? { calls: [count] } : { text: 'Done.' }
      }),
    )
    const out = await turn('count twice')
    const done = steps(out)
    expect(done[0]).toMatchObject({ state: 'done' })
    expect(done[1]).toMatchObject({ state: 'refused', reason: 'agent_policy_off' })
  })

  // Review of A2 (minor 8): under read only, the model is offered no change and told why.
  it('read-only: offers the model no change tool, and says it may only read', async () => {
    const { inject, fake, turn } = await agent()
    await policy(inject).set('read')
    fake.reply(agentReply(() => ({ text: 'ok' })))
    await turn('hi')
    const body = fake.requests[0]!.body as {
      tools?: Array<{ function?: { name: string } }>
      messages: Array<{ content: unknown }>
    }
    const names = (body.tools ?? []).map((t) => t.function?.name)
    expect(names).toContain('count_documents')
    expect(names).toContain('open_in_app')
    for (const tool of AI_AGENT_WRITE_TOOLS) expect(names).not.toContain(tool)
    expect(JSON.stringify(body.messages[0])).toMatch(/read only/i)
  })

  it('read-only: reads run, every change is refused before a card', async () => {
    const { db, inject, once, turn } = await agent()
    await policy(inject).set('read')
    once([
      { name: 'count_documents', args: { connection: 'Test', database: db, collection: 'orders' } },
      { name: 'create_collection', args: { connection: 'Test', database: db, collection: 'more' } },
    ])
    const out = await turn('count, then add one')
    const done = steps(out)
    expect(done[0]).toMatchObject({ tool: 'count_documents', state: 'done' })
    expect(done[1]).toMatchObject({
      tool: 'create_collection',
      state: 'refused',
      reason: 'agent_policy_read',
    })
    expect(out.some((l) => l.type === 'step' && l.step.state === 'awaiting')).toBe(false)
    expect((await inject('GET', 'me/ai-agent')).json()).toMatchObject({ available: true, policy: 'read' })
  })

  it('a change already on its card is refused once the policy no longer allows it', async () => {
    const { db, h, inject, fake } = await agent()
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                {
                  name: 'create_collection',
                  args: { connection: 'Test', database: db, collection: 'later' },
                },
              ],
            }
          : { text: 'Not done.' },
      ),
    )
    const stream = await agentTurn(h.t.app, h.headers, { message: 'add later' })
    const card = await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const id = (card as Extract<AiChatLine, { type: 'step' }>).step.id
    await policy(inject).set('read')
    // Re-review (I1): ended by the narrowing itself — a confirm after finds nothing waiting.
    await stream.waitFor((l) => l.type === 'step' && l.step.id === id && l.step.state === 'error')
    const answer = await inject('POST', `ai/agent/runs/${run}/decide`, { call: id, decision: 'confirm' })
    expect(answer.statusCode).toBe(404)
    expect(await client.db(db).listCollections({ name: 'later' }).toArray()).toHaveLength(0)
    expect(await stream.ended).toBe(200)
  })

  // Re-review (I1): narrowing it ends a change waiting on its card at once — no answer needed.
  it('narrowing it ends a change already waiting on its card', async () => {
    const { db, h, inject, fake } = await agent()
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                {
                  name: 'create_collection',
                  args: { connection: 'Test', database: db, collection: 'later' },
                },
              ],
            }
          : { text: 'Not done.' },
      ),
    )
    const stream = await agentTurn(h.t.app, h.headers, { message: 'add later' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as Extract<
      AiChatLine,
      { type: 'step' }
    >
    await policy(inject).set('read')
    const ended = (await stream.waitFor(
      (l) => l.type === 'step' && l.step.id === card.step.id && l.step.state === 'error',
    )) as Extract<AiChatLine, { type: 'step' }>
    expect(ended.step.reason).toBe('agent_policy_read')
    expect(await stream.ended).toBe(200)
    expect(await client.db(db).listCollections({ name: 'later' }).toArray()).toHaveLength(0)
  })

  // Second re-review (minor 1): narrowed while the change is being prepared — it never waits.
  it('ends a change narrowed away while it was being prepared, without a card left waiting', async () => {
    const { db, h, inject, fake } = await agent()
    const through = h.t.app.inject.bind(h.t.app) as (opts: unknown) => unknown
    // While the backup's plan is read — the card not yet shown — an administrator narrows it.
    h.t.app.inject = ((opts: unknown) => {
      if (typeof opts === 'object' && opts && String((opts as { url?: string }).url).includes('/backup/plan'))
        setAgentPolicy(h.t.app.ctx, 'read')
      return through(opts)
    }) as unknown as typeof h.t.app.inject
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? { calls: [{ name: 'run_backup', args: { connection: 'Test', database: db, format: 'archive' } }] }
          : { text: 'Not started.' },
      ),
    )
    const out = lines((await inject('POST', 'ai/agent', { message: 'back it up' })).payload)
    expect(out.some((l) => l.type === 'step' && l.step.state === 'awaiting')).toBe(false)
    expect(steps(out)[0]).toMatchObject({ tool: 'run_backup', state: 'error', reason: 'agent_policy_read' })
  })

  it('widening it ends nothing, and narrowing it says how many changes it ended', async () => {
    const { db, h, inject, fake } = await agent()
    await policy(inject).set('read')
    await policy(inject).set('full')
    expect(h.t.app.ctx.audit.list({ action: 'ai.agent.policy' })[0]).not.toHaveProperty('details.ended')
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                {
                  name: 'create_collection',
                  args: { connection: 'Test', database: db, collection: 'later' },
                },
              ],
            }
          : { text: 'Not done.' },
      ),
    )
    const stream = await agentTurn(h.t.app, h.headers, { message: 'add later' })
    await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')
    await policy(inject).set('off')
    await stream.ended
    expect(h.t.app.ctx.audit.list({ action: 'ai.agent.policy' })[0]).toMatchObject({ details: { ended: 1 } })
  })

  // Re-review (nit): a damaged stored value, saved again as off, is repaired.
  it('saves a damaged policy again, though it reads as the same', async () => {
    const { h, inject } = await agent()
    h.t.app.ctx.store.db
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('ai.agent.policy', 'not json', Date.now())
    await policy(inject).set('off')
    const row = h.t.app.ctx.store.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('ai.agent.policy') as { value: string }
    expect(JSON.parse(row.value)).toEqual({ policy: 'off' })
  })

  it('turned off, a change waiting on its card is refused and ended too', async () => {
    const { db, h, inject, fake } = await agent()
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                {
                  name: 'create_collection',
                  args: { connection: 'Test', database: db, collection: 'later' },
                },
              ],
            }
          : { text: 'Not done.' },
      ),
    )
    const stream = await agentTurn(h.t.app, h.headers, { message: 'add later' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as Extract<
      AiChatLine,
      { type: 'step' }
    >
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    await policy(inject).set('off')
    const ended = (await stream.waitFor(
      (l) => l.type === 'step' && l.step.id === card.step.id && l.step.state === 'error',
    )) as Extract<AiChatLine, { type: 'step' }>
    expect(ended.step.reason).toBe('agent_policy_off')
    const answer = await inject('POST', `ai/agent/runs/${run}/decide`, {
      call: card.step.id,
      decision: 'confirm',
    })
    expect(answer.statusCode).toBe(404)
    expect(await stream.ended).toBe(200)
    expect(await client.db(db).listCollections({ name: 'later' }).toArray()).toHaveLength(0)
  })
})

describe('A3: a backup the agent starts, then follows (design 2026-10-25)', () => {
  /** Starts the agent's backup of the database and confirms it; the job's id from the step. */
  async function backedUp(extra: Record<string, unknown> = {}) {
    const env = await agent()
    const { db, fake, h, inject } = env
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                {
                  name: 'run_backup',
                  args: { connection: 'Test', database: db, format: 'archive', ...extra },
                },
              ],
            }
          : { text: 'Started.' },
      ),
    )
    const stream = await agentTurn(h.t.app, h.headers, { message: 'demo db’sini yedekle' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as Extract<
      AiChatLine,
      { type: 'step' }
    >
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const answer = (
      await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'confirm' })
    ).json() as { state: string; summary: { started: boolean; job: string } }
    await stream.ended
    return { ...env, card: card.step, answer, stream }
  }

  // Review of B6 (M1): the backup's own end is in the turn's rows (the job keeps the turn it was
  // started for).
  it('ties the backup’s end to the turn it was started for', async () => {
    const { answer, h, stream, card } = await backedUp()
    await waitJob(h.t, answer.summary.job)
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const row = h.t.app.ctx.audit.list({ action: 'backup.dump' }).at(0)!
    expect((row.details as { agent?: unknown }).agent).toMatchObject({ run, call: card.id })
    expect(h.t.app.ctx.audit.list({ run, limit: 50 }).map((r) => r.action)).toContain('backup.dump')
  })

  // Review of A3 (I1): a backup job's "*" is no name — a server backup has no database, a database
  // backup no collection: neither told, nor placed, nor opened.
  it('tells a database backup without a collection of "*"', async () => {
    const { answer, h, once, turn, fake } = await backedUp()
    await waitJob(h.t, answer.summary.job)
    once([{ name: 'get_job', args: { job: answer.summary.job } }])
    const out = await turn('done?')
    expect(steps(out)[0]!.place).not.toHaveProperty('coll')
    const told = conversationOf(fake.requests.at(-1)!.body).results[0]!
    expect(told).not.toContain('"coll"')
    expect(told).not.toContain('*')
  })

  // Review of A3 (I2): what a job or backup list told is a source of the turn, weighed as such later.
  it('counts the connections it told of as sources of the turn', async () => {
    const { answer, h, once, turn } = await backedUp()
    await waitJob(h.t, answer.summary.job)
    once([{ name: 'list_backups', args: {} }])
    const out = await turn('my backups?')
    const id = (out[0] as { id: string }).id
    expect(
      h.t.app.ctx.ai.chats
        .get(null, id)!
        .turns.at(-1)!
        .record.sources.map((x) => x.connectionId),
    ).toContain(h.connectionId)
  })

  // Review of A3 (I3): another person's jobs are no one else's business, an administrator's included.
  it('lists only the person’s own jobs, an administrator’s agent included', async () => {
    const { t, ctx, as, connectionId } = await restrictedApp(mongo, [], {
      ai: { privateNetworks: ['127.0.0.1/32'] },
    } as never)
    closers.push(t.close)
    const fake = await startFakeAi()
    closers.push(fake.close)
    ctx.ai.providers.create(
      {
        name: 'F',
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
        maxTokens: 512,
        samples: false,
        enabled: true,
        isDefault: true,
      },
      null,
    )
    const me = as('admin')
    const other = as('admin')
    const headers = (id: string) => {
      const session = ctx.sessions.create(id, {})
      return { ...H, 'x-csrf-token': session.session.csrfToken, cookie: `mm_sid=${session.sessionId}` }
    }
    const mine = headers(me.id)
    await t.app.inject({ method: 'PUT', url: '/api/me/ai-agent', headers: mine, payload: { on: true } })
    const job = (userId: string) => {
      const id = randomUUID()
      new JobRepo(ctx.store.db).insert({
        id,
        kind: 'backup.dump',
        userId,
        connectionId,
        targetConnectionId: null,
        db: 'shop',
        coll: '*',
        target: '',
        state: 'done',
        progress: null,
        estimate: null,
        error: null,
        staging: null,
        stagingConnectionId: null,
        stagingDb: null,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      })
      return id
    }
    const theirs = job(other.id)
    const own = job(me.id)
    fake.reply(
      agentReply((c) =>
        c.results.length === 0 ? { calls: [{ name: 'list_jobs', args: {} }] } : { text: 'ok' },
      ),
    )
    const turn = await agentTurn(t.app, mine, { message: 'my jobs?' })
    await turn.ended
    const told = conversationOf(fake.requests.at(-1)!.body).results.join('\n')
    expect(told).toContain(own)
    expect(told).not.toContain(theirs)
  })

  // Review of A3 (I4): a size tells the length of what personal-data rules hide — hidden from the
  // provider where they apply, as collection_stats hides it.
  it('hides a kept backup’s size where personal-data rules apply', async () => {
    const { h, db, once, turn, fake, inject } = await agent()
    // The rules first: a backup made before them is no longer listed (take it again).
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'status' }])
    const base = `connections/${h.connectionId}/backup`
    const body = { scope: { kind: 'database', db }, format: 'archive' }
    const plan = (await inject('POST', `${base}/plan`, body)).json() as { planHash: string }
    const started = (await inject('POST', base, { ...body, planHash: plan.planHash })).json() as {
      job: { id: string }
    }
    await waitJob(h.t, started.job.id)
    once([{ name: 'list_backups', args: {} }])
    await turn('my backups?')
    const told = conversationOf(fake.requests.at(-1)!.body).results[0]!
    const list = JSON.parse(told.slice(told.indexOf('{'), told.lastIndexOf('}') + 1)) as {
      backups: Array<Record<string, unknown>>
    }
    expect(list.backups[0]).toMatchObject({ size: null, sizeHidden: true })
    const allowed = [
      'id',
      'name',
      'connection',
      'scope',
      'format',
      'size',
      'sizeHidden',
      'namespaces',
      'finishedAt',
      'expiresAt',
      'copies',
    ]
    expect(Object.keys(list.backups[0]!).filter((k) => !allowed.includes(k))).toEqual([])
  })

  // Review of A3 (I5): sent on to a destination, the backup is not done when its dump is — the send
  // job is said, and each copy's state; never an error's own words.
  it('says the send job of a backup sent to a destination, and each copy’s state', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mm-agent-dest-'))
    const env = await agent({ backup: { folderRoots: [base] } })
    const { h, db, inject, fake, once, turn } = env
    const dest = await inject('POST', 'backup-destinations', {
      type: 'folder',
      name: 'Disk',
      config: { path: join(base, 'd1') },
    })
    expect(dest.statusCode).toBe(201)
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                { name: 'run_backup', args: { connection: 'Test', database: db, destinations: ['disk'] } },
              ],
            }
          : { text: 'Started.' },
      ),
    )
    const stream = await agentTurn(h.t.app, h.headers, { message: 'back it up to Disk' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as Extract<
      AiChatLine,
      { type: 'step' }
    >
    // Named as listed, in any letter case; the card shows the name, never an id (minor 10, 12).
    expect(JSON.stringify(card.step.proposal!.payload)).toContain('Disk')
    expect(JSON.stringify(card.step.proposal!.payload)).not.toContain(dest.json().id)
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const done = (
      await inject('POST', `ai/agent/runs/${run}/decide`, {
        call: card.step.id,
        decision: 'confirm',
        password: 'correct-horse-battery-1',
      })
    ).json() as { summary: { job: string } }
    await stream.ended
    await waitJob(h.t, done.summary.job, 7000)
    once([{ name: 'get_job', args: { job: done.summary.job } }])
    await turn('is it sent?')
    const told = conversationOf(fake.requests.at(-1)!.body).results[0]!
    expect(told).toMatch(/"sendJob":"[0-9a-f-]{36}"/)
    // Each copy by its destination's name and state, never its error's words.
    const sendJob = /"sendJob":"([0-9a-f-]{36})"/.exec(told)![1]!
    await waitJob(h.t, sendJob, 7000)
    once([{ name: 'list_backups', args: {} }])
    await turn('and the copies?')
    const listed = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    const data = JSON.parse(listed.slice(listed.indexOf('{'), listed.lastIndexOf('}') + 1)) as {
      backups: Array<{ copies: Array<Record<string, unknown>>; size: unknown }>
    }
    expect(data.backups[0]!.copies).toEqual([{ destination: 'Disk', state: 'complete' }])
    expect(typeof data.backups[0]!.size).toBe('number')
  })

  it('refuses deleteLocal without a destination, and a state filter of any job state', async () => {
    const { db, once, turn } = await agent()
    once([
      {
        name: 'run_backup',
        args: { connection: 'Test', database: db, format: 'archive', deleteLocal: true },
      },
    ])
    expect(steps(await turn('back up'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    once([{ name: 'list_jobs', args: { state: 'interrupted' } }])
    expect(steps(await turn('interrupted ones?'))[0]).toMatchObject({ tool: 'list_jobs', state: 'done' })
  })

  it('is told to follow a backup through its job', () => {
    expect(agentSystemPrompt('en')).toMatch(/get_job/)
    expect(agentSystemPrompt('en')).toMatch(/never say a backup finished before its job/i)
  })

  it('says when the kept copy expires, on the card', async () => {
    const { card } = await backedUp()
    expect(card.proposal!.preview).toMatchObject({ expiresInHours: 24 })
  })

  it('gives the started job back, to the person and to the model', async () => {
    const { answer, h, fake } = await backedUp()
    expect(answer).toMatchObject({ state: 'done', summary: { started: true, job: expect.any(String) } })
    expect(h.t.app.ctx.jobs.get(answer.summary.job)).toMatchObject({ kind: 'backup.dump' })
    expect(conversationOf(fake.requests.at(-1)!.body).results.at(-1)).toContain(answer.summary.job)
  })

  it('follows the job and finds the backup it kept — states, sizes and names only', async () => {
    const { answer, h, db, once, turn, fake } = await backedUp()
    await waitJob(h.t, answer.summary.job)
    once([
      { name: 'get_job', args: { job: answer.summary.job } },
      { name: 'list_jobs', args: { connection: 'Test' } },
      { name: 'list_backups', args: { connection: 'Test' } },
    ])
    const out = await turn('is it done?')
    const done = steps(out)
    expect(done.map((s) => [s.tool, s.state])).toEqual([
      ['get_job', 'done'],
      ['list_jobs', 'done'],
      ['list_backups', 'done'],
    ])
    const results = conversationOf(fake.requests.at(-1)!.body).results
    const job = JSON.parse(
      results[0]!.slice(results[0]!.indexOf('{'), results[0]!.lastIndexOf('}') + 1),
    ) as Record<string, unknown>
    expect(job).toMatchObject({ id: answer.summary.job, kind: 'backup.dump', state: 'done', db })
    // Exactly these: never an error's words, a path or anything else the route keeps.
    const allowed = [
      'id',
      'kind',
      'connection',
      'db',
      'coll',
      'state',
      'percent',
      'failed',
      'startedAt',
      'finishedAt',
      'sendJob',
      'sendFailed',
    ]
    expect(Object.keys(job).filter((k) => !allowed.includes(k))).toEqual([])
    expect(results[2]).toContain(db)
    expect(results[2]).toContain('expiresAt')
    // Never a checksum, a path or an error's own words.
    for (const r of results) {
      expect(r).not.toMatch(/sha256|"error":"[^"]/)
    }
  })

  it('sends it to a destination the person may use, named; one unknown refused before a card', async () => {
    const { db, once, turn } = await agent()
    once([
      {
        name: 'run_backup',
        args: { connection: 'Test', database: db, format: 'archive', destinations: ['Nowhere'] },
      },
    ])
    const out = await turn('back it up to Nowhere')
    expect(steps(out)[0]).toMatchObject({
      tool: 'run_backup',
      state: 'refused',
      reason: 'destination_unknown',
    })
  })

  it('finds no job that is not there, nor one of a connection it is not told of — said alike', async () => {
    const { h, db, once, turn, inject, fake } = await agent()
    const second = namedConnection(h.t.app, mongo.port, 'Second')
    const base = `connections/${second}/backup`
    const body = { scope: { kind: 'database', db }, format: 'archive' }
    const plan = (await inject('POST', `${base}/plan`, body)).json() as { planHash: string }
    const started = (await inject('POST', base, { ...body, planHash: plan.planHash })).json() as {
      job: { id: string }
    }
    h.t.app.ctx.connections.setAiPolicy(second, 'off')
    for (const job of [randomUUID(), started.job.id]) {
      once([{ name: 'get_job', args: { job } }])
      const out = await turn('that job?')
      expect(steps(out)[0]).toMatchObject({ tool: 'get_job', state: 'error', reason: 'not_found' })
    }
    once([{ name: 'list_jobs', args: {} }])
    await turn('my jobs?')
    // What the model was given (review of A3, I7: the person's lines never held the list).
    expect(conversationOf(fake.requests.at(-1)!.body).results.join('\n')).not.toContain(started.job.id)
    await waitJob(h.t, started.job.id)
    // Nor the backup it kept.
    once([{ name: 'list_backups', args: {} }])
    const backups = await turn('my backups?')
    expect(steps(backups)[0]).toMatchObject({ tool: 'list_backups', state: 'done', summary: { backups: 0 } })
  })
})

describe('A4: a schedule that will run, checked before its card (design 2026-10-25)', () => {
  /** The agent with a folder destination "Disk" that takes unencrypted backups. */
  async function scheduling(backup: Record<string, unknown> = {}) {
    const base = mkdtempSync(join(tmpdir(), 'mm-agent-sched-'))
    const env = await agent({ backup: { folderRoots: [base], ...backup } })
    // One that takes encrypted backups only, as a new destination does.
    await env.inject('POST', 'backup-destinations', {
      type: 'folder',
      name: 'Sealed',
      config: { path: join(base, 'd2') },
    })
    const dest = await env.inject('POST', 'backup-destinations', {
      type: 'folder',
      name: 'Disk',
      config: { path: join(base, 'd1') },
      policy: { encryptedOnly: false },
    })
    expect(dest.statusCode).toBe(201)
    const weekly = (extra: Record<string, unknown> = {}) =>
      env.once([
        {
          name: 'create_backup_schedule',
          args: {
            connection: 'Test',
            database: env.db,
            name: 'Weekly',
            cadence: '{"kind":"weekly","days":[1],"time":"03:00"}',
            timeZone: 'Europe/Istanbul',
            destinations: ['disk'],
            format: 'archive',
            ...extra,
          },
        },
      ])
    return { ...env, weekly, destination: dest.json().id as string }
  }
  const awaitingOf = (out: AiChatLine[]) =>
    out.find((l) => l.type === 'step' && l.step.state === 'awaiting') as
      Extract<AiChatLine, { type: 'step' }> | undefined

  it('shows a schedule that will run on its card: the retention it keeps, named destinations', async () => {
    const { h, weekly } = await scheduling()
    weekly({ retention: 'long' })
    const stream = await agentTurn(h.t.app, h.headers, { message: 'haftalık yedek kur' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as Extract<
      AiChatLine,
      { type: 'step' }
    >
    expect(card.step.proposal!.preview).toMatchObject({
      retention: { last: 7, daily: 30, weekly: 26, monthly: 60 },
    })
    expect(JSON.stringify(card.step.proposal!.payload)).toContain('"Disk"')
    // Review of A4 (M6): confirmed, it is saved as the card showed it.
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const answer = await h.t.app.inject({
      method: 'POST',
      url: `/api/ai/agent/runs/${run}/decide`,
      headers: h.headers,
      payload: { call: card.step.id, decision: 'confirm' },
    })
    expect(answer.json()).toMatchObject({ state: 'done' })
    await stream.ended
    const saved = h.t.app.ctx.backup.schedules.list('local')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ name: 'Weekly', timeZone: 'Europe/Istanbul', retention: { daily: 30 } })
  })

  it('says there is no destination at all, whatever was named', async () => {
    const { once, turn, db } = await agent()
    once([
      {
        name: 'create_backup_schedule',
        args: {
          connection: 'Test',
          database: db,
          name: 'W',
          cadence: '{"kind":"daily","times":["02:00"]}',
          timeZone: 'UTC',
          destinations: ['Made up'],
          format: 'archive',
        },
      },
    ])
    expect(steps(await turn('weekly'))[0]).toMatchObject({ state: 'refused', reason: 'no_destination' })
  })

  // Review of A4 (I1, I2): what the route refuses on save, refused before any card — a gap under an
  // hour, a destination that takes encrypted backups only, personal data unencrypted.
  it('refuses before its card a cadence under an hour apart, and an unencrypted backup the route would refuse', async () => {
    const { h, db, weekly, turn, fake } = await scheduling()
    weekly({ cadence: '{"kind":"daily","times":["02:00","02:30"]}' })
    let out = await turn('twice a night')
    expect(steps(out)[0]).toMatchObject({ state: 'refused', reason: 'cadence_min_gap' })
    expect(conversationOf(fake.requests.at(-1)!.body).results.at(-1)).toMatch(/minutes/)
    weekly({ destinations: ['Sealed'] })
    out = await turn('to Sealed')
    expect(steps(out)[0]).toMatchObject({ state: 'refused', reason: 'encrypted_only' })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'status' }])
    weekly()
    out = await turn('to Disk')
    expect(steps(out)[0]).toMatchObject({ state: 'refused', reason: 'personal_plain' })
    expect(awaitingOf(out)).toBeUndefined()
  })

  it('proposes an encrypted schedule where the person has an active key, not a pending one', async () => {
    const { h, weekly, turn } = await scheduling()
    h.t.app.ctx.backup.keys.create('local')
    weekly({ format: 'mmbak', destinations: ['Sealed'] })
    expect(steps(await turn('encrypted'))[0]).toMatchObject({ state: 'refused', reason: 'key_required' })
    const key = h.t.app.ctx.backup.keys.importKey('local', randomBytes(32))
    h.t.app.ctx.backup.keys.activate('local', key.id)
    weekly({ format: 'mmbak', destinations: ['Sealed'] })
    const stream = await agentTurn(h.t.app, h.headers, { message: 'encrypted' })
    await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')
    stream.stop()
    await stream.ended
  })

  it('refuses where scheduled backups are off', async () => {
    const { weekly, turn } = await scheduling({ schedules: false })
    weekly()
    expect(steps(await turn('weekly'))[0]).toMatchObject({ state: 'refused', reason: 'schedules_off' })
  })

  // Review of A4 (M3): a schedule's zone, left out by the model, is the person's.
  // Third review of A4 (minor 1, 2): a scope of MongoDB's own, or a zone this server does not know,
  // refused as such before its card — never a tool failure, never a route's bare refusal.
  it('refuses a schedule of MongoDB’s own databases, and a time zone this server does not know', async () => {
    const { weekly, turn, fake } = await scheduling()
    for (const format of ['archive', 'mmbak']) {
      weekly({ database: 'admin', format })
      expect(steps(await turn('the admin db'))[0]).toMatchObject({
        state: 'refused',
        reason: 'system_namespace',
      })
    }
    weekly({ timeZone: 'Not/AZone' })
    expect(steps(await turn('weekly'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    expect(conversationOf(fake.requests.at(-1)!.body).results.at(-1)).toMatch(/time zone/i)
  })

  it('refuses a schedule when neither the model nor the turn gives a time zone', async () => {
    const { weekly, turn } = await scheduling()
    weekly({ timeZone: undefined })
    expect(steps(await turn('weekly'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
  })

  it('takes the turn’s time zone where the model gives none', async () => {
    const { h, weekly } = await scheduling()
    weekly({ timeZone: undefined })
    const stream = await agentTurn(h.t.app, h.headers, { message: 'weekly', timeZone: 'Asia/Tokyo' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as Extract<
      AiChatLine,
      { type: 'step' }
    >
    expect(card.step.proposal!.payload).toMatchObject({ timeZone: 'Asia/Tokyo' })
    expect(card.step.proposal!.preview).toMatchObject({ timeZone: 'Asia/Tokyo' })
    stream.stop()
    await stream.ended
  })

  it('refuses an encrypted schedule before its card when the person has no backup key', async () => {
    const { weekly, turn } = await scheduling()
    weekly({ format: 'mmbak' })
    expect(steps(await turn('haftalık yedek kur'))[0]).toMatchObject({
      state: 'refused',
      reason: 'key_required',
    })
  })

  it('refuses one more schedule than the person may have, before its card', async () => {
    const { h, weekly, turn, destination, db } = await scheduling()
    for (let i = 0; i < MAX_SCHEDULES_PER_USER; i++) {
      const made = await h.t.app.inject({
        method: 'POST',
        url: '/api/backup-schedules',
        headers: h.headers,
        payload: {
          name: `S${i}`,
          connectionId: h.connectionId,
          dump: { scope: { kind: 'database', db } },
          format: 'archive',
          cadence: { kind: 'daily', times: ['02:00'] },
          timeZone: 'UTC',
          destinations: [destination],
        },
      })
      expect(made.statusCode).toBe(201)
    }
    weekly()
    expect(steps(await turn('one more'))[0]).toMatchObject({ state: 'refused', reason: 'schedule_limit' })
  })

  it('refuses a schedule with no destination, and a cadence that cannot run, by their reasons', async () => {
    const { weekly, turn, fake } = await scheduling()
    // Review of A4 (M1): destinations exist, none was named — the model is told them, to ask.
    weekly({ destinations: [] })
    expect(steps(await turn('no destination'))[0]).toMatchObject({
      state: 'refused',
      reason: 'destination_needed',
    })
    expect(conversationOf(fake.requests.at(-1)!.body).results.at(-1)).toContain('Disk')
    weekly({ cadence: '{"kind":"cron","expression":"not a cron"}' })
    // The cron's field and code go back, so the model can put it right (never the route's words).
    const out = await turn('bad cadence')
    expect(steps(out)[0]).toMatchObject({ state: 'refused', reason: 'cadence_cron' })
    weekly({ cadence: '{"kind":"cron","expression":"0 0 30 2 *"}' })
    expect(steps(await turn('never'))[0]).toMatchObject({ state: 'refused', reason: 'cadence_never' })
    expect(awaitingOf(out)).toBeUndefined()
  })

  // jobs:run is checked before a card as on confirm, but every role that may use the assistant
  // (editor, admin) has it: defence in depth, no case to test.

  it('is told the person’s time zone, and to use it for times they give', async () => {
    const { fake, turn } = await agent()
    fake.reply(agentReply(() => ({ text: 'ok' })))
    await turn('every Monday at 3', { timeZone: 'Europe/Istanbul' })
    expect(conversationOf(fake.requests[0]!.body).users.at(-1)).toContain('"timeZone":"Europe/Istanbul"')
    expect(agentSystemPrompt('en')).toMatch(/timeZone/)
    // Review of A4 (I4): a zone this server does not know is left out — never a refused turn.
    const other = await agent()
    other.fake.reply(agentReply(() => ({ text: 'ok' })))
    const unknown = await other.inject('POST', 'ai/agent', { message: 'x', timeZone: 'Not/AZone' })
    expect(unknown.statusCode).toBe(200)
    expect(conversationOf(other.fake.requests[0]!.body).users.at(-1)).not.toContain('timeZone')
  })
})

describe('A5: a connection checked, and why not said (design 2026-10-25)', () => {
  const told = (fake: Awaited<ReturnType<typeof agent>>['fake']) => {
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
  }

  it('checks a connection that answers, and opens it as the app does', async () => {
    const { once, turn, fake, h } = await agent()
    once([{ name: 'check_connection', args: { connection: 'Test' } }])
    const out = await turn('is Test up?')
    expect(steps(out)[0]).toMatchObject({
      tool: 'check_connection',
      state: 'done',
      summary: { connected: true },
    })
    expect(told(fake)).toEqual({ connected: true })
    // Opened as the app does: its databases read through the person's own route (the pool open).
    expect(h.t.app.ctx.manager.openNow(h.connectionId, 'local')).toBe(true)
  })

  it('says why a connection cannot be reached by its kind only — never an address or the error’s words', async () => {
    const { once, turn, fake, h } = await agent()
    namedConnection(h.t.app, 1, 'Nowhere', { serverSelectionTimeoutMS: 500 })
    once([{ name: 'check_connection', args: { connection: 'Nowhere' } }])
    const out = await turn('is Nowhere up?')
    const step = steps(out)[0]!
    expect(step).toMatchObject({ tool: 'check_connection', state: 'done', summary: { connected: false } })
    expect(['network', 'timeout', 'dns']).toContain(step.summary!.problem)
    const answer = told(fake)
    expect(Object.keys(answer).sort()).toEqual(['connected', 'problem'])
    expect(JSON.stringify(answer)).not.toMatch(/127\.0\.0\.1|:1\b|ECONNREFUSED/)
  })

  // A5: a read on a connection that cannot be reached says so by its kind (it said "mongo_error").
  it('names the kind of a connection failure a read met', async () => {
    const { once, turn, h } = await agent()
    namedConnection(h.t.app, 1, 'Nowhere', { serverSelectionTimeoutMS: 500 })
    once([{ name: 'list_databases', args: { connection: 'Nowhere' } }])
    const out = await turn('databases of Nowhere?')
    expect(steps(out)[0]!.reason).toMatch(/^connection_(network|timeout|dns)$/)
  })

  // Review of A5 (I2): a refused sign-in is tried once — never again by the model, in the turn or
  // the next, whoever the person (an administrator's re-test is for their own Test button).
  it('tries a refused sign-in once, and keeps the refusal for the reads and turns after', async () => {
    const { once, turn, fake, h } = await agent()
    const test = vi
      .spyOn(h.t.app.ctx.manager, 'test')
      .mockResolvedValue({ ok: false, error: { kind: 'auth', message: 'Authentication failed.' } })
    once([
      { name: 'check_connection', args: { connection: 'Test' } },
      { name: 'check_connection', args: { connection: 'Test' } },
    ])
    const out = await turn('is Test up?')
    expect(steps(out).map((s) => s.summary)).toEqual([
      { connected: false, problem: 'auth' },
      { connected: false, problem: 'auth' },
    ])
    once([{ name: 'check_connection', args: { connection: 'Test' } }])
    await turn('and now?')
    expect(told(fake)).toEqual({ connected: false, problem: 'auth' })
    expect(test).toHaveBeenCalledTimes(1)
    expect(h.t.app.ctx.manager.refusalOf(h.connectionId)?.kind).toBe('auth')
  })

  // Review of A5 (I3): a host key no one has looked at is never taken on by the agent.
  it('never dials an SSH tunnel whose host key is not pinned, for a check or a read', async () => {
    const { once, turn, h } = await agent()
    namedConnection(h.t.app, 1, 'Tunnel', {
      settings: {
        ssh: { enabled: true, host: 'bastion', port: 22, username: 'u', method: 'password', password: 'p' },
      },
    })
    const test = vi.spyOn(h.t.app.ctx.manager, 'test')
    const client = vi.spyOn(h.t.app.ctx.manager, 'getClient')
    once([
      { name: 'check_connection', args: { connection: 'Tunnel' } },
      { name: 'list_databases', args: { connection: 'Tunnel' } },
    ])
    const [check, read] = steps(await turn('is Tunnel up?'))
    expect(check).toMatchObject({ state: 'done', summary: { connected: false, problem: 'ssh-host-key' } })
    expect(read).toMatchObject({ reason: 'connection_ssh-host-key' })
    expect(test).not.toHaveBeenCalled()
    expect(client).not.toHaveBeenCalled()
  })

  // Review of A5 (I1, M3): every failure its own code — none taken for the agent's own refusals.
  it('names a failure it cannot sort, a busy pool and an unsupported server by codes of their own', () => {
    const code = (status: number, body: object) => routeError({ status, body } as never).reason
    expect(code(502, { code: 'MONGO_ERROR', details: { kind: 'unknown' } })).toBe('connection_failed')
    expect(code(503, { code: 'MONGO_ERROR', details: { kind: 'pool' } })).toBe('connection_pool')
    expect(code(422, { code: 'UNSUPPORTED_SERVER', details: { kind: 'unsupported' } })).toBe(
      'connection_unsupported',
    )
    // A reason the route gives goes first (a sign-in, a person's own).
    expect(code(401, { code: 'MONGO_ERROR', details: { kind: 'oidc', reason: 'oidc_sign_in' } })).toBe(
      'oidc_sign_in',
    )
  })

  // Review of A5 (M2): a server that answers but refuses a right is connected — it answered.
  it('says a connection that answers is connected though its databases are not the person’s to list', async () => {
    const { once, turn, fake } = await agent()
    // MongoDB's own refusal of the listing, as a person without the right meets it.
    const listing = vi
      .spyOn(Admin.prototype, 'listDatabases')
      .mockRejectedValue(
        new MongoServerError({ message: 'not authorized on admin', code: 13, codeName: 'Unauthorized' }),
      )
    once([{ name: 'check_connection', args: { connection: 'Test' } }])
    await turn('is Test up?')
    expect(listing).toHaveBeenCalled()
    expect(told(fake)).toEqual({ connected: true })
  })

  // Re-review of A5 (M-d): only a right refused is the server answering; any other failure is not.
  it('says a connection whose listing failed otherwise is not connected', async () => {
    const { once, turn, fake } = await agent()
    vi.spyOn(Admin.prototype, 'listDatabases').mockRejectedValue(
      new MongoServerError({
        message: 'not primary',
        code: 11602,
        codeName: 'InterruptedDueToReplStateChange',
      }),
    )
    once([{ name: 'check_connection', args: { connection: 'Test' } }])
    await turn('is Test up?')
    expect(told(fake)).toMatchObject({ connected: false })
  })

  // Re-review of A5 (M-c, N-a): an edit meanwhile, or a check that never dialled, is not kept.
  it('checks again in the turn after the connection was edited, or when its test was busy', async () => {
    const { once, turn, h } = await agent()
    const answers = [
      { ok: false as const, error: { kind: 'busy' as const, message: 'still running' } },
      { ok: false as const, error: { kind: 'network' as const, message: 'down' } },
      { ok: false as const, error: { kind: 'network' as const, message: 'down' } },
    ]
    const test = vi.spyOn(h.t.app.ctx.manager, 'test').mockImplementation(async () => {
      // The connection edited while its second check ran.
      if (answers.length === 2) {
        h.t.clock.now += 1_000
        h.t.app.ctx.connections.update(h.connectionId, { name: 'Test' })
      }
      return answers.shift()!
    })
    once([
      { name: 'check_connection', args: { connection: 'Test' } },
      { name: 'check_connection', args: { connection: 'Test' } },
      { name: 'check_connection', args: { connection: 'Test' } },
    ])
    const out = await turn('is Test up?')
    expect(steps(out).map((s) => s.summary?.problem)).toEqual(['busy', 'network', 'network'])
    expect(test).toHaveBeenCalledTimes(3)
  })

  // Re-review of A5 (M-a): the app's own lists never dial, so a host key unpinned stops none.
  it('lists the jobs and backups of a tunnel whose host key is not pinned', async () => {
    const { once, turn, h } = await agent()
    namedConnection(h.t.app, 1, 'Tunnel', {
      settings: {
        ssh: { enabled: true, host: 'bastion', port: 22, username: 'u', method: 'password', password: 'p' },
      },
    })
    once([
      { name: 'list_jobs', args: { connection: 'Tunnel' } },
      { name: 'list_backups', args: { connection: 'Tunnel' } },
    ])
    const out = await turn('its jobs and backups?')
    expect(steps(out).map((s) => s.state)).toEqual(['done', 'done'])
  })

  // Spec A5: what the app knows of each connection, told without dialling any.
  // Review of A5 (I2): a connection out of reach is dialled once a turn, however often it is asked.
  it('checks a connection out of reach once a turn', async () => {
    const { once, turn, h } = await agent()
    const test = vi
      .spyOn(h.t.app.ctx.manager, 'test')
      .mockResolvedValue({ ok: false, error: { kind: 'network' as const, message: 'connect ECONNREFUSED' } })
    once([
      { name: 'check_connection', args: { connection: 'Test' } },
      { name: 'check_connection', args: { connection: 'Test' } },
    ])
    const out = await turn('is Test up?')
    expect(steps(out).map((s) => s.summary?.problem)).toEqual(['network', 'network'])
    expect(test).toHaveBeenCalledTimes(1)
  })

  it('never lists a client still opening as open', async () => {
    const { once, turn, fake, h } = await agent()
    const far = namedConnection(h.t.app, 1, 'Far', { serverSelectionTimeoutMS: 20_000 })
    const opening = h.t.app.ctx.manager.getClient(far).catch(() => undefined)
    expect(h.t.app.ctx.manager.isOpen(far)).toBe(true)
    once([{ name: 'list_connections', args: {} }])
    await turn('my connections?')
    const listed = told(fake).connections as Array<{ name: string; open: boolean }>
    expect(listed.find((c) => c.name === 'Far')!.open).toBe(false)
    await h.t.app.ctx.manager.invalidate(far)
    await opening
  })

  it('lists whether each connection is open now, and a refusal kept for it', async () => {
    const { once, turn, fake, h } = await agent()
    const shut = namedConnection(h.t.app, mongo.port, 'Shut')
    const refused = namedConnection(h.t.app, mongo.port, 'Refused')
    h.t.app.ctx.manager.noteRefusal(refused, new ConnectionError('auth', 'Authentication failed.'))
    await h.t.app.ctx.manager.getClient(h.connectionId)
    const client = vi.spyOn(h.t.app.ctx.manager, 'getClient')
    once([{ name: 'list_connections', args: {} }])
    await turn('my connections?')
    const listed = (told(fake).connections as Array<{ name: string; open: boolean; problem?: string }>)
      .sort((x, y) => x.name.localeCompare(y.name))
      .map(({ name, open, problem }) => ({ name, open, problem }))
    expect(listed).toEqual([
      { name: 'Refused', open: false, problem: 'auth' },
      { name: 'Shut', open: false, problem: undefined },
      { name: 'Test', open: true, problem: undefined },
    ])
    expect(client).not.toHaveBeenCalled()
    void shut
  })

  it('is told to check a connection before saying it cannot be reached', () => {
    expect(agentSystemPrompt('en')).toMatch(/check_connection/)
  })
})

// User report 2026-10-25: "AI geçmişinde sohbetin sadece son mesajını görebiliyorum ... ajan bana 3
// adet onay önerisi verdi ... ama AI geçmişinde hiçbir şey göremiyorum": an agent turn's request in
// the AI history keeps what each step did, as its chat keeps it — tools, places and outcomes, never values.
describe('the AI history of an agent turn', () => {
  it('keeps each step: its tool, where, and how it ended — never a value', async () => {
    const { db, inject, once, turn } = await agent()
    once([
      { name: 'list_databases', args: { connection: 'Test' } },
      { name: 'find_documents', args: { connection: 'Test', database: db, collection: 'orders' } },
      { name: 'drop_collection', args: { connection: 'Nowhere', database: db, collection: 'orders' } },
    ])
    await turn('look around')
    const { items } = (await inject('GET', 'ai/history')).json() as {
      items: Array<{ id: string; chatId: string | null }>
    }
    const kept = (await inject('GET', `ai/history/${items[0]!.id}`)).json() as {
      content: { prompt: string; steps?: Array<Record<string, unknown>> }
    }
    expect(kept.content.prompt).toBe('look around')
    expect(kept.content.steps!.map((s) => [s.tool, s.state])).toEqual([
      ['list_databases', 'done'],
      ['find_documents', 'done'],
      ['drop_collection', 'refused'],
    ])
    expect(kept.content.steps![1]).toMatchObject({ namespace: `${db}.orders` })
    // As the chat keeps them: no field but these (no documents, no route's words).
    for (const step of kept.content.steps!)
      for (const key of Object.keys(step))
        expect(['tool', 'connectionId', 'namespace', 'state', 'sent', 'summary', 'reason']).toContain(key)
  })

  const keptOf = async (inject: Awaited<ReturnType<typeof agent>>['inject']) => {
    const { items } = (await inject('GET', 'ai/history')).json() as { items: Array<{ id: string }> }
    return (await inject('GET', `ai/history/${items[0]!.id}`)).json() as {
      content: { steps?: Array<Record<string, unknown>> }
    }
  }

  // Review of the history's steps (I1): a step's connection is among the turn's sources whatever
  // the step's end — so only a teammate who may read it reads the request shared (M4: and why).
  it('keeps a refused step’s connection among the sources, and its reason as a code', async () => {
    const { h, inject, once, turn } = await agent()
    const locked = namedConnection(h.t.app, mongo.port, 'Locked', { readOnly: true })
    once([{ name: 'drop_collection', args: { connection: 'Locked', database: 'hr', collection: 'payroll' } }])
    await turn('drop payroll on Locked')
    const kept = await keptOf(inject)
    expect(kept.content.steps).toEqual([
      {
        tool: 'drop_collection',
        connectionId: locked,
        namespace: 'hr.payroll',
        state: 'refused',
        reason: 'read_only',
      },
    ])
    const db = (h.t.app.ctx.ai.history as unknown as { db: import('node:sqlite').DatabaseSync }).db
    const row = db.prepare('SELECT sources FROM ai_requests').get() as { sources: string }
    expect(JSON.parse(row.sources)).toContain(locked)
  })

  it('keeps where a change refused before it ran was asked, and why', async () => {
    const { h, db, inject, once } = await agent()
    const write = (coll: string) => ({
      name: 'create_collection',
      args: { connection: 'Test', database: db, collection: coll },
    })
    once([write('a1'), write('b1')])
    const stream = await agentTurn(h.t.app, h.headers, { message: 'two' })
    const first = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    await inject('POST', `ai/agent/runs/${run}/decide`, { call: first.step.id, decision: 'decline' })
    await stream.ended
    const kept = await keptOf(inject)
    expect(kept.content.steps).toEqual([
      {
        tool: 'create_collection',
        connectionId: h.connectionId,
        namespace: `${db}.a1`,
        state: 'declined',
        sent: 'outcome',
      },
      {
        tool: 'create_collection',
        connectionId: h.connectionId,
        namespace: `${db}.b1`,
        state: 'refused',
        reason: 'one_change_at_a_time',
      },
    ])
    // Its audit says where too (re-review of the history's steps, M-c).
    const audit = (await inject('GET', 'audit?action=ai.agent.tool')).json() as Array<{
      namespace: string | null
      details: { reason?: string }
    }>
    expect(audit.find((r) => r.details.reason === 'one_change_at_a_time')?.namespace).toBe(`${db}.b1`)
  })

  // Re-review (M-a, M-b): a refused change's place as a tool would read it — names trimmed, a
  // database with no dot, and a connection the agent may still use.
  it('keeps a refused change’s names trimmed, never a dotted database, never a connection gone', async () => {
    const { h, db, inject, once } = await agent()
    const off = namedConnection(h.t.app, mongo.port, 'Off')
    const write = (args: object) => ({ name: 'create_collection', args })
    once([
      write({ connection: 'Test', database: db, collection: 'first' }),
      write({ connection: 'Test', database: `  ${db}  `, collection: '  padded ' }),
      write({ connection: 'Test', database: 'a.b', collection: 'c' }),
      write({ connection: 'Off', database: db, collection: 'x' }),
    ])
    const stream = await agentTurn(h.t.app, h.headers, { message: 'four' })
    const first = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    // Turned off for the agent while the card waits.
    h.t.app.ctx.connections.setAiPolicy(off, 'off')
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    await inject('POST', `ai/agent/runs/${run}/decide`, { call: first.step.id, decision: 'decline' })
    await stream.ended
    const kept = await keptOf(inject)
    expect(kept.content.steps!.slice(1).map((s) => [s.connectionId, s.namespace])).toEqual([
      [h.connectionId, `${db}.padded`],
      [h.connectionId, null],
      [null, null],
    ])
  })

  // M1, M2: a name past a name's bounds is no place; a job's id is the owner's, never kept.
  it('keeps no name past its bounds, nor a job’s id', async () => {
    const { h, inject, once, turn } = await agent()
    once([
      { name: 'collection_stats', args: { connection: 'Test', database: 'x'.repeat(5000), collection: 'c' } },
    ])
    await turn('stats')
    const kept = await keptOf(inject)
    expect(kept.content.steps![0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    expect(JSON.stringify(kept.content.steps![0]).length).toBeLessThan(400)
    // A job's id is the owner's: never kept with the request (a teammate may read it).
    const owner = (h.t.app.ctx.ai.history as unknown as { db: import('node:sqlite').DatabaseSync }).db
      .prepare('SELECT user_id, chat_id FROM ai_requests')
      .get() as { user_id: string | null; chat_id: string }
    h.t.app.ctx.ai.history.record({
      owner: owner.user_id,
      action: 'chat',
      chatId: owner.chat_id,
      connectionId: null,
      namespace: null,
      provider: { id: randomUUID(), name: 'P', kind: 'openai', model: 'm' },
      outcome: 'ok',
      usage: { input: 1, output: 1 },
      ms: 5,
      price: null,
      content: {
        prompt: 'back it up',
        answer: 'Started.',
        steps: [
          {
            tool: 'run_backup',
            connectionId: h.connectionId,
            namespace: 'shop',
            state: 'done',
            summary: { started: true, job: randomUUID(), sendJob: randomUUID() },
          },
          // Final review of wave C (nit 5): a plan kept as the chat keeps it, a backup's job never.
          {
            tool: 'plan_changes',
            connectionId: null,
            namespace: null,
            state: 'done',
            plan: {
              title: 'T'.repeat(300),
              changes: [
                { tool: 'create_collection', about: 'a' },
                { tool: 'drop_collection', about: 'b' },
              ],
            },
          },
          {
            tool: 'drop_collection',
            connectionId: h.connectionId,
            namespace: 'shop.old',
            state: 'done',
            planItem: 1,
            backup: { state: 'done', job: randomUUID() },
          },
        ],
      },
    })
    const latest = await keptOf(inject)
    expect(latest.content.steps![0]!.summary).toEqual({ started: true })
    expect(latest.content.steps![1]!.plan).toEqual({
      title: 'T'.repeat(120),
      changes: [
        { tool: 'create_collection', about: 'a' },
        { tool: 'drop_collection', about: 'b' },
      ],
    })
    expect(latest.content.steps![2]).toMatchObject({ planItem: 1 })
    expect(latest.content.steps![2]).not.toHaveProperty('backup')
  })

  // N1: a request is found by what its steps did, as its reader sees them.
  it('finds a request by a step’s place', async () => {
    const { h, inject, once, turn } = await agent()
    namedConnection(h.t.app, mongo.port, 'Locked', { readOnly: true })
    once([{ name: 'drop_collection', args: { connection: 'Locked', database: 'hr', collection: 'payroll' } }])
    await turn('clean up')
    const found = (await inject('GET', 'ai/history?q=payroll')).json() as { items: unknown[] }
    expect(found.items).toHaveLength(1)
  })
})
