// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Fail the first rename of the live key file, as antivirus or a crash between commit and swap would.
const failRename = vi.hoisted(() => ({ armed: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (failRename.armed && /secret\.key$/.test(String(from))) {
        failRename.armed = false
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
      return fs.renameSync(from, to)
    },
  }
})

const { openStore } = await import('../src/store/db')
const { createSecretBox, loadOrCreateKey } = await import('../src/crypto/secret-box')
const { rotateSecretKey, verifyKeyCheck } = await import('../src/crypto/rotate')
const { ConnectionRepo } = await import('../src/connections/repo')
const { resolveConfig } = await import('../src/config')
const { startServer } = await import('../src/server')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('a rotation interrupted after its commit (Review Minor 2)', () => {
  it('says it was committed, finishes on the next start, and a second rotation still works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-rotate-pc-'))
    dirs.push(dir)
    const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    const store = await openStore(dir)
    const conn = new ConnectionRepo(store.db, box, Date.now).create(
      { name: 'Prod', settings: { hosts: [{ host: 'db' }] } } as never,
      null,
    )
    verifyKeyCheck(store.db, box)
    store.close()

    failRename.armed = true
    await expect(rotateSecretKey({ dataDir: dir })).rejects.toThrow(/committed.*next start completes it/s)
    // A second rotation first completes the pending one, then rotates again.
    const again = await rotateSecretKey({ dataDir: dir })
    expect(again.connections).toBe(1)
    const server = await startServer(resolveConfig({ cli: { dataDir: dir, webPort: 0, logLevel: 'silent' } }))
    expect(server.app.ctx.connections.get(conn.id)?.name).toBe('Prod')
    await server.close()
  })
})
