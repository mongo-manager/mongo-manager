// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'
import { slow } from './support/slowness'

/**
 * W3.4: live health on the connection cards and the Overview — ping latency, version, topology
 * and alerts firing. Cheap: cached for 30 s, the list never opens a connection by itself.
 * Threat model: health of a connection the user may not see; alert counts of a server they may not
 * watch; the list used to make the server dial every saved connection.
 */
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const make = (name: string, port: number) =>
    ctx.connections.create(
      {
        name,
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({
          hosts: [{ host: '127.0.0.1', port }],
          serverSelectionTimeoutMS: 1_000,
          connectTimeoutMS: 1_000,
        }),
      },
      null,
    ).id
  const up = make('Up', mongo.port)
  const down = make('Down', 1)
  const as = (role: Role, grants: Record<string, Role | 'none'> = {}) => {
    const user = ctx.users.create({ username: `u-${Math.random()}`, passwordHash: 'x', role })
    for (const [id, g] of Object.entries(grants)) ctx.grants.set(id, user.id, g)
    const s = ctx.sessions.create(user.id, {})
    return (url: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api${url}`,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
      })
  }
  return { t, ctx, up, down, as }
}

describe('connection health (W3.4)', () => {
  it('pings a connection on its page, and caches the answer', async () => {
    const { ctx, up, as } = await setup()
    const viewer = as('viewer')
    const first = await viewer(`/connections/${up}/health`)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({
      connectionId: up,
      state: 'ok',
      topology: 'standalone',
      alertsFiring: 0,
    })
    expect(first.json().latencyMs).toBeGreaterThanOrEqual(0)
    expect(first.json().version).toMatch(/^\d+\.\d+/)
    const client = await ctx.manager.getClient(up)
    const spy = vi.spyOn(client, 'db')
    const again = await viewer(`/connections/${up}/health`)
    expect(again.json().checkedAt).toBe(first.json().checkedAt)
    expect(spy).not.toHaveBeenCalled()
  })

  it('says a server is down, without its address', async () => {
    const { down, as } = await setup()
    const res = await as('admin')(`/connections/${down}/health`)
    expect(res.json()).toMatchObject({ state: 'down', latencyMs: null, version: null })
    expect(res.body).not.toContain('127.0.0.1')
  })

  it('lists health without opening connections: idle until something opened them', async () => {
    const { ctx, up, down, as } = await setup()
    const admin = as('admin')
    const list = await admin('/connections/health')
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: up, state: 'idle' }),
        expect.objectContaining({ connectionId: down, state: 'idle' }),
      ]),
    )
    expect(ctx.manager.isOpen(up)).toBe(false)
    expect(ctx.manager.isOpen(down)).toBe(false)
    await admin(`/connections/${up}/health`)
    const after = (await admin('/connections/health')).json()
    expect(after.find((h: { connectionId: string }) => h.connectionId === up)).toMatchObject({ state: 'ok' })
  })

  it('shows only connections the user may see, and alert counts only where they may watch', async () => {
    const { ctx, up, down, as } = await setup()
    const rule = ctx.alerts.repo.createRule(
      {
        kind: 'metric',
        connectionId: up,
        metric: 'connections',
        threshold: 1,
        sustain: 1,
        enabled: true,
        channels: { inApp: true, email: false, webhooks: [] },
      },
      null,
    )
    ctx.alerts.repo.insertEvent({
      ruleId: rule.id,
      connectionId: up,
      connectionName: 'Up',
      metric: 'connections',
      event: null,
      state: 'firing',
      value: 5,
      threshold: 1,
      startedAt: 0,
      detail: {},
      snoozed: false,
    })
    const editor = as('editor', { [down]: 'none' })
    const list = (await editor('/connections/health')).json()
    expect(list.map((h: { connectionId: string }) => h.connectionId)).toEqual([up])
    expect(list[0].alertsFiring).toBe(1)
    expect((await editor(`/connections/${down}/health`)).statusCode).toBe(404)
    // A viewer may not watch the server: no count.
    const viewer = as('viewer')
    expect(
      (await viewer('/connections/health'))
        .json()
        .find((h: { connectionId: string }) => h.connectionId === up).alertsFiring,
    ).toBe(0)
  })
})
