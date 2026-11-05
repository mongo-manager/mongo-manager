// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MongoClient } from 'mongodb'
import type { AiChatLine, AiChatSummary, AiChatView, AiProviderView } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { echoReply, openaiReply, startFakeAi, statusReply } from './support/fake-ai'

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
    .map((l) => JSON.parse(l) as AiChatLine)
const textOf = (out: AiChatLine[]) =>
  out
    .filter((l) => l.type === 'text')
    .map((l) => (l as { delta: string }).delta)
    .join('')
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 20))
  expect(ok()).toBe(true)
}

async function chatting() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const db = `ch${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([
      { qty: 1, email: 'a@x' },
      { qty: 9, email: 'b@x' },
    ])
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  const provider = async (over: Record<string, unknown> = {}) =>
    (
      await inject('POST', 'ai/providers', {
        name: `P${randomUUID().slice(0, 4)}`,
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
        ...over,
      })
    ).json() as AiProviderView
  const turn = (payload: object, coll = 'orders') =>
    h.call('POST', `/databases/${db}/collections/${coll}/ai/chat`, payload)
  const general = (payload: object) => inject('POST', 'ai/chat', payload)
  const chat = async (id: string) => (await inject('GET', `ai/chats/${id}`)).json() as AiChatView
  return { h, fake, db, inject, provider, turn, general, chat }
}

describe('a chat turn (phase 4a-2 spec §1.2, §2.5)', () => {
  it('streams the chat, what was sent, the text and the blocks; stores the turn sealed; audits without content', async () => {
    const { h, fake, db, inject, provider, turn, chat } = await chatting()
    await provider()
    fake.reply(
      openaiReply('Big ones:\n```json\n{ "filter": { "qty": { "$gt": 5 } } }\n```', { input: 50, output: 9 }),
    )
    const res = await turn({ message: 'orders over five', language: 'en' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    const out = lines(res.payload)
    const id = (out[0] as { id: string }).id
    expect(out[0]).toEqual({ type: 'chat', id, title: 'orders over five', turn: expect.any(String) })
    expect(out[1]).toMatchObject({
      type: 'context',
      sent: { namespace: `${db}.orders`, indexes: expect.any(Array), validator: null },
      provider: { kind: 'openai', model: 'm' },
      history: { sent: 0, leftOut: [] },
    })
    expect(textOf(out)).toMatch(/Big ones/)
    expect(out.at(-1)).toEqual({
      type: 'done',
      blocks: [
        { index: 0, result: { kind: 'query', filter: { qty: { $gt: { $numberInt: '5' } } } }, warnings: [] },
      ],
      usage: { input: 50, output: 9 },
      local: true,
    })
    const list = (await inject('GET', 'ai/chats')).json() as AiChatSummary[]
    expect(list).toEqual([
      {
        id,
        title: 'orders over five',
        namespace: `${db}.orders`,
        messages: 2,
        updatedAt: expect.any(Number),
      },
    ])
    const view = await chat(id)
    expect(view.full).toBe(false)
    expect(view.messages[0]).toMatchObject({
      role: 'user',
      text: 'orders over five',
      turn: {
        connectionId: h.connectionId,
        namespace: `${db}.orders`,
        parts: { schema: true, current: false, indexes: true, validator: false, samples: 0 },
        state: 'done',
        usage: { input: 50, output: 9 },
      },
    })
    expect(view.messages[1]).toMatchObject({
      role: 'assistant',
      blocks: [{ index: 0, result: { kind: 'query' } }],
    })
    const row = h.t.app.ctx.audit.list({ action: 'ai.chat' }).at(0)!
    expect(row).toMatchObject({ outcome: 'success', namespace: `${db}.orders` })
    expect(row.details).toMatchObject({
      chat: id,
      kind: 'openai',
      local: true,
      history: 0,
      input: 50,
      output: 9,
      outcome: 'ok',
    })
    expect(JSON.stringify(row)).not.toContain('orders over five')
    expect(JSON.stringify(row)).not.toContain('Big ones')
    expect(h.t.app.ctx.ai.metrics.requests.get('chat|ok')).toBe(1)
  })

  it('sends the earlier turns with the new one, the data envelope on the latest only', async () => {
    const { fake, db, provider, turn } = await chatting()
    await provider()
    fake.reply(openaiReply('First answer.'))
    const first = lines((await turn({ message: 'what is here?' })).payload)
    const id = (first[0] as { id: string }).id
    fake.reply(echoReply())
    const second = lines((await turn({ chat: id, message: 'and the big ones?' })).payload)
    expect(second[1]).toMatchObject({ history: { sent: 1, leftOut: [] } })
    expect(textOf(second)).toBe('4 messages: system,user,assistant,user')
    const sent = (fake.requests.at(-1)!.body as { messages: Array<{ role: string; content: string }> })
      .messages
    expect(sent[1]!.content).toBe(`[About ${db}.orders]\nwhat is here?`)
    expect(sent[2]!.content).toBe('First answer.')
    expect(sent[1]!.content).not.toContain('<data>')
    expect(sent[3]!.content.match(/<data>/g)).toHaveLength(1)
  })

  it('keeps in the AI history every connection a general follow-up drew on (share review C1)', async () => {
    const { h, fake, provider, turn, general } = await chatting()
    await provider()
    fake.reply(openaiReply('Two orders.'))
    const id = (lines((await turn({ message: 'what is here?' })).payload)[0] as { id: string }).id
    fake.reply(openaiReply('Their emails are…'))
    await general({ chat: id, message: 'and their emails?' })
    const db = (h.t.app.ctx.ai.history as unknown as { db: import('node:sqlite').DatabaseSync }).db
    const rows = db
      .prepare(
        "SELECT connection_id, sources, credential FROM ai_requests WHERE action = 'chat' ORDER BY rowid",
      )
      .all() as Array<{ connection_id: string | null; sources: string; credential: number }>
    expect(rows.map((r) => [r.connection_id, JSON.parse(r.sources), r.credential])).toEqual([
      [h.connectionId, [h.connectionId], 0],
      // No connection of its own, yet its answer drew on the first turn's.
      [null, [h.connectionId], 0],
    ])
  })

  it('answers a general turn without any data — collection names aside (user request 2026-10-10)', async () => {
    const { h, fake, db, provider, general, chat } = await chatting()
    await provider()
    fake.reply(openaiReply('An index is…'))
    const out = lines((await general({ message: 'What is an index?' })).payload)
    expect(out[1]).toMatchObject({ type: 'context', sent: null })
    // Its envelope holds collection names only: never a document's value.
    const body = JSON.stringify((fake.requests.at(-1)!.body as { messages: unknown[] }).messages.slice(1))
    expect(body).toContain('[General]')
    expect(body).toContain(`${db}.orders`)
    expect(body).not.toContain('a@x')
    const view = await chat((out[0] as { id: string }).id)
    // Review I1: the connection whose names went is the turn's source, as history weighs it.
    expect(view.messages[0]!.turn).toMatchObject({
      connectionId: null,
      namespace: null,
      rulesVersion: null,
      sources: [{ connectionId: h.connectionId, rulesVersion: expect.any(Number) }],
    })
  })

  it('carries the parts asked for: the current query and the validator', async () => {
    const { fake, provider, turn } = await chatting()
    await provider()
    fake.reply(openaiReply('ok'))
    const out = lines(
      (
        await turn({
          message: 'why?',
          parts: { current: true, indexes: false, validator: true },
          current: { filter: { qty: { $numberInt: '9' } } },
        })
      ).payload,
    )
    expect(out[1]).toMatchObject({ sent: { indexes: null, current: expect.stringContaining('qty') } })
    // Without the part, the current query is not sent even when the body carries one.
    const without = lines(
      (await turn({ message: 'why?', current: { filter: { qty: { $numberInt: '9' } } } })).payload,
    )
    expect(without[1]).toMatchObject({ sent: { current: null } })
  })

  it('refuses before anything is stored or sent', async () => {
    const { h, fake, inject, provider, turn } = await chatting()
    expect((await turn({ message: 'x' })).json()).toMatchObject({ details: { reason: 'no_provider' } })
    await provider({ samples: false })
    expect((await turn({ message: 'x', samples: { count: 1 } })).json()).toMatchObject({
      details: { reason: 'samples_refused' },
    })
    expect((await turn({ message: 'x', retry: true })).json()).toMatchObject({
      details: { reason: 'nothing_to_retry' },
    })
    expect((await turn({ message: 'x', chat: randomUUID() })).statusCode).toBe(404)
    expect((await turn({ message: 'x' }, 'system.users')).statusCode).toBe(403)
    expect((await inject('GET', 'ai/chats')).json()).toEqual([])
    expect(fake.requests).toHaveLength(0)
    const refused = h.t.app.ctx.audit.list({ action: 'ai.chat' })
    expect(refused.length).toBeGreaterThanOrEqual(4)
    expect(refused.every((r) => r.outcome !== 'success')).toBe(true)
  })

  it('refuses a second turn while the chat answers', async () => {
    const { fake, provider, turn, chat } = await chatting()
    await provider()
    fake.reply(openaiReply('one'))
    const id = (lines((await turn({ message: 'first' })).payload)[0] as { id: string }).id
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    fake.reply(async (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      await gate
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'late' } }] })}\n\ndata: [DONE]\n\n`)
    })
    const before = fake.requests.length
    const slow = turn({ chat: id, message: 'second' })
    await until(() => fake.requests.length === before + 1)
    const busy = await turn({ chat: id, message: 'third' })
    expect([busy.statusCode, busy.json().details]).toEqual([409, { reason: 'chat_busy' }])
    release()
    expect(textOf(lines((await slow).payload))).toBe('late')
    expect((await chat(id)).messages.map((m) => m.text)).toEqual(['first', 'one', 'second', 'late'])
  })

  it('keeps a stopped turn when the client goes away and frees the chat', async () => {
    const { h, fake, db, provider, turn, chat } = await chatting()
    await provider()
    fake.reply(openaiReply('one'))
    const id = (lines((await turn({ message: 'first' })).payload)[0] as { id: string }).id
    let closed = false
    fake.reply(async (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Thinking…' } }] })}\n\n`)
      res.once('close', () => void (closed = true))
    })
    await h.t.app.listen({ port: 0, host: '127.0.0.1' })
    const port = (h.t.app.server.address() as AddressInfo).port
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/api/connections/${h.connectionId}/databases/${db}/collections/orders/ai/chat`,
      headers: {
        ...h.headers,
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
        'content-type': 'application/json',
      },
    })
    const text = new Promise<void>((resolve) =>
      req.on('response', (res) =>
        res.on('data', (c: Buffer) => c.toString().includes('Thinking') && resolve()),
      ),
    )
    req.end(JSON.stringify({ chat: id, message: 'second' }))
    await text
    req.destroy()
    await until(() => closed)
    await until(() => h.t.app.ctx.ai.chatsRunning.size === 0)
    expect(h.t.app.ctx.ai.limits.running('local')).toBe(0)
    const view = await chat(id)
    expect(view.messages.at(-1)!.text).toBe('Thinking…')
    expect(view.messages.at(-2)!.turn).toMatchObject({ state: 'stopped', reason: 'aborted' })
    expect(h.t.app.ctx.audit.list({ action: 'ai.chat' }).at(0)!.details).toMatchObject({ outcome: 'aborted' })
    fake.reply(openaiReply('three'))
    expect(textOf(lines((await turn({ chat: id, message: 'again' })).payload))).toBe('three')
  })

  it('keeps "nothing left the server" with a turn refused before sending', async () => {
    const { provider, turn, chat } = await chatting()
    // Not a listed network: refused where the socket would connect, before anything is written.
    await provider({ kind: 'anthropic', baseUrl: 'https://10.255.255.1', apiKey: 'k' })
    const out = lines((await turn({ message: 'x' })).payload)
    expect(out.at(-1)).toMatchObject({ type: 'error', reason: 'address_refused', nothingSent: true })
    const view = await chat((out[0] as { id: string }).id)
    expect(view.messages[0]!.turn).toMatchObject({
      state: 'error',
      reason: 'address_refused',
      nothingSent: true,
    })
  })

  it('tries a failed turn again in its place', async () => {
    const { fake, provider, turn, chat } = await chatting()
    await provider()
    fake.reply(openaiReply('one'))
    const id = (lines((await turn({ message: 'first' })).payload)[0] as { id: string }).id
    fake.reply(statusReply(500, '{"error":"boom"}'))
    expect(lines((await turn({ chat: id, message: 'second' })).payload).at(-1)).toMatchObject({
      type: 'error',
      reason: 'provider_error',
    })
    expect((await chat(id)).messages.at(-2)!.turn).toMatchObject({ state: 'error', reason: 'provider_error' })
    fake.reply(openaiReply('two'))
    await turn({ chat: id, message: 'second', retry: true })
    expect((await chat(id)).messages.map((m) => m.text)).toEqual(['first', 'one', 'second', 'two'])
    expect((await turn({ chat: id, message: 'x', retry: true })).json()).toMatchObject({
      details: { reason: 'nothing_to_retry' },
    })
  })

  it('leaves out a turn whose rules changed, and says so', async () => {
    const { h, fake, db, provider, turn } = await chatting()
    await provider()
    fake.reply(openaiReply('one'))
    const id = (lines((await turn({ message: 'first' })).payload)[0] as { id: string }).id
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'email' }])
    fake.reply(echoReply())
    const out = lines((await turn({ chat: id, message: 'second' })).payload)
    expect(out[1]).toMatchObject({ history: { sent: 0, leftOut: ['history:rules:1'] } })
    expect(textOf(out)).toBe('2 messages: system,user')
  })

  it('refuses the 101st turn of a chat', async () => {
    const { h, fake, provider, turn } = await chatting()
    await provider()
    fake.reply(openaiReply('x'))
    const id = (lines((await turn({ message: 'first' })).payload)[0] as { id: string }).id
    const record = h.t.app.ctx.ai.chats.get(null, id)!.turns[0]!.record
    for (let i = 1; i < 100; i++) h.t.app.ctx.ai.chats.append(null, id, { user: 'q', answer: 'a', record })
    expect((await turn({ chat: id, message: 'one more' })).json()).toMatchObject({
      details: { reason: 'chat_full' },
    })
  })

  it('renames, deletes one and deletes all; deletions are audited', async () => {
    const { h, fake, inject, provider, general } = await chatting()
    await provider()
    fake.reply(openaiReply('x'))
    const a = (lines((await general({ message: 'a' })).payload)[0] as { id: string }).id
    await general({ message: 'b' })
    expect((await inject('PATCH', `ai/chats/${a}`, { title: ' Renamed ' })).json()).toEqual({
      id: a,
      title: 'Renamed',
    })
    expect((await inject('PATCH', `ai/chats/${a}`, { title: '' })).statusCode).toBe(400)
    expect((await inject('DELETE', `ai/chats/${a}`)).statusCode).toBe(204)
    expect((await inject('DELETE', `ai/chats/${a}`)).statusCode).toBe(404)
    expect((await inject('DELETE', 'ai/chats')).json()).toEqual({ removed: 1 })
    expect((await inject('GET', 'ai/chats')).json()).toEqual([])
    const rows = h.t.app.ctx.audit.list({ action: 'ai.chat.delete' })
    expect(rows.map((r) => r.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chat: a, count: 1 }),
        expect.objectContaining({ all: true, count: 1 }),
      ]),
    )
  })
})
