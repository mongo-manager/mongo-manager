import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config'
import { startServer } from '../src/server'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('log file', () => {
  it('appends JSON log lines to a private file, secrets redacted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-log-'))
    dirs.push(dir)
    const logFile = join(dir, 'logs', 'mongo-manager.log')
    const server = await startServer(
      resolveConfig({ cli: { dataDir: join(dir, 'data'), webPort: 0, logLevel: 'info', logFile } }),
      { logger: true },
    )
    await fetch(new URL('healthz', server.url), { headers: { cookie: 'mm_sid=very-secret-session' } })
    await server.close()
    const text = readFileSync(logFile, 'utf8')
    expect(text).toMatch(/"url":"\/healthz"/)
    expect(text).not.toContain('very-secret-session')
    if (process.platform !== 'win32') expect(statSync(logFile).mode & 0o777).toBe(0o600)
  })

  // Independent review of the security pass (minor): nor a GridFS file's id, a path part.
  it('writes no file id nor query value into the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-log-'))
    dirs.push(dir)
    const logFile = join(dir, 'mm.log')
    const server = await startServer(
      resolveConfig({ cli: { dataDir: join(dir, 'data'), webPort: 0, logLevel: 'info', logFile } }),
      { logger: true },
    )
    await fetch(
      new URL(
        'api/connections/c1/databases/shop/gridfs/fs/files/ceo%40corp.example/download?q=secret-search',
        server.url,
      ),
    )
    await server.close()
    const text = readFileSync(logFile, 'utf8')
    expect(text).toContain('/gridfs/fs/files/***/download')
    expect(text).not.toContain('ceo')
    expect(text).not.toContain('secret-search')
  })

  // Merge of main: a local launch link's token (and a forget link's) never reaches the log either.
  it('writes no launch token into the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-log-'))
    dirs.push(dir)
    const logFile = join(dir, 'mm.log')
    const server = await startServer(
      resolveConfig({ cli: { dataDir: join(dir, 'data'), webPort: 0, logLevel: 'info', logFile } }),
      { logger: true },
    )
    const token = 'LAUNCHTOKEN0123456789abcdefLAUNCH'
    await fetch(new URL(`launch/${token}`, server.url), { redirect: 'manual' })
    await fetch(new URL(`launch/forget/${token}`, server.url), { method: 'POST' })
    await server.close()
    const text = readFileSync(logFile, 'utf8')
    expect(text).toContain('/launch/***')
    expect(text).not.toContain(token)
  })

  it('reads MM_LOG_FILE', () => {
    expect(resolveConfig({ env: { MM_LOG_FILE: '/var/log/mm.log' } }).logFile).toBe('/var/log/mm.log')
  })
})
