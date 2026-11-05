// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCK_FILE, LOCK_INFO_FILE, acquireInstanceLock, runningInstance } from '../src/store/lock'
import { resolveConfig } from '../src/config'
import { startServer } from '../src/server'

const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-lock-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('instance lock (Review Focus 3)', () => {
  it('refuses a second holder, names the holder, and allows it after release', () => {
    const dir = tempDir()
    const lock = acquireInstanceLock(dir, 'key rotation')
    expect(runningInstance(dir)).toMatchObject({ pid: process.pid, what: 'key rotation' })
    expect(() => acquireInstanceLock(dir)).toThrow(/in use by Mongo Manager \(key rotation, pid \d+\)/)
    lock.release()
    expect(runningInstance(dir)).toBeNull()
    acquireInstanceLock(dir).release()
  })

  it('is released by the operating system when the holder is killed', () => {
    const dir = tempDir()
    const path = join(dir, LOCK_FILE)
    const killed = spawnSync(process.execPath, [
      '-e',
      `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(path)});
       db.exec('PRAGMA locking_mode = EXCLUSIVE'); db.exec('BEGIN EXCLUSIVE');
       require('node:fs').writeFileSync(${JSON.stringify(join(dir, LOCK_INFO_FILE))}, JSON.stringify({ pid: process.pid, what: 'server', startedAt: 1 }));
       process.kill(process.pid, 'SIGKILL')`,
    ])
    expect(killed.signal ?? killed.status).toBeTruthy()
    expect(runningInstance(dir)).toBeNull()
    acquireInstanceLock(dir).release()
  })

  it('is not fooled by a reused PID, e.g. PID 1 in a restarted container (Review Important 2)', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, LOCK_INFO_FILE),
      JSON.stringify({ pid: process.pid, what: 'server', startedAt: 1 }),
    )
    expect(runningInstance(dir)).toBeNull()
    acquireInstanceLock(dir).release()
  })

  it('replaces a lock file that is not a lock database', () => {
    const dir = tempDir()
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 12345, startedAt: 1 }))
    acquireInstanceLock(dir).release()
  })

  it('keeps two servers off one data directory', async () => {
    const dir = tempDir()
    const config = resolveConfig({ cli: { dataDir: dir, webPort: 0, logLevel: 'silent' } })
    const first = await startServer(config)
    try {
      await expect(startServer(config)).rejects.toThrow(/in use by Mongo Manager \(server, pid \d+\)/)
    } finally {
      await first.close()
    }
    expect(runningInstance(dir)).toBeNull()
    await (await startServer(config)).close()
  })
})
