import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginAdminView } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { helloPlugin, manifestOf } from './support/tar'

// Review 2026-10-11 (minor 3): a scan that fails says nothing was found — so an unscanned plugin
// asks for its id like one with a high finding, and a scanner bug breaks no plugin.
vi.mock('../src/plugins/scan', () => ({
  scanPlugin: () => {
    throw new Error('scanner bug')
  },
}))

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function admin(overrides: Record<string, unknown> = {}) {
  const t = await makeApp({ auth: true, ...overrides })
  apps.push(t)
  const user = t.app.ctx.users.create({ username: 'boss', passwordHash: 'x', role: 'admin' })
  const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
  const headers = { ...H, 'x-csrf-token': session.csrfToken }
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer, type?: string) =>
    t.app.inject({
      method,
      url: `/api/${url}`,
      headers: type ? { ...headers, 'content-type': type } : headers,
      cookies: { mm_sid: sessionId },
      ...(payload ? { payload } : {}),
    })
  const one = async (id: string) =>
    ((await call('GET', 'plugins/manage')).json() as { plugins: PluginAdminView[] }).plugins.find(
      (p) => p.id === id,
    )!
  return { call, one }
}

describe('a plugin whose scan failed', () => {
  it('is not broken, has no scan, and is approved only with its id typed', async () => {
    const { call, one } = await admin()
    expect((await call('PUT', 'plugins', helloPlugin(), 'application/gzip')).statusCode).toBe(201)
    const view = await one('hello')
    expect(view).toMatchObject({ error: null, scan: null })
    const bare = await call('POST', 'plugins/hello/approve', { digest: view.digest })
    expect(bare.statusCode).toBe(409)
    expect(bare.json().details).toMatchObject({ reason: 'risk_not_accepted' })
    const typed = await call('POST', 'plugins/hello/approve', { digest: view.digest, acceptRisk: 'hello' })
    expect(typed.statusCode).toBe(200)
  })

  it('leaves a plugin shipped with the app approvable as it is', async () => {
    const bundled = mkdtempSync(join(tmpdir(), 'mm-bundled-scanfail-'))
    mkdirSync(join(bundled, 'hello'), { recursive: true })
    writeFileSync(join(bundled, 'hello', 'mongo-manager-plugin.json'), manifestOf({}))
    writeFileSync(join(bundled, 'hello', 'index.html'), 'x')
    const { call, one } = await admin({ bundledPluginsDir: bundled })
    const view = await one('hello')
    expect(view).toMatchObject({ error: null, scan: null })
    expect((await call('POST', 'plugins/hello/approve', { digest: view.digest })).statusCode).toBe(200)
    rmSync(bundled, { recursive: true, force: true })
  })
})
