import { afterEach, describe, expect, it } from 'vitest'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { LoginThrottle, ipThrottleKey } from '../src/auth/throttle'
import { assertSafeBind, resolveConfig } from '../src/config'
import { DB_FILE } from '../src/store/db'
import { totpCode } from '../src/auth/totp'

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

async function team(overrides = {}, headers: Record<string, string> = H) {
  const t = await make({ auth: true, ...overrides })
  const token = t.app.ctx.setup.ensureToken()
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers,
    payload: { token, username: 'admin', password: PASSWORD },
  })
  const session = { cookies: { mm_sid: sid(res)! }, csrf: res.json().csrfToken as string }
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { ...headers, 'x-csrf-token': session.csrf },
      cookies: session.cookies,
      ...(payload ? { payload } : {}),
    })
  return { t, session, call, adminId: res.json().user.id as string }
}

describe('fix: health exemption cannot bypass the host allow-list (critical)', () => {
  it('rejects a foreign Host even when the query string mentions /healthz', async () => {
    const { app } = await make()
    for (const url of ['/api/auth/me?x=/healthz', '/api/auth/me?/readyz', '/api/auth/status?y=/healthz']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: 'evil.example:4321' } })
      expect(res.statusCode, url).toBe(403)
    }
    expect(
      (await app.inject({ method: 'GET', url: '/healthz?probe=1', headers: { host: 'evil.example' } }))
        .statusCode,
    ).toBe(200)
  })
})

describe('fix: parallel login attempts cannot exceed the lockout', () => {
  it('locks after the free attempts even when 30 requests race', async () => {
    const { t } = await team()
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        t.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: H,
          payload: { username: 'admin', password: 'wrong-password-123' },
        }),
      ),
    )
    expect(results.filter((r) => r.statusCode === 401).length).toBeLessThanOrEqual(6)
    expect(results.filter((r) => r.statusCode === 429).length).toBeGreaterThanOrEqual(24)
  })

  it('a correct password is not counted as a failure', async () => {
    const { t } = await team()
    for (let i = 0; i < 8; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { username: 'admin', password: PASSWORD },
      })
      expect(res.statusCode).toBe(200)
    }
  })
})

describe('fix: throttle eviction never frees a locked user key', () => {
  it('keeps user:alice locked while thousands of other keys come and go', () => {
    const t = new LoginThrottle(() => 0, { maxKeys: 100 })
    for (let i = 0; i < 6; i++) t.recordFailure('user:alice')
    for (let i = 0; i < 1000; i++) t.recordFailure(`user:other${i}`)
    for (let i = 0; i < 1000; i++) for (let j = 0; j < 6; j++) t.recordFailure(`ip:10.0.${i >> 8}.${i & 255}`)
    expect(t.retryAfterMs('user:alice')).toBeGreaterThan(0)
  })

  it('groups IPv6 addresses by /64 and keeps IPv4 as is', () => {
    expect(ipThrottleKey('2001:db8:1:2:aaaa::1')).toBe(ipThrottleKey('2001:db8:1:2:ffff:ffff:ffff:ffff'))
    expect(ipThrottleKey('2001:db8:1:2::1')).not.toBe(ipThrottleKey('2001:db8:1:3::1'))
    expect(ipThrottleKey('::ffff:10.1.2.3')).toBe('ip:10.1.2.3')
    expect(ipThrottleKey('10.1.2.3')).toBe('ip:10.1.2.3')
  })
})

describe('fix: bind safety covers proxy publication (S1)', () => {
  it('refuses a no-auth instance that trusts a proxy or allows public host names', () => {
    expect(() => assertSafeBind(resolveConfig({ cli: { trustedProxies: ['127.0.0.1'] } }))).toThrow(
      /Refusing/,
    )
    expect(() => assertSafeBind(resolveConfig({ cli: { allowedHosts: ['mm.example.com'] } }))).toThrow(
      /Refusing/,
    )
    expect(() =>
      assertSafeBind(resolveConfig({ cli: { allowedHosts: ['localhost', '127.0.0.1', '[::1]'] } })),
    ).not.toThrow()
    expect(() =>
      assertSafeBind(resolveConfig({ cli: { trustedProxies: ['127.0.0.1'], auth: true } })),
    ).not.toThrow()
  })
})

