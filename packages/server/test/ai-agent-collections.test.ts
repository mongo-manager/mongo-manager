// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Collection, MongoClient, MongoServerError } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import type { AiAgentStep, AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { waitJob } from './support/jobs'
import { dataHarness, teamAdminHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf, namedConnection } from './support/agent'

/**
 * The AI database manager (design 2026-10-25, C3, first part): a collection's validation rules and a
 * search index proposed on cards — the rules tested against the documents there first, saved only
 * over the rules the card was made from; a search index only where the server has search.
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
  const db = `c3${randomUUID().slice(0, 8)}`
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

describe('validation rules and search indexes on cards (C3)', () => {
  it('proposes validation rules, says how many documents break them, and saves them on the click', async () => {
    const { db, card } = await agent()
    await client
      .db(db)
      .collection('items')
      .insertMany([{ n: 1 }, { n: 2 }, { label: 'none' }])
    const asked = await card([
      {
        name: 'set_validator',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          validator: '{"$jsonSchema":{"required":["n"]}}',
          action: 'warn',
        },
      },
    ])
    expect(asked.step.proposal).toMatchObject({
      payload: {
        validator: { $jsonSchema: { required: ['n'] } },
        validationLevel: 'strict',
        validationAction: 'warn',
      },
      preview: { failing: 1, total: 3, replaces: false },
    })
    const { ended } = await asked.decide('confirm')
    expect(ended).toMatchObject({ state: 'done', summary: { validator: 'set' } })
    const [info] = await client.db(db).listCollections({ name: 'items' }).toArray()
    expect((info as { options: { validator?: unknown; validationAction?: string } }).options).toMatchObject({
      validator: { $jsonSchema: { required: ['n'] } },
      validationAction: 'warn',
    })
  })

  it('saves only over the rules the card was made from, and never server JavaScript', async () => {
    const { db, card, once, turn } = await agent()
    await client.db(db).createCollection('items')
    const asked = await card([
      {
        name: 'set_validator',
        args: { connection: 'Test', database: db, collection: 'items', validator: '{"n":{"$exists":true}}' },
      },
    ])
    // Changed meanwhile: the click is refused, the other rules kept.
    await client.db(db).command({ collMod: 'items', validator: { m: { $exists: true } } })
    expect((await asked.decide('confirm')).ended).toMatchObject({
      state: 'error',
      reason: 'validator_changed',
    })
    once([
      {
        name: 'set_validator',
        args: { connection: 'Test', database: db, collection: 'items', validator: '{"$where":"true"}' },
      },
    ])
    expect(steps(await turn('rules'))[0]).toMatchObject({ state: 'refused', reason: 'server_js' })
  })

  it('never proposes rules naming a personal field (a validator answers about it)', async () => {
    const { h, db, once, turn } = await agent()
    await client.db(db).collection('people').insertOne({ email: 'x@c3.test' })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    once([
      {
        name: 'set_validator',
        args: {
          connection: 'Test',
          database: db,
          collection: 'people',
          validator: '{"email":{"$regex":"^x"}}',
        },
      },
    ])
    expect(steps(await turn('rules'))[0]).toMatchObject({ state: 'refused', reason: 'personal_field' })
  })

  it('refuses rules naming a personal field for someone nothing is hidden from too', async () => {
    const fake = await startFakeAi()
    closers.push(fake.close)
    const h = await teamAdminHarness(mongo, { ai: { privateNetworks: ['127.0.0.1/32'] } } as never)
    closers.push(h.t.close)
    const inject = (method: 'POST' | 'PUT', path: string, payload?: object) =>
      h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
    await inject('POST', 'ai/providers', { name: 'F', kind: 'openai', baseUrl: `${fake.url}/v1`, model: 'm' })
    await inject('PUT', 'me/ai-agent', { on: true })
    const db = `c3t${randomUUID().slice(0, 6)}`
    await client.db(db).collection('people').insertOne({ email: 'x@c3-team.test' })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    fake.reply(
      agentReply((c) =>
        c.results.length === 0
          ? {
              calls: [
                {
                  name: 'set_validator',
                  args: {
                    connection: 'Test',
                    database: db,
                    collection: 'people',
                    validator: '{"email":{"$regex":"^x"}}',
                  },
                },
              ],
            }
          : { text: 'ok' },
      ),
    )
    const out = (await inject('POST', 'ai/agent', { message: 'rules' })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
    // The count of documents breaking them would answer about the field: refused before any card.
    expect(steps(out)[0]).toMatchObject({ state: 'refused', reason: 'personal_field' })
  })

  it('removes the rules with an empty validator, said on the card', async () => {
    const { db, card } = await agent()
    await client.db(db).createCollection('items', { validator: { n: { $exists: true } } })
    const asked = await card([
      {
        name: 'set_validator',
        args: { connection: 'Test', database: db, collection: 'items', validator: '{}' },
      },
    ])
    expect(asked.step.proposal).toMatchObject({ preview: { replaces: true, removes: true } })
    expect((await asked.decide('confirm')).ended).toMatchObject({
      state: 'done',
      summary: { validator: 'removed' },
    })
  })

  it('never proposes a search index where the server has no search', async () => {
    const { db, once, turn } = await agent()
    await client.db(db).collection('items').insertOne({ title: 'x' })
    once([
      {
        name: 'create_search_index',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          name: 'titles',
          definition: '{"mappings":{"dynamic":true}}',
        },
      },
    ])
    const [step] = steps(await turn('search'))
    expect(step).toMatchObject({ state: 'refused' })
    expect(['search_unsupported', 'search_not_enabled']).toContain(step!.reason)
    for (const name of ['bad name', '$x', 'x'.repeat(200)]) {
      once([
        {
          name: 'create_search_index',
          args: {
            connection: 'Test',
            database: db,
            collection: 'items',
            name,
            definition: '{"mappings":{}}',
          },
        },
      ])
      expect(steps(await turn('search'))[0], name).toMatchObject({
        state: 'refused',
        reason: 'invalid_arguments',
      })
    }
  })
})

// Review of C3 (first part).
describe('validation rules and search indexes on cards: the review of C3', () => {
  it('keeps the level and action the rules had, shows the rules replaced, and asks for a remove explicitly', async () => {
    const { db, card, once, turn } = await agent()
    await client.db(db).createCollection('items', {
      validator: { n: { $exists: true } },
      validationLevel: 'moderate',
      validationAction: 'warn',
    })
    const asked = await card([
      {
        name: 'set_validator',
        args: { connection: 'Test', database: db, collection: 'items', validator: '{"m":{"$exists":true}}' },
      },
    ])
    expect(asked.step.proposal).toMatchObject({
      payload: { validationLevel: 'moderate', validationAction: 'warn' },
      preview: { replaces: true, currentRules: { n: { $exists: true } } },
      destructive: true,
    })
    await asked.decide('decline')
    // A blank validator is no "remove all".
    once([
      {
        name: 'set_validator',
        args: { connection: 'Test', database: db, collection: 'items', validator: '' },
      },
    ])
    expect(steps(await turn('rules'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    // Nothing to remove where there are no rules.
    await client.db(db).createCollection('plain')
    once([
      {
        name: 'set_validator',
        args: { connection: 'Test', database: db, collection: 'plain', validator: '{}' },
      },
    ])
    expect(steps(await turn('rules'))[0]).toMatchObject({ state: 'refused', reason: 'no_rules' })
  })

  it('refuses rules on a time series, and on a connection with client-side encryption', async () => {
    const { h, db, once, turn } = await agent()
    await client.db(db).createCollection('series', { timeseries: { timeField: 't' } })
    once([
      {
        name: 'set_validator',
        args: { connection: 'Test', database: db, collection: 'series', validator: '{"m":1}' },
      },
    ])
    expect(steps(await turn('rules'))[0]).toMatchObject({ state: 'refused', reason: 'validator_timeseries' })
    const other = namedConnection(h.t.app, mongo.port, 'Encrypted')
    h.t.app.ctx.connections.update(other, {
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port: mongo.port }],
        encryption: {
          enabled: true,
          keyVaultNamespace: 'kv.__keyVault',
          kms: { local: { key: 'A'.repeat(128) } },
        },
      }),
    })
    once([
      {
        name: 'set_validator',
        args: { connection: 'Encrypted', database: db, collection: 'items', validator: '{}' },
      },
    ])
    expect(steps(await turn('rules'))[0]).toMatchObject({ state: 'refused', reason: 'encrypted_connection' })
  })

  it('refuses for someone nothing is hidden from: a search index where rules apply, rules named personal since the card', async () => {
    const fake = await startFakeAi()
    closers.push(fake.close)
    const h = await teamAdminHarness(mongo, { ai: { privateNetworks: ['127.0.0.1/32'] } } as never)
    closers.push(h.t.close)
    const inject = (method: 'POST' | 'PUT', path: string, payload?: object) =>
      h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
    await inject('POST', 'ai/providers', { name: 'F', kind: 'openai', baseUrl: `${fake.url}/v1`, model: 'm' })
    await inject('PUT', 'me/ai-agent', { on: true })
    const db = `c3u${randomUUID().slice(0, 6)}`
    await client.db(db).collection('people').insertOne({ email: 'x@c3-u.test', city: 'A' })
    const turnOf = async (call: object) => {
      fake.reply(agentReply((c) => (c.results.length === 0 ? { calls: [call as FakeCall] } : { text: 'ok' })))
      return agentTurn(h.t.app, h.headers, { message: 'x' })
    }
    // Rules named after the card: the click checks again.
    const stream = await turnOf({
      name: 'set_validator',
      args: {
        connection: 'Test',
        database: db,
        collection: 'people',
        validator: '{"city":{"$exists":true}}',
      },
    })
    const awaiting = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'city' }])
    await inject('POST', `ai/agent/runs/${run}/decide`, { call: awaiting.step.id, decision: 'confirm' })
    await stream.ended
    expect(steps(stream.lines).at(-1)).toMatchObject({ state: 'error', reason: 'personal_field' })
    // A search index copies the values of the fields it maps: none where rules apply.
    const search = await turnOf({
      name: 'create_search_index',
      args: {
        connection: 'Test',
        database: db,
        collection: 'people',
        name: 'all',
        definition: '{"mappings":{"dynamic":true}}',
      },
    })
    await search.ended
    expect(steps(search.lines)[0]).toMatchObject({ state: 'refused', reason: 'personal_field' })
  })
})

// Re-review of C3.
describe('validation rules and search indexes on cards: the re-review of C3', () => {
  it('takes rules whose operators the gate rebuilds in its own key order (minor 1)', async () => {
    const { h, db, card } = await agent()
    await client.db(db).collection('items').insertOne({ n: 2 })
    // A rule elsewhere in the database: the gate looks at every validator here.
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    const asked = await card([
      {
        name: 'set_validator',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          validator: '{"$expr":{"$let":{"in":{"$gt":["$$x",1]},"vars":{"x":"$n"}}}}',
        },
      },
    ])
    expect(asked.step.state).toBe('awaiting')
    await asked.decide('decline')
  })

  it('says what to change when rules there refuse $jsonSchema (minor 2)', async () => {
    const { h, db, once, turn, toldJson } = await agent()
    await client.db(db).collection('people').insertOne({ email: 'x@c3-r.test', city: 'A' })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    once([
      {
        name: 'set_validator',
        args: {
          connection: 'Test',
          database: db,
          collection: 'people',
          validator: '{"$jsonSchema":{"required":["city"]}}',
        },
      },
    ])
    expect(steps(await turn('rules'))[0]).toMatchObject({ state: 'refused', reason: 'personal_field' })
    expect(JSON.stringify(toldJson())).toContain('without $expr or $jsonSchema')
  })

  it('checks a search index again on the click: rules added since the card refuse it (minor 5)', async () => {
    const { h, db, card } = await agent()
    await client.db(db).collection('people').insertOne({ email: 'x@c3-r.test' })
    vi.spyOn(Collection.prototype, 'listSearchIndexes').mockReturnValue({
      toArray: async () => [],
    } as unknown as ReturnType<Collection['listSearchIndexes']>)
    const create = vi.spyOn(Collection.prototype, 'createSearchIndex').mockResolvedValue('made')
    const asked = await card([
      {
        name: 'create_search_index',
        args: {
          connection: 'Test',
          database: db,
          collection: 'people',
          name: 'all',
          definition: '{"mappings":{"dynamic":true}}',
        },
      },
    ])
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    expect((await asked.decide('confirm')).ended).toMatchObject({ state: 'error', reason: 'personal_field' })
    expect(create).not.toHaveBeenCalled()
  })

  it('marks first rules that would refuse writes to documents there, and says a bound below its cap as the count (nits)', async () => {
    const { db, card } = await agent()
    await client
      .db(db)
      .collection('items')
      .insertMany([{ n: 1 }, { m: 1 }])
    const locking = await card([
      {
        name: 'set_validator',
        args: { connection: 'Test', database: db, collection: 'items', validator: '{"n":{"$exists":true}}' },
      },
    ])
    expect(locking.step.proposal).toMatchObject({ preview: { failing: 1 }, destructive: true })
    await locking.decide('decline')
    const warning = await card([
      {
        name: 'set_validator',
        args: {
          connection: 'Test',
          database: db,
          collection: 'items',
          validator: '{"n":{"$exists":true}}',
          action: 'warn',
        },
      },
    ])
    expect(warning.step.proposal!.destructive).toBeFalsy()
    await warning.decide('decline')
    // The full count ran out of time; the bounded one found fewer than its cap: that is the count.
    const count = Collection.prototype.countDocuments
    vi.spyOn(Collection.prototype, 'countDocuments').mockImplementation(function (
      this: Collection,
      filter,
      options,
    ) {
      if (options?.limit) return Promise.resolve(3)
      if (filter && '$nor' in filter)
        return Promise.reject(new MongoServerError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'x' }))
      return count.call(this, filter, options)
    })
    const bounded = await card([
      {
        name: 'set_validator',
        args: { connection: 'Test', database: db, collection: 'items', validator: '{"k":{"$exists":true}}' },
      },
    ])
    expect(bounded.step.proposal!.preview).toMatchObject({ failing: 3 })
    expect(bounded.step.proposal!.preview).not.toHaveProperty('failingAtLeast')
    await bounded.decide('decline')
  })
})

// Design 2026-10-25 (C3, second part): renaming and copying a collection on cards.
describe('renaming and copying a collection on cards (C3)', () => {
  it('renames a collection on a card that takes its name typed', async () => {
    const { db, card } = await agent()
    await client.db(db).collection('old').insertOne({ n: 1 })
    const asked = await card([
      {
        name: 'rename_collection',
        args: { connection: 'Test', database: db, collection: 'old', to: 'renamed' },
      },
    ])
    expect(asked.step.proposal).toMatchObject({
      payload: { renameCollection: `${db}.old`, to: `${db}.renamed` },
      typed: 'old',
      destructive: true,
    })
    expect((await asked.decide('confirm', { confirm: 'old' })).ended).toMatchObject({
      state: 'done',
      summary: { renamed: 'renamed' },
    })
    const names = (await client.db(db).listCollections().toArray()).map((c) => c.name)
    expect(names).toContain('renamed')
    expect(names).not.toContain('old')
  })

  it('never renames onto a name taken, into a system name, nor a collection whose personal-data rules would stay behind', async () => {
    const { h, db, once, turn } = await agent()
    await client.db(db).collection('a').insertOne({ n: 1 })
    await client.db(db).collection('b').insertOne({ n: 1 })
    once([
      { name: 'rename_collection', args: { connection: 'Test', database: db, collection: 'a', to: 'b' } },
    ])
    expect(steps(await turn('rename'))[0]).toMatchObject({ state: 'refused', reason: 'exists' })
    once([
      {
        name: 'rename_collection',
        args: { connection: 'Test', database: db, collection: 'a', to: 'system.x' },
      },
    ])
    expect(steps(await turn('rename'))[0]).toMatchObject({ state: 'refused', reason: 'system_namespace' })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'a', field: 'email' }])
    once([
      { name: 'rename_collection', args: { connection: 'Test', database: db, collection: 'a', to: 'c' } },
    ])
    expect(steps(await turn('rename'))[0]).toMatchObject({ state: 'refused', reason: 'rules_follow_name' })
  })

  it('copies a collection on a card from the person’s own plan, followed as a job', async () => {
    const { h, db, card } = await agent()
    await client
      .db(db)
      .collection('src')
      .insertMany([{ n: 1 }, { n: 2 }])
    const asked = await card([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'src',
          toDatabase: `${db}b`,
          toCollection: 'dst',
        },
      },
    ])
    expect(asked.step.proposal).toMatchObject({
      payload: { copy: `${db}.src`, to: `Test / ${db}b.dst`, mode: 'insert' },
      preview: { targetExists: false },
    })
    const { ended } = await asked.decide('confirm')
    expect(ended).toMatchObject({ state: 'done', summary: { started: true, job: expect.any(String) } })
    await waitJob(h.t, String(ended.summary!.job))
    expect(await client.db(`${db}b`).collection('dst').countDocuments()).toBe(2)
    await client.db(`${db}b`).dropDatabase()
  })

  it('takes a replace’s target name typed, and refuses a copy its plan refuses or where the agent may not write', async () => {
    const { h, db, card, once, turn } = await agent()
    await client.db(db).collection('src').insertOne({ n: 1 })
    await client.db(db).collection('dst').insertOne({ n: 9 })
    const replacing = await card([
      {
        name: 'copy_collection',
        args: { connection: 'Test', database: db, collection: 'src', toCollection: 'dst', mode: 'replace' },
      },
    ])
    expect(replacing.step.proposal).toMatchObject({
      typed: `${db}.dst`,
      destructive: true,
      preview: { targetExists: true },
    })
    await replacing.decide('decline')
    once([
      {
        name: 'copy_collection',
        args: { connection: 'Test', database: db, collection: 'src', toCollection: 'src' },
      },
    ])
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'copy_same_namespace' })
    namedConnection(h.t.app, mongo.port, 'NoWrites', { aiAgentWrites: false })
    once([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'src',
          toConnection: 'NoWrites',
          toCollection: 'x',
        },
      },
    ])
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'agent_writes_off' })
  })
})

// Review of C3b.
describe('renaming and copying a collection on cards: the review of C3b', () => {
  it('shows what picks the documents, counts them, and refuses picking them by a personal field, for anyone', async () => {
    const { h, db, card, once, turn } = await agent()
    await client
      .db(db)
      .collection('src')
      .insertMany([
        { n: 1, email: 'a@c3b.test' },
        { n: 2, email: 'b@c3b.test' },
        { n: 3, email: 'c@c3b.test' },
      ])
    const picked = await card([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'src',
          toCollection: 'dst',
          filter: '{"n":{"$gt":1}}',
        },
      },
    ])
    expect(picked.step.proposal).toMatchObject({
      payload: { copy: `${db}.src`, filter: { n: { $gt: { $numberInt: '1' } } } },
      preview: { documents: 2 },
    })
    expect(picked.step.proposal!.preview).not.toHaveProperty('documentsAbout')
    await picked.decide('decline')
    h.t.app.ctx.personalFields.set(h.connectionId, [
      { db, coll: 'src', field: 'email' },
      { db, coll: 'src', field: 'contact.phone' },
    ])
    once([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'src',
          toCollection: 'dst',
          filter: '{"email":{"$regex":"^a"}}',
        },
      },
    ])
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'personal_field' })
    once([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'src',
          toCollection: 'dst',
          pipeline: '[{"$match":{"email":{"$regex":"^a"}}}]',
        },
      },
    ])
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'personal_field' })
    // A pipeline the gate would run otherwise (the type of what holds a personal field read through
    // its own guard): refused too.
    once([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'src',
          toCollection: 'dst',
          pipeline: '[{"$match":{"$expr":{"$eq":[{"$type":"$contact"},"object"]}}}]',
        },
      },
    ])
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'personal_field' })
  })

  it('takes the target’s name typed for every mode that changes its documents; says a plan’s refusal by its words', async () => {
    const { db, card, once, turn } = await agent()
    await client.db(db).collection('src').insertOne({ n: 1 })
    await client.db(db).collection('dst').insertOne({ n: 9 })
    for (const mode of ['upsert', 'merge']) {
      const asked = await card([
        {
          name: 'copy_collection',
          args: { connection: 'Test', database: db, collection: 'src', toCollection: 'dst', mode },
        },
      ])
      expect(asked.step.proposal, mode).toMatchObject({ typed: `${db}.dst`, destructive: true })
      await asked.decide('decline')
    }
    const inserting = await card([
      {
        name: 'copy_collection',
        args: { connection: 'Test', database: db, collection: 'src', toCollection: 'dst' },
      },
    ])
    expect(inserting.step.proposal).toMatchObject({ destructive: true })
    expect(inserting.step.proposal!.typed).toBeUndefined()
    await inserting.decide('decline')
    once([
      {
        name: 'copy_collection',
        args: { connection: 'Test', database: db, collection: 'src', toCollection: 'src' },
      },
    ])
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'copy_same_namespace' })
  })

  it('refuses a copy from where the agent may not propose, into client-side encryption, and checks the target again on the click', async () => {
    const { h, db, card, once, turn } = await agent()
    await client.db(db).collection('src').insertOne({ n: 1 })
    const quiet = namedConnection(h.t.app, mongo.port, 'Quiet', { aiAgentWrites: false })
    void quiet
    once([
      {
        name: 'copy_collection',
        args: {
          connection: 'Quiet',
          database: db,
          collection: 'src',
          toConnection: 'Test',
          toCollection: 'x',
        },
      },
    ])
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'agent_writes_off' })
    const sealed = namedConnection(h.t.app, mongo.port, 'Sealed')
    h.t.app.ctx.connections.update(sealed, {
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port: mongo.port }],
        encryption: {
          enabled: true,
          keyVaultNamespace: 'kv.__keyVault',
          kms: { local: { key: 'A'.repeat(128) } },
        },
      }),
    })
    once([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'src',
          toConnection: 'Sealed',
          toCollection: 'x',
        },
      },
    ])
    expect(steps(await turn('copy'))[0]).toMatchObject({ state: 'refused', reason: 'encrypted_connection' })
    // The target's switch turned off after the card: the click refuses it.
    const other = namedConnection(h.t.app, mongo.port, 'Other')
    const asked = await card([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'src',
          toConnection: 'Other',
          toCollection: 'x',
        },
      },
    ])
    h.t.app.ctx.connections.setAiAgentWrites(other, false)
    expect((await asked.decide('confirm')).ended).toMatchObject({
      state: 'error',
      reason: 'agent_writes_off',
    })
    expect(await client.db(db).collection('x').countDocuments()).toBe(0)
  })

  it('refuses renaming a view, a time series, or where client-side encryption is on; checks the rules again on the click; says the views left', async () => {
    const { h, db, card, once, turn } = await agent()
    await client.db(db).collection('base').insertOne({ n: 1 })
    await client.db(db).createCollection('look', { viewOn: 'base', pipeline: [] })
    await client.db(db).createCollection('series', { timeseries: { timeField: 't' } })
    once([
      {
        name: 'rename_collection',
        args: { connection: 'Test', database: db, collection: 'look', to: 'look2' },
      },
    ])
    expect(steps(await turn('rename'))[0]).toMatchObject({ state: 'refused', reason: 'rename_view' })
    once([
      {
        name: 'rename_collection',
        args: { connection: 'Test', database: db, collection: 'series', to: 's2' },
      },
    ])
    expect(steps(await turn('rename'))[0]).toMatchObject({ state: 'refused', reason: 'rename_timeseries' })
    const asked = await card([
      {
        name: 'rename_collection',
        args: { connection: 'Test', database: db, collection: 'base', to: 'base2' },
      },
    ])
    expect(asked.step.proposal!.preview).toMatchObject({ viewsLeft: 1 })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'base', field: 'email' }])
    expect((await asked.decide('confirm', { confirm: 'base' })).ended).toMatchObject({
      state: 'error',
      reason: 'rules_follow_name',
    })
    expect((await client.db(db).listCollections({ name: 'base' }).toArray()).length).toBe(1)
    const sealed = namedConnection(h.t.app, mongo.port, 'Sealed')
    h.t.app.ctx.connections.update(sealed, {
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port: mongo.port }],
        encryption: {
          enabled: true,
          keyVaultNamespace: 'kv.__keyVault',
          kms: { local: { key: 'A'.repeat(128) } },
        },
      }),
    })
    once([
      {
        name: 'rename_collection',
        args: { connection: 'Sealed', database: db, collection: 'base', to: 'b3' },
      },
    ])
    expect(steps(await turn('rename'))[0]).toMatchObject({ state: 'refused', reason: 'encrypted_connection' })
  })
})

// Review of C4 (M8): client-side encryption turned on after the card refuses it on the click.
describe('renaming and copying where client-side encryption is turned on after the card (review of C4)', () => {
  const sealed = (
    h: { t: { app: { ctx: { connections: { update: (id: string, p: object) => unknown } } } } },
    id: string,
  ) =>
    h.t.app.ctx.connections.update(id, {
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port: mongo.port }],
        encryption: {
          enabled: true,
          keyVaultNamespace: 'kv.__keyVault',
          kms: { local: { key: 'A'.repeat(128) } },
        },
      }),
    })

  it('refuses the rename and the copy on the click', async () => {
    const { h, db, card } = await agent()
    await client.db(db).collection('base').insertOne({ n: 1 })
    const renaming = await card([
      { name: 'rename_collection', args: { connection: 'Test', database: db, collection: 'base', to: 'b2' } },
    ])
    sealed(h, h.connectionId)
    expect((await renaming.decide('confirm', { confirm: 'base' })).ended).toMatchObject({
      state: 'error',
      reason: 'encrypted_connection',
    })
    const { h: h2, db: db2, card: card2 } = await agent()
    await client.db(db2).collection('src').insertOne({ n: 1 })
    const other = namedConnection(h2.t.app, mongo.port, 'Other')
    const copying = await card2([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db2,
          collection: 'src',
          toConnection: 'Other',
          toCollection: 'x',
        },
      },
    ])
    sealed(h2, other)
    expect((await copying.decide('confirm')).ended).toMatchObject({
      state: 'error',
      reason: 'encrypted_connection',
    })
  })
})
