import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AiAgentStep, AiChatLine } from '@mongo-manager/shared'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { waitJob } from './support/jobs'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf, namedConnection } from './support/agent'

/**
 * The AI database manager (design 2026-10-25, C5): an administrator turns the agent's tools off per
 * connection, as the MongoDB MCP server's disabled tools — refused before anything is read or proposed
 * there, a change waiting on its card refused when confirmed, and the model told which are off.
 */
let mongo: TestMongo
let mongoClient: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  mongoClient = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
})
afterAll(async () => {
  await mongoClient?.close()
  await mongo?.stop()
})
const client = (_h: unknown) => mongoClient
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

const ended = (lines: AiChatLine[]) =>
  lines.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))

async function agent() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  await inject('POST', 'ai/providers', {
    name: 'Fake',
    kind: 'openai',
    baseUrl: `${fake.url}/v1`,
    model: 'm',
  })
  await inject('PUT', 'me/ai-agent', { on: true })
  const db = `c5${randomUUID().slice(0, 8)}`
  const once = (calls: FakeCall[]) =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text: 'ok' })))
  const turn = async () =>
    (await inject('POST', 'ai/agent', { message: 'go' })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
  const told = () => {
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
  }
  return { h, db, inject, once, turn, told }
}

describe('the agent’s tools turned off per connection (C5)', () => {
  it('keeps the tools off as the agent lists them, each once, and refuses a name it has no tool for', async () => {
    const { h, inject } = await agent()
    const set = await inject('PATCH', `connections/${h.connectionId}`, {
      aiAgentToolsOff: ['drop_collection', 'find_documents', 'drop_collection'],
    })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ aiAgentToolsOff: ['find_documents', 'drop_collection'] })
    expect((await inject('GET', `connections/${h.connectionId}`)).json()).toMatchObject({
      aiAgentToolsOff: ['find_documents', 'drop_collection'],
    })
    expect(
      (await inject('PATCH', `connections/${h.connectionId}`, { aiAgentToolsOff: ['rm_rf'] })).statusCode,
    ).toBe(400)
    // A store written by an older or a newer build: names it does not know are dropped.
    h.t.app.ctx.store.db
      .prepare('UPDATE connections SET ai_agent_tools_off = ? WHERE id = ?')
      .run('["find_documents","nope",3]', h.connectionId)
    expect(h.t.app.ctx.connections.get(h.connectionId)!.aiAgentToolsOff).toEqual(['find_documents'])
    h.t.app.ctx.store.db
      .prepare('UPDATE connections SET ai_agent_tools_off = ? WHERE id = ?')
      .run('not json', h.connectionId)
    expect(h.t.app.ctx.connections.get(h.connectionId)!.aiAgentToolsOff).toEqual([])
  })

  it('refuses a tool turned off before it reads or proposes anything, and tells the model which are off', async () => {
    const { h, db, once, turn, told } = await agent()
    h.t.app.ctx.connections.setAiAgentToolsOff(h.connectionId, ['count_documents', 'create_collection'])
    once([{ name: 'list_connections', args: {} }])
    await turn()
    const listed = (told().connections as Array<{ name: string; toolsOff?: string[] }>).find(
      (c) => c.name === 'Test',
    )
    expect(listed?.toolsOff).toEqual(['count_documents', 'create_collection'])
    once([
      { name: 'count_documents', args: { connection: 'Test', database: db, collection: 'x', filter: '{}' } },
    ])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'tool_off' })
    once([{ name: 'create_collection', args: { connection: 'Test', database: db, collection: 'x' } }])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'tool_off' })
    // A copy into a connection where copying is off.
    const other = namedConnection(h.t.app, mongo.port, 'Other')
    h.t.app.ctx.connections.setAiAgentToolsOff(other, ['copy_collection'])
    once([
      {
        name: 'copy_collection',
        args: { connection: 'Test', database: db, collection: 'x', toConnection: 'Other', toCollection: 'y' },
      },
    ])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'tool_off' })
  })

  it('refuses a change waiting on its card once its tool is turned off', async () => {
    const { h, db, inject, once } = await agent()
    once([{ name: 'create_collection', args: { connection: 'Test', database: db, collection: 'later' } }])
    const stream = await agentTurn(h.t.app, h.headers, { message: 'go' })
    const awaiting = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    h.t.app.ctx.connections.setAiAgentToolsOff(h.connectionId, ['create_collection'])
    const confirmed = await inject('POST', `ai/agent/runs/${run}/decide`, {
      call: awaiting.step.id,
      decision: 'confirm',
    })
    expect(confirmed.statusCode).toBe(403)
    expect(confirmed.json()).toMatchObject({ details: { reason: 'tool_off' } })
    // Declining is never held back.
    expect(
      (await inject('POST', `ai/agent/runs/${run}/decide`, { call: awaiting.step.id, decision: 'decline' }))
        .statusCode,
    ).toBe(200)
    await stream.ended
  })
})

