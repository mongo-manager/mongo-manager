// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { hashPassword } from '../src/auth/passwords'
import type { SessionRevocation } from '../src/auth/sessions'

/**
 * Security audit 2026-10-16 (minor): what ends a session ends what the session started at once —
 * the sockets of a deleted user (its sessions went by cascade, with no word to the sockets), and the
 * shells (a running command went on) after sign-out, a password change, an administrator's password
 * or two-factor reset.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const PASSWORD = 'tarçın-kavanoz-42-mavi'
const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'mm_sid')?.value

async function team() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const closed: Array<{ match: { connectionId?: string; userId?: string | null }; reason: string }> = []
  ;(ctx.shell as unknown as { closeFor: unknown }).closeFor = async (
    match: { connectionId?: string; userId?: string | null },
    reason: string,
  ) => {
    closed.push({ match, reason })
  }
  const revoked: SessionRevocation[] = []
  ctx.sessions.onRevoke((r) => revoked.push(r))
  const token = ctx.setup.ensureToken()
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: H,
    payload: { token, username: 'admin', password: PASSWORD },
  })
  const adminId = res.json().user.id as string
  const signedIn = (r: LightMyRequestResponse) => ({
    cookies: { mm_sid: sid(r)! },
    csrf: r.json().csrfToken as string,
  })
  const call = (
    s: { cookies: { mm_sid: string }; csrf: string },
    method: 'POST' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url,
      headers: { ...H, 'x-csrf-token': s.csrf },
      cookies: s.cookies,
      ...(payload ? { payload } : {}),
    })
  const bob = ctx.users.create({
    username: 'bob',
    passwordHash: await hashPassword(PASSWORD),
    role: 'editor',
  })
  const login = async (username: string) =>
    signedIn(
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { username, password: PASSWORD },
      }),
    )
  return { t, ctx, closed, revoked, admin: signedIn(res), adminId, bob, call, login }
}

describe('ending a session ends what it started', () => {
  it('deleting a user ends their sessions with word to their sockets', async () => {
    const s = await team()
    await s.login('bob')
    s.revoked.length = 0
    expect((await s.call(s.admin, 'DELETE', `/api/users/${s.bob.id}`)).statusCode).toBe(204)
    expect(s.revoked).toContainEqual({ userId: s.bob.id })
  })

  it('signing out closes the shells', async () => {
    const s = await team()
    const bob = await s.login('bob')
    expect((await s.call(bob, 'POST', '/api/auth/logout')).statusCode).toBe(204)
    expect(s.closed).toContainEqual({ match: { userId: s.bob.id }, reason: 'access' })
  })

  it('changing one’s password closes the shells', async () => {
    const s = await team()
    const bob = await s.login('bob')
    const res = await s.call(bob, 'POST', '/api/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'yeni-parola-2026-mor-kalem',
    })
    expect(res.statusCode).toBe(200)
    expect(s.closed).toContainEqual({ match: { userId: s.bob.id }, reason: 'access' })
  })

  it('an administrator’s password or two-factor reset closes the user’s shells', async () => {
    const s = await team()
    const reset = await s.call(s.admin, 'POST', `/api/users/${s.bob.id}/password`, {
      password: 'yeni-parola-2026-mor-kalem',
      currentPassword: PASSWORD,
    })
    expect(reset.statusCode).toBe(204)
    expect(s.closed).toContainEqual({ match: { userId: s.bob.id }, reason: 'access' })
    s.closed.length = 0
    const twoFactor = await s.call(s.admin, 'POST', `/api/users/${s.bob.id}/reset-2fa`, {
      currentPassword: PASSWORD,
    })
    expect(twoFactor.statusCode).toBe(204)
    expect(s.closed).toContainEqual({ match: { userId: s.bob.id }, reason: 'access' })
  })
})
