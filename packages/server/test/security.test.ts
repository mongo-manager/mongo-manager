// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { H, LOCAL_COOKIE_NAME, LOCAL_COOKIE_VALUE, makeApp, type TestApp } from './helpers'
import { requirePermission } from '../src/http/guards'

const apps: TestApp[] = []
async function make(...args: Parameters<typeof makeApp>) {
  const t = await makeApp(...args)
  t.app.get('/t/whoami', async (req) => ({
    kind: req.principal?.kind ?? null,
    username: req.principal?.username ?? null,
  }))
  t.app.post('/t/write', { preHandler: requirePermission('documents:write') }, async () => ({ ok: true }))
  t.app.post('/t/users', { preHandler: requirePermission('users:manage') }, async () => ({ ok: true }))
  t.app.post('/t/open', { config: { csrf: false } }, async () => ({ ok: true }))
  apps.push(t)
  return t
}
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('local mode principal and CSRF (S5)', () => {
  // Security audit 2026-10-16: the local owner is who holds a launch link's cookie, not every request.
  it('treats a browser with the launch cookie as the local owner, and nobody else', async () => {
    const { app } = await make()
    expect((await app.inject({ method: 'GET', url: '/t/whoami', headers: H })).json()).toEqual({
      kind: 'local',
      username: 'owner',
    })
    expect(
      (
        await app.inject({ method: 'GET', url: '/t/whoami', headers: { host: H.host, origin: H.origin } })
      ).json(),
    ).toEqual({ kind: null, username: null })
  })

  it('requires the CSRF token on mutating requests', async () => {
    const { app } = await make()
    const token = app.ctx.localCsrfToken
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/t/write', headers })
    expect((await post(H)).statusCode).toBe(403)
    expect((await post({ ...H, 'x-csrf-token': 'wrong' })).json().message).toMatch(/CSRF/)
    expect((await post({ ...H, 'x-csrf-token': token })).statusCode).toBe(200)
  })

  it('blocks cross-origin requests even with a valid token', async () => {
    const { app } = await make()
    const token = app.ctx.localCsrfToken
    for (const origin of [
      'http://evil.example',
      'http://localhost.evil.com',
      'null',
      'https://localhost:4321',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/t/write',
        headers: { ...H, origin, 'x-csrf-token': token },
      })
      expect(res.statusCode, origin).toBe(403)
      expect(res.json().message).toMatch(/Cross-origin/)
    }
    const noOriginCrossSite = await app.inject({
      method: 'POST',
      url: '/t/write',
      headers: { host: H.host, 'sec-fetch-site': 'cross-site', 'x-csrf-token': token },
    })
    expect(noOriginCrossSite.statusCode).toBe(403)
    const cli = await app.inject({
      method: 'POST',
      url: '/t/write',
      headers: { host: H.host, cookie: H.cookie, 'x-mm-local': H['x-mm-local'], 'x-csrf-token': token },
    })
    expect(cli.statusCode).toBe(200)
    // Security audit 2026-10-16: a token alone (another process that read it) is not enough.
    const tokenOnly = await app.inject({
      method: 'POST',
      url: '/t/write',
      headers: { host: H.host, 'x-csrf-token': token },
    })
    expect(tokenOnly.statusCode).toBe(401)
  })

  it('csrf:false routes skip the token but not the Origin check', async () => {
    const { app } = await make()
    expect((await app.inject({ method: 'POST', url: '/t/open', headers: H })).statusCode).toBe(200)
    expect(
      (await app.inject({ method: 'POST', url: '/t/open', headers: { ...H, origin: 'http://evil.example' } }))
        .statusCode,
    ).toBe(403)
  })

  it('uses forwarded host and protocol behind a trusted proxy (Review Focus 1)', async () => {
    const { app } = await make({ trustedProxies: ['10.0.0.1'], allowedHosts: ['mm.example.com'] })
    const res = await app.inject({
      method: 'POST',
      url: '/t/write',
      remoteAddress: '10.0.0.1',
      headers: {
        host: 'internal:4321',
        'x-forwarded-host': 'mm.example.com',
        'x-forwarded-proto': 'https',
        origin: 'https://mm.example.com',
        'x-csrf-token': app.ctx.localCsrfToken,
        // Over HTTPS the local cookie has the __Host- name (security audit 2026-10-16).
        cookie: `__Host-${LOCAL_COOKIE_NAME}=${LOCAL_COOKIE_VALUE}`,
        'x-mm-local': H['x-mm-local'],
      },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('team mode principal', () => {
  it('has no principal without a session and rejects guarded routes with 401', async () => {
    const { app } = await make({ auth: true })
    expect((await app.inject({ method: 'GET', url: '/t/whoami', headers: H })).json()).toEqual({
      kind: null,
      username: null,
    })
    const res = await app.inject({ method: 'POST', url: '/t/write', headers: H })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('UNAUTHENTICATED')
  })

  it('resolves a session cookie, and drops expired sessions and disabled users', async () => {
    const t = await make({ auth: true })
    const user = t.app.ctx.users.create({ username: 'alice', passwordHash: 'x', role: 'editor' })
    const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
    const cookies = { mm_sid: sessionId }
    expect((await t.app.inject({ method: 'GET', url: '/t/whoami', headers: H, cookies })).json()).toEqual({
      kind: 'user',
      username: 'alice',
    })
    const write = await t.app.inject({
      method: 'POST',
      url: '/t/write',
      headers: { ...H, 'x-csrf-token': session.csrfToken },
      cookies,
    })
    expect(write.statusCode).toBe(200)

    t.app.ctx.users.setDisabled(user.id, true)
    expect(
      (await t.app.inject({ method: 'GET', url: '/t/whoami', headers: H, cookies })).json().kind,
    ).toBeNull()
    t.app.ctx.users.setDisabled(user.id, false)
    expect(t.app.ctx.sessions.get(sessionId)).toBeUndefined()

    const second = t.app.ctx.sessions.create(user.id, {})
    t.clock.now += 31 * 60_000
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/t/whoami',
          headers: H,
          cookies: { mm_sid: second.sessionId },
        })
      ).json().kind,
    ).toBeNull()
  })
})

describe('permission guards (S12)', () => {
  async function asRole(role: 'admin' | 'editor' | 'viewer', overrides = {}) {
    const t = await make({ auth: true, ...overrides })
    const user = t.app.ctx.users.create({ username: `u-${role}`, passwordHash: 'x', role })
    const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
    const post = (url: string) =>
      t.app.inject({
        method: 'POST',
        url,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
      })
    return { post }
  }

  it('denies insufficient roles with 403 FORBIDDEN', async () => {
    const viewer = await asRole('viewer')
    const res = await viewer.post('/t/write')
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN')
    expect((await (await asRole('editor')).post('/t/users')).statusCode).toBe(403)
    expect((await (await asRole('admin')).post('/t/users')).statusCode).toBe(200)
  })

  it('reports READ_ONLY for data writes in read-only mode but keeps admin management', async () => {
    const admin = await asRole('admin', { readOnly: true })
    const res = await admin.post('/t/write')
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('READ_ONLY')
    expect((await admin.post('/t/users')).statusCode).toBe(200)
  })
})
