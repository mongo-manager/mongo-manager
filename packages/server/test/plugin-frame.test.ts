// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginAdminView } from '@mongo-manager/shared'
import { createHmac } from 'node:crypto'
import { H, makeApp, type TestApp } from './helpers'
import { helloPlugin } from './support/tar'
import { SESSION_ABSOLUTE_MS, hashSessionId } from '../src/auth/sessions'
import { hashPassword } from '../src/auth/passwords'
import { openSession, sealSession, signTicket, type FrameTicket } from '../src/plugins/frame'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

/** A ticket's base path as its payload (the JSON) and signature. */
const parts = (base: string) => {
  const [payload, mac] = base.slice('plugin-frame/'.length, -1).split('.')
  return { payload: Buffer.from(payload!, 'base64url').toString(), mac: mac! }
}
/** The ticket with some of its content changed, signed again with the server's key. */
const forge = (t: TestApp, base: string, change: Partial<FrameTicket>) =>
  `plugin-frame/${signTicket(t.app.ctx.pluginFrameKey, { ...(JSON.parse(parts(base).payload) as FrameTicket), ...change })}/`

async function setup(over: Record<string, unknown> = {}, extra: Parameters<typeof helloPlugin>[1] = []) {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const sessions: Record<string, string> = {}
  const as = (role: 'admin' | 'editor' | 'viewer') => {
    const user = ctx.users.create({
      username: `u-${role}-${Math.random().toString(36).slice(2, 8)}`,
      passwordHash: 'x',
      role,
    })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    sessions[role] = sessionId
    const headers = { ...H, 'x-csrf-token': session.csrfToken }
    return (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer, type?: string) =>
      t.app.inject({
        method,
        url: `/api/${url}`,
        headers: type ? { ...headers, 'content-type': type } : headers,
        cookies: { mm_sid: sessionId },
        ...(payload ? { payload } : {}),
      })
  }
  const admin = as('admin')
  await admin('PUT', 'plugins', helloPlugin(over, extra), 'application/gzip')
  const digest = async () =>
    ((await admin('GET', 'plugins/manage')).json() as { plugins: PluginAdminView[] }).plugins[0]!.digest!
  await admin('POST', 'plugins/hello/approve', { digest: await digest() })
  const viewer = as('viewer')
  const ticket = async () => {
    const res = await viewer('GET', 'plugins/hello/ticket')
    return res.json() as { base: string; entry: string; expiresAt: number }
  }
  /** A frame request: no cookie, no session — only the ticket in its path. */
  const frame = (path: string) => t.app.inject({ method: 'GET', url: `/${path}`, headers: { host: H.host } })
  return { t, admin, viewer, ticket, frame, sessions, root: join(t.dir, 'plugins', 'hello') }
}

