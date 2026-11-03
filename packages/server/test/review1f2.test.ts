import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config'
import { startServer } from '../src/server'
import { KEY_FILE } from '../src/crypto/secret-box'

const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-r1f2-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const config = (dataDir: string, extra = {}) =>
  resolveConfig({ cli: { dataDir, webPort: 0, logLevel: 'silent', ...extra } })

describe('a data directory whose key is missing (Review Important 4)', () => {
  it('is refused without writing a new key next to the data', async () => {
    const dir = tempDir()
    await (await startServer(config(dir))).close()
    rmSync(join(dir, KEY_FILE))
    await expect(startServer(config(dir))).rejects.toThrow(/holds encrypted data but no key/)
    expect(existsSync(join(dir, KEY_FILE))).toBe(false)
  })

  it('still gets a key on a genuinely new data directory', async () => {
    const dir = tempDir()
    await (await startServer(config(dir))).close()
    expect(existsSync(join(dir, KEY_FILE))).toBe(true)
  })
})

describe('log file hardening (Review Minor 7, 8)', () => {
  it('rotates a log that grew past 10 MiB', async () => {
    const dir = tempDir()
    const logFile = join(dir, 'logs', 'mm.log')
    mkdirSync(join(dir, 'logs'))
    writeFileSync(logFile, Buffer.alloc(10 * 1024 * 1024 + 1, 32))
    const server = await startServer(config(join(dir, 'data'), { logFile, logLevel: 'info' }), {
      logger: true,
    })
    await server.close()
    expect(statSync(`${logFile}.1`).size).toBeGreaterThan(10 * 1024 * 1024)
    expect(statSync(logFile).size).toBeLessThan(1024 * 1024)
  })

  it.skipIf(process.platform === 'win32')('does not follow a symlink planted at the log path', async () => {
    const dir = tempDir()
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'keep me', { mode: 0o644 })
    const logFile = join(dir, 'mm.log')
    symlinkSync(victim, logFile)
    await expect(
      startServer(config(join(dir, 'data'), { logFile, logLevel: 'info' }), { logger: true }),
    ).rejects.toThrow()
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
    expect(statSync(victim).mode & 0o777).toBe(0o644)
  })
})

describe('log rotation while running (second review Y6)', () => {
  it('rotates when the next write would pass the limit, keeping one previous file', async () => {
    const { openLogFile } = await import('../src/http/log-file')
    const dir = tempDir()
    const path = join(dir, 'mm.log')
    const stream = openLogFile(path, 100)
    const line = `${'x'.repeat(59)}\n`
    for (let i = 0; i < 5; i++) stream.write(line)
    await new Promise<void>((resolve) => stream.end(resolve))
    // Each file read once: its size is what was read.
    const current = readFileSync(path)
    const previous = readFileSync(`${path}.1`)
    expect(current.length).toBeLessThanOrEqual(100)
    expect(previous.length).toBeLessThanOrEqual(100)
    expect(current.toString('utf8') + previous.toString('utf8')).toContain(line)
  })
})
