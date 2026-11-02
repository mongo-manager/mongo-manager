import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { ProfilerReverter, ProfilerReverts, REVERT_AFTER_MS, RETRY_MS } from '../src/monitor/profiler'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * Phase 3b spec §3.1: the profiler per database. Monitors see it; connection admins change it;
 * level 2 is confirmed and reverts by itself after 30 minutes, even across a restart.
 */
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  await client.db('p1').collection('c').insertOne({ a: 1 })
}, slow(120_000))
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
  await client.db('p1').command({ profile: 0, slowms: 100, sampleRate: 1 })
})

async function setup(readOnly = false) {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
    },
    null,
  ).id
  const as = (role: Role) => {
    const user = ctx.users.create({ username: `u-${Math.random()}`, passwordHash: 'x', role })
    ctx.grants.set(connectionId, user.id, role)
    const s = ctx.sessions.create(user.id, {})
    return (method: 'GET' | 'PUT', path: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/connections/${connectionId}/server/${path}`,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
        ...(payload ? { payload } : {}),
      })
  }
  const audit = () =>
    (
      ctx.store.db
        .prepare("SELECT details FROM audit_log WHERE action = 'server.profiler' ORDER BY id")
        .all() as Array<{
        details: string
      }>
    ).map((r) => JSON.parse(r.details) as Record<string, unknown>)
  /** A reverter over the same store, as a restarted app would build it. */
  const reverter = (client: (id: string) => Promise<MongoClient> = (id) => ctx.manager.getClient(id)) =>
    new ProfilerReverter({
      reverts: new ProfilerReverts(ctx.store.db),
      client,
      hold: (id) => ctx.manager.hold(id),
      audit: (e) => ctx.audit.append(e),
      now: () => t.clock.now,
    })
  return { t, ctx, connectionId, as, audit, reverter }
}

const level = async () => (await client.db('p1').command({ profile: -1 })).was as number

describe('profiler (phase 3b §3.1)', () => {
  it('shows each database to monitors and lets only connection admins change it', async () => {
    const { as } = await setup()
    const status = (await as('editor')('GET', 'profiler')).json()
    expect(status.scope).toBe('mongod')
    expect(status.databases.find((d: { name: string }) => d.name === 'p1')).toMatchObject({ level: 0 })
    expect(status.databases.some((d: { name: string }) => d.name === 'local')).toBe(false)
    expect((await as('viewer')('GET', 'profiler')).statusCode).toBe(403)
    expect(
      (await as('editor')('PUT', 'profiler/p1', { level: 1, slowms: 50, sampleRate: 1 })).statusCode,
    ).toBe(403)
    const res = await as('admin')('PUT', 'profiler/p1', { level: 1, slowms: 50, sampleRate: 1 })
    expect(res.statusCode).toBe(200)
    expect(await client.db('p1').command({ profile: -1 })).toMatchObject({ was: 1, slowms: 50 })
  })

  it('asks for confirmation of level 2 and schedules a revert, audited', async () => {
    const { t, ctx, connectionId, as, audit } = await setup()
    const admin = as('admin')
    expect((await admin('PUT', 'profiler/p1', { level: 2, slowms: 100, sampleRate: 1 })).statusCode).toBe(400)
    expect(await level()).toBe(0)
    const res = await admin('PUT', 'profiler/p1', { level: 2, slowms: 100, sampleRate: 1, confirm: true })
    expect(res.json().revertAt).toBe(new Date(t.clock.now + REVERT_AFTER_MS).toISOString())
    expect(ctx.profilerReverts.pending(connectionId)).toHaveLength(1)
    expect(audit().at(-1)).toMatchObject({ db: 'p1', previous: { level: 0 }, next: { level: 2 } })
    const status = (await admin('GET', 'profiler')).json()
    expect(status.databases.find((d: { name: string }) => d.name === 'p1').revertAt).toBe(res.json().revertAt)
  })

  it('reverts at the deadline, and after a restart (review focus 3)', async () => {
    const { t, ctx, connectionId, as, audit, reverter } = await setup()
    await as('admin')('PUT', 'profiler/p1', { level: 2, slowms: 100, sampleRate: 1, confirm: true })
    const restarted = reverter()
    await restarted.tick()
    expect(await level()).toBe(2)
    t.clock.now += REVERT_AFTER_MS + 1
    await restarted.tick()
    expect(await level()).toBe(0)
    expect(ctx.profilerReverts.pending(connectionId)).toEqual([])
    expect(audit().at(-1)).toMatchObject({ reason: 'auto-revert', db: 'p1', next: { level: 0 } })
  })

  it('keeps a failed revert pending and retries (review focus 3)', async () => {
    const { t, ctx, connectionId, as, reverter } = await setup()
    await as('admin')('PUT', 'profiler/p1', { level: 2, slowms: 100, sampleRate: 1, confirm: true })
    let down = true
    const flaky = reverter(async (id) => {
      if (down) throw new Error('unreachable')
      return ctx.manager.getClient(id)
    })
    t.clock.now += REVERT_AFTER_MS + 1
    await flaky.tick()
    expect(ctx.profilerReverts.pending(connectionId)[0]).toMatchObject({
      attempts: 1,
      lastError: 'unreachable',
    })
    expect(await level()).toBe(2)
    down = false
    await flaky.tick() // not due again yet
    expect(await level()).toBe(2)
    t.clock.now += RETRY_MS + 1
    await flaky.tick()
    expect(ctx.profilerReverts.pending(connectionId)).toEqual([])
    expect(await level()).toBe(0)
  })

  it('refuses on a read-only connection, bounds values, and limits changes per minute', async () => {
    const ro = await setup(true)
    const roRes = await ro.as('admin')('PUT', 'profiler/p1', { level: 1, slowms: 5, sampleRate: 1 })
    expect([roRes.statusCode, roRes.json().code]).toEqual([403, 'READ_ONLY'])
    const { as } = await setup()
    const admin = as('admin')
    for (const bad of [
      { level: 3, slowms: 1, sampleRate: 1 },
      { level: 1, slowms: -1, sampleRate: 1 },
      { level: 1, slowms: 1, sampleRate: 2 },
      { level: 1, slowms: 1.5, sampleRate: 1 },
      { level: 1, slowms: 1, sampleRate: 1, extra: true },
    ])
      expect((await admin('PUT', 'profiler/p1', bad)).statusCode, JSON.stringify(bad)).toBe(400)
    expect((await admin('PUT', 'profiler/a.b', { level: 1, slowms: 1, sampleRate: 1 })).statusCode).toBe(400)
    const codes: number[] = []
    for (let i = 0; i < 11; i++)
      codes.push((await admin('PUT', 'profiler/p1', { level: 1, slowms: 100 + i, sampleRate: 1 })).statusCode)
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true)
    expect(codes[10]).toBe(429)
  })

  it('stores the revert before it turns level 2 on (final review I3)', async () => {
    const { ctx, as } = await setup()
    vi.spyOn(ctx.profilerReverts, 'schedule').mockImplementation(() => {
      throw new Error('disk full')
    })
    const res = await as('admin')('PUT', 'profiler/p1', {
      level: 2,
      slowms: 100,
      sampleRate: 1,
      confirm: true,
    })
    expect(res.statusCode).toBe(500)
    // Without a stored revert, level 2 was never switched on.
    expect(await level()).toBe(0)
  })

  it('never lets a revert and a manual change overwrite each other (final review I3)', async () => {
    const { t, ctx, connectionId, as } = await setup()
    await as('admin')('PUT', 'profiler/p1', { level: 2, slowms: 100, sampleRate: 1, confirm: true })
    t.clock.now += REVERT_AFTER_MS + 1
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    const slow = new ProfilerReverter({
      reverts: ctx.profilerReverts,
      client: async (id) => {
        await gate
        return ctx.manager.getClient(id)
      },
      hold: (id) => ctx.manager.hold(id),
      audit: (e) => ctx.audit.append(e),
      now: () => t.clock.now,
    })
    const reverting = slow.tick()
    await new Promise((r) => setTimeout(r, 50))
    // The admin sets level 1 while the revert waits for MongoDB.
    const manual = as('admin')('PUT', 'profiler/p1', { level: 1, slowms: 42, sampleRate: 1 })
    await new Promise((r) => setTimeout(r, 50))
    open()
    await reverting
    expect((await manual).statusCode).toBe(200)
    expect(await client.db('p1').command({ profile: -1 })).toMatchObject({ was: 1, slowms: 42 })
    expect(ctx.profilerReverts.pending(connectionId)).toEqual([])
  })

  it('reports a failed revert without its error text (final review M3)', async () => {
    const { t, ctx, connectionId, as } = await setup()
    await as('admin')('PUT', 'profiler/p1', { level: 2, slowms: 100, sampleRate: 1, confirm: true })
    ctx.profilerReverts.failed(
      connectionId,
      'p1',
      'connect mongodb://bob:hunter2@h:1 failed',
      t.clock.now + RETRY_MS,
    )
    const res = await as('editor')('GET', 'profiler')
    expect(res.body).not.toContain('hunter2')
    expect(res.json().databases.find((d: { name: string }) => d.name === 'p1').revertFailed).toBe(true)
  })

  it('reverts only on the member the change was made on (final review M4)', async () => {
    const { t, ctx, connectionId, reverter } = await setup()
    await client.db('p1').command({ profile: 2, slowms: 100, sampleRate: 1 })
    ctx.profilerReverts.schedule(
      connectionId,
      'p1',
      { level: 0, slowms: 100, sampleRate: 1 },
      t.clock.now,
      'elsewhere:27017',
    )
    t.clock.now += 1
    await reverter(async (id) => ctx.manager.getClient(id)).tick()
    expect(await level()).toBe(2)
    expect(ctx.profilerReverts.pending(connectionId)[0]!.lastError).toMatch(/member/)
  })

  it('a manual change cancels the pending revert, and a second level 2 keeps the first previous settings', async () => {
    const { ctx, connectionId, as } = await setup()
    const admin = as('admin')
    await admin('PUT', 'profiler/p1', { level: 2, slowms: 100, sampleRate: 1, confirm: true })
    await admin('PUT', 'profiler/p1', { level: 2, slowms: 70, sampleRate: 1, confirm: true })
    expect(ctx.profilerReverts.pending(connectionId)[0]!.previous).toMatchObject({ level: 0, slowms: 100 })
    await admin('PUT', 'profiler/p1', { level: 1, slowms: 100, sampleRate: 1 })
    expect(ctx.profilerReverts.pending(connectionId)).toEqual([])
  })
})
