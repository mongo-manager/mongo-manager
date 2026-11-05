// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Collection, MongoClient, MongoServerError, type Document } from 'mongodb'
import {
  ConnectionSettingsSchema,
  type AiAgentStep,
  type AiChatLine,
  type AiProviderView,
} from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamAdminHarness, type DataHarness } from './support/data'
import { H } from './helpers'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, namedConnection } from './support/agent'
import { AiLimits } from '../src/ai/limits'
import { agentConnections } from '../src/ai/agent/turn'

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
const ended = (out: AiChatLine[]) =>
  out.flatMap((l) =>
    l.type === 'step' && l.step.state !== 'running' && l.step.state !== 'awaiting' ? [l.step] : [],
  ) as AiAgentStep[]

/**
 * `team`: as an administrator signed in, in team mode — someone the rules hide nothing from unless
 * they hide it from themselves (user request 2026-10-24: local mode always hides it now).
 */
async function agent(over: Record<string, unknown> = {}, config: Record<string, unknown> = {}, team = false) {
  const fake = await startFakeAi()
  closers.push(fake.close)
  // Team mode reaches a provider on this machine only where an administrator listed it.
  const h: DataHarness & { hide?: (hidden: boolean) => void } = team
    ? await teamAdminHarness(mongo, { ai: { privateNetworks: ['127.0.0.1/32'] }, ...config } as never)
    : await dataHarness(mongo, config as never)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  const provider = (
    await inject('POST', 'ai/providers', {
      name: 'F',
      kind: 'openai',
      baseUrl: `${fake.url}/v1`,
      model: 'm',
      ...over,
    })
  ).json() as AiProviderView
  await inject('PUT', 'me/ai-agent', { on: true })
  const once = (calls: FakeCall[]) =>
    fake.reply(
      agentReply((c) => (c.results.length === 0 ? { calls } : { text: `ok: ${c.results.join(' | ')}` })),
    )
  const sent = () => JSON.stringify(fake.requests.map((r) => r.body))
  return { fake, h, inject, provider, once, sent }
}

describe('twelfth review of explain masking: a collection’s statistics', () => {
  it('tell the agent its sizes are hidden, not unknown, where rules hide personal data', async () => {
    const { h, once, inject, sent } = await agent()
    const db = `st${randomUUID().slice(0, 8)}`
    await client.db(db).collection('people').insertOne({ name: 'A', phone: '555-0101' })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'phone' }])
    once([
      { name: 'collection_stats', args: { connection: 'Test', database: db, collection: 'people' } },
      { name: 'list_databases', args: { connection: 'Test' } },
    ])
    const res = await inject('POST', 'ai/agent', { message: 'stats' })
    expect(ended(lines(res.payload))[0]).toMatchObject({ tool: 'collection_stats', state: 'done' })
    expect(sent()).toContain('\\"sizesHidden\\":true')
    expect(sent()).toContain('\\"size\\":null')
    expect(sent()).toContain('\\"count\\":1')
    // Nor is a database’s size, in the list (nit).
    expect(sent()).toContain('\\"sizeHidden\\":true')
  })
})

describe('ninth review of explain masking: a plan over a personal index', () => {
  it('is refused to the agent, as a refusal and not a failure', async () => {
    const { h, once, inject } = await agent({ samples: true })
    const db = `pi${randomUUID().slice(0, 8)}`
    const people = client.db(db).collection('people')
    await people.insertMany([
      { name: 'A', contact: { phone: ['555-0101', '555-0102'] } },
      { name: 'B', contact: { phone: ['555-0103'] } },
    ])
    await people.createIndex({ name: 1, 'contact.phone': 1 })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'contact.phone' }])
    const ns = { connection: 'Test', database: db, collection: 'people' }
    try {
      once([{ name: 'explain_query', args: { ...ns, filter: '{ "name": "A" }' } }])
      const out = lines((await inject('POST', 'ai/agent', { message: 'probe', documents: true })).payload)
      expect(ended(out).map((s) => [s.tool, s.state, s.reason])).toEqual([
        ['explain_query', 'refused', 'personal_index'],
      ])
    } finally {
      await client.db(db).dropDatabase()
    }
  })
})

