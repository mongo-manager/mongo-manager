// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Db, type Document } from 'mongodb'
import { ConnectionSettingsSchema, type ConnectionSettings } from '@mongo-manager/shared'
import { ConnectionManager } from '../src/connections/manager'
import { toAppError } from '../src/data/mongo-errors'
import { AppError } from '../src/errors'
import { startMongo, type TestMongo } from './support/mongo'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const settings = (): ConnectionSettings =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: '127.0.0.1', port: mongo.port }],
    serverSelectionTimeoutMS: 2_000,
  })

/** Makes the test server report `version` from buildInfo; every other command runs for real. */
function pretendVersion(version: string) {
  const original = Db.prototype.command
  vi.spyOn(Db.prototype, 'command').mockImplementation(function (this: Db, command: Document, ...rest) {
    if ('buildInfo' in command) return Promise.resolve({ version, ok: 1 })
    return original.call(this, command, ...(rest as []))
  } as typeof original)
}

describe('MongoDB older than 6.0 is refused (phase 1h spec §10)', () => {
  it('reports an unsupported server in the connection test, with the version it found', async () => {
    pretendVersion('5.0.26')
    const manager = new ConnectionManager({ load: () => ({ settings: settings() }) })
    const result = await manager.test(settings())
    expect(result).toMatchObject({ ok: false, error: { kind: 'unsupported' } })
    expect(!result.ok && result.error.message).toBe(
      'MongoDB 5.0.26 is not supported. mongo-manager supports MongoDB 6.0 and later.',
    )
    await manager.closeAll()
  })

  it('refuses to open a saved connection to it, closes the client and answers 422', async () => {
    pretendVersion('4.4.29')
    const manager = new ConnectionManager({ load: () => ({ settings: settings() }) })
    const error = await manager.getClient('c1').then(
      () => null,
      (e: unknown) => toAppError(e),
    )
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: 'UNSUPPORTED_SERVER', statusCode: 422 })
    expect(manager.openCount()).toBe(0)
    await manager.closeAll()
  })

  it('treats an unreadable version as unsupported', async () => {
    pretendVersion('unknown')
    const manager = new ConnectionManager({ load: () => ({ settings: settings() }) })
    expect(await manager.test(settings())).toMatchObject({ ok: false, error: { kind: 'unsupported' } })
    await manager.closeAll()
  })

  it('connects to the real test server, which is supported', async () => {
    const manager = new ConnectionManager({ load: () => ({ settings: settings() }) })
    const result = await manager.test(settings())
    expect(result.ok).toBe(true)
    await manager.getClient('c1')
    expect(manager.openCount()).toBe(1)
    await manager.closeAll()
  })
})
