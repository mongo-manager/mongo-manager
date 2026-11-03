import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiChatLine, AiChatView, AiProviderView } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { echoReply, openaiReply, startFakeAi } from './support/fake-ai'
import { EgressError, type EgressRequest } from '../src/net/egress'
import { createBlockCache } from '../src/routes/ai-chat'

/** Phase 4a-2 final review: each server finding, first seen failing. */
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

async function chatting() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const db = `cf${randomUUID().slice(0, 8)}`
  await client.db(db).collection('orders').insertOne({ qty: 1, email: 'a@x' })
  const inject = (method: 'GET' | 'POST', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  const provider = (
    await inject('POST', 'ai/providers', { name: 'P', kind: 'openai', baseUrl: `${fake.url}/v1`, model: 'm' })
  ).json() as AiProviderView
  const turn = (payload: object) => h.call('POST', `/databases/${db}/collections/orders/ai/chat`, payload)
  const chat = async (id: string) => (await inject('GET', `ai/chats/${id}`)).json() as AiChatView
  return { h, fake, db, inject, provider, turn, chat }
}

describe('phase 4a-2 final review (server)', () => {
  it('Important 2: keeps what the history left out with the turn (counts, never content)', async () => {
    const { h, fake, db, turn, chat } = await chatting()
    fake.reply(openaiReply('one'))
    const id = (lines((await turn({ message: 'first' })).payload)[0] as { id: string }).id
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'email' }])
    fake.reply(echoReply())
    await turn({ chat: id, message: 'second' })
    const view = await chat(id)
    expect(view.messages[2]!.turn).toMatchObject({ history: { sent: 0, leftOut: ['history:rules:1'] } })
  })

  it('Important 2: names the stored turn in its first line, so the panel can keep what was sent beside it', async () => {
    const { fake, turn, chat } = await chatting()
    fake.reply(openaiReply('one'))
    const first = lines((await turn({ message: 'first' })).payload)[0] as { id: string; turn: string }
    expect(first.turn).toMatch(/^[0-9a-f-]{36}$/)
    expect((await chat(first.id)).messages[0]!.id).toBe(first.turn)
  })

  it('Minor 6: a local-only history with a provider never used says why, and learns the provider is outside', async () => {
    const { h, fake, provider, turn, inject } = await chatting()
    h.t.app.ctx.connections.setAiPolicy(h.connectionId, 'local')
    fake.reply(openaiReply('local answer'))
    const id = (lines((await turn({ message: 'local question' })).payload)[0] as { id: string }).id
    // Never used from here on; the next request would land outside the listed networks.
    h.t.app.ctx.store.db.prepare('UPDATE ai_providers SET last_local = NULL WHERE id = ?').run(provider.id)
    const egress = h.t.app.ctx.ai.egress
    const original = egress.request.bind(egress)
    egress.request = async (r: EgressRequest) => {
      if (r.privateOnly) throw new EgressError('address_refused', 'outside the listed networks')
      return original(r)
    }
    const out = lines((await inject('POST', 'ai/chat', { chat: id, message: 'general now' })).payload)
    expect(out.at(-1)).toMatchObject({ type: 'error', reason: 'history_local', nothingSent: true })
    expect(h.t.app.ctx.ai.providers.get(provider.id)!.lastLocal).toBe(false)
    fake.reply(openaiReply('fine'))
    const again = lines(
      (await inject('POST', 'ai/chat', { chat: id, message: 'general now', retry: true })).payload,
    )
    expect(again[1]).toMatchObject({ history: { leftOut: ['history:local:1'] } })
    expect(again.at(-1)).toMatchObject({ type: 'done' })
  })

  it('Minor 10: reads an answer’s blocks once, and forgets the oldest beyond its size', () => {
    let parsed = 0
    const blocksOf = createBlockCache(2, (text) => {
      parsed++
      return text ? [] : []
    })
    const a = blocksOf('m1', 'x', false)
    expect(blocksOf('m1', 'x', false)).toBe(a)
    expect(parsed).toBe(1)
    blocksOf('m1', 'x', true)
    blocksOf('m2', 'y', false)
    expect(parsed).toBe(3)
    blocksOf('m1', 'x', false)
    expect(parsed).toBe(4)
  })
})
