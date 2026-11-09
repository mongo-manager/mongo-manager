// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Collection, Db, MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'
import { describe as describeAlert } from '../src/alerts/notifier'
import { REPORT_COUNT_BOUND, REPORT_RUNS_KEPT } from '../src/alerts/reports'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'

/**
 * Design 2026-10-25 (C7): scheduled reports — a connection's counts on a cadence, said through the
 * alert channels, numbers only; an administrator's; never by a personal field, MongoDB's own
 * namespaces or server JavaScript; as the connection's own credentials.
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

async function admin() {
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  const db = `rp${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([
      { status: 'shipping', email: 'a@r.test' },
      { status: 'shipping', email: 'b@r.test' },
      { status: 'done', email: 'c@r.test' },
    ])
  const input = (over: object = {}) => ({
    name: 'Morning orders',
    connectionId: h.connectionId,
    measures: [
      { label: 'Orders', db, coll: 'orders' },
      { label: 'Shipping', db, coll: 'orders', filter: { status: 'shipping' } },
    ],
    cadence: { kind: 'daily', times: ['09:00'] },
    timeZone: 'Europe/Istanbul',
    ...over,
  })
  return { h, api, db, input }
}

describe('scheduled reports (C7)', () => {
  it('counts on its cadence, keeps the last run, and says it in the bell, numbers only', async () => {
    const { h, api, input } = await admin()
    await api('PUT', 'me/alerts', { inApp: true })
    const made = await api('POST', 'alerts/reports', input())
    expect(made.statusCode, made.payload).toBe(201)
    const report = made.json() as { id: string; nextRunAt: number }
    expect(report.nextRunAt).toBeGreaterThan(h.t.clock.now)
    // Not due yet: nothing runs.
    await h.t.app.ctx.reports.tick()
    expect(h.t.app.ctx.reports.repo.get(report.id)!.lastRun).toBeNull()
    h.t.clock.now = report.nextRunAt + 1
    await h.t.app.ctx.reports.tick()
    const after = h.t.app.ctx.reports.repo.get(report.id)!
    expect(after.lastRun!.values).toEqual([
      { label: 'Orders', count: 3 },
      { label: 'Shipping', count: 2 },
    ])
    expect(after.nextRunAt).toBeGreaterThan(report.nextRunAt)
    const bell = (await api('GET', 'alerts/active')).json() as Array<{
      event: string
      detail: Record<string, unknown>
    }>
    const ran = bell.find((a) => a.event === 'report.ready')!
    expect(ran.detail).toMatchObject({ report: 'Morning orders', Orders: 3, Shipping: 2 })
    // Mail says the report by its name and its counts, never its id.
    const event = h.t.app.ctx.alerts.repo.history({ limit: 5 }).find((e) => e.event === 'report.ready')!
    const mail = describeAlert(event, 'event')
    expect(mail.subject).toContain('Morning orders')
    expect(mail.text).toContain('Shipping: 2')
    expect(mail.text).not.toContain(report.id)
  })

  it('runs now, says "at least" past its bound, and goes with its connection', async () => {
    const { h, api, input } = await admin()
    const report = (await api('POST', 'alerts/reports', input())).json() as { id: string }
    vi.spyOn(Collection.prototype, 'countDocuments').mockResolvedValue(REPORT_COUNT_BOUND + 1)
    const now = await api('POST', `alerts/reports/${report.id}/run`)
    expect(now.json()).toMatchObject({
      values: [
        { label: 'Orders', count: 3 },
        { label: 'Shipping', count: REPORT_COUNT_BOUND, atLeast: true },
      ],
    })
    // A run now leaves the next scheduled one as it was.
    expect(h.t.app.ctx.reports.repo.get(report.id)!.lastRun).not.toBeNull()
    h.t.app.ctx.connections.delete(h.connectionId)
    expect((await api('GET', 'alerts/reports')).json()).toEqual([])
  })

  it('refuses MongoDB’s own namespaces, server JavaScript, a cadence that runs too often, an unknown webhook', async () => {
    const { api, db, input } = await admin()
    const refused = async (body: object) =>
      (await api('POST', 'alerts/reports', body)).json() as { details?: unknown }
    expect(
      await refused(input({ measures: [{ label: 'Users', db: 'admin', coll: 'system.users' }] })),
    ).toMatchObject({
      details: { reason: 'system_namespace', measure: 0 },
    })
    expect(
      await refused(input({ measures: [{ label: 'JS', db, coll: 'orders', filter: { $where: 'true' } }] })),
    ).toMatchObject({ details: { reason: 'server_js' } })
    expect(await refused(input({ cadence: { kind: 'cron', expression: '*/5 * * * *' } }))).toMatchObject({
      details: { reason: 'cadence_min_gap' },
    })
    expect(
      (await api('POST', 'alerts/reports', input({ channels: { webhooks: ['nope'] } }))).statusCode,
    ).toBe(400)
    // A view or a time series: its pipeline could pick by a personal field.
    await client.db(db).createCollection('shippingView', { viewOn: 'orders', pipeline: [] })
    expect(await refused(input({ measures: [{ label: 'V', db, coll: 'shippingView' }] }))).toMatchObject({
      details: { reason: 'measure_view', measure: 0 },
    })
    // Two counts of one label, or a label of the report's own.
    expect(
      (await api('POST', 'alerts/reports', input({ measures: [{ label: 'reportId', db, coll: 'orders' }] })))
        .statusCode,
    ).toBe(400)
  })

  it('never counts by a personal field, when saved or when run, for anyone', async () => {
    const { h, api, db, input } = await admin()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'email' }])
    const byEmail = input({
      measures: [{ label: 'A', db, coll: 'orders', filter: { email: { $regex: '^a' } } }],
    })
    expect((await api('POST', 'alerts/reports', byEmail)).json()).toMatchObject({
      details: { reason: 'personal_field', measure: 0 },
    })
    // A filter the gate would read otherwise (the type of what holds a personal field): refused too.
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'contact.phone' }])
    const byType = input({
      measures: [
        { label: 'B', db, coll: 'orders', filter: { $expr: { $eq: [{ $type: '$contact' }, 'object'] } } },
      ],
    })
    expect((await api('POST', 'alerts/reports', byType)).json()).toMatchObject({
      details: { reason: 'personal_field', measure: 0 },
    })
    // Rules named after it was saved: the run leaves that count out, said why.
    h.t.app.ctx.personalFields.set(h.connectionId, [])
    const report = (await api('POST', 'alerts/reports', input())).json() as { id: string }
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'status' }])
    expect((await api('POST', `alerts/reports/${report.id}/run`)).json()).toMatchObject({
      values: [
        { label: 'Orders', count: 3 },
        { label: 'Shipping', count: null, reason: 'personal_field' },
      ],
    })
  })

  it('is an administrator’s', async () => {
    const team = await teamHarness(mongo)
    closers.push(team.t.close)
    const editor = team.user('editor')
    const res = await editor.get('/api/alerts/reports')
    expect(res.statusCode).toBe(403)
  })

  it('refuses a connection signed in per person: no one is behind a report', async () => {
    const { h, api, input } = await admin()
    vi.spyOn(h.t.app.ctx.manager, 'perPerson').mockReturnValue(true)
    expect((await api('POST', 'alerts/reports', input())).json()).toMatchObject({
      details: { reason: 'per_person' },
    })
  })

  it('changes, turns off and deletes a report; one turned off never runs', async () => {
    const { h, api, input } = await admin()
    const report = (await api('POST', 'alerts/reports', input())).json() as { id: string; nextRunAt: number }
    const off = await api('PATCH', `alerts/reports/${report.id}`, { enabled: false, name: 'Evening' })
    expect(off.json()).toMatchObject({ enabled: false, name: 'Evening' })
    h.t.clock.now = report.nextRunAt + 1
    await h.t.app.ctx.reports.tick()
    expect(h.t.app.ctx.reports.repo.get(report.id)!.lastRun).toBeNull()
    expect((await api('DELETE', `alerts/reports/${report.id}`)).statusCode).toBe(204)
    expect((await api('DELETE', `alerts/reports/${report.id}`)).statusCode).toBe(404)
  })
})

