// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type AiAgentStep, type AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf } from './support/agent'
import { H, makeApp } from './helpers'

/**
 * The AI database manager (design 2026-10-25, C7): the person's alerts read, and for an administrator
 * the alert rules and scheduled reports read and changed on cards — through the alerts routes as the
 * person, channels by name, numbers only.
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
  for (const c of closers.splice(0).reverse()) await c()
})

const ended = (lines: AiChatLine[]) =>
  lines.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))

async function agent() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  await api('POST', 'ai/providers', { name: 'Fake', kind: 'openai', baseUrl: `${fake.url}/v1`, model: 'm' })
  await api('PUT', 'me/ai-agent', { on: true })
  const db = `c7${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([{ s: 'a' }, { s: 'a' }, { s: 'b' }])
  const once = (calls: FakeCall[]) =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text: 'ok' })))
  const told = () => {
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
  }
  const turn = async () =>
    (await api('POST', 'ai/agent', { message: 'go' })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
  const card = async (calls: FakeCall[]) => {
    once(calls)
    const stream = await agentTurn(h.t.app, h.headers, { message: 'do it' })
    const awaiting = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const decide = async (decision: 'confirm' | 'decline') => {
      await api('POST', `ai/agent/runs/${run}/decide`, { call: awaiting.step.id, decision })
      await stream.ended
      return ended(stream.lines).at(-1)!
    }
    return { step: awaiting.step, decide }
  }
  const hook = async (name: string) =>
    (await api('POST', 'alerts/channels/webhooks', { name, url: 'https://hooks.c7.test/x' })).json() as {
      id: string
    }
  return { h, api, db, once, told, turn, card, hook }
}

describe('alert rules and scheduled reports through the agent (C7)', () => {
  it('makes a threshold rule on a card, its webhook by name, and lists it', async () => {
    const { h, card, hook, once, turn, told } = await agent()
    const pager = await hook('Pager')
    const asked = await card([
      {
        name: 'create_alert_rule',
        args: {
          kind: 'metric',
          connection: 'Test',
          metric: 'connections',
          threshold: 300,
          webhooks: ['pager'],
        },
      },
    ])
    expect(asked.step.proposal).toMatchObject({
      payload: {
        metric: 'connections',
        threshold: 300,
        connection: 'Test',
        channels: { webhooks: ['Pager'] },
      },
      preview: { channels: { inApp: true, email: false, webhooks: ['Pager'] } },
    })
    // Never a webhook's address on the card.
    expect(JSON.stringify(asked.step.proposal)).not.toContain('hooks.c7.test')
    expect(await asked.decide('confirm')).toMatchObject({ state: 'done', summary: { alertRule: 'created' } })
    const rule = h.t.app.ctx.alerts.repo.listRules(h.connectionId)[0]!
    expect(rule).toMatchObject({ metric: 'connections', threshold: 300, channels: { webhooks: [pager.id] } })
    once([{ name: 'list_alert_rules', args: {} }])
    await turn()
    expect(told()).toMatchObject({
      rules: [{ id: rule.id, metric: 'connections', connection: 'Test', channels: { webhooks: ['Pager'] } }],
    })
    expect(JSON.stringify(told())).not.toContain('hooks.c7.test')
  })

  it('changes, snoozes and deletes a rule by its id; never one for every connection', async () => {
    const { h, api, card, once, turn } = await agent()
    const made = (
      await api('POST', 'alerts/rules', {
        kind: 'event',
        connectionId: h.connectionId,
        event: 'backup.failed',
        channels: { inApp: true },
      })
    ).json() as { id: string }
    const off = await card([{ name: 'update_alert_rule', args: { rule: made.id, enabled: false } }])
    expect(await off.decide('confirm')).toMatchObject({ state: 'done' })
    expect(h.t.app.ctx.alerts.repo.getRule(made.id)!.enabled).toBe(false)
    const snooze = await card([{ name: 'snooze_alert_rule', args: { rule: made.id, minutes: 60 } }])
    expect(snooze.step.proposal!.preview).toMatchObject({ snoozeMinutes: 60 })
    await snooze.decide('confirm')
    expect(h.t.app.ctx.alerts.repo.getRule(made.id)!.snoozedUntil).toBeGreaterThan(h.t.clock.now)
    const gone = await card([{ name: 'delete_alert_rule', args: { rule: made.id } }])
    expect(gone.step.proposal).toMatchObject({ destructive: true })
    await gone.decide('confirm')
    expect(h.t.app.ctx.alerts.repo.getRule(made.id)).toBeUndefined()
    const every = (
      await api('POST', 'alerts/rules', { kind: 'event', connectionId: null, event: 'job.failed' })
    ).json() as { id: string }
    once([{ name: 'delete_alert_rule', args: { rule: every.id } }])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'rule_every_connection' })
    once([{ name: 'create_alert_rule', args: { kind: 'event', event: 'job.failed' } }])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
  })

  it('makes a report on a card — its next runs and words — runs it now, and tells the counts', async () => {
    const { h, db, card } = await agent()
    const asked = await card([
      {
        name: 'create_report',
        args: {
          connection: 'Test',
          name: 'Orders',
          counts: [
            { label: 'All', database: db, collection: 'orders' },
            { label: 'A', database: db, collection: 'orders', filter: '{"s":"a"}' },
          ],
          cadence: '{"kind":"daily","times":["09:00"]}',
          timeZone: 'Europe/Istanbul',
        },
      },
    ])
    expect(asked.step.proposal!.preview).toMatchObject({
      counts: 2,
      nextRuns: expect.any(Array),
      words: expect.any(String),
      channels: { inApp: true },
    })
    expect(await asked.decide('confirm')).toMatchObject({ state: 'done', summary: { report: 'created' } })
    const report = h.t.app.ctx.reports.repo.list()[0]!
    expect(report.measures[1]).toMatchObject({ label: 'A', filter: { s: 'a' } })
    const ran = await card([{ name: 'run_report', args: { report: 'orders' } }])
    const end = await ran.decide('confirm')
    expect(end).toMatchObject({ state: 'done', summary: { report: 'ran', counts: 2 } })
  })

  it('refuses a report by a personal field, on a view, a webhook not listed, e-mail with no mail server', async () => {
    const { h, db, once, turn, told } = await agent()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 's' }])
    const report = (counts: object[], extra: object = {}) => ({
      name: 'create_report',
      args: {
        connection: 'Test',
        name: 'R',
        counts,
        cadence: '{"kind":"daily","times":["09:00"]}',
        timeZone: 'UTC',
        ...extra,
      },
    })
    once([report([{ label: 'A', database: db, collection: 'orders', filter: '{"s":"a"}' }])])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'report_personal_field' })
    await client.db(db).createCollection('v', { viewOn: 'orders', pipeline: [] })
    once([report([{ label: 'V', database: db, collection: 'v' }])])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'report_measure_view' })
    once([report([{ label: 'A', database: db, collection: 'orders' }], { webhooks: ['nowhere'] })])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'webhook_unknown' })
    expect(told()).toMatchObject({ refused: 'webhook_unknown' })
    once([report([{ label: 'A', database: db, collection: 'orders' }], { email: true })])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'email_off' })
    once([
      report([{ label: 'A', database: db, collection: 'orders' }], {
        cadence: '{"kind":"cron","expression":"* * * * *"}',
      }),
    ])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'cadence_min_gap' })
  })

  it('is an administrator’s: anyone else is refused before any card, and reads only their own bell', async () => {
    const fake = await startFakeAi()
    closers.push(fake.close)
    const t = await makeApp({ auth: true, ai: { privateNetworks: ['127.0.0.1/32'] } } as never)
    closers.push(t.close)
    const { ctx } = t.app
    ctx.connections.create(
      {
        name: 'Test',
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
      },
      null,
    )
    const user = ctx.users.create({
      username: `ed-${randomUUID().slice(0, 6)}`,
      passwordHash: 'x',
      role: 'editor',
    })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const headers = { ...H, 'x-csrf-token': session.csrfToken, cookie: `mm_sid=${sessionId}` }
    const api = (method: 'POST' | 'PUT', path: string, payload: object) =>
      t.app.inject({ method, url: `/api/${path}`, headers, payload })
    // A provider is an administrator's to add; the editor uses it.
    const root = ctx.users.create({
      username: `ad-${randomUUID().slice(0, 6)}`,
      passwordHash: 'x',
      role: 'admin',
    })
    const rootSession = ctx.sessions.create(root.id, {})
    await t.app.inject({
      method: 'POST',
      url: '/api/ai/providers',
      headers: {
        ...H,
        'x-csrf-token': rootSession.session.csrfToken,
        cookie: `mm_sid=${rootSession.sessionId}`,
      },
      payload: { name: 'F', kind: 'openai', baseUrl: `${fake.url}/v1`, model: 'm' },
    })
    await api('PUT', 'me/ai-agent', { on: true })
    const turnOf = async (call: FakeCall) => {
      fake.reply(agentReply((c) => (c.results.length === 0 ? { calls: [call] } : { text: 'ok' })))
      return ended(
        (await api('POST', 'ai/agent', { message: 'x' })).payload
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as AiChatLine),
      )
    }
    for (const call of [
      {
        name: 'create_alert_rule',
        args: { kind: 'metric', connection: 'Test', metric: 'connections', threshold: 1 },
      },
      { name: 'list_alert_rules', args: {} },
      { name: 'run_report', args: { report: 'any' } },
    ])
      expect((await turnOf(call))[0], call.name).toMatchObject({ reason: 'forbidden' })
    expect((await turnOf({ name: 'list_alerts', args: {} }))[0]).toMatchObject({ state: 'done' })
  })

  it('lists the person’s alerts of the connections it is told of, a report’s run with its counts', async () => {
    const { h, api, db, once, turn, told } = await agent()
    const report = (
      await api('POST', 'alerts/reports', {
        name: 'Orders',
        connectionId: h.connectionId,
        measures: [{ label: 'All', db, coll: 'orders' }],
        cadence: { kind: 'daily', times: ['09:00'] },
        timeZone: 'UTC',
      })
    ).json() as { id: string }
    await api('POST', `alerts/reports/${report.id}/run`)
    once([{ name: 'list_alerts', args: {} }])
    await turn()
    expect(told()).toMatchObject({
      alerts: [
        { event: 'report.ready', connection: 'Test', report: 'Orders', counts: [{ label: 'All', count: 3 }] },
      ],
    })
  })
})

// Review of C7b.
describe('alert rules and scheduled reports through the agent: the review of C7b', () => {
  const daily = (db: string, name = 'Orders') => ({
    name,
    connectionId: '',
    measures: [{ label: 'All', db, coll: 'orders' }],
    cadence: { kind: 'daily', times: ['09:00'] },
    timeZone: 'UTC',
  })

  it('refuses before any card where the tool is off on the rule’s or report’s connection, or the agent may not change it (I1)', async () => {
    const { h, api, db, once, turn } = await agent()
    const rule = (
      await api('POST', 'alerts/rules', { kind: 'event', connectionId: h.connectionId, event: 'job.failed' })
    ).json() as { id: string }
    await api('POST', 'alerts/reports', { ...daily(db), connectionId: h.connectionId })
    h.t.app.ctx.connections.setAiAgentToolsOff(h.connectionId, ['delete_alert_rule', 'run_report'])
    once([{ name: 'delete_alert_rule', args: { rule: rule.id } }])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'tool_off' })
    once([{ name: 'run_report', args: { report: 'Orders' } }])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'tool_off' })
    h.t.app.ctx.connections.setAiAgentToolsOff(h.connectionId, [])
    h.t.app.ctx.connections.setAiAgentWrites(h.connectionId, false)
    once([{ name: 'run_report', args: { report: 'Orders' } }])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'agent_writes_off' })
  })

  it('names a webhook only where one has the name and it is on; e-mail is refused only where asked (I2, M6, M7)', async () => {
    const { h, api, hook, once, turn, card } = await agent()
    await hook('Pager')
    await hook('Pager')
    const quiet = await hook('Quiet')
    await api('PATCH', `alerts/channels/webhooks/${quiet.id}`, { enabled: false })
    const rule = (webhooks: string[]) => ({
      name: 'create_alert_rule',
      args: { kind: 'metric', connection: 'Test', metric: 'connections', threshold: 9, webhooks },
    })
    once([rule(['Pager'])])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'webhook_ambiguous' })
    // Re-review of C7 (minor 6): two that differ by their letter case only, as ambiguous.
    await hook('Ops')
    await hook('OPS')
    once([rule(['ops'])])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'webhook_ambiguous' })
    once([rule(['Quiet'])])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'webhook_off' })
    // A rule with e-mail on (no mail server): its bell still changes.
    const made = h.t.app.ctx.alerts.repo.createRule(
      {
        kind: 'event',
        connectionId: h.connectionId,
        event: 'job.failed',
        enabled: true,
        channels: { inApp: true, email: true, webhooks: [] },
      },
      null,
    )
    const asked = await card([{ name: 'update_alert_rule', args: { rule: made.id, inApp: false } }])
    expect(asked.step.state).toBe('awaiting')
    await asked.decide('decline')
  })

  it('drops a deleted webhook from the reports that named it (I3)', async () => {
    const { h, api, db, hook } = await agent()
    const pager = await hook('Pager')
    const report = (
      await api('POST', 'alerts/reports', {
        ...daily(db),
        connectionId: h.connectionId,
        channels: { inApp: true, webhooks: [pager.id] },
      })
    ).json() as { id: string }
    await h.t.app.inject({
      method: 'DELETE',
      url: `/api/alerts/channels/webhooks/${pager.id}`,
      headers: h.headers,
    })
    expect(h.t.app.ctx.reports.repo.get(report.id)!.channels.webhooks).toEqual([])
  })

  it('refuses a threshold on an event rule, and a report name taken (M9, M10)', async () => {
    const { h, api, db, once, turn } = await agent()
    const rule = (
      await api('POST', 'alerts/rules', { kind: 'event', connectionId: h.connectionId, event: 'job.failed' })
    ).json() as { id: string }
    once([{ name: 'update_alert_rule', args: { rule: rule.id, threshold: 5 } }])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    await api('POST', 'alerts/reports', { ...daily(db), connectionId: h.connectionId })
    once([
      {
        name: 'create_report',
        args: {
          connection: 'Test',
          name: 'orders',
          counts: [{ label: 'A', database: db, collection: 'orders' }],
          cadence: '{"kind":"daily","times":["09:00"]}',
          timeZone: 'UTC',
        },
      },
    ])
    expect(ended(await turn())[0]).toMatchObject({ state: 'refused', reason: 'report_name_taken' })
  })
})