describe('security review of W6.3: counts never answer a filter on personal data (I2)', () => {
  it('refuses a filter, a sort or a pipeline that names a personal field, before anything runs', async () => {
    // Someone the rules hide nothing from: an administrator in team mode.
    const { h, once, inject, sent } = await agent({ samples: true }, {}, true)
    const db = `pf${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('people')
      .insertMany([
        { name: 'A', email: 'a@secret.example', contact: { phone: '555-0101' } },
        { name: 'B', email: 'b@secret.example', contact: { phone: '555-0102' } },
      ])
    h.t.app.ctx.personalFields.set(h.connectionId, [
      { db, coll: 'people', field: 'email' },
      { db, coll: 'people', field: 'contact.phone' },
    ])
    const ns = { connection: 'Test', database: db, collection: 'people' }
    const calls: FakeCall[] = [
      { name: 'count_documents', args: { ...ns, filter: '{ "email": { "$regex": "^a" } }' } },
      { name: 'find_documents', args: { ...ns, filter: '{ "email": { "$regex": "^a" } }' } },
      { name: 'find_documents', args: { ...ns, sort: '{ "email": 1 }' } },
      { name: 'count_documents', args: { ...ns, filter: '{ "contact": { "phone": "555-0101" } }' } },
      {
        name: 'count_documents',
        args: { ...ns, filter: '{ "$expr": { "$eq": [{ "$substr": ["$email", 0, 1] }, "a"] } }' },
      },
      {
        name: 'run_aggregation',
        args: { ...ns, pipeline: '[{ "$match": { "email": { "$regex": "^a" } } }, { "$count": "n" }]' },
      },
      { name: 'explain_query', args: { ...ns, filter: '{ "email": "a@secret.example" }' } },
      { name: 'delete_documents', args: { ...ns, filter: '{ "email": { "$regex": "^a" } }' } },
    ]
    once(calls)
    const out = lines((await inject('POST', 'ai/agent', { message: 'probe', documents: true })).payload)
    // Refused (denied), not failed (re-review minor 1).
    expect(ended(out).map((s) => [s.tool, s.state, s.reason])).toEqual(
      calls.map((c) => [c.name, 'refused', 'personal_field']),
    )
    expect(h.t.app.ctx.audit.list({ action: 'ai.agent.tool' }).every((r) => r.outcome === 'denied')).toBe(
      true,
    )
    expect(out.some((l) => l.type === 'step' && l.step.state === 'awaiting')).toBe(false)
    // A filter on other fields still answers.
    once([{ name: 'count_documents', args: { ...ns, filter: '{ "name": "A" }' } }])
    const ok = lines((await inject('POST', 'ai/agent', { message: 'count' })).payload)
    expect(ended(ok)[0]).toMatchObject({ state: 'done', summary: { count: 1 } })
    // No value went back (the model's own guesses are its words, not the documents').
    expect(sent()).not.toContain('b@secret.example')
    expect(sent()).not.toContain('555-0102')
  })

  it('an index build that would answer on personal data (unique, a partial filter) is refused before its card', async () => {
    const { h, once, inject } = await agent()
    const db = `pi${randomUUID().slice(0, 8)}`
    await client.db(db).collection('people').insertOne({ email: 'x@secret.example' })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    const ns = { connection: 'Test', database: db, collection: 'people' }
    once([
      {
        name: 'create_index',
        args: {
          ...ns,
          keys: '{ "name": 1 }',
          partialFilterExpression: '{ "email": { "$exists": true, "$gt": "m" } }',
        },
      },
      { name: 'create_index', args: { ...ns, keys: '{ "email": 1 }', unique: true } },
    ])
    const out = lines((await inject('POST', 'ai/agent', { message: 'index' })).payload)
    expect(ended(out).map((s) => s.reason)).toEqual(['personal_field', 'personal_field'])
  })
})

// Final review of explain masking (P-1): the gate rewrites as often as it refuses (a comparison of a
// sub-document that holds a hidden value, a sort by one, a group by one); a person no rule hides
// anything from would otherwise run the original and the provider learn the hidden value, a step
// at a time. A find or a count it would rewrite is refused; a pipeline runs as the gate rewrote it.
describe('final review of explain masking: what the gate rewrites is not run as written (P-1)', () => {
  it('refuses a find or a count the gate would rewrite, and runs a pipeline as it rewrote it', async () => {
    // Someone the rules hide nothing from: an administrator in team mode.
    const { h, once, inject, sent } = await agent({ samples: true }, {}, true)
    const db = `pr${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('people')
      .insertMany([
        { name: 'A', profile: { email: 'a@secret.example' } },
        { name: 'B', profile: { email: 'z@secret.example' } },
      ])
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'profile.email' }])
    const ns = { connection: 'Test', database: db, collection: 'people' }
    try {
      // A comparison the gate rewrites (a sub-document compares as "***"), not one it refuses.
      const expr = '{ "$expr": { "$gt": ["$profile", { "email": "m" }] } }'
      const refused: FakeCall[] = [
        { name: 'find_documents', args: { ...ns, sort: '{ "profile": 1 }' } },
        { name: 'find_documents', args: { ...ns, filter: expr } },
        { name: 'count_documents', args: { ...ns, filter: expr } },
      ]
      once(refused)
      const out = lines((await inject('POST', 'ai/agent', { message: 'probe', documents: true })).payload)
      expect(ended(out).map((s) => [s.tool, s.state, s.reason])).toEqual(
        refused.map((c) => [c.name, 'refused', 'personal_field']),
      )
      // The comparison is answered as the gate rewrote it: alike for both, whatever their emails.
      once([
        {
          name: 'run_aggregation',
          args: {
            ...ns,
            pipeline:
              '[{ "$project": { "_id": 0, "name": 1, "t": { "$gt": ["$profile", { "email": "m" }] } } }]',
          },
        },
      ])
      const ran = lines((await inject('POST', 'ai/agent', { message: 'run', documents: true })).payload)
      expect(ended(ran)[0]).toMatchObject({ tool: 'run_aggregation', state: 'done' })
      const all = sent()
      const answers = [...all.matchAll(/\\+"t\\+":(true|false)/g)].map((m) => m[1])
      expect(answers).toEqual(['false', 'false'])
      expect(all).not.toContain('z@secret.example')
      // A find ordered by what is shown still answers.
      once([{ name: 'find_documents', args: { ...ns, sort: '{ "name": -1 }' } }])
      const ok = lines((await inject('POST', 'ai/agent', { message: 'find', documents: true })).payload)
      expect(ended(ok)[0]).toMatchObject({ tool: 'find_documents', state: 'done' })
    } finally {
      await client.db(db).dropDatabase()
    }
  })
})

