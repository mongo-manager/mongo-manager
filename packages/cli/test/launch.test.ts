import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import {
  LaunchGate,
  loadOrCreateLaunchSecret,
  openStore,
  powershellEnv,
  resolveConfig,
  startServer,
  type StartedServer,
} from '@mongo-manager/server'
import { start } from '../src/commands/start'
import { openCommand } from '../src/commands/open'
import { serviceCommand } from '../src/commands/service'
import { layoutFor } from '../src/service/layout'
import { main } from '../src/main'
import { checkedLaunchLink, cleanTempDirs, fakeIo, tempDir } from './support'
import { fakeSys } from './service/fake-sys'

/**
 * Security audit 2026-10-16 (important 2): local mode opens only from a one-time launch link.
 *
 * Review of the audit fixes: the browser is opened with a 0600 file that redirects to a two-minute
 * link, so no token is ever in a command line others can read (important 2); the link itself is
 * printed only to a terminal outside a container — elsewhere (a service, pm2, nohup, docker logs)
 * the path of such a file, kept for an hour (minor 6); `mongo-manager open` finds the running
 * server's own address and prints a link when no browser opens (minor 7).
 */
const servers: StartedServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  cleanTempDirs()
})

const config = (overrides = {}) =>
  resolveConfig({ cli: { dataDir: tempDir(), webPort: 0, logLevel: 'silent', ...overrides } })

/** Follows a launch link as a browser would — the cookie, then its page's key — and asks the API. */
async function opens(printedLink: string): Promise<boolean> {
  const link = checkedLaunchLink(printedLink)
  const res = await fetch(link, { redirect: 'manual' })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (res.status !== 303 || !cookie) return false
  const origin = link.origin
  const claimed = await fetch(new URL('/api/auth/local/claim', origin), {
    method: 'POST',
    headers: { cookie, origin },
  })
  if (!claimed.ok) return false
  const { key } = (await claimed.json()) as { key: string }
  return (
    (await fetch(new URL('/api/auth/me', origin), { headers: { cookie, 'x-mm-local': key } })).status === 200
  )
}

/** The link a redirect file sends the browser to. */
function linkIn(file: string): string {
  const html = readFileSync(file, 'utf8')
  return /url=([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&')
}

/** Everyone, Users, Authenticated Users, Interactive — none may read the file (Windows). */
function broadSids(path: string): string[] {
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  return execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-Acl -LiteralPath $env:MM_PROBE).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value }",
    ],
    { encoding: 'utf8', env: powershellEnv({ MM_PROBE: path }) },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-4'].includes(s))
}

function expectPrivate(file: string) {
  if (process.platform === 'win32') expect(broadSids(file)).toEqual([])
  else expect(statSync(file).mode & 0o777).toBe(0o600)
}

describe('start in local mode', () => {
  it('in a terminal: prints a link after its address, and opens the browser with a private file', async () => {
    let printed = ''
    let opened = ''
    const io = fakeIo({
      tty: true,
      whileRunning: async () => {
        const address = /local mode\) is running at (\S+)\n/.exec(io.err())![1]!
        // The address line is as before: a script reading it still finds the server.
        expect((await fetch(new URL('healthz', address))).status).toBe(200)
        expect((await fetch(new URL('api/auth/me', address))).status).toBe(401)
        printed = /Open it with this link \(it works once, within an hour\): (\S+)\n/.exec(io.err())![1]!
        expect(io.opened).toHaveLength(1)
        // What the opener's command line shows: a file's path, never a token.
        expect(io.opened[0]).not.toMatch(/^https?:/)
        expect(io.opened[0]).not.toContain('/launch/')
        expectPrivate(io.opened[0]!)
        opened = linkIn(io.opened[0]!)
        expect(opened).not.toBe(printed)
        expect(await opens(opened)).toBe(true)
        expect(await opens(printed)).toBe(true)
      },
    })
    io.stderr.isTTY = true
    expect(await start(config(), {}, io, { startServer, inContainer: () => false })).toBe(0)
    // Two minutes for the one opened at once.
    const exp = Number.parseInt(opened.split('/launch/')[1]!.split('.')[0]!, 36)
    expect(exp - Date.now()).toBeLessThanOrEqual(2 * 60_000)
  })

  it("into a log (no terminal): prints a private file's path, never a link", async () => {
    let link = ''
    const io = fakeIo({
      whileRunning: async () => {
        const file = /Open it from this file \(it works once, within an hour\): (.+)\n/.exec(io.err())![1]!
        expect(existsSync(file)).toBe(true)
        expectPrivate(file)
        link = linkIn(file)
        expect(await opens(link)).toBe(true)
      },
    })
    io.stderr.isTTY = false
    await start(config({ open: false }), {}, io, { startServer, inContainer: () => false })
    expect(io.err()).not.toMatch(/\/launch\//)
    expect(link).toMatch(/\/launch\//)
  })

  // Second review (minor 6): a file inside a container is no use on the host: the command instead.
  it('in a container: names the command that prints a link, never a path inside it', async () => {
    for (const tty of [true, false]) {
      const io = fakeIo()
      io.stderr.isTTY = tty
      await start(config({ open: false }), {}, io, { startServer, inContainer: () => true })
      expect(io.err()).toContain('docker exec <container> node /app/dist/cli.cjs open --no-open')
      expect(io.err()).not.toMatch(/\/launch\/|Open it from this file/)
    }
  })

  it('prints no link in team mode', async () => {
    const io = fakeIo()
    await start(config({ auth: true }), {}, io)
    expect(io.err()).not.toMatch(/\/launch\/|Open it/)
  })
})

describe('mongo-manager open', () => {
  /** A server on a port of its own; the CLI's config names the default port, as a person's does. */
  async function running() {
    const c = config()
    const server = await startServer(c)
    servers.push(server)
    return { server, c: resolveConfig({ cli: { dataDir: c.dataDir, logLevel: 'silent' } }) }
  }

  it('prints a link to the running server’s own address when there is no terminal', async () => {
    const { server, c } = await running()
    const io = fakeIo()
    expect(await openCommand(c, io)).toBe(0)
    const link = /within an hour\): (\S+)\n/.exec(io.out())![1]!
    expect(link.startsWith(`${server.url}launch/`)).toBe(true)
    expect(await opens(link)).toBe(true)
  })

  it('opens the browser with a private file, never a token in its command line', async () => {
    const { c } = await running()
    const io = fakeIo({ tty: true })
    expect(await openCommand(c, io)).toBe(0)
    expect(io.opened[0]).not.toMatch(/^https?:/)
    expect(io.opened[0]).not.toContain('/launch/')
    expect(await opens(linkIn(io.opened[0]!))).toBe(true)
    // Second review (N3): a browser that cannot read the file (snap, Flatpak) or an opener that shows
    // it in an editor still exits well — the terminal gets a link too.
    const link = /If no browser opened it: (\S+)\n/.exec(io.out())![1]!
    expect(await opens(link)).toBe(true)
  })

  it('prints the link when no browser opens (a headless computer)', async () => {
    const { c } = await running()
    const io = fakeIo({ tty: true, openFails: true })
    expect(await openCommand(c, io)).toBe(0)
    const link = /within an hour\): (\S+)\n/.exec(io.out())![1]!
    expect(await opens(link)).toBe(true)
  })

  it('reads the same options as start', async () => {
    const { server, c } = await running()
    const io = fakeIo()
    const code = await main(['open', '--no-open', '--data-dir', c.dataDir, '--log-level', 'silent'], io)
    expect(code).toBe(0)
    expect(io.out()).toContain(`${server.url}launch/`)
  })

  it('says so when nothing runs on the data directory, or in team mode', async () => {
    const idle = config()
    loadOrCreateLaunchSecret(idle.dataDir)
    const io = fakeIo()
    expect(await openCommand(idle, io)).toBe(1)
    expect(io.err()).toMatch(/not running/)
    const team = fakeIo()
    expect(await openCommand(config({ auth: true }), team)).toBe(1)
    expect(team.err()).toMatch(/team mode has no launch link/)
  })
})

