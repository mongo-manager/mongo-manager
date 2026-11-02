import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LightMyRequestResponse } from 'fastify'
import { TEST_LAUNCH_SECRET, makeApp, type TestApp } from './helpers'
import { resolveConfig } from '../src/config'
import { startServer, type StartedServer } from '../src/server'
import { powershellEnv } from '../src/windows-tools'
import {
  LAUNCH_FILE,
  LAUNCH_TTL_START_MS,
  loadOrCreateLaunchSecret,
  localCookieName,
  mintForgetToken,
  mintLaunchToken,
  readLaunchSecret,
} from '../src/auth/launch'

/**
 * Security audit 2026-10-16 (important 2): in local mode every process and every account on the
 * computer that reached the port was the owner. Now the API and the socket answer only a browser
 * that opened a one-time launch link made from the per-install secret in the data directory.
 *
 * Review of the audit fixes (important 1): a cookie on 127.0.0.1 also goes to every other port of it
 * (another account's server there gets it), so a cookie alone opens nothing: each browser gets a
 * random cookie of its own, kept as a hash and revocable, and claims once a key its page keeps in its
 * own origin's storage and sends as `x-mm-local`. (Important 2: a used token stays used after a
 * restart; minor 1, 2: HEAD takes nothing, and guesses never hold a real link back.)
 */
const apps: TestApp[] = []
const servers: StartedServer[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A browser's headers without the cookie: what another process on the computer sends. */
const BARE = { host: 'localhost:4321', origin: 'http://localhost:4321' }
const NAME = localCookieName(TEST_LAUNCH_SECRET)
const cookieOf = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === NAME)

async function local(overrides: object = {}) {
  const t = await makeApp(overrides)
  apps.push(t)
  const { ctx } = t.app
  const req = (
    method: 'GET' | 'POST' | 'HEAD',
    url: string,
    browser: { cookie?: string; key?: string; csrf?: string } = {},
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url,
      headers: {
        ...BARE,
        ...(browser.cookie ? { cookie: `${NAME}=${browser.cookie}` } : {}),
        ...(browser.key ? { 'x-mm-local': browser.key } : {}),
        ...(browser.csrf ? { 'x-csrf-token': browser.csrf } : {}),
      },
      ...(payload ? { payload } : {}),
    })
  const get = (url: string, browser?: { cookie?: string; key?: string }) => req('GET', url, browser)
  /** Opens a launch link and claims the key, as the app does: the browser's cookie and key. */
  const launch = async () => {
    const res = await get(`/launch/${ctx.launch!.mint(LAUNCH_TTL_START_MS)}`)
    const cookie = cookieOf(res)!.value
    const claimed = await req('POST', '/api/auth/local/claim', { cookie })
    expect(claimed.statusCode, claimed.body).toBe(200)
    return { cookie, key: claimed.json().key as string }
  }
  const socket = (headers: Record<string, string>) =>
    t.app.injectWS('/ws', { headers, socket: { encrypted: false, remoteAddress: '127.0.0.1' } } as never)
  return { t, ctx, req, get, launch, socket }
}

describe('local mode without the cookie', () => {
  it('refuses every API request, the socket and the CSRF token', async () => {
    const { t, get, socket } = await local()
    for (const url of ['/api/auth/status', '/api/auth/me', '/api/connections', '/api/plugins'] as const) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(401)
      expect(res.json().details, url).toEqual({ reason: 'launch_required' })
      expect(res.body, url).not.toContain('csrf')
    }
    const post = await t.app.inject({ method: 'POST', url: '/api/connections', headers: BARE, payload: {} })
    expect(post.statusCode).toBe(401)
    await expect(socket(BARE)).rejects.toThrow(/401/)
    expect((await get('/healthz')).statusCode).toBe(200)
  })

  it('refuses a forged cookie', async () => {
    const { get } = await local()
    expect((await get('/api/auth/me', { cookie: 'x'.repeat(43) })).statusCode).toBe(401)
  })
})