// Final review of the agent's gate: what is explained, changed or stored as a view is gated too, for
// a person no rule hides anything from; a restricted person's own route applies the rewrite.
describe('final review of the agent’s gate', () => {
  async function people(h: Awaited<ReturnType<typeof agent>>['h'], shown: boolean) {
    const hide = h.hide
    if (!hide) throw new Error('people() needs an administrator in team mode: agent(…, true)')
    const db = `ag${randomUUID().slice(0, 8)}`
    const coll = client.db(db).collection('people')
    await coll.insertMany([
      { name: 'A', profile: { email: 'a@secret.example' } },
      { name: 'B', profile: { email: 'z@secret.example' } },
    ])
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'profile.email' }])
    // Shown, or hidden from themselves ("hide from me", user request 2026-10-24).
    hide(!shown)
    return { db, coll, ns: { connection: 'Test', database: db, collection: 'people' } }
  }
  const t = (pipeline: unknown) => JSON.stringify(pipeline)

  it('explains no plan over an index holding personal data, to anyone (I-1)', async () => {
    const { h, once, inject, sent } = await agent({ samples: true }, {}, true)
    const { db, coll, ns } = await people(h, true)
    try {
      await coll.createIndex({ name: 1, 'profile.email': 1 })
      once([
        { name: 'explain_query', args: { ...ns, filter: '{ "name": "A" }' } },
        { name: 'explain_query', args: { ...ns, pipeline: t([{ $match: { name: 'A' } }]) } },
      ])
      const out = lines((await inject('POST', 'ai/agent', { message: 'plan', documents: true })).payload)
      expect(ended(out).map((s) => [s.tool, s.state, s.reason])).toEqual([
        ['explain_query', 'refused', 'personal_index'],
        ['explain_query', 'refused', 'personal_index'],
      ])
      // Nor where no index holds it: the plan is sent.
      await coll.dropIndexes()
      await coll.createIndex({ name: 1 })
      once([{ name: 'explain_query', args: { ...ns, filter: '{ "name": "A" }' } }])
      const ok = lines((await inject('POST', 'ai/agent', { message: 'plan' })).payload)
      expect(ended(ok)[0]).toMatchObject({ tool: 'explain_query', state: 'done' })
      // A pipeline the gate rewrote is explained as it would run, and said to be (M-4).
      once([{ name: 'explain_query', args: { ...ns, pipeline: t([{ $sort: { profile: 1 } }]) } }])
      const rewritten = lines((await inject('POST', 'ai/agent', { message: 'plan' })).payload)
      expect(ended(rewritten)[0]).toMatchObject({ tool: 'explain_query', state: 'done' })
      expect(sent()).toContain('rewritten')
      // A find the gate orders (where an index could order it by what is hidden): explained with the
      // gate's order, and said (nit).
      await coll.createIndex({ name: 1, 'profile.email': 1 })
      const before = sent().split('An index here may order').length
      once([{ name: 'explain_query', args: { ...ns, filter: '{}', sort: '{ "name": -1 }' } }])
      const ordered = lines((await inject('POST', 'ai/agent', { message: 'plan' })).payload)
      expect(ended(ordered).map((s) => s.state)).toEqual(['done'])
      expect(sent().split('An index here may order').length).toBeGreaterThan(before)
    } finally {
      await client.db(db).dropDatabase()
    }
  })

  it('proposes no update or view that would read what is hidden (I-2)', async () => {
    const { h, once, inject } = await agent({ samples: true }, {}, true)
    const { db, ns } = await people(h, true)
    try {
      const refused: FakeCall[] = [
        {
          name: 'update_documents',
          args: { ...ns, filter: '{}', update: t([{ $set: { note: '$profile.email' } }]) },
        },
        {
          name: 'update_documents',
          args: { ...ns, filter: '{}', update: t({ $max: { profile: { email: 'm' } } }) },
        },
        // One the gate rewrites rather than refuses: a comparison of the sub-document, as "***".
        {
          name: 'update_documents',
          args: {
            ...ns,
            filter: '{}',
            update: t([{ $set: { n: { $cond: [{ $gt: ['$profile', { email: 'm' }] }, 1, 0] } } }]),
          },
        },
        {
          name: 'create_collection',
          args: {
            connection: 'Test',
            database: db,
            collection: 'v',
            kind: 'view',
            viewOn: 'people',
            pipeline: t([{ $match: { 'profile.email': { $regex: '^a' } } }]),
          },
        },
        {
          name: 'create_collection',
          args: {
            connection: 'Test',
            database: db,
            collection: 'v',
            kind: 'view',
            viewOn: 'people',
            pipeline: t([{ $match: { $expr: { $gt: ['$profile', { email: 'm' }] } } }]),
          },
        },
      ]
      once(refused)
      const out = lines((await inject('POST', 'ai/agent', { message: 'change' })).payload)
      expect(ended(out).map((s) => [s.tool, s.state, s.reason])).toEqual(
        refused.map((c) => [c.name, 'refused', 'personal_field']),
      )
      // What reads nothing hidden is still proposed (the person confirms it), one change a turn;
      // declined here.
      const proposals: FakeCall[] = [
        {
          name: 'update_documents',
          args: { ...ns, filter: '{ "name": "A" }', update: t({ $set: { seen: true } }) },
        },
        {
          name: 'create_collection',
          args: {
            connection: 'Test',
            database: db,
            collection: 'v',
            kind: 'view',
            viewOn: 'people',
            pipeline: t([{ $project: { name: 1 } }]),
          },
        },
      ]
      for (const call of proposals) {
        once([call])
        const turn = await agentTurn(h.t.app, h.headers, { message: 'change' })
        const card = (await turn.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
          step: AiAgentStep
        }
        expect(card.step.tool).toBe(call.name)
        const run = (turn.lines.find((l) => l.type === 'chat') as { run: string }).run
        await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'decline' })
        await turn.ended
      }
    } finally {
      await client.db(db).dropDatabase()
    }
  })

  // Third review of the agent's gate: a stored view runs as it is, its $limit in MongoDB's order (I-1);
  // an insert under a unique index over personal data answers by its duplicate key (M-2); a change is
  // gated again when confirmed (M-1); sizes are hidden where rules apply, whoever asks (M-5).
  it('stores no view whose order the gate would set, inserts nothing a unique index would answer', async () => {
    const { h, once, inject, sent } = await agent({ samples: true }, {}, true)
    const { db, coll, ns } = await people(h, true)
    try {
      await coll.createIndex({ name: 1, 'profile.email': 1 })
      await client.db(db).createCollection('accounts')
      await client.db(db).collection('accounts').createIndex({ 'profile.email': 1 }, { unique: true })
      h.t.app.ctx.personalFields.set(h.connectionId, [
        { db, coll: 'people', field: 'profile.email' },
        { db, coll: 'accounts', field: 'profile.email' },
      ])
      const calls: FakeCall[] = [
        {
          name: 'create_collection',
          args: {
            connection: 'Test',
            database: db,
            collection: 'first',
            kind: 'view',
            viewOn: 'people',
            pipeline: t([{ $match: { name: 'A' } }, { $limit: 1 }]),
          },
        },
        {
          name: 'insert_documents',
          args: {
            connection: 'Test',
            database: db,
            collection: 'accounts',
            documents: t([{ profile: { email: 'guess@secret.example' } }]),
          },
        },
      ]
      once(calls)
      const out = lines((await inject('POST', 'ai/agent', { message: 'change' })).payload)
      expect(ended(out).map((s) => [s.tool, s.state, s.reason])).toEqual([
        ['create_collection', 'refused', 'personal_field'],
        ['insert_documents', 'refused', 'personal_field'],
      ])
      // Sizes where rules apply are not sent, though no rule hides anything from this person.
      once([
        { name: 'collection_stats', args: ns },
        { name: 'list_databases', args: { connection: 'Test' } },
      ])
      await inject('POST', 'ai/agent', { message: 'stats' })
      expect(sent()).toContain('\\"sizesHidden\\":true')
      expect(sent()).toContain('\\"sizeHidden\\":true')
      // A proposal is gated again when confirmed: a rule added meanwhile refuses it.
      once([
        {
          name: 'update_documents',
          args: { ...ns, filter: '{ "name": "A" }', update: t({ $set: { seen: true } }) },
        },
      ])
      const turn = await agentTurn(h.t.app, h.headers, { message: 'change' })
      const card = (await turn.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
        step: AiAgentStep
      }
      h.t.app.ctx.personalFields.set(h.connectionId, [
        { db, coll: 'people', field: 'profile.email' },
        { db, coll: 'people', field: 'name' },
      ])
      const run = (turn.lines.find((l) => l.type === 'chat') as { run: string }).run
      await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'confirm' })
      const end = (await turn.waitFor(
        (l) =>
          l.type === 'step' &&
          l.step.id === card.step.id &&
          l.step.state !== 'awaiting' &&
          l.step.state !== 'running',
      )) as { step: AiAgentStep }
      expect(end.step).toMatchObject({ state: 'error', reason: 'personal_field' })
      await turn.ended
      expect(await coll.countDocuments({ seen: true })).toBe(0)
    } finally {
      await client.db(db).dropDatabase()
    }
  })

  // Fourth review of the agent's gate: the _id index answers a duplicate key too (M-1); a stored view
  // lives past today's indexes (M-2) yet one that does not depend on the order is stored (M-3); a
  // unique index whose filter reads personal data answers for any document (M-4), a compound one's
  // other keys for none (nit); an insert is gated again when confirmed (M-7).
  it('inserts nothing a unique index could answer for, and stores a view by what depends on the order', async () => {
    const { h, once, inject, sent } = await agent({ samples: true }, {}, true)
    const { db, ns } = await people(h, true)
    const at = (collection: string) => ({ connection: 'Test', database: db, collection })
    const view = (pipeline: unknown): FakeCall => ({
      name: 'create_collection',
      args: { ...at('v'), kind: 'view', viewOn: 'people', pipeline: t(pipeline) },
    })
    try {
      await client.db(db).createCollection('keyed')
      await client.db(db).createCollection('scoped')
      await client
        .db(db)
        .collection('scoped')
        .createIndex(
          { tenant: 1 },
          { unique: true, partialFilterExpression: { 'profile.email': { $gt: 'm' } } },
        )
      await client.db(db).createCollection('scoped2')
      await client
        .db(db)
        .collection('scoped2')
        .createIndex(
          { tenant: 1 },
          { unique: true, partialFilterExpression: { 'profile.email': { $gt: 'm' }, kind: 'x' } },
        )
      await client
        .db(db)
        .collection('scoped2')
        .insertOne({ tenant: 't', profile: { email: 'z@x' } })
      await client
        .db(db)
        .createCollection('clustered', { clusteredIndex: { key: { _id: 1 }, unique: true, name: 'byId' } })
      await client.db(db).createCollection('deep')
      await client.db(db).createCollection('tagged')
      await client
        .db(db)
        .collection('tagged')
        .createIndex(
          { tags: 1 },
          { unique: true, partialFilterExpression: { 'profile.email': { $exists: true } } },
        )
      await client
        .db(db)
        .collection('tagged')
        .insertOne({ tags: ['x'], profile: { email: 'z@x' } })
      await client.db(db).createCollection('pairs')
      await client.db(db).collection('pairs').createIndex({ tenant: 1, 'profile.email': 1 }, { unique: true })
      h.t.app.ctx.personalFields.set(h.connectionId, [
        { db, coll: 'people', field: 'profile.email' },
        { db, coll: 'keyed', field: '_id' },
        { db, coll: 'scoped', field: 'profile.email' },
        { db, coll: 'pairs', field: 'profile.email' },
        { db, coll: 'scoped2', field: 'profile.email' },
        { db, coll: 'clustered', field: '_id' },
        { db, coll: 'deep', field: '**.email' },
        { db, coll: 'tagged', field: 'profile.email' },
      ])
      const refused: FakeCall[] = [
        {
          name: 'insert_documents',
          args: { ...at('keyed'), documents: t([{ _id: 'alice@secret.example' }]) },
        },
        { name: 'insert_documents', args: { ...at('scoped'), documents: t([{ tenant: 't' }]) } },
        {
          name: 'insert_documents',
          args: { ...at('pairs'), documents: t([{ tenant: 't', profile: { email: 'g@x' } }]) },
        },
        // No index orders people by what is hidden today: a $limit is still checked in the gate's order.
        view([{ $match: { name: 'A' } }, { $limit: 1 }]),
        // Nor a join's arrays, though the view itself is in _id order (M-A).
        view([
          { $sort: { _id: 1 } },
          { $lookup: { from: 'people', localField: 'name', foreignField: 'name', as: 'same' } },
        ]),
        // A change to what a unique index's partial filter reads moves a document under it (M-B).
        {
          name: 'update_documents',
          args: { ...at('scoped2'), filter: '{}', update: t({ $set: { kind: 'x' } }) },
        },
        // A clustered collection's index answers by any name (M-E).
        {
          name: 'insert_documents',
          args: { ...at('clustered'), documents: t([{ _id: 'alice@secret.example' }]) },
        },
        // Emptying an array under a unique index whose filter reads what is hidden (M-1).
        {
          name: 'update_documents',
          args: { ...at('tagged'), filter: '{}', update: t({ $pull: { tags: 'x' } }) },
        },
        // A sub-document where a hidden value may lie below (nit).
        { name: 'insert_documents', args: { ...at('deep'), documents: t([{ _id: { email: 'g@x' } }]) } },
      ]
      once(refused)
      const out = lines((await inject('POST', 'ai/agent', { message: 'change' })).payload)
      expect(ended(out).map((s) => [s.tool, s.state, s.reason])).toEqual(
        refused.map((c) => [c.name, 'refused', 'personal_field']),
      )
      // The model is told why a unique index refused it (nit).
      expect(sent()).toContain('would tell, by a duplicate key')
      // What they may: a compound key's other field, a view in its own order or none at all.
      const proposed: FakeCall[] = [
        { name: 'insert_documents', args: { ...at('pairs'), documents: t([{ tenant: 't' }]) } },
        // A scalar _id cannot hold a hidden value below it (nit), nor a compound one holding none (M-1).
        { name: 'insert_documents', args: { ...at('deep'), documents: t([{ _id: 5 }]) } },
        { name: 'insert_documents', args: { ...at('deep'), documents: t([{ _id: { day: 1, user: 'u' } }]) } },
        view([{ $sort: { _id: 1 } }, { $limit: 1 }]),
        view([{ $match: { name: 'A' } }, { $project: { name: 1 } }]),
      ]
      for (const call of proposed) {
        once([call])
        const turn = await agentTurn(h.t.app, h.headers, { message: 'change' })
        const card = (await turn.waitFor((l) => l.type === 'step' && l.step.state !== 'running')) as {
          step: AiAgentStep
        }
        expect([card.step.tool, card.step.state, card.step.reason]).toEqual([
          call.name,
          'awaiting',
          undefined,
        ])
        const run = (turn.lines.find((l) => l.type === 'chat') as { run: string }).run
        await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'decline' })
        await turn.ended
      }
      // An insert is gated again when confirmed: a unique index built meanwhile refuses it.
      await client.db(db).createCollection('accounts')
      h.t.app.ctx.personalFields.set(h.connectionId, [
        { db, coll: 'people', field: 'profile.email' },
        { db, coll: 'accounts', field: 'profile.email' },
      ])
      once([
        {
          name: 'insert_documents',
          args: { ...at('accounts'), documents: t([{ profile: { email: 'g@x' } }]) },
        },
      ])
      const turn = await agentTurn(h.t.app, h.headers, { message: 'change' })
      const card = (await turn.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
        step: AiAgentStep
      }
      await client.db(db).collection('accounts').createIndex({ 'profile.email': 1 }, { unique: true })
      const run = (turn.lines.find((l) => l.type === 'chat') as { run: string }).run
      await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'confirm' })
      const end = (await turn.waitFor(
        (l) =>
          l.type === 'step' &&
          l.step.id === card.step.id &&
          l.step.state !== 'awaiting' &&
          l.step.state !== 'running',
      )) as { step: AiAgentStep }
      expect(end.step).toMatchObject({ state: 'error', reason: 'personal_field' })
      await turn.ended
      expect(await client.db(db).collection('accounts').countDocuments()).toBe(0)
      void ns
    } finally {
      await client.db(db).dropDatabase()
    }
  })

  // Fourth review of the agent's gate (M-7, nit): a plan whose check cannot finish is not sent, said
  // as such; a key vault's own rules apply with none of the connection's (M-5).
  it('sends no plan it could not check, and gates a key vault with no rules', async () => {
    const { h, once, inject } = await agent({ samples: true }, {}, true)
    const { db, coll, ns } = await people(h, true)
    try {
      await coll.createIndex({ name: 1 })
      let calls = 0
      const listIndexes = Collection.prototype.listIndexes
      vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        // The query's own check reads them first; the plan's check after the plan is read fails, as
        // a cursor does (its listing rejected; the lookup answers none).
        if (this.collectionName === 'people' && ++calls > 1)
          return { toArray: () => Promise.reject(new Error('listing failed')) } as never
        return listIndexes.apply(this, args as never)
      } as typeof listIndexes)
      once([{ name: 'explain_query', args: { ...ns, filter: '{ "name": "A" }' } }])
      const out = lines((await inject('POST', 'ai/agent', { message: 'plan' })).payload)
      expect(ended(out).map((s) => [s.tool, s.state, s.reason])).toEqual([
        ['explain_query', 'refused', 'plan_unchecked'],
      ])
      // Nor is an insert or a change made where the indexes cannot be read (M-D).
      once([
        {
          name: 'insert_documents',
          args: { ...ns, documents: t([{ name: 'C' }]) },
        },
        {
          name: 'update_documents',
          args: { ...ns, filter: '{ "name": "A" }', update: t({ $set: { seen: true } }) },
        },
      ])
      const blind = lines((await inject('POST', 'ai/agent', { message: 'change' })).payload)
      expect(ended(blind).map((s) => [s.tool, s.state, s.reason])).toEqual([
        ['insert_documents', 'refused', 'indexes_unread'],
        ['update_documents', 'refused', 'indexes_unread'],
      ])
      // A server's own failure is the tool's, said as a failure, not as a right (next round, M-5).
      vi.restoreAllMocks()
      vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (this.collectionName === 'people')
          return {
            toArray: () =>
              Promise.reject(new MongoServerError({ message: 'interrupted at shutdown', code: 91 })),
          } as never
        return listIndexes.apply(this, args as never)
      } as typeof listIndexes)
      once([{ name: 'insert_documents', args: { ...ns, documents: t([{ name: 'C' }]) } }])
      const down = lines((await inject('POST', 'ai/agent', { message: 'change' })).payload)
      expect(ended(down).map((s) => [s.tool, s.state, s.reason])).toEqual([
        ['insert_documents', 'error', 'tool_failed'],
      ])
      vi.restoreAllMocks()
      // A key vault another connection names is refused though this connection has no rules of its
      // own (as MongoDB's own collections are; the gate's key vault rules stand behind it).
      h.t.app.ctx.personalFields.set(h.connectionId, [])
      const vault = `kv${randomUUID().slice(0, 8)}`
      await client
        .db(vault)
        .collection('__keyVault')
        .insertOne({ keyAltNames: ['alice'], keyMaterial: 'x' })
      const other = namedConnection(h.t.app, mongo.port, 'Vaulted')
      h.t.app.ctx.connections.update(other, {
        settings: ConnectionSettingsSchema.parse({
          hosts: [{ host: '127.0.0.1', port: mongo.port }],
          encryption: {
            enabled: true,
            keyVaultNamespace: `${vault}.__keyVault`,
            kms: { local: { key: 'A'.repeat(128) } },
          },
        }),
      })
      try {
        once([
          {
            name: 'count_documents',
            args: {
              connection: 'Test',
              database: vault,
              collection: '__keyVault',
              filter: '{ "keyAltNames": { "$regex": "^a" } }',
            },
          },
        ])
        const vaulted = lines((await inject('POST', 'ai/agent', { message: 'count' })).payload)
        expect(ended(vaulted).map((s) => [s.tool, s.state, s.reason])).toEqual([
          ['count_documents', 'refused', 'credential_collection'],
        ])
      } finally {
        await client.db(vault).dropDatabase()
      }
    } finally {
      vi.restoreAllMocks()
      await client.db(db).dropDatabase()
    }
  })

  it('sends the gate’s order with a find, bounds what it adds, and says a pipeline was rewritten (M-2, M-3, M-5)', async () => {
    const { h, once, inject, sent } = await agent({ samples: true }, {}, true)
    const { db, coll, ns } = await people(h, true)
    const finds: Document[] = []
    const find = Collection.prototype.find
    vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'people') finds.push((args[1] ?? {}) as Document)
      return find.apply(this, args as never)
    } as typeof find)
    try {
      // An index that could order the page by what is hidden: the gate's own order is sent.
      await coll.createIndex({ name: 1, 'profile.email': 1 })
      once([{ name: 'find_documents', args: { ...ns, sort: '{ "name": -1 }' } }])
      const ran = lines((await inject('POST', 'ai/agent', { message: 'find', documents: true })).payload)
      expect(ended(ran)[0]).toMatchObject({ tool: 'find_documents', state: 'done' })
      const options = finds.at(-1)!
      expect(JSON.stringify(options.sort ?? null) + JSON.stringify(options.hint ?? null)).toMatch(
        /_id|\$natural/,
      )
      // A pipeline the gate grows past the routes' 100 stages is refused, said as such.
      const long = Array.from({ length: 40 }, () => ({ $sort: { profile: 1 } }))
      once([{ name: 'run_aggregation', args: { ...ns, pipeline: t(long) } }])
      const tooLong = lines((await inject('POST', 'ai/agent', { message: 'run' })).payload)
      expect(ended(tooLong)[0]).toMatchObject({
        tool: 'run_aggregation',
        state: 'refused',
        reason: 'invalid_arguments',
      })
      // The model is told a pipeline ran rewritten.
      once([
        {
          name: 'run_aggregation',
          args: { ...ns, pipeline: t([{ $group: { _id: '$profile', n: { $sum: 1 } } }]) },
        },
      ])
      const grouped = lines((await inject('POST', 'ai/agent', { message: 'run', documents: true })).payload)
      expect(ended(grouped)[0]).toMatchObject({ tool: 'run_aggregation', state: 'done' })
      expect(sent()).toContain('rewritten')
    } finally {
      vi.restoreAllMocks()
      await client.db(db).dropDatabase()
    }
  })

  it('leaves the rewrite to a restricted person’s route, and refuses no query for its keys’ order (M-1, M-4)', async () => {
    const { h, once, inject, sent } = await agent({ samples: true }, {}, true)
    const { db, ns } = await people(h, false)
    try {
      const expr = '{ "$expr": { "$gt": ["$profile", { "email": "m" }] } }'
      once([
        { name: 'find_documents', args: { ...ns, filter: expr } },
        { name: 'count_documents', args: { ...ns, filter: expr } },
        {
          name: 'run_aggregation',
          args: { ...ns, pipeline: t([{ $project: { _id: 0, t: { $gt: ['$profile', { email: 'm' }] } } }]) },
        },
      ])
      const out = lines((await inject('POST', 'ai/agent', { message: 'probe', documents: true })).payload)
      expect(ended(out).map((s) => [s.tool, s.state])).toEqual([
        ['find_documents', 'done'],
        ['count_documents', 'done'],
        ['run_aggregation', 'done'],
      ])
      // Told its answer is the rewritten one, as the route ran it (nit).
      expect(sent()).toContain('rewritten')
      // Its route compared the sub-document as "***": alike for both.
      expect([...sent().matchAll(/\\+"t\\+":(true|false)/g)].map((m) => m[1])).toEqual(['false', 'false'])
      // A $let written vars after in is the gate's own, rebuilt: not a rewrite (for everyone).
      h.hide!(false)
      once([
        {
          name: 'find_documents',
          args: {
            ...ns,
            filter: t({ $expr: { $let: { in: { $eq: ['$$n', 'A'] }, vars: { n: '$name' } } } }),
          },
        },
      ])
      const ok = lines((await inject('POST', 'ai/agent', { message: 'find', documents: true })).payload)
      expect(ended(ok)[0]).toMatchObject({ tool: 'find_documents', state: 'done' })
    } finally {
      await client.db(db).dropDatabase()
    }
  })
})

