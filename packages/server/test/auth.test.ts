import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { totpCode } from '../src/auth/totp'
import { hashPassword } from '../src/auth/passwords'
import { completeSecondFactor } from '../src/routes/auth'

const apps: TestApp[] = []
async function make(...args: Parameters<typeof makeApp>) {
  const t = await makeApp(...args)
  apps.push(t)
  return t
}
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const PASSWORD = 'tarçın-kavanoz-42-mavi'
const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'mm_sid')?.value

interface Session {
  cookies: Record<string, string>
  csrf: string
}

async function setup(t: TestApp, username = 'admin'): Promise<Session> {
  const token = t.app.ctx.setup.ensureToken()
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: H,
    payload: { token, username, password: PASSWORD },
  })
  expect(res.statusCode).toBe(200)
  return { cookies: { mm_sid: sid(res)! }, csrf: res.json().csrfToken }
}

function login(t: TestApp, username: string, password = PASSWORD) {
  return t.app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { username, password } })
}

function post(t: TestApp, url: string, payload: object) {
  return t.app.inject({ method: 'POST', url, headers: H, payload })
}

function call(t: TestApp, s: Session, method: 'GET' | 'POST', url: string, payload?: object) {
  return t.app.inject({
    method,
    url,
    headers: { ...H, 'x-csrf-token': s.csrf },
    cookies: s.cookies,
    ...(payload ? { payload } : {}),
  })
}

async function enableTotp(t: TestApp, s: Session): Promise<{ secret: string; recoveryCodes: string[] }> {
  const { secret } = (await call(t, s, 'POST', '/api/auth/totp/enroll', { password: PASSWORD })).json()
  const confirm = await call(t, s, 'POST', '/api/auth/totp/confirm', { code: totpCode(secret, t.clock.now) })
  expect(confirm.statusCode).toBe(200)
  return { secret, recoveryCodes: confirm.json().recoveryCodes }
}

describe('status and setup wizard', () => {
  it('reports local mode without setup', async () => {
    const t = await make()
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: H })).json()).toEqual({
      mode: 'local',
      setupRequired: false,
      authenticated: true,
    })
    expect((await login(t, 'x')).statusCode).toBe(409)
  })

  it('protects the setup token (Review Focus 5)', async () => {
    const t = await make({ auth: true })
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: H })).json()).toMatchObject(
      {
        mode: 'team',
        setupRequired: true,
        authenticated: false,
      },
    )
    const token = t.app.ctx.setup.ensureToken()
    expect(
      (await post(t, '/api/auth/setup', { token: 'nope', username: 'admin', password: PASSWORD })).statusCode,
    ).toBe(401)
    expect(
      (await post(t, '/api/auth/setup', { token, username: 'admin', password: 'short' })).statusCode,
    ).toBe(400)
    const s = await setup(t)
    expect((await call(t, s, 'GET', '/api/auth/me')).json()).toMatchObject({
      mode: 'team',
      user: { username: 'admin', role: 'admin' },
      twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
    })
    expect(t.app.ctx.setup.active).toBe(false)
    expect(
      (await post(t, '/api/auth/setup', { token, username: 'second', password: PASSWORD })).statusCode,
    ).toBe(409)
  })

  it('creates exactly one admin under concurrent setup requests (Review Focus 2)', async () => {
    const t = await make({ auth: true })
    const token = t.app.ctx.setup.ensureToken()
    const results = await Promise.all(
      ['admin1', 'admin2', 'admin3'].map((username) =>
        post(t, '/api/auth/setup', { token, username, password: PASSWORD }),
      ),
    )
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1)
    expect(t.app.ctx.users.count()).toBe(1)
  })
})

