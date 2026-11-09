// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocket } from '@fastify/websocket'
import { ConnectionSettingsSchema, type JobView, type Role } from '@mongo-manager/shared'
import type { JobKind } from '../src/jobs/types'
import { ADMIN_PASSWORD, H, givePassword, makeApp, type TestApp } from './helpers'
import { hashSessionId } from '../src/auth/sessions'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const FAST = { helloTimeoutMs: 200, pingMs: 50 }

/** A job that runs until the test ends it. */
function hangingKind(): JobKind<unknown> & { progress(done: number): void; finish(): void } {
  const runs: Array<{ resolve: () => void; ctx: Parameters<JobKind<unknown>['run']>[0] }> = []
  return {
    name: 'index.create',
    run: (ctx) => new Promise<void>((resolve) => runs.push({ resolve, ctx })),
    cancel: async () => true,
    recover: () => 'unknown',
    progress: (done) => runs.forEach((r) => r.ctx.progress(done, 100)),
    finish: () => runs.splice(0).forEach((r) => r.resolve()),
  }
}

type Payload = { jobs: JobView[]; job: JobView; id: string; now: number }

interface Client {
  ws: WebSocket
  messages: Array<{ ch?: string; type: string; payload?: Payload }>
  next(type: string, ch?: string): Promise<{ type: string; payload: Payload }>
  closed: Promise<number>
  send(message: unknown): void
}

async function setup(overrides: object = {}, realtime: Partial<typeof FAST> = FAST) {
  const t = await makeApp({ auth: true, ...overrides }, { realtime: { ...FAST, ...realtime } })
  apps.push(t)
  await t.app.ready()
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1' }] }),
    },
    null,
  ).id
  const user = (role: Role, grant?: 'viewer' | 'none') => {
    const record = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    if (grant) ctx.grants.set(connectionId, record.id, grant)
    const { sessionId, session } = ctx.sessions.create(record.id, {})
    return { id: record.id, sessionId, csrf: session.csrfToken }
  }
  const open = async (headers: Record<string, string>, opts: { noPong?: boolean } = {}): Promise<Client> => {
    let closedWith!: (code: number) => void
    const closed = new Promise<number>((r) => (closedWith = r))
    const messages: Client['messages'] = []
    const waiters: Array<() => void> = []
    // injectWS builds a bare request: give it the socket facts a real one has (plain HTTP, loopback).
    const request = { headers, socket: { encrypted: false, remoteAddress: '127.0.0.1' } } as never
    const ws = await t.app.injectWS('/ws', request, {
      onInit: (socket) => {
        // Browsers answer pings on their own; injectWS's client does not, so it answers here.
        if (!opts.noPong) socket.on('ping', () => socket.pong())
        socket.on('message', (data) => {
          messages.push(JSON.parse(String(data)))
          waiters.splice(0).forEach((w) => w())
        })
        socket.on('close', (code) => closedWith(code))
      },
    })
    const next = async (type: string, ch?: string) => {
      for (;;) {
        const i = messages.findIndex((m) => m.type === type && (ch === undefined || m.ch === ch))
        if (i >= 0) return messages.splice(i, 1)[0]! as { type: string; payload: Payload }
        await Promise.race([
          new Promise<void>((r) => waiters.push(r)),
          closed.then(() => {
            throw new Error(`closed while waiting for ${type}`)
          }),
        ])
      }
    }
    return { ws, messages, next, closed, send: (m) => ws.send(JSON.stringify(m)) }
  }
  const as = (u: ReturnType<typeof user>) => open({ ...H, cookie: `mm_sid=${u.sessionId}` })
  /** A socket that said hello and subscribed to jobs. */
  const subscribed = async (u: ReturnType<typeof user>) => {
    const c = await as(u)
    c.send({ type: 'hello', csrf: u.csrf })
    await c.next('ready')
    c.send({ ch: 'jobs', type: 'sub' })
    return c
  }
  const start = (kind: JobKind<unknown>, userId: string | null) =>
    ctx.jobs.start(kind, { userId, connectionId, db: 'shop', coll: 'orders', target: 'n_1' }, {})
  return { t, ctx, connectionId, user, open, as, subscribed, start }
}

const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'opened',
    (e: Error) => e.message,
  )