describe('security review of W6.3: a TTL index is a destructive change (I3)', () => {
  it('counts what would expire now, and asks for the collection’s name', async () => {
    const { h, once, inject } = await agent()
    const db = `tt${randomUUID().slice(0, 8)}`
    const past = new Date(Date.now() - 86_400_000)
    await client
      .db(db)
      .collection('logs')
      .insertMany([
        { createdAt: past },
        { createdAt: past },
        { createdAt: past },
        { createdAt: new Date(Date.now() + 86_400_000 * 365) },
      ])
    once([
      {
        name: 'create_index',
        args: {
          connection: 'Test',
          database: db,
          collection: 'logs',
          keys: '{ "createdAt": 1 }',
          expireAfterSeconds: 0,
        },
      },
    ])
    const turn = await agentTurn(h.t.app, h.headers, { message: 'ttl' })
    const card = (await turn.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    expect(card.step.proposal).toMatchObject({ typed: 'logs', destructive: true, preview: { expiring: 3 } })
    const run = (turn.lines.find((l) => l.type === 'chat') as { run: string }).run
    const bare = await inject('POST', `ai/agent/runs/${run}/decide`, {
      call: card.step.id,
      decision: 'confirm',
    })
    expect(bare.json().details).toEqual({ reason: 'typed_name' })
    expect(await client.db(db).collection('logs').indexes()).toHaveLength(1)
    await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'decline' })
    await turn.ended
  })
})

