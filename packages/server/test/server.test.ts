// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config'
import { startServer, type StartedServer } from '../src/server'
import { redactUriSecrets } from '../src/connections/errors'

const dirs: string[] = []
const servers: StartedServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-srv-'))
  dirs.push(d)
  return d
}

describe('security audit 2026-10-16 (minor): an invalid --uri never shows its password', () => {
  const PASSWORD = 'Pa@ss/w0rd:x'
  it('redacts all of the credentials, unencoded @ / and : included', () => {
    const uri = `mongodb://admin:${PASSWORD}@db.example:27017/app?authSource=admin`
    for (const message of [
      `Invalid connection string: bad ${uri} here`,
      'Invalid host "ss/w0rd:x@db.example"',
      `Password contains unescaped characters: ${PASSWORD}`,
    ]) {
      const shown = redactUriSecrets(message, uri)
      for (const piece of ['Pa@ss', 'ss/w0rd', 'w0rd:x', PASSWORD]) expect(shown).not.toContain(piece)
    }
    expect(redactUriSecrets(`see ${uri}`, uri)).toBe(
      'see mongodb://***@db.example:27017/app?authSource=admin',
    )
    expect(redactUriSecrets('Unsupported authMechanism "FOO"', 'mongodb://h/?authMechanism=FOO')).toBe(
      'Unsupported authMechanism "FOO"',
    )
  })

  // Independent review of the security pass (minor): the password as the parser decoded it, and
  // its short pieces, are hidden too (a short piece only where it stands alone).
  it('hides the decoded password and its short pieces', () => {
    const uri = 'mongodb://admin:x%40Zq%2Fsecretpw@db.example/app'
    const shown = redactUriSecrets(
      'Password "x@Zq/secretpw" is not valid: piece "Zq" and "x" in Password contains',
      uri,
    )
    for (const piece of ['x@Zq', 'secretpw', '"Zq"', '"x"']) expect(shown).not.toContain(piece)
    expect(shown).toContain('Password contains')
  })

  it('starts with no word of it in the error', async () => {
    const uri = `mongodb://admin:${PASSWORD}@db.example:27017/app?tlsCAFile=/etc/ca.pem`
    const err = await startServer(resolveConfig({ cli: { dataDir: tempDir(), webPort: 0, uri } })).catch(
      (e: Error) => e,
    )
    expect(String((err as Error).message)).toMatch(/^--uri cannot be used: File-based TLS options/)
    for (const piece of ['Pa@ss', 'w0rd']) expect(String((err as Error).message)).not.toContain(piece)
  })
})

describe('startServer', () => {
  it('refuses an explicit web root that holds no built app', async () => {
    const dataDir = tempDir()
    await expect(
      startServer(resolveConfig({ cli: { dataDir, webPort: 0, webRoot: join(dataDir, 'missing') } })),
    ).rejects.toThrow(/webRoot/)
  })

  it('refuses an unsafe bind before touching the data dir (S1)', async () => {
    const dataDir = join(tempDir(), 'never-created')
    await expect(
      startServer(resolveConfig({ cli: { host: '0.0.0.0', dataDir, webPort: 1 } })),
    ).rejects.toThrow(/Refusing/)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('serves real HTTP in local mode and shuts down cleanly', async () => {
    const s = await startServer(resolveConfig({ cli: { dataDir: tempDir(), webPort: 0 } }))
    servers.push(s)
    expect(s.setupToken).toBeNull()
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const res = await fetch(new URL('healthz', s.url))
    expect(await res.json()).toEqual({ status: 'ok' })
    await s.close()
    servers.length = 0
    await expect(fetch(new URL('healthz', s.url))).rejects.toThrow()
  })

  it('issues a setup token only while team mode has no users', async () => {
    const dataDir = tempDir()
    const first = await startServer(resolveConfig({ cli: { dataDir, webPort: 0, auth: true } }))
    servers.push(first)
    expect(first.setupToken).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const status = await fetch(new URL('api/auth/status', first.url)).then((r) => r.json())
    expect(status).toMatchObject({ mode: 'team', setupRequired: true })
    first.app.ctx.users.create({ username: 'admin', passwordHash: 'x', role: 'admin' })
    await first.close()
    servers.length = 0

    const second = await startServer(resolveConfig({ cli: { dataDir, webPort: 0, auth: true } }))
    servers.push(second)
    expect(second.setupToken).toBeNull()
  })

  // Security review 2026-10-13 (low): the token was written to the log, which is often kept and
  // read by others. It is kept in a file only the server's account reads, gone once set up.
  it('keeps the setup token in a file of the data folder, never in the log, and removes it after setup', async () => {
    const dataDir = tempDir()
    const logFile = join(dataDir, 'logs', 'mm.log')
    const s = await startServer(resolveConfig({ cli: { dataDir, webPort: 0, auth: true, logFile } }), {
      logger: true,
    })
    const lines = [readFileSync(logFile, 'utf8')]
    servers.push(s)
    const file = join(dataDir, 'setup-token')
    expect(s.setupTokenFile).toBe(file)
    expect(readFileSync(file, 'utf8').trim()).toBe(s.setupToken)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(lines.join('')).not.toContain(s.setupToken!)
    expect(lines.join('')).toContain(file.replace(/\\/g, '\\\\'))
    const res = await fetch(new URL('api/auth/setup', s.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'mongo-manager' },
      body: JSON.stringify({ token: s.setupToken, username: 'admin', password: 'tarçın-kavanoz-42-mavi' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(file)).toBe(false)
  })

  it('reports and logs how its transport may leak (security review 2026-10-13)', async () => {
    const dataDir = tempDir()
    const logFile = join(dataDir, 'logs', 'mm.log')
    const s = await startServer(
      resolveConfig({ cli: { dataDir, webPort: 0, auth: true, allowedHosts: ['mm.example.com'], logFile } }),
      { logger: true },
    )
    servers.push(s)
    expect(s.warnings).toEqual([expect.stringMatching(/^--allowed-hosts names mm\.example\.com, .*Secure/)])
    expect(readFileSync(logFile, 'utf8')).toContain('no proxy is trusted')
  })

  it('removes a setup token file left from before once there are users', async () => {
    const dataDir = tempDir()
    const first = await startServer(resolveConfig({ cli: { dataDir, webPort: 0, auth: true } }))
    first.app.ctx.users.create({ username: 'admin', passwordHash: 'x', role: 'admin' })
    await first.close()
    expect(existsSync(join(dataDir, 'setup-token'))).toBe(true)
    const second = await startServer(resolveConfig({ cli: { dataDir, webPort: 0, auth: true } }))
    servers.push(second)
    expect(second.setupTokenFile).toBeNull()
    expect(existsSync(join(dataDir, 'setup-token'))).toBe(false)
  })

  it('reuses the same secret key across restarts', async () => {
    const dataDir = tempDir()
    const a = await startServer(resolveConfig({ cli: { dataDir, webPort: 0 } }))
    const sealed = a.app.ctx.secretBox.seal('hello', 'ctx')
    await a.close()
    const b = await startServer(resolveConfig({ cli: { dataDir, webPort: 0 } }))
    servers.push(b)
    expect(b.app.ctx.secretBox.open(sealed, 'ctx')).toBe('hello')
  })
})
