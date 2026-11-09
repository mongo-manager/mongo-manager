// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import type { ServerSample } from '../src/monitor/sampler'
import type { LiveSyncRecord } from '../src/livesync/repo'
import { MAX_HISTORY_CONNECTIONS } from '../src/monitor/history'
import { UNMEASURED } from './support/samples'

/**
 * Independent review of W3 (alerts): a connection deleted with a live sync and an every-connection
 * rule (I1), the SMTP password kept for another server (I3), a repeat sync failure (I4), the
 * sampling cap (M1), the fan-out ceiling (M7), acknowledgement and what the bell's detail shows
 * (M8), the health cache after a change (M9).
 */
const apps: TestApp[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of closers.splice(0)) await c()
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true, alerts: { enabled: true, privateNetworks: ['127.0.0.1/32'] } }, {
    alerts: { retryDelaysMs: [1] },
  } as never)
  apps.push(t)
  const { ctx } = t.app
  const conn = (name: string) =>
    ctx.connections.create(
      {
        name,
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
      },
      null,
    ).id
  const as = (role: Role, grants: Record<string, Role | 'none'> = {}) => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    for (const [id, g] of Object.entries(grants)) ctx.grants.set(id, user.id, g)
    const s = ctx.sessions.create(user.id, {})
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
      t.app.inject({
        method,
        url: `/api${url}`,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      })
    return Object.assign(call, { id: user.id, username: user.username })
  }
  return { t, ctx, conn, as }
}

const sample = (current: number): ServerSample => ({
  t: 0,
  ops: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
  network: { inPerSec: 0, outPerSec: 0 },
  connections: { current, available: 1000 },
  memory: { residentMb: 1, virtualMb: 1 },
  cache: null,
  queues: { readers: 0, writers: 0 },
  restarted: false,
  baseline: false,
  uptimeSec: 1,
  version: '8.0.0',
  ...UNMEASURED,
})

const syncInput = (ownerId: string, source: string, target: string) => ({
  owner: ownerId,
  name: 'orders sync',
  source: { connectionId: source, db: 'shop', coll: 'orders', collections: null },
  target: { connectionId: target, db: 'shop', coll: 'orders' },
  options: {
    startMode: 'copy' as const,
    errorPolicy: 'pause' as const,
    followNew: false,
    anonymous: false,
    masked: false,
    pairs: [['orders', 'orders']] as Array<[string, string]>,
  },
  stamps: {
    versions: { source: 0, target: 0 },
    settings: { source: '', target: '' },
    deployments: {
      source: { kind: 'replicaSet' as const, setName: 'a', hosts: ['a:1'] },
      target: { kind: 'replicaSet' as const, setName: 'b', hosts: ['b:1'] },
    },
  },
  state: 'paused' as const,
  startAt: '100.1',
  copyJobId: null,
})

describe('W3 review: alerts and connection deletion (I1)', () => {
  it('deletes a source connection whose sync stops, with an every-connection rule, cleanly', async () => {
    const { ctx, conn, as } = await setup()
    const admin = as('admin')
    const source = conn('Source')
    const target = conn('Target')
    await admin('POST', '/alerts/rules', { kind: 'event', event: 'liveSync.stopped' })
    const owner = ctx.users.create({ username: 'owner', passwordHash: 'x', role: 'editor' })
    ctx.liveSync.repo.create(syncInput(owner.id, source, target) as never)
    const invalidate = vi.spyOn(ctx.manager, 'invalidate')
    const res = await admin('DELETE', `/connections/${source}`)
    expect(res.statusCode).toBe(204)
    // What follows the stop ran too.
    expect(invalidate).toHaveBeenCalledWith(source)
    const [event] = (await admin('GET', '/alerts/history')).json()
    expect(event).toMatchObject({
      event: 'liveSync.stopped',
      connectionId: null,
      connectionName: 'Source',
      detail: expect.objectContaining({ reason: 'connection_deleted' }),
    })
  })

  it('never throws out of an event, whatever the store says', async () => {
    const { ctx, conn } = await setup()
    const id = conn('Gone')
    ctx.alerts.repo.createRule(
      {
        kind: 'event',
        event: 'job.failed',
        connectionId: null,
        enabled: true,
        channels: { inApp: true, email: false, webhooks: [] },
      },
      null,
    )
    vi.spyOn(ctx.alerts.repo, 'insertEvent').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() =>
      ctx.alerts.onJob({
        id: 'j',
        kind: 'data.copy',
        state: 'failed',
        connectionId: id,
        db: 'a',
        coll: 'b',
      } as never),
    ).not.toThrow()
    // The scheduler calls event() itself.
    expect(() => ctx.alerts.event({ event: 'job.failed', connectionId: id, detail: {} })).not.toThrow()
  })

  it('finishes a deletion whatever another live sync listener does', async () => {
    const { ctx, conn, as } = await setup()
    const admin = as('admin')
    const source = conn('Source')
    const target = conn('Target')
    const owner = ctx.users.create({ username: 'owner2', passwordHash: 'x', role: 'editor' })
    ctx.liveSync.repo.create(syncInput(owner.id, source, target) as never)
    ctx.liveSync.onChange(() => {
      throw new Error('a listener’s bug')
    })
    const invalidate = vi.spyOn(ctx.manager, 'invalidate')
    expect((await admin('DELETE', `/connections/${source}`)).statusCode).toBe(204)
    expect(invalidate).toHaveBeenCalledWith(source)
  })
})

