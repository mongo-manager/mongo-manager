import { afterEach, describe, expect, it } from 'vitest'
import { H as BROWSER, makeApp, type TestApp } from './helpers'
import { RATE_LIMIT_API } from '../src/http/app'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
/** No Origin (GETs need none); local mode's cookie and page key (security audit 2026-10-16). */
const H = { host: 'localhost:4321', cookie: BROWSER.cookie, 'x-mm-local': BROWSER['x-mm-local'] }

describe('rate limit buckets (Review Focus 5)', () => {
  it('web requests never use up the API budget, and the API budget stays at 600', async () => {
    const t = await makeApp()
    apps.push(t)
    const get = (url: string) => t.app.inject({ method: 'GET', url, headers: H })
    for (let i = 0; i < RATE_LIMIT_API + 50; i++) expect((await get('/healthz')).statusCode).toBe(200)
    for (let i = 0; i < RATE_LIMIT_API; i++) expect((await get('/api/auth/status')).statusCode).toBe(200)
    expect((await get('/api/auth/status')).statusCode).toBe(429)
    expect((await get('/healthz')).statusCode).toBe(200)
  })

  it('treats a base path prefix the same way', async () => {
    const t = await makeApp({ basePath: '/mm/' })
    apps.push(t)
    for (let i = 0; i < RATE_LIMIT_API; i++) {
      expect((await t.app.inject({ method: 'GET', url: '/mm/healthz', headers: H })).statusCode).toBe(200)
    }
    expect((await t.app.inject({ method: 'GET', url: '/mm/api/auth/status', headers: H })).statusCode).toBe(
      200,
    )
  })
})

describe('rate limit classification', () => {
  it('counts a percent-encoded API path against the API budget (Review Important 3)', async () => {
    const t = await makeApp()
    apps.push(t)
    const encoded = await t.app.inject({ method: 'GET', url: '/%61pi/auth/status', headers: H })
    expect(encoded.statusCode).toBe(200)
    expect(encoded.headers['x-ratelimit-limit']).toBe(String(RATE_LIMIT_API))
    for (let i = 0; i < RATE_LIMIT_API - 1; i++) {
      await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: H })
    }
    expect((await t.app.inject({ method: 'GET', url: '/%61pi/auth/status', headers: H })).statusCode).toBe(
      429,
    )
  })
})
