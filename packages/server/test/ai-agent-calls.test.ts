import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AGENT_CALL_HEADER, callRoute, type AgentAuth } from '../src/ai/agent/calls'
import { H, LOCAL_COOKIE_VALUE, LOCAL_KEY } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

/**
 * W6.3: the agent's tools call the app's own routes, as the person — their session, rights, masking,
 * rate limits and audit — never the driver directly. The way in is a single-use token that never
 * leaves the process.
 */
describe('agent calls go through the app’s routes as the person', () => {
  it('a viewer’s write is refused by the route itself; an admin’s goes through and is audited as them', async () => {
    const team = await teamHarness(mongo)
    closers.push(team.t.close)
    const { ctx } = team.t.app
    const as = (role: 'admin' | 'viewer'): AgentAuth => {
      const user = ctx.users.create({
        username: `a-${role}-${randomUUID().slice(0, 6)}`,
        passwordHash: 'x',
        role,
      })
      const { sessionId } = ctx.sessions.create(user.id, {})
      return { kind: 'user', sessionId, ip: '10.1.2.3', host: H.host }
    }
    const db = `ag${randomUUID().slice(0, 8)}`
    const path = `/connections/${team.connectionId}/databases/${db}/collections`
    const viewer = await callRoute(team.t.app, as('viewer'), 'POST', path, {
      kind: 'collection',
      name: 'users',
    })
    expect(viewer.status).toBe(403)
    const admin = as('admin')
    const ok = await callRoute(team.t.app, admin, 'POST', path, { kind: 'collection', name: 'users' })
    expect(ok.status).toBe(201)
    const row = ctx.audit.list({ action: 'collections.create' }).at(0)!
    expect(row).toMatchObject({ outcome: 'success', ip: '10.1.2.3', namespace: db })
    expect(row.username).toMatch(/^a-admin-/)
    // B6: a call made for no run carries none.
    expect((row.details as { agent?: unknown }).agent).toBeUndefined()
    const linked = await callRoute(
      team.t.app,
      { ...admin, via: { run: 'r1', chat: 'c1', call: '2.1' } },
      'POST',
      path,
      { kind: 'collection', name: 'orders' },
    )
    expect(linked.status).toBe(201)
    expect(ctx.audit.list({ action: 'collections.create' }).at(0)!.details).toMatchObject({
      agent: { run: 'r1', chat: 'c1', call: '2.1' },
    })
  })

  it('works in local mode with the browser’s cookie and page key', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t.close)
    const auth: AgentAuth = {
      kind: 'local',
      localCookie: LOCAL_COOKIE_VALUE,
      localKey: LOCAL_KEY,
      ip: '127.0.0.1',
      host: H.host,
    }
    const res = await callRoute(h.t.app, auth, 'GET', `/connections/${h.connectionId}/databases`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ databases: expect.any(Array) })
    // Without the page key the local gate refuses it, as it refuses any request.
    const keyless = await callRoute(
      h.t.app,
      { ...auth, localKey: undefined },
      'GET',
      `/connections/${h.connectionId}/databases`,
    )
    expect(keyless.status).toBe(401)
  })

  it('a session revoked meanwhile is refused (the person is read again on every call)', async () => {
    const team = await teamHarness(mongo)
    closers.push(team.t.close)
    const { ctx } = team.t.app
    const user = ctx.users.create({
      username: `r-${randomUUID().slice(0, 6)}`,
      passwordHash: 'x',
      role: 'admin',
    })
    const { sessionId } = ctx.sessions.create(user.id, {})
    ctx.sessions.revoke(sessionId)
    const res = await callRoute(
      team.t.app,
      { kind: 'user', sessionId, ip: '10.0.0.1', host: H.host },
      'GET',
      '/connections',
    )
    expect(res.status).toBe(401)
  })

  it('refuses a made-up or replayed token from outside (abuse case)', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t.close)
    const forged = await h.t.app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { host: H.host, [AGENT_CALL_HEADER]: 'a'.repeat(43) },
    })
    expect(forged.statusCode).toBe(401)
    // A bad token never falls back to the cookie the request also carries.
    const withCookie = await h.t.app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { ...H, [AGENT_CALL_HEADER]: 'b'.repeat(43) },
    })
    expect(withCookie.statusCode).toBe(401)
    // A token is taken once: the route caller's own token never works twice.
    const calls = h.t.app.ctx.ai.agent.calls
    const token = calls.issue({
      kind: 'local',
      localCookie: LOCAL_COOKIE_VALUE,
      localKey: LOCAL_KEY,
      ip: '127.0.0.1',
      host: H.host,
    })
    const first = await h.t.app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { host: H.host, 'x-mm-local': LOCAL_KEY, [AGENT_CALL_HEADER]: token },
    })
    expect(first.statusCode).toBe(200)
    const again = await h.t.app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { host: H.host, 'x-mm-local': LOCAL_KEY, [AGENT_CALL_HEADER]: token },
    })
    expect(again.statusCode).toBe(401)
  })

  it('a token expires unused', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t.close)
    const calls = h.t.app.ctx.ai.agent.calls
    const token = calls.issue({
      kind: 'local',
      localCookie: LOCAL_COOKIE_VALUE,
      localKey: LOCAL_KEY,
      ip: '127.0.0.1',
      host: H.host,
    })
    h.t.clock.now += 61_000
    expect(calls.take(token)).toBeNull()
  })
})