describe('W3 review: repeat live sync failures (I4)', () => {
  it('alerts again when a sync fails again after it ran', async () => {
    const { ctx, conn, as } = await setup()
    const admin = as('admin')
    const a = conn('A')
    await admin('POST', '/alerts/rules', { kind: 'event', event: 'liveSync.stopped' })
    const r = (state: string) =>
      ({
        id: 's1',
        name: 'Orders',
        state,
        reason: state === 'live' ? null : 'write_error',
        source: { connectionId: a, db: 'shop', coll: 'orders', collections: null },
      }) as unknown as LiveSyncRecord
    ctx.alerts.onLiveSync(r('attention'))
    ctx.alerts.onLiveSync(r('attention'))
    ctx.alerts.onLiveSync(r('live'))
    ctx.alerts.onLiveSync(r('attention'))
    const history = (await admin('GET', '/alerts/history?state=event')).json()
    expect(history).toHaveLength(2)
  })
})

describe('W3 review: the SMTP password and its server (I3)', () => {
  const settings = {
    enabled: true,
    host: 'smtp.example.com',
    port: 587,
    security: 'starttls',
    username: 'mailer',
    password: 'smtp-pass-0123456',
    from: 'alerts@example.com',
    recipients: ['ops@example.com'],
  }
  it('asks for the password again when the server, port, security or account changes', async () => {
    const { ctx, as } = await setup()
    const admin = as('admin')
    expect((await admin('PUT', '/alerts/channels/email', settings)).statusCode).toBe(200)
    const { password: _drop, ...keep } = settings
    void _drop
    // Same server: the stored password stays.
    expect(
      (await admin('PUT', '/alerts/channels/email', { ...keep, recipients: ['dba@example.com'] })).statusCode,
    ).toBe(200)
    for (const change of [
      { host: 'evil.example.net' },
      { port: 25 },
      { security: 'tls' },
      { username: 'other' },
    ]) {
      const res = await admin('PUT', '/alerts/channels/email', { ...keep, ...change })
      expect([res.statusCode, res.json().details?.reason, change]).toEqual([400, 'password_required', change])
    }
    expect(ctx.alerts.repo.smtp()).toMatchObject({ host: 'smtp.example.com', password: 'smtp-pass-0123456' })
    // With the password typed again, the change is taken.
    const moved = await admin('PUT', '/alerts/channels/email', { ...settings, host: 'mail2.example.com' })
    expect(moved.statusCode).toBe(200)
  })
})

describe('W3 review: one sampling cap for history and alerts (M1)', () => {
  it('counts history and alert connections together on every path', async () => {
    const { ctx, conn, as } = await setup()
    const admin = as('admin')
    const ids = Array.from({ length: MAX_HISTORY_CONNECTIONS + 1 }, (_, i) => conn(`c${i}`))
    for (const id of ids.slice(0, MAX_HISTORY_CONNECTIONS - 1)) ctx.metricHistory.setEnabled(id, true)
    const rule = await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId: ids[MAX_HISTORY_CONNECTIONS - 1],
      metric: 'connections',
      threshold: 1,
    })
    expect(rule.statusCode).toBe(201)
    const last = ids[MAX_HISTORY_CONNECTIONS]!
    // History on the 51st: refused, though only 49 record history.
    const history = await admin('PUT', `/connections/${last}/server/history/settings`, { enabled: true })
    expect(history.statusCode).toBe(409)
    const another = await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId: last,
      metric: 'connections',
      threshold: 1,
    })
    expect(another.json().details?.reason).toBe('too_many_sampled')
    // A rule made paused, then switched on: the same check.
    const paused = ctx.alerts.repo.createRule(
      {
        kind: 'metric',
        connectionId: last,
        metric: 'connections',
        threshold: 1,
        sustain: 1,
        enabled: false,
        channels: { inApp: true, email: false, webhooks: [] },
      },
      null,
    )
    const on = await admin('PATCH', `/alerts/rules/${paused.id}`, { enabled: true })
    expect(on.json().details?.reason).toBe('too_many_sampled')
  })
})