describe('the /ws channel: opening it (phase 1h spec §4)', () => {
  it('refuses a missing or foreign Origin, a foreign Host and a missing session before upgrading', async () => {
    const { open, user } = await setup()
    const u = user('editor')
    const cookie = `mm_sid=${u.sessionId}`
    expect(await refused(open({ host: H.host, cookie }))).toMatch(/403/)
    expect(await refused(open({ host: H.host, origin: 'http://evil.example', cookie }))).toMatch(/403/)
    expect(await refused(open({ host: 'evil.example', origin: 'http://evil.example', cookie }))).toMatch(
      /403/,
    )
    expect(await refused(open({ ...H }))).toMatch(/401/)
    expect(await refused(open({ ...H, cookie: 'mm_sid=forged' }))).toMatch(/401/)
  })

  it('closes a socket that does not say hello in time, or says it with a wrong token', async () => {
    const { as, user } = await setup()
    const u = user('editor')
    expect(await (await as(u)).closed).toBe(4403)
    const wrong = await as(u)
    wrong.send({ type: 'hello', csrf: 'x'.repeat(43) })
    expect(await wrong.closed).toBe(4403)
    const right = await as(u)
    right.send({ type: 'hello', csrf: u.csrf })
    expect(await right.next('ready')).toEqual({ type: 'ready' })
  })

  it('works in local mode with the local token, and still requires the Origin', async () => {
    const { t, open } = await setup({ auth: false })
    expect(await refused(open({ host: H.host, cookie: H.cookie }))).toMatch(/403/)
    // Security audit 2026-10-16: and the launch link's cookie.
    expect(await refused(open({ host: H.host, origin: H.origin }))).toMatch(/401/)
    const c = await open({ ...H })
    c.send({ type: 'hello', csrf: t.app.ctx.localCsrfToken })
    expect(await c.next('ready')).toEqual({ type: 'ready' })
  })
})

describe('the /ws channel: limits (phase 1h spec §4)', () => {
  it('closes on an unknown channel, on non-JSON, on an oversize message and on a flood', async () => {
    const { as, subscribed, user } = await setup()
    const u = user('editor')
    const unknown = await subscribed(u)
    unknown.send({ ch: 'shell', type: 'sub' })
    expect(await unknown.closed).toBe(4400)
    const garbage = await subscribed(u)
    garbage.ws.send('{not json')
    expect(await garbage.closed).toBe(4400)
    const big = await subscribed(u)
    big.ws.send(JSON.stringify({ ch: 'jobs', type: 'sub', pad: 'x'.repeat(17 * 1024) }))
    expect(await big.closed).toBe(4413)
    const flood = await subscribed(u)
    for (let i = 0; i < 25; i++) flood.send({ ch: 'jobs', type: 'unsub' })
    expect(await flood.closed).toBe(4408)
    // Before hello, anything but hello is refused: 4403, the session itself may still be fine.
    const early = await as(u)
    early.send({ ch: 'jobs', type: 'sub' })
    expect(await early.closed).toBe(4403)
  })

  it('sends one snapshot per subscription, however often sub is repeated, with the server time (Minors 7, 9)', async () => {
    const { t, subscribed, user } = await setup()
    const u = user('editor')
    const c = await subscribed(u)
    const first = await c.next('snapshot', 'jobs')
    expect(first.payload).toMatchObject({ jobs: [], now: t.clock.now })
    for (let i = 0; i < 5; i++) c.send({ ch: 'jobs', type: 'sub' })
    await new Promise((r) => setTimeout(r, 100))
    expect(c.messages.filter((m) => m.type === 'snapshot')).toEqual([])
  })

  it('allows 8 sockets per session and refuses the 9th', async () => {
    const { as, user } = await setup()
    const u = user('editor')
    const open = []
    for (let i = 0; i < 8; i++) open.push(await as(u))
    expect(await (await as(u)).closed).toBe(4429)
  })

  it('closes a socket that stops answering pings', async () => {
    const { open, user } = await setup()
    const u = user('editor')
    const c = await open({ ...H, cookie: `mm_sid=${u.sessionId}` }, { noPong: true })
    c.send({ type: 'hello', csrf: u.csrf })
    await c.next('ready')
    expect(await c.closed).toBe(4408)
  })
})