describe('password login', () => {
  it('logs in case-insensitively and rotates the session id (Review Focus 3)', async () => {
    const t = await make({ auth: true })
    const first = await setup(t, 'Alice')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      cookies: first.cookies,
      payload: { username: 'alice', password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ user: { username: 'Alice' }, csrfToken: expect.any(String) })
    expect(res.json().user.passwordHash).toBeUndefined()
    expect(sid(res)).not.toBe(first.cookies.mm_sid)
    expect(t.app.ctx.sessions.get(first.cookies.mm_sid!)).toBeUndefined()
  })

  it('uses one generic message for unknown users and wrong passwords', async () => {
    const t = await make({ auth: true })
    await setup(t)
    const unknown = await login(t, 'ghost')
    const wrong = await login(t, 'admin', 'wrong-password-123')
    expect(unknown.statusCode).toBe(401)
    expect(wrong.statusCode).toBe(401)
    expect(unknown.json().message).toBe(wrong.json().message)
  })

  it('locks out after 5 failures per username (S3)', async () => {
    const t = await make({ auth: true })
    await setup(t)
    for (let i = 0; i < 6; i++) await login(t, 'ADMIN', 'wrong-password-123')
    const locked = await login(t, 'admin')
    expect(locked.statusCode).toBe(429)
    expect(locked.json()).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterMs: expect.any(Number) },
    })
    t.clock.now += 16 * 60_000
    expect((await login(t, 'admin')).statusCode).toBe(200)
  })

  // Security review 2026-10-13 (L1): six wrong passwords from six addresses locked the real admin
  // out of every address. Failures count per account and address; across addresses an account is
  // held back only after many more, and never from an address it signed in from before.
  it('does not let anyone lock an account out from other addresses', async () => {
    const t = await make({ auth: true })
    await setup(t)
    const from = (ip: string, password = PASSWORD) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { username: 'admin', password },
        remoteAddress: ip,
      })
    t.app.ctx.users.create({ username: 'bob', passwordHash: await hashPassword(PASSWORD), role: 'viewer' })
    const bob = (ip: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { username: 'bob', password: PASSWORD },
        remoteAddress: ip,
      })
    expect((await from('10.0.0.1')).statusCode).toBe(200)
    for (let i = 0; i < 6; i++) await from(`10.9.0.${i + 1}`, 'wrong-password-123')
    expect((await from('10.7.7.7')).statusCode).toBe(200)
    // The address that guessed is held back for this account — not for everyone behind it.
    for (let i = 0; i < 6; i++) await from('10.9.9.9', 'wrong-password-123')
    expect((await from('10.9.9.9')).statusCode).toBe(429)
    expect((await bob('10.9.9.9')).statusCode).toBe(200)
    // Many addresses guessing hold the account back — but not where it signed in before, and a
    // sign-in there lifts it.
    for (let i = 0; i < 60; i++)
      await from(`10.8.${Math.floor(i / 250)}.${(i % 250) + 1}`, 'wrong-password-123')
    expect((await from('10.6.6.6')).statusCode).toBe(429)
    expect((await from('10.0.0.1')).statusCode).toBe(200)
    expect((await from('10.6.6.6')).statusCode).toBe(200)
  })

  it('holds an address back after it guessed at many accounts', async () => {
    const t = await make({ auth: true })
    await setup(t)
    const guess = (username: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { username, password: 'wrong-password-123' },
        remoteAddress: '10.5.5.5',
      })
    for (let i = 0; i < 20; i++) expect((await guess(`user${i}`)).statusCode).toBe(401)
    expect((await guess('user99')).statusCode).toBe(401)
    expect((await guess('user100')).statusCode).toBe(429)
  })

  // Review of L1 (I1): every correct attempt from a new address counted against the account first,
  // and the lock that set stayed — a two-factor user then failed at the code, for good.
  it('never holds an account back for a correct answer, and forgets old guesses', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    const { secret } = await enableTotp(t, s)
    const from = (ip: string, password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { username: 'admin', password },
        remoteAddress: ip,
      })
    for (let i = 0; i < 64; i++) {
      t.clock.now += 16 * 60_000
      await from(`10.4.${Math.floor(i / 250)}.${(i % 250) + 1}`, 'wrong-password-123')
    }
    t.clock.now += 16 * 60_000
    const step1 = await from('10.3.3.3', PASSWORD)
    expect(step1.json()).toMatchObject({ mfaRequired: true })
    // Guesses elsewhere meanwhile hold the account's password back, never the code step.
    for (let i = 0; i < 3; i++) await from(`10.4.9.${i + 1}`, 'wrong-password-123')
    expect((await from('10.4.9.9', 'wrong-password-123')).statusCode).toBe(429)
    t.clock.now += 31_000
    const step2 = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: H,
      payload: { ticket: step1.json().ticket, code: totpCode(secret, t.clock.now) },
      remoteAddress: '10.3.3.3',
    })
    expect(step2.statusCode).toBe(200)
    // A day later the old guesses are forgotten: five more do not hold the account back anywhere.
    t.clock.now += 25 * 3600_000
    for (let i = 0; i < 5; i++) await from(`10.2.0.${i + 1}`, 'wrong-password-123')
    expect((await from('10.2.9.9', PASSWORD)).statusCode).toBe(200)
  })

  // Review of L1 (minor 9): an address is known once the whole sign-in is done, two steps included.
  it('knows the address of a two-factor sign-in', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    const { secret } = await enableTotp(t, s)
    const from = (ip: string, password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { username: 'admin', password },
        remoteAddress: ip,
      })
    t.clock.now += 31_000
    const step1 = await from('10.1.1.1', PASSWORD)
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: H,
      payload: { ticket: step1.json().ticket, code: totpCode(secret, t.clock.now) },
      remoteAddress: '10.1.1.1',
    })
    for (let i = 0; i < 60; i++) await from(`10.8.0.${i + 1}`, 'wrong-password-123')
    expect((await from('10.6.6.6', PASSWORD)).statusCode).toBe(429)
    expect((await from('10.1.1.1', PASSWORD)).json()).toMatchObject({ mfaRequired: true })
  })

  // Review of L1: guesses at the sign-in never lock a signed-in user's password re-check.
  it('keeps sign-in guesses apart from a signed-in user’s password checks', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    for (let i = 0; i < 70; i++) await login(t, 'admin', 'wrong-password-123')
    const res = await call(t, s, 'POST', '/api/auth/totp/enroll', { password: PASSWORD })
    expect(res.statusCode).toBe(200)
  })

  it('does not let a disabled user log in', async () => {
    const t = await make({ auth: true })
    await setup(t)
    t.app.ctx.users.setDisabled(t.app.ctx.users.findByUsername('admin')!.id, true)
    expect((await login(t, 'admin')).statusCode).toBe(401)
  })
})

