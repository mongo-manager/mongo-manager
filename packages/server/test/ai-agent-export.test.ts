// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiAgentStep, AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamAdminHarness } from './support/data'
import { runSqlPlugin } from './support/sql-plugin'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf, namedConnection } from './support/agent'
import { restrictedApp } from './support/restricted'
import { H } from './helpers'

/**
 * The AI database manager (design 2026-10-25, C1): an export as a card — the person's own export
 * (data:export, their rights and hidden fields), started on their click and followed as a job; never
 * a write pipeline, server JavaScript, or one of MongoDB's own namespaces, and no value told.
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

const steps = (out: AiChatLine[]) =>
  out.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))

async function agent() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
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
  await inject('PUT', 'me/ai-agent', { on: true })
  const db = `c1${randomUUID().slice(0, 8)}`
  const once = (calls: FakeCall[], text = 'ok') =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text })))
  const turn = async (message: string) =>
    (await inject('POST', 'ai/agent', { message })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
  const toldJson = () => {
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
  }
  const card = async (calls: FakeCall[]) => {
    once(calls)
    const stream = await agentTurn(h.t.app, h.headers, { message: 'do it' })
    const awaiting = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const attempt = (extra: object) =>
      inject('POST', `ai/agent/runs/${run}/decide`, { call: awaiting.step.id, decision: 'confirm', ...extra })
    const decide = async (decision: 'confirm' | 'decline', extra: object = {}) => {
      const res = await inject('POST', `ai/agent/runs/${run}/decide`, {
        call: awaiting.step.id,
        decision,
        ...extra,
      })
      await stream.ended
      return { res, ended: steps(stream.lines).at(-1)! }
    }
    return { step: awaiting.step, attempt, decide }
  }
  return { h, fake, db, inject, once, turn, toldJson, card }
}

describe('an export as a card (C1)', () => {
  it('exports a query on a card that says how many documents go, and follows its job', async () => {
    const { h, db, card, fake } = await agent()
    await client
      .db(db)
      .collection('items')
      .insertMany([
        { n: 1, label: 'c1-unseen-a' },
        { n: 2, label: 'c1-unseen-b' },
        { n: 3, label: 'c1-unseen-c' },
      ])
    const asked = await card([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'csv',
          filter: '{"n":{"$gte":2}}',
        },
      },
    ])
    expect(asked.step.proposal).toMatchObject({
      payload: { export: `${db}.items`, format: 'csv', filter: { n: { $gte: { $numberInt: '2' } } } },
      preview: { documents: 2 },
    })
    const { ended } = await asked.decide('confirm')
    expect(ended).toMatchObject({ state: 'done', summary: { started: true, job: expect.any(String) } })
    const job = h.t.app.ctx.jobs.get(String(ended.summary!.job))
    expect(job).toMatchObject({ kind: 'data.export' })
    const row = h.t.app.ctx.audit.list({ action: 'transfer.export.start' }).at(0)!
    expect((row.details as { agent?: unknown }).agent).toMatchObject({ call: asked.step.id })
    // No value reaches the provider.
    expect(JSON.stringify(fake.requests.map((r) => r.body))).not.toContain('c1-unseen')
  })

  it('exports a read-only pipeline, never one that writes nor server JavaScript', async () => {
    const { db, card, once, turn } = await agent()
    await client.db(db).collection('items').insertOne({ n: 1 })
    const asked = await card([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'json',
          pipeline: '[{"$match":{"n":1}}]',
        },
      },
    ])
    expect(asked.step.proposal).toMatchObject({
      payload: { format: 'json', pipeline: [{ $match: { n: { $numberInt: '1' } } }] },
    })
    await asked.decide('decline')
    once([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'json',
          pipeline: '[{"$out":"x"}]',
        },
      },
    ])
    expect(steps(await turn('export'))[0]).toMatchObject({ state: 'refused', reason: 'write_pipeline' })
    once([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'csv',
          filter: '{"$where":"1"}',
        },
      },
    ])
    expect(steps(await turn('export'))[0]).toMatchObject({ state: 'refused', reason: 'server_js' })
    once([
      {
        name: 'export_documents',
        args: { connection: 'Test', database: 'admin', collection: 'system.users', format: 'csv' },
      },
    ])
    expect(steps(await turn('export'))[0]).toMatchObject({ state: 'refused', reason: 'system_namespace' })
  })

  it('never offers an export to someone who may not export', async () => {
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
        enabled: true,
        isDefault: true,
      },
      null,
    )
    // An editor of the app who only views this connection: no export there.
    const person = as('editor')
    ctx.grants.set(connectionId, person.id, 'viewer')
    const s = ctx.sessions.create(person.id, {})
    const call = (method: 'POST' | 'PUT', url: string, payload: object) =>
      t.app.inject({
        method,
        url,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
        payload,
      })
    await call('PUT', '/api/me/ai-agent', { on: true })
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                {
                  name: 'export_documents',
                  args: { connection: 'M', database: 'shop', collection: 'orders', format: 'csv' },
                },
              ],
            }
          : { text: 'ok' },
      ),
    )
    const out = (await call('POST', '/api/ai/agent', { message: 'export' })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
    expect(steps(out)[0], JSON.stringify(out).slice(0, 400)).toMatchObject({
      state: 'refused',
      // Who may not export from a connection may not use the assistant there either (ai:use comes with
      // data:export): the connection is not offered at all — the export's own check stands behind it.
      reason: 'connection_unknown',
    })
    expect(steps(out)[0]!.proposal).toBeUndefined()
  })
})

// Review of C1: what the card shows is what goes; where the agent may not propose changes, no card.
describe('an export as a card: the review of C1', () => {
  // Review of 1.0.1 (I1): an SQL file comes with the SQL → MongoDB plugin, as the export route says.
  it('proposes no SQL file while the SQL → MongoDB plugin does not run', async () => {
    const { db, once, turn } = await agent()
    once([
      {
        name: 'export_documents',
        args: { connection: 'Test', database: db, collection: 'items', format: 'sql' },
      },
    ])
    const out = await turn('export it as SQL')
    expect(steps(out)[0], JSON.stringify(out).slice(0, 400)).toMatchObject({
      state: 'refused',
      reason: 'sql_plugin_off',
    })
    expect(steps(out)[0]!.proposal).toBeUndefined()
  })

  it('shows the find or the pipeline it sends, with the file’s options', async () => {
    const { h, db, card } = await agent()
    runSqlPlugin(h.t.app)
    await client
      .db(db)
      .collection('items')
      .insertMany([{ n: 1 }, { n: 2 }])
    const found = await card([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'sql',
          dialect: 'mysql',
          gzip: true,
          filter: '{"n":{"$gte":1}}',
          sort: '{"n":-1}',
          limit: 1,
          pipeline: '',
        },
      },
    ])
    expect(found.step.proposal).toMatchObject({
      payload: {
        export: `${db}.items`,
        format: 'sql',
        dialect: 'mysql',
        gzip: true,
        filter: { n: { $gte: { $numberInt: '1' } } },
        sort: { n: { $numberInt: '-1' } },
        limit: 1,
      },
      preview: { documents: 1, format: 'sql', dialect: 'mysql', compressed: true },
    })
    await found.decide('decline')
    const piped = await card([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'csv',
          pipeline: '[{"$match":{"n":2}}]',
          filter: '',
        },
      },
    ])
    expect(piped.step.proposal).toMatchObject({
      payload: { pipeline: [{ $match: { n: { $numberInt: '2' } } }] },
    })
    await piped.decide('decline')
  })

  it('says a whole collection’s count as an estimate, and takes {} beside a pipeline as none', async () => {
    const { db, card } = await agent()
    await client
      .db(db)
      .collection('items')
      .insertMany([{ n: 1 }, { n: 2 }])
    const whole = await card([
      {
        name: 'export_documents',
        args: { connection: 'Test', database: db, collection: 'items', format: 'csv' },
      },
    ])
    expect(whole.step.proposal!.preview).toMatchObject({ documents: 2, documentsAbout: true })
    await whole.decide('decline')
    const piped = await card([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'csv',
          filter: '{}',
          pipeline: '[{"$match":{}}]',
        },
      },
    ])
    expect(piped.step.proposal).toMatchObject({ payload: { pipeline: [{ $match: {} }] } })
    await piped.decide('decline')
    // Re-review of C3 (nit): {} sent as an object is none too.
    const object = await card([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'csv',
          filter: {},
          pipeline: '[{"$match":{}}]',
        },
      },
    ])
    expect(object.step.proposal).toMatchObject({ payload: { pipeline: [{ $match: {} }] } })
    await object.decide('decline')
  })

  it('refuses a limit beside a pipeline, a lookup into a credential, and where the agent may not propose', async () => {
    const { h, db, once, turn } = await agent()
    await client.db(db).collection('items').insertOne({ n: 1 })
    once([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'csv',
          pipeline: '[{"$match":{}}]',
          limit: 5,
        },
      },
    ])
    expect(steps(await turn('export'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    once([
      {
        name: 'export_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          format: 'json',
          pipeline: '[{"$lookup":{"from":{"db":"admin","coll":"system.users"},"pipeline":[],"as":"u"}}]',
        },
      },
    ])
    expect(steps(await turn('export'))[0]).toMatchObject({ state: 'refused' })
    namedConnection(h.t.app, mongo.port, 'NoWrites', { aiAgentWrites: false })
    once([
      {
        name: 'export_documents',
        args: { connection: 'NoWrites', database: db, collection: 'items', format: 'csv' },
      },
    ])
    expect(steps(await turn('export'))[0]).toMatchObject({ state: 'refused', reason: 'agent_writes_off' })
  })
})

describe('an export’s filter, the gate’s for everyone (final review of wave C)', () => {
  it('refuses an export picked by a personal field for someone nothing is hidden from', async () => {
    const fake = await startFakeAi()
    closers.push(fake.close)
    const h = await teamAdminHarness(mongo, { ai: { privateNetworks: ['127.0.0.1/32'] } } as never)
    closers.push(h.t.close)
    const inject = (method: 'POST' | 'PUT', path: string, payload?: object) =>
      h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
    await inject('POST', 'ai/providers', { name: 'F', kind: 'openai', baseUrl: `${fake.url}/v1`, model: 'm' })
    await inject('PUT', 'me/ai-agent', { on: true })
    const db = `c1t${randomUUID().slice(0, 6)}`
    await client
      .db(db)
      .collection('items')
      .insertMany([{ email: 'a@x.test' }, { email: 'b@x.test' }])
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'items', field: 'email' }])
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                {
                  name: 'export_documents',
                  args: {
                    connection: 'Test',
                    database: db,
                    collection: 'items',
                    format: 'csv',
                    filter: '{"email":{"$regex":"^a"}}',
                  },
                },
              ],
            }
          : { text: 'ok' },
      ),
    )
    const out = (await inject('POST', 'ai/agent', { message: 'x' })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
    expect(steps(out).at(-1)).toMatchObject({ state: 'refused', reason: 'personal_field' })
  })

  it('refuses an export whose filter names a personal field since its card, on the click', async () => {
    const { h, db, card } = await agent()
    await client
      .db(db)
      .collection('items')
      .insertMany([
        { n: 1, email: 'a@x.test' },
        { n: 2, email: 'b@x.test' },
      ])
    const args = { connection: 'Test', database: db, collection: 'items', format: 'csv' }
    // Rules named after the card: refused on the click, no job started.
    h.t.app.ctx.personalFields.set(h.connectionId, [])
    const asked = await card([{ name: 'export_documents', args: { ...args, filter: '{"n":{"$gte":2}}' } }])
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'items', field: 'n' }])
    const { ended } = await asked.decide('confirm')
    expect(ended).toMatchObject({ state: 'error', reason: 'personal_field' })
    expect(h.t.app.ctx.audit.list({ action: 'transfer.export.start' })).toHaveLength(0)
  })
})