// Review of C7a.
describe('scheduled reports: the review of C7a', () => {
  it('never lets a report it cannot schedule take the loop down: it is turned off, said why, the others run (I1)', async () => {
    const { h, api, input } = await admin()
    const bad = (await api('POST', 'alerts/reports', input({ name: 'Bad' }))).json() as {
      id: string
      nextRunAt: number
    }
    const good = (await api('POST', 'alerts/reports', input({ name: 'Good' }))).json() as { id: string }
    // A zone this build no longer knows (as after a Node change).
    h.t.app.ctx.store.db
      .prepare("UPDATE alert_reports SET time_zone = 'Mars/Olympus' WHERE id = ?")
      .run(bad.id)
    h.t.clock.now = bad.nextRunAt + 1
    await expect(h.t.app.ctx.reports.tick()).resolves.toBeUndefined()
    const after = h.t.app.ctx.reports.repo.get(bad.id)!
    expect(after).toMatchObject({ enabled: false, nextRunAt: null })
    expect(after.lastRun!.values[0]).toMatchObject({ count: null, reason: 'invalid_cadence' })
    expect(h.t.app.ctx.reports.repo.get(good.id)!.lastRun!.values[0]).toMatchObject({ count: 3 })
  })

  it('keeps each count’s failure when a run fails, and skips a report turned off since the tick began (M3, M6)', async () => {
    const { h, api, input } = await admin()
    const report = (await api('POST', 'alerts/reports', input())).json() as { id: string; nextRunAt: number }
    h.t.clock.now = report.nextRunAt + 1
    const runner = h.t.app.ctx.reports
    const values = vi.spyOn(runner as unknown as { values: () => Promise<unknown> }, 'values')
    values.mockRejectedValueOnce(new Error('boom'))
    await runner.tick()
    const failed = runner.repo.get(report.id)!
    expect(failed.lastRun!.values).toEqual([
      { label: 'Orders', count: null, reason: 'failed' },
      { label: 'Shipping', count: null, reason: 'failed' },
    ])
    expect(failed.nextRunAt).toBeGreaterThan(report.nextRunAt)
    // Due, then turned off before its turn: it does not run.
    h.t.clock.now = failed.nextRunAt! + 1
    const stale = runner.repo.due(h.t.clock.now)
    runner.repo.patch(report.id, { enabled: false })
    vi.spyOn(runner.repo, 'due').mockReturnValueOnce(stale)
    values.mockClear()
    await runner.tick()
    expect(values).not.toHaveBeenCalled()
  })

  it('turns a report off or renames it however its counts stand now (I2)', async () => {
    const { h, api, db, input } = await admin()
    const report = (await api('POST', 'alerts/reports', input())).json() as { id: string }
    // The rules now name the filter's field: the counts would be refused — turning it off is not.
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'status' }])
    const off = await api('PATCH', `alerts/reports/${report.id}`, { enabled: false, name: 'Paused' })
    expect(off.statusCode, off.payload).toBe(200)
    // Turned on again, its counts are checked.
    expect((await api('PATCH', `alerts/reports/${report.id}`, { enabled: true })).json()).toMatchObject({
      details: { reason: 'personal_field' },
    })
  })

  it('says why the gate refused, a collection not read, a filter where fields are encrypted on the client (M4, M5, nit)', async () => {
    const { h, api, db, input } = await admin()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'email' }])
    const schema = input({
      measures: [{ label: 'S', db, coll: 'orders', filter: { $jsonSchema: { required: ['status'] } } }],
    })
    expect((await api('POST', 'alerts/reports', schema)).json()).toMatchObject({
      details: { reason: 'not_supported' },
    })
    h.t.app.ctx.personalFields.set(h.connectionId, [])
    const report = (await api('POST', 'alerts/reports', input())).json() as { id: string }
    vi.spyOn(Db.prototype, 'listCollections').mockImplementation(() => {
      throw new Error('not authorized')
    })
    expect((await api('POST', `alerts/reports/${report.id}/run`)).json()).toMatchObject({
      values: [{ reason: 'failed' }, { reason: 'failed' }],
    })
    vi.restoreAllMocks()
    h.t.app.ctx.connections.update(h.connectionId, {
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port: mongo.port }],
        encryption: {
          enabled: true,
          keyVaultNamespace: 'kv.__keyVault',
          kms: { local: { key: 'A'.repeat(128) } },
        },
      }),
    })
    expect((await api('POST', 'alerts/reports', input())).json()).toMatchObject({
      details: { reason: 'encrypted_filter', measure: 1 },
    })
  })

  it('keeps each report’s last runs, and says whether a run went anywhere (M7, nit)', async () => {
    const { h, api, input } = await admin()
    const report = (await api('POST', 'alerts/reports', input({ channels: { inApp: false } }))).json() as {
      id: string
    }
    let last: { sent?: boolean } = {}
    for (let i = 0; i < REPORT_RUNS_KEPT + 3; i++)
      last = (await api('POST', `alerts/reports/${report.id}/run`)).json()
    expect(last.sent).toBe(false)
    const runs = h.t.app.ctx.alerts.repo.history({ limit: 500 }).filter((e) => e.event === 'report.ready')
    expect(runs).toHaveLength(REPORT_RUNS_KEPT)
  })

  it('shows those who are not administrators only that a report ran (M1)', async () => {
    const team = await teamHarness(mongo)
    closers.push(team.t.close)
    const db = `rq${randomUUID().slice(0, 6)}`
    await client.db(db).collection('o').insertOne({ n: 1 })
    const runner = team.t.app.ctx.reports
    const report = runner.repo.create(
      {
        name: 'R',
        connectionId: team.connectionId,
        measures: [{ label: 'state', db, coll: 'o' }],
        cadence: { kind: 'daily', times: ['09:00'] },
        timeZone: 'UTC',
        enabled: true,
        channels: { inApp: true, email: false, webhooks: [] },
      },
      null,
    )
    await runner.run(report)
    const editor = team.user('editor')
    team.t.app.ctx.preferences.set(editor.id, 'alerts.inApp', true)
    const bell = (await editor.get('/api/alerts/active')).json() as Array<{ event: string; detail: object }>
    expect(bell.find((a) => a.event === 'report.ready')!.detail).toEqual({})
  })
})

