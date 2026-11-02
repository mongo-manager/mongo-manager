import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiAgentStep, AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf, namedConnection } from './support/agent'
import { restrictedApp } from './support/restricted'
import { H } from './helpers'

/**
 * The AI database manager (design 2026-10-25, B4): MongoDB's users and roles from the chat — listed
 * under databases:admin by names and roles only; a user created on a card whose password the person
 * types there (never the model's, never told), with no right over the deployment; a user dropped on a
 * card that takes its name typed, never the connection's own account.
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
const PASSWORD = 'a-long-new-password-9'

async function users() {
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
  const db = `b4${randomUUID().slice(0, 8)}`
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
  const usersOf = async () =>
    ((await client.db(db).command({ usersInfo: 1 })).users as Array<{ user: string; roles: unknown[] }>).map(
      (u) => u.user,
    )
  return { h, fake, db, inject, once, turn, toldJson, card, usersOf }
}

describe('MongoDB users and roles from the chat (B4)', () => {
  it('lists users by their names and roles only, and custom roles by what they hold', async () => {
    const { db, once, turn, toldJson } = await users()
    await client
      .db(db)
      .command({ createUser: 'reporter', pwd: 'never-told-9876', roles: [{ role: 'read', db }] })
    await client.db(db).command({
      createRole: 'auditor',
      privileges: [{ resource: { db, collection: '' }, actions: ['find'] }],
      roles: [],
    })
    once([{ name: 'list_users', args: { connection: 'Test', database: db } }])
    const [listed] = steps(await turn('who can sign in?'))
    expect(listed).toMatchObject({ tool: 'list_users', state: 'done', summary: { users: 1 } })
    expect(toldJson()).toMatchObject({ users: [{ user: 'reporter', database: db, roles: [`read@${db}`] }] })
    expect(JSON.stringify(toldJson())).not.toMatch(/never-told|credentials|SCRAM|salt/i)
    once([{ name: 'list_roles', args: { connection: 'Test', database: db } }])
    const [roles] = steps(await turn('which roles?'))
    expect(roles).toMatchObject({ tool: 'list_roles', state: 'done' })
    expect(toldJson()).toMatchObject({ roles: [{ role: 'auditor', database: db, privileges: 1 }] })
  })

  it('creates a user on a card whose password the person types — never the model’s, never told', async () => {
    const { db, card, usersOf, fake } = await users()
    const asked = await card([
      {
        name: 'create_user',
        args: { connection: 'Test', database: db, user: 'writer', roles: ['readWrite'] },
      },
    ])
    expect(asked.step.proposal).toMatchObject({
      payload: { createUser: 'writer', database: db, roles: [`readWrite@${db}`] },
      password: true,
      passwordFor: 'user',
    })
    // A password the route would refuse keeps the card waiting.
    const short = await asked.attempt({ password: 'short' })
    expect(short.json().details?.reason).toBe('password_short')
    // One MongoDB would not take (over 256 characters) is refused on the card too.
    const long = await asked.attempt({ password: 'x'.repeat(300) })
    expect(long.json().details?.reason).toBe('password_invalid')
    const { ended } = await asked.decide('confirm', { password: PASSWORD })
    expect(ended).toMatchObject({ state: 'done', summary: { created: 'writer' } })
    expect(await usersOf()).toEqual(['writer'])
    expect(JSON.stringify(fake.requests.map((r) => r.body))).not.toContain(PASSWORD)
  })

  it('never offers a user that exists, rights over the deployment, nor one in $external', async () => {
    const { db, once, turn } = await users()
    await client.db(db).command({ createUser: 'reporter', pwd: 'never-told-9876', roles: [] })
    once([
      { name: 'create_user', args: { connection: 'Test', database: db, user: 'reporter', roles: ['read'] } },
    ])
    expect(steps(await turn('add'))[0]).toMatchObject({ state: 'refused', reason: 'user_exists' })
    once([
      {
        name: 'create_user',
        args: { connection: 'Test', database: 'admin', user: 'boss', roles: ['userAdminAnyDatabase'] },
      },
    ])
    expect(steps(await turn('add'))[0]).toMatchObject({ state: 'refused', reason: 'broad_role' })
    once([{ name: 'create_user', args: { connection: 'Test', database: '$external', user: 'x', roles: [] } }])
    expect(steps(await turn('add'))[0]).toMatchObject({ state: 'refused', reason: 'external_user' })
  })

  it('drops a user on a card that takes its name typed', async () => {
    const { db, card, usersOf } = await users()
    await client.db(db).command({ createUser: 'leaver', pwd: 'never-told-9876', roles: [] })
    const asked = await card([
      { name: 'drop_user', args: { connection: 'Test', database: db, user: 'leaver' } },
    ])
    expect(asked.step.proposal).toMatchObject({ typed: 'leaver', destructive: true })
    const { ended } = await asked.decide('confirm', { confirm: 'leaver' })
    expect(ended).toMatchObject({ state: 'done', summary: { dropped: 'leaver' } })
    expect(await usersOf()).toEqual([])
  })

  it('never offers a change on a read-only connection, nor a user that is not there', async () => {
    const { h, db, once, turn } = await users()
    namedConnection(h.t.app, mongo.port, 'RO', { readOnly: true })
    once([{ name: 'create_user', args: { connection: 'RO', database: db, user: 'w', roles: ['read'] } }])
    expect(steps(await turn('add'))[0]).toMatchObject({ state: 'refused', reason: 'read_only' })
    once([{ name: 'drop_user', args: { connection: 'Test', database: db, user: 'ghost' } }])
    expect(steps(await turn('drop'))[0]).toMatchObject({ state: 'refused', reason: 'user_unknown' })
  })
})

// Review of B4: what the agent never offers, and what the click checks again.
describe('MongoDB users from the chat: the abuse cases (review of B4)', () => {
  it('never offers a role over the whole deployment, however it is named', async () => {
    const { db, once, turn } = await users()
    // A custom role that inherits one, one that reads every database, and admin's own built-ins.
    await client.db('admin').command({
      createRole: `heir${db}`,
      privileges: [],
      roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }],
    })
    await client.db('admin').command({
      createRole: `everywhere${db}`,
      privileges: [{ resource: { db: '', collection: '' }, actions: ['find'] }],
      roles: [],
    })
    for (const roles of [
      [`heir${db}@admin`],
      [`everywhere${db}@admin`],
      ['root@admin'],
      ['readAnyDatabase@admin'],
      ['clusterMonitor@admin'],
      ['enableSharding@admin'],
      ['read@local'],
      ['readWrite@config'],
      [`read@${db}`, 'dbOwner@admin'],
    ]) {
      once([{ name: 'create_user', args: { connection: 'Test', database: db, user: 'w', roles } }])
      expect(steps(await turn('add'))[0], roles.join()).toMatchObject({
        state: 'refused',
        reason: 'broad_role',
      })
    }
  })

  it('never offers a role or a user MongoDB has not, nor in its own databases', async () => {
    const { db, once, turn } = await users()
    // An admin-only built-in named in another database is no role there.
    once([
      { name: 'create_user', args: { connection: 'Test', database: db, user: 'w', roles: ['clusterAdmin'] } },
    ])
    expect(steps(await turn('add'))[0]).toMatchObject({ state: 'refused', reason: 'role_unknown' })
    once([{ name: 'create_user', args: { connection: 'Test', database: db, user: 'w', roles: ['nobody'] } }])
    expect(steps(await turn('add'))[0]).toMatchObject({ state: 'refused', reason: 'role_unknown' })
    // Nor a user of MongoDB's own databases, nor a name MongoDB would not take.
    for (const database of ['local', 'config']) {
      once([{ name: 'create_user', args: { connection: 'Test', database, user: 'w', roles: [] } }])
      expect(steps(await turn('add'))[0], database).toMatchObject({
        state: 'refused',
        reason: 'system_namespace',
      })
    }
    // A name a URL path would read as "this" or "the one above" (review of B5).
    for (const user of ['.', '..']) {
      once([{ name: 'drop_user', args: { connection: 'Test', database: db, user } }])
      expect(steps(await turn('drop'))[0], user).toMatchObject({
        state: 'refused',
        reason: 'invalid_arguments',
      })
    }
    once([{ name: 'create_user', args: { connection: 'Test', database: db, user: 'a\u0001b', roles: [] } }])
    expect(steps(await turn('add'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    once([
      {
        name: 'create_user',
        args: { connection: 'Test', database: db, user: 'w', roles: ['read@a\u0000b'] },
      },
    ])
    expect(steps(await turn('add'))[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    expect(((await client.db(db).command({ usersInfo: 1 })).users as unknown[]).length).toBe(0)
  })

  it('never drops the account the connection signs in as', async () => {
    const { h, db, once, turn } = await users()
    await client
      .db(db)
      .command({ createUser: 'app', pwd: 'the-apps-own-pw-1', roles: [{ role: 'readWrite', db }] })
    namedConnection(h.t.app, mongo.port, 'AsApp', {
      settings: {
        auth: { mechanism: 'SCRAM-SHA-256', username: 'app', password: 'the-apps-own-pw-1', authSource: db },
      },
    })
    once([{ name: 'drop_user', args: { connection: 'AsApp', database: db, user: 'app' } }])
    expect(steps(await turn('drop app'))[0]).toMatchObject({ state: 'refused', reason: 'own_account' })
    expect(((await client.db(db).command({ usersInfo: 'app' })).users as unknown[]).length).toBe(1)
  })

  it('checks again on the click: a role made broad since, or a user made since', async () => {
    const { db, card } = await users()
    await client.db('admin').command({ createRole: `later${db}`, privileges: [], roles: [] })
    const asked = await card([
      {
        name: 'create_user',
        args: { connection: 'Test', database: db, user: 'w1', roles: [`later${db}@admin`] },
      },
    ])
    await client
      .db('admin')
      .command({ grantRolesToRole: `later${db}`, roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }] })
    const { ended } = await asked.decide('confirm', { password: PASSWORD })
    expect(ended).toMatchObject({ state: 'error', reason: 'broad_role' })
    const again = await card([
      { name: 'create_user', args: { connection: 'Test', database: db, user: 'w2', roles: ['read'] } },
    ])
    await client.db(db).command({ createUser: 'w2', pwd: 'made-elsewhere-12', roles: [] })
    expect((await again.decide('confirm', { password: PASSWORD })).ended).toMatchObject({
      state: 'error',
      reason: 'user_exists',
    })
    expect(((await client.db(db).command({ usersInfo: 'w1' })).users as unknown[]).length).toBe(0)
  })

  it('never offers a change where the agent may not write', async () => {
    const { h, db, once, turn } = await users()
    namedConnection(h.t.app, mongo.port, 'NoWrites', { aiAgentWrites: false })
    once([
      { name: 'create_user', args: { connection: 'NoWrites', database: db, user: 'w', roles: ['read'] } },
    ])
    expect(steps(await turn('add'))[0]).toMatchObject({ state: 'refused', reason: 'agent_writes_off' })
  })

  it('lists and changes users for a database administrator, also one hiding personal data from themselves', async () => {
    const { t, ctx, as, connectionId } = await restrictedApp(
      mongo,
      [{ db: 'hr', coll: 'people', field: 'email' }],
      {
        ai: { privateNetworks: ['127.0.0.1/32'] },
      } as never,
    )
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
    const db = `b4r${randomUUID().slice(0, 6)}`
    for (const role of ['editor', 'admin'] as const) {
      const person = as(role)
      // User report 2026-10-30: an administrator who hides personal data from themselves shows it again
      // at will — hiding is how they view values, not what they may do: MongoDB's accounts stay theirs.
      if (role === 'admin') ctx.personalFields.setHiddenFromSelf(connectionId, person.id, true)
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
                // An administrator's change would wait on its card: its reads show the guard passed.
                calls: [
                  { name: 'list_users', args: { connection: 'M', database: db } },
                  role === 'editor'
                    ? {
                        name: 'create_user',
                        args: { connection: 'M', database: db, user: 'w', roles: ['read'] },
                      }
                    : { name: 'list_roles', args: { connection: 'M', database: db } },
                ],
              }
            : { text: 'ok' },
        ),
      )
      const out = (await call('POST', '/api/ai/agent', { message: 'users' })).payload
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as AiChatLine)
      const [listed, created] = steps(out)
      if (role === 'editor') {
        expect([listed!.state, listed!.reason], `${role} list`).toEqual(['refused', 'forbidden'])
        // Refused by the agent before any read: no route was asked (its words would be said).
        expect(listed!.summary, role).toBeUndefined()
        expect(created!.state, `${role} create`).toBe('refused')
        expect(created!.proposal, role).toBeUndefined()
      } else {
        expect([listed!.state, created!.state], `${role} lists`).toEqual(['done', 'done'])
      }
    }
  })
})
