import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig, startServer as realStart, type startServer } from '@mongo-manager/server'
import { start } from '../src/commands/start'
import { main } from '../src/main'
import { cleanTempDirs, fakeIo, tempDir } from './support'

afterEach(cleanTempDirs)

const config = (overrides = {}) =>
  resolveConfig({ cli: { dataDir: tempDir(), webPort: 0, logLevel: 'silent', ...overrides } })

describe('start', () => {
  it('serves until shutdown and prints the URL and, in team mode, the one-time setup token', async () => {
    let health = 0
    const io = fakeIo({
      whileRunning: async () => {
        const url = /running at (\S+)/.exec(io.err())![1]!
        health = (await fetch(new URL('healthz', url))).status
      },
    })
    io.stderr.isTTY = true
    expect(
      await start(config({ auth: true }), {}, io, { startServer: realStart, inContainer: () => false }),
    ).toBe(0)
    expect(health).toBe(200)
    expect(io.err()).toMatch(/team mode\) is running at http:\/\/127\.0\.0\.1:\d+\//)
    expect(io.err()).toMatch(/one-time setup token:\s+\S{20,}/)
    expect(io.opened).toEqual([])
  })

  // Security review 2026-10-13 (low): output that is not a terminal is usually a log (a service, a
  // container): it names the file that holds the token, never the token.
  it('names the setup token file, not the token, when its output is not a terminal', async () => {
    const io = fakeIo()
    const c = config({ auth: true })
    expect(await start(c, {}, io)).toBe(0)
    expect(io.err()).not.toMatch(/setup token:\s+\S{20,}/)
    expect(io.err()).toContain(join(c.dataDir, 'setup-token'))
  })

  it('names the setup token file in a container’s terminal, which its runtime keeps as a log', async () => {
    const io = fakeIo()
    io.stderr.isTTY = true
    const c = config({ auth: true })
    expect(await start(c, {}, io, { startServer: realStart, inContainer: () => true })).toBe(0)
    expect(io.err()).not.toMatch(/setup token:\s+\S{20,}/)
    expect(io.err()).toContain(join(c.dataDir, 'setup-token'))
  })

  it('prints the server’s startup warnings (security review 2026-10-13)', async () => {
    const fake = vi.fn(async () => ({
      url: 'http://127.0.0.1:1/',
      setupToken: null,
      setupTokenFile: null,
      warnings: ['Team mode listens on 0.0.0.0 over plain HTTP'],
      close: async () => {},
    })) as unknown as typeof startServer
    const io = fakeIo()
    await start(config(), {}, io, { startServer: fake })
    expect(io.err()).toContain('Warning: Team mode listens on 0.0.0.0 over plain HTTP')
  })

  it('names the bundled plugins it ships, an explicit folder first (4b map review I1)', async () => {
    const seen: Array<{ bundledPluginsDir?: string }> = []
    const fake = vi.fn(async (c: { bundledPluginsDir?: string }) => {
      seen.push(c)
      return { url: 'http://127.0.0.1:1/', setupToken: null, close: async () => {} }
    }) as unknown as typeof startServer
    await start(config({ bundledPluginsDir: '/opt/plugins' }), {}, fakeIo(), { startServer: fake })
    expect(seen[0]!.bundledPluginsDir).toBe('/opt/plugins')
    await start(config(), {}, fakeIo(), { startServer: fake })
    // From source: the package's own plugins folder when built, else none — never a guess elsewhere.
    const own = join(import.meta.dirname, '..', 'plugins')
    const packaged = existsSync(join(own, 'geojson-map', 'mongo-manager-plugin.json')) ? own : undefined
    expect(seen[1]!.bundledPluginsDir).toBe(packaged)
  })

  it('opens the browser only in local mode on loopback with a terminal', async () => {
    const tty = fakeIo({ tty: true })
    await start(config(), {}, tty)
    expect(tty.opened).toHaveLength(1)
    const piped = fakeIo({ tty: false })
    await start(config(), {}, piped)
    expect(piped.opened).toEqual([])
    const off = fakeIo({ tty: true })
    await start(config({ open: false }), {}, off)
    expect(off.opened).toEqual([])
  })

  it('warns about credentials on the command line without echoing them (Review Focus 2)', async () => {
    const fake = vi.fn(async () => ({
      url: 'http://127.0.0.1:1/',
      setupToken: null,
      close: async () => {},
    })) as unknown as typeof startServer
    const io = fakeIo()
    await start(config(), { uri: 'mongodb://app:hunter2-secret@db:27017/' }, io, { startServer: fake })
    expect(io.err()).toMatch(/visible to other users.*MM_URI/s)
    expect(io.err()).not.toContain('hunter2-secret')
  })

  it('warns loudly when listening on the network without authentication', async () => {
    const fake = vi.fn(async () => ({
      url: 'http://0.0.0.0:1/',
      setupToken: null,
      close: async () => {},
    })) as unknown as typeof startServer
    const io = fakeIo()
    await start(config({ host: '0.0.0.0', unsafeNoAuth: true }), {}, io, { startServer: fake })
    expect(io.err()).toMatch(/WARNING: .*without authentication/)
  })

  it('refuses a network bind without --auth (S1)', async () => {
    const io = fakeIo()
    expect(
      await main(['start', '--host', '0.0.0.0', '--data-dir', tempDir(), '--log-level', 'silent'], io),
    ).toBe(1)
    expect(io.err()).toMatch(/Refusing to listen on 0\.0\.0\.0 without authentication/)
  })
})
