import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiHistoryPage, AiProviderView, AiUsage } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { openaiReply, startFakeAi } from './support/fake-ai'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { MIGRATIONS } from '../src/store/migrations'

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

async function local() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const db = `hp${randomUUID().slice(0, 8)}`
  await client.db(db).collection('orders').insertOne({ qty: 1 })
  const api = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  const provider = (
    await api('POST', 'ai/providers', {
      name: 'Unpriced',
      kind: 'openai',
      baseUrl: `${fake.url}/v1`,
      model: 'm',
    })
  ).json() as AiProviderView
  const ask = async (prompt: string) => {
    fake.reply(openaiReply('ok', { input: 1_000_000, output: 1_000_000 }))
    await h.call('POST', `/databases/${db}/collections/orders/ai`, {
      action: 'query',
      prompt,
      language: 'en',
    })
  }
  const costs = async () =>
    ((await api('GET', 'ai/history')).json() as AiHistoryPage).items.map((i) => [i.preview, i.cost])
  return { api, provider, ask, costs }
}

describe('AI prices entered after the requests (user, 2026-10-09: "fiyat girdim ama hala fiyat gir yazıyor")', () => {
  it('prices the provider’s requests made without a price, and leaves priced ones as they were', async () => {
    const { api, provider, ask, costs } = await local()
    await ask('before any price')
    expect(await costs()).toEqual([['before any price', null]])
    await api('PATCH', `ai/providers/${provider.id}`, { price: { input: 2, output: 4, currency: 'USD' } })
    await ask('at the first price')
    await api('PATCH', `ai/providers/${provider.id}`, { price: { input: 10, output: 10, currency: 'EUR' } })
    expect(await costs()).toEqual([
      ['at the first price', { amount: 6, currency: 'USD' }],
      ['before any price', { amount: 6, currency: 'USD' }],
    ])
    const usage = (await api('GET', 'ai/usage?days=30')).json() as AiUsage
    expect(usage.totals.cost).toEqual([{ amount: 12, currency: 'USD' }])
    // Clearing a price changes no cost already counted.
    await api('PATCH', `ai/providers/${provider.id}`, { price: null })
    expect((await costs()).map(([, c]) => c)).toEqual([
      { amount: 6, currency: 'USD' },
      { amount: 6, currency: 'USD' },
    ])
  })

  it('prices only the requests made with the model and kind the price is for', async () => {
    const { api, provider, ask, costs } = await local()
    await ask('made with the old model')
    await api('PATCH', `ai/providers/${provider.id}`, {
      model: 'a-dearer-model',
      price: { input: 2, output: 4, currency: 'USD' },
    })
    expect(await costs()).toEqual([['made with the old model', null]])
  })

  it('prices nothing of another provider', async () => {
    const { api, provider, ask, costs } = await local()
    await ask('by the first provider')
    const other = (
      await api('POST', 'ai/providers', {
        name: 'Other',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'm',
        price: { input: 1, output: 1, currency: 'USD' },
      })
    ).json() as AiProviderView
    expect(other.id).not.toBe(provider.id)
    expect(await costs()).toEqual([['by the first provider', null]])
  })
})

describe('AI prices entered before prices priced earlier requests', () => {
  it('prices once, on upgrade, the requests a provider with a price left without a cost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-ai-prices-'))
    closers.push(async () => rmSync(dir, { recursive: true, force: true }))
    const before = await openStore(
      dir,
      MIGRATIONS.filter((m) => m.version <= 21),
    )
    const now = Date.now()
    before.db
      .prepare(
        `INSERT INTO ai_providers (id, name, kind, base_url, model, api_key, max_tokens, samples, enabled,
           is_default, created_at, updated_at) VALUES ('p1', 'P', 'openai', 'http://x/v1', 'm', NULL, 2048, 0, 1, 1, ?, ?)`,
      )
      .run(now, now)
    before.db
      .prepare(
        "INSERT INTO ai_prices (provider_id, input, output, currency, updated_at) VALUES ('p1', 2, 4, 'USD', ?)",
      )
      .run(now)
    const row = (id: string, provider: string | null, cost: number | null) =>
      before.db
        .prepare(
          `INSERT INTO ai_requests (id, user_id, at, action, provider_id, provider_name, provider_kind, model,
             outcome, input, output, ms, cost, currency) VALUES (?, NULL, ?, 'query', ?, 'P', 'openai', 'm', 'ok',
             1000000, 1000000, 1, ?, ?)`,
        )
        .run(id, now, provider, cost, cost === null ? null : 'EUR')
    row('unpriced', 'p1', null)
    before.db.prepare("UPDATE ai_requests SET model = 'another model' WHERE id = 'unpriced'").run()
    row('unpriced, same model', 'p1', null)
    before.db.prepare("UPDATE ai_requests SET id = 'other model' WHERE id = 'unpriced'").run()
    row('priced', 'p1', 9)
    row('gone provider', 'p-gone', null)
    before.close()
    const after = await openStore(dir)
    closers.push(async () => after.close())
    expect(after.db.prepare('SELECT id, cost, currency FROM ai_requests ORDER BY id').all()).toEqual([
      { id: 'gone provider', cost: null, currency: null },
      { id: 'other model', cost: null, currency: null },
      { id: 'priced', cost: 9, currency: 'EUR' },
      { id: 'unpriced, same model', cost: 6, currency: 'USD' },
    ])
  })
})

describe('AI usage by model (user preview: a renamed provider listed twice)', () => {
  it('counts a provider once under its current name after a rename', async () => {
    const { api, provider, ask } = await local()
    await ask('before the rename')
    await api('PATCH', `ai/providers/${provider.id}`, { name: 'Renamed' })
    await ask('after the rename')
    const usage = (await api('GET', 'ai/usage?days=30')).json() as AiUsage
    expect(usage.byModel).toEqual([expect.objectContaining({ provider: 'Renamed', model: 'm', requests: 2 })])
  })
})
