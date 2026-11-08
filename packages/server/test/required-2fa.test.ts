// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { H, makeApp, type TestApp } from './helpers'
import { hashPassword } from '../src/auth/passwords'
import { generateTotpSecret, totpCode } from '../src/auth/totp'
import { totpContext } from '../src/routes/auth'

/** Required 2FA, per user and for everyone (spec 2026-10-28-required-2fa-design.md). */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const PASSWORD = 'the right password'
const NEW_PASSWORD = 'a long enough new password 1'

async function team(overrides: Record<string, unknown> = {}) {
  const t = await makeApp({ auth: true, ...overrides })
  apps.push(t)
  const { ctx } = t.app
  const signIn = (userId: string, stepUp = false) => {
    const { sessionId, session } = ctx.sessions.create(userId, {})
    if (stepUp) ctx.stepUps.mark(session.idHash)
    return (method: Method, url: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/${url}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload ? { payload } : {}),
      })
  }
  const as = (role: 'admin' | 'editor' | 'viewer', factors: { totp?: boolean } = {}) => {
    const user = ctx.users.create({
      username: `u-${role}-${randomUUID().slice(0, 6)}`,
      passwordHash: 'x',
      role,
    })
    if (factors.totp) ctx.users.setTotp(user.id, 'sealed', true)
    return { id: user.id, call: signIn(user.id) }
  }
  /** An administrator with 2FA, a known password and a second factor proved in this session. */
  const boss = async () => {
    const user = ctx.users.create({
      username: `boss-${randomUUID().slice(0, 6)}`,
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
    })
    ctx.users.setTotp(user.id, 'sealed', true)
    return { id: user.id, call: signIn(user.id, true) }
  }
  return { t, ctx, as, boss, signIn }
}

const reason = (res: { statusCode: number; json: () => { details?: { reason?: string } } }) => [
  res.statusCode,
  res.json().details?.reason,
]