describe('the /ws channel: jobs (phase 1h spec §4, Review Focus 3)', () => {
  it('sends a snapshot of visible jobs, then updates, and never another user’s hidden job', async () => {
    const { subscribed, user, start } = await setup()
    const kind = hangingKind()
    const owner = user('editor')
    const hidden = user('viewer', 'none')
    const early = start(kind, owner.id)
    const mine = await subscribed(owner)
    const theirs = await subscribed(hidden)
    const snapshot = await mine.next('snapshot', 'jobs')
    expect(snapshot.payload.jobs.map((j: JobView) => j.id)).toEqual([early.id])
    expect((await theirs.next('snapshot', 'jobs')).payload.jobs).toEqual([])
    const later = start(kind, owner.id)
    expect((await mine.next('update', 'jobs')).payload.job).toMatchObject({
      id: later.id,
      state: 'running',
      mine: true,
    })
    kind.finish()
    const finals = [await mine.next('update', 'jobs'), await mine.next('update', 'jobs')]
    expect(finals.map((m) => m.payload.job.state)).toEqual(['done', 'done'])
    expect(theirs.messages).toEqual([])
  })

  it('sends gone to the job’s own owner when their grant becomes none (final review I1)', async () => {
    const { ctx, subscribed, user, start, connectionId } = await setup()
    const kind = hangingKind()
    const owner = user('editor')
    const job = start(kind, owner.id)
    const c = await subscribed(owner)
    expect((await c.next('snapshot', 'jobs')).payload.jobs.map((j: JobView) => j.id)).toEqual([job.id])
    ctx.grants.set(connectionId, owner.id, 'none')
    await new Promise((r) => setTimeout(r, 600))
    kind.progress(50)
    expect(await c.next('gone', 'jobs')).toMatchObject({ payload: { id: job.id } })
    kind.finish()
    await new Promise((r) => setTimeout(r, 50))
    expect(c.messages).toEqual([])
  })

  it('sends gone and stops updates when the reader loses access mid-job', async () => {
    const { ctx, subscribed, user, start, connectionId } = await setup()
    const kind = hangingKind()
    const owner = user('editor')
    const reader = user('viewer')
    const job = start(kind, owner.id)
    const c = await subscribed(reader)
    expect((await c.next('snapshot', 'jobs')).payload.jobs.map((j: JobView) => j.id)).toEqual([job.id])
    ctx.grants.set(connectionId, reader.id, 'none')
    await new Promise((r) => setTimeout(r, 600))
    kind.progress(50)
    expect(await c.next('gone', 'jobs')).toMatchObject({ payload: { id: job.id } })
    kind.finish()
    await new Promise((r) => setTimeout(r, 50))
    expect(c.messages).toEqual([])
  })

  it('closes the sockets of a session that signs out, and of a user who is disabled', async () => {
    const { t, subscribed, user } = await setup()
    const a = user('editor')
    const b = user('editor')
    const first = await subscribed(a)
    const second = await subscribed(b)
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...H, 'x-csrf-token': a.csrf },
      cookies: { mm_sid: a.sessionId },
    })
    expect(await first.closed).toBe(4401)
    t.app.ctx.users.setDisabled(b.id, true)
    t.app.ctx.sessions.revokeAllForUser(b.id)
    expect(await second.closed).toBe(4401)
  })

  it('closes a socket whose session expired, at the next heartbeat', async () => {
    const { t, subscribed, user } = await setup()
    const u = user('editor')
    const c = await subscribed(u)
    t.clock.now += 365 * 24 * 3600_000
    expect(await c.closed).toBe(4401)
  })

  it('closes an administrator’s open socket when 2FA becomes required for them (4c review I1)', async () => {
    const { t, subscribed, user } = await setup()
    const ctx = t.app.ctx
    const secured = user('admin')
    ctx.users.setTotp(secured.id, 'sealed', true)
    const bare = user('admin')
    const editor = user('editor')
    const bareSocket = await subscribed(bare)
    const editorSocket = await subscribed(editor)
    // Turned on while the bare administrator has the app open.
    const on = await t.app.inject({
      method: 'PUT',
      url: '/api/users/policy',
      headers: { ...H, 'x-csrf-token': secured.csrf },
      cookies: { mm_sid: secured.sessionId },
      payload: { adminTwoFactor: true },
    })
    expect(on.statusCode).toBe(200)
    expect(await bareSocket.closed).toBe(4401)
    // An editor is not concerned — until made an administrator.
    editorSocket.send({ ch: 'jobs', type: 'sub' })
    await editorSocket.next('snapshot', 'jobs')
    // Security audit 2026-10-16: a promotion is confirmed with the password and a fresh second factor.
    await givePassword(ctx, secured.id)
    ctx.stepUps.mark(hashSessionId(secured.sessionId))
    const promoted = await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${editor.id}`,
      headers: { ...H, 'x-csrf-token': secured.csrf },
      cookies: { mm_sid: secured.sessionId },
      payload: { role: 'admin', currentPassword: ADMIN_PASSWORD },
    })
    expect(promoted.statusCode).toBe(200)
    expect(await editorSocket.closed).toBe(4401)
  })

  it('closes the socket of a user 2FA becomes required of, alone or with everyone (required 2FA)', async () => {
    // No heartbeat within the test: the change itself must close the sockets, at once.
    const { t, subscribed, user } = await setup({}, { pingMs: 600_000 })
    const soon = (closed: Promise<number>) =>
      Promise.race([closed, new Promise<string>((r) => setTimeout(() => r('still open'), 2000))])
    const ctx = t.app.ctx
    const secured = user('admin')
    ctx.users.setTotp(secured.id, 'sealed', true)
    const flagged = user('viewer')
    const other = user('editor')
    const flaggedSocket = await subscribed(flagged)
    const otherSocket = await subscribed(other)
    const call = (method: 'PATCH' | 'PUT', url: string, payload: object) =>
      t.app.inject({
        method,
        url,
        headers: { ...H, 'x-csrf-token': secured.csrf },
        cookies: { mm_sid: secured.sessionId },
        payload,
      })
    expect((await call('PATCH', `/api/users/${flagged.id}`, { requireTwoFactor: true })).statusCode).toBe(200)
    expect(await soon(flaggedSocket.closed)).toBe(4401)
    // The other user is not concerned — until everyone must.
    otherSocket.send({ ch: 'jobs', type: 'sub' })
    await otherSocket.next('snapshot', 'jobs')
    expect((await call('PUT', '/api/users/policy', { everyoneTwoFactor: true })).statusCode).toBe(200)
    expect(await soon(otherSocket.closed)).toBe(4401)
  })
})

describe('the /ws channel: session lifetime (2026-10-29)', () => {
  it('closes at once the socket of a session a shorter idle time ends', async () => {
    // No heartbeat within the test: the change itself must close the socket.
    const { t, subscribed, user } = await setup({}, { pingMs: 600_000 })
    const soon = (closed: Promise<number>) =>
      Promise.race([closed, new Promise<string>((r) => setTimeout(() => r('still open'), 2000))])
    const admin = user('admin')
    const idle = user('viewer')
    const idleSocket = await subscribed(idle)
    t.clock.now += 20 * 60_000
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/users/session-policy',
      headers: { ...H, 'x-csrf-token': admin.csrf },
      cookies: { mm_sid: admin.sessionId },
      payload: { idleMinutes: 15 },
    })
    expect(res.statusCode).toBe(200)
    expect(await soon(idleSocket.closed)).toBe(4401)
  })
})

describe('the /ws channel: security audit 2026-10-16', () => {
  it('audits a hello with a wrong token, a few a minute from one address', async () => {
    const { t, ctx, as, user } = await setup()
    const u = user('editor')
    const hellos = () =>
      ctx.audit.list({ action: 'realtime.hello' }) as Array<{ outcome: string; details: unknown }>
    for (let i = 0; i < 8; i++) {
      const c = await as(u)
      c.send({ type: 'hello', csrf: 'x'.repeat(43) })
      expect(await c.closed).toBe(4403)
    }
    // Five entries, then the address is held back: the log cannot be flooded.
    expect(hellos()).toHaveLength(5)
    expect(hellos()[0]).toMatchObject({ outcome: 'denied', details: { reason: 'csrf' } })
    t.clock.now += 61_000
    const late = await as(u)
    late.send({ type: 'hello', csrf: 'y'.repeat(43) })
    expect(await late.closed).toBe(4403)
    // The next entry says how many were left out.
    expect(hellos()).toHaveLength(6)
    expect(hellos()[0]).toMatchObject({ details: { reason: 'csrf', suppressed: 3 } })
    // A right hello is never audited.
    const right = await as(u)
    right.send({ type: 'hello', csrf: u.csrf })
    await right.next('ready')
    expect(hellos()).toHaveLength(6)
  })

  it('drops a socket whose session is gone before it cancels or closes a shell', async () => {
    // No heartbeat in the test's time: the message itself must find the session gone.
    const { ctx, as, user } = await setup({}, { pingMs: 60_000 })
    const u = user('editor')
    const touched: string[] = []
    ;(ctx.shell as unknown as { cancel: unknown }).cancel = () => touched.push('cancel')
    ;(ctx.shell as unknown as { close: unknown }).close = async () => {
      touched.push('close')
    }
    for (const type of ['cancel', 'close'] as const) {
      const c = await as(u)
      c.send({ type: 'hello', csrf: u.csrf })
      await c.next('ready')
      // Gone without a word to the socket (an expiry, a cascade).
      ctx.store.db.prepare('UPDATE sessions SET last_seen_at = 0 WHERE user_id = ?').run(u.id)
      c.send({ ch: 'shell', type, sessionId: 's1' })
      expect(await c.closed).toBe(4401)
      ctx.store.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?').run(ctx.now(), u.id)
    }
    expect(touched).toEqual([])
  })
})
