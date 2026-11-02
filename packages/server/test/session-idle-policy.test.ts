import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { totpCode } from '../src/auth/totp'
import { SESSION_ABSOLUTE_MS, SessionRepo } from '../src/auth/sessions'
import { sessionIdleMs } from '../src/auth/sessionPolicy'
import { SettingsRepo } from '../src/store/settings'

/**
 * Session lifetime (2026-10-29): an administrator chooses how long a team-mode session lasts
 * without a request (15 minutes to 8 hours, 30 by default); every session still ends 12 hours after
 * its sign-in. A longer time weakens the sign-in, so it asks for the administrator's password and a
 * second factor used lately, as turning a 2FA rule off does; a shorter one asks nothing.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const PASSWORD = 'tarçın-kavanoz-42-mavi'
const OTHER = 'baska-parola-2026-yesil'
const MIN = 60_000
const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'mm_sid')?.value

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
function caller(t: TestApp, res: LightMyRequestResponse) {
  const session = { cookies: { mm_sid: sid(res)! }, csrf: res.json().csrfToken as string }
  return (method: Method, url: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { ...H, 'x-csrf-token': session.csrf },
      cookies: session.cookies,
      ...(payload ? { payload } : {}),
    })
}

async function team() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const token = t.app.ctx.setup.ensureToken()
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: H,
    payload: { token, username: 'admin', password: PASSWORD },
  })
  const call = caller(t, res)
  await call('POST', '/api/users', {
    username: 'bob',
    password: OTHER,
    role: 'viewer',
    currentPassword: PASSWORD,
  })
  const signIn = async (username: string, password: string) =>
    caller(
      t,
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { username, password },
      }),
    )
  return { t, call, signIn }
}

describe('the session repository’s idle time', () => {
  it('is the one set, for a request, a socket’s look and the pruning, with the 12 hours kept', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const user = ctx.users.create({ username: 'carol', passwordHash: 'h', role: 'viewer' })
    const sessions = new SessionRepo(ctx.store.db, () => t.clock.now, 60 * MIN)
    const a = sessions.create(user.id, {})
    t.clock.now += 45 * MIN
    // A socket's look first: it counts no activity, and must use the time set, not the default.
    expect(sessions.peekHash(a.session.idHash)).toBeDefined()
    expect(sessions.pruneExpired()).toBe(0)
    expect(sessions.get(a.sessionId)).toBeDefined()
    t.clock.now += 61 * MIN
    expect(sessions.peekHash(a.session.idHash)).toBeUndefined()
    expect(sessions.pruneExpired()).toBe(1)

    sessions.setIdleMs(15 * MIN)
    const b = sessions.create(user.id, {})
    t.clock.now += 16 * MIN
    expect(sessions.get(b.sessionId)).toBeUndefined()

    sessions.setIdleMs(480 * MIN)
    const c = sessions.create(user.id, {})
    for (let at = 0; at < SESSION_ABSOLUTE_MS; at += 240 * MIN) {
      t.clock.now += 240 * MIN
      expect(sessions.get(c.sessionId)).toBeDefined()
    }
    t.clock.now += 1
    expect(sessions.get(c.sessionId)).toBeUndefined()
  })

  it('is read from the stored setting: 30 minutes when none, the shortest when it no longer reads', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { db } = t.app.ctx.store
    const settings = new SettingsRepo(db, () => t.clock.now)
    expect(sessionIdleMs(db, () => t.clock.now)).toBe(30 * MIN)
    settings.set('auth.sessionIdle', { minutes: 240 })
    expect(sessionIdleMs(db, () => t.clock.now)).toBe(240 * MIN)
    settings.set('auth.sessionIdle', { minutes: 100_000 })
    expect(sessionIdleMs(db, () => t.clock.now)).toBe(15 * MIN)
  })
})

describe('the stored idle time, at start', () => {
  it('holds for the sessions of a server started afterwards', async () => {
    const t = await makeApp({ auth: true }, {}, (db) =>
      new SettingsRepo(db, () => 0).set('auth.sessionIdle', { minutes: 240 }),
    )
    apps.push(t)
    const { ctx } = t.app
    const user = ctx.users.create({ username: 'dave', passwordHash: 'h', role: 'viewer' })
    const { sessionId } = ctx.sessions.create(user.id, {})
    t.clock.now += 200 * MIN
    expect(ctx.sessions.get(sessionId)).toBeDefined()
  })
})

describe('the session policy route', () => {
  it('is 30 minutes and 12 hours at first, for administrators only', async () => {
    const s = await team()
    expect((await s.call('GET', '/api/users/session-policy')).json()).toEqual({
      idleMinutes: 30,
      absoluteMinutes: 720,
    })
    const bob = await s.signIn('bob', OTHER)
    expect((await bob('GET', '/api/users/session-policy')).statusCode).toBe(403)
    expect((await bob('PUT', '/api/users/session-policy', { idleMinutes: 480 })).statusCode).toBe(403)
  })

  it('takes a shorter time without a password, and ends at once a session idle longer than it', async () => {
    const s = await team()
    const bob = await s.signIn('bob', OTHER)
    expect((await bob('GET', '/api/auth/me')).statusCode).toBe(200)
    s.t.clock.now += 20 * MIN
    const res = await s.call('PUT', '/api/users/session-policy', { idleMinutes: 15 })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ idleMinutes: 15, absoluteMinutes: 720 })
    expect((await bob('GET', '/api/auth/me')).statusCode).toBe(401)
    expect(s.t.app.ctx.audit.list({ action: 'users.sessionPolicy' })[0]).toMatchObject({
      outcome: 'success',
      details: { idleMinutes: 15, from: 30 },
    })
  })

  it('never brings back a session a shorter time ended, when made longer again', async () => {
    const s = await team()
    const bob = await s.signIn('bob', OTHER)
    expect((await bob('GET', '/api/auth/me')).statusCode).toBe(200)
    s.t.clock.now += 20 * MIN
    expect((await s.call('PUT', '/api/users/session-policy', { idleMinutes: 15 })).statusCode).toBe(200)
    const longer = await s.call('PUT', '/api/users/session-policy', { idleMinutes: 480, password: PASSWORD })
    expect(longer.statusCode).toBe(200)
    expect((await bob('GET', '/api/auth/me')).statusCode).toBe(401)
  })

  it('never brings back a session the time in force had ended, when made longer', async () => {
    const s = await team()
    const bob = await s.signIn('bob', OTHER)
    expect((await bob('GET', '/api/auth/me')).statusCode).toBe(200)
    // Bob idle 40 minutes (past the 30), the administrator active meanwhile.
    for (let i = 0; i < 4; i++) {
      s.t.clock.now += 10 * MIN
      await s.call('GET', '/api/users/session-policy')
    }
    const longer = await s.call('PUT', '/api/users/session-policy', { idleMinutes: 240, password: PASSWORD })
    expect(longer.statusCode).toBe(200)
    expect((await bob('GET', '/api/auth/me')).statusCode).toBe(401)
  })

  it('records a refused change too, with the times and never the password', async () => {
    const s = await team()
    await s.call('PUT', '/api/users/session-policy', { idleMinutes: 480, password: OTHER })
    expect(s.t.app.ctx.audit.list({ action: 'users.sessionPolicy' })[0]).toMatchObject({
      outcome: 'failure',
      details: { idleMinutes: 480, from: 30 },
    })
    expect(JSON.stringify(s.t.app.ctx.audit.list({ action: 'users.sessionPolicy' }))).not.toContain(OTHER)
  })

  it('asks the password for a longer time, and keeps sessions idle that long', async () => {
    const s = await team()
    const none = await s.call('PUT', '/api/users/session-policy', { idleMinutes: 240 })
    expect(none.statusCode).toBe(400)
    expect(none.json().details).toMatchObject({ reason: 'wrong_password' })
    const wrong = await s.call('PUT', '/api/users/session-policy', { idleMinutes: 240, password: OTHER })
    expect(wrong.statusCode).toBe(400)
    expect((await s.call('GET', '/api/users/session-policy')).json()).toMatchObject({ idleMinutes: 30 })

    const done = await s.call('PUT', '/api/users/session-policy', { idleMinutes: 240, password: PASSWORD })
    expect(done.statusCode).toBe(200)
    const bob = await s.signIn('bob', OTHER)
    s.t.clock.now += 200 * MIN
    expect((await bob('GET', '/api/auth/me')).statusCode).toBe(200)
    s.t.clock.now += 241 * MIN
    expect((await bob('GET', '/api/auth/me')).statusCode).toBe(401)
    // The password is never written to the audit log.
    expect(JSON.stringify(s.t.app.ctx.audit.list({ action: 'users.sessionPolicy' }))).not.toContain(PASSWORD)
  })

  it('asks a second factor used lately first, when the administrator has one', async () => {
    const s = await team()
    const { secret } = (await s.call('POST', '/api/auth/totp/enroll', { password: PASSWORD })).json()
    await s.call('POST', '/api/auth/totp/confirm', { code: totpCode(secret, s.t.clock.now) })
    s.t.clock.now += 11 * MIN
    // Asked before the password is checked, so the route is no way to test passwords.
    const wrong = await s.call('PUT', '/api/users/session-policy', { idleMinutes: 480, password: OTHER })
    expect(wrong.statusCode).toBe(403)
    expect(wrong.json().details).toMatchObject({ reason: 'step_up_required' })
    await s.call('POST', '/api/auth/step-up', { code: totpCode(secret, s.t.clock.now) })
    const done = await s.call('PUT', '/api/users/session-policy', { idleMinutes: 480, password: PASSWORD })
    expect(done.statusCode).toBe(200)
    // Shorter again: nothing asked.
    s.t.clock.now += 11 * MIN
    expect((await s.call('PUT', '/api/users/session-policy', { idleMinutes: 60 })).statusCode).toBe(200)
  })

  it('takes only the listed times, and nothing else in the body', async () => {
    const s = await team()
    for (const body of [
      { idleMinutes: 45 },
      { idleMinutes: '30' },
      { idleMinutes: 0 },
      { idleMinutes: 30, absoluteMinutes: 10_000 },
      {},
    ]) {
      const res = await s.call('PUT', '/api/users/session-policy', body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }
    expect((await s.call('GET', '/api/users/session-policy')).json()).toMatchObject({ idleMinutes: 30 })
  })

  it('is for team mode only', async () => {
    const t = await makeApp()
    apps.push(t)
    const res = await t.app.inject({ method: 'GET', url: '/api/users/session-policy', headers: H })
    expect(res.statusCode).toBe(409)
  })
})