describe('session lifecycle', () => {
  it('logout revokes the session', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    expect((await call(t, s, 'POST', '/api/auth/logout')).statusCode).toBe(204)
    expect((await call(t, s, 'GET', '/api/auth/me')).statusCode).toBe(401)
  })

  it('password change revokes every other session and returns a new one (Review Focus 4)', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    const other = await login(t, 'admin')
    const otherCookies = { mm_sid: sid(other)! }
    expect(
      (await call(t, s, 'POST', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'short' }))
        .statusCode,
    ).toBe(400)
    const wrongCurrent = await call(t, s, 'POST', '/api/auth/password', {
      currentPassword: 'nope-nope-nope',
      newPassword: 'yeni-parola-2026-mavi',
    })
    expect(wrongCurrent.statusCode).toBe(400)
    const ok = await call(t, s, 'POST', '/api/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'yeni-parola-2026-mavi',
    })
    expect(ok.statusCode).toBe(200)
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: H, cookies: otherCookies }))
        .statusCode,
    ).toBe(401)
    const fresh = { cookies: { mm_sid: sid(ok)! }, csrf: ok.json().csrfToken }
    expect((await call(t, fresh, 'GET', '/api/auth/me')).statusCode).toBe(200)
    expect((await login(t, 'admin', 'yeni-parola-2026-mavi')).statusCode).toBe(200)
  })

  it('reports permissions and the read-only flag in /me', async () => {
    const t = await make({ auth: true, readOnly: true })
    const s = await setup(t)
    const me = (await call(t, s, 'GET', '/api/auth/me')).json()
    expect(me.readOnly).toBe(true)
    expect(me.permissions).toContain('users:manage')
    expect(me.permissions).not.toContain('documents:write')
  })
})

