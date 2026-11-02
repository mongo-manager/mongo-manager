import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiAgentStep, AiChatLine, AiChatView, AiProviderView } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { startFakeAi, statusReply, openaiReply } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf, namedConnection } from './support/agent'
import { EgressError, type EgressRequest } from '../src/net/egress'

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

async function agent(kind: AiProviderView['kind'] = 'openai', over: Record<string, unknown> = {}) {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  const p = (
    await inject('POST', 'ai/providers', {
      name: 'Fake',
      kind,
      baseUrl: kind === 'openai' ? `${fake.url}/v1` : fake.url,
      model: kind === 'gemini' ? 'gemini-3-pro' : 'm',
      ...(kind === 'anthropic' || kind === 'gemini' ? { apiKey: 'k' } : {}),
      ...over,
    })
  ).json() as AiProviderView
  expect((await inject('PUT', 'me/ai-agent', { on: true })).statusCode).toBe(200)
  const decide = (run: string, call: string, body: Record<string, unknown>) =>
    inject('POST', `ai/agent/runs/${run}/decide`, { call, ...body })
  return { fake, h, inject, provider: p, decide }
}
const step = (l: AiChatLine): AiAgentStep | null => (l.type === 'step' ? l.step : null)
const awaiting = (tool: string) => (l: AiChatLine) => step(l)?.tool === tool && step(l)?.state === 'awaiting'
const runOf = (lines: AiChatLine[]) => (lines.find((l) => l.type === 'chat') as { run: string }).run

