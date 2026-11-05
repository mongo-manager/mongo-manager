// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Binary, MongoClient } from 'mongodb'
import { AiRequestSchema, SECRET_MASK, type AiLine, type AiSent } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness, type DataHarness } from './support/data'
import { startFakeAi, statusReply, type FakeAi } from './support/fake-ai'
import { buildContext, capContext, cutDocument } from '../src/ai/context'
import { createAiEgress } from '../src/ai/egress'
import { callProvider } from '../src/ai/wire'
import { EgressError } from '../src/net/egress'
import { defaultConfig, resolveConfig } from '../src/config'
import type { Principal } from '../src/http/context'

/** Phase 4a-1 final review: each finding, first seen failing. */
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

async function setup(overrides: Record<string, unknown> = {}) {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h: DataHarness = await dataHarness(mongo, overrides as never)
  closers.push(h.t.close)
  const db = `fin${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('c')
    .insertMany([{ a: 1 }, { a: 2 }])
  const ask = (payload: unknown) => h.call('POST', `/databases/${db}/collections/c/ai`, payload)
  return { fake, h, db, ask }
}
const provider = (h: DataHarness, fake: FakeAi, over: Record<string, unknown> = {}) =>
  h.t.app.ctx.ai.providers.create(
    {
      name: `P${randomUUID().slice(0, 4)}`,
      kind: 'openai',
      baseUrl: `${fake.url}/v1`,
      model: 'm',
      apiKey: 'key-old',
      maxTokens: 2048,
      enabled: true,
      isDefault: true,
      ...over,
    } as never,
    null,
  )

describe('I1: a key travels only with its own address', () => {
  it('sends the key read with the address, even when the provider moves during the context', async () => {
    const { fake, h, ask } = await setup()
    const p = provider(h, fake)
    const seen: Array<{ url: string; auth?: string }> = []
    const real = h.t.app.ctx.ai.egress
    h.t.app.ctx.ai.egress = {
      ...real,
      request: async (r) => {
        seen.push({ url: String(r.url), auth: r.headers?.authorization })
        throw new EgressError('connect', 'stopped here')
      },
    }
    // While the server reads the collection, an administrator moves the provider and enters a new key.
    const rules = h.t.app.ctx.personalFields
    const get = rules.get.bind(rules)
    let moved = false
    rules.get = (id: string) => {
      if (!moved) {
        moved = true
        h.t.app.ctx.ai.providers.update(p.id, { baseUrl: 'https://new-gw.example/v1', apiKey: 'key-new' })
      }
      return get(id)
    }
    await ask({ action: 'describe' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url.startsWith(fake.url)).toBe(true)
    expect(seen[0]!.auth).toBe('Bearer key-old')
  })
})

describe('I2: export and import keep a connection’s AI policy', () => {
  it('round-trips the policy', async () => {
    const { h } = await setup()
    h.t.app.ctx.connections.setAiPolicy(h.connectionId, 'local')
    const exported = await h.t.app.inject({
      method: 'POST',
      url: '/api/connections/export',
      headers: h.headers,
      payload: {},
    })
    const file = exported.json() as { connections: Array<{ aiPolicy?: string }> }
    expect(file.connections[0]!.aiPolicy).toBe('local')
  })
})

describe('I3: changing the AI policy is not a connection change', () => {
  it('saves the policy from the whole form without reconnecting or closing feeds and shells', async () => {
    const { h } = await setup()
    const before = h.t.app.ctx.connections.get(h.connectionId)!
    const dto = (await h.call('GET', '')).json() as Record<string, unknown>
    let invalidated = 0
    const manager = h.t.app.ctx.manager
    const invalidate = manager.invalidate.bind(manager)
    manager.invalidate = async (id: string) => {
      invalidated++
      return invalidate(id)
    }
    // The form sends everything, as patchFromForm does, with the policy changed.
    const res = await h.call('PATCH', '', {
      name: dto.name,
      group: null,
      color: null,
      favorite: dto.favorite,
      readOnly: dto.readOnly,
      settings: dto.settings,
      aiPolicy: 'off',
    })
    expect(res.statusCode).toBe(200)
    expect(invalidated).toBe(0)
    const after = h.t.app.ctx.connections.get(h.connectionId)!
    expect(after.aiPolicy).toBe('off')
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  it('leaves the policy as it was when the rest of the save is refused', async () => {
    const { h } = await setup()
    // A masked password for another host is refused after the body is read (secret reuse).
    const res = await h.call('PATCH', '', {
      aiPolicy: 'off',
      settings: {
        hosts: [{ host: 'elsewhere.example', port: 27017 }],
        auth: { mechanism: 'DEFAULT', username: 'u', password: SECRET_MASK },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(h.t.app.ctx.connections.get(h.connectionId)!.aiPolicy).toBe('any')
  })
})

describe('I4: a local-only connection says so', () => {
  it('refuses a provider known to be cloud before reading anything', async () => {
    const { fake, h, ask } = await setup()
    const p = provider(h, fake)
    h.t.app.ctx.ai.providers.setLocal(p.id, false)
    h.t.app.ctx.connections.setAiPolicy(h.connectionId, 'local')
    const res = await ask({ action: 'describe' })
    expect(res.json()).toMatchObject({ details: { reason: 'ai_local_only' } })
    expect(fake.requests).toHaveLength(0)
  })

  it('names a refusal at connect ai_local_only, and says nothing was sent', async () => {
    const { fake, h, ask } = await setup()
    provider(h, fake)
    h.t.app.ctx.connections.setAiPolicy(h.connectionId, 'local')
    const real = h.t.app.ctx.ai.egress
    h.t.app.ctx.ai.egress = {
      ...real,
      request: async () => {
        throw new EgressError('address_refused', 'not listed')
      },
    }
    const out = lines((await ask({ action: 'describe' })).payload)
    expect(out.at(-1)).toEqual({ type: 'error', reason: 'ai_local_only', nothingSent: true })
  })
})

describe('Minor 1: a slow provider’s test is too slow, not stopped', () => {
  it('reports timeout', async () => {
    const { fake, h } = await setup()
    const p = provider(h, fake)
    h.t.app.ctx.ai.testMs = 300
    fake.reply(async () => new Promise(() => undefined))
    const res = await h.t.app.inject({
      method: 'POST',
      url: `/api/ai/providers/${p.id}/test`,
      headers: h.headers,
    })
    expect(res.json()).toMatchObject({ outcome: 'timeout' })
  })
})

describe('Minors 2–5: the context’s cuts', () => {
  const LOCAL: Principal = { kind: 'local', userId: 'local', username: 'owner', role: 'admin', csrfToken: '' }

  it('keeps the fields that fit beside a huge binary, and cuts a huge array fast', () => {
    const doc = {
      _id: 1,
      file: new Binary(Buffer.alloc(8 * 1024 * 1024)),
      name: 'report.pdf',
      size: 8388608,
      owner: 'ada',
    }
    const text = cutDocument(doc, 4096)
    for (const kept of ['report.pdf', '8388608', 'ada']) expect(text).toContain(kept)
    const started = Date.now()
    const big = { _id: 1, list: Array.from({ length: 400_000 }, (_, i) => i), tail: 'kept' }
    const cut = cutDocument(big, 4096)
    expect(Date.now() - started).toBeLessThan(300)
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(4096)
    expect(cut).toContain('kept')
  })

  it('shrinks long field names instead of refusing, and says what was left out', () => {
    const sent: AiSent = {
      namespace: 'd.c',
      schema: {
        sampled: 1,
        count: 1,
        more: 0,
        fields: Array.from({ length: 25 }, (_, i) => ({
          path: `f${i}_${'x'.repeat(3000)}`,
          types: { int: 1 },
          share: 1,
        })),
      },
      current: null,
      plan: null,
      indexes: null,
      validator: null,
      samples: [],
      leftOut: [],
    }
    capContext(sent)
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(48 * 1024)
    expect(sent.schema!.fields.every((f) => f.path.length <= 257)).toBe(true)
  })

  it('measures the current query as the text that is sent', async () => {
    const { h, db } = await setup()
    const sent = await buildContext({
      ctx: h.t.app.ctx,
      principal: LOCAL,
      connectionId: h.connectionId,
      client: await h.client(),
      db,
      coll: 'c',
      // ~9 KB of shell text, ~27 KB of canonical EJSON.
      request: AiRequestSchema.parse({
        action: 'explain',
        current: {
          filter: { a: { $in: Array.from({ length: 1500 }, (_, i) => ({ $numberInt: String(i) })) } },
        },
      }),
      comment: 'mm-ai-test',
      signal: new AbortController().signal,
    })
    expect(sent.current).toContain('$in')
  })
})

describe('Minor 11: the providers’ rules agree with the API', () => {
  it('refuses a disabled default and an Anthropic provider without a key', async () => {
    const { fake, h } = await setup()
    const r = h.t.app.ctx.ai.providers
    expect(() =>
      r.create(
        { name: 'A', kind: 'ollama', model: 'm', maxTokens: 2048, enabled: false, isDefault: true } as never,
        null,
      ),
    ).toThrow(/disabled/i)
    const p = r.create(
      {
        name: 'C',
        kind: 'anthropic',
        baseUrl: fake.url,
        apiKey: 'k',
        maxTokens: 2048,
        enabled: true,
        isDefault: false,
      } as never,
      null,
    )
    expect(() => r.update(p.id, { apiKey: null })).toThrow(/key/i)
  })
})

describe('Minor 12: the status follows per-connection rights', () => {
  it('lists the providers for a global viewer who holds an editor grant somewhere', async () => {
    const fake = await startFakeAi()
    closers.push(fake.close)
    const team = await teamHarness(mongo)
    closers.push(team.t.close)
    team.t.app.ctx.ai.providers.create(
      {
        name: 'L',
        kind: 'ollama',
        baseUrl: fake.url,
        model: 'm',
        maxTokens: 2048,
        enabled: true,
        isDefault: false,
      } as never,
      null,
    )
    const viewer = team.user('viewer')
    team.t.app.ctx.grants.set(team.connectionId, viewer.id, 'editor')
    expect(((await viewer.get('/api/ai/status')).json() as { providers: unknown[] }).providers).toHaveLength(
      1,
    )
  })
})

describe('Minor 13: the audit says why and where', () => {
  it('names a rate limit’s refusal, and records local for a provider that answered with an error', async () => {
    const { fake, h, ask } = await setup({ ai: { perMinute: 1 } })
    provider(h, fake)
    fake.reply(statusReply(401, '{}'))
    await ask({ action: 'describe' })
    await ask({ action: 'describe' })
    const rows = h.t.app.ctx.audit.list({ action: 'ai.request' })
    expect(
      rows.find(
        (r) => r.outcome === 'failure' && (r.details as { outcome?: string }).outcome === 'key_refused',
      )!.details,
    ).toMatchObject({ local: true })
    expect(rows.find((r) => (r.details as { status?: number }).status === 429)!.details).toMatchObject({
      reason: 'rate_limited',
    })
  })
})

describe('Minor 14: a provider’s error text never carries the key', () => {
  it('redacts the stored key from the excerpt', async () => {
    const fake = await startFakeAi()
    closers.push(fake.close)
    fake.reply(statusReply(401, '{"error":"invalid key gw-1234abcd for this gateway"}'))
    const egress = createAiEgress(resolveConfig({ cli: { auth: false, dataDir: '/tmp/x' } }))
    try {
      await callProvider(
        egress,
        { kind: 'openai', baseUrl: `${fake.url}/v1`, model: 'm', apiKey: 'gw-1234abcd', maxTokens: 16 },
        { system: 's', messages: [{ role: 'user' as const, content: 'u' }] },
        { signal: new AbortController().signal, privateOnly: false, onText: () => {} },
      )
      expect.unreachable()
    } catch (e) {
      expect((e as { detail?: { excerpt?: string } }).detail?.excerpt).not.toContain('gw-1234abcd')
    }
  })
})

describe('Minor 18: the defaults are never shared between configurations', () => {
  it('gives every configuration its own network lists', () => {
    const d = defaultConfig()
    d.ai.privateNetworks.push('10.0.0.0/8')
    d.backup.privateNetworks.push('10.0.0.0/8')
    expect(defaultConfig().ai.privateNetworks).toEqual([])
    expect(defaultConfig().backup.privateNetworks).toEqual([])
    const a = resolveConfig({})
    a.ai.privateNetworks.push('10.0.0.0/8')
    a.backup.privateNetworks.push('10.0.0.0/8')
    const b = resolveConfig({})
    expect(b.ai.privateNetworks).toEqual([])
    expect(b.backup.privateNetworks).toEqual([])
  })
})