describe('TOTP (authenticator app) second factor', () => {
  it('enrolls with recovery codes, then requires a second step with a ticket', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    const { secret, otpauthUri } = (
      await call(t, s, 'POST', '/api/auth/totp/enroll', { password: PASSWORD })
    ).json()
    expect(otpauthUri).toContain(`secret=${secret}`)
    expect((await call(t, s, 'POST', '/api/auth/totp/confirm', { code: '000000' })).statusCode).toBe(400)
    const confirm = await call(t, s, 'POST', '/api/auth/totp/confirm', {
      code: totpCode(secret, t.clock.now),
    })
    expect(confirm.statusCode).toBe(200)
    expect(confirm.json().recoveryCodes).toHaveLength(10)
    expect((await call(t, s, 'POST', '/api/auth/totp/enroll', { password: PASSWORD })).statusCode).toBe(409)
    expect((await call(t, s, 'GET', '/api/auth/me')).json().twoFactor).toEqual({
      enabled: true,
      totp: true,
      passkeys: 0,
      recoveryCodesRemaining: 10,
    })

    t.clock.now += 60_000
    const step1 = await login(t, 'admin')
    expect(step1.statusCode).toBe(200)
    expect(step1.cookies).toHaveLength(0)
    const { ticket, methods, mfaRequired } = step1.json()
    expect(mfaRequired).toBe(true)
    expect(methods).toEqual(['totp', 'recovery'])
    expect((await post(t, '/api/auth/login/totp', { ticket, code: '123456' })).statusCode).toBe(401)
    const code = totpCode(secret, t.clock.now)
    const step2 = await post(t, '/api/auth/login/totp', { ticket, code })
    expect(step2.statusCode).toBe(200)
    expect(sid(step2)).toBeDefined()
    expect((await post(t, '/api/auth/login/totp', { ticket, code })).statusCode).toBe(401)

    const replay = (await login(t, 'admin')).json().ticket
    expect((await post(t, '/api/auth/login/totp', { ticket: replay, code })).statusCode).toBe(401)
  })

  it('invalidates a ticket after 5 wrong codes and after 5 minutes', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    const { secret } = await enableTotp(t, s)
    t.clock.now += 60_000
    const ticket = (await login(t, 'admin')).json().ticket
    for (let i = 0; i < 5; i++) await post(t, '/api/auth/login/totp', { ticket, code: '000000' })
    const dead = await post(t, '/api/auth/login/totp', { ticket, code: totpCode(secret, t.clock.now) })
    expect(dead.statusCode).toBe(401)
    expect(dead.json().message).toMatch(/expired/)
    // Clients detect expiry by reason, not by the English wording.
    expect(dead.json().details).toEqual({ reason: 'mfa_ticket_expired' })

    t.clock.now += 16 * 60_000
    const late = (await login(t, 'admin')).json().ticket
    t.clock.now += 5 * 60_000
    expect(
      (await post(t, '/api/auth/login/totp', { ticket: late, code: totpCode(secret, t.clock.now) }))
        .statusCode,
    ).toBe(401)
  })

  // Plan 1b deferred minor: a ticket from the password step outlived a password change, so whoever
  // had passed it finished the sign-in after the reset that was meant to lock them out.
  it('ends a half-finished sign-in when the password changes', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    const { secret } = await enableTotp(t, s)
    t.clock.now += 60_000
    const ticket = (await login(t, 'admin')).json().ticket
    const code = totpCode(secret, t.clock.now)
    const changed = await call(t, s, 'POST', '/api/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'yeni-parola-2026-mavi',
      code,
    })
    expect(changed.statusCode).toBe(200)
    const late = await post(t, '/api/auth/login/totp', { ticket, code })
    expect(late.statusCode).toBe(401)
    expect(late.json().details).toEqual({ reason: 'mfa_ticket_expired' })
    expect(sid(late)).toBeUndefined()
    // A sign-in begun with the new password goes on as before.
    const fresh = (await login(t, 'admin', 'yeni-parola-2026-mavi')).json().ticket
    t.clock.now += 30_000
    const done = await post(t, '/api/auth/login/totp', { ticket: fresh, code: totpCode(secret, t.clock.now) })
    expect(done.statusCode).toBe(200)
  })

  // Review of the deferred fixes: an administrator's reset ends the user's half-finished sign-in too.
  it('ends a half-finished sign-in when an administrator resets the password', async () => {
    const t = await make({ auth: true })
    const admin = await setup(t)
    const eve = t.app.ctx.users.create({
      username: 'eve',
      passwordHash: await hashPassword(PASSWORD),
      role: 'editor',
    })
    const { sessionId, session } = t.app.ctx.sessions.create(eve.id, {})
    const { secret } = await enableTotp(t, { cookies: { mm_sid: sessionId }, csrf: session.csrfToken })
    t.clock.now += 60_000
    const ticket = (await login(t, 'eve')).json().ticket
    const reset = await call(t, admin, 'POST', `/api/users/${eve.id}/password`, {
      password: 'yeni-parola-2026-mavi',
      currentPassword: PASSWORD,
    })
    expect(reset.statusCode).toBe(204)
    const late = await post(t, '/api/auth/login/totp', { ticket, code: totpCode(secret, t.clock.now) })
    expect(late.statusCode).toBe(401)
    expect(late.json().details).toEqual({ reason: 'mfa_ticket_expired' })
  })

  // Review of the deferred fixes (M7): a password changed while a factor was being checked (a passkey's
  // check is asynchronous) still let the sign-in through.
  it('does not finish a sign-in whose password changed while its factor was checked', async () => {
    const t = await make({ auth: true })
    t.app.post('/t/second-factor', { config: { csrf: false } }, async (request, reply) =>
      completeSecondFactor(request, reply, (request.body as { ticket: string }).ticket, async (record) => {
        t.app.ctx.users.setPassword(record.id, await hashPassword('yeni-parola-2026-mavi'))
        return true
      }),
    )
    const s = await setup(t)
    await enableTotp(t, s)
    t.clock.now += 60_000
    const ticket = (await login(t, 'admin')).json().ticket
    const res = await post(t, '/t/second-factor', { ticket })
    expect(res.statusCode).toBe(401)
    expect(sid(res)).toBeUndefined()
  })

  // Review of the deferred fixes (M7, the one-step path): a password changed while the old one was
  // being checked let a session in after the change had revoked every other.
  it('does not sign in with a password changed while it was being checked', async () => {
    const t = await make({ auth: true })
    await setup(t)
    const record = t.app.ctx.users.findByUsername('admin')!
    const newHash = await hashPassword('yeni-parola-2026-mavi')
    const original = t.app.ctx.users.findByUsername.bind(t.app.ctx.users)
    // The change lands right after the record was read, while scrypt runs.
    t.app.ctx.users.findByUsername = (name: string) => {
      const found = original(name)
      if (found) setImmediate(() => t.app.ctx.users.setPassword(record.id, newHash))
      return found
    }
    const res = await login(t, 'admin')
    expect(res.statusCode).toBe(401)
    expect(sid(res)).toBeUndefined()
  })

  it('disabling the only factor clears recovery codes and restores one-step login', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    const { secret } = await enableTotp(t, s)
    t.clock.now += 60_000
    const bad = await call(t, s, 'POST', '/api/auth/totp/disable', {
      password: 'wrong-password-99',
      code: totpCode(secret, t.clock.now),
    })
    expect(bad.statusCode).toBe(400)
    const off = await call(t, s, 'POST', '/api/auth/totp/disable', {
      password: PASSWORD,
      code: totpCode(secret, t.clock.now),
    })
    expect(off.statusCode).toBe(204)
    expect((await call(t, s, 'GET', '/api/auth/me')).json().twoFactor).toMatchObject({
      enabled: false,
      recoveryCodesRemaining: 0,
    })
    expect((await login(t, 'admin')).json().csrfToken).toEqual(expect.any(String))
  })
})

