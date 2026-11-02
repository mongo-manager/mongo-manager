import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { totpCode } from '../src/auth/totp'

/**
 * Security audit 2026-10-16 (important 1): a stolen administrator session alone could create an
 * administrator, promote an account, or reset another account's password or second factors — a
 * lasting way in that outlives the session. Each now takes the caller's own password, and a second
 * factor proved lately when the caller has one. Turning the administrators' 2FA requirement off and
 * shortening the audit log take that second factor too (minor).
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const PASSWORD = 'tarçın-kavanoz-42-mavi'
const OTHER = 'baska-parola-2026-yesil'
const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'mm_sid')?.value

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
  const session = { cookies: { mm_sid: sid(res)! }, csrf: res.json().csrfToken as string }
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { ...H, 'x-csrf-token': session.csrf },
      cookies: session.cookies,
      ...(payload ? { payload } : {}),
    })
  const bob = (
    await call('POST', '/api/users', {
      username: 'bob',
      password: OTHER,
      role: 'viewer',
      currentPassword: PASSWORD,
    })
  ).json() as { id: string }
  return { t, call, bob }
}

async function withTotp(s: Awaited<ReturnType<typeof team>>): Promise<string> {
  const { secret } = (await s.call('POST', '/api/auth/totp/enroll', { password: PASSWORD })).json()
  const confirm = await s.call('POST', '/api/auth/totp/confirm', { code: totpCode(secret, s.t.clock.now) })
  expect(confirm.statusCode).toBe(200)
  return secret as string
}

/** The four account changes that hand out a lasting way in, each with its body less the password. */
const actions = (bobId: string) =>
  [
    [
      'POST',
      '/api/users',
      { username: `eve${Math.random().toString(36).slice(2, 8)}`, password: OTHER, role: 'admin' },
    ],
    ['PATCH', `/api/users/${bobId}`, { role: 'admin' }],
    ['POST', `/api/users/${bobId}/password`, { password: 'yeni-parola-2026-mor-kalem' }],
    ['POST', `/api/users/${bobId}/reset-2fa`, {}],
  ] as const

