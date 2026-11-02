import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { MAX_HISTORY_CONNECTIONS } from '../src/monitor/history'
import type { ServerSample } from '../src/monitor/sampler'
import { H, makeApp, type TestApp } from './helpers'
import { UNMEASURED } from './support/samples'

/** Phase 3b spec §6: history settings (connection admins), range reads (monitors) and delete. */
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const add = () =>
    ctx.connections.create(
      {
        name: `C${Math.random()}`,
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
      },
      null,
    ).id
  const connectionId = add()
  const as = (role: Role) => {
    const user = ctx.users.create({ username: `u-${Math.random()}`, passwordHash: 'x', role })
    ctx.grants.set(connectionId, user.id, role)
    const s = ctx.sessions.create(user.id, {})
    return (method: 'GET' | 'PUT' | 'DELETE', path: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/connections/${connectionId}/server/${path}`,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
        ...(payload ? { payload } : {}),
      })
  }
  const audit = (action: string) =>
    ctx.store.db.prepare('SELECT details FROM audit_log WHERE action = ?').all(action) as Array<{
      details: string
    }>
  return { t, ctx, connectionId, add, as, audit }
}

const sample = (t: number): ServerSample => ({
  t,
  ops: { insert: 1, query: 2, update: 3, delete: 4, getmore: 5, command: 6 },
  network: { inPerSec: 7, outPerSec: 8 },
  connections: { current: 9, available: 91 },
  memory: { residentMb: 10, virtualMb: 100 },
  cache: null,
  queues: { readers: 0, writers: 1 },
  restarted: false,
  baseline: false,
  uptimeSec: 60,
  version: '8.0.4',
  ...UNMEASURED,
})

describe('history routes (phase 3b §6)', () => {
  it('let only a connection admin turn history on, off and delete it, audited', async () => {
    const { ctx, connectionId, as, audit } = await setup()
    const sync = vi.spyOn(ctx.historyRecorder, 'sync').mockImplementation(() => undefined)
    const editor = as('editor')
    expect((await editor('GET', 'history/settings')).json()).toMatchObject({ enabled: false, samples: 0 })
    expect((await editor('PUT', 'history/settings', { enabled: true })).statusCode).toBe(403)
    expect((await editor('DELETE', 'history')).statusCode).toBe(403)
    const admin = as('admin')
    const on = await admin('PUT', 'history/settings', { enabled: true })
    expect(on.statusCode).toBe(200)
    expect(on.json()).toMatchObject({ enabled: true })
    expect(sync).toHaveBeenCalled()
    // The editor's refused attempt is audited too; the admin's change is the successful row.
    const rows = audit('server.history').map((r) => JSON.parse(r.details) as { status: number })
    expect(rows.find((d) => d.status === 200)).toMatchObject({ enabled: true })
    expect(rows.some((d) => d.status === 403)).toBe(true)
    ctx.metricHistory.add(connectionId, sample(1))
    expect((await admin('DELETE', 'history')).statusCode).toBe(204)
    expect(ctx.metricHistory.status(connectionId).samples).toBe(0)
    const deletes = audit('server.history.delete').map((r) => JSON.parse(r.details) as { status: number })
    expect(deletes.map((d) => d.status).sort()).toEqual([204, 403])
    expect((await admin('PUT', 'history/settings', { enabled: 'yes' })).statusCode).toBe(400)
    expect((await as('viewer')('GET', 'history/settings')).statusCode).toBe(403)
  })

  it('refuses the connection past the limit', async () => {
    const { ctx, add, as } = await setup()
    vi.spyOn(ctx.historyRecorder, 'sync').mockImplementation(() => undefined)
    for (let i = 0; i < MAX_HISTORY_CONNECTIONS; i++) ctx.metricHistory.setEnabled(add(), true)
    const res = await as('admin')('PUT', 'history/settings', { enabled: true })
    expect(res.statusCode).toBe(409)
    expect(res.json().details).toMatchObject({ reason: 'limit', max: MAX_HISTORY_CONNECTIONS })
  })

  it('reads a range as averaged points, and refuses unknown ranges (review focus 3)', async () => {
    const { t, ctx, connectionId, as } = await setup()
    const now = t.clock.now
    for (let i = 0; i < 30; i++) ctx.metricHistory.add(connectionId, sample(now - i * 60_000 - 1000))
    const editor = as('editor')
    const hour = (await editor('GET', 'history?range=1h')).json()
    expect(hour).toMatchObject({ range: '1h', stepMs: 60_000 })
    expect(hour.points).toHaveLength(30)
    const day = (await editor('GET', 'history?range=24h')).json()
    expect(day.stepMs).toBe(5 * 60_000)
    expect(day.points.length).toBeLessThanOrEqual(7)
    expect(day.points[0].ops.query).toBe(2)
    for (const bad of ['range=all', 'range=1h&x=1', '', 'range=9999999h'])
      expect((await editor('GET', `history?${bad}`)).statusCode, bad).toBe(400)
  })

  it('never shows the error text of a failed sample', async () => {
    const { ctx, connectionId, as } = await setup()
    ctx.metricHistory.setEnabled(connectionId, true)
    ctx.metricHistory.failed(connectionId, 'connect mongodb://bob:hunter2@h failed', 5)
    const res = await as('editor')('GET', 'history/settings')
    expect(res.body).not.toContain('hunter2')
    expect(res.json()).toMatchObject({ lastError: true })
  })

  it('stops recording a deleted connection (review focus 1)', async () => {
    const { t, ctx, connectionId } = await setup()
    ctx.metricHistory.setEnabled(connectionId, true)
    const sync = vi.spyOn(ctx.historyRecorder, 'sync').mockImplementation(() => undefined)
    const admin = ctx.users.create({ username: `adm-${Math.random()}`, passwordHash: 'x', role: 'admin' })
    const s = ctx.sessions.create(admin.id, {})
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/connections/${connectionId}`,
      headers: { ...H, 'x-csrf-token': s.session.csrfToken },
      cookies: { mm_sid: s.sessionId },
    })
    expect(res.statusCode).toBe(204)
    expect(sync).toHaveBeenCalled()
    expect(ctx.metricHistory.enabled()).toEqual([])
  })
})