describe('recovery codes', () => {
  it('sign in once per code, and regeneration invalidates the old set', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    const { recoveryCodes } = await enableTotp(t, s)
    const ticket = (await login(t, 'admin')).json().ticket
    const ok = await post(t, '/api/auth/login/recovery', { ticket, code: recoveryCodes[0] })
    expect(ok.statusCode).toBe(200)
    const again = (await login(t, 'admin')).json().ticket
    expect(
      (await post(t, '/api/auth/login/recovery', { ticket: again, code: recoveryCodes[0] })).statusCode,
    ).toBe(401)
    expect((await call(t, s, 'GET', '/api/auth/me')).json().twoFactor.recoveryCodesRemaining).toBe(9)

    expect(
      (await call(t, s, 'POST', '/api/auth/recovery-codes', { password: 'wrong-password-99' })).statusCode,
    ).toBe(400)
    const regen = await call(t, s, 'POST', '/api/auth/recovery-codes', { password: PASSWORD })
    expect(regen.json().recoveryCodes).toHaveLength(10)
    const third = (await login(t, 'admin')).json().ticket
    expect(
      (await post(t, '/api/auth/login/recovery', { ticket: third, code: recoveryCodes[1] })).statusCode,
    ).toBe(401)
    expect(
      (await post(t, '/api/auth/login/recovery', { ticket: third, code: regen.json().recoveryCodes[0] }))
        .statusCode,
    ).toBe(200)
  })

  it('cannot generate recovery codes without a second factor', async () => {
    const t = await make({ auth: true })
    const s = await setup(t)
    expect((await call(t, s, 'POST', '/api/auth/recovery-codes', { password: PASSWORD })).statusCode).toBe(
      409,
    )
  })
})
