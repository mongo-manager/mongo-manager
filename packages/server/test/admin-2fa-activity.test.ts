import { afterEach, describe, expect, it } from 'vitest'
import type { AuditAction } from '@mongo-manager/shared'
import { randomUUID } from 'node:crypto'
import { H, makeApp, type TestApp } from './helpers'
import { hashPassword } from '../src/auth/passwords'
import { hashSessionId } from '../src/auth/sessions'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

async function team(overrides: Record<string, unknown> = {}) {
  const t = await makeApp({ auth: true, ...overrides })
  apps.push(t)
  const { ctx } = t.app
  const as = (role: 'admin' | 'editor' | 'viewer', factors: { totp?: boolean; passkey?: boolean } = {}) => {
    const user = ctx.users.create({
      username: `u-${role}-${randomUUID().slice(0, 6)}`,
      passwordHash: 'x',
      role,
    })
    if (factors.totp) ctx.users.setTotp(user.id, 'sealed', true)
    if (factors.passkey)
      ctx.store.db
        .prepare(
          `INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, created_at)
           VALUES (?, ?, 'key', x'00', 0, '[]', 0)`,
        )
        .run(randomUUID(), user.id)
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const call = (method: Method, url: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/${url}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload ? { payload } : {}),
      })
    return { id: user.id, username: user.username, call, cookies: { mm_sid: sessionId } }
  }
  return { t, ctx, as }
}