describe('plugin frames (phase 4b §3)', () => {
  it('gives a signed-in user a ticket for an enabled plugin only', async () => {
    const { viewer, admin, ticket } = await setup()
    const tk = await ticket()
    expect(tk.base).toMatch(/^plugin-frame\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/$/)
    expect(tk.entry).toBe('index.html')
    expect((await viewer('GET', 'plugins/nope/ticket')).statusCode).toBe(404)
    await admin('POST', 'plugins/hello/disable')
    expect((await viewer('GET', 'plugins/hello/ticket')).statusCode).toBe(404)
  })

  it('serves a plugin page sandboxed however it is opened, without the network or a session', async () => {
    const { ticket, frame } = await setup()
    const tk = await ticket()
    const res = await frame(`${tk.base}${tk.entry}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    const csp = String(res.headers['content-security-policy'])
    // Opened in a tab of its own it is still sandboxed: never the app's origin.
    expect(csp).toMatch(/(^|; )sandbox allow-scripts(;|$)/)
    expect(csp).not.toContain('allow-same-origin')
    for (const d of [
      "default-src 'none'",
      `script-src http://${H.host}/${tk.base}`,
      "connect-src 'none'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ])
      expect(csp, d).toContain(d)
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['set-cookie']).toBeUndefined()
    const js = await frame(`${tk.base}app.js`)
    expect(js.statusCode).toBe(200)
    expect(js.headers['content-type']).toMatch(/^text\/javascript/)
    expect(js.body).toContain('postMessage')
  })

  // Security review 2026-10-13 (low): the app's own policy allows its origin's scripts, and plugin
  // files are on that origin — a page of the app could run one with the app's rights. A sandboxed
  // frame is an opaque origin: its requests are cross-site; the app's own are same-origin.
  it('serves a plugin’s files to its sandboxed frame only, never as the app’s own', async () => {
    const { t, ticket } = await setup()
    const tk = await ticket()
    const get = (path: string, site: string | null, dest: string) =>
      t.app.inject({
        method: 'GET',
        url: `/${tk.base}${path}`,
        headers: {
          host: H.host,
          'sec-fetch-dest': dest,
          ...(site ? { 'sec-fetch-site': site } : {}),
        },
      })
    // The app opens the frame (or a tab of it): a same-origin navigation.
    expect((await get(tk.entry, 'same-origin', 'iframe')).statusCode).toBe(200)
    expect((await get(tk.entry, 'same-origin', 'document')).statusCode).toBe(200)
    // The frame loads its files: cross-site, from its opaque origin.
    expect((await get('app.js', 'cross-site', 'script')).statusCode).toBe(200)
    // A page of the app loading them: refused, as a script, a worker or a style.
    for (const dest of ['script', 'worker', 'sharedworker', 'serviceworker', 'style', 'empty'])
      expect((await get('app.js', 'same-origin', dest)).statusCode, dest).toBe(403)
    expect((await get('app.js', 'same-site', 'script')).statusCode).toBe(403)
    // A browser that sends no metadata is served as before.
    expect((await get('app.js', null, 'script')).statusCode).toBe(200)
  })

  // Security review 2026-10-13 (ops): the request log kept every frame's ticket, good for hours.
  it('keeps frame tickets out of the request log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-frame-log-'))
    const logFile = join(dir, 'mm.log')
    try {
      const t = await makeApp({ auth: true, logFile, logLevel: 'info' }, { logger: true })
      apps.push(t)
      const res = await t.app.inject({ method: 'GET', url: '/plugin-frame/abc.def/index.html', headers: H })
      expect(res.statusCode).toBe(403)
      const log = readFileSync(logFile, 'utf8')
      expect(log).toContain('/plugin-frame/***/index.html')
      expect(log).not.toContain('abc.def')
    } finally {
      for (const t of apps.splice(0)) await t.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a forged, altered, expired or reused-elsewhere ticket', async () => {
    const { t, ticket, frame } = await setup()
    const tk = await ticket()
    const [payload, mac] = tk.base.slice('plugin-frame/'.length, -1).split('.')
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
    expect((await frame(`plugin-frame/${flip(payload!)}.${mac}/index.html`)).statusCode).toBe(403)
    expect((await frame(`plugin-frame/${payload}.${flip(mac!)}/index.html`)).statusCode).toBe(403)
    expect((await frame(`plugin-frame/garbage/index.html`)).statusCode).toBe(403)
    // A payload naming another plugin, signed by nobody.
    const other = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), p: 'other' }),
    ).toString('base64url')
    expect((await frame(`plugin-frame/${other}.${mac}/index.html`)).statusCode).toBe(403)
    t.clock.now += 11 * 60_000
    expect((await frame(`${tk.base}index.html`)).statusCode).toBe(403)
  })

  it('serves only the approved files, never a path outside them', async () => {
    const { ticket, frame, root } = await setup()
    writeFileSync(join(root, 'added-later.js'), 'evil()')
    const tk = await ticket()
    for (const path of [
      '../../plugins.db',
      '..%2F..%2Fsecret.key',
      '%2e%2e/%2e%2e/secret.key',
      'a\\..\\..\\x',
      'added-later.js',
      'mongo-manager-plugin.json/x',
      'missing.js',
      '',
    ])
      expect((await frame(`${tk.base}${path}`)).statusCode, path).toBeGreaterThanOrEqual(400)
  })

  it('stops serving a plugin the moment it is disabled, or its files change on disk', async () => {
    const { admin, ticket, frame, root } = await setup()
    const tk = await ticket()
    writeFileSync(join(root, 'app.js'), 'steal()')
    expect((await frame(`${tk.base}app.js`)).statusCode).toBe(404)
    expect((await frame(`${tk.base}index.html`)).statusCode).toBe(200)
    await admin('POST', 'plugins/hello/disable')
    expect((await frame(`${tk.base}index.html`)).statusCode).toBe(403)
  })

  it('adds an administrator-set tile server to the images a frame may load, nothing else', async () => {
    const { admin, ticket, frame } = await setup({
      settings: { tileUrl: { type: 'url', title: { en: 'Tiles' } } },
    })
    await admin('PUT', 'plugins/hello/settings', {
      values: { tileUrl: 'https://{s}.tile.example.org/{z}/{x}/{y}.png' },
    })
    const tk = await ticket()
    const csp = String((await frame(`${tk.base}index.html`)).headers['content-security-policy'])
    expect(csp).toContain(`img-src http://${H.host}/${tk.base} data: blob: https://*.tile.example.org;`)
    expect(csp).toContain("connect-src 'none'")
  })

  it('gives every page (html in any case, svg) the short window, and names its own files only', async () => {
    const { t, ticket, frame } = await setup({}, [
      { name: 'other.HTML', data: '<p>x</p>' },
      { name: 'pic.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
      { name: 'img.png', data: 'png' },
    ])
    const tk = await ticket()
    const csp = String((await frame(`${tk.base}index.html`)).headers['content-security-policy'])
    // The plugin's own files, not the whole app: never 'self'.
    expect(csp).not.toMatch(/(script|style|img|font)-src [^;]*'self'/)
    expect(csp).toContain(`script-src http://${H.host}/${tk.base};`)
    expect(csp).toContain("frame-ancestors 'self'")
    t.clock.now += 11 * 60_000
    for (const page of ['other.HTML', 'pic.svg'])
      expect((await frame(`${tk.base}${page}`)).statusCode, page).toBe(403)
    expect((await frame(`${tk.base}img.png`)).statusCode).toBe(200)
    const proto = await frame(`${tk.base}__proto__`)
    expect(proto.statusCode, proto.body).toBe(404)
    expect((await frame(`${tk.base}constructor`)).statusCode).toBe(404)
  })

  // Security audit 2026-10-16: a ticket was good for 8 hours whoever held it, signed out or not.
  it('binds a frame ticket to the session it was issued in: refused once that session ends', async () => {
    const { t, ticket, frame, sessions } = await setup({}, [{ name: 'img.png', data: 'png' }])
    const tk = await ticket()
    expect((await frame(`${tk.base}index.html`)).statusCode).toBe(200)
    expect((await frame(`${tk.base}img.png`)).statusCode).toBe(200)
    t.app.ctx.sessions.revoke(sessions.viewer!)
    expect((await frame(`${tk.base}index.html`)).statusCode).toBe(403)
    expect((await frame(`${tk.base}img.png`)).statusCode).toBe(403)
  })

  it('names its session in a ticket, sealed: the plugin reading its address learns nothing of it', async () => {
    const { t, ticket, frame, sessions } = await setup()
    const tk = await ticket()
    const { payload } = parts(tk.base)
    const key = t.app.ctx.pluginFrameKey
    const hash = hashSessionId(sessions.viewer!)
    expect(payload).not.toContain(hash)
    expect(payload).not.toContain(sessions.viewer!)
    const { s } = JSON.parse(payload) as FrameTicket
    // What it names is this session, readable with the server's key only.
    expect(openSession(key, s)).toBe(hash)
    expect(openSession(createHmac('sha256', 'other').digest(), s)).toBeNull()
    // A sealed reference changed by one character names no session.
    const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1)
    expect((await frame(`${forge(t, tk.base, { s: flipped })}index.html`)).statusCode).toBe(403)
  })

  // Review of the security pass (I5): an hour cut a page's lazy fonts off; the session check does the
  // revoking, so a page's files are served as long as its session lasts (at most its 12 hours).
  it('serves a page’s later files for as long as its session lasts, not for an hour only', async () => {
    const { t, ticket, frame, sessions } = await setup({}, [{ name: 'img.png', data: 'png' }])
    const tk = await ticket()
    // The user stays active: the session lives two hours on.
    for (let minutes = 0; minutes < 120; minutes += 20) {
      t.clock.now += 20 * 60_000
      t.app.ctx.sessions.get(sessions.viewer!)
    }
    const img = await frame(`${tk.base}img.png`)
    expect(img.statusCode).toBe(200)
    // Kept by no cache: signed out, the browser asks again and is refused.
    expect(img.headers['cache-control']).toBe('no-store')
    // Past the session's whole life, nothing.
    t.clock.now += SESSION_ABSOLUTE_MS
    expect((await frame(`${tk.base}img.png`)).statusCode).toBe(403)
  })

  it('refuses a ticket naming no session, a session that ended, or a user who was disabled', async () => {
    const { t, ticket, frame, sessions } = await setup()
    const tk = await ticket()
    const key = t.app.ctx.pluginFrameKey
    expect((await frame(`${forge(t, tk.base, { s: '' })}index.html`)).statusCode).toBe(403)
    expect(
      (await frame(`${forge(t, tk.base, { s: sealSession(key, hashSessionId('gone')) })}index.html`))
        .statusCode,
    ).toBe(403)
    // Another live session of another user is that user's: a ticket naming it is theirs, and ends with it.
    const other = t.app.ctx.users.create({ username: 'other-user', passwordHash: 'x', role: 'viewer' })
    const { sessionId } = t.app.ctx.sessions.create(other.id, {})
    const theirs = forge(t, tk.base, { s: sealSession(key, hashSessionId(sessionId)) })
    expect((await frame(`${theirs}index.html`)).statusCode).toBe(200)
    t.app.ctx.sessions.revoke(sessionId)
    expect((await frame(`${theirs}index.html`)).statusCode).toBe(403)
    // A user disabled (the session not yet swept) is refused too.
    expect((await frame(`${tk.base}index.html`)).statusCode).toBe(200)
    const viewer = t.app.ctx.sessions.get(sessions.viewer!)!
    t.app.ctx.users.setDisabled(viewer.userId, true)
    expect((await frame(`${tk.base}index.html`)).statusCode).toBe(403)
  })

  // Review of the security pass (I5): a sign-in in another tab, or a password change, renews the session
  // in place (a new id): the open page's tickets named the old one.
  it('keeps a page’s files coming when its session is renewed in place, never after a sign-out', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const password = 'Correct-horse-battery-9!'
    const user = ctx.users.create({
      username: 'ada',
      passwordHash: await hashPassword(password),
      role: 'admin',
    })
    const first = ctx.sessions.create(user.id, {})
    const call = (
      sid: string,
      csrf: string,
      method: 'GET' | 'POST' | 'PUT',
      url: string,
      payload?: object | Buffer,
      type?: string,
    ) =>
      t.app.inject({
        method,
        url: `/api/${url}`,
        headers: { ...H, 'x-csrf-token': csrf, ...(type ? { 'content-type': type } : {}) },
        cookies: { mm_sid: sid },
        ...(payload ? { payload } : {}),
      })
    const csrf = first.session.csrfToken
    await call(
      first.sessionId,
      csrf,
      'PUT',
      'plugins',
      helloPlugin({}, [{ name: 'img.png', data: 'png' }]),
      'application/gzip',
    )
    const digest = (
      (await call(first.sessionId, csrf, 'GET', 'plugins/manage')).json() as { plugins: PluginAdminView[] }
    ).plugins[0]!.digest!
    await call(first.sessionId, csrf, 'POST', 'plugins/hello/approve', { digest })
    const tk = (await call(first.sessionId, csrf, 'GET', 'plugins/hello/ticket')).json() as { base: string }
    const frame = (path: string) =>
      t.app.inject({ method: 'GET', url: `/${path}`, headers: { host: H.host } })
    // Signed in again in another tab of the same browser: the old session ends, a new one begins.
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      cookies: { mm_sid: first.sessionId },
      payload: { username: 'ada', password },
    })
    expect(login.statusCode).toBe(200)
    expect(ctx.sessions.get(first.sessionId)).toBeUndefined()
    expect((await frame(`${tk.base}img.png`)).statusCode).toBe(200)
    const second = login.cookies.find((c) => c.name === 'mm_sid')!.value
    // Another user signing in on that browser takes nothing over.
    ctx.users.create({ username: 'bob', passwordHash: await hashPassword(password), role: 'viewer' })
    const bob = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      cookies: { mm_sid: second },
      payload: { username: 'bob', password },
    })
    expect(bob.statusCode).toBe(200)
    expect((await frame(`${tk.base}img.png`)).statusCode).toBe(403)
    // Signed out: the page's files end with it.
    const third = ctx.sessions.create(user.id, {})
    const tk3 = (
      await call(third.sessionId, third.session.csrfToken, 'GET', 'plugins/hello/ticket')
    ).json() as {
      base: string
    }
    expect((await frame(`${tk3.base}img.png`)).statusCode).toBe(200)
    const out = await call(third.sessionId, third.session.csrfToken, 'POST', 'auth/logout')
    expect(out.statusCode).toBe(204)
    expect((await frame(`${tk3.base}img.png`)).statusCode).toBe(403)
  })

  it('serves a frame without sign-in in local mode, where there is no session', async () => {
    const t = await makeApp({ auth: false })
    apps.push(t)
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer, type?: string) =>
      t.app.inject({
        method,
        url: `/api/${url}`,
        headers: {
          ...H,
          'x-csrf-token': t.app.ctx.localCsrfToken,
          ...(type ? { 'content-type': type } : {}),
        },
        ...(payload ? { payload } : {}),
      })
    await call('PUT', 'plugins', helloPlugin(), 'application/gzip')
    const digest = ((await call('GET', 'plugins/manage')).json() as { plugins: PluginAdminView[] })
      .plugins[0]!.digest!
    await call('POST', 'plugins/hello/approve', { digest })
    const tk = (await call('GET', 'plugins/hello/ticket')).json() as { base: string; entry: string }
    expect(JSON.parse(parts(tk.base).payload).s).toBe('')
    const res = await t.app.inject({
      method: 'GET',
      url: `/${tk.base}${tk.entry}`,
      headers: { host: H.host },
    })
    expect(res.statusCode).toBe(200)
  })

  // Security audit 2026-10-16: connect-src does not cover WebRTC or prefetch hints.
  it('asks the browser to block WebRTC and DNS prefetching in a frame', async () => {
    const { ticket, frame } = await setup()
    const tk = await ticket()
    const res = await frame(`${tk.base}index.html`)
    expect(String(res.headers['content-security-policy'])).toContain("webrtc 'block'")
    expect(res.headers['x-dns-prefetch-control']).toBe('off')
  })

  it('serves an unknown kind of file as bytes, and an svg sandboxed', async () => {
    const { ticket, frame } = await setup({}, [
      { name: 'data.bin', data: 'x' },
      { name: 'icon.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
    ])
    const tk = await ticket()
    expect((await frame(`${tk.base}data.bin`)).headers['content-type']).toBe('application/octet-stream')
    const svg = await frame(`${tk.base}icon.svg`)
    expect(svg.headers['content-type']).toBe('image/svg+xml')
    expect(String(svg.headers['content-security-policy'])).toContain('sandbox allow-scripts')
  })
})
