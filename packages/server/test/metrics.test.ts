// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { resolveConfig } from '../src/config'
import { H, makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const TOKEN = 'm'.repeat(40)

async function app(overrides = {}) {
  const t = await makeApp(overrides)
  apps.push(t)
  return t
}

describe('optional /metrics (spec §3.5, Review Focus 2)', () => {
  it('does not exist unless a token is configured', async () => {
    const t = await app()
    expect((await t.app.inject({ method: 'GET', url: '/metrics', headers: H })).statusCode).toBe(404)
    expect(t.app.routeInventory.has('GET /metrics')).toBe(false)
  })

  it('refuses a token shorter than 32 characters', () => {
    expect(() => resolveConfig({ cli: { metricsToken: 'short' } })).toThrow(/metricsToken/)
    expect(() => resolveConfig({ env: { MM_METRICS_TOKEN: 'x'.repeat(31) } })).toThrow(/metricsToken/)
    expect(resolveConfig({ env: { MM_METRICS_TOKEN: TOKEN } }).metricsToken).toBe(TOKEN)
  })

  it('answers only with the bearer token, in Prometheus text, without any names', async () => {
    const t = await app({ metricsToken: TOKEN, auth: true })
    t.app.ctx.connections.create(
      {
        name: 'secret-customer-db',
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'db.secret.example' }] }),
      },
      null,
    )
    await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: H })
    for (const authorization of [undefined, 'Bearer wrong', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { ...H, ...(authorization ? { authorization } : {}) },
      })
      expect(res.statusCode, String(authorization)).toBe(401)
      expect(res.body).not.toContain('mm_')
    }
    const res = await t.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { ...H, authorization: `Bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/)
    expect(res.headers['cache-control']).toBe('no-store')
    for (const metric of [
      'mm_http_requests_total{class="2xx"}',
      'mm_mongo_clients_open',
      'mm_jobs_running{kind="index.create"}',
      'mm_jobs_running{kind="collection.duplicate"}',
      'process_resident_memory_bytes',
      'process_uptime_seconds',
    ])
      expect(res.body).toContain(metric)
    expect(res.body).not.toMatch(/secret|customer|example/)
    expect(res.body).toContain('# TYPE mm_live_syncs gauge')
    expect(res.body).toContain('mm_live_syncs{state="live"} 0')
    expect(res.body).toContain('mm_live_sync_lag_seconds 0')
    // Final review m3: a sum over the syncs that exist is a gauge (it drops when one is deleted).
    expect(res.body).toContain('# TYPE mm_live_sync_changes gauge')
    expect(res.body).toContain('mm_live_sync_changes 0')
    expect(res.body).toContain('# TYPE mm_ai_requests_total counter')
    expect(res.body).toContain('mm_ai_tokens_total{direction="input"} 0')
    expect(res.body).not.toContain('mm_index_builds_running')
    // Every answered request counts, not only the scrapes: one status call and four refusals so far.
    const count = (cls: string) =>
      Number(new RegExp(`mm_http_requests_total\\{class="${cls}"\\} (\\d+)`).exec(res.body)![1])
    expect(count('2xx')).toBeGreaterThanOrEqual(1)
    expect(count('4xx')).toBeGreaterThanOrEqual(4)
  })

  it('answers only on an allowed Host, unlike /healthz (final review 1g-3, Minor 6)', async () => {
    const t = await app({ metricsToken: TOKEN, allowedHosts: ['mm.example'] })
    const scrape = (host: string) =>
      t.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { ...H, host, authorization: `Bearer ${TOKEN}` },
      })
    expect((await scrape('mm.example')).statusCode).toBe(200)
    expect((await scrape('10.0.0.5:3000')).statusCode).toBe(403)
  })

  it('reads the Bearer scheme in any case, as RFC 7235 says (final review 1g-3, Minor 4)', async () => {
    const t = await app({ metricsToken: TOKEN })
    for (const authorization of [`bearer ${TOKEN}`, `BEARER  ${TOKEN}`, `Bearer ${TOKEN} `]) {
      const res = await t.app.inject({ method: 'GET', url: '/metrics', headers: { ...H, authorization } })
      expect(res.statusCode, authorization).toBe(200)
    }
    for (const authorization of [`Bearer${TOKEN}`, `Bearer ${TOKEN} x`, `xBearer ${TOKEN}`]) {
      const res = await t.app.inject({ method: 'GET', url: '/metrics', headers: { ...H, authorization } })
      expect(res.statusCode, authorization).toBe(401)
    }
  })
})