describe('mandatory 2FA for administrators (phase 4c §4)', () => {
  it('is off by default, and only an administrator who has 2FA may turn it on', async () => {
    const { as, ctx } = await team()
    const bare = as('admin')
    const secured = as('admin', { totp: true })
    expect((await bare.call('GET', 'users/policy')).json()).toEqual({
      adminTwoFactor: false,
      forced: false,
      everyoneTwoFactor: false,
      everyoneForced: false,
    })
    const refused = await bare.call('PUT', 'users/policy', { adminTwoFactor: true })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ details: { reason: 'two_factor_needed_first' } })
    const done = await secured.call('PUT', 'users/policy', { adminTwoFactor: true })
    expect(done.json()).toEqual({
      adminTwoFactor: true,
      forced: false,
      everyoneTwoFactor: false,
      everyoneForced: false,
    })
    expect(ctx.audit.list({ action: 'users.policy' })[0]).toMatchObject({ details: { adminTwoFactor: true } })
  })

  it('keeps an administrator without 2FA to setting it up, and no one else', async () => {
    const { as, t } = await team()
    const secured = as('admin', { passkey: true })
    await secured.call('PUT', 'users/policy', { adminTwoFactor: true })
    const bare = as('admin')
    // The real-time socket: refused before it upgrades.
    const socket = await t.app.inject({
      method: 'GET',
      url: '/ws',
      headers: {
        ...H,
        connection: 'upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
      cookies: bare.cookies,
    })
    expect([socket.statusCode, socket.json().details?.reason]).toEqual([403, 'two_factor_setup_required'])
    for (const url of ['connections', 'users', 'ai/history']) {
      const res = await bare.call('GET', url)
      expect([res.statusCode, res.json().details?.reason]).toEqual([403, 'two_factor_setup_required'])
    }
    // Encoding the path changes nothing: the router decodes it to the same route.
    const encoded = await t.app.inject({
      method: 'GET',
      url: '/%61pi/connections',
      headers: H,
      cookies: bare.cookies,
    })
    // Either the gate refuses it, or it reaches no route at all: never the data.
    expect([403, 404]).toContain(encoded.statusCode)
    // Their own account and setting 2FA up stay open.
    const me = (await bare.call('GET', 'auth/me')).json()
    expect(me).toMatchObject({ twoFactorRequired: true })
    expect(
      (await bare.call('POST', 'auth/totp/enroll', { password: 'wrong' })).json().details?.reason,
    ).not.toBe('two_factor_setup_required')
    // Not administrators, nor an administrator who has 2FA.
    expect((await as('editor').call('GET', 'connections')).statusCode).toBe(200)
    expect((await secured.call('GET', 'connections')).statusCode).toBe(200)
    expect((await secured.call('GET', 'auth/me')).json()).toMatchObject({ twoFactorRequired: false })
  })

  it('asks the password of who turns the requirement off (4c review I4)', async () => {
    const { ctx, t } = await team()
    const admin = ctx.users.create({
      username: 'boss',
      passwordHash: await hashPassword('the right password'),
      role: 'admin',
    })
    ctx.users.setTotp(admin.id, 'sealed', true)
    const { sessionId, session } = ctx.sessions.create(admin.id, {})
    // Security audit 2026-10-16: turning it off takes a second factor proved lately as well (this
    // session signed in with it); admin-reauth.test.ts covers a session that did not.
    ctx.stepUps.mark(session.idHash)
    const put = (payload: object) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/users/policy',
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        payload,
      })
    expect((await put({ adminTwoFactor: true })).statusCode).toBe(200)
    for (const body of [{ adminTwoFactor: false }, { adminTwoFactor: false, password: 'nope' }]) {
      const res = await put(body)
      expect([res.statusCode, res.json().details?.reason]).toEqual([400, 'wrong_password'])
    }
    expect((await put({ adminTwoFactor: false, password: 'the right password' })).json()).toEqual({
      adminTwoFactor: false,
      forced: false,
      everyoneTwoFactor: false,
      everyoneForced: false,
    })
  })

  it('never lets a required administrator remove their last 2FA method', async () => {
    const { as, ctx } = await team()
    const totp = as('admin', { totp: true })
    await totp.call('PUT', 'users/policy', { adminTwoFactor: true })
    const off = await totp.call('POST', 'auth/totp/disable', { password: 'x', code: '000000' })
    expect([off.statusCode, off.json().details?.reason]).toEqual([409, 'last_factor_required'])
    const keyed = as('admin', { passkey: true })
    const id = (
      ctx.store.db.prepare('SELECT id FROM passkeys WHERE user_id = ?').get(keyed.id) as { id: string }
    ).id
    const gone = await keyed.call('DELETE', `auth/passkeys/${id}`, { password: 'x' })
    expect([gone.statusCode, gone.json().details?.reason]).toEqual([409, 'last_factor_required'])
  })

  it('keeps one method when two removals race (4c review M1)', async () => {
    const { ctx, t } = await team({ requireAdmin2fa: true })
    const admin = ctx.users.create({
      username: 'boss',
      passwordHash: await hashPassword('the right password'),
      role: 'admin',
    })
    const ids = [randomUUID(), randomUUID()]
    for (const id of ids)
      ctx.store.db
        .prepare(
          `INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, created_at)
           VALUES (?, ?, 'key', x'00', 0, '[]', 0)`,
        )
        .run(id, admin.id)
    const { sessionId, session } = ctx.sessions.create(admin.id, {})
    // Signed in with a second factor just now (security review L2).
    ctx.stepUps.mark(hashSessionId(sessionId))
    const remove = (id: string) =>
      t.app.inject({
        method: 'DELETE',
        url: `/api/auth/passkeys/${id}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        payload: { password: 'the right password' },
      })
    const results = await Promise.all(ids.map(remove))
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 409])
    expect(ctx.passkeys.countForUser(admin.id)).toBe(1)
  })

  it('may be forced by configuration, then shown and kept on', async () => {
    const { as } = await team({ requireAdmin2fa: true })
    const secured = as('admin', { totp: true })
    expect((await secured.call('GET', 'users/policy')).json()).toEqual({
      adminTwoFactor: true,
      forced: true,
      everyoneTwoFactor: false,
      everyoneForced: false,
    })
    expect((await secured.call('PUT', 'users/policy', { adminTwoFactor: false })).statusCode).toBe(409)
    const bare = as('admin')
    expect((await bare.call('GET', 'connections')).statusCode).toBe(403)
  })

  it('is an administrator’s to read and change, in team mode only', async () => {
    const { as } = await team()
    expect((await as('editor').call('GET', 'users/policy')).statusCode).toBe(403)
    expect(
      (await as('editor', { totp: true }).call('PUT', 'users/policy', { adminTwoFactor: true })).statusCode,
    ).toBe(403)
    const local = await makeApp()
    apps.push(local)
    const res = await local.app.inject({
      method: 'GET',
      url: '/api/users/policy',
      headers: { ...H, 'x-csrf-token': local.app.ctx.localCsrfToken },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('user activity (phase 4c §3)', () => {
  it('sums each user’s sign-ins, failures, actions and last activity over the days asked', async () => {
    const { t, as, ctx } = await team()
    const DAY = 86_400_000
    // Signed in on the day asked (a session from months before would have expired).
    t.clock.now = Date.UTC(2026, 5, 30)
    const admin = as('admin')
    const ada = as('editor')
    const idle = as('viewer')
    const add = (
      userId: string,
      username: string,
      action: AuditAction,
      outcome: 'success' | 'failure' | 'denied',
      at: number,
    ) => {
      t.clock.now = at
      ctx.audit.append({ userId, username, action, outcome })
    }
    const now = Date.UTC(2026, 5, 30)
    add(ada.id, ada.username, 'auth.login', 'success', now - 40 * DAY)
    add(ada.id, ada.username, 'auth.login', 'success', now - 5 * DAY)
    add(ada.id, ada.username, 'auth.login.totp', 'failure', now - 4 * DAY)
    add(ada.id, ada.username, 'documents.update', 'success', now - 3 * DAY)
    add(ada.id, ada.username, 'documents.delete', 'denied', now - 2 * DAY)
    add(ada.id, ada.username, 'export.start' as AuditAction, 'success', now - DAY)
    t.clock.now = now
    const res = await admin.call('GET', 'users/activity?days=30')
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<Record<string, unknown>>
    const of = (id: string) => rows.find((r) => r.userId === id)!
    expect(of(ada.id)).toMatchObject({
      username: ada.username,
      role: 'editor',
      lastSignInAt: now - 5 * DAY,
      signIns: 1,
      failedSignIns: 1,
      actions: 3,
      denied: 1,
      lastActivityAt: now - DAY,
      groups: [
        { group: 'documents', count: 2 },
        { group: 'export', count: 1 },
      ],
    })
    // A user who did nothing is there too.
    expect(of(idle.id)).toMatchObject({ signIns: 0, actions: 0, lastActivityAt: null, lastSignInAt: null })
  })

  it('counts real sign-ins: a wrong password is a failure of that account, a 2FA sign-in counts once (4c review I3)', async () => {
    const { t, as, ctx } = await team()
    const admin = as('admin')
    const password = 'correct horse battery staple'
    const plain = ctx.users.create({
      username: 'plain',
      passwordHash: await hashPassword(password),
      role: 'editor',
    })
    const secured = ctx.users.create({
      username: 'secured',
      passwordHash: await hashPassword(password),
      role: 'editor',
    })
    ctx.users.setTotp(secured.id, 'sealed', true)
    const login = (username: string, pw: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { username, password: pw },
      })
    // A wrong password, then the right one.
    expect((await login('plain', 'wrong password here')).statusCode).toBe(401)
    expect((await login('plain', password)).statusCode).toBe(200)
    // The password step of a 2FA account, then a wrong code: no sign-in, one failure.
    const step = await login('secured', password)
    expect(step.json()).toMatchObject({ mfaRequired: true })
    const code = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: H,
      payload: { ticket: step.json().ticket, code: '000000' },
    })
    expect(code.statusCode).not.toBe(200)
    const rows = (await admin.call('GET', 'users/activity?days=7')).json() as Array<Record<string, unknown>>
    const of = (id: string) => rows.find((r) => r.userId === id)!
    expect(of(plain.id)).toMatchObject({ signIns: 1, failedSignIns: 1 })
    expect(of(secured.id)).toMatchObject({ signIns: 0, failedSignIns: 1, lastSignInAt: null })
  })

  it('refuses a period it does not offer, anyone but who manages users, and local mode', async () => {
    const { as } = await team()
    expect((await as('admin').call('GET', 'users/activity?days=5')).statusCode).toBe(400)
    expect((await as('editor').call('GET', 'users/activity?days=30')).statusCode).toBe(403)
    const local = await makeApp()
    apps.push(local)
    const res = await local.app.inject({
      method: 'GET',
      url: '/api/users/activity?days=30',
      headers: { ...H, 'x-csrf-token': local.app.ctx.localCsrfToken },
    })
    expect(res.statusCode).toBe(409)
  })

  it('counts a passkey as 2FA in the users list', async () => {
    const { as } = await team()
    const admin = as('admin')
    const keyed = as('editor', { passkey: true })
    const users = (await admin.call('GET', 'users')).json() as Array<{ id: string; twoFactor: boolean }>
    expect(users.find((u) => u.id === keyed.id)!.twoFactor).toBe(true)
    expect(users.find((u) => u.id === admin.id)!.twoFactor).toBe(false)
  })
})