describe('the agent scenario (W6.3): a collection and a demo user on another connection', () => {
  it('names the connection, proposes each change, writes only after each click, and says so', async () => {
    const { fake, h, decide } = await agent()
    const db = `sales${randomUUID().slice(0, 8)}`
    namedConnection(h.t.app, mongo.port, 'Sales Mongo', { defaultDatabase: db })
    fake.reply(
      agentReply((c) => {
        if (c.results.length === 0) {
          // The connection is named in the request's envelope, its default database too.
          const envelope = c.users.at(-1)!
          const data = JSON.parse(
            envelope.slice(envelope.indexOf('<data>') + 6, envelope.indexOf('</data>')),
          ) as {
            connections: Array<{ name: string; defaultDatabase: string | null }>
          }
          const sales = data.connections.find((x) => x.name === 'Sales Mongo')!
          return {
            text: `I will create users in ${sales.defaultDatabase}, the connection's default database.`,
            calls: [
              {
                name: 'create_collection',
                args: { connection: 'Sales Mongo', database: sales.defaultDatabase, collection: 'users' },
              },
            ],
          }
        }
        if (c.results.length === 1)
          return {
            calls: [
              {
                name: 'insert_documents',
                args: {
                  connection: 'Sales Mongo',
                  database: db,
                  collection: 'users',
                  documents: '[{ "name": "Demo User", "email": "demo@example.com" }]',
                },
              },
            ],
          }
        return { text: 'Done: users was created and a demo user added.' }
      }),
    )
    const turn = await agentTurn(h.t.app, h.headers, {
      message: 'add a new collection named users to the Sales Mongo connection and add a demo user',
    })
    const context = (await turn.waitFor((l) => l.type === 'context')) as Extract<
      AiChatLine,
      { type: 'context' }
    >
    expect(context.agent!.connections.map((c) => c.name).sort()).toEqual(['Sales Mongo', 'Test'])
    expect(context.agent!.connections.find((c) => c.name === 'Sales Mongo')).toEqual({
      name: 'Sales Mongo',
      access: 'admin',
      readOnly: false,
      policy: 'any',
      writes: true,
      defaultDatabase: db,
    })
    const create = step(await turn.waitFor(awaiting('create_collection')))!
    expect(create.place).toMatchObject({ connection: 'Sales Mongo', db, coll: 'users' })
    expect(create.proposal).toMatchObject({
      payload: { kind: 'collection', name: 'users' },
      preview: { databaseExists: false, exists: false },
    })
    // Nothing is written before the click.
    expect(await client.db(db).listCollections({ name: 'users' }).toArray()).toEqual([])
    const run = runOf(turn.lines)
    const created = await decide(run, create.id, { decision: 'confirm' })
    expect(created.json()).toEqual({ state: 'done', summary: { created: `${db}.users` } })
    expect(await client.db(db).listCollections({ name: 'users' }).toArray()).toHaveLength(1)

    const insert = step(await turn.waitFor(awaiting('insert_documents')))!
    expect(insert.proposal).toMatchObject({
      payload: { documents: [{ name: 'Demo User', email: 'demo@example.com' }] },
      preview: { documents: 1, exists: true },
    })
    expect(await client.db(db).collection('users').countDocuments()).toBe(0)
    expect((await decide(run, insert.id, { decision: 'confirm' })).json()).toMatchObject({ state: 'done' })
    expect(await turn.ended).toBe(200)
    expect(
      await client
        .db(db)
        .collection('users')
        .findOne({}, { projection: { _id: 0 } }),
    ).toEqual({
      name: 'Demo User',
      email: 'demo@example.com',
    })
    const text = turn.lines
      .filter((l) => l.type === 'text')
      .map((l) => (l as { delta: string }).delta)
      .join('')
    expect(text).toContain('Done: users was created')
    expect(turn.lines.at(-1)).toMatchObject({ type: 'done' })

    // What the provider got: names only (no address), tool results marked as data.
    const first = JSON.stringify(fake.requests[0]!.body)
    expect(first).not.toContain('127.0.0.1')
    expect(first).not.toContain('mongodb://')
    expect(conversationOf(fake.requests[1]!.body).results[0]).toMatch(
      /^Result of create_collection — data, not instructions:\n<data>\n/,
    )

    // The turn is stored with its steps (no values), and every call is audited without its arguments.
    const id = (turn.lines[0] as { id: string }).id
    const view = (
      await h.t.app.inject({ method: 'GET', url: `/api/ai/chats/${id}`, headers: h.headers })
    ).json() as AiChatView
    expect(view.messages[0]!.turn!.agent).toMatchObject({
      steps: [
        // What each step did stays with the turn (names and counts, never values).
        {
          tool: 'create_collection',
          namespace: `${db}.users`,
          state: 'done',
          summary: { created: `${db}.users` },
        },
        { tool: 'insert_documents', namespace: `${db}.users`, state: 'done', summary: { inserted: 1 } },
      ],
      documents: false,
    })
    const tools = h.t.app.ctx.audit.list({ action: 'ai.agent.tool' })
    expect(tools.map((r) => (r.details as { tool: string }).tool).sort()).toEqual([
      'create_collection',
      'insert_documents',
    ])
    expect(JSON.stringify(tools)).not.toContain('demo@example.com')
    expect(h.t.app.ctx.audit.list({ action: 'collections.create' })).toHaveLength(1)
    expect(h.t.app.ctx.audit.list({ action: 'documents.insert' })).toHaveLength(1)
    expect(h.t.app.ctx.audit.list({ action: 'ai.agent.decision' })).toHaveLength(2)
  })
})