describe('mongo-manager forget-browsers', () => {
  it('signs every browser out of local mode', async () => {
    const c = config()
    const server = await startServer(c)
    servers.push(server)
    const link = server.launchUrl!()
    const res = await fetch(link, { redirect: 'manual' })
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    const origin = new URL(link).origin
    const { key } = (await (
      await fetch(new URL('/api/auth/local/claim', origin), { method: 'POST', headers: { cookie, origin } })
    ).json()) as { key: string }
    const io = fakeIo()
    expect(await main(['forget-browsers', '--data-dir', c.dataDir, '--log-level', 'silent'], io)).toBe(0)
    // Second review (minor 3): through the running server, so the local shells end at once too.
    expect(io.out()).toMatch(/1 browser signed out by the running server/)
    expect(
      (await fetch(new URL('/api/auth/me', origin), { headers: { cookie, 'x-mm-local': key } })).status,
    ).toBe(401)
  })
})

describe('service open', () => {
  const layout = layoutFor('linux', {})
  const install = async (auth: boolean, withSecret = true) => {
    const sys = fakeSys('linux')
    sys.files.set(layout.configFile, {
      content: JSON.stringify({ webPort: 4321, host: '127.0.0.1', auth, dataDir: layout.dataDir }),
      mode: 0o600,
    })
    const secret = Buffer.alloc(32, 3)
    if (withSecret)
      sys.files.set(posix.join(layout.dataDir, 'launch.key'), {
        content: `${secret.toString('base64')}\n`,
        mode: 0o600,
      })
    const store = await openStore(tempDir())
    return { sys, gate: new LaunchGate(secret, Date.now, store.db), store }
  }

  it('prints a link the service takes, for an administrator', async () => {
    const { sys, gate, store } = await install(false)
    const io = fakeIo()
    expect(await serviceCommand(['open'], {}, io, { sys })).toBe(0)
    const link = /within an hour\): (\S+)\n/.exec(io.out())![1]!
    expect(link.startsWith('http://127.0.0.1:4321/launch/')).toBe(true)
    expect(gate.take(link.split('/launch/')[1]!)).toBe(true)
    expect(io.opened).toEqual([])
    store.close()
  })

  it('needs an administrator, a local-mode service, and one that has started', async () => {
    const io = fakeIo()
    const notAdmin = fakeSys('linux', { admin: false })
    expect(await serviceCommand(['open'], {}, io, { sys: notAdmin })).toBe(1)
    expect(io.err()).toMatch(/needs root/)
    const team = fakeIo()
    const t = await install(true)
    expect(await serviceCommand(['open'], {}, team, { sys: t.sys })).toBe(1)
    expect(team.err()).toMatch(/team mode: sign in at http:\/\/127\.0\.0\.1:4321\//)
    const early = fakeIo()
    const e = await install(false, false)
    expect(await serviceCommand(['open'], {}, early, { sys: e.sys })).toBe(1)
    expect(early.err()).toMatch(/not started yet/)
    t.store.close()
    e.store.close()
  })
})