describe('fix: cookies behind an HTTPS proxy', () => {
  const proxied = { remoteAddress: '10.0.0.1' }
  const httpsHeaders = {
    host: 'internal:4321',
    'x-forwarded-host': 'mm.example.com',
    'x-forwarded-proto': 'https',
    origin: 'https://mm.example.com',
  }

  it('issues __Host-mm_sid with Secure over HTTPS (Review Focus 1)', async () => {
    const t = await make({ auth: true, trustedProxies: ['10.0.0.1'], allowedHosts: ['mm.example.com'] })
    const token = t.app.ctx.setup.ensureToken()
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      ...proxied,
      headers: httpsHeaders,
      payload: { token, username: 'admin', password: PASSWORD },
    })
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toMatch(/^__Host-mm_sid=/)
    expect(cookie).toMatch(/; Secure/)
    expect(cookie).toMatch(/; HttpOnly/)
    expect(cookie).toMatch(/; SameSite=Strict/)
  })

  it('ignores a plain mm_sid cookie on HTTPS requests (cookie tossing)', async () => {
    const t = await make({ auth: true, trustedProxies: ['10.0.0.1'], allowedHosts: ['mm.example.com'] })
    const user = t.app.ctx.users.create({ username: 'attacker', passwordHash: 'x', role: 'viewer' })
    const { sessionId } = t.app.ctx.sessions.create(user.id, {})
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      ...proxied,
      headers: httpsHeaders,
      cookies: { mm_sid: sessionId },
    })
    expect(res.statusCode).toBe(401)
  })

  it('treats an explicit default port as the same origin', async () => {
    const t = await make({ auth: true, trustedProxies: ['10.0.0.1'], allowedHosts: ['mm.example.com'] })
    const user = t.app.ctx.users.create({ username: 'admin', passwordHash: 'x', role: 'admin' })
    const secure = t.app.ctx.sessions.create(user.id, {})
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      ...proxied,
      headers: {
        ...httpsHeaders,
        'x-forwarded-host': 'mm.example.com:443',
        'x-csrf-token': secure.session.csrfToken,
      },
      cookies: { '__Host-mm_sid': secure.sessionId },
    })
    expect(res.statusCode).toBe(204)
  })
})

describe('fix: password re-checks are throttled and required for new factors', () => {
  it('locks the recovery-code password check after repeated failures', async () => {
    const { t, call } = await team()
    const { secret } = (await call('POST', '/api/auth/totp/enroll', { password: PASSWORD })).json()
    expect(
      (await call('POST', '/api/auth/totp/confirm', { code: totpCode(secret, t.clock.now) })).statusCode,
    ).toBe(200)
    const statuses: number[] = []
    for (let i = 0; i < 8; i++)
      statuses.push(
        (await call('POST', '/api/auth/recovery-codes', { password: 'wrong-password-99' })).statusCode,
      )
    expect(statuses).toContain(429)
  })

  it('requires the current password to enroll an authenticator app or a passkey', async () => {
    const { call } = await team()
    expect((await call('POST', '/api/auth/totp/enroll')).statusCode).toBe(400)
    expect((await call('POST', '/api/auth/totp/enroll', { password: 'wrong-password-99' })).statusCode).toBe(
      400,
    )
    expect((await call('POST', '/api/auth/totp/enroll', { password: PASSWORD })).statusCode).toBe(200)
    expect((await call('POST', '/api/auth/passkeys/options')).statusCode).toBe(400)
    expect(
      (await call('POST', '/api/auth/passkeys/options', { password: 'wrong-password-99' })).statusCode,
    ).toBe(400)
    expect((await call('POST', '/api/auth/passkeys/options', { password: PASSWORD })).statusCode).toBe(200)
  })
})

describe('fix: admins cannot reset their own password without the current one', () => {
  it('rejects /users/:self/password', async () => {
    const { call, adminId } = await team()
    expect(
      (await call('POST', `/api/users/${adminId}/password`, { password: 'baska-parola-2026-yesil' }))
        .statusCode,
    ).toBe(409)
  })
})

describe('fix: audit records the account the login targeted', () => {
  it('logs the attempted username, not the caller, and the user id on success', async () => {
    const { t, call } = await team()
    t.app.ctx.users.create({ username: 'bob', passwordHash: 'x', role: 'viewer' })
    await call('POST', '/api/auth/login', { username: 'bob', password: 'wrong-password-99' })
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { username: 'admin', password: PASSWORD },
    })
    const logins = t.app.ctx.audit.list({ action: 'auth.login' })
    expect(logins[1]).toMatchObject({ username: 'bob', userId: null, outcome: 'denied' })
    expect(logins[0]).toMatchObject({
      username: 'admin',
      userId: t.app.ctx.users.findByUsername('admin')!.id,
      outcome: 'success',
    })
  })
})

describe('fix: database files are private on POSIX', () => {
  it.skipIf(process.platform === 'win32')(
    'creates the database with mode 0600 and the directory 0700',
    async () => {
      const t = await make()
      expect(statSync(join(t.dir, DB_FILE)).mode & 0o777).toBe(0o600)
      expect(statSync(t.dir).mode & 0o777).toBe(0o700)
    },
  )
})