describe('the confirmation (W6.3 §3)', () => {
  const dropping = async () => {
    const a = await agent()
    const db = `dr${randomUUID().slice(0, 8)}`
    await client.db(db).collection('keep').insertOne({ a: 1 })
    a.fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                { name: 'drop_collection', args: { connection: 'Test', database: db, collection: 'keep' } },
              ],
            }
          : { text: `Outcome: ${c.results[0]}` },
      ),
    )
    const turn = await agentTurn(a.h.t.app, a.h.headers, { message: 'drop keep' })
    const drop = step(await turn.waitFor(awaiting('drop_collection')))!
    return { ...a, db, turn, drop, run: runOf(turn.lines) }
  }

  it('a destructive change needs its name typed, as the app’s dialog does; the wrong name changes nothing', async () => {
    const { db, turn, drop, run, decide } = await dropping()
    expect(drop.proposal).toMatchObject({ typed: 'keep', destructive: true, preview: { documents: 1 } })
    const wrong = await decide(run, drop.id, { decision: 'confirm', confirm: 'kee' })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().details).toEqual({ reason: 'typed_name' })
    expect(await client.db(db).listCollections({ name: 'keep' }).toArray()).toHaveLength(1)
    expect((await decide(run, drop.id, { decision: 'confirm', confirm: 'keep' })).json()).toMatchObject({
      state: 'done',
    })
    await turn.ended
    expect(await client.db(db).listCollections({ name: 'keep' }).toArray()).toHaveLength(0)
  })

  it('a declined change writes nothing and the model is told', async () => {
    const { fake, db, turn, drop, run, decide } = await dropping()
    expect((await decide(run, drop.id, { decision: 'decline' })).json()).toEqual({ state: 'declined' })
    await turn.ended
    expect(await client.db(db).listCollections({ name: 'keep' }).toArray()).toHaveLength(1)
    expect(conversationOf(fake.requests[1]!.body).results[0]).toContain('"declined":true')
    expect(step(turn.lines.filter((l) => step(l)?.tool === 'drop_collection').at(-1)!)!.state).toBe(
      'declined',
    )
  })

  it('takes one answer: a second click is refused (no double click)', async () => {
    const { turn, drop, run, decide, h } = await dropping()
    const [a, b] = await Promise.all([
      decide(run, drop.id, { decision: 'confirm', confirm: 'keep' }),
      decide(run, drop.id, { decision: 'confirm', confirm: 'keep' }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect([a, b].find((r) => r.statusCode === 409)!.json().details).toEqual({ reason: 'already_decided' })
    await turn.ended
    // Carried out once.
    expect(h.t.app.ctx.audit.list({ action: 'collections.drop' })).toHaveLength(1)
  })

  it('proposes no drop of a collection or a database that is not there', async () => {
    const { fake, inject } = await agent()
    const db = `nx${randomUUID().slice(0, 8)}`
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                { name: 'drop_collection', args: { connection: 'Test', database: db, collection: 'ghost' } },
                { name: 'drop_database', args: { connection: 'Test', database: db } },
              ],
            }
          : { text: 'ok' },
      ),
    )
    const res = await inject('POST', 'ai/agent', { message: 'drop ghost' })
    const out = res.payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
    const ended = out.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))
    expect(ended.map((s) => [s.tool, s.state, s.reason])).toEqual([
      ['drop_collection', 'refused', 'not_found'],
      ['drop_database', 'refused', 'not_found'],
    ])
  })

  it('shows the person the route’s own words for a refusal, and keeps them neither for the model nor in the record', async () => {
    const { fake, inject, h } = await agent()
    const db = `er${randomUUID().slice(0, 8)}`
    await client.db(db).collection('a').insertOne({ x: 1 })
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                {
                  name: 'count_documents',
                  args: { connection: 'Test', database: db, collection: 'a', filter: '{ "$nope": 1 }' },
                },
              ],
            }
          : { text: 'ok' },
      ),
    )
    const res = await inject('POST', 'ai/agent', { message: 'count' })
    const out = res.payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
    const ended = out.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))
    expect(ended[0]).toMatchObject({
      tool: 'count_documents',
      state: 'error',
      summary: { message: expect.stringMatching(/\$nope/) },
    })
    expect(JSON.stringify(fake.requests[1]!.body)).not.toContain('$nope"')
    const id = (out[0] as { id: string }).id
    const stored = h.t.app.ctx.ai.chats.get(null, id)!.turns[0]!.record.agent!.steps[0]!
    // Its reason as a code (review of the history's steps, M4), never the route's words.
    expect(stored).toEqual({
      tool: 'count_documents',
      connectionId: h.connectionId,
      namespace: `${db}.a`,
      state: 'error',
      reason: 'mongo_error',
    })
    expect(JSON.stringify(stored)).not.toContain('$nope')
  })

  it('stopping the turn cancels the waiting change (nothing written, its answer finds nothing)', async () => {
    const { db, turn, drop, run, decide, h } = await dropping()
    turn.stop()
    for (let i = 0; i < 100 && h.t.app.ctx.ai.chatsRunning.size; i++)
      await new Promise((r) => setTimeout(r, 20))
    const late = await decide(run, drop.id, { decision: 'confirm', confirm: 'keep' })
    expect(late.statusCode).toBe(404)
    expect(await client.db(db).listCollections({ name: 'keep' }).toArray()).toHaveLength(1)
  })
})