describe('security review of W6.3: what a turn may use is read on every call (I4)', () => {
  it('a connection turned off mid-turn refuses the next call; one made local-only keeps the next request inside', async () => {
    const { h, fake, inject } = await agent()
    const other = namedConnection(h.t.app, mongo.port, 'Other')
    const third = namedConnection(h.t.app, mongo.port, 'Third')
    const privateOnly: boolean[] = []
    let listed = ''
    const egress = h.t.app.ctx.ai.egress
    const request = egress.request.bind(egress)
    egress.request = (opts) => {
      privateOnly.push(!!opts.privateOnly)
      return request(opts)
    }
    fake.reply(
      agentReply((c) => {
        if (c.results.length === 0)
          return { calls: [{ name: 'list_databases', args: { connection: 'Other' } }] }
        if (c.results.length === 1) {
          // The administrator changes the policies while the model thinks.
          h.t.app.ctx.connections.setAiPolicy(other, 'off')
          h.t.app.ctx.connections.setAiPolicy(third, 'local')
          return {
            calls: [
              { name: 'list_databases', args: { connection: 'Other' } },
              { name: 'list_connections', args: {} },
            ],
          }
        }
        // What the model is told of its connections follows too.
        listed = c.results[2] ?? ''
        return { text: 'done' }
      }),
    )
    const out = lines((await inject('POST', 'ai/agent', { message: 'list' })).payload)
    expect(ended(out).map((s) => [s.state, s.reason ?? null])).toEqual([
      ['done', null],
      ['refused', 'connection_unknown'],
      ['done', null],
    ])
    expect(listed).toContain('"Third"')
    expect(listed).not.toContain('"Other"')
    expect(privateOnly).toEqual([false, false, true])
  })
})

