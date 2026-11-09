// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { Errors } from '../src/errors'
import { H, makeApp, type TestApp } from './helpers'
import { resolveConfig, startupWarnings } from '../src/config'

const apps: TestApp[] = []
async function make(...args: Parameters<typeof makeApp>) {
  const t = await makeApp(...args)
  apps.push(t)
  return t
}
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('buildApp basics', () => {
  it('serves health endpoints with strict security headers', async () => {
    const { app } = await make()
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: H })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    const csp = res.headers['content-security-policy'] as string
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      // 'self' (not 'none'): the SPA's <base href> must apply, or deep links and basePath break.
      "base-uri 'self'",
      // A GridFS preview plays a sound or a video the app read itself (a blob of its own).
      "media-src 'self' blob:",
    ]) {
      expect(csp).toContain(directive)
    }
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect((await app.inject({ method: 'GET', url: '/readyz', headers: H })).json()).toEqual({
      status: 'ready',
    })
  })

  // Security review 2026-10-13 (ops): API answers (documents, users, settings) had no cache policy —
  // a shared computer's browser cache, or a proxy, could keep them.
  it('tells browsers and proxies to keep no API answer', async () => {
    const { app } = await make({ auth: true })
    for (const url of ['/api/auth/status', '/api/connections', '/api/nope']) {
      const res = await app.inject({ method: 'GET', url, headers: H })
      expect(res.headers['cache-control'], url).toBe('no-store')
    }
    // The app's own files keep their caching.
    expect(
      (await app.inject({ method: 'GET', url: '/healthz', headers: H })).headers['cache-control'],
    ).not.toBe('no-store')
  })

  // Security review 2026-10-13 (web, low): a plugin's frame could navigate itself, carrying what it
  // read in the address. Frames of the app show plugin frames only — never another site, never
  // another address of the app.
  it('lets the app frame plugin pages only', async () => {
    const { app } = await make()
    const csp = (await app.inject({ method: 'GET', url: '/healthz', headers: H })).headers[
      'content-security-policy'
    ] as string
    expect(csp).toContain(`frame-src http://${H.host}/plugin-frame/`)
    const based = await make({ basePath: '/mm/' })
    const scoped = (await based.app.inject({ method: 'GET', url: '/mm/healthz', headers: H })).headers[
      'content-security-policy'
    ] as string
    expect(scoped).toContain(`frame-src http://${H.host}/mm/plugin-frame/`)
    // A Host shaped to add to the policy names no frame at all.
    const injected = (
      await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { ...H, host: 'evil.example; script-src *' },
      })
    ).headers['content-security-policy'] as string
    expect(injected).toContain("frame-src 'none'")
    expect(injected).not.toContain('script-src *')
    // Behind a trusted proxy, the address the browser used.
    const proxied = await make({ trustedProxies: ['10.0.0.2'] })
    const forwarded = (
      await proxied.app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { ...H, 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https' },
        remoteAddress: '10.0.0.2',
      })
    ).headers['content-security-policy'] as string
    expect(forwarded).toContain('frame-src https://public.example/plugin-frame/')
  })

  it('returns ApiErrorBody for unknown routes', async () => {
    const { app } = await make()
    const res = await app.inject({ method: 'GET', url: '/nope', headers: H })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', correlationId: expect.any(String) })
  })

  it('maps AppError, oversized bodies, malformed JSON and unexpected errors (S13, §4.9)', async () => {
    const { app } = await make()
    app.post('/t/echo', { config: { csrf: false } }, async (req) => req.body)
    app.get('/t/app-error', async () => {
      throw Errors.conflict('Already there')
    })
    app.get('/t/crash', async () => {
      throw new Error('SELECT * FROM secret_table')
    })

    const big = await app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { ...H, 'content-type': 'application/json' },
      payload: JSON.stringify({ x: 'a'.repeat(1024 * 1024 + 10) }),
    })
    expect(big.statusCode).toBe(413)
    expect(big.json().code).toBe('PAYLOAD_TOO_LARGE')

    const bad = await app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { ...H, 'content-type': 'application/json' },
      payload: '{ nope',
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('VALIDATION_ERROR')

    const conflict = await app.inject({ method: 'GET', url: '/t/app-error', headers: H })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ code: 'CONFLICT', message: 'Already there' })

    const crash = await app.inject({ method: 'GET', url: '/t/crash', headers: H })
    expect(crash.statusCode).toBe(500)
    expect(crash.json()).toEqual({
      code: 'INTERNAL',
      message: 'Internal server error',
      correlationId: expect.any(String),
    })
    expect(crash.body).not.toContain('secret_table')
  })
})