describe('2FA required of one user', () => {
  it('is set when the user is created, off by default, and audited', async () => {
    const { ctx, boss } = await team()
    const admin = await boss()
    const created = await admin.call('POST', 'users', {
      username: 'alice',
      password: NEW_PASSWORD,
      role: 'viewer',
      requireTwoFactor: true,
      currentPassword: PASSWORD,
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({ username: 'alice', requireTwoFactor: true })
    expect(ctx.audit.list({ action: 'users.create' })[0]).toMatchObject({
      details: { target: 'alice', requireTwoFactor: true },
    })
    const plain = await admin.call('POST', 'users', {
      username: 'bob',
      password: NEW_PASSWORD,
      role: 'viewer',
      currentPassword: PASSWORD,
    })
    expect(plain.json()).toMatchObject({ username: 'bob', requireTwoFactor: false })
    const listed = (await admin.call('GET', 'users')).json() as Array<{
      username: string
      requireTwoFactor: boolean
    }>
    expect(listed.filter((u) => u.username !== 'alice' && u.username !== 'bob').length).toBe(1)
    expect(Object.fromEntries(listed.map((u) => [u.username, u.requireTwoFactor]))).toMatchObject({
      alice: true,
      bob: false,
    })
  })

  it('refuses a flag that is not a boolean', async () => {
    const { boss } = await team()
    const admin = await boss()
    const res = await admin.call('POST', 'users', {
      username: 'carol',
      password: NEW_PASSWORD,
      role: 'viewer',
      requireTwoFactor: 'yes',
      currentPassword: PASSWORD,
    })
    expect(res.statusCode).toBe(400)
  })

  it('keeps that user to setting 2FA up until they have it, and no one else', async () => {
    const { ctx, as, signIn } = await team()
    const required = ctx.users.create({
      username: 'dave',
      passwordHash: 'x',
      role: 'viewer',
      requireTwoFactor: true,
    })
    const call = signIn(required.id)
    expect(reason(await call('GET', 'connections'))).toEqual([403, 'two_factor_setup_required'])
    expect((await call('GET', 'auth/me')).json()).toMatchObject({
      twoFactorRequired: true,
      twoFactorRequiredBy: 'account',
    })
    // A viewer without the flag is not concerned.
    expect((await as('viewer').call('GET', 'connections')).statusCode).toBe(200)
    ctx.users.setTotp(required.id, 'sealed', true)
    expect((await call('GET', 'connections')).statusCode).toBe(200)
    const me = (await call('GET', 'auth/me')).json()
    expect(me.twoFactorRequired).toBe(false)
    expect(me.twoFactorRequiredBy).toBeUndefined()
  })

  it('never lets a required user remove their last method; an optional one may', async () => {
    const { ctx, signIn } = await team()
    const required = ctx.users.create({
      username: 'erin',
      passwordHash: 'x',
      role: 'editor',
      requireTwoFactor: true,
    })
    ctx.users.setTotp(required.id, 'sealed', true)
    const off = await signIn(required.id)('POST', 'auth/totp/disable', { password: 'x', code: '000000' })
    expect(reason(off)).toEqual([409, 'last_factor_required'])
    expect(off.json().message).toBe('Two-factor authentication is required for this account')
    const optional = ctx.users.create({ username: 'frank', passwordHash: 'x', role: 'editor' })
    // A real secret: this one gets as far as checking the code.
    ctx.users.setTotp(optional.id, ctx.secretBox.seal(generateTotpSecret(), totpContext(optional.id)), true)
    const tried = await signIn(optional.id)('POST', 'auth/totp/disable', { password: 'x', code: '000000' })
    expect(reason(tried)).toEqual([400, 'wrong_password_or_code'])
  })

  it('is turned on later without a password, and off only with the administrator’s own', async () => {
    const { ctx, boss, signIn } = await team()
    const admin = await boss()
    const user = ctx.users.create({ username: 'gina', passwordHash: 'x', role: 'editor' })
    const on = await admin.call('PATCH', `users/${user.id}`, { requireTwoFactor: true })
    expect(on.statusCode).toBe(200)
    expect(on.json()).toMatchObject({ requireTwoFactor: true })
    expect(ctx.audit.list({ action: 'users.update' })[0]).toMatchObject({
      details: { change: { requireTwoFactor: true } },
    })
    expect(reason(await signIn(user.id)('GET', 'connections'))).toEqual([403, 'two_factor_setup_required'])
    for (const body of [{ requireTwoFactor: false }, { requireTwoFactor: false, currentPassword: 'nope' }]) {
      const res = await admin.call('PATCH', `users/${user.id}`, body)
      expect(reason(res)).toEqual([400, 'wrong_password'])
    }
    expect(ctx.users.findById(user.id)?.requireTwoFactor).toBe(true)
    const off = await admin.call('PATCH', `users/${user.id}`, {
      requireTwoFactor: false,
      currentPassword: PASSWORD,
    })
    expect(off.json()).toMatchObject({ requireTwoFactor: false })
    expect((await signIn(user.id)('GET', 'connections')).statusCode).toBe(200)
  })

  it('needs a second factor proved lately to take the flag off', async () => {
    const { ctx, signIn } = await team()
    const admin = ctx.users.create({
      username: 'hal',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
    })
    ctx.users.setTotp(admin.id, 'sealed', true)
    const user = ctx.users.create({
      username: 'ivy',
      passwordHash: 'x',
      role: 'editor',
      requireTwoFactor: true,
    })
    // Signed in, but no second factor proved in this session.
    const res = await signIn(admin.id)('PATCH', `users/${user.id}`, {
      requireTwoFactor: false,
      currentPassword: PASSWORD,
    })
    expect(res.statusCode).toBe(403)
    expect(ctx.users.findById(user.id)?.requireTwoFactor).toBe(true)
  })

  it('is set on oneself only by an administrator who has 2FA', async () => {
    const { ctx, signIn } = await team()
    const bare = ctx.users.create({ username: 'jack', passwordHash: 'x', role: 'admin' })
    const res = await signIn(bare.id)('PATCH', `users/${bare.id}`, { requireTwoFactor: true })
    expect(reason(res)).toEqual([409, 'two_factor_needed_first'])
    expect(ctx.users.findById(bare.id)?.requireTwoFactor).toBe(false)
  })

  it('is for an administrator to change', async () => {
    const { ctx, as } = await team()
    const user = ctx.users.create({
      username: 'kim',
      passwordHash: 'x',
      role: 'viewer',
      requireTwoFactor: true,
    })
    const editor = as('editor', { totp: true })
    expect((await editor.call('PATCH', `users/${user.id}`, { requireTwoFactor: false })).statusCode).toBe(403)
  })
})

describe('2FA required of everyone', () => {
  it('is turned on only by an administrator who has 2FA, and covers every role', async () => {
    const { ctx, as, boss, signIn } = await team()
    const bare = as('admin')
    expect((await bare.call('GET', 'users/policy')).json()).toEqual({
      adminTwoFactor: false,
      forced: false,
      everyoneTwoFactor: false,
      everyoneForced: false,
    })
    expect(reason(await bare.call('PUT', 'users/policy', { everyoneTwoFactor: true }))).toEqual([
      409,
      'two_factor_needed_first',
    ])
    const admin = await boss()
    const on = await admin.call('PUT', 'users/policy', { everyoneTwoFactor: true })
    expect(on.json()).toEqual({
      adminTwoFactor: false,
      forced: false,
      everyoneTwoFactor: true,
      everyoneForced: false,
    })
    expect(ctx.audit.list({ action: 'users.policy' })[0]).toMatchObject({
      details: { everyoneTwoFactor: true },
    })
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      const user = ctx.users.create({ username: `n-${role}`, passwordHash: 'x', role })
      const call = signIn(user.id)
      expect(reason(await call('GET', 'connections'))).toEqual([403, 'two_factor_setup_required'])
      expect((await call('GET', 'auth/me')).json()).toMatchObject({ twoFactorRequiredBy: 'everyone' })
    }
    expect((await as('viewer', { totp: true }).call('GET', 'connections')).statusCode).toBe(200)
    // Everyone keeps their last method.
    const kept = await as('viewer', { totp: true }).call('POST', 'auth/totp/disable', {
      password: 'x',
      code: '000000',
    })
    expect(reason(kept)).toEqual([409, 'last_factor_required'])
  })

  it('leaves the other requirement as it is when only one is given', async () => {
    const { boss } = await team()
    const admin = await boss()
    await admin.call('PUT', 'users/policy', { adminTwoFactor: true })
    const res = await admin.call('PUT', 'users/policy', { everyoneTwoFactor: true })
    expect(res.json()).toMatchObject({ adminTwoFactor: true, everyoneTwoFactor: true })
    expect((await admin.call('PUT', 'users/policy', {})).statusCode).toBe(400)
    expect((await admin.call('PUT', 'users/policy', { everyoneTwoFactor: 'on' })).statusCode).toBe(400)
  })

  it('asks the password and a second factor of who turns it off', async () => {
    const { ctx, boss, signIn } = await team()
    const admin = await boss()
    await admin.call('PUT', 'users/policy', { everyoneTwoFactor: true })
    for (const body of [{ everyoneTwoFactor: false }, { everyoneTwoFactor: false, password: 'nope' }])
      expect(reason(await admin.call('PUT', 'users/policy', body))).toEqual([400, 'wrong_password'])
    // The password alone, from a session that proved no second factor.
    const stale = signIn(admin.id)
    expect(
      (await stale('PUT', 'users/policy', { everyoneTwoFactor: false, password: PASSWORD })).statusCode,
    ).toBe(403)
    const off = await admin.call('PUT', 'users/policy', { everyoneTwoFactor: false, password: PASSWORD })
    expect(off.json()).toMatchObject({ everyoneTwoFactor: false })
    expect(ctx.audit.list({ action: 'users.policy' })[0]).toMatchObject({
      details: { everyoneTwoFactor: false },
    })
  })

  it('names the strongest reason a user must have 2FA', async () => {
    const { ctx, boss, signIn } = await team()
    const admin = await boss()
    await admin.call('PUT', 'users/policy', { adminTwoFactor: true })
    const flagged = ctx.users.create({
      username: 'lea',
      passwordHash: 'x',
      role: 'admin',
      requireTwoFactor: true,
    })
    expect((await signIn(flagged.id)('GET', 'auth/me')).json()).toMatchObject({
      twoFactorRequiredBy: 'admins',
    })
    await admin.call('PUT', 'users/policy', { everyoneTwoFactor: true })
    expect((await signIn(flagged.id)('GET', 'auth/me')).json()).toMatchObject({
      twoFactorRequiredBy: 'everyone',
    })
  })

  it('may be forced by configuration, then shown and kept on', async () => {
    const { as } = await team({ requireAll2fa: true })
    const secured = as('admin', { totp: true })
    expect((await secured.call('GET', 'users/policy')).json()).toEqual({
      adminTwoFactor: false,
      forced: false,
      everyoneTwoFactor: true,
      everyoneForced: true,
    })
    expect(reason(await secured.call('PUT', 'users/policy', { everyoneTwoFactor: false }))).toEqual([
      409,
      'forced_by_config',
    ])
    expect(reason(await as('viewer').call('GET', 'connections'))).toEqual([403, 'two_factor_setup_required'])
  })
})

describe('required 2FA: the final review', () => {
  const addPasskey = (ctx: TestApp['app']['ctx'], userId: string) => {
    const id = randomUUID()
    ctx.store.db
      .prepare(
        `INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, created_at)
         VALUES (?, ?, 'key', x'00', 0, '[]', 0)`,
      )
      .run(id, userId)
    return id
  }

  it('lets a pending user set an authenticator app up, and then in', async () => {
    const { ctx, signIn } = await team()
    const user = ctx.users.create({
      username: 'mia',
      passwordHash: await hashPassword(PASSWORD),
      role: 'viewer',
      requireTwoFactor: true,
    })
    const call = signIn(user.id)
    expect(reason(await call('GET', 'connections'))).toEqual([403, 'two_factor_setup_required'])
    const enrolled = await call('POST', 'auth/totp/enroll', { password: PASSWORD })
    expect(enrolled.statusCode).toBe(200)
    const code = totpCode(enrolled.json().secret, ctx.now())
    const confirmed = await call('POST', 'auth/totp/confirm', { code })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json().recoveryCodes).toHaveLength(10)
    expect((await call('GET', 'connections')).statusCode).toBe(200)
  })

  it('refuses a new socket of a pending user', async () => {
    const { t, ctx } = await team()
    const user = ctx.users.create({
      username: 'noa',
      passwordHash: 'x',
      role: 'viewer',
      requireTwoFactor: true,
    })
    const { sessionId } = ctx.sessions.create(user.id, {})
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
      cookies: { mm_sid: sessionId },
    })
    expect([socket.statusCode, socket.json().details?.reason]).toEqual([403, 'two_factor_setup_required'])
  })

  it('never lets a required user delete their last passkey, nor two deletes race it away', async () => {
    const { ctx, t } = await team()
    const user = ctx.users.create({
      username: 'olga',
      passwordHash: await hashPassword(PASSWORD),
      role: 'viewer',
      requireTwoFactor: true,
    })
    const ids = [addPasskey(ctx, user.id), addPasskey(ctx, user.id)]
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    ctx.stepUps.mark(session.idHash)
    const remove = (id: string) =>
      t.app.inject({
        method: 'DELETE',
        url: `/api/auth/passkeys/${id}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        payload: { password: PASSWORD },
      })
    const results = await Promise.all(ids.map(remove))
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 409])
    expect(ctx.passkeys.countForUser(user.id)).toBe(1)
    const left = (
      ctx.store.db.prepare('SELECT id FROM passkeys WHERE user_id = ?').get(user.id) as { id: string }
    ).id
    expect(reason(await remove(left))).toEqual([409, 'last_factor_required'])
  })

  it('keeps the flag when the role changes', async () => {
    const { ctx, boss, signIn } = await team()
    const admin = await boss()
    const user = ctx.users.create({
      username: 'pia',
      passwordHash: 'x',
      role: 'viewer',
      requireTwoFactor: true,
    })
    const res = await admin.call('PATCH', `users/${user.id}`, { role: 'editor', currentPassword: PASSWORD })
    expect(res.json()).toMatchObject({ role: 'editor', requireTwoFactor: true })
    expect(reason(await signIn(user.id)('GET', 'connections'))).toEqual([403, 'two_factor_setup_required'])
  })

  it('tells the open sockets once, after the change is stored, and not at all when it is refused', async () => {
    const { ctx, boss } = await team()
    const admin = await boss()
    const user = ctx.users.create({ username: 'rae', passwordHash: 'x', role: 'viewer' })
    const changed = vi.spyOn(ctx.access, 'changed')
    await admin.call('PATCH', `users/${user.id}`, {
      role: 'editor',
      requireTwoFactor: true,
      currentPassword: PASSWORD,
    })
    expect(changed).toHaveBeenCalledTimes(1)
    changed.mockClear()
    // Refused inside the transaction (an administrator demoting themselves): nothing changed.
    const refused = await admin.call('PATCH', `users/${admin.id}`, {
      role: 'viewer',
      requireTwoFactor: true,
      currentPassword: PASSWORD,
    })
    expect(reason(refused)).toEqual([409, 'self_demote'])
    expect(changed).not.toHaveBeenCalled()
  })

  it('ends the shells of the users who must now set 2FA up', async () => {
    const { ctx, boss } = await team()
    const admin = await boss()
    const flagged = ctx.users.create({ username: 'sam', passwordHash: 'x', role: 'viewer' })
    const secured = ctx.users.create({ username: 'tia', passwordHash: 'x', role: 'viewer' })
    ctx.users.setTotp(secured.id, 'sealed', true)
    const bare = ctx.users.create({ username: 'uma', passwordHash: 'x', role: 'editor' })
    const closeFor = vi.spyOn(ctx.shell, 'closeFor')
    await admin.call('PATCH', `users/${flagged.id}`, { requireTwoFactor: true })
    expect(closeFor.mock.calls).toEqual([[{ userId: flagged.id }, 'access']])
    closeFor.mockClear()
    await admin.call('PUT', 'users/policy', { everyoneTwoFactor: true })
    const ended = closeFor.mock.calls.map(([match]) => (match as { userId: string }).userId).sort()
    // The flagged user's shells went already: only who must now set 2FA up.
    expect(ended).toEqual([bare.id])
    expect(ended).not.toContain(secured.id)
    expect(ended).not.toContain(admin.id)
  })

  it('confirms the second factor before the password, so a session alone cannot test passwords', async () => {
    const { ctx, boss, signIn } = await team()
    const admin = await boss()
    await admin.call('PUT', 'users/policy', { everyoneTwoFactor: true })
    const stale = signIn(admin.id)
    for (const password of ['nope', PASSWORD])
      expect(reason(await stale('PUT', 'users/policy', { everyoneTwoFactor: false, password }))).toEqual([
        403,
        'step_up_required',
      ])
    expect(ctx.audit.list({ action: 'users.policy' })[0]).toMatchObject({ outcome: 'denied' })
  })

  it('asks the password for a body that turns one rule on and the other off', async () => {
    const { boss } = await team()
    const admin = await boss()
    await admin.call('PUT', 'users/policy', { everyoneTwoFactor: true })
    expect(
      reason(await admin.call('PUT', 'users/policy', { adminTwoFactor: true, everyoneTwoFactor: false })),
    ).toEqual([400, 'wrong_password'])
    expect((await admin.call('GET', 'users/policy')).json()).toMatchObject({
      adminTwoFactor: false,
      everyoneTwoFactor: true,
    })
  })

  it('reads a stored rule it cannot parse as required, never as off', async () => {
    const { ctx, as } = await team()
    ctx.store.db
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 0)')
      .run('auth.everyoneTwoFactor', '{"required":"maybe"}')
    expect((await as('admin', { totp: true }).call('GET', 'users/policy')).json()).toMatchObject({
      everyoneTwoFactor: true,
    })
    expect(reason(await as('viewer').call('GET', 'connections'))).toEqual([403, 'two_factor_setup_required'])
  })
})