describe('security review of W6.3: each provider round takes a slot and counts (I5)', () => {
  it('holds the assistant’s slot for a round after a card, and counts every round against the minute', async () => {
    const { h, fake, inject } = await agent()
    const db = `sl${randomUUID().slice(0, 8)}`
    const running: number[] = []
    fake.reply(
      agentReply((c) => {
        running.push(h.t.app.ctx.ai.limits.running('local'))
        return c.results.length === 0
          ? {
              calls: [
                { name: 'create_collection', args: { connection: 'Test', database: db, collection: 'c' } },
              ],
            }
          : { text: 'done' }
      }),
    )
    const turn = await agentTurn(h.t.app, h.headers, { message: 'make c' })
    const card = (await turn.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    expect(h.t.app.ctx.ai.limits.running('local')).toBe(0)
    const run = (turn.lines.find((l) => l.type === 'chat') as { run: string }).run
    await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'decline' })
    await turn.ended
    expect(running).toEqual([1, 1])
  })

  it('a turn whose rounds go over the agent’s minute stops with rate_limited', async () => {
    const { h, fake, inject } = await agent()
    h.t.app.ctx.ai.limits = new AiLimits(() => h.t.clock.now, {
      agentPerMinute: 1,
      perMinute: 10,
      perDay: 100,
      perUser: 2,
      server: 8,
    })
    fake.reply(agentReply(() => ({ calls: [{ name: 'list_connections', args: {} }] })))
    const out = lines((await inject('POST', 'ai/agent', { message: 'loop' })).payload)
    expect(fake.requests).toHaveLength(2)
    expect(out.at(-1)).toMatchObject({ type: 'error', reason: 'rate_limited' })
  })

  // Re-review minor 3: rounds have their own minute; the person's next message is not refused.
  it('rounds count against their own minute (and the day), not the person’s requests', async () => {
    const { h, fake, inject } = await agent()
    h.t.app.ctx.ai.limits = new AiLimits(() => h.t.clock.now, {
      perMinute: 2,
      perDay: 100,
      perUser: 2,
      server: 8,
    })
    fake.reply(
      agentReply((c) =>
        c.results.length < 3 ? { calls: [{ name: 'list_connections', args: {} }] } : { text: 'done' },
      ),
    )
    const out = lines((await inject('POST', 'ai/agent', { message: 'four rounds' })).payload)
    expect(out.at(-1)).toMatchObject({ type: 'done' })
    fake.reply(agentReply(() => ({ text: 'again' })))
    const next = lines((await inject('POST', 'ai/agent', { message: 'next' })).payload)
    expect(next.at(-1)).toMatchObject({ type: 'done' })
  })

  it('after a change was made, the closing round waits for the minute instead of ending without a word', async () => {
    const { h, fake, inject } = await agent()
    h.t.app.ctx.ai.limits = new AiLimits(() => h.t.clock.now, {
      agentPerMinute: 1,
      perMinute: 10,
      perDay: 100,
      perUser: 2,
      server: 8,
    })
    const db = `cr${randomUUID().slice(0, 8)}`
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                { name: 'create_collection', args: { connection: 'Test', database: db, collection: 'c' } },
              ],
            }
          : c.results.length === 1
            ? { calls: [{ name: 'list_collections', args: { connection: 'Test', database: db } }] }
            : { text: 'Created c, and it is listed.' },
      ),
    )
    const turn = await agentTurn(h.t.app, h.headers, { message: 'make c' })
    const card = (await turn.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (turn.lines.find((l) => l.type === 'chat') as { run: string }).run
    await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'confirm' })
    // The third round finds the agent's minute full; a minute on, it goes.
    await turn.waitFor(
      (l) => l.type === 'step' && l.step.tool === 'list_collections' && l.step.state === 'done',
    )
    await new Promise((r) => setTimeout(r, 400))
    h.t.clock.now += 61_000
    await turn.ended
    expect(turn.lines.at(-1)).toMatchObject({ type: 'done' })
    expect(
      turn.lines
        .filter((l) => l.type === 'text')
        .map((l) => (l as { delta: string }).delta)
        .join(''),
    ).toContain('Created c')
  })
})

