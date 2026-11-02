import { afterEach, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { startHttpsServer } from './support/https-server'
import { startFakeSmtp, type FakeSmtp } from './support/fake-smtp'
import type { ServerSample } from '../src/monitor/sampler'
import type { JobRecord } from '../src/jobs/types'
import type { LiveSyncRecord } from '../src/livesync/repo'
import { UNMEASURED } from './support/samples'

/**
 * W3.3: alerts — rules on a connection's metrics (with hysteresis) and on the app's events; the
 * bell, e-mail and webhooks; snooze, acknowledge and history. Threat model: a non-administrator
 * changing rules or channels; a user seeing alerts of a connection they may not watch; secrets
 * (SMTP password, webhook signing secret) at rest in the clear or sent back; a webhook to a private
 * or metadata address; a forged webhook (unsigned); flapping alerts; values or connection strings
 * leaving the app in a notification.
 */
const apps: TestApp[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const t of apps.splice(0)) await t.close()
})

async function setup(overrides: Record<string, unknown> = {}) {
  const t = await makeApp(
    { auth: true, alerts: { enabled: true, privateNetworks: ['127.0.0.1/32'] }, ...overrides },
    { alerts: { retryDelaysMs: [1, 1, 1] } } as never,
  )
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'Prod',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: 'db.internal.example', port: 27017 }],
        auth: { mechanism: 'DEFAULT', username: 'svc', password: 'mongo-secret-pw', authSource: 'admin' },
      }),
    },
    null,
  ).id
  const as = (role: Role, grant?: Role | 'none') => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    if (grant) ctx.grants.set(connectionId, user.id, grant)
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
  return { t, ctx, connectionId, as }
}

const sample = (over: Partial<ServerSample> = {}): ServerSample => ({
  t: 0,
  ops: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
  network: { inPerSec: 0, outPerSec: 0 },
  connections: { current: 10, available: 1000 },
  memory: { residentMb: 1, virtualMb: 1 },
  cache: { usedBytes: 50, dirtyBytes: 0, maxBytes: 100 },
  queues: { readers: 0, writers: 0 },
  restarted: false,
  baseline: false,
  uptimeSec: 100,
  version: '8.0.0',
  ...UNMEASURED,
  ...over,
})

async function webhookServer(status: number[] = [200]) {
  const hits: Array<{ headers: IncomingHttpHeaders; body: string }> = []
  const server = await startHttpsServer(
    async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.statusCode = status[Math.min(hits.length - 1, status.length - 1)]!
      res.end('ok')
    },
    { plain: true },
  )
  closers.push(() => server.close())
  return { url: `${server.url}/hook`, hits }
}

