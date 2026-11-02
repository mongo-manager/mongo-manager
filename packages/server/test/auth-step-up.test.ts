import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { SoftAuthenticator } from './soft-authenticator'
import { totpCode } from '../src/auth/totp'

/**
 * Security review 2026-10-13 (L2): new recovery codes, a passkey added or removed, an authenticator
 * app enrolled took only the password — so someone holding a session and the password could give
 * themselves a lasting way past two-factor sign-in. Managing second factors now takes one of them,
 * proved in this session within the last ten minutes: at a two-factor sign-in, on adding one, or by
 * stepping up with a code or a passkey. Codes checked for it are throttled.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const PASSWORD = 'tarçın-kavanoz-42-mavi'
const ORIGIN = 'http://localhost:4321'
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
  let session = { cookies: { mm_sid: sid(res)! }, csrf: res.json().csrfToken as string }
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { ...H, 'x-csrf-token': session.csrf },
      cookies: session.cookies,
      ...(payload ? { payload } : {}),
    })
  const post = (url: string, payload: object) => t.app.inject({ method: 'POST', url, headers: H, payload })
  const use = (r: LightMyRequestResponse) => {
    session = { cookies: { mm_sid: sid(r)! }, csrf: r.json().csrfToken as string }
  }
  return { t, call, post, use }
}

async function withTotp(s: Awaited<ReturnType<typeof team>>) {
  const { secret } = (await s.call('POST', '/api/auth/totp/enroll', { password: PASSWORD })).json()
  expect(
    (await s.call('POST', '/api/auth/totp/confirm', { code: totpCode(secret, s.t.clock.now) })).statusCode,
  ).toBe(200)
  return secret as string
}

describe('managing second factors', () => {
  it('takes a second factor proved in this session lately, and a code checked for it is throttled', async () => {
    const s = await team()
    const secret = await withTotp(s)
    // Just enrolled: proved now.
    expect((await s.call('POST', '/api/auth/recovery-codes', { password: PASSWORD })).statusCode).toBe(200)
    s.t.clock.now += 11 * 60_000
    const stale = await s.call('POST', '/api/auth/recovery-codes', { password: PASSWORD })
    expect(stale.statusCode).toBe(403)
    expect(stale.json().details).toMatchObject({ reason: 'step_up_required', methods: ['totp', 'recovery'] })
    expect((await s.call('POST', '/api/auth/step-up', { code: '000000' })).statusCode).toBe(400)
    const ok = await s.call('POST', '/api/auth/step-up', { code: totpCode(secret, s.t.clock.now) })
    expect(ok.statusCode).toBe(204)
    expect((await s.call('POST', '/api/auth/recovery-codes', { password: PASSWORD })).statusCode).toBe(200)
    // Guessing codes is held back.
    s.t.clock.now += 60_000
    for (let i = 0; i < 6; i++) await s.call('POST', '/api/auth/step-up', { code: '111111' })
    expect((await s.call('POST', '/api/auth/step-up', { code: '222222' })).statusCode).toBe(429)
  })

  it('counts a two-factor sign-in as proved', async () => {
    const s = await team()
    const secret = await withTotp(s)
    s.t.clock.now += 11 * 60_000
    const step1 = (await s.post('/api/auth/login', { username: 'admin', password: PASSWORD })).json()
    s.t.clock.now += 31_000
    s.use(
      await s.post('/api/auth/login/totp', { ticket: step1.ticket, code: totpCode(secret, s.t.clock.now) }),
    )
    expect((await s.call('POST', '/api/auth/recovery-codes', { password: PASSWORD })).statusCode).toBe(200)
  })

  // Review of L2 (minor 9).
  it('takes a recovery code for a step-up once', async () => {
    const s = await team()
    await withTotp(s)
    const { recoveryCodes } = (
      await s.call('POST', '/api/auth/recovery-codes', { password: PASSWORD })
    ).json()
    s.t.clock.now += 11 * 60_000
    expect((await s.call('POST', '/api/auth/step-up', { code: recoveryCodes[0] })).statusCode).toBe(204)
    s.t.clock.now += 11 * 60_000
    expect((await s.call('POST', '/api/auth/step-up', { code: recoveryCodes[0] })).statusCode).toBe(400)
    expect((await s.call('POST', '/api/auth/step-up', { code: recoveryCodes[1] })).statusCode).toBe(204)
  })

  it('asks a passkey owner for it before an authenticator app is added', async () => {
    const s = await team()
    const device = new SoftAuthenticator(ORIGIN, 'localhost')
    const options = (await s.call('POST', '/api/auth/passkeys/options', { password: PASSWORD })).json()
    await s.call('POST', '/api/auth/passkeys', { name: 'Laptop', response: device.register(options) })
    s.t.clock.now += 11 * 60_000
    const res = await s.call('POST', '/api/auth/totp/enroll', { password: PASSWORD })
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'step_up_required', methods: ['passkey', 'recovery'] })
  })

  it('throttles the code that disables the authenticator app', async () => {
    const s = await team()
    await withTotp(s)
    for (let i = 0; i < 6; i++)
      await s.call('POST', '/api/auth/totp/disable', { password: PASSWORD, code: '123456' })
    expect(
      (await s.call('POST', '/api/auth/totp/disable', { password: PASSWORD, code: '654321' })).statusCode,
    ).toBe(429)
  })

  it('steps up with a passkey, and removes one only so', async () => {
    const s = await team()
    const device = new SoftAuthenticator(ORIGIN, 'localhost')
    const options = (await s.call('POST', '/api/auth/passkeys/options', { password: PASSWORD })).json()
    const { passkey } = (
      await s.call('POST', '/api/auth/passkeys', { name: 'Laptop', response: device.register(options) })
    ).json()
    s.t.clock.now += 11 * 60_000
    expect(
      (await s.call('DELETE', `/api/auth/passkeys/${passkey.id}`, { password: PASSWORD })).json().details,
    ).toMatchObject({ reason: 'step_up_required', methods: ['passkey', 'recovery'] })
    expect((await s.call('POST', '/api/auth/passkeys/options', { password: PASSWORD })).statusCode).toBe(403)
    const step = (await s.call('POST', '/api/auth/step-up/passkey/options', {})).json()
    const proved = await s.call('POST', '/api/auth/step-up/passkey', { response: device.authenticate(step) })
    expect(proved.statusCode).toBe(204)
    expect(
      (await s.call('DELETE', `/api/auth/passkeys/${passkey.id}`, { password: PASSWORD })).statusCode,
    ).toBe(204)
  })
})