describe('the launch link', () => {
  it('gives this browser a cookie of its own and a clean address', async () => {
    const { ctx, get } = await local()
    const res = await get(`/launch/${ctx.launch!.mint(LAUNCH_TTL_START_MS)}`)
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/')
    expect(res.headers['cache-control']).toBe('no-store')
    const cookie = cookieOf(res)!
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' })
    expect(cookie.maxAge).toBeGreaterThan(30 * 24 * 3600)
    // Another browser's link gives another cookie: nothing is shared.
    const other = cookieOf(await get(`/launch/${ctx.launch!.mint(LAUNCH_TTL_START_MS)}`))!
    expect(other.value).not.toBe(cookie.value)
  })

  it('names the cookie for this installation, so two never overwrite each other', () => {
    expect(NAME).toMatch(/^mm_local_[\w-]{10}$/)
    expect(localCookieName(randomBytes(32))).not.toBe(NAME)
  })

  it('is useless as a cookie alone: the page key, claimed once and only by its browser, is needed too', async () => {
    const { ctx, req, get } = await local()
    const res = await get(`/launch/${ctx.launch!.mint(LAUNCH_TTL_START_MS)}`)
    const cookie = cookieOf(res)!.value
    // What another port's server on 127.0.0.1 gets: the cookie. It reads nothing with it.
    for (const url of ['/api/auth/status', '/api/auth/me', '/api/connections']) {
      const stolen = await get(url, { cookie })
      expect(stolen.statusCode, url).toBe(401)
      expect(stolen.json().details).toEqual({ reason: 'launch_required' })
    }
    // The page claims its key at once; a second claim (a thief's, later) gets nothing.
    const claimed = await req('POST', '/api/auth/local/claim', { cookie })
    const key = claimed.json().key as string
    expect(key).toMatch(/^[\w-]{40,}$/)
    expect((await req('POST', '/api/auth/local/claim', { cookie })).statusCode).toBe(401)
    expect((await get('/api/auth/me', { cookie, key })).json()).toMatchObject({ mode: 'local' })
    expect((await get('/api/auth/status', { cookie, key: 'x'.repeat(43) })).statusCode).toBe(401)
    // The key without its browser's cookie, or with another browser's, opens nothing either.
    expect((await get('/api/auth/status', { key })).statusCode).toBe(401)
    const other = cookieOf(await get(`/launch/${ctx.launch!.mint(LAUNCH_TTL_START_MS)}`))!.value
    expect((await get('/api/auth/status', { cookie: other, key })).statusCode).toBe(401)
  })

  it('claims only from the app itself, and only soon after the link', async () => {
    const { t, ctx, get } = await local()
    const cookie = cookieOf(await get(`/launch/${ctx.launch!.mint(LAUNCH_TTL_START_MS)}`))!.value
    // Another origin (another port's page) is refused before anything is claimed.
    const foreign = await t.app.inject({
      method: 'POST',
      url: '/api/auth/local/claim',
      headers: { host: BARE.host, origin: 'http://localhost:8000', cookie: `${NAME}=${cookie}` },
    })
    expect(foreign.statusCode).toBe(403)
    t.clock.now += 6 * 60_000
    const late = await t.app.inject({
      method: 'POST',
      url: '/api/auth/local/claim',
      headers: { ...BARE, cookie: `${NAME}=${cookie}` },
    })
    expect(late.statusCode).toBe(401)
  })

  it('opens the socket only with the CSRF token a keyed request gets', async () => {
    const { get, launch, socket } = await local()
    const browser = await launch()
    const headers = { ...BARE, cookie: `${NAME}=${browser.cookie}` }
    const csrf = (await get('/api/auth/me', browser)).json().csrfToken as string
    const wrong = await socket(headers)
    const closed = new Promise<number>((r) => wrong.on('close', (code: number) => r(code)))
    wrong.send(JSON.stringify({ type: 'hello', csrf: 'x'.repeat(43) }))
    expect(await closed).toBe(4403)
    const right = await socket(headers)
    const ready = new Promise<string>((r) => right.on('message', (d: Buffer) => r(String(d))))
    right.send(JSON.stringify({ type: 'hello', csrf }))
    expect(JSON.parse(await ready)).toEqual({ type: 'ready' })
    right.terminate()
  })

  it('lets a download link through once with a ticket its page asked for', async () => {
    const { req, get, launch } = await local()
    const browser = await launch()
    const csrf = (await get('/api/auth/me', browser)).json().csrfToken as string
    const url = '/api/audit/export?format=csv'
    // A link is a navigation: no header. The cookie alone is refused.
    expect((await get(url, { cookie: browser.cookie })).statusCode).toBe(401)
    const ask = (path: string, who: { cookie?: string; key?: string; csrf?: string }) =>
      req('POST', '/api/auth/local/link', who, { path })
    // Only the page (its key) gets a ticket.
    expect((await ask('/api/audit/export', { cookie: browser.cookie, csrf })).statusCode).toBe(401)
    const ticket = (await ask('/api/audit/export', { ...browser, csrf })).json().ticket as string
    const first = await get(`${url}&mm_link=${ticket}`, { cookie: browser.cookie })
    expect(first.statusCode, first.body).toBe(200)
    expect((await get(`${url}&mm_link=${ticket}`, { cookie: browser.cookie })).statusCode).toBe(401)
    // A ticket is for its path, and its browser.
    const elsewhere = (await ask('/api/audit/export', { ...browser, csrf })).json().ticket as string
    expect((await get(`/api/connections?mm_link=${elsewhere}`, { cookie: browser.cookie })).statusCode).toBe(
      401,
    )
    const other = await launch()
    const theirs = (await ask('/api/audit/export', { ...browser, csrf })).json().ticket as string
    expect((await get(`${url}&mm_link=${theirs}`, { cookie: other.cookie })).statusCode).toBe(401)
  })

  // Second review (N2): a link the browser followed without its ticket (a middle-click that was
  // quicker) gets a page saying where to click it, not a JSON refusal.
  it('answers a link followed without its ticket with a page', async () => {
    const { t, launch } = await local()
    const browser = await launch()
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/audit/export?format=csv',
      headers: {
        ...BARE,
        cookie: `${NAME}=${browser.cookie}`,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'sec-fetch-mode': 'navigate',
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.body).toContain('Mongo Manager')
    expect(res.body).toContain('href="/"')
    // A request of the app's own still gets JSON.
    const api = await t.app.inject({
      method: 'GET',
      url: '/api/audit/export?format=csv',
      headers: { ...BARE, cookie: `${NAME}=${browser.cookie}`, accept: 'application/json' },
    })
    expect(api.json().details).toEqual({ reason: 'launch_required' })
  })

  it('signs every browser out, its open socket too', async () => {
    const { req, get, launch, socket } = await local()
    const a = await launch()
    const b = await launch()
    const csrf = (await get('/api/auth/me', a)).json().csrfToken as string
    const open = await socket({ ...BARE, cookie: `${NAME}=${b.cookie}` })
    const closed = new Promise<number>((r) => open.on('close', (code: number) => r(code)))
    const ready = new Promise<void>((r) => open.on('message', () => r()))
    open.send(JSON.stringify({ type: 'hello', csrf }))
    await ready
    const out = await req('POST', '/api/auth/local/sign-out-all', { ...a, csrf })
    expect(out.statusCode).toBe(204)
    expect(await closed).toBe(4401)
    expect((await get('/api/auth/status', a)).statusCode).toBe(401)
    expect((await get('/api/auth/status', b)).statusCode).toBe(401)
  })

  // Second review (minor 3): signing every browser out ends the local shells, a command running in
  // them too; the CLI asks a running server to do it through a link of its own kind.
  it('ends the local shells when every browser is signed out, from the app or the CLI', async () => {
    const { t, ctx, req, get, launch } = await local()
    const closed: Array<{ match: unknown; reason: string }> = []
    ;(ctx.shell as unknown as { closeFor: unknown }).closeFor = async (match: unknown, reason: string) => {
      closed.push({ match, reason })
    }
    const a = await launch()
    const csrf = (await get('/api/auth/me', a)).json().csrfToken as string
    expect((await req('POST', '/api/auth/local/sign-out-all', { ...a, csrf })).statusCode).toBe(204)
    expect(closed).toEqual([{ match: { userId: null }, reason: 'access' }])
    closed.length = 0
    const b = await launch()
    const forget = (token: string) =>
      t.app.inject({ method: 'POST', url: `/launch/forget/${token}`, headers: BARE })
    // A launch token is not a forget token, nor the other way round.
    expect((await forget(ctx.launch!.mint(LAUNCH_TTL_START_MS))).statusCode).toBe(401)
    const token = mintForgetToken(TEST_LAUNCH_SECRET, t.clock.now)
    expect((await get(`/launch/${token}`)).headers.location).toBe('/open-link?link=expired')
    const res = await forget(token)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ removed: 1 })
    expect(closed).toEqual([{ match: { userId: null }, reason: 'access' }])
    expect((await get('/api/auth/status', b)).statusCode).toBe(401)
    // Once only.
    expect((await forget(token)).statusCode).toBe(401)
  })

  it('works once, refuses HEAD, and stays used after a restart', async () => {
    const { ctx, req, get } = await local()
    const token = ctx.launch!.mint(LAUNCH_TTL_START_MS)
    const head = await req('HEAD', `/launch/${token}`)
    expect(head.statusCode).toBe(404)
    expect(cookieOf(head)).toBeUndefined()
    expect(cookieOf(await get(`/launch/${token}`))).toBeDefined()
    const again = await get(`/launch/${token}`)
    expect(again.headers.location).toBe('/open-link?link=expired')
    expect(cookieOf(again)).toBeUndefined()
  })

  it('refuses a wrong, expired, over-long or foreign token', async () => {
    const { t, ctx, get } = await local()
    const expired = ctx.launch!.mint(60_000)
    t.clock.now += 61_000
    const refused = [
      'nonsense',
      `${ctx.launch!.mint(60_000).slice(0, -2)}xx`,
      expired,
      mintLaunchToken(TEST_LAUNCH_SECRET, t.clock.now, 2 * 86_400_000),
      mintLaunchToken(randomBytes(32), t.clock.now),
    ]
    for (const token of refused) {
      const res = await get(`/launch/${token}`)
      expect(res.headers.location, token).toBe('/open-link?link=expired')
      expect(cookieOf(res), token).toBeUndefined()
    }
    expect(cookieOf(await get(`/launch/${mintLaunchToken(TEST_LAUNCH_SECRET, t.clock.now)}`))).toBeDefined()
  })

  it('never holds a real link back for others’ guesses, and answers a browser with a page', async () => {
    const { ctx, get } = await local()
    for (let i = 0; i < 30; i++) {
      const res = await get(`/launch/a.b.c${i}`)
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe('/open-link?link=expired')
    }
    const real = await get(`/launch/${ctx.launch!.mint(LAUNCH_TTL_START_MS)}`)
    expect(real.headers.location).toBe('/')
    expect(cookieOf(real)).toBeDefined()
    // Guesses are held back from the audit log.
    expect(ctx.audit.list({ action: 'auth.launch', limit: 500 }).length).toBeLessThan(15)
  })

  it('is audited, never with the token', async () => {
    const { ctx, get } = await local()
    const token = ctx.launch!.mint(LAUNCH_TTL_START_MS)
    await get(`/launch/${token}`)
    await get('/launch/wrong')
    const entries = ctx.audit.list({ action: 'auth.launch' })
    expect(entries.map((e) => e.outcome)).toEqual(['denied', 'success'])
    expect(JSON.stringify(entries)).not.toContain(token.split('.')[2])
  })

  it('keeps the cookie to the base path', async () => {
    const { ctx, t } = await local({ basePath: '/mm/' })
    const res = await t.app.inject({
      method: 'GET',
      url: `/mm/launch/${ctx.launch!.mint(LAUNCH_TTL_START_MS)}`,
      headers: BARE,
    })
    expect(res.headers.location).toBe('/mm/')
    expect(cookieOf(res)?.path).toBe('/mm/')
  })

  it('does not exist in team mode, which is unchanged', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    expect(t.app.ctx.launch).toBeNull()
    expect((await t.app.inject({ method: 'GET', url: '/launch/x', headers: BARE })).statusCode).toBe(404)
    const status = await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: BARE })
    expect(status.json()).toMatchObject({ mode: 'team', authenticated: false })
  })
})