describe('security review of W6.3, re-review', () => {
  // N1: diagnostic stages read other clients' queries, validators and view pipelines.
  it('refuses the stages that show other clients’ queries or the catalog, at any depth, in every pipeline', async () => {
    const { h, once, inject, sent } = await agent({ samples: true })
    const db = `pc${randomUUID().slice(0, 8)}`
    const c = client.db(db).collection('orders')
    await c.insertMany(Array.from({ length: 50 }, (_, i) => ({ a: i % 7, b: `v${i}` })))
    await c.createIndex({ a: 1 })
    await c.createIndex({ b: 1 })
    for (let i = 0; i < 5; i++) await c.find({ a: 3, b: 'PLANCACHE_MARKER' }).toArray()
    await client.db(db).createCollection('val', { validator: { secret: { $ne: 'VALIDATOR_MARKER' } } })
    const agg = (coll: string, pipeline: string): FakeCall => ({
      name: 'run_aggregation',
      args: { connection: 'Test', database: db, collection: coll, pipeline },
    })
    const calls: FakeCall[] = [
      agg('orders', '[{ "$planCacheStats": {} }]'),
      agg('val', '[{ "$listCatalog": {} }]'),
      agg(
        'orders',
        '[{ "$lookup": { "from": "orders", "pipeline": [{ "$planCacheStats": {} }], "as": "p" } }]',
      ),
      agg('orders', '[{ "$facet": { "f": [{ "$querySettings": {} }] } }]'),
      agg('orders', '[{ "$indexStats": {} }]'),
      agg('orders', '[{ "$collStats": { "count": {} } }]'),
      agg('orders', '[{ "$currentOp": {} }]'),
      agg('orders', '[{ "$listSessions": {} }]'),
      agg('orders', '[{ "$queryStats": {} }]'),
      {
        name: 'explain_query',
        args: {
          connection: 'Test',
          database: db,
          collection: 'orders',
          pipeline: '[{ "$planCacheStats": {} }]',
        },
      },
    ]
    once(calls)
    const out = lines((await inject('POST', 'ai/agent', { message: 'diagnose', documents: true })).payload)
    expect(ended(out).map((s) => [s.tool, s.state, s.reason])).toEqual(
      calls.map((x) => [x.name, 'refused', 'diagnostic_stage']),
    )
    expect(sent()).not.toContain('PLANCACHE_MARKER')
    expect(sent()).not.toContain('VALIDATOR_MARKER')
    once([
      {
        name: 'create_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'v',
          kind: 'view',
          viewOn: 'orders',
          pipeline: '[{ "$listCatalog": {} }]',
        },
      },
    ])
    const view = lines((await inject('POST', 'ai/agent', { message: 'view' })).payload)
    expect(ended(view)[0]).toMatchObject({ state: 'refused', reason: 'diagnostic_stage' })
    void h
  })

  // Minor 2: a catalog that cannot be read is no proof that a name is not a view.
  it('refuses a read whose source cannot be resolved', async () => {
    const { h, once, inject } = await agent()
    const db = `sr${randomUUID().slice(0, 8)}`
    await client.db(db).collection('a').insertOne({ x: 1 })
    const manager = h.t.app.ctx.manager
    const getClient = manager.getClient.bind(manager)
    manager.getClient = async (id: string) => {
      const real = await getClient(id)
      return new Proxy(real, {
        get(target, key) {
          if (key !== 'db') return Reflect.get(target, key)
          return (name: string) => {
            const d = target.db(name)
            if (name !== db) return d
            return new Proxy(d, {
              get(t, k) {
                if (k === 'listCollections')
                  return () => ({ toArray: async () => Promise.reject(new Error('not authorized')) })
                const v = Reflect.get(t, k)
                return typeof v === 'function' ? v.bind(t) : v
              },
            })
          }
        },
      })
    }
    once([{ name: 'count_documents', args: { connection: 'Test', database: db, collection: 'a' } }])
    const out = lines((await inject('POST', 'ai/agent', { message: 'count' })).payload)
    expect(ended(out)[0]).toMatchObject({ state: 'refused', reason: 'source_unknown' })
  })
})