// Review of C5.
describe('the agent’s tools turned off per connection: the review of C5', () => {
  const backUp = async (inject: Awaited<ReturnType<typeof agent>>['inject'], id: string, db: string) => {
    const request = { scope: { kind: 'database', db }, format: 'gzip' }
    const plan = (await inject('POST', `connections/${id}/backup/plan`, request)).json() as {
      planHash: string
    }
    const started = await inject('POST', `connections/${id}/backup`, { ...request, planHash: plan.planHash })
    expect(started.statusCode, started.payload).toBeLessThan(300)
    return (started.json() as { job: { id: string } }).job.id
  }

  it('leaves out jobs and backups of a connection where listing them is off, and finds no job there (I2)', async () => {
    const { h, db, inject, once, turn, told } = await agent()
    await client(h).db(db).collection('a').insertOne({ n: 1 })
    const job = await backUp(inject, h.connectionId, db)
    await waitJob(h.t, job)
    h.t.app.ctx.connections.setAiAgentToolsOff(h.connectionId, ['list_jobs', 'get_job', 'list_backups'])
    once([{ name: 'list_jobs', args: {} }])
    await turn()
    expect(told()).toMatchObject({ jobs: [] })
    once([{ name: 'list_backups', args: {} }])
    await turn()
    expect(told()).toMatchObject({ backups: [] })
    once([{ name: 'get_job', args: { job } }])
    // As a job of a connection the agent is not told of: a missing one.
    expect(ended(await turn())[0]).toMatchObject({ reason: 'not_found' })
  })

  it('refuses a restore from a connection where restoring is off, and offers no backup first where backing up is off (minor 1, 2)', async () => {
    const { h, db, once, turn } = await agent()
    const other = namedConnection(h.t.app, mongo.port, 'Other')
    h.t.app.ctx.connections.setAiAgentToolsOff(other, ['restore_backup'])
    once([{ name: 'restore_backup', args: { backup: 'any', from: 'Other', connection: 'Test' } }])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'tool_off' })
    await client(h).db(db).collection('old').insertOne({ n: 1 })
    h.t.app.ctx.connections.setAiAgentToolsOff(h.connectionId, ['run_backup'])
    once([{ name: 'drop_collection', args: { connection: 'Test', database: db, collection: 'old' } }])
    const stream = await agentTurn(h.t.app, h.headers, { message: 'go' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    expect(card.step.proposal!.backup).toBeUndefined()
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    await h.t.app.inject({
      method: 'POST',
      url: `/api/ai/agent/runs/${run}/decide`,
      headers: h.headers,
      payload: { call: card.step.id, decision: 'decline' },
    })
    await stream.ended
  })

  it('takes only tools that act on a connection, and keeps a file’s names this build knows (I3, minor 3)', async () => {
    const { h, inject } = await agent()
    expect(
      (await inject('PATCH', `connections/${h.connectionId}`, { aiAgentToolsOff: ['list_connections'] }))
        .statusCode,
    ).toBe(400)
    const file = {
      format: 'mongo-manager-connections',
      version: 1,
      connections: [
        {
          name: 'Newer',
          favorite: false,
          readOnly: false,
          aiPolicy: 'any',
          aiAgentWrites: true,
          aiAgentToolsOff: ['find_documents', 'a_tool_from_a_later_version', 'list_connections'],
          settings: { hosts: [{ host: '127.0.0.1', port: mongo.port }] },
        },
      ],
    }
    const imported = await inject('POST', 'connections/import', file)
    expect(imported.statusCode, imported.payload).toBeLessThan(300)
    expect(h.t.app.ctx.connections.list().find((c) => c.name === 'Newer')!.aiAgentToolsOff).toEqual([
      'find_documents',
    ])
  })
})

// Second review of C5.
describe('the agent’s tools turned off per connection: the second review of C5', () => {
  it('refuses restoring a backup of a connection where restoring is off, named by its id alone (I1)', async () => {
    const { h, db, inject, once, turn } = await agent()
    const other = namedConnection(h.t.app, mongo.port, 'Other')
    await mongoClient.db(db).collection('a').insertOne({ n: 1 })
    const request = { scope: { kind: 'database', db }, format: 'gzip' }
    const plan = (await inject('POST', `connections/${other}/backup/plan`, request)).json() as {
      planHash: string
    }
    const started = await inject('POST', `connections/${other}/backup`, {
      ...request,
      planHash: plan.planHash,
    })
    await waitJob(h.t, (started.json() as { job: { id: string } }).job.id)
    const backup = (
      (await inject('GET', 'backups')).json() as Array<{ id: string; connectionId: string }>
    ).find((b) => b.connectionId === other)!
    h.t.app.ctx.connections.setAiAgentToolsOff(other, ['restore_backup'])
    once([{ name: 'restore_backup', args: { backup: backup.id, connection: 'Test', database: `${db}r` } }])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'tool_off' })
  })

  it('makes no backup first once backing up is turned off after the card (M1)', async () => {
    const { h, db, inject, once } = await agent()
    await mongoClient.db(db).collection('old').insertOne({ n: 1 })
    once([{ name: 'drop_collection', args: { connection: 'Test', database: db, collection: 'old' } }])
    const stream = await agentTurn(h.t.app, h.headers, { message: 'go' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    expect(card.step.proposal!.backup).toBeDefined()
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    h.t.app.ctx.connections.setAiAgentToolsOff(h.connectionId, ['run_backup'])
    const asked = await inject('POST', `ai/agent/runs/${run}/decide`, {
      call: card.step.id,
      decision: 'backup',
      backupPassword: 'correct horse battery staple 9',
    })
    expect(asked.json()).toMatchObject({ state: 'error', reason: 'tool_off' })
    await inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, decision: 'decline' })
    await stream.ended
  })
})
