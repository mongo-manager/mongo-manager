import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type AiAgentStep, type AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { fakeCryptSharedLib } from './support/crypt-shared'
import { openaiReply, startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply } from './support/agent'
import type { OptionalModules } from '../src/optional/modules'
import { AGENT_CALL_HEADER } from '../src/ai/agent/calls'
import { runTool, type ToolEnv } from '../src/ai/agent/execute'
import { agentConnections } from '../src/ai/agent/turn'
import { H, LOCAL_COOKIE_VALUE, LOCAL_KEY } from './helpers'

/**
 * W8 × W6: what client-side encryption makes sensitive never reaches an AI provider. The assistant
 * and the agent read values as stored (ciphertext, never decrypted), never read the key vault or
 * Queryable Encryption's metadata collections, and the agent proposes no document writes there (the
 * client that would carry them does not encrypt).
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

const present: OptionalModules = {
  distribution: 'npm',
  clientEncryption: { status: 'available', version: '6.5.0' },
  kerberos: { status: 'missing', version: null },
}
const lines = (payload: string) =>
  payload
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as AiChatLine)
const steps = (out: AiChatLine[]) =>
  out.flatMap((l) =>
    l.type === 'step' && l.step.state !== 'running' && l.step.state !== 'awaiting' ? [l.step] : [],
  ) as AiAgentStep[]

async function encryptedAgent() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo, {}, { optionalModules: present })
  closers.push(h.t.close)
  const { ctx } = h.t.app
  ctx.connections.update(h.connectionId, {
    settings: ConnectionSettingsSchema.parse({
      hosts: [{ host: '127.0.0.1', port: mongo.port }],
      serverSelectionTimeoutMS: 3_000,
      encryption: {
        enabled: true,
        keyVaultNamespace: 'encryption.__keyVault',
        kms: { local: { key: 'A'.repeat(128) } },
        cryptSharedLibPath: fakeCryptSharedLib(),
      },
    }),
  })
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  await inject('POST', 'ai/providers', {
    name: 'Fake',
    kind: 'openai',
    baseUrl: `${fake.url}/v1`,
    model: 'm',
    samples: true,
  })
  await inject('PUT', 'me/ai-agent', { on: true })
  const once = (calls: FakeCall[]) =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text: 'ok' })))
  const decrypting = vi.spyOn(ctx.manager, 'getClient')
  const decrypted = () => decrypting.mock.calls.some(([, as]) => as?.decrypt === true)
  return { h, fake, inject, once, decrypted }
}

describe('W8 × W6: the agent and client-side encryption', () => {
  it('reads documents for the provider as stored, never through the decrypting client', async () => {
    const { once, inject, decrypted } = await encryptedAgent()
    const db = `enc${randomUUID().slice(0, 8)}`
    await client.db(db).collection('people').insertOne({ name: 'Ana' })
    once([{ name: 'find_documents', args: { connection: 'Test', database: db, collection: 'people' } }])
    const out = lines((await inject('POST', 'ai/agent', { message: 'people', documents: true })).payload)
    expect(steps(out)[0]).toMatchObject({ tool: 'find_documents', state: 'done' })
    expect(decrypted()).toBe(false)
  })

  it('never reads the key vault or Queryable Encryption’s metadata collections', async () => {
    const { once, inject } = await encryptedAgent()
    for (const [database, collection] of [
      ['encryption', '__keyVault'],
      ['shop', 'enxcol_.patients.esc'],
    ]) {
      once([{ name: 'find_documents', args: { connection: 'Test', database, collection } }])
      const out = lines((await inject('POST', 'ai/agent', { message: 'keys', documents: true })).payload)
      expect(steps(out)[0], collection).toMatchObject({ state: 'refused', reason: 'credential_collection' })
    }
  })

  // Re-review item 1, abuse case: dropping the database that holds the key vault (or the key vault
  // itself, or QE metadata) deletes every data key; the agent never proposes it. Asked of the tool
  // itself, so a regression shows as a proposal at once, not as a turn waiting for an answer.
  it('never proposes to drop the key vault, its metadata, or the database that holds it', async () => {
    const { h } = await encryptedAgent()
    const { ctx } = h.t.app
    await client
      .db('encryption')
      .collection('__keyVault')
      .insertOne({ keyAltNames: ['k'] })
    const principal = {
      kind: 'local',
      userId: 'local',
      username: 'owner',
      role: 'admin',
      csrfToken: 'c',
    } as unknown as ToolEnv['principal']
    const connections = agentConnections(ctx, principal, null)
    const env: ToolEnv = {
      app: h.t.app,
      ctx,
      principal,
      auth: {} as ToolEnv['auth'],
      connections,
      recheck: (c) => c,
      documents: false,
      language: 'en',
    }
    const label = connections[0]!.label
    for (const [tool, args] of [
      ['drop_database', { connection: label, database: 'encryption' }],
      ['drop_collection', { connection: label, database: 'encryption', collection: '__keyVault' }],
      ['drop_collection', { connection: label, database: 'shop', collection: 'enxcol_.p.esc' }],
    ] as const) {
      const out = await runTool(env, tool, args)
      expect(out.type, `${tool} ${JSON.stringify(args)}`).toBe('result')
      expect(out.step).toMatchObject({ state: 'refused', reason: 'system_namespace' })
      expect(out).not.toHaveProperty('proposal')
    }
    expect(await client.db('encryption').collection('__keyVault').countDocuments()).toBeGreaterThan(0)
  })

  it('proposes no document writes on such a connection (they would not be encrypted)', async () => {
    const { once, inject } = await encryptedAgent()
    const db = `enc${randomUUID().slice(0, 8)}`
    once([
      {
        name: 'insert_documents',
        args: { connection: 'Test', database: db, collection: 'people', documents: '[{"ssn":"1"}]' },
      },
    ])
    const out = lines((await inject('POST', 'ai/agent', { message: 'insert' })).payload)
    expect(steps(out)).toEqual([
      expect.objectContaining({ tool: 'insert_documents', state: 'refused', reason: 'encrypted_connection' }),
    ])
    expect(out.some((l) => l.type === 'step' && l.step.state === 'awaiting')).toBe(false)
    expect(await client.db(db).collection('people').countDocuments()).toBe(0)
  })

  // Defence in depth: a document write the agent would carry is refused by the route itself.
  it('has its document writes refused by the routes too', async () => {
    const { h } = await encryptedAgent()
    const { ctx } = h.t.app
    const token = ctx.ai.agent.calls.issue({
      kind: 'local',
      localCookie: LOCAL_COOKIE_VALUE,
      localKey: LOCAL_KEY,
      ip: '127.0.0.1',
      host: undefined,
    })
    const res = await h.t.app.inject({
      method: 'POST',
      url: `/api/connections/${h.connectionId}/databases/shop/collections/people/documents`,
      headers: { ...H, 'x-csrf-token': ctx.localCsrfToken, [AGENT_CALL_HEADER]: token },
      payload: { document: '{"ssn": "1"}' },
    })
    expect(res.json().details).toMatchObject({ reason: 'encrypted_connection' })
  })
})

describe('W8 × 4a: the assistant and client-side encryption', () => {
  it('sends a collection’s samples as stored, never decrypted', async () => {
    const { h, fake, decrypted } = await encryptedAgent()
    const db = `enc${randomUUID().slice(0, 8)}`
    await client.db(db).collection('orders').insertOne({ qty: 1 })
    fake.reply(openaiReply('```json\n{ filter: {} }\n```'))
    const res = await h.call('POST', `/databases/${db}/collections/orders/ai`, {
      action: 'describe',
      language: 'en',
      samples: { count: 1 },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(decrypted()).toBe(false)
  })

  it('never sends the key vault as context', async () => {
    const { h } = await encryptedAgent()
    const res = await h.call('POST', `/databases/encryption/collections/__keyVault/ai`, {
      action: 'query',
      prompt: 'keys',
      language: 'en',
    })
    expect(res.json().details).toMatchObject({ reason: 'credential_collection' })
  })
})
