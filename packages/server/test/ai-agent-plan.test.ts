// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiAgentStep, AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { waitJob } from './support/jobs'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf, namedConnection } from './support/agent'

/**
 * The AI database manager (design 2026-10-25, C4): several changes shown first as a plan, each then
 * confirmed on its own card, in order — a "no" stops the rest; and before a change that loses data,
 * the card offers a backup of what it would lose, made before the change may be confirmed.
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

const ended = (lines: AiChatLine[]) =>
  lines.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))
const PASSWORD = 'correct horse battery staple 9'

async function agent() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  await inject('POST', 'ai/providers', {
    name: 'Fake',
    kind: 'openai',
    baseUrl: `${fake.url}/v1`,
    model: 'm',
  })
  await inject('PUT', 'me/ai-agent', { on: true })
  const db = `c4${randomUUID().slice(0, 8)}`
  /** The model's rounds, one list of calls each, then its words. */
  const rounds = (...each: FakeCall[][]) =>
    fake.reply(
      agentReply((c) =>
        c.results.length < each.length ? { calls: each[c.results.length]! } : { text: 'ok' },
      ),
    )
  const told = (n = -1) => {
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(n)!
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
  }
  const start = async () => {
    const stream = await agentTurn(h.t.app, h.headers, { message: 'do it' })
    const run = async () => {
      await stream.waitFor((l) => l.type === 'chat')
      return (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    }
    const awaiting = async (n: number) =>
      (
        (await stream.waitFor(
          (l) =>
            l.type === 'step' &&
            l.step.state === 'awaiting' &&
            stream.lines.filter((x) => x.type === 'step' && x.step.state === 'awaiting').length >= n,
        )) as { step: AiAgentStep }
      ).step
    const decide = async (step: AiAgentStep, decision: string, extra: object = {}) =>
      inject('POST', `ai/agent/runs/${await run()}/decide`, { call: step.id, decision, ...extra })
    return { stream, awaiting, decide }
  }
  return { h, fake, db, inject, rounds, told, start }
}

const createColl = (db: string, name: string): FakeCall => ({
  name: 'create_collection',
  args: { connection: 'Test', database: db, collection: name },
})

