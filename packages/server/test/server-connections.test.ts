// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config'
import { startServer, type StartedServer } from '../src/server'

const dirs: string[] = []
const servers: StartedServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-seed-'))
  dirs.push(d)
  return d
}

describe('--uri pre-seed', () => {
  it('creates a Default connection once', async () => {
    const dataDir = tempDir()
    const cfg = resolveConfig({
      cli: { dataDir, webPort: 0, uri: 'mongodb://seed-user:seed-pass@db.example:27017/?appName=x' },
    })
    const first = await startServer(cfg)
    expect(first.app.ctx.connections.list().map((c) => c.name)).toEqual(['Default'])
    expect(first.app.ctx.connections.list()[0]!.settings.auth.password).toBe('seed-pass')
    await first.close()
    const second = await startServer(cfg)
    servers.push(second)
    expect(second.app.ctx.connections.count()).toBe(1)
  })

  it('fails fast on an invalid --uri without echoing credentials', async () => {
    const cfg = resolveConfig({
      cli: { dataDir: tempDir(), webPort: 0, uri: 'mongodb://u:topsecret@h/?tlsCAFile=/etc/passwd' },
    })
    const error = await startServer(cfg).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/--uri/)
    expect((error as Error).message).not.toContain('topsecret')
  })
})