describe('account changes that outlive a session', () => {
  it('refuse a session without the administrator password', async () => {
    const s = await team()
    for (const [method, url, body] of actions(s.bob.id)) {
      const missing = await s.call(method, url, body)
      expect(missing.statusCode, `${method} ${url} without the password`).toBe(400)
      expect(missing.json().details).toMatchObject({ reason: 'wrong_password' })
      const wrong = await s.call(method, url, { ...body, currentPassword: 'not-the-password-2026' })
      expect(wrong.statusCode, `${method} ${url} with a wrong password`).toBe(400)
      expect(wrong.json().details).toMatchObject({ reason: 'wrong_password' })
    }
    // Nothing changed: bob is a viewer still, and no administrator was added.
    const users = (await s.call('GET', '/api/users')).json() as Array<{ username: string; role: string }>
    expect(users.map((u) => [u.username, u.role])).toEqual([
      ['admin', 'admin'],
      ['bob', 'viewer'],
    ])
  })

  it('go through with the administrator password', async () => {
    const s = await team()
    for (const [method, url, body] of actions(s.bob.id)) {
      const res = await s.call(method, url, { ...body, currentPassword: PASSWORD })
      expect(res.statusCode, `${method} ${url}`).toBeLessThan(300)
    }
  })

  it('leave disabling an account as it was (it takes a way in away)', async () => {
    const s = await team()
    expect((await s.call('PATCH', `/api/users/${s.bob.id}`, { disabled: true })).statusCode).toBe(200)
  })

  // Review of the audit fixes (important 3): a disabled account brought back is a way in again.
  it('take the administrator password to enable an account again', async () => {
    const s = await team()
    expect((await s.call('PATCH', `/api/users/${s.bob.id}`, { disabled: true })).statusCode).toBe(200)
    const bare = await s.call('PATCH', `/api/users/${s.bob.id}`, { disabled: false })
    expect(bare.statusCode).toBe(400)
    expect(bare.json().details).toMatchObject({ reason: 'wrong_password' })
    expect((await s.call('GET', '/api/users')).json()[1]).toMatchObject({ disabled: true })
    const ok = await s.call('PATCH', `/api/users/${s.bob.id}`, { disabled: false, currentPassword: PASSWORD })
    expect(ok.statusCode).toBe(200)
  })

  // Review of the audit fixes (minor 3): without a recent second factor the password is not even
  // checked, so a stolen session cannot use these routes to guess it.
  it('ask the second factor before the password, so the password cannot be guessed here', async () => {
    const s = await team()
    await withTotp(s)
    s.t.clock.now += 11 * 60_000
    for (let i = 0; i < 8; i++) {
      const res = await s.call('POST', `/api/users/${s.bob.id}/reset-2fa`, {
        currentPassword: `guess-${i}-x`,
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().details).toMatchObject({ reason: 'step_up_required' })
    }
  })

  it('hold back guesses at the administrator password', async () => {
    const s = await team()
    for (let i = 0; i < 6; i++)
      await s.call('POST', `/api/users/${s.bob.id}/reset-2fa`, { currentPassword: `guess-${i}-xxxxxxxx` })
    const held = await s.call('POST', `/api/users/${s.bob.id}/reset-2fa`, { currentPassword: PASSWORD })
    expect(held.statusCode).toBe(429)
  })

  it('take a second factor proved lately from an administrator who has one', async () => {
    const s = await team()
    const secret = await withTotp(s)
    s.t.clock.now += 11 * 60_000
    for (const [method, url, body] of actions(s.bob.id)) {
      const res = await s.call(method, url, { ...body, currentPassword: PASSWORD })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().details).toMatchObject({ reason: 'step_up_required', methods: ['totp', 'recovery'] })
    }
    const stepUp = await s.call('POST', '/api/auth/step-up', { code: totpCode(secret, s.t.clock.now) })
    expect(stepUp.statusCode).toBe(204)
    for (const [method, url, body] of actions(s.bob.id)) {
      const res = await s.call(method, url, { ...body, currentPassword: PASSWORD })
      expect(res.statusCode, `${method} ${url}`).toBeLessThan(300)
    }
  })
})

describe('weakening the audit trail and the 2FA requirement', () => {
  it('turning the administrators’ 2FA requirement off takes a second factor proved lately', async () => {
    const s = await team()
    const secret = await withTotp(s)
    expect((await s.call('PUT', '/api/users/policy', { adminTwoFactor: true })).statusCode).toBe(200)
    s.t.clock.now += 11 * 60_000
    const off = await s.call('PUT', '/api/users/policy', { adminTwoFactor: false, password: PASSWORD })
    expect(off.statusCode).toBe(403)
    expect(off.json().details).toMatchObject({ reason: 'step_up_required' })
    expect((await s.call('GET', '/api/users/policy')).json()).toMatchObject({ adminTwoFactor: true })
    await s.call('POST', '/api/auth/step-up', { code: totpCode(secret, s.t.clock.now) })
    expect(
      (await s.call('PUT', '/api/users/policy', { adminTwoFactor: false, password: PASSWORD })).statusCode,
    ).toBe(200)
  })

  it('shortening the audit log takes a second factor proved lately', async () => {
    const s = await team()
    const secret = await withTotp(s)
    s.t.clock.now += 11 * 60_000
    const shorten = await s.call('PUT', '/api/audit/settings', { days: 30, password: PASSWORD })
    expect(shorten.statusCode).toBe(403)
    expect(shorten.json().details).toMatchObject({ reason: 'step_up_required' })
    expect((await s.call('GET', '/api/audit/settings')).json()).toMatchObject({ days: null })
    // Keeping it longer weakens nothing: no second factor asked.
    await s.call('POST', '/api/auth/step-up', { code: totpCode(secret, s.t.clock.now) })
    expect((await s.call('PUT', '/api/audit/settings', { days: 30, password: PASSWORD })).statusCode).toBe(
      200,
    )
  })
})
