// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const PASSWORD = 'tarçın-kavanoz-42-mavi'
const proxied = { remoteAddress: '10.0.0.1' }
const https = {
  host: 'internal:4321',
  'x-forwarded-host': 'mm.example.com',
  'x-forwarded-proto': 'https',
  origin: 'https://mm.example.com',
}
const http = { host: 'localhost:4321', origin: 'http://localhost:4321' }

async function setup(basePath: string, overHttps: boolean) {
  const t = await makeApp({
    auth: true,
    basePath,
    ...(overHttps ? { trustedProxies: ['10.0.0.1'], allowedHosts: ['mm.example.com'] } : {}),
  })
  apps.push(t)
  const token = t.app.ctx.setup.ensureToken()
  const res = await t.app.inject({
    method: 'POST',
    url: `${basePath}api/auth/setup`,
    ...(overHttps ? proxied : {}),
    headers: overHttps ? https : http,
    payload: { token, username: 'admin', password: PASSWORD },
  })
  expect(res.statusCode).toBe(200)
  return { t, res, cookie: String(res.headers['set-cookie']), csrf: res.json().csrfToken as string }
}

describe('session cookie scope (Review Focus 5)', () => {
  it('keeps __Host-mm_sid at the root over HTTPS', async () => {
    const { cookie } = await setup('/', true)
    expect(cookie).toMatch(/^__Host-mm_sid=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict$/)
  })

  it('scopes a plain cookie to the base path over HTTP', async () => {
    const { cookie } = await setup('/mm/', false)
    expect(cookie).toMatch(/^mm_sid=[^;]+; Path=\/mm\/; HttpOnly; SameSite=Strict$/)
  })

  it('uses __Secure-mm_sid with the base path over HTTPS, and only that name counts', async () => {
    const { t, res, cookie } = await setup('/mm/', true)
    expect(cookie).toMatch(/^__Secure-mm_sid=[^;]+; Path=\/mm\/; HttpOnly; Secure; SameSite=Strict$/)
    const value = res.cookies.find((c) => c.name === '__Secure-mm_sid')!.value
    const me = (cookies: Record<string, string>) =>
      t.app.inject({ method: 'GET', url: '/mm/api/auth/me', ...proxied, headers: https, cookies })
    expect((await me({ '__Secure-mm_sid': value })).statusCode).toBe(200)
    expect((await me({ '__Host-mm_sid': value })).statusCode).toBe(401)
    expect((await me({ mm_sid: value })).statusCode).toBe(401)
  })

  it('clears the cookie on its own path when signing out', async () => {
    const { t, res, csrf } = await setup('/mm/', false)
    const value = res.cookies.find((c) => c.name === 'mm_sid')!.value
    const out = await t.app.inject({
      method: 'POST',
      url: '/mm/api/auth/logout',
      headers: { ...http, 'x-csrf-token': csrf },
      cookies: { mm_sid: value },
    })
    expect(out.statusCode).toBeLessThan(300)
    const cleared = ([] as string[]).concat(out.headers['set-cookie'] as string | string[])
    expect(
      cleared.some((c) => /^mm_sid=; Max-Age=0; Path=\/mm\/;/.test(c) || /^mm_sid=;.*Path=\/mm\//.test(c)),
    ).toBe(true)
  })
})
