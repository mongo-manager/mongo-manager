// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { ConnectionManager, type Tunnel } from '../src/connections/manager'
import { resolveConfig } from '../src/config'
import { startServer } from '../src/server'
import { H, makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function local() {
  const t = await makeApp()
  apps.push(t)
  const call = (method: 'POST' | 'PATCH', url: string, payload: object) =>
    t.app.inject({ method, url, headers: { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken }, payload })
  return { t, call }
}

describe('minor fixes (phase 1c)', () => {
  it('answers 404, not 500, when the connection disappears during a PATCH', async () => {
    const { t, call } = await local()
    const dto = (
      await call('POST', '/api/connections', { name: 'X', settings: { hosts: [{ host: 'h' }] } })
    ).json()
    t.app.ctx.connections.update = () => undefined
    const res = await call('PATCH', `/api/connections/${dto.id}`, { name: 'Y' })
    expect(res.statusCode).toBe(404)
  })

  it('records the target hosts when testing unsaved settings', async () => {
    const { t, call } = await local()
    await call('POST', '/api/connections/test', {
      settings: { hosts: [{ host: '127.0.0.1', port: 1 }], serverSelectionTimeoutMS: 500 },
    })
    const [entry] = t.app.ctx.audit.list({ action: 'connections.test' })
    expect(entry?.details).toMatchObject({ hosts: ['127.0.0.1:1'] })
  })

  it('caps the shutdown drain even when a connection is still opening', async () => {
    const hanging = () => new Promise<Tunnel>(() => undefined)
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'db' }],
      ssh: { enabled: true, host: 's', username: 'u', method: 'password', password: 'p' },
    })
    const manager = new ConnectionManager({ load: () => ({ settings }), openTunnel: hanging })
    void manager.getClient('c1').catch(() => undefined)
    const started = Date.now()
    await manager.closeAll(200)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  /** Why a start was refused; a server that started after all is closed again, and says ''. */
  const refusalOf = (cfg: ReturnType<typeof resolveConfig>) =>
    startServer(cfg).then(
      async (server) => {
        await server.close()
        return ''
      },
      (e: Error) => e.message,
    )

  it('says why a --uri holding timeoutMS cannot be used, without calling the string invalid', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mm-seed3-'))
    dirs.push(dataDir)
    const cfg = resolveConfig({
      cli: { dataDir, webPort: 0, uri: 'mongodb://app:s3cret@db.example:27017/?timeoutMS=5000' },
    })
    const message = await refusalOf(cfg)
    expect(message).toBe(
      '--uri cannot be used: timeoutMS is not supported: the app bounds each operation itself; remove it from the connection string',
    )
    expect(message).not.toContain('s3cret')
  })

  it('says in one line which setting of a --uri is refused', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mm-seed4-'))
    dirs.push(dataDir)
    const cfg = resolveConfig({
      cli: {
        dataDir,
        webPort: 0,
        uri: `mongodb://db.example:27017/?appName=${'x'.repeat(200)}&connectTimeoutMS=10`,
      },
    })
    const message = await refusalOf(cfg)
    expect(message).toMatch(/^--uri cannot be used: appName: .+; connectTimeoutMS: /)
    expect(message).not.toContain('\n')
    expect(message).not.toContain('"code"')
  })

  it('does not re-create the --uri connection after the user deleted it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mm-seed2-'))
    dirs.push(dataDir)
    const cfg = resolveConfig({ cli: { dataDir, webPort: 0, uri: 'mongodb://db.example:27017/' } })
    const first = await startServer(cfg)
    for (const c of first.app.ctx.connections.list()) first.app.ctx.connections.delete(c.id)
    await first.close()
    const second = await startServer(cfg)
    expect(second.app.ctx.connections.count()).toBe(0)
    await second.close()
  })
})
