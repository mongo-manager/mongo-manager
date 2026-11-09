// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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

/** W6.3: an administrator can turn the agent's writes off per connection. */
describe('the per-connection agent writes switch', () => {
  it('is on by default, saved without reconnecting, and travels with export and import', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t.close)
    expect(h.t.app.ctx.connections.get(h.connectionId)!.aiAgentWrites).toBe(true)
    const dto = (await h.call('GET', '')).json() as Record<string, unknown>
    expect(dto.aiAgentWrites).toBe(true)
    let invalidated = 0
    const manager = h.t.app.ctx.manager
    const invalidate = manager.invalidate.bind(manager)
    manager.invalidate = async (id: string) => {
      invalidated++
      return invalidate(id)
    }
    const res = await h.call('PATCH', '', {
      name: dto.name,
      group: null,
      color: null,
      favorite: dto.favorite,
      readOnly: dto.readOnly,
      settings: dto.settings,
      aiAgentWrites: false,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ aiAgentWrites: false })
    expect(invalidated).toBe(0)
    expect(h.t.app.ctx.connections.get(h.connectionId)!.aiAgentWrites).toBe(false)

    const exported = await h.t.app.inject({
      method: 'POST',
      url: '/api/connections/export',
      headers: h.headers,
      payload: {},
    })
    const file = exported.json() as { connections: Array<Record<string, unknown>> }
    expect(file.connections[0]!.aiAgentWrites).toBe(false)
    const imported = await h.t.app.inject({
      method: 'POST',
      url: '/api/connections/import',
      headers: h.headers,
      payload: { ...file, connections: file.connections.map((c) => ({ ...c, name: 'Copy' })) },
    })
    expect(imported.statusCode, imported.payload).toBeLessThan(300)
    const copy = h.t.app.ctx.connections.list().find((c) => c.name === 'Copy')!
    expect(copy.aiAgentWrites).toBe(false)
  })

  it('is changed only by those who manage connections', async () => {
    const team = await teamHarness(mongo)
    closers.push(team.t.close)
    const editor = team.user('editor')
    const res = await editor.call('PATCH', '', { aiAgentWrites: false })
    expect([403, 404]).toContain(res.statusCode)
    expect(team.t.app.ctx.connections.get(team.connectionId)!.aiAgentWrites).toBe(true)
  })
})

// Design 2026-10-25 (C5): the tools turned off travel as the switch does, and are as guarded.
describe('the agent’s tools turned off on a connection (C5)', () => {
  it('travel with the connection’s export and import', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t.close)
    h.t.app.ctx.connections.setAiAgentToolsOff(h.connectionId, ['drop_database', 'list_users'])
    const exported = await h.t.app.inject({
      method: 'POST',
      url: '/api/connections/export',
      headers: h.headers,
      payload: {},
    })
    const file = exported.json() as { connections: Array<Record<string, unknown>> }
    expect(file.connections[0]!.aiAgentToolsOff).toEqual(['list_users', 'drop_database'])
    const imported = await h.t.app.inject({
      method: 'POST',
      url: '/api/connections/import',
      headers: h.headers,
      payload: { ...file, connections: file.connections.map((c) => ({ ...c, name: 'Copy' })) },
    })
    expect(imported.statusCode, imported.payload).toBeLessThan(300)
    const copy = h.t.app.ctx.connections.list().find((c) => c.name === 'Copy')!
    expect(copy.aiAgentToolsOff).toEqual(['list_users', 'drop_database'])
  })

  it('are changed only by those who manage connections', async () => {
    const team = await teamHarness(mongo)
    closers.push(team.t.close)
    const res = await team.user('editor').call('PATCH', '', { aiAgentToolsOff: ['find_documents'] })
    expect([403, 404]).toContain(res.statusCode)
    expect(team.t.app.ctx.connections.get(team.connectionId)!.aiAgentToolsOff).toEqual([])
  })
})
