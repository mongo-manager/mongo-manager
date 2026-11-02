import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema, type ConnectionSettings } from '@mongo-manager/shared'
import { ConnectionManager } from '../src/connections/manager'
import { startMongo, type TestMongo } from './support/mongo'

let mongo: TestMongo
let secured: TestMongo
beforeAll(async () => {
  ;[mongo, secured] = await Promise.all([
    startMongo(),
    startMongo({ auth: { user: 'root', password: 'root-pass' } }),
  ])
})
afterAll(async () => {
  await Promise.all([mongo?.stop(), secured?.stop()])
})

const at = (port: number, extra: object = {}): ConnectionSettings =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: '127.0.0.1', port }],
    serverSelectionTimeoutMS: 2_000,
    ...extra,
  })

describe('ConnectionManager.getClient', () => {
  it('shares one client between concurrent callers', async () => {
    const manager = new ConnectionManager({ load: () => ({ settings: at(mongo.port) }) })
    const clients = await Promise.all(Array.from({ length: 5 }, () => manager.getClient('c1')))
    expect(new Set(clients).size).toBe(1)
    expect((await clients[0]!.db('admin').command({ ping: 1 })).ok).toBe(1)
    await manager.closeAll()
  })

  it('closes idle clients and reconnects on demand', async () => {
    const manager = new ConnectionManager({ load: () => ({ settings: at(mongo.port) }), idleMs: 50 })
    const first = await manager.getClient('c1')
    await new Promise((r) => setTimeout(r, 150))
    const second = await manager.getClient('c1')
    expect(second).not.toBe(first)
    await manager.closeAll()
  })

  it('never closes a client while it is held by a running operation (long index builds)', async () => {
    const manager = new ConnectionManager({ load: () => ({ settings: at(mongo.port) }), idleMs: 50 })
    const first = await manager.getClient('c1')
    const release = manager.hold('c1')
    const second = manager.hold('c1')
    await new Promise((r) => setTimeout(r, 150))
    expect(await manager.getClient('c1')).toBe(first)
    release()
    release() // releasing twice counts once
    await new Promise((r) => setTimeout(r, 150))
    expect(await manager.getClient('c1')).toBe(first)
    second()
    await new Promise((r) => setTimeout(r, 150))
    expect(await manager.getClient('c1')).not.toBe(first)
    await manager.closeAll()
  })

  it('drops the cached client on invalidate and does not cache failures', async () => {
    let port = 1
    const manager = new ConnectionManager({
      load: (id) => (id === 'c1' ? { settings: at(port) } : undefined),
    })
    await expect(manager.getClient('c1')).rejects.toThrow()
    port = mongo.port
    const ok = await manager.getClient('c1')
    await manager.invalidate('c1')
    expect(await manager.getClient('c1')).not.toBe(ok)
    await expect(manager.getClient('missing')).rejects.toThrow(/not found/)
    await manager.closeAll()
  })
})

describe('ConnectionManager.test (Review Focus 5)', () => {
  const manager = new ConnectionManager({ load: () => undefined })

  it('reports version, topology and latency', async () => {
    const result = await manager.test(at(mongo.port))
    expect(result).toMatchObject({
      ok: true,
      topology: 'standalone',
      serverVersion: expect.stringMatching(/^\d+\.\d+/),
    })
    if (result.ok) expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('classifies an unreachable port quickly', async () => {
    const started = Date.now()
    const result = await manager.test(at(1, { serverSelectionTimeoutMS: 30_000 }))
    expect(Date.now() - started).toBeLessThan(6_500)
    expect(result).toMatchObject({ ok: false, error: { kind: expect.stringMatching(/network|timeout/) } })
  })

  it('classifies bad credentials as auth', async () => {
    const good = await manager.test(
      at(secured.port, {
        auth: { mechanism: 'DEFAULT', username: 'root', password: 'root-pass', authSource: 'admin' },
      }),
    )
    expect(good.ok).toBe(true)
    const bad = await manager.test(
      at(secured.port, {
        auth: { mechanism: 'DEFAULT', username: 'root', password: 'nope', authSource: 'admin' },
      }),
    )
    expect(bad).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })
})
