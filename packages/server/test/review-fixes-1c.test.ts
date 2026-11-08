// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import { ConnectionSettingsSchema, SECRET_MASK, type ConnectionSettings } from '@mongo-manager/shared'
import { ConnectionManager, type Tunnel } from '../src/connections/manager'
import { openSshTunnel } from '../src/connections/ssh'
import { H, makeApp, type TestApp } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'
import { startSshServer, type TestSshServer } from './support/ssh-server'

let mongo: TestMongo
let sshd: TestSshServer
beforeAll(async () => {
  mongo = await startMongo()
  sshd = await startSshServer({ password: 'tunnel-pass' })
})
afterAll(async () => {
  await sshd?.close()
  await mongo?.stop()
})

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const sshSettings = (): ConnectionSettings =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: '127.0.0.1', port: mongo.port }],
    serverSelectionTimeoutMS: 3_000,
    ssh: {
      enabled: true,
      host: '127.0.0.1',
      port: sshd.port,
      username: 'tunnel',
      method: 'password',
      password: 'tunnel-pass',
    },
  })

describe('fix: an SSH server disconnect never crashes the process (critical)', () => {
  it('closes the local listener and refuses new sockets without throwing', async () => {
    const tunnel = await openSshTunnel(sshSettings().ssh!, { host: '127.0.0.1', port: mongo.port })
    const closed = new Promise<void>((resolve) => tunnel.onClose(resolve))
    sshd.dropClients()
    await closed
    await new Promise<void>((resolve) => {
      const socket = net.connect(tunnel.localPort, '127.0.0.1')
      socket.on('error', () => resolve())
      socket.on('close', () => resolve())
    })
    await tunnel.close()
  })

  it('evicts the cached client so the next request reconnects', async () => {
    const manager = new ConnectionManager({
      load: () => ({ settings: sshSettings() }),
      openTunnel: openSshTunnel,
    })
    const first = await manager.getClient('c1')
    sshd.dropClients()
    await new Promise((r) => setTimeout(r, 300))
    const second = await manager.getClient('c1')
    expect(second).not.toBe(first)
    expect((await second.db('admin').command({ ping: 1 })).ok).toBe(1)
    await manager.closeAll()
  })
})

describe('fix: connection tests always finish (Review Focus 5)', () => {
  const hanging = () => new Promise<Tunnel>(() => undefined)

  it('gives up at the deadline even if a phase hangs', async () => {
    const manager = new ConnectionManager({ load: () => undefined, openTunnel: hanging, testTimeoutMs: 300 })
    const started = Date.now()
    const result = await manager.test(sshSettings())
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } })
  })

  it('limits concurrent tests', async () => {
    const manager = new ConnectionManager({
      load: () => undefined,
      openTunnel: hanging,
      testTimeoutMs: 500,
      maxConcurrentTests: 1,
    })
    const [a, b] = await Promise.all([manager.test(sshSettings()), manager.test(sshSettings())])
    expect([a, b].map((r) => (r.ok ? 'ok' : r.error.kind)).sort()).toEqual(['busy', 'timeout'])
  })

  it('passes a short SSH ready timeout to the tunnel during tests', async () => {
    const seen: Array<number | undefined> = []
    const manager = new ConnectionManager({
      load: () => undefined,
      openTunnel: async (_ssh, _target, opts) => {
        seen.push(opts?.readyTimeoutMs)
        throw new Error('stop')
      },
    })
    await manager.test(sshSettings())
    expect(seen[0]).toBeLessThanOrEqual(5_000)
  })
})

describe('fix: no tunnel leak when the driver rejects the options', () => {
  it('closes the tunnel and reports a config error', async () => {
    let closes = 0
    const fakeTunnel: Tunnel = {
      localPort: 1,
      credentials: { username: 'u', password: 'p' },
      fingerprint: 'SHA256:x',
      close: async () => void closes++,
      onClose: () => undefined,
    }
    const manager = new ConnectionManager({ load: () => undefined, openTunnel: async () => fakeTunnel })
    const settings = { ...sshSettings(), options: { maxPoolSize: 'abc' } }
    const result = await manager.test(settings)
    expect(result).toMatchObject({ ok: false, error: { kind: 'config' } })
    expect(closes).toBe(1)
  })
})

describe('fix: routes refuse to send stored secrets to a new target', () => {
  async function local() {
    const t = await makeApp()
    apps.push(t)
    const call = (method: 'POST' | 'PATCH', url: string, payload: object) =>
      t.app.inject({ method, url, headers: { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken }, payload })
    return { t, call }
  }

  it('rejects PATCH and test when the host changes but the password stays masked', async () => {
    const { call } = await local()
    const dto = (
      await call('POST', '/api/connections', {
        name: 'Prod',
        settings: {
          hosts: [{ host: 'db.internal', port: 27017 }],
          auth: { mechanism: 'DEFAULT', username: 'app', password: 'secret-pw' },
        },
      })
    ).json()
    const moved = {
      ...dto.settings,
      hosts: [{ host: 'attacker.example', port: 27017 }],
      auth: { ...dto.settings.auth, mechanism: 'PLAIN' },
    }
    const patch = await call('PATCH', `/api/connections/${dto.id}`, { settings: moved })
    expect(patch.statusCode).toBe(400)
    expect(patch.json().message).toMatch(/re-enter/i)
    const test = await call('POST', '/api/connections/test', { settings: moved, connectionId: dto.id })
    expect(test.statusCode).toBe(400)
    const retyped = { ...moved, auth: { ...moved.auth, password: 'typed-again' } }
    expect((await call('PATCH', `/api/connections/${dto.id}`, { settings: retyped })).statusCode).toBe(200)
    expect(dto.settings.auth.password).toBe(SECRET_MASK)
  })

  it('keeps a pinned SSH fingerprint when a stale form without it is saved', async () => {
    const { t, call } = await local()
    const dto = (
      await call('POST', '/api/connections', {
        name: 'Tunnel',
        settings: {
          hosts: [{ host: 'db', port: 27017 }],
          ssh: { enabled: true, host: 'bastion', username: 'u', method: 'password', password: 'sp' },
        },
      })
    ).json()
    t.app.ctx.connections.setSshFingerprint(
      dto.id,
      'SHA256:pinned',
      t.app.ctx.connections.get(dto.id)!.settings.ssh!,
    )
    await call('PATCH', `/api/connections/${dto.id}`, { name: 'Renamed', settings: dto.settings })
    expect(t.app.ctx.connections.get(dto.id)?.settings.ssh?.hostFingerprint).toBe('SHA256:pinned')
    const newHost = { ...dto.settings, ssh: { ...dto.settings.ssh, host: 'new-bastion', password: 'sp2' } }
    await call('PATCH', `/api/connections/${dto.id}`, { settings: newHost })
    expect(t.app.ctx.connections.get(dto.id)?.settings.ssh?.hostFingerprint).toBeUndefined()
  })
})