// Third review of the connection names (M-2): an agent turn records the connections it was told of
// that its answer names — no source, their policy checked before the turn goes on.
describe('an agent turn naming a connection', () => {
  it('records the connections its answer names, those it used apart', async () => {
    const { fake, h, inject } = await agent()
    const second = namedConnection(h.t.app, mongo.port, 'Second')
    fake.reply(openaiReply('Second has nothing yet; Test has your orders.'))
    const res = await inject('POST', 'ai/agent', { message: 'what is there?' })
    const id = (JSON.parse(res.payload.trim().split('\n')[0]!) as { id: string }).id
    const record = h.t.app.ctx.ai.chats.get(null, id)!.turns[0]!.record
    expect(record.named).toEqual(expect.arrayContaining([second, h.connectionId]))
    expect(record.sources.map((s) => s.connectionId)).not.toContain(second)
  })

  // Fifth review (M4): the person's own words name a connection as much as the answer does.
  it('records a connection the person named, though the answer does not', async () => {
    const { fake, h, inject } = await agent()
    const second = namedConnection(h.t.app, mongo.port, 'Second')
    fake.reply(openaiReply('Nothing to add.'))
    const res = await inject('POST', 'ai/agent', { message: 'what about Second?' })
    const id = (JSON.parse(res.payload.trim().split('\n')[0]!) as { id: string }).id
    expect(h.t.app.ctx.ai.chats.get(null, id)!.turns[0]!.record.named).toEqual([second])
  })

  // Fourth review (I-A): the next turn, its answer naming none, carries what the history named.
  it('carries the connections the history named into the next turn', async () => {
    const { fake, h, inject } = await agent()
    const second = namedConnection(h.t.app, mongo.port, 'Second')
    fake.reply(openaiReply('Second has nothing yet.'))
    const res = await inject('POST', 'ai/agent', { message: 'what is there?' })
    const id = (JSON.parse(res.payload.trim().split('\n')[0]!) as { id: string }).id
    fake.reply(openaiReply('Nothing more.'))
    await inject('POST', 'ai/agent', { chat: id, message: 'and now?' })
    const turns = h.t.app.ctx.ai.chats.get(null, id)!.turns
    expect(turns).toHaveLength(2)
    expect(turns[1]!.record.named).toEqual([second])
  })
})

