import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import type { AiChatLine, AiChatView, AiHistoryPage, AiHistoryThread } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { openaiReply, startFakeAi } from './support/fake-ai'
import { agentReply } from './support/agent'
import { openStore } from '../src/store/db'
import { MIGRATIONS } from '../src/store/migrations'

/**
 * User reports 2026-10-25: "AI geçmişinde sohbetin sadece son mesajını görebiliyorum" and "aynı
 * konuşmada Ajan modunu aktif edince konuşma bölündü, ikinci AI geçmiş başlattı" — a chat is one entry
 * of the AI history, every turn of it in order (a plain turn, one about a collection, an agent turn);
 * and "ajan modu aktif değilse çalışmıyor" — a turn asking for a change says the agent does it, and a
 * block the answer names a listed collection for goes there.
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
  const db = `ch${randomUUID().slice(0, 8)}`
  await client.db(db).collection('users').insertOne({ name: 'Ada' })
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  expect(
    (
      await inject('POST', 'ai/providers', {
        name: 'Fake',
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
      })
    ).statusCode,
  ).toBeLessThan(300)
  const chatOf = (out: AiChatLine[]) => (out.find((l) => l.type === 'chat') as { id: string }).id
  const done = (out: AiChatLine[]) =>
    out.find((l) => l.type === 'done') as Extract<AiChatLine, { type: 'done' }>
  return { h, fake, db, inject, chatOf, done }
}

describe('a chat in the AI history', () => {
  it('is one entry: a plain turn, one about a collection and an agent turn, in order', async () => {
    const { h, fake, db, inject, chatOf } = await chatting()
    fake.reply(openaiReply('Hello.'))
    const first = lines((await inject('POST', 'ai/chat', { message: 'hello' })).payload)
    const chat = chatOf(first)
    fake.reply(openaiReply('It holds users.'))
    await h.call('POST', `/databases/${db}/collections/users/ai/chat`, { message: 'what is in it?', chat })
    expect((await inject('PUT', 'me/ai-agent', { on: true })).statusCode).toBe(200)
    fake.reply(agentReply(() => ({ text: 'As the agent.' })))
    await inject('POST', 'ai/agent', { message: 'now as the agent', chat })
    const page = (await inject('GET', 'ai/history')).json() as AiHistoryPage
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ action: 'chat', chatId: chat, chain: { steps: 3 } })
    const thread = (
      await inject('GET', `ai/history/threads/${page.items[0]!.thread}`)
    ).json() as AiHistoryThread
    expect(thread.steps.map((s) => s.preview)).toEqual(['hello', 'what is in it?', 'now as the agent'])
  })

  it('never takes another request into a chat, whatever thread the browser names', async () => {
    const { h, fake, inject, chatOf } = await chatting()
    fake.reply(openaiReply('Hello.'))
    const chat = chatOf(lines((await inject('POST', 'ai/chat', { message: 'hello' })).payload))
    h.t.app.ctx.ai.history.record({
      owner: null,
      action: 'query',
      // As the chat's own turn: only what it is keeps it out of the chat.
      connectionId: null,
      namespace: null,
      provider: { id: randomUUID(), name: 'P', kind: 'openai', model: 'm' },
      outcome: 'ok',
      usage: { input: 1, output: 1 },
      ms: 5,
      price: null,
      content: { prompt: 'find', answer: '{}' },
      thread: chat,
    })
    const page = (await inject('GET', 'ai/history')).json() as AiHistoryPage
    expect(page.items.map((i) => i.action).sort()).toEqual(['chat', 'query'])
  })

  it('never lets a request take a chat’s id before the chat’s first turn is kept', async () => {
    const { h, fake, inject } = await chatting()
    const chat = h.t.app.ctx.ai.chats.create(null, 'hello').id
    h.t.app.ctx.ai.history.record({
      owner: null,
      action: 'query',
      connectionId: null,
      namespace: null,
      provider: { id: randomUUID(), name: 'P', kind: 'openai', model: 'm' },
      outcome: 'ok',
      usage: { input: 1, output: 1 },
      ms: 5,
      price: null,
      content: { prompt: 'find', answer: '{}' },
      thread: chat,
    })
    fake.reply(openaiReply('One.'))
    await inject('POST', 'ai/chat', { message: 'one', chat })
    fake.reply(openaiReply('Two.'))
    await inject('POST', 'ai/chat', { message: 'two', chat })
    const page = (await inject('GET', 'ai/history')).json() as AiHistoryPage
    const entry = page.items.find((i) => i.action === 'chat')!
    expect(entry.chain?.steps).toBe(2)
  })

  it('upgrades a store at version 43: a share keyed by a chat itself goes, a turn’s stays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-ai-chats-'))
    closers.push(async () => rmSync(dir, { recursive: true, force: true }))
    const before = await openStore(
      dir,
      MIGRATIONS.filter((m) => m.version <= 43),
    )
    before.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at)
           VALUES ('u1', 'ada', 'x', 'editor', 0, 0)`,
      )
      .run()
    before.db
      .prepare(
        `INSERT INTO ai_requests (id, user_id, at, action, chat_id, thread_id, step, provider_name, provider_kind,
           model, outcome) VALUES ('a1', 'u1', 1, 'chat', 'chatA', 'chatA', 1, 'P', 'openai', 'm', 'ok')`,
      )
      .run()
    // Another user's share whose entry happens to be the same id is theirs, kept (third review, minor 3).
    before.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at)
           VALUES ('u2', 'bob', 'x', 'editor', 0, 0)`,
      )
      .run()
    before.db.prepare(`INSERT INTO ai_request_shares (user_id, entry, at) VALUES ('u2', 'chatA', 5)`).run()
    for (const entry of ['chatA', 'a1'])
      before.db.prepare(`INSERT INTO ai_request_shares (user_id, entry, at) VALUES ('u1', ?, 5)`).run(entry)
    before.close()
    const after = await openStore(dir)
    closers.push(async () => after.close())
    expect(after.db.prepare('SELECT user_id, entry FROM ai_request_shares ORDER BY user_id').all()).toEqual([
      { user_id: 'u1', entry: 'a1' },
      { user_id: 'u2', entry: 'chatA' },
    ])
  })

  it('upgrades a store at version 42: a chat’s kept turns made one entry, a turn shared before still shared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-ai-chats-'))
    closers.push(async () => rmSync(dir, { recursive: true, force: true }))
    const before = await openStore(
      dir,
      MIGRATIONS.filter((m) => m.version <= 42),
    )
    const row = (id: string, chat: string | null, at: number) =>
      before.db
        .prepare(
          `INSERT INTO ai_requests (id, user_id, at, action, chat_id, connection_id, namespace, provider_name,
             provider_kind, model, outcome) VALUES (?, 'u1', ?, ?, ?, NULL, NULL, 'P', 'openai', 'm', 'ok')`,
        )
        .run(id, at, chat ? 'chat' : 'query', chat)
    before.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at)
           VALUES ('u1', 'ada', 'x', 'editor', 0, 0)`,
      )
      .run()
    row('a1', 'chatA', 1)
    row('q1', null, 2)
    row('a2', 'chatA', 3)
    row('b1', 'chatB', 4)
    before.db.prepare(`INSERT INTO ai_request_shares (user_id, entry, at) VALUES ('u1', 'a2', 5)`).run()
    before.db.prepare(`INSERT INTO ai_request_shares (user_id, entry, at) VALUES ('u1', 'q1', 5)`).run()
    before.close()
    const after = await openStore(dir)
    closers.push(async () => after.close())
    expect(after.db.prepare('SELECT id, thread_id, step FROM ai_requests ORDER BY id').all()).toEqual([
      { id: 'a1', thread_id: 'chatA', step: 1 },
      { id: 'a2', thread_id: 'chatA', step: 2 },
      { id: 'b1', thread_id: 'chatB', step: 1 },
      { id: 'q1', thread_id: null, step: null },
    ])
    // A turn is shared on its own (never the whole chat): one shared before stays so.
    expect(after.db.prepare('SELECT entry FROM ai_request_shares ORDER BY entry').all()).toEqual([
      { entry: 'a2' },
      { entry: 'q1' },
    ])
  })
})

describe('a plain turn asked for a change', () => {
  it('says the agent does it — the line kept from the answer — and the chat says so again', async () => {
    const { fake, inject, chatOf, done } = await chatting()
    fake.reply(openaiReply('I cannot add it; the agent can.\n[[agent]]'))
    const out = lines((await inject('POST', 'ai/chat', { message: 'add a user named Gökhan' })).payload)
    expect(done(out)).toMatchObject({ agentAsked: true })
    const view = (await inject('GET', `ai/chats/${chatOf(out)}`)).json() as AiChatView
    const answer = view.messages.find((m) => m.role === 'assistant')!
    expect(answer.text).toBe('I cannot add it; the agent can.')
    expect(view.messages.find((m) => m.role === 'user')!.turn).toMatchObject({ agentAsked: true })
    const page = (await inject('GET', 'ai/history')).json() as AiHistoryPage
    const kept = (await inject('GET', `ai/history/${page.items[0]!.id}`)).json() as {
      content: { answer: string }
    }
    expect(kept.content.answer).not.toContain('[[agent]]')
  })

  // Re-review (M8): the line on a line of its own, as the panel takes it — never the end of a sentence.
  it('takes the line only on a line of its own', async () => {
    const { fake, inject, done } = await chatting()
    fake.reply(openaiReply('Done. [[agent]]'))
    const out = lines((await inject('POST', 'ai/chat', { message: 'x' })).payload)
    expect(done(out).agentAsked).toBeUndefined()
  })

  it('takes the line only at the end of an answer', async () => {
    const { fake, inject, done } = await chatting()
    fake.reply(openaiReply('Write [[agent]] to ask the agent, it says.'))
    const out = lines((await inject('POST', 'ai/chat', { message: 'how?' })).payload)
    expect(done(out).agentAsked).toBeUndefined()
  })

  it('puts a block naming no collection where the answer named one listed (and only one)', async () => {
    const { fake, db, inject, done } = await chatting()
    // Listed from the first turn on (the list is read once a while).
    await client.db(db).collection('other').insertOne({ n: 1 })
    const label = `Test / ${db}.users`
    fake.reply(openaiReply(`The collection: ${label}\n\`\`\`json\n{ "name": "Gökhan" }\n\`\`\``))
    const out = lines((await inject('POST', 'ai/chat', { message: 'find Gökhan in users' })).payload)
    expect(done(out).blocks[0]).toMatchObject({ target: { db, coll: 'users' } })
    // Two named: nowhere (the person asks where).
    fake.reply(openaiReply(`Either ${label} or Test / ${db}.other\n\`\`\`json\n{ "name": "Gökhan" }\n\`\`\``))
    const two = lines((await inject('POST', 'ai/chat', { message: 'find Gökhan' })).payload)
    expect(done(two).blocks[0]!.target).toBeUndefined()
  })

  // Review of the chat entry (M4): a name inside a longer one is that name only where it stands alone.
  it('takes a name inside a longer one for the longer, and both said apart for two', async () => {
    const { fake, db, inject, done } = await chatting()
    await client.db(db).collection('users_old').insertOne({ n: 1 })
    const block = '\n```json\n{ "name": "Gökhan" }\n```'
    fake.reply(openaiReply(`In Test / ${db}.users_old${block}`))
    const longer = lines((await inject('POST', 'ai/chat', { message: 'find' })).payload)
    expect(done(longer).blocks[0]).toMatchObject({ target: { db, coll: 'users_old' } })
    fake.reply(openaiReply(`In Test / ${db}.users or Test / ${db}.users_old${block}`))
    const both = lines((await inject('POST', 'ai/chat', { message: 'find' })).payload)
    expect(done(both).blocks[0]!.target).toBeUndefined()
  })
})