describe('proxy trust (S2)', () => {
  it('ignores X-Forwarded-For unless the peer is a trusted proxy', async () => {
    const plain = await make()
    plain.app.get('/t/ip', async (req) => ({ ip: req.ip, protocol: req.protocol }))
    const spoof = { ...H, 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' }
    expect(
      (
        await plain.app.inject({ method: 'GET', url: '/t/ip', headers: spoof, remoteAddress: '10.1.1.1' })
      ).json(),
    ).toEqual({
      ip: '10.1.1.1',
      protocol: 'http',
    })

    const proxied = await make({ trustedProxies: ['10.1.1.1'] })
    proxied.app.get('/t/ip', async (req) => ({ ip: req.ip, protocol: req.protocol }))
    expect(
      (
        await proxied.app.inject({ method: 'GET', url: '/t/ip', headers: spoof, remoteAddress: '10.1.1.1' })
      ).json(),
    ).toEqual({ ip: '6.6.6.6', protocol: 'https' })
    expect(
      (
        await proxied.app.inject({ method: 'GET', url: '/t/ip', headers: spoof, remoteAddress: '10.9.9.9' })
      ).json(),
    ).toEqual({ ip: '10.9.9.9', protocol: 'http' })
  })
})

describe('host allow-list (S20 DNS rebinding)', () => {
  it('accepts only loopback names when bound to loopback', async () => {
    const { app } = await make()
    app.get('/t/ok', async () => ({ ok: true }))
    for (const host of ['localhost:4321', '127.0.0.1:4321', '[::1]:4321', 'LOCALHOST:4321']) {
      expect((await app.inject({ method: 'GET', url: '/t/ok', headers: { host } })).statusCode, host).toBe(
        200,
      )
    }
    const evil = await app.inject({ method: 'GET', url: '/t/ok', headers: { host: 'evil.example:4321' } })
    expect(evil.statusCode).toBe(403)
    expect(evil.json().code).toBe('FORBIDDEN')
    expect(
      (await app.inject({ method: 'GET', url: '/healthz', headers: { host: 'evil.example' } })).statusCode,
    ).toBe(200)
  })

  it('uses the configured list when set, and no list for non-loopback binds', async () => {
    const listed = await make({ allowedHosts: ['mm.example.com'] })
    listed.app.get('/t/ok', async () => ({ ok: true }))
    expect(
      (await listed.app.inject({ method: 'GET', url: '/t/ok', headers: { host: 'mm.example.com' } }))
        .statusCode,
    ).toBe(200)
    expect(
      (await listed.app.inject({ method: 'GET', url: '/t/ok', headers: { host: 'localhost:4321' } }))
        .statusCode,
    ).toBe(403)

    const open = await make({ host: '0.0.0.0', auth: true })
    open.app.get('/t/ok', async () => ({ ok: true }))
    expect(
      (await open.app.inject({ method: 'GET', url: '/t/ok', headers: { host: '192.168.1.20:4321' } }))
        .statusCode,
    ).toBe(200)
  })

  // Security audit 2026-10-16: a network bind without --allowed-hosts took any Host, so a page on a
  // rebinding name (evil.example resolving to this server) was same-origin with the app — and passkeys
  // took that name as their relying party. Without a list, only addresses and loopback names are
  // taken: rebinding needs a name, and the documented setups (Docker on the host loopback, a LAN
  // address) keep working.
  it('takes addresses and loopback names, never another name, on a network bind without a list', async () => {
    for (const auth of [true, false]) {
      const open = await make({ host: '0.0.0.0', auth, ...(auth ? {} : { unsafeNoAuth: true }) })
      open.app.get('/t/ok', async () => ({ ok: true }))
      const status = async (host: string) =>
        (await open.app.inject({ method: 'GET', url: '/t/ok', headers: { host } })).statusCode
      for (const host of ['localhost:4321', '127.0.0.1:4321', '[::1]:4321', '10.0.0.7', '[fe80::1]:4321'])
        expect(await status(host), host).toBe(200)
      for (const host of ['evil.example', 'evil.example:4321', 'mm.example.com', '10.0.0.7.evil.example'])
        expect(await status(host), host).toBe(403)
      const refused = await open.app.inject({
        method: 'GET',
        url: '/t/ok',
        headers: { host: 'evil.example' },
      })
      expect(refused.json().details).toEqual({ reason: 'host_not_allowed' })
      // Health checks stay reachable by any name (a load balancer's).
      expect(
        (await open.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'evil.example' } }))
          .statusCode,
      ).toBe(200)
    }
  })

  it('says at start-up which names a network bind without a list takes', () => {
    const config = resolveConfig({ cli: { host: '0.0.0.0', auth: true, dataDir: '/x' } })
    expect(startupWarnings(config).join('\n')).toMatch(/--allowed-hosts/)
    const listed = resolveConfig({
      cli: { host: '0.0.0.0', auth: true, dataDir: '/x', allowedHosts: ['mm.example.com'] },
    })
    expect(startupWarnings(listed).join('\n')).not.toMatch(/only addresses/)
  })
})

describe('basePath', () => {
  it('mounts routes under the base path', async () => {
    const { app } = await make({ basePath: '/mm/' })
    expect((await app.inject({ method: 'GET', url: '/mm/healthz', headers: H })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/healthz', headers: H })).statusCode).toBe(404)
  })
})