describe('a plan of changes, each confirmed on its own card (C4)', () => {
  it('shows the plan, then each change on its card in the plan’s order', async () => {
    const { db, rounds, start, inject } = await agent()
    rounds(
      [
        {
          name: 'plan_changes',
          args: {
            title: 'Set up the archive',
            changes: [
              { tool: 'create_collection', about: 'A collection for the archive' },
              { tool: 'create_collection', about: 'One for its log' },
            ],
          },
        },
      ],
      [createColl(db, 'archive')],
      [createColl(db, 'log')],
    )
    const { stream, awaiting, decide } = await start()
    const first = await awaiting(1)
    const plan = ended(stream.lines).find((s) => s.tool === 'plan_changes')!
    expect(plan).toMatchObject({
      state: 'done',
      plan: {
        title: 'Set up the archive',
        changes: [
          { tool: 'create_collection', about: 'A collection for the archive' },
          { tool: 'create_collection', about: 'One for its log' },
        ],
      },
    })
    expect(first).toMatchObject({ tool: 'create_collection', planItem: 0 })
    expect((await decide(first, 'confirm')).statusCode).toBe(200)
    const second = await awaiting(2)
    expect(second).toMatchObject({ planItem: 1 })
    expect((await decide(second, 'confirm')).statusCode).toBe(200)
    await stream.ended
    const names = (await client.db(db).listCollections().toArray()).map((c) => c.name).sort()
    expect(names).toEqual(['archive', 'log'])
    // Wave C e2e: the stored turn keeps the plan and which change each step was.
    const chat = (stream.lines.find((l) => l.type === 'chat') as { id: string }).id
    const view = (await inject('GET', `ai/chats/${chat}`)).json() as {
      messages: Array<{
        turn?: { agent?: { steps: Array<{ tool: string; plan?: unknown; planItem?: number }> } }
      }>
    }
    const stored = view.messages.flatMap((m) => m.turn?.agent?.steps ?? [])
    expect(stored[0]).toMatchObject({ tool: 'plan_changes', plan: { title: 'Set up the archive' } })
    expect(stored.slice(1).map((s) => s.planItem)).toEqual([0, 1])
  })

  it('stops the plan at a “no”: the changes after it are refused, the model told', async () => {
    const { db, rounds, start, told } = await agent()
    rounds(
      [
        {
          name: 'plan_changes',
          args: {
            title: 'Two collections',
            changes: [
              { tool: 'create_collection', about: 'First' },
              { tool: 'create_collection', about: 'Second' },
            ],
          },
        },
      ],
      [createColl(db, 'a')],
      [createColl(db, 'b')],
    )
    const { stream, awaiting, decide } = await start()
    await decide(await awaiting(1), 'decline')
    await stream.ended
    const steps = ended(stream.lines)
    expect(steps.at(-1)).toMatchObject({
      tool: 'create_collection',
      state: 'refused',
      reason: 'plan_stopped',
    })
    expect(told()).toMatchObject({ refused: 'plan_stopped' })
    expect((await client.db(db).listCollections().toArray()).length).toBe(0)
  })

  it('refuses a change out of the plan’s order, a second plan while one runs, and a plan of no change', async () => {
    const { db, rounds, start } = await agent()
    rounds(
      [
        {
          name: 'plan_changes',
          args: {
            title: 'One',
            changes: [
              { tool: 'create_collection', about: 'x' },
              { tool: 'drop_collection', about: 'y' },
            ],
          },
        },
      ],
      [{ name: 'drop_collection', args: { connection: 'Test', database: db, collection: 'x' } }],
      [
        {
          name: 'plan_changes',
          args: {
            title: 'Again',
            changes: [
              { tool: 'create_collection', about: 'x' },
              { tool: 'create_collection', about: 'y' },
            ],
          },
        },
      ],
    )
    const { stream } = await start()
    await stream.ended
    const steps = ended(stream.lines)
    expect(steps[1]).toMatchObject({ tool: 'drop_collection', state: 'refused', reason: 'not_in_plan' })
    expect(steps[2]).toMatchObject({ tool: 'plan_changes', state: 'refused', reason: 'plan_active' })
    // A plan of something that changes nothing, or of one change, is no plan.
    for (const changes of [
      [
        { tool: 'find_documents', about: 'x' },
        { tool: 'create_collection', about: 'y' },
      ],
      [{ tool: 'create_collection', about: 'x' }],
    ]) {
      rounds([{ name: 'plan_changes', args: { title: 'Reads', changes } }])
      const again = await start()
      await again.stream.ended
      expect(ended(again.stream.lines)[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    }
  })

  it('refuses a plan where an administrator lets the agent only read', async () => {
    const { rounds, start, inject } = await agent()
    // The admin harness's own session sets the policy.
    expect((await inject('PUT', 'ai/agent-policy', { policy: 'read' })).statusCode).toBe(200)
    rounds([
      {
        name: 'plan_changes',
        args: {
          title: 'Two',
          changes: [
            { tool: 'create_collection', about: 'x' },
            { tool: 'create_collection', about: 'y' },
          ],
        },
      },
    ])
    const { stream } = await start()
    await stream.ended
    expect(ended(stream.lines)[0]).toMatchObject({ state: 'refused', reason: 'agent_policy_read' })
  })
})

describe('a backup offered before a change that loses data (C4)', () => {
  it('backs up what a drop would lose, from the card, before the drop may be confirmed', async () => {
    const { h, db, rounds, start, told, inject } = await agent()
    await client
      .db(db)
      .collection('old')
      .insertMany([{ n: 1 }, { n: 2 }])
    rounds([{ name: 'drop_collection', args: { connection: 'Test', database: db, collection: 'old' } }])
    const { stream, awaiting, decide } = await start()
    const card = await awaiting(1)
    expect(card.proposal!.backup).toEqual({ scope: 'collection', db, coll: 'old' })
    // The backup's password, from the card only: none, or too short, refused.
    expect((await decide(card, 'backup')).json()).toMatchObject({ details: { reason: 'password_required' } })
    expect((await decide(card, 'backup', { backupPassword: 'short' })).json()).toMatchObject({
      details: { reason: 'password_short' },
    })
    const backing = await decide(card, 'backup', { backupPassword: PASSWORD })
    expect(backing.statusCode).toBe(200)
    const job = (backing.json() as { job: string }).job
    expect(typeof job).toBe('string')
    // One backup a card.
    expect((await decide(card, 'backup', { backupPassword: PASSWORD })).statusCode).toBe(409)
    expect(await waitJob(h.t, job)).toMatchObject({ state: 'done' })
    await stream.waitFor((l) => l.type === 'step' && l.step.id === card.id && l.step.backup?.state === 'done')
    expect((await decide(card, 'confirm', { confirm: 'old' })).statusCode).toBe(200)
    await stream.ended
    expect(ended(stream.lines).at(-1)).toMatchObject({ state: 'done', backup: { state: 'done', job } })
    expect(told()).toMatchObject({ done: expect.anything(), backup: { state: 'done', job } })
    // The kept copy is the person's, listed as their backups are.
    expect((await inject('GET', 'backups')).payload).toContain(db)
  })

  it('holds the confirmation while the backup runs, and never offers one where nothing is lost', async () => {
    const { h, db, rounds, start } = await agent()
    await client.db(db).collection('old').insertOne({ n: 1 })
    // The backup held until the test lets it go.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const kind = h.t.app.ctx.jobKinds['backup.dump']
    const run = kind.run.bind(kind)
    vi.spyOn(kind, 'run').mockImplementation(async (ctx, params) => {
      await held
      return run(ctx, params)
    })
    rounds([
      {
        name: 'delete_documents',
        args: { connection: 'Test', database: db, collection: 'old', filter: '{}' },
      },
    ])
    const deleting = await start()
    const card = await deleting.awaiting(1)
    expect(card.proposal!.backup).toEqual({ scope: 'collection', db, coll: 'old' })
    const job = (
      (await deleting.decide(card, 'backup', { backupPassword: PASSWORD })).json() as { job: string }
    ).job
    await deleting.stream.waitFor((l) => l.type === 'step' && l.step.backup?.state === 'running')
    const early = await deleting.decide(card, 'confirm', { confirm: card.proposal!.typed })
    expect(early.statusCode).toBe(409)
    expect(early.json()).toMatchObject({ details: { reason: 'backup_first_running' } })
    release()
    await waitJob(h.t, job)
    await deleting.stream.waitFor((l) => l.type === 'step' && l.step.backup?.state === 'done')
    expect((await deleting.decide(card, 'confirm', { confirm: card.proposal!.typed })).statusCode).toBe(200)
    await deleting.stream.ended
    expect(await client.db(db).collection('old').countDocuments()).toBe(0)
    rounds([createColl(db, 'fresh')])
    const made = await start()
    const create = await made.awaiting(1)
    expect(create.proposal!.backup).toBeUndefined()
    expect((await made.decide(create, 'backup', { backupPassword: PASSWORD })).statusCode).toBe(409)
    await made.decide(create, 'decline')
    await made.stream.ended
  })
})

// Review of C4.
describe('a plan and a backup first: the review of C4', () => {
  const two = (title = 'Two') => ({
    name: 'plan_changes',
    args: {
      title,
      changes: [
        { tool: 'create_collection', about: 'x' },
        { tool: 'create_collection', about: 'y' },
      ],
    },
  })

  it('holds no more changes than a turn can reach, and says a plan the turn ended before finishing (I1)', async () => {
    const { db, rounds, start } = await agent()
    const nine = Array.from({ length: 9 }, (_, i) => ({ tool: 'create_collection', about: `c${i}` }))
    rounds([{ name: 'plan_changes', args: { title: 'Nine', changes: nine } }])
    const many = await start()
    await many.stream.ended
    expect(ended(many.stream.lines)[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    // The model stops after the plan's first change: the turn says the plan is not done.
    rounds([two()], [createColl(db, 'a')])
    const half = await start()
    await half.decide(await half.awaiting(1), 'confirm')
    await half.stream.ended
    expect(half.stream.lines.some((l) => l.type === 'note' && l.note === 'plan_unfinished')).toBe(true)
  })

  it('refuses a new plan after one stopped as stopped, and offers none where the agent may only read (M6, M7)', async () => {
    const { db, fake, rounds, start, inject } = await agent()
    rounds([two()], [createColl(db, 'a')], [two('Again')])
    const stopped = await start()
    await stopped.decide(await stopped.awaiting(1), 'decline')
    await stopped.stream.ended
    expect(ended(stopped.stream.lines).at(-1)).toMatchObject({
      tool: 'plan_changes',
      state: 'refused',
      reason: 'plan_stopped',
    })
    await inject('PUT', 'ai/agent-policy', { policy: 'read' })
    rounds([{ name: 'list_connections', args: {} }])
    const reading = await start()
    await reading.stream.ended
    const offered = JSON.stringify((fake.requests.at(-1)!.body as { tools?: unknown }).tools ?? [])
    expect(offered).toContain('list_connections')
    expect(offered).not.toContain('plan_changes')
  })

  it('backs a copy’s target up on its own connection, refused where the agent may no longer write there (M1)', async () => {
    const { h, db, rounds, start } = await agent()
    await client.db(db).collection('src').insertOne({ n: 1 })
    const other = namedConnection(h.t.app, mongo.port, 'Other')
    await client.db(`${db}o`).collection('dst').insertOne({ n: 9 })
    rounds([
      {
        name: 'copy_collection',
        args: {
          connection: 'Test',
          database: db,
          collection: 'src',
          toConnection: 'Other',
          toDatabase: `${db}o`,
          toCollection: 'dst',
          mode: 'upsert',
        },
      },
    ])
    const copying = await start()
    const card = await copying.awaiting(1)
    expect(card.proposal!.backup).toEqual({ scope: 'collection', db: `${db}o`, coll: 'dst' })
    h.t.app.ctx.connections.setAiAgentWrites(other, false)
    const asked = await copying.decide(card, 'backup', { backupPassword: PASSWORD })
    expect(asked.json()).toMatchObject({ state: 'error', reason: 'agent_writes_off' })
    await copying.decide(card, 'decline')
    await copying.stream.ended
    await client.db(`${db}o`).dropDatabase()
  })

  it('lets a change be declined while its backup runs, and says nothing of the backup after (M9)', async () => {
    const { h, db, rounds, start } = await agent()
    await client.db(db).collection('old').insertOne({ n: 1 })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const kind = h.t.app.ctx.jobKinds['backup.dump']
    const run = kind.run.bind(kind)
    vi.spyOn(kind, 'run').mockImplementation(async (ctx, params) => {
      await held
      return run(ctx, params)
    })
    rounds([{ name: 'drop_collection', args: { connection: 'Test', database: db, collection: 'old' } }])
    const dropping = await start()
    const card = await dropping.awaiting(1)
    const job = (
      (await dropping.decide(card, 'backup', { backupPassword: PASSWORD })).json() as { job: string }
    ).job
    await dropping.stream.waitFor((l) => l.type === 'step' && l.step.backup?.state === 'running')
    expect((await dropping.decide(card, 'decline')).statusCode).toBe(200)
    await dropping.stream.ended
    const lines = dropping.stream.lines.length
    release()
    expect(await waitJob(h.t, job)).toMatchObject({ state: 'done' })
    await new Promise((r) => setTimeout(r, 50))
    expect(dropping.stream.lines.length).toBe(lines)
    expect(ended(dropping.stream.lines).at(-1)).toMatchObject({
      state: 'declined',
      backup: { state: 'running' },
    })
    expect(await client.db(db).collection('old').countDocuments()).toBe(1)
  })

  it('reads a backup’s job once when its change ends first (final review of wave C, minor 4)', async () => {
    const { h, db, rounds, start } = await agent()
    await client.db(db).collection('old').insertOne({ n: 1 })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const kind = h.t.app.ctx.jobKinds['backup.dump']
    const run = kind.run.bind(kind)
    vi.spyOn(kind, 'run').mockImplementation(async (ctx, params) => {
      await held
      return run(ctx, params)
    })
    rounds([{ name: 'drop_collection', args: { connection: 'Test', database: db, collection: 'old' } }])
    const dropping = await start()
    const card = await dropping.awaiting(1)
    const job = (
      (await dropping.decide(card, 'backup', { backupPassword: PASSWORD })).json() as { job: string }
    ).job
    await dropping.stream.waitFor((l) => l.type === 'step' && l.step.backup?.state === 'running')
    // Its end not yet heard by the turn when the change ends: the job's own state is what is kept.
    const jobs = h.t.app.ctx.jobs
    const get = jobs.get.bind(jobs)
    vi.spyOn(jobs, 'get').mockImplementation((id: string) => {
      const j = get(id)
      return j && id === job ? { ...j, state: 'failed' } : j
    })
    expect((await dropping.decide(card, 'decline')).statusCode).toBe(200)
    await dropping.stream.ended
    expect(ended(dropping.stream.lines).at(-1)).toMatchObject({
      state: 'declined',
      backup: { state: 'error', job, reason: 'backup_failed' },
    })
    release()
    await waitJob(h.t, job)
  })

  it('refuses a plan after a change of its own round (final review of wave C, nit 6)', async () => {
    const { db, rounds, start } = await agent()
    rounds([
      { name: 'create_collection', args: { connection: 'Test', database: db, collection: 'a' } },
      {
        name: 'plan_changes',
        args: {
          title: 'Late',
          changes: [
            { tool: 'create_collection', about: 'x' },
            { tool: 'create_collection', about: 'y' },
          ],
        },
      },
    ])
    const { stream, awaiting, decide } = await start()
    await decide(await awaiting(1), 'confirm')
    await stream.ended
    expect(ended(stream.lines).find((s) => s.tool === 'plan_changes')).toMatchObject({
      state: 'refused',
      reason: 'plan_first',
    })
  })
})
