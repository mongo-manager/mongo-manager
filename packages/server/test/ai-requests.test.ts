import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type {
  AiHistoryItem,
  AiHistoryPage,
  AiHistorySettings,
  AiHistoryThread,
  AiProviderView,
  AiUsage,
} from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'
import { openaiReply, startFakeAi } from './support/fake-ai'
import { H } from './helpers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { rotateSecretKey } from '../src/crypto/rotate'
import { AiHistoryRepo, aiRequestContext } from '../src/ai/requests'
import { SettingsRepo } from '../src/store/settings'

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

/** A local-mode server with a provider priced at 3 USD / 15 USD per million tokens. */
async function local(overrides: Parameters<typeof dataHarness>[1] = {}) {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo, overrides)
  closers.push(h.t.close)
  const db = `hi${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([{ qty: 1 }, { qty: 9 }])
  const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  const provider = (
    await api('POST', 'ai/providers', {
      name: 'Priced',
      kind: 'openai',
      baseUrl: `${fake.url}/v1`,
      model: 'gpt-test',
      price: { input: 3, output: 15, currency: 'USD' },
    })
  ).json() as AiProviderView
  const ask = (prompt: string) =>
    h.call('POST', `/databases/${db}/collections/orders/ai`, { action: 'query', prompt, language: 'en' })
  return { fake, h, db, api, provider, ask }
}
const page = async (api: Awaited<ReturnType<typeof local>>['api'], query = '') =>
  (await api('GET', `ai/history${query}`)).json() as AiHistoryPage

describe('AI history (user, 2026-10-09: "AI yaptırdığımız işleri nerde görüyoruz")', () => {
  it('records each request: what was asked, the answer, the tokens, the time and the cost', async () => {
    const { fake, api, provider, ask, db } = await local()
    expect(provider.price).toEqual({ input: 3, output: 15, currency: 'USD' })
    fake.reply(
      openaiReply('Big:\n```json\n{ filter: { qty: { $gt: 5 } } }\n```', {
        input: 1_000_000,
        output: 200_000,
      }),
    )
    await ask('orders over five')
    const { items } = await page(api)
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item).toMatchObject({
      action: 'query',
      namespace: `${db}.orders`,
      provider: { name: 'Priced', kind: 'openai', model: 'gpt-test' },
      outcome: 'ok',
      usage: { input: 1_000_000, output: 200_000 },
      // 1M × 3 + 0.2M × 15 = 6 USD.
      cost: { amount: 6, currency: 'USD' },
      preview: 'orders over five',
    })
    expect(item.ms).toBeGreaterThanOrEqual(0)
    const full = (await api('GET', `ai/history/${item.id}`)).json() as AiHistoryItem
    expect(full.content).toMatchObject({
      prompt: 'orders over five',
      answer: expect.stringContaining('Big:'),
      result: { kind: 'query' },
      sent: { namespace: `${db}.orders` },
    })
  })

  it('answers and audits the request even when the history cannot keep it', async () => {
    const { fake, h, ask } = await local()
    h.t.app.ctx.ai.history.record = () => {
      throw new Error('disk full')
    }
    fake.reply(openaiReply('still answered'))
    const res = await ask('kept nowhere')
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('"type":"done"')
    expect(h.t.app.ctx.audit.list({ action: 'ai.request' })).toHaveLength(1)
  })

  it('records a failure with its reason, and no cost without a price', async () => {
    const { fake, api, ask, h } = await local()
    await api('POST', 'ai/providers', {
      name: 'Free',
      kind: 'openai',
      baseUrl: `${fake.url}/v1`,
      model: 'm',
      isDefault: true,
    })
    fake.reply((res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"bad key"}}')
    })
    await ask('anything')
    const [item] = (await page(api)).items
    expect(item).toMatchObject({ outcome: 'key_refused', cost: null, provider: { name: 'Free' } })
    expect(h.t.app.ctx.audit.list({ action: 'ai.request' })).toHaveLength(1)
  })

  it('keeps what was asked and answered sealed at rest', async () => {
    const { fake, h, ask } = await local()
    fake.reply(openaiReply('The secret answer'))
    await ask('a very private question')
    const rows = JSON.stringify(h.t.app.ctx.store.db.prepare('SELECT * FROM ai_requests').all())
    expect(rows).not.toContain('a very private question')
    expect(rows).not.toContain('The secret answer')
  })

  it('pages newest first, filters by action and outcome, searches the words, and deletes', async () => {
    const { fake, api, ask } = await local()
    for (const w of ['first one', 'second one', 'third one']) {
      fake.reply(openaiReply('ok\n```json\n{ filter: {} }\n```'))
      await ask(w)
    }
    const all = await page(api, '?limit=2')
    expect(all.items.map((i) => i.preview)).toEqual(['third one', 'second one'])
    const next = await page(api, `?limit=2&before=${encodeURIComponent(all.next!)}`)
    expect(next.items.map((i) => i.preview)).toEqual(['first one'])
    expect((await page(api, '?q=SECOND')).items.map((i) => i.preview)).toEqual(['second one'])
    expect((await page(api, '?action=pipeline')).items).toEqual([])
    expect((await page(api, '?outcome=failed')).items).toEqual([])
    const id = all.items[0]!.id
    expect((await api('DELETE', `ai/history/${id}`)).statusCode).toBe(204)
    expect((await page(api)).items).toHaveLength(2)
    expect((await api('DELETE', 'ai/history')).statusCode).toBe(204)
    expect((await page(api)).items).toEqual([])
  })

  it('counts a "needs a pipeline" answer as answered, not failed', async () => {
    const { fake, api, ask } = await local()
    fake.reply(openaiReply('This needs the customers collection.\n```json\n{ "needsPipeline": true }\n```'))
    await ask('who paid')
    expect((await page(api, '?outcome=failed')).items).toEqual([])
    expect((await page(api, '?outcome=ok')).items).toEqual([
      expect.objectContaining({ outcome: 'needs_pipeline' }),
    ])
  })

  it('sums the usage and the cost by model', async () => {
    const { fake, api, ask } = await local()
    for (let i = 0; i < 2; i++) {
      fake.reply(openaiReply('ok', { input: 500_000, output: 100_000 }))
      await ask(`q${i}`)
    }
    const usage = (await api('GET', 'ai/usage?days=30')).json() as AiUsage
    expect(usage.totals).toMatchObject({ requests: 2, input: 1_000_000, output: 200_000 })
    expect(usage.totals.cost).toEqual([{ amount: 6, currency: 'USD' }])
    expect(usage.byModel).toEqual([
      expect.objectContaining({
        provider: 'Priced',
        model: 'gpt-test',
        requests: 2,
        input: 1_000_000,
        output: 200_000,
      }),
    ])
  })

  it('records a chat turn too, linked to its chat', async () => {
    const { fake, h, db, api } = await local()
    fake.reply(openaiReply('Chat answer'))
    const res = await h.call('POST', `/databases/${db}/collections/orders/ai/chat`, {
      message: 'hello chat',
      language: 'en',
    })
    const chatId = (JSON.parse(res.payload.split('\n')[0]!) as { id: string }).id
    const [item] = (await page(api)).items
    expect(item).toMatchObject({ action: 'chat', chatId, preview: 'hello chat' })
  })

  it('keeps no chat words on disk when chats are kept in memory only (MM_AI_CHAT_DAYS=0)', async () => {
    const { fake, h, db, api } = await local({ ai: { chatDays: 0 } } as never)
    fake.reply(openaiReply('Secret chat answer'))
    await h.call('POST', `/databases/${db}/collections/orders/ai/chat`, {
      message: 'memory only',
      language: 'en',
    })
    const [item] = (await page(api)).items
    // The usage still counts; the words never reach the database.
    expect(item).toMatchObject({ action: 'chat', preview: null })
    expect(item!.usage.input).toBeGreaterThan(0)
    expect((await api('GET', `ai/history/${item!.id}`)).json()).toMatchObject({ content: null })
    const raw = h.t.app.ctx.store.db.prepare('SELECT content FROM ai_requests').all() as Array<{
      content: unknown
    }>
    expect(raw).toEqual([{ content: null }])
  })
})

describe('AI history settings (user: "90 gün, ayarlardan değiştirilebilsin")', () => {
  it('keeps 90 days by default; an administrator changes it, and may keep no content', async () => {
    const { fake, api, ask, h } = await local()
    expect((await api('GET', 'ai/history/settings')).json()).toEqual({ days: 90, keepContent: true })
    expect((await api('PUT', 'ai/history/settings', { days: 0, keepContent: true })).statusCode).toBe(400)
    expect((await api('PUT', 'ai/history/settings', { days: 4000, keepContent: true })).statusCode).toBe(400)
    const saved = (
      await api('PUT', 'ai/history/settings', { days: 30, keepContent: false })
    ).json() as AiHistorySettings
    expect(saved).toEqual({ days: 30, keepContent: false })
    fake.reply(openaiReply('answer', { input: 10, output: 5 }))
    await ask('not kept')
    const [item] = (await page(api)).items
    expect(item).toMatchObject({ usage: { input: 10, output: 5 }, preview: null })
    expect(((await api('GET', `ai/history/${item!.id}`)).json() as AiHistoryItem).content).toBeNull()
    // The two refused changes are audited as failures; the one kept as a success.
    expect(
      h.t.app.ctx.audit.list({ action: 'ai.history.settings' }).filter((r) => r.outcome === 'success'),
    ).toHaveLength(1)
  })

  it('removes what is older than the days kept', async () => {
    const { fake, api, ask, h } = await local()
    fake.reply(openaiReply('old'))
    await ask('an old one')
    h.t.app.ctx.store.db.prepare('UPDATE ai_requests SET at = at - ?').run(91 * 86_400_000)
    fake.reply(openaiReply('new'))
    await ask('a new one')
    expect(h.t.app.ctx.ai.history.sweep()).toBe(1)
    expect((await page(api)).items.map((i) => i.preview)).toEqual(['a new one'])
  })
})

describe('AI history, abuse cases', () => {
  async function team() {
    const fake = await startFakeAi()
    closers.push(fake.close)
    // Team mode reaches a provider on this machine only when the networks list it.
    const h = await teamHarness(mongo, { ai: { privateNetworks: ['127.0.0.1/32'] } } as never)
    closers.push(h.t.close)
    const db = `ht${randomUUID().slice(0, 8)}`
    await client.db(db).collection('orders').insertOne({ qty: 1 })
    const { ctx } = h.t.app
    const as = (role: 'admin' | 'editor' | 'viewer') => {
      const user = ctx.users.create({
        username: `u-${role}-${randomUUID().slice(0, 6)}`,
        passwordHash: 'x',
        role,
      })
      const { sessionId, session } = ctx.sessions.create(user.id, {})
      const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
        h.t.app.inject({
          method,
          url: `/api/${url}`,
          headers: { ...H, 'x-csrf-token': session.csrfToken },
          cookies: { mm_sid: sessionId },
          ...(payload ? { payload } : {}),
        })
      return { id: user.id, call }
    }
    const admin = as('admin')
    await admin.call('POST', 'ai/providers', {
      name: 'P',
      kind: 'openai',
      baseUrl: `${fake.url}/v1`,
      model: 'm',
    })
    return { fake, h, db, as, admin }
  }

  it('shows content to its owner only — never to another user, nor to an administrator', async () => {
    const { fake, h, db, as, admin } = await team()
    const ada = as('editor')
    const bob = as('editor')
    fake.reply(openaiReply('ada answer', { input: 7, output: 3 }))
    await ada.call('POST', `connections/${h.connectionId}/databases/${db}/collections/orders/ai`, {
      action: 'query',
      prompt: 'ada private words',
      language: 'en',
    })
    const adaItems = ((await ada.call('GET', 'ai/history')).json() as AiHistoryPage).items
    expect(adaItems).toHaveLength(1)
    const id = adaItems[0]!.id
    expect(((await bob.call('GET', 'ai/history')).json() as AiHistoryPage).items).toEqual([])
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
    expect((await bob.call('DELETE', `ai/history/${id}`)).statusCode).toBe(404)
    expect((await admin.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
    // The administrator sees everyone's usage, by user, and never the words.
    const usage = await admin.call('GET', 'ai/usage?days=30&all=1')
    expect(usage.statusCode).toBe(200)
    expect((usage.json() as AiUsage).byUser).toEqual([
      expect.objectContaining({ requests: 1, input: 7, output: 3 }),
    ])
    expect(usage.payload).not.toContain('ada private words')
    expect((await ada.call('GET', 'ai/usage?days=30&all=1')).statusCode).toBe(403)
    expect((await ada.call('PUT', 'ai/history/settings', { days: 7, keepContent: true })).statusCode).toBe(
      403,
    )
    // Everyone may read how long their own requests are kept.
    expect((await ada.call('GET', 'ai/history/settings')).json()).toEqual({ days: 90, keepContent: true })
    // A search runs in the searcher's own requests only (review: isolation with q).
    const search = (who: typeof ada, q: string) => who.call('GET', `ai/history?q=${encodeURIComponent(q)}`)
    expect(((await search(bob, 'ada private')).json() as AiHistoryPage).items).toEqual([])
    expect(((await search(admin, 'ada private')).json() as AiHistoryPage).items).toEqual([])
    expect(((await search(ada, 'ada private')).json() as AiHistoryPage).items).toHaveLength(1)
  })

  it('removes a user’s requests with the user, and keeps requests when their provider goes', async () => {
    const { fake, h, db, as, admin } = await team()
    const ada = as('editor')
    fake.reply(openaiReply('answer'))
    await ada.call('POST', `connections/${h.connectionId}/databases/${db}/collections/orders/ai`, {
      action: 'query',
      prompt: 'kept after the provider',
      language: 'en',
    })
    const providers = (await admin.call('GET', 'ai/providers')).json() as AiProviderView[]
    expect((await admin.call('DELETE', `ai/providers/${providers[0]!.id}`)).statusCode).toBe(204)
    const [item] = ((await ada.call('GET', 'ai/history')).json() as AiHistoryPage).items
    expect(item).toMatchObject({ preview: 'kept after the provider', provider: { name: 'P', model: 'm' } })
    expect((await admin.call('DELETE', `users/${ada.id}`)).statusCode).toBe(204)
    const left = h.t.app.ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM ai_requests WHERE user_id = ?')
      .get(ada.id)
    expect(left).toEqual({ n: 0 })
  })

  it('limits searches: 30 a minute per user', async () => {
    const { as } = await team()
    const ada = as('editor')
    for (let i = 0; i < 30; i++) expect((await ada.call('GET', 'ai/history?q=x')).statusCode).toBe(200)
    expect((await ada.call('GET', 'ai/history?q=x')).statusCode).toBe(429)
    // Listing without a search is not counted.
    expect((await ada.call('GET', 'ai/history')).statusCode).toBe(200)
  })

  it('refuses bad page sizes, cursors and filters', async () => {
    const { api } = await local()
    for (const q of [
      '?limit=0',
      '?limit=1000',
      '?before=nope',
      '?action=drop',
      '?outcome=x',
      `?q=${'x'.repeat(300)}`,
    ])
      expect((await api('GET', `ai/history${q}`)).statusCode, q).toBe(400)
    expect((await api('GET', 'ai/history/not-a-uuid')).statusCode).toBe(400)
    expect((await api('GET', 'ai/usage?days=0')).statusCode).toBe(400)
  })

  it('refuses a price that is not a price', async () => {
    const { api, provider } = await local()
    for (const price of [
      { input: -1, output: 1, currency: 'USD' },
      { input: 1, output: 1, currency: 'BTC' },
      { input: 1e9, output: 1, currency: 'USD' },
    ])
      expect((await api('PATCH', `ai/providers/${provider.id}`, { price })).statusCode).toBe(400)
    const cleared = (
      await api('PATCH', `ai/providers/${provider.id}`, { price: null })
    ).json() as AiProviderView
    expect(cleared.price).toBeNull()
  })
})

describe('AI history and rotate-key', () => {
  it('re-seals what was asked and answered with the new key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-ai-history-'))
    closers.push(async () => rmSync(dir, { recursive: true, force: true }))
    const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    let store = await openStore(dir)
    const repo = () => new AiHistoryRepo(store.db, box, new SettingsRepo(store.db, Date.now), Date.now)
    const id = repo().record({
      owner: null,
      action: 'query',
      connectionId: null,
      namespace: 'shop.orders',
      provider: { id: randomUUID(), name: 'P', kind: 'openai', model: 'm' },
      outcome: 'ok',
      usage: { input: 1, output: 1 },
      ms: 5,
      price: null,
      content: { prompt: 'kept words', answer: 'kept answer' },
    })
    store.close()
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.aiRequests).toBe(1)
    store = await openStore(dir)
    const fresh = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    const item = new AiHistoryRepo(store.db, fresh, new SettingsRepo(store.db, Date.now), Date.now).get(
      null,
      id,
    )
    expect(item?.content).toMatchObject({ prompt: 'kept words', answer: 'kept answer' })
    // The preview, sealed apart, is re-sealed too.
    expect(item?.preview).toBe('kept words')
    expect(store.db.prepare('SELECT preview FROM ai_requests').get()).not.toEqual({ preview: null })
    store.close()
  })
})

describe('AI history size (abuse: a user filling the disk with words)', () => {
  it('keeps at most a set size of words per user, dropping the oldest words first but never their usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-ai-history-'))
    closers.push(async () => rmSync(dir, { recursive: true, force: true }))
    const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    const store = await openStore(dir)
    closers.push(async () => store.close())
    let clock = 1_000
    // What one request's words take on disk, sealed: room for three and a half.
    const row = box.seal(
      JSON.stringify({ prompt: 'request 0', answer: 'a'.repeat(900) }),
      aiRequestContext(randomUUID(), null),
    ).length
    const repo = new AiHistoryRepo(store.db, box, new SettingsRepo(store.db, () => clock), () => clock, {
      wordsPerUser: Math.floor(row * 3.5),
    })
    const record = (owner: string | null, prompt: string) =>
      repo.record({
        owner,
        action: 'query',
        connectionId: null,
        namespace: 'shop.orders',
        provider: { id: randomUUID(), name: 'P', kind: 'openai', model: 'm' },
        outcome: 'ok',
        usage: { input: 10, output: 5 },
        ms: 5,
        price: { input: 1, output: 1, currency: 'USD' },
        content: { prompt, answer: 'a'.repeat(900) },
      })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      clock += 1000
      ids.push(record(null, `request ${i}`))
    }
    // Another user's words are theirs to count.
    store.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES ('u9', 'grace', 'x', 'viewer', 0, 0)",
      )
      .run()
    clock += 1000
    record('u9', 'grace words')
    const kept = ids.map((id) => repo.get(null, id)!.content !== null)
    expect(kept).toEqual([false, false, true, true, true])
    // Every request still counts in the usage and the cost.
    expect(repo.usage(null, 30).totals).toMatchObject({ requests: 5, input: 50, output: 25 })
    expect(repo.list('u9', { limit: 50 } as never).items[0]!.preview).toBe('grace words')
  })
})

/** A history on its own database, with a clock the test moves. */
async function bare(options: ConstructorParameters<typeof AiHistoryRepo>[4] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-ai-history-'))
  closers.push(async () => rmSync(dir, { recursive: true, force: true }))
  const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
  const store = await openStore(dir)
  closers.push(async () => store.close())
  const clock = { now: 1_000 }
  const repo = new AiHistoryRepo(
    store.db,
    box,
    new SettingsRepo(store.db, () => clock.now),
    () => clock.now,
    options,
  )
  const record = (prompt: string, over: Partial<Parameters<AiHistoryRepo['record']>[0]> = {}) =>
    repo.record({
      owner: null,
      action: 'query',
      connectionId: null,
      namespace: 'shop.orders',
      provider: { id: randomUUID(), name: 'P', kind: 'openai', model: 'm' },
      outcome: 'ok',
      usage: { input: 1, output: 1 },
      ms: 5,
      price: null,
      content: { prompt, answer: `answer to ${prompt}` },
      ...over,
    })
  return { store, box, repo, record, clock }
}

describe('AI history review fixes', () => {
  it('keeps how many sample documents went, never their values', async () => {
    const { repo, record } = await bare()
    const id = record('with samples', {
      content: {
        prompt: 'with samples',
        answer: 'a',
        sent: { namespace: 'shop.customers', samples: ['{"email":"ada@example.com"}', '{"email":"x"}'] },
      },
    })
    const content = repo.get(null, id)!.content!
    expect(content.samples).toBe(2)
    expect(content.sent).toMatchObject({ namespace: 'shop.customers', samples: [] })
    expect(JSON.stringify(content)).not.toContain('ada@example.com')
  })

  it('forgets every kept word at once when words are no longer kept', async () => {
    const { repo, record, store } = await bare()
    const id = record('old words')
    repo.setSettings({ days: 90, keepContent: false })
    expect(repo.get(null, id)).toMatchObject({ preview: null, content: null })
    expect(store.db.prepare('SELECT content, preview, bytes FROM ai_requests').all()).toEqual([
      { content: null, preview: null, bytes: 0 },
    ])
    // Its usage stays.
    expect(repo.usage(null, 30).totals.requests).toBe(1)
  })

  it('lists from the sealed preview, never opening the full words', async () => {
    const { repo, record, store } = await bare()
    const id = record('the preview')
    // Words that no longer open (another key, a broken row) do not stop the page.
    store.db.prepare("UPDATE ai_requests SET content = 'broken'").run()
    expect(repo.list(null, { limit: 50 } as never).items[0]!.preview).toBe('the preview')
    expect(repo.get(null, id)!.content).toBeNull()
  })

  it('pages rows of the same time in order, and a search goes on past the rows it may open', async () => {
    const { repo, record } = await bare({ searchScan: 3 })
    const ids = ['one', 'two match', 'three', 'four', 'five match', 'six'].map((w) => record(w))
    const first = repo.list(null, { limit: 2 } as never)
    expect(first.items.map((i) => i.preview)).toEqual(['six', 'five match'])
    const second = repo.list(null, { limit: 2, before: first.next! } as never)
    expect(second.items.map((i) => i.preview)).toEqual(['four', 'three'])
    const third = repo.list(null, { limit: 2, before: second.next! } as never)
    expect(third.items.map((i) => i.id)).toEqual([ids[1], ids[0]])
    expect(third.next).toBeNull()
    // Three rows a page: the first page finds one match and says where to go on.
    const s1 = repo.list(null, { limit: 5, q: 'match' } as never)
    expect(s1.items.map((i) => i.preview)).toEqual(['five match'])
    expect(s1.next).not.toBeNull()
    const s2 = repo.list(null, { limit: 5, q: 'match', before: s1.next! } as never)
    expect(s2.items.map((i) => i.preview)).toEqual(['two match'])
    // The last rows searched: nothing more is offered (no empty page after it).
    expect(s2.next).toBeNull()
  })
})

describe('AI history and chats (review: a chat’s words live as long as the chat)', () => {
  it('forgets a chat’s words when the chat is deleted, keeping its usage', async () => {
    const { fake, h, db, api } = await local()
    fake.reply(openaiReply('Chat answer'))
    const res = await h.call('POST', `/databases/${db}/collections/orders/ai/chat`, {
      message: 'words of a chat',
      language: 'en',
    })
    const chatId = (JSON.parse(res.payload.split(String.fromCharCode(10))[0]!) as { id: string }).id
    expect((await page(api)).items[0]!.preview).toBe('words of a chat')
    expect((await api('DELETE', `ai/chats/${chatId}`)).statusCode).toBe(204)
    const [item] = (await page(api)).items
    expect(item).toMatchObject({ action: 'chat', chatId, preview: null })
    expect((await api('GET', `ai/history/${item!.id}`)).json()).toMatchObject({ content: null })
  })

  it('forgets the words of a chat swept or pushed out, keeping its usage', async () => {
    const { repo, record, store } = await bare()
    const chat = (id: string) =>
      store.db
        .prepare(
          'INSERT INTO ai_chats (id, user_id, title, bytes, created_at, updated_at) VALUES (?, NULL, ?, 0, 0, 0)',
        )
        .run(id, 't')
    chat('c-kept')
    chat('c-gone')
    const kept = record('a kept chat', { action: 'chat', chatId: 'c-kept' })
    const gone = record('a gone chat', { action: 'chat', chatId: 'c-gone' })
    expect(repo.get(null, gone)!.preview).toBe('a gone chat')
    store.db.prepare("DELETE FROM ai_chats WHERE id = 'c-gone'").run()
    repo.sweep()
    expect(repo.get(null, gone)).toMatchObject({ preview: null, content: null })
    expect(repo.get(null, kept)!.preview).toBe('a kept chat')
    expect(repo.usage(null, 30).totals.requests).toBe(2)
  })

  it('keeps no chat words at all when chats live in memory only, and forgets earlier ones', async () => {
    const first = await bare()
    first.store.db
      .prepare(
        'INSERT INTO ai_chats (id, user_id, title, bytes, created_at, updated_at) VALUES (?, NULL, ?, 0, 0, 0)',
      )
      .run('c1', 't')
    const earlier = first.record('an earlier chat', { action: 'chat', chatId: 'c1' })
    const query = first.record('a query')
    // The operator moves chats to memory (MM_AI_CHAT_DAYS=0): the start-up sweep forgets chat words.
    const memory = new AiHistoryRepo(
      first.store.db,
      first.box,
      new SettingsRepo(first.store.db, () => first.clock.now),
      () => first.clock.now,
      { chatsKept: false },
    )
    memory.sweep()
    expect(memory.get(null, earlier)!.preview).toBeNull()
    expect(memory.get(null, query)!.preview).toBe('a query')
  })
})

describe('AI history chains (user, 2026-10-09: "düzeltme istekleri ilk işleme bağlı görünsün")', () => {
  const T = '6f1d3c1e-1111-4a5b-9c9d-000000000001'
  const priced = { input: 1_000_000, output: 1_000_000, currency: 'USD' as const }

  it('links the refinements of a pipeline to its first request, newest activity first', async () => {
    const { repo, record, clock } = await bare()
    clock.now = 2_000
    const first = record('first', { action: 'pipeline', thread: T, price: priced })
    clock.now = 3_000
    record('other', { action: 'query' })
    clock.now = 4_000
    const second = record('second', {
      action: 'pipeline',
      thread: T,
      outcome: 'key_refused',
      usage: { input: 2, output: 3 },
      ms: 7,
      price: priced,
    })
    const { items } = repo.list(null, { limit: 50 } as never)
    expect(items.map((i) => i.preview)).toEqual(['first', 'other'])
    expect(items[0]).toMatchObject({
      id: first,
      thread: T,
      step: 1,
      chain: {
        steps: 2,
        at: 4_000,
        usage: { input: 3, output: 4 },
        ms: 12,
        outcome: 'key_refused',
        cost: [{ amount: 7, currency: 'USD' }],
        latest: second,
      },
    })
    expect(items[1]).toMatchObject({ thread: null, step: null, chain: null })
    // Read alone (a link to it), a step says its chain too.
    const alone = repo.thread(null, T)[1]!
    expect(repo.get(null, alone.id)).toMatchObject({ step: 2, chain: { steps: 2, at: 4_000 } })
    const steps = repo.thread(null, T)
    expect(steps.map((s) => [s.step, s.content?.prompt])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ])
  })

  it('finds and filters a chain by any of its steps', async () => {
    const { repo, record, clock } = await bare()
    record('first', { action: 'pipeline', thread: T })
    clock.now += 1000
    record('then group by city', { action: 'pipeline', thread: T, outcome: 'key_refused' })
    clock.now += 1000
    record('alone', { action: 'query' })
    const previews = (q: object) => repo.list(null, { limit: 50, ...q } as never).items.map((i) => i.preview)
    expect(previews({ outcome: 'failed' })).toEqual(['first'])
    expect(previews({ outcome: 'ok' })).toEqual(['alone', 'first'])
    expect(previews({ q: 'group by city' })).toEqual(['first'])
    expect(previews({ action: 'query' })).toEqual(['alone'])
  })

  it('starts no chain across collections, and numbers steps past a removed one', async () => {
    const { repo, record, clock } = await bare()
    const a = record('first', { action: 'pipeline', thread: T })
    clock.now += 1000
    const elsewhere = record('elsewhere', { action: 'pipeline', thread: T, namespace: 'shop.customers' })
    expect(repo.get(null, elsewhere)).toMatchObject({ thread: null, step: null })
    clock.now += 1000
    record('second', { action: 'pipeline', thread: T })
    expect(repo.remove(null, a)).toBe(true)
    clock.now += 1000
    const third = record('third', { action: 'pipeline', thread: T })
    expect(repo.get(null, third)!.step).toBe(3)
    // The first step gone, the next one leads the chain.
    const head = repo.list(null, { limit: 50 } as never).items.find((i) => i.thread === T)!
    expect(head).toMatchObject({ preview: 'second', chain: { steps: 2 } })
    expect(repo.removeThread(null, T)).toBe(2)
    expect(repo.list(null, { limit: 50 } as never).items.map((i) => i.preview)).toEqual(['elsewhere'])
  })

  it('pages chains and single requests by their latest activity', async () => {
    const { repo, record, clock } = await bare()
    const threads = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']
    for (const [i, t] of threads.entries()) {
      clock.now += 1000
      record(`chain ${i}`, { action: 'pipeline', thread: t })
      clock.now += 1000
      record(`chain ${i} again`, { action: 'pipeline', thread: t })
    }
    clock.now += 1000
    record('single', { action: 'query' })
    const p1 = repo.list(null, { limit: 2 } as never)
    expect(p1.items.map((i) => i.preview)).toEqual(['single', 'chain 1'])
    const p2 = repo.list(null, { limit: 2, before: p1.next! } as never)
    expect(p2).toMatchObject({ items: [expect.objectContaining({ preview: 'chain 0' })], next: null })
  })

  it('sends a chain through the request, and shows it to its owner only', async () => {
    const { fake, h, db, api } = await local()
    const ask = (prompt: string, thread: string) =>
      h.call('POST', `/databases/${db}/collections/orders/ai`, {
        action: 'pipeline',
        prompt,
        language: 'en',
        thread,
      })
    fake.reply(openaiReply('ok'))
    await ask('first', T)
    fake.reply(openaiReply('ok'))
    await ask('second', T)
    const res = await api('GET', `ai/history/threads/${T}`)
    expect(res.statusCode).toBe(200)
    expect((res.json() as AiHistoryThread).steps.map((s) => s.content?.prompt)).toEqual(['first', 'second'])
    expect((await api('GET', 'ai/history/threads/not-a-uuid')).statusCode).toBe(400)
    expect(
      (
        await h.call('POST', `/databases/${db}/collections/orders/ai`, {
          action: 'pipeline',
          prompt: 'x',
          thread: 'nope',
        })
      ).statusCode,
    ).toBe(400)
    expect((await api('DELETE', `ai/history/threads/${T}`)).statusCode).toBe(204)
    expect((await api('GET', `ai/history/threads/${T}`)).statusCode).toBe(404)
    expect((await api('DELETE', `ai/history/threads/${T}`)).statusCode).toBe(404)
  })
})

describe('AI history chains, abuse cases', () => {
  it('never joins another user’s chain: the same chain id stays each owner’s own', async () => {
    const { repo, record } = await bare()
    const T = '6f1d3c1e-1111-4a5b-9c9d-000000000002'
    const store = (repo as unknown as { db: import('node:sqlite').DatabaseSync }).db
    store
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES ('u7', 'eve', 'x', 'editor', 0, 0)",
      )
      .run()
    record('ada first', { action: 'pipeline', thread: T })
    const eve = record('eve joins', { action: 'pipeline', thread: T, owner: 'u7' })
    expect(repo.get('u7', eve)).toMatchObject({ step: 1 })
    expect(repo.thread('u7', T).map((s) => s.content?.prompt)).toEqual(['eve joins'])
    expect(repo.thread(null, T).map((s) => s.content?.prompt)).toEqual(['ada first'])
    expect(repo.removeThread('u7', T)).toBe(1)
    expect(repo.thread(null, T)).toHaveLength(1)
  })
})

describe('AI history chains, paging and search (chains review)', () => {
  const T = '6f1d3c1e-1111-4a5b-9c9d-000000000003'
  const page = (repo: AiHistoryRepo, owner: string | null, q: object) =>
    repo.list(owner, { limit: 50, ...q } as never)

  it('keeps two owners’ chains of one id apart in the list', async () => {
    const { repo, record, clock, store } = await bare()
    store.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES ('u8', 'mal', 'x', 'editor', 0, 0)",
      )
      .run()
    record('ada one', { action: 'pipeline', thread: T })
    clock.now += 1000
    record('ada two', { action: 'pipeline', thread: T })
    clock.now += 5000
    record('mal one', { action: 'pipeline', thread: T, owner: 'u8' })
    const ada = page(repo, null, {}).items
    expect(ada).toEqual([
      expect.objectContaining({ preview: 'ada one', chain: expect.objectContaining({ steps: 2, at: 2000 }) }),
    ])
    const mal = page(repo, 'u8', {}).items
    expect(mal).toEqual([expect.objectContaining({ preview: 'mal one', chain: null })])
  })

  it('pages requests of the same time one after another, none twice', async () => {
    const { repo, record } = await bare()
    for (const p of ['a', 'b', 'c']) record(p)
    const seen: string[] = []
    let before: string | undefined
    for (let i = 0; i < 4; i++) {
      const p = repo.list(null, { limit: 1, ...(before ? { before } : {}) } as never)
      seen.push(...p.items.map((x) => x.preview!))
      if (!p.next) break
      before = p.next
    }
    expect(seen).toEqual(['c', 'b', 'a'])
  })

  it('does not skip a chain that gains a step while the pages are read', async () => {
    const { repo, record, clock } = await bare()
    record('older single')
    clock.now += 1000
    record('chain start', { action: 'pipeline', thread: T })
    clock.now += 1000
    record('newest single')
    const p1 = repo.list(null, { limit: 1 } as never)
    expect(p1.items.map((i) => i.preview)).toEqual(['newest single'])
    clock.now += 1000
    record('chain change', { action: 'pipeline', thread: T })
    const p2 = repo.list(null, { limit: 1, before: p1.next! } as never)
    expect(p2.items.map((i) => i.preview)).toEqual(['chain start'])
    const p3 = repo.list(null, { limit: 1, before: p2.next! } as never)
    expect(p3.items.map((i) => i.preview)).toEqual(['older single'])
    expect(p3.next).toBeNull()
  })

  it('spends a search’s budget on a chain’s steps too, and offers more only when there is more', async () => {
    const { repo, record, clock } = await bare({ searchScan: 3 })
    record('the match')
    clock.now += 1000
    for (let i = 0; i < 5; i++) record(`step ${i}`, { action: 'pipeline', thread: T })
    const s1 = page(repo, null, { q: 'match' })
    expect(s1.items).toEqual([])
    expect(s1.next).not.toBeNull()
    const s2 = page(repo, null, { q: 'match', before: s1.next! })
    expect(s2.items.map((i) => i.preview)).toEqual(['the match'])
    expect(s2.next).toBeNull()
    // Alone, a long chain without the words says there is nothing more.
    const only = await bare({ searchScan: 3 })
    for (let i = 0; i < 5; i++) only.record(`step ${i}`, { action: 'pipeline', thread: T })
    expect(page(only.repo, null, { q: 'nothing' })).toEqual({ items: [], next: null })
  })
})

describe('AI history page review', () => {
  const T = '6f1d3c1e-1111-4a5b-9c9d-000000000004'

  it('asks the database for at most one row past a search’s budget', async () => {
    const { repo, record, clock, store } = await bare({ searchScan: 3 })
    for (let i = 0; i < 10; i++) {
      clock.now += 1000
      record(`request ${i}`)
    }
    const limits: unknown[] = []
    const prepare = store.db.prepare.bind(store.db)
    store.db.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (!sql.includes('ORDER BY e.last DESC')) return statement
      const iterate = statement.iterate.bind(statement)
      statement.iterate = ((...args: unknown[]) => {
        limits.push(args.at(-1))
        return iterate(...(args as never[]))
      }) as never
      return statement
    }) as never
    repo.list(null, { limit: 50, q: 'request' } as never)
    expect(limits).toEqual([4])
  })

  it('pages an old two-part cursor, and a crafted time shows nothing of another owner', async () => {
    const { repo, record, clock, store } = await bare()
    store.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES ('u6', 'zoe', 'x', 'editor', 0, 0)",
      )
      .run()
    record('first')
    clock.now += 1000
    record('second')
    clock.now += 1000
    record('zoe’s', { owner: 'u6' })
    const p1 = repo.list(null, { limit: 1 } as never)
    const [last, seq] = p1.next!.split(':')
    expect(
      repo.list(null, { limit: 5, before: `${last}:${seq}` } as never).items.map((i) => i.preview),
    ).toEqual(['first'])
    const crafted = repo.list(null, {
      limit: 5,
      before: `999999999999999:999999999:999999999999999`,
    } as never)
    expect(crafted.items.map((i) => i.preview)).toEqual(['second', 'first'])
  })

  it('sums a chain on a later page as of the first page, as its place there says', async () => {
    const { repo, record, clock } = await bare()
    record('chain start', { action: 'pipeline', thread: T })
    clock.now += 1000
    record('newest single')
    const p1 = repo.list(null, { limit: 1 } as never)
    clock.now += 1000
    record('chain change', { action: 'pipeline', thread: T })
    const p2 = repo.list(null, { limit: 1, before: p1.next! } as never)
    // The chain is where it was when the first page was read: one step then, so no chain yet.
    expect(p2.items).toEqual([expect.objectContaining({ preview: 'chain start', chain: null })])
  })
})

describe('AI usage by day', () => {
  const at = (iso: string) => Date.parse(iso)

  it('groups the requests by the day in the user’s time zone', async () => {
    const { repo, record, clock } = await bare()
    clock.now = at('2026-10-08T23:30:00Z')
    record('late')
    clock.now = at('2026-10-09T00:30:00Z')
    record('early')
    clock.now = at('2026-10-09T12:00:00Z')
    // Istanbul (UTC+3): both on the 9th.
    expect(repo.usage(null, 30, 180).byDay).toEqual([
      expect.objectContaining({ day: '2026-10-09', requests: 2, input: 2, output: 2 }),
    ])
    // UTC: one on each day, oldest first.
    expect(repo.usage(null, 30, 0).byDay!.map((d) => [d.day, d.requests])).toEqual([
      ['2026-10-08', 1],
      ['2026-10-09', 1],
    ])
    // New York (UTC-4): both on the 8th.
    expect(repo.usage(null, 30, -240).byDay!.map((d) => [d.day, d.requests])).toEqual([['2026-10-08', 2]])
  })

  it('gives no days unless a time zone is asked for', async () => {
    const { repo, record } = await bare()
    record('one')
    expect(repo.usage(null, 30).byDay).toBeUndefined()
  })

  it('refuses a time zone out of range even when called directly', async () => {
    const { repo } = await bare()
    for (const tz of [900, -841, 1.5, Number.NaN]) expect(() => repo.usage(null, 30, tz)).toThrow(RangeError)
  })

  it('counts only the asker’s own requests by day', async () => {
    const { repo, record, store } = await bare()
    store.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES ('u9', 'grace', 'x', 'viewer', 0, 0)",
      )
      .run()
    record('mine')
    record('theirs', { owner: 'u9' })
    expect(repo.usage(null, 30, 0).byDay!.reduce((n, d) => n + d.requests, 0)).toBe(1)
  })

  it('takes the time zone on the route, and refuses one out of range', async () => {
    const { fake, api, ask } = await local()
    fake.reply(openaiReply('ok', { input: 10, output: 5 }))
    await ask('q')
    const usage = (await api('GET', 'ai/usage?days=30&tz=180')).json() as AiUsage
    expect(usage.byDay).toEqual([expect.objectContaining({ requests: 1, input: 10, output: 5 })])
    expect(usage.byDay![0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const tz of ['900', '-900', '1.5', 'x', "0'); DROP TABLE ai_requests; --"])
      expect((await api('GET', `ai/usage?days=30&tz=${encodeURIComponent(tz)}`)).statusCode).toBe(400)
    expect(((await api('GET', 'ai/usage?days=30')).json() as AiUsage).byDay).toBeUndefined()
  })
})
