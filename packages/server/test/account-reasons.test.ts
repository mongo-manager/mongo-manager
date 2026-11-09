// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { passwordProblemCodes } from '../src/auth/passwords'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const PASSWORD = 'tarçın-kavanoz-42-mavi'
const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'mm_sid')?.value

async function admin() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const token = t.app.ctx.setup.ensureToken()
  const weak = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: H,
    payload: { token, username: 'admin', password: 'admin-short' },
  })
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: H,
    payload: { token, username: 'admin', password: PASSWORD },
  })
  const csrf = res.json().csrfToken as string
  const req = (url: string, payload: object) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...H, 'x-csrf-token': csrf },
      cookies: { mm_sid: sid(res)! },
      payload,
    })
  return { weak, req }
}

const details = (r: LightMyRequestResponse) => r.json().details

describe('account refusals name their reason (shown in the user language)', () => {
  it('password policy problems come as codes', async () => {
    const { weak } = await admin()
    expect(weak.statusCode).toBe(400)
    expect(details(weak)).toEqual({ reason: 'weak_password', problems: ['too_short', 'contains_username'] })
    expect(passwordProblemCodes('aaaaaaaaaaaaaa')).toEqual(['repeated_char'])
    expect(passwordProblemCodes('password1234')).toEqual(['too_common'])
    expect(passwordProblemCodes('ab'.repeat(513))).toEqual(['too_long'])
    // Password strength (2026-10-28): long, but among the first guesses.
    expect(passwordProblemCodes('qwertyuiopasdf')).toEqual(['too_predictable'])
  })

  it('refuses a predictable password when setting one up, as the meter says', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: H,
      payload: { token: t.app.ctx.setup.ensureToken(), username: 'admin', password: 'Password1234!' },
    })
    expect([res.statusCode, details(res)]).toEqual([
      400,
      { reason: 'weak_password', problems: ['too_predictable'] },
    ])
    expect(res.json().message).toContain('is too easy to guess')
  })

  it('wrong passwords, codes and factor states', async () => {
    const { req } = await admin()
    const wrong = { reason: 'wrong_password' }
    expect(
      details(await req('/api/auth/password', { currentPassword: 'nope', newPassword: 'x-new-password-1' })),
    ).toEqual(wrong)
    expect(details(await req('/api/auth/totp/enroll', { password: 'nope' }))).toEqual(wrong)
    expect(details(await req('/api/auth/recovery-codes', { password: PASSWORD }))).toEqual({
      reason: 'two_factor_required',
    })
    expect(details(await req('/api/auth/totp/confirm', { code: '123456' }))).toEqual({
      reason: 'no_pending_enrollment',
    })
    expect(details(await req('/api/auth/totp/disable', { password: PASSWORD, code: '123456' }))).toEqual({
      reason: 'totp_not_enabled',
    })
    expect(details(await req('/api/auth/passkeys/options', { password: 'nope' }))).toEqual(wrong)
    expect(
      details(
        await req('/api/auth/passkeys', {
          name: 'k',
          response: { id: 'cred', type: 'public-key', response: {} },
        }),
      ),
    ).toEqual({
      reason: 'passkey_expired',
    })
    expect((await req('/api/auth/totp/enroll', { password: PASSWORD })).statusCode).toBe(200)
    expect(details(await req('/api/auth/totp/confirm', { code: '000000' }))).toEqual({
      reason: 'invalid_code',
    })
  })
})

describe('CSRF refusals', () => {
  it('name their reason so a client can refresh the token once', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const token = t.app.ctx.setup.ensureToken()
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: H,
      payload: { token, username: 'admin', password: PASSWORD },
    })
    const refused = await t.app.inject({
      method: 'POST',
      url: '/api/auth/totp/enroll',
      headers: { ...H, 'x-csrf-token': 'stale' },
      cookies: { mm_sid: sid(res)! },
      payload: { password: PASSWORD },
    })
    expect(refused.statusCode).toBe(403)
    expect(details(refused)).toEqual({ reason: 'csrf' })
  })
})