describe('starting in local mode', () => {
  it('makes an owner-only secret once and gives a link that opens the app, once across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-launch-'))
    dirs.push(dir)
    const dataDir = join(dir, 'data')
    const logFile = join(dir, 'mm.log')
    const config = resolveConfig({ cli: { dataDir, webPort: 0, logLevel: 'info', logFile } })
    let server = await startServer(config, { logger: true })
    servers.push(server)
    const link = server.launchUrl!()
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/launch\/[0-9a-z]+\.[\w-]+\.[\w-]+$/)
    const res = await fetch(link, { redirect: 'manual' })
    expect(res.status).toBe(303)
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    const claimed = await fetch(new URL('api/auth/local/claim', server.url), {
      method: 'POST',
      headers: { cookie, origin: new URL(server.url).origin },
    })
    const { key } = (await claimed.json()) as { key: string }
    const me = await fetch(new URL('api/auth/me', server.url), { headers: { cookie, 'x-mm-local': key } })
    expect(me.status).toBe(200)
    expect((await fetch(new URL('api/auth/me', server.url), { headers: { cookie } })).status).toBe(401)
    const secret = readLaunchSecret(dataDir)!
    expect(loadOrCreateLaunchSecret(dataDir).equals(secret)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(join(dataDir, LAUNCH_FILE)).mode & 0o777).toBe(0o600)
    else expect(broadSids(join(dataDir, LAUNCH_FILE))).toEqual([])
    await server.close()
    servers.length = 0
    // A restart takes the used link no more; the browser it opened stays in.
    server = await startServer(config, { logger: true })
    servers.push(server)
    const replay = await fetch(link.replace(/:\d+\//, `:${new URL(server.url).port}/`), {
      redirect: 'manual',
    })
    expect(replay.headers.get('location')).toBe('/open-link?link=expired')
    const again = await fetch(new URL('api/auth/me', server.url), { headers: { cookie, 'x-mm-local': key } })
    expect(again.status).toBe(200)
    await server.close()
    servers.length = 0
    expect(readFileSync(logFile, 'utf8')).not.toContain(link.split('/launch/')[1]!)
    expect(readFileSync(logFile, 'utf8')).not.toContain(key)
    expect(readFileSync(logFile, 'utf8')).toContain('/launch/***')
  })

  it('makes no secret in team mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-launch-team-'))
    dirs.push(dir)
    const server = await startServer(resolveConfig({ cli: { dataDir: dir, webPort: 0, auth: true } }))
    servers.push(server)
    expect(server.launchUrl).toBeNull()
    expect(readLaunchSecret(dir)).toBeNull()
  })
})

/** Everyone, Users, Authenticated Users, Interactive — none may read the secret (Windows). */
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