// Re-review of C7.
describe('scheduled reports: the re-review of C7', () => {
  it('stops after the run in flight, saving and sending nothing of it: it stays due (I1)', async () => {
    const { h, api, input } = await admin()
    const report = (await api('POST', 'alerts/reports', input())).json() as { id: string; nextRunAt: number }
    h.t.clock.now = report.nextRunAt + 1
    const runner = h.t.app.ctx.reports
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const values = vi.spyOn(runner as unknown as { values: () => Promise<unknown> }, 'values')
    values.mockImplementationOnce(async () => {
      await held
      return [{ label: 'Orders', count: 3 }]
    })
    const ticking = runner.tick()
    // A second tick while the first runs: the stop still waits for the first.
    await runner.tick()
    const stopping = runner.stop()
    let stopped = false
    void stopping.then(() => (stopped = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(stopped).toBe(false)
    release()
    await ticking
    await stopping
    const after = runner.repo.get(report.id)!
    expect(after.lastRun).toBeNull()
    expect(after.nextRunAt).toBe(report.nextRunAt)
    expect(h.t.app.ctx.alerts.repo.history({ limit: 10 }).some((e) => e.event === 'report.ready')).toBe(false)
  })

  it('checks the schedule of a report turned on again, and keeps its counts when saying them fails (minors 2, 4)', async () => {
    const { h, api, input } = await admin()
    const report = (await api('POST', 'alerts/reports', input())).json() as { id: string }
    await api('PATCH', `alerts/reports/${report.id}`, { enabled: false })
    h.t.app.ctx.store.db
      .prepare("UPDATE alert_reports SET time_zone = 'Mars/Olympus' WHERE id = ?")
      .run(report.id)
    expect((await api('PATCH', `alerts/reports/${report.id}`, { enabled: true })).json()).toMatchObject({
      details: { reason: 'invalid_cadence' },
    })
    h.t.app.ctx.store.db.prepare("UPDATE alert_reports SET time_zone = 'UTC' WHERE id = ?").run(report.id)
    vi.spyOn(h.t.app.ctx.alerts.repo, 'insertEvent').mockImplementation(() => {
      throw new Error('store busy')
    })
    const ran = await api('POST', `alerts/reports/${report.id}/run`)
    expect(ran.statusCode).toBe(200)
    expect(h.t.app.ctx.reports.repo.get(report.id)!.lastRun!.values[0]).toMatchObject({ count: 3 })
  })

  it('says a run sent nowhere where e-mail has no mail server and its webhooks are off (minor 5)', async () => {
    const { api, input } = await admin()
    const report = (
      await api('POST', 'alerts/reports', input({ channels: { inApp: false, email: true } }))
    ).json() as {
      id: string
    }
    expect((await api('POST', `alerts/reports/${report.id}/run`)).json()).toMatchObject({ sent: false })
  })
})

describe('scheduled reports: the final review of wave C', () => {
  it('counts no more once stopping (minor 2)', async () => {
    const { h, api, input } = await admin()
    const report = (await api('POST', 'alerts/reports', input())).json() as { id: string; nextRunAt: number }
    h.t.clock.now = report.nextRunAt + 1
    const runner = h.t.app.ctx.reports
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const seen = vi.spyOn(runner as unknown as { viewProblem: () => Promise<unknown> }, 'viewProblem')
    seen.mockImplementationOnce(async () => {
      await held
      return null
    })
    const ticking = runner.tick()
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    const stopping = runner.stop()
    release()
    await ticking
    await stopping
    // The report's second count was never read.
    expect(seen).toHaveBeenCalledTimes(1)
    expect(runner.repo.get(report.id)!.lastRun).toBeNull()
  })

  it('takes a filter the gate rebuilds in its own key order where rules apply (minor 3)', async () => {
    const { h, api, db, input } = await admin()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'email' }])
    const byLet = input({
      measures: [
        {
          label: 'Big',
          db,
          coll: 'orders',
          filter: { $expr: { $let: { in: { $gt: ['$$t', 0] }, vars: { t: '$total' } } } },
        },
      ],
    })
    const made = await api('POST', 'alerts/reports', byLet)
    expect(made.statusCode).toBe(201)
    const run = (await api('POST', `alerts/reports/${(made.json() as { id: string }).id}/run`)).json() as {
      values: Array<{ reason?: string }>
    }
    expect(run.values[0]!.reason).toBeUndefined()
  })
})