describe('alert rules (W3.3)', () => {
  it('lets administrators make, change and delete rules; nobody else', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    const created = await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId,
      metric: 'connections',
      threshold: 500,
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ metric: 'connections', threshold: 500, sustain: 2, enabled: true })
    const id = created.json().id
    expect((await admin('PATCH', `/alerts/rules/${id}`, { threshold: 600 })).json().threshold).toBe(600)
    expect((await admin('GET', `/alerts/rules?connectionId=${connectionId}`)).json()).toHaveLength(1)
    for (const role of ['editor', 'viewer'] as const) {
      // Even an admin of the connection: alert rules are the app's settings.
      const user = as(role, 'admin')
      expect((await user('GET', '/alerts/rules')).statusCode).toBe(403)
      expect(
        (
          await user('POST', '/alerts/rules', {
            kind: 'metric',
            connectionId,
            metric: 'connections',
            threshold: 1,
          })
        ).statusCode,
      ).toBe(403)
    }
    const bad = await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId,
      metric: 'cpu',
      threshold: 1,
    })
    expect(bad.statusCode).toBe(400)
    const unknown = await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId: 'nope',
      metric: 'connections',
      threshold: 1,
    })
    expect(unknown.statusCode).toBe(404)
    expect((await admin('DELETE', `/alerts/rules/${id}`)).statusCode).toBe(204)
    const actions = (
      ctx.store.db.prepare('SELECT action FROM audit_log').all() as Array<{ action: string }>
    ).map((r) => r.action)
    expect(actions).toEqual(
      expect.arrayContaining(['alerts.rule.create', 'alerts.rule.update', 'alerts.rule.delete']),
    )
  })

  it('fires after the value stays above the threshold, and resolves only well below it (hysteresis)', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    const rule = (
      await admin('POST', '/alerts/rules', {
        kind: 'metric',
        connectionId,
        metric: 'connections',
        threshold: 100,
      })
    ).json()
    const feed = (n: number) =>
      ctx.alerts.engine.onSample(connectionId, sample({ connections: { current: n, available: 1 } }))
    const firing = () => ctx.alerts.repo.openFiring(rule.id)
    await feed(150)
    expect(firing()).toBeUndefined()
    await feed(150)
    expect(firing()).toMatchObject({ state: 'firing', value: 150, threshold: 100 })
    // Just under the line is not "well below": it stays firing (no flapping).
    await feed(95)
    await feed(95)
    expect(firing()?.state).toBe('firing')
    await feed(85)
    expect(firing()?.state).toBe('firing')
    await feed(85)
    expect(firing()).toBeUndefined()
    const history = (await admin('GET', '/alerts/history')).json()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ state: 'resolved', connectionName: 'Prod', metric: 'connections' })
    // The rule says it is quiet again.
    expect((await admin('GET', '/alerts/rules')).json()[0].firing).toBeNull()
  })

  it('reads cache fill and operations from the sample; a baseline sample measures no rate', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    const cache = (
      await admin('POST', '/alerts/rules', {
        kind: 'metric',
        connectionId,
        metric: 'cacheFill',
        threshold: 90,
        sustain: 1,
      })
    ).json()
    const ops = (
      await admin('POST', '/alerts/rules', {
        kind: 'metric',
        connectionId,
        metric: 'opcounters',
        threshold: 1000,
        sustain: 1,
      })
    ).json()
    const busy = { insert: 600, query: 600, update: 0, delete: 0, getmore: 0, command: 0 }
    await ctx.alerts.engine.onSample(connectionId, sample({ ops: busy, baseline: true }))
    expect(ctx.alerts.repo.openFiring(ops.id)).toBeUndefined()
    await ctx.alerts.engine.onSample(
      connectionId,
      sample({ ops: busy, cache: { usedBytes: 95, dirtyBytes: 0, maxBytes: 100 } }),
    )
    expect(ctx.alerts.repo.openFiring(ops.id)?.value).toBe(1200)
    expect(ctx.alerts.repo.openFiring(cache.id)?.value).toBe(95)
  })
})

describe('the bell (W3.3)', () => {
  it('shows firing alerts only to users who opted in and may watch the connection', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId,
      metric: 'connections',
      threshold: 1,
      sustain: 1,
    })
    await ctx.alerts.engine.onSample(connectionId, sample({ connections: { current: 50, available: 1 } }))
    // Off until each user turns it on.
    expect((await admin('GET', '/alerts/active')).json()).toEqual([])
    expect((await admin('PUT', '/me/alerts', { inApp: true })).statusCode).toBe(200)
    expect((await admin('GET', '/me/alerts')).json()).toEqual({ inApp: true, available: true })
    const shown = (await admin('GET', '/alerts/active')).json()
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ connectionName: 'Prod', metric: 'connections', value: 50 })
    const editor = as('editor')
    await editor('PUT', '/me/alerts', { inApp: true })
    expect((await editor('GET', '/alerts/active')).json()).toHaveLength(1)
    // A viewer may not watch the server; a user the connection is hidden from does not know it exists.
    const viewer = as('viewer')
    await viewer('PUT', '/me/alerts', { inApp: true })
    expect((await viewer('GET', '/alerts/active')).json()).toEqual([])
    const hidden = as('editor', 'none')
    await hidden('PUT', '/me/alerts', { inApp: true })
    expect((await hidden('GET', '/alerts/active')).json()).toEqual([])
    // Dismissed by someone who sees it; not by someone who does not. Acknowledged (for everyone)
    // by an administrator only (W3 review M8).
    expect((await viewer('POST', `/alerts/${shown[0].id}/dismiss`)).statusCode).toBe(404)
    expect((await editor('POST', `/alerts/${shown[0].id}/acknowledge`)).statusCode).toBe(403)
    const ack = await admin('POST', `/alerts/${shown[0].id}/acknowledge`)
    expect(ack.statusCode).toBe(200)
    expect(ack.json()).toMatchObject({ acknowledgedBy: admin.username })
  })

  it('leaves alerts of a rule without the in-app channel out of the bell', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    await admin('PUT', '/me/alerts', { inApp: true })
    await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId,
      metric: 'connections',
      threshold: 1,
      sustain: 1,
      channels: { inApp: false },
    })
    await ctx.alerts.engine.onSample(connectionId, sample({ connections: { current: 50, available: 1 } }))
    expect((await admin('GET', '/alerts/active')).json()).toEqual([])
  })
})