describe('agent mode and providers (W6.3 §2, §5)', () => {
  it('is refused while agent mode is off; the switch is the person’s own', async () => {
    const { h, inject } = await agent()
    expect((await inject('GET', 'me/ai-agent')).json()).toEqual({
      on: true,
      available: true,
      assistant: true,
      policy: 'full',
    })
    await inject('PUT', 'me/ai-agent', { on: false })
    const res = await inject('POST', 'ai/agent', { message: 'hello' })
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toEqual({ reason: 'agent_off' })
    expect(h.t.app.ctx.ai.chats.list(null)).toEqual([])
  })

  // Eighth review (M2): a local-only connection made while the turn runs is named by the fallback
  // alone — its request kept inside, and a provider found outside refuses it as a chat turn does.
  it('refuses the fallback outside for a local-only connection it names', async () => {
    const { fake, h, inject, provider } = await agent()
    h.t.app.ctx.ai.providers.setLocal(provider.id, true)
    const egress = h.t.app.ctx.ai.egress
    const original = egress.request.bind(egress)
    egress.request = async (r: EgressRequest) => {
      if (r.privateOnly) throw new EgressError('address_refused', 'outside the listed networks')
      return original(r)
    }
    let made = false
    let inside = ''
    fake.reply((res, req) => {
      if (!made)
        inside = namedConnection(h.t.app, 1, 'Inside', { aiPolicy: 'local', serverSelectionTimeoutMS: 500 })
      made = true
      return statusReply(400, '{"error":"m does not support tools"}')(res, req)
    })
    const res = await inject('POST', 'ai/agent', { message: 'and Inside?' })
    const lines = res.payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
    expect(lines.at(-1)).toMatchObject({ type: 'error', reason: 'names_local' })
    expect(h.t.app.ctx.ai.providers.get(provider.id)!.lastLocal).toBe(false)
    // Ninth review: the turn kept says so, and holds the name it would have sent.
    const id = (lines[0] as { id: string }).id
    const record = h.t.app.ctx.ai.chats.get(null, id)!.turns.at(-1)!.record
    expect(record).toMatchObject({ state: 'error', reason: 'names_local', named: [inside] })
  })

  it('falls back to the read-only assistant with a note when the model cannot call tools', async () => {
    const { fake, h, inject } = await agent()
    // A connection whose collections are not listed (nothing there to reach): named all the same.
    namedConnection(h.t.app, 1, 'Empty')
    // A collection the plain answer names (first in order, so within the list).
    const seed = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    await seed.db('aaafallback').collection('orders').insertOne({ a: 1 })
    await seed.close()
    let calls = 0
    fake.reply((res, req) => {
      calls++
      return (req.body as { tools?: unknown }).tools
        ? statusReply(400, '{"error":"m does not support tools"}')(res, req)
        : openaiReply('Here:\n```json\n{ "namespace": "Test / aaafallback.orders", "filter": {} }\n```')(
            res,
            req,
          )
    })
    const res = await inject('POST', 'ai/agent', { message: 'make me a collection' })
    const lines = res.payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
    expect(lines).toContainEqual({ type: 'note', note: 'tools_unsupported' })
    expect(lines.at(-1)).toMatchObject({ type: 'done' })
    expect(calls).toBe(2)
    // Second review (M-3): its block points where it names, as a general turn's does.
    expect(lines.at(-1)).toMatchObject({
      type: 'done',
      blocks: [{ target: { connectionId: h.connectionId, db: 'aaafallback', coll: 'orders' } }],
    })
    // User report 2026-10-24: the plain answer is told the connections by name, collections or not.
    const plain = (fake.requests.at(-1)!.body as { messages: Array<{ content: string }> }).messages.at(
      -1,
    )!.content
    const data = JSON.parse(plain.slice(plain.indexOf('<data>') + 6, plain.indexOf('</data>'))) as {
      connections: string[]
    }
    expect(data.connections).toEqual(expect.arrayContaining(['Empty']))
    // Second review (minor 5, M-3): told the model cannot call tools; what went is said.
    const system = JSON.stringify(fake.requests.at(-1)!.body)
    expect(system).toMatch(/cannot call tools/)
    expect(lines).toContainEqual(
      expect.objectContaining({ type: 'context', connectionNames: expect.any(Number) }),
    )
    // Known from then on: the next turn goes straight to the plain answer.
    await inject('POST', 'ai/agent', { message: 'again' })
    expect(calls).toBe(3)
    // An hour on, the model is asked with tools again (it may have been updated meanwhile).
    h.t.clock.now += 61 * 60_000
    await inject('POST', 'ai/agent', { message: 'and again' })
    expect(calls).toBe(5)
    const id = (lines[0] as { id: string }).id
    expect(h.t.app.ctx.ai.chats.get(null, id)!.turns[0]!.record.agent).toMatchObject({ fallback: true })
  })

  for (const kind of ['anthropic', 'gemini', 'ollama'] as const)
    it(`runs a read tool and carries its result back (${kind})`, async () => {
      const { fake, inject } = await agent(kind)
      fake.reply(
        agentReply((c) =>
          c.results.length === 0
            ? { calls: [{ id: `id-${kind}`, name: 'list_connections', args: {} }] }
            : { text: `Seen: ${c.results[0]!.includes('"Test"') ? 'Test' : 'nothing'}` },
        ),
      )
      const res = await inject('POST', 'ai/agent', { message: 'which connections?' })
      const lines = res.payload
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as AiChatLine)
      expect(
        lines
          .filter((l) => l.type === 'text')
          .map((l) => (l as { delta: string }).delta)
          .join(''),
      ).toContain('Seen: Test')
      expect(lines.find((l) => step(l)?.state === 'done')).toMatchObject({
        step: { tool: 'list_connections', sent: 'names' },
      })
      expect(fake.requests).toHaveLength(2)
    })
})