describe('security review of W6.3: minor findings', () => {
  it('a bulk change confirmed after its preview’s 10 minutes is previewed again, and a changed count stops it (2)', async () => {
    const { h, fake, once, inject } = await agent()
    const db = `bp${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('t')
      .insertMany([{ k: 1, v: 'SAMPLE_VALUE_MARKER' }, { k: 1 }, { k: 2 }])
    const del: FakeCall = {
      name: 'delete_documents',
      args: { connection: 'Test', database: db, collection: 't', filter: '{ "k": 1 }' },
    }
    once([del])
    let turn = await agentTurn(h.t.app, h.headers, { message: 'delete' })
    let card = (await turn.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    let run = (turn.lines.find((l) => l.type === 'chat') as { run: string }).run
    h.t.clock.now += 11 * 60_000
    expect(
      (
        await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'confirm' })
      ).json(),
    ).toEqual({
      state: 'done',
      summary: { deleted: 2 },
    })
    await turn.ended
    // The preview's sample documents are never handed to the model.
    expect(JSON.stringify(fake.requests.map((r) => r.body))).not.toContain('SAMPLE_VALUE_MARKER')
    await client
      .db(db)
      .collection('t')
      .insertMany([{ k: 1 }, { k: 1 }])
    once([del])
    turn = await agentTurn(h.t.app, h.headers, { message: 'delete again' })
    card = (await turn.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    run = (turn.lines.find((l) => l.type === 'chat') as { run: string }).run
    await client.db(db).collection('t').insertOne({ k: 1 })
    expect(
      (
        await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'confirm' })
      ).json(),
    ).toEqual({
      state: 'error',
      reason: 'count_changed',
    })
    await turn.ended
    expect(await client.db(db).collection('t').countDocuments({ k: 1 })).toBe(3)
  })

  it('a schedule’s card names its connection and destinations, not their ids (3)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-agent-dest-'))
    const { h, once, inject } = await agent({}, { backup: { folderRoots: [root], privateNetworks: [] } })
    const dest = (
      await inject('POST', 'backup-destinations', {
        type: 'folder',
        name: 'Nightly folder',
        config: { path: join(root, 'n') },
        // An archive is refused before its card where only encrypted backups go (review of A4, I2).
        policy: { encryptedOnly: false },
      })
    ).json() as { id: string }
    expect(dest.id).toBeTruthy()
    once([
      {
        name: 'create_backup_schedule',
        args: {
          connection: 'Test',
          name: 'Nightly',
          database: 'shop',
          cadence: '{ "kind": "daily", "times": ["02:00"] }',
          timeZone: 'Europe/Istanbul',
          destinations: ['Nightly folder'],
          format: 'archive',
        },
      },
    ])
    const turn = await agentTurn(h.t.app, h.headers, { message: 'schedule' })
    const card = (await turn.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const shown = JSON.stringify(card.step.proposal!.payload)
    expect(shown).toContain('Nightly folder')
    expect(shown).toContain('"Test"')
    expect(shown).not.toContain(dest.id)
    expect(shown).not.toContain(h.connectionId)
    turn.stop()
    await turn.ended
    for (let i = 0; i < 100 && h.t.app.ctx.ai.chatsRunning.size; i++)
      await new Promise((r) => setTimeout(r, 20))
  })

  it('tells same-named connections apart by their group or a short id, never their address (4)', async () => {
    const { h, provider } = await agent()
    const a = namedConnection(h.t.app, mongo.port, 'X')
    const b = namedConnection(h.t.app, mongo.port, 'X')
    namedConnection(h.t.app, mongo.port, 'X (2)')
    const labels = agentConnections(
      h.t.app.ctx,
      { kind: 'local', userId: 'local', username: 'owner', role: 'admin', csrfToken: '' },
      provider.lastLocal,
    ).map((c) => c.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toContain('X (2)')
    expect(labels.filter((l) => l.startsWith('X ·')).sort()).toEqual(
      [`X · ${a.slice(0, 8)}`, `X · ${b.slice(0, 8)}`].sort(),
    )
    expect(labels.join()).not.toContain('127.0.0.1')
  })

  it('records how many documents went, and a provider not allowed samples is not handed that answer again (6)', async () => {
    const { h, once, inject, fake } = await agent({ samples: true })
    const db = `hs${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('t')
      .insertMany([{ v: 'QUOTED_VALUE' }, { v: 'OTHER' }])
    once([{ name: 'find_documents', args: { connection: 'Test', database: db, collection: 't' } }])
    const first = lines((await inject('POST', 'ai/agent', { message: 'read', documents: true })).payload)
    const chat = (first[0] as { id: string }).id
    expect(h.t.app.ctx.ai.chats.get(null, chat)!.turns[0]!.record.parts.samples).toBe(2)
    const strict = (
      await inject('POST', 'ai/providers', {
        name: 'Strict',
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
        samples: false,
      })
    ).json() as AiProviderView
    fake.requests.length = 0
    fake.reply(agentReply(() => ({ text: 'fine' })))
    const next = lines(
      (await inject('POST', 'ai/agent', { chat, message: 'and?', provider: strict.id })).payload,
    )
    expect(next.find((l) => l.type === 'context')).toMatchObject({
      history: { sent: 0, leftOut: ['history:samples:1'] },
    })
    expect(JSON.stringify(fake.requests[0]!.body)).not.toContain('QUOTED_VALUE')
  })

  it('audits a tool the model made up (8)', async () => {
    const { h, once, inject } = await agent()
    once([{ name: 'shell_eval', args: {} }])
    await inject('POST', 'ai/agent', { message: 'x' })
    const row = h.t.app.ctx.audit.list({ action: 'ai.agent.tool' }).at(0)!
    expect(row).toMatchObject({ outcome: 'denied' })
    expect(row.details).toMatchObject({ tool: 'shell_eval', state: 'refused', reason: 'unknown_tool' })
  })

  it('works behind a proxy whose public name only the forwarded headers carry (9)', async () => {
    const { h, once } = await agent(
      {},
      { allowedHosts: ['mm.example', 'localhost'], trustedProxies: ['127.0.0.1'] },
    )
    once([{ name: 'list_databases', args: { connection: 'Test' } }])
    const res = await h.t.app.inject({
      method: 'POST',
      url: '/api/ai/agent',
      headers: {
        ...h.headers,
        host: 'internal:4321',
        'x-forwarded-host': 'mm.example',
        'x-forwarded-proto': 'http',
        origin: 'http://mm.example',
      },
      remoteAddress: '127.0.0.1',
      payload: { message: 'list' },
    })
    expect(res.statusCode, res.payload).toBe(200)
    expect(ended(lines(res.payload))[0]).toMatchObject({ tool: 'list_databases', state: 'done' })
    void H
  })
})