describe('webhooks (W3.3)', () => {
  it('signs the body with HMAC-SHA256, shows the secret once, and sends names and numbers only', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    const hook = await webhookServer()
    const made = await admin('POST', '/alerts/channels/webhooks', { name: 'Ops', url: hook.url })
    expect(made.statusCode).toBe(201)
    const secret: string = made.json().secret
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/)
    const channels = await admin('GET', '/alerts/channels')
    expect(channels.body).not.toContain(secret)
    expect(JSON.stringify(ctx.store.db.prepare('SELECT * FROM alert_channels').all())).not.toContain(secret)
    await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId,
      metric: 'connections',
      threshold: 1,
      sustain: 1,
      channels: { inApp: true, webhooks: [made.json().id] },
    })
    await ctx.alerts.engine.onSample(connectionId, sample({ connections: { current: 50, available: 1 } }))
    await ctx.alerts.notifier.idle()
    expect(hook.hits).toHaveLength(1)
    const { headers, body } = hook.hits[0]!
    const ts = String(headers['x-mm-timestamp'])
    const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`
    expect(headers['x-mm-signature']).toBe(expected)
    const payload = JSON.parse(body)
    expect(payload).toMatchObject({
      type: 'alert.firing',
      alert: {
        metric: 'connections',
        value: 50,
        threshold: 1,
        connection: { id: connectionId, name: 'Prod' },
      },
    })
    // Never where the server is or how the app signs in to it.
    expect(body).not.toMatch(/db\.internal\.example|mongo-secret-pw|svc/)
    const history = (await admin('GET', '/alerts/history')).json()
    expect(history[0].deliveries).toEqual([
      expect.objectContaining({ channel: 'webhook', target: 'Ops', ok: true, attempts: 1 }),
    ])
  })

  it('retries a failing endpoint with backoff, but not a refusal', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    const flaky = await webhookServer([503, 500, 200])
    const refusing = await webhookServer([400])
    const a = (await admin('POST', '/alerts/channels/webhooks', { name: 'Flaky', url: flaky.url })).json()
    const b = (
      await admin('POST', '/alerts/channels/webhooks', { name: 'Refusing', url: refusing.url })
    ).json()
    await admin('POST', '/alerts/rules', {
      kind: 'event',
      event: 'job.failed',
      channels: { inApp: false, webhooks: [a.id, b.id] },
    })
    ctx.alerts.onJob({
      id: 'j1',
      kind: 'data.import',
      state: 'failed',
      connectionId,
      db: 'shop',
      coll: 'orders',
      error: 'E11000 duplicate key { email: "ada@example.com" }',
    } as JobRecord)
    await ctx.alerts.notifier.idle()
    expect(flaky.hits).toHaveLength(3)
    expect(refusing.hits).toHaveLength(1)
    // The job's error text can quote values: it never leaves.
    expect(flaky.hits[0]!.body).not.toContain('ada@example.com')
    expect(JSON.parse(flaky.hits[0]!.body).alert).toMatchObject({
      event: 'job.failed',
      detail: { job: 'j1', kind: 'data.import', namespace: 'shop.orders' },
    })
    const [event] = (await admin('GET', '/alerts/history')).json()
    expect(event.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'Flaky', ok: true, attempts: 3 }),
        expect.objectContaining({ target: 'Refusing', ok: false, attempts: 1, error: 'HTTP 400' }),
      ]),
    )
  })

  it('refuses addresses the egress guard refuses, at creation and at delivery', async () => {
    const { as } = await setup({ alerts: { enabled: true, privateNetworks: [] } })
    const admin = as('admin')
    for (const url of [
      'http://example.com/hook',
      'https://user:pw@example.com/hook',
      'ftp://example.com/hook',
      'https://169.254.169.254/latest',
    ]) {
      const res = await admin('POST', '/alerts/channels/webhooks', { name: 'x', url })
      expect([res.statusCode, url]).toEqual([400, url])
    }
    // A private address is refused when it is used (its name may resolve anywhere until then).
    const local = await admin('POST', '/alerts/channels/webhooks', {
      name: 'Local',
      url: 'https://127.0.0.1:9/x',
    })
    expect(local.statusCode).toBe(201)
    const tested = await admin('POST', `/alerts/channels/webhooks/${local.json().id}/test`)
    expect(tested.json()).toMatchObject({ ok: false, error: 'address_refused' })
  })

  it('does not notify a snoozed rule, but still records what fired', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    const hook = await webhookServer()
    const made = (await admin('POST', '/alerts/channels/webhooks', { name: 'Ops', url: hook.url })).json()
    const rule = (
      await admin('POST', '/alerts/rules', {
        kind: 'metric',
        connectionId,
        metric: 'connections',
        threshold: 1,
        sustain: 1,
        channels: { inApp: true, webhooks: [made.id] },
      })
    ).json()
    const snoozed = await admin('POST', `/alerts/rules/${rule.id}/snooze`, { minutes: 60 })
    expect(snoozed.json().snoozedUntil).not.toBeNull()
    await ctx.alerts.engine.onSample(connectionId, sample({ connections: { current: 50, available: 1 } }))
    await ctx.alerts.notifier.idle()
    expect(hook.hits).toHaveLength(0)
    expect((await admin('GET', '/alerts/history')).json()[0]).toMatchObject({
      state: 'firing',
      snoozed: true,
    })
  })
})

describe('e-mail (W3.3)', () => {
  let smtp: FakeSmtp
  const smtpSettings = (port: number) => ({
    enabled: true,
    host: '127.0.0.1',
    port,
    security: 'starttls',
    username: 'mailer',
    password: 'smtp-pass-0123456',
    from: 'alerts@example.com',
    recipients: ['ops@example.com'],
  })

  it('keeps the SMTP password sealed and write-only, and sends a test message', async () => {
    smtp = await startFakeSmtp({ user: 'mailer', password: 'smtp-pass-0123456' })
    closers.push(() => smtp.close())
    const { as, ctx } = await setup()
    ctx.alerts.notifier.trust(smtp.caPem)
    const admin = as('admin')
    const put = await admin('PUT', '/alerts/channels/email', smtpSettings(smtp.port))
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ passwordSet: true, username: 'mailer' })
    expect(put.body).not.toContain('smtp-pass-0123456')
    expect(JSON.stringify(ctx.store.db.prepare('SELECT * FROM alert_channels').all())).not.toContain(
      'smtp-pass-0123456',
    )
    // Omitted: kept.
    const { password: _omit, ...withoutPassword } = smtpSettings(smtp.port)
    void _omit
    expect((await admin('PUT', '/alerts/channels/email', withoutPassword)).json().passwordSet).toBe(true)
    const test = await admin('POST', '/alerts/channels/email/test')
    expect(test.json()).toEqual({ ok: true, error: null })
    expect(smtp.mails).toHaveLength(1)
    expect(smtp.mails[0]).toMatchObject({ to: ['ops@example.com'], tls: true, user: 'mailer' })
    const audit = JSON.stringify(ctx.store.db.prepare('SELECT details FROM audit_log').all())
    expect(audit).not.toContain('smtp-pass-0123456')
    // null removes it.
    expect(
      (await admin('PUT', '/alerts/channels/email', { ...smtpSettings(smtp.port), password: null })).json()
        .passwordSet,
    ).toBe(false)
    expect((await as('editor')('PUT', '/alerts/channels/email', smtpSettings(smtp.port))).statusCode).toBe(
      403,
    )
  })

  // User report 2026-10-30: the switch turns mail off (and on) by itself, the settings kept as saved.
  it('turns the e-mail channel off and on without the settings being sent again', async () => {
    const { as, ctx } = await setup()
    const admin = as('admin')
    // Nothing set up yet: nothing to turn off.
    expect((await admin('PATCH', '/alerts/channels/email', { enabled: false })).statusCode).toBe(404)
    await admin('PUT', '/alerts/channels/email', smtpSettings(2525))
    const off = await admin('PATCH', '/alerts/channels/email', { enabled: false })
    expect(off.statusCode).toBe(200)
    expect(off.json()).toMatchObject({ enabled: false, host: '127.0.0.1', passwordSet: true })
    expect(ctx.alerts.repo.smtp()).toMatchObject({ enabled: false, password: 'smtp-pass-0123456' })
    expect((await admin('PATCH', '/alerts/channels/email', { enabled: true })).json().enabled).toBe(true)
    expect((await admin('PATCH', '/alerts/channels/email', { enabled: 'no' })).statusCode).toBe(400)
    expect((await admin('PATCH', '/alerts/channels/email', { enabled: false, host: 'x' })).statusCode).toBe(
      400,
    )
    expect((await as('editor')('PATCH', '/alerts/channels/email', { enabled: false })).statusCode).toBe(403)
    const audit = ctx.store.db
      .prepare("SELECT details FROM audit_log WHERE action = 'alerts.email.update'")
      .all() as Array<{ details: string }>
    expect(audit.map((a) => JSON.parse(a.details))).toContainEqual(
      expect.objectContaining({ enabled: false, status: 200 }),
    )
  })

  it('mails a firing alert with a one-line subject naming the connection', async () => {
    smtp = await startFakeSmtp({ user: 'mailer', password: 'smtp-pass-0123456' })
    closers.push(() => smtp.close())
    const { connectionId, as, ctx } = await setup()
    ctx.alerts.notifier.trust(smtp.caPem)
    const admin = as('admin')
    await admin('PUT', '/alerts/channels/email', smtpSettings(smtp.port))
    await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId,
      metric: 'replicationLag',
      threshold: 30,
      sustain: 1,
      channels: { inApp: false, email: true },
    })
    await ctx.alerts.engine.onSample(connectionId, sample(), { replicationLag: 45 })
    await ctx.alerts.notifier.idle()
    expect(smtp.mails).toHaveLength(1)
    const head = smtp.mails[0]!.data.split('\r\n\r\n')[0]!
    expect(head).toMatch(/^Subject: \[Mongo Manager\] Firing: replication lag 45 s on Prod$/m)
  })
})

describe('events (W3.3)', () => {
  it('turns failed jobs, failed scheduled backups and stopped live syncs into events', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    for (const event of ['job.failed', 'backup.failed', 'liveSync.stopped', 'schedule.failed'])
      await admin('POST', '/alerts/rules', { kind: 'event', event })
    ctx.alerts.onJob({
      id: 'b1',
      kind: 'backup.dump',
      state: 'failed',
      connectionId,
      db: 'shop',
      coll: '',
    } as JobRecord)
    // Reported again (a throttled repeat): one event.
    ctx.alerts.onJob({
      id: 'b1',
      kind: 'backup.dump',
      state: 'failed',
      connectionId,
      db: 'shop',
      coll: '',
    } as JobRecord)
    ctx.alerts.onJob({
      id: 'j2',
      kind: 'data.export',
      state: 'done',
      connectionId,
      db: 'shop',
      coll: 'x',
    } as JobRecord)
    ctx.alerts.onLiveSync({
      id: 's1',
      name: 'Orders',
      state: 'failed',
      reason: 'source_gone',
      source: { connectionId, db: 'shop', coll: 'orders', collections: null },
    } as unknown as LiveSyncRecord)
    // A person stopping a sync is no alert.
    ctx.alerts.onLiveSync({
      id: 's2',
      name: 'Other',
      state: 'stopped',
      reason: 'owner',
      source: { connectionId, db: 'shop', coll: null, collections: null },
    } as unknown as LiveSyncRecord)
    ctx.alerts.event({
      event: 'schedule.failed',
      connectionId,
      detail: { schedule: 'Nightly', outcome: 'failed', reason: 'dump_failed' },
    })
    const history = (await admin('GET', '/alerts/history?state=event')).json()
    expect(history.map((h: { event: string }) => h.event).sort()).toEqual([
      'backup.failed',
      'liveSync.stopped',
      'schedule.failed',
    ])
    expect(history.find((h: { event: string }) => h.event === 'liveSync.stopped').detail).toEqual({
      sync: 's1',
      name: 'Orders',
      state: 'failed',
      reason: 'source_gone',
      namespace: 'shop.orders',
    })
  })

  it('takes a rule for one connection only for that connection', async () => {
    const { connectionId, as, ctx } = await setup()
    const admin = as('admin')
    const other = ctx.connections.create(
      {
        name: 'Other',
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'h', port: 1 }] }),
      },
      null,
    ).id
    await admin('POST', '/alerts/rules', { kind: 'event', event: 'job.failed', connectionId: other })
    ctx.alerts.onJob({
      id: 'x',
      kind: 'data.copy',
      state: 'failed',
      connectionId,
      db: 'a',
      coll: 'b',
    } as JobRecord)
    expect((await admin('GET', '/alerts/history')).json()).toEqual([])
    // Deleting a connection deletes its rules; its history stays, with its name.
    ctx.alerts.onJob({
      id: 'y',
      kind: 'data.copy',
      state: 'failed',
      connectionId: other,
      db: 'a',
      coll: 'b',
    } as JobRecord)
    // A threshold firing on it when it goes: resolved, not firing for ever with nothing to resolve it.
    await admin('POST', '/alerts/rules', {
      kind: 'metric',
      connectionId: other,
      metric: 'connections',
      threshold: 1,
      sustain: 1,
    })
    await ctx.alerts.engine.onSample(other, sample({ connections: { current: 9, available: 1 } }))
    ctx.connections.delete(other)
    expect((await admin('GET', '/alerts/rules')).json()).toEqual([])
    const history = (await admin('GET', '/alerts/history')).json()
    expect(history.find((h: { event: string | null }) => h.event === 'job.failed')).toMatchObject({
      connectionId: null,
      connectionName: 'Other',
    })
    expect(history.find((h: { metric: string | null }) => h.metric === 'connections')).toMatchObject({
      state: 'resolved',
      connectionName: 'Other',
    })
  })
})