describe('W3 review: fan-out ceiling (M7)', () => {
  it('sends to many webhooks a few at a time', async () => {
    let now = 0
    let most = 0
    const server = createServer((_req, res) => {
      now++
      most = Math.max(most, now)
      setTimeout(() => {
        now--
        res.end('ok')
      }, 60)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    closers.push(() => new Promise((r) => server.close(() => r())))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
    const { ctx, conn, as } = await setup()
    const admin = as('admin')
    const id = conn('Prod')
    const hooks: string[] = []
    for (let i = 0; i < 10; i++)
      hooks.push((await admin('POST', '/alerts/channels/webhooks', { name: `h${i}`, url })).json().id)
    await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId: id,
      metric: 'connections',
      threshold: 1,
      sustain: 1,
      channels: { inApp: false, webhooks: hooks },
    })
    await ctx.alerts.engine.onSample(id, sample(5))
    await ctx.alerts.notifier.idle()
    expect(most).toBeGreaterThan(0)
    expect(most).toBeLessThanOrEqual(4)
  })
})

describe('W3 review: acknowledgement and the bell’s detail (M8)', () => {
  it('lets editors dismiss for themselves, administrators acknowledge for all, and hides names', async () => {
    const { ctx, conn, as } = await setup()
    const admin = as('admin')
    const id = conn('Prod')
    await admin('POST', '/alerts/rules', { kind: 'event', event: 'liveSync.stopped' })
    ctx.alerts.onLiveSync({
      id: 's9',
      name: 'Secret project sync',
      state: 'failed',
      reason: 'source_gone',
      source: { connectionId: id, db: 'hr', coll: 'salaries', collections: null },
    } as unknown as LiveSyncRecord)
    const editor = as('editor')
    await editor('PUT', '/me/alerts', { inApp: true })
    await admin('PUT', '/me/alerts', { inApp: true })
    const [seen] = (await editor('GET', '/alerts/active')).json()
    expect(seen.detail).toEqual({ state: 'failed', reason: 'source_gone' })
    expect(JSON.stringify(seen)).not.toMatch(/Secret project|salaries/)
    // Administrators see the names.
    expect((await admin('GET', '/alerts/active')).json()[0].detail.name).toBe('Secret project sync')
    // An editor cannot acknowledge for everyone; dismissing hides it from them alone.
    expect((await editor('POST', `/alerts/${seen.id}/acknowledge`)).statusCode).toBe(403)
    expect((await editor('POST', `/alerts/${seen.id}/dismiss`)).statusCode).toBe(200)
    expect((await editor('GET', '/alerts/active')).json()).toEqual([])
    expect((await admin('GET', '/alerts/active')).json()).toHaveLength(1)
    const ack = await admin('POST', `/alerts/${seen.id}/acknowledge`)
    expect(ack.json()).toMatchObject({ acknowledgedBy: admin.username })
    // Someone who may not see it cannot dismiss it either.
    const viewer = as('viewer')
    expect((await viewer('POST', `/alerts/${seen.id}/dismiss`)).statusCode).toBe(404)
  })
})

describe('W3 review: health after a change (M9)', () => {
  it('forgets a connection’s health when it is changed or deleted', async () => {
    const { ctx, conn, as } = await setup()
    const admin = as('admin')
    const id = conn('Prod')
    const forget = vi.spyOn(ctx.health, 'forget')
    const { settings } = (await admin('GET', `/connections/${id}`)).json()
    // An edit of its settings (a new name alone changes nothing it was made of: manager-opening.test.ts).
    await admin('PATCH', `/connections/${id}`, { settings: { ...settings, appName: 'edited' } })
    expect(forget).toHaveBeenCalledWith(id)
    forget.mockClear()
    await admin('DELETE', `/connections/${id}`)
    expect(forget).toHaveBeenCalledWith(id)
  })
})
