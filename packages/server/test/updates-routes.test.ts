// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import type { PartialConfig } from '../src/config'
import { UpdateService } from '../src/updates/service'
import { H, makeApp, type TestApp } from './helpers'
import { fakeGithub, signedRelease, testKey } from './support/updates'

const key = testKey()
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

/** Team mode, the updater pointed at a fake GitHub with a test key; `as(role)` calls as such a user. */
async function harness(overrides: PartialConfig = {}) {
  const t = await makeApp({ auth: true, ...overrides })
  apps.push(t)
  const { ctx } = t.app
  const github = fakeGithub(signedRelease(key, '9.0.0').answers)
  const restarts: number[] = []
  ctx.updates.stop()
  ctx.updates = new UpdateService({
    ...ctx.updates.deps,
    egress: github.egress,
    keys: [key.pub],
    origin: {
      distribution: 'bundle',
      bundledVersion: '1.0.0',
      installDir: '/opt/x/dist',
      target: null,
      isolate: false,
    },
    restart: () => restarts.push(1),
    restartDelayMs: 0,
  })
  const as = (role: 'admin' | 'viewer', opts: { csrf?: boolean } = {}) => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const headers = { ...H, ...(opts.csrf === false ? {} : { 'x-csrf-token': session.csrfToken }) }
    return (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
      t.app.inject({ method, url, headers, cookies: { mm_sid: sessionId }, ...(payload ? { payload } : {}) })
  }
  return { t, ctx, as, github, restarts }
}

describe('the update routes', () => {
  it('shows a viewer the installed version only, and refuses them every write', async () => {
    const { as } = await harness()
    const viewer = as('viewer')
    const status = (await viewer('GET', '/api/updates')).json()
    expect(status).toMatchObject({ latest: null, offer: null, lastCheck: null, auto: false })
    expect(typeof status.installed).toBe('string')
    expect((await viewer('POST', '/api/updates/check')).statusCode).toBe(403)
    expect((await viewer('PUT', '/api/updates/settings', { auto: true })).statusCode).toBe(403)
    expect((await viewer('POST', '/api/updates/install', { version: '9.0.0' })).statusCode).toBe(403)
  })

  it('lets an administrator check, turn the daily check on and install — each write audited', async () => {
    const { as, ctx, restarts } = await harness()
    const admin = as('admin')
    const checked = await admin('POST', '/api/updates/check')
    expect(checked.statusCode).toBe(200)
    expect(checked.json()).toMatchObject({ offer: 'install', latest: { version: '9.0.0' } })
    expect((await admin('PUT', '/api/updates/settings', { auto: true })).json()).toMatchObject({ auto: true })
    const installing = await admin('POST', '/api/updates/install', { version: '9.0.0' })
    expect(installing.statusCode).toBe(202)
    await ctx.updates.installing
    expect(restarts).toHaveLength(1)
    expect(ctx.audit.list({ action: 'updates.check' })).toHaveLength(1)
    expect(ctx.audit.list({ action: 'updates.settings' })[0]).toMatchObject({ details: { auto: true } })
    expect(ctx.audit.list({ action: 'updates.install' })[0]).toMatchObject({ details: { to: '9.0.0' } })
  })

  it('refuses a write without the page’s CSRF token, and an odd body', async () => {
    const { as } = await harness()
    expect((await as('admin', { csrf: false })('POST', '/api/updates/check')).statusCode).toBe(403)
    const admin = as('admin')
    expect((await admin('PUT', '/api/updates/settings', { auto: 'yes' })).statusCode).toBe(400)
    expect((await admin('POST', '/api/updates/install', { version: '9.0', extra: 1 })).statusCode).toBe(400)
  })

  it('says the jobs that would stop, and installs once confirmed', async () => {
    const { as, ctx } = await harness()
    const admin = as('admin')
    await admin('POST', '/api/updates/check')
    ctx.updates.deps.runningJobs = () => 2
    const asked = await admin('POST', '/api/updates/install', { version: '9.0.0' })
    expect(asked.statusCode).toBe(409)
    expect(asked.json()).toMatchObject({ details: { reason: 'update_jobs', jobs: 2 } })
    expect(
      (await admin('POST', '/api/updates/install', { version: '9.0.0', confirmJobs: true })).statusCode,
    ).toBe(202)
    await ctx.updates.installing
  })

  it('MM_UPDATES=off: the status says so, every write is refused, nothing reaches GitHub', async () => {
    const { as, ctx, github } = await harness({ updates: { enabled: false } })
    ctx.updates = new UpdateService({ ...ctx.updates.deps, enabled: false })
    const admin = as('admin')
    expect((await admin('GET', '/api/updates')).json()).toMatchObject({ disabled: true })
    for (const [method, url, body] of [
      ['POST', '/api/updates/check', undefined],
      ['PUT', '/api/updates/settings', { auto: true }],
      ['POST', '/api/updates/install', { version: '9.0.0' }],
    ] as const) {
      const r = await admin(method, url, body)
      expect(r.statusCode, url).toBe(403)
      expect(r.json()).toMatchObject({ details: { reason: 'updates_off' } })
    }
    expect(github.asked).toHaveLength(0)
  })
})
