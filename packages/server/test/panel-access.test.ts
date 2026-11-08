// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { H, makeApp, type TestApp } from './helpers'
import { openStore } from '../src/store/db'
import { ACCESS_RELOAD_MS, AccessList, accessRange, ownRange, rangesAllowing } from '../src/auth/accessList'
import { SettingsRepo } from '../src/store/settings'

/**
 * Panel access (2026-10-30): an administrator sets, in the app, the addresses the team-mode panel
 * answers. Saving shows who is signed in from where, warns when their own address is left out, and
 * ends every session from an address outside the list; the panel refuses other addresses from then.
 */
const PASSWORD = 'tarçın-kavanoz-42-mavi'
const OTHER = 'baska-parola-2026-yesil'
const ADMIN_IP = '203.0.113.10'
const BOB_IP = '198.51.100.20'
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'mm_sid')?.value

describe('an address range', () => {
  it('is read as an address or a CIDR range, in one form', () => {
    expect(accessRange(' 203.0.113.7 ')).toBe('203.0.113.7')
    expect(accessRange('203.0.113.0/24')).toBe('203.0.113.0/24')
    expect(accessRange('2001:DB8::/48')).toBe('2001:db8::/48')
    expect(accessRange('::ffff:192.0.2.1')).toBe('192.0.2.1')
    for (const bad of [
      'example.com',
      '10.0.0.0/0',
      '10.0.0.0/33',
      '::/129',
      'fe80::1%eth0',
      '1.2.3.4/8/9',
      '10.0.0.0/x',
      '',
    ])
      expect(accessRange(bad), bad).toBeNull()
  })

  it('lets in what it holds, and an empty list every address', () => {
    const allow = rangesAllowing(['203.0.113.0/24', '2001:db8::/48', '192.0.2.1'])
    for (const ip of ['203.0.113.200', '::ffff:203.0.113.5', '2001:db8:0:ffff::1', '192.0.2.1'])
      expect(allow(ip), ip).toBe(true)
    for (const ip of ['203.0.114.1', '2001:db9::1', '192.0.2.2', null])
      expect(allow(ip), String(ip)).toBe(false)
    expect(rangesAllowing([])('198.51.100.1')).toBe(true)
  })
})

describe('an address range, as it is kept (review of panel access, minor 5)', () => {
  it('is written one way, with the bits past its mask cleared, an IPv4-mapped one as IPv4', () => {
    expect(accessRange('203.0.113.7/24')).toBe('203.0.113.0/24')
    expect(accessRange('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1')
    expect(accessRange('2001:db8:0:0:1::1/48')).toBe('2001:db8::/48')
    expect(accessRange('::ffff:c000:201')).toBe('192.0.2.1')
    expect(accessRange('::ffff:10.0.0.0/104')).toBe('10.0.0.0/8')
    expect(accessRange('::ffff:10.0.0.0/8')).toBeNull()
    expect(accessRange('2001:db8:1:0:0:0:0:2')).toBe('2001:db8:1::2')
    expect(accessRange('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3')
  })

  // Review of panel access (I2): an IPv6 address rotates within its /64 (privacy addresses).
  it('takes an IPv6 address as its /64 for “my address”, an IPv4 one as it is', () => {
    expect(ownRange('2001:db8:1:2:a:b:c:d')).toBe('2001:db8:1:2::/64')
    expect(ownRange('fe80::1%eth0')).toBe('fe80::/64')
    expect(ownRange('203.0.113.9')).toBe('203.0.113.9')
    expect(ownRange('::ffff:203.0.113.9')).toBe('203.0.113.9')
  })
})

describe('the access list', () => {
  async function list() {
    const store = await openStore(mkdtempSync(join(tmpdir(), 'mm-access-')))
    const clock = { now: Date.UTC(2026, 0, 1) }
    const warned: string[] = []
    return {
      store,
      clock,
      warned,
      list: new AccessList(
        store.db,
        () => clock.now,
        (m) => warned.push(m),
      ),
    }
  }

  it('is read again within seconds, so a list cleared from the command line holds', async () => {
    const { store, clock, list: a } = await list()
    a.set([{ range: '203.0.113.0/24', label: 'Office' }])
    expect(a.allows('198.51.100.1')).toBe(false)
    new AccessList(store.db, () => clock.now).set([])
    expect(a.allows('198.51.100.1')).toBe(false)
    clock.now += ACCESS_RELOAD_MS
    expect(a.allows('198.51.100.1')).toBe(true)
  })

  it('lets no address in when nothing of the stored list reads, and says how to clear it', async () => {
    const { store, clock, list: a, warned } = await list()
    new SettingsRepo(store.db, () => clock.now).set('access.allowlist', {
      entries: [{ range: 'nope', label: '' }],
    })
    expect(a.allows('203.0.113.1')).toBe(false)
    expect(a.broken()).toBe(true)
    expect(warned).toEqual([expect.stringContaining('mongo-manager access clear')])
  })

  // Review of panel access (minor 2): a stricter later release must not lock the team out.
  it('leaves out only the entries that do not read, and reads the rest leniently', async () => {
    const { store, clock, list: a } = await list()
    new SettingsRepo(store.db, () => clock.now).set('access.allowlist', {
      entries: [
        { range: 'nope', label: '' },
        { range: '203.0.113.0/24', label: 7, extra: true },
      ],
    })
    expect(a.allows('203.0.113.1')).toBe(true)
    expect(a.allows('198.51.100.1')).toBe(false)
    expect(a.broken()).toBe(false)
    expect(a.current()).toEqual([{ range: '203.0.113.0/24', label: '' }])
  })
})

async function team() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const token = t.app.ctx.setup.ensureToken()
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: H,
    payload: { token, username: 'admin', password: PASSWORD },
    remoteAddress: ADMIN_IP,
  })
  const caller = (r: LightMyRequestResponse, ip: string) => {
    const session = { cookies: { mm_sid: sid(r)! }, csrf: r.json().csrfToken as string }
    return (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, from = ip, extra = {}) =>
      t.app.inject({
        method,
        url,
        headers: { ...H, 'x-csrf-token': session.csrf, ...extra },
        cookies: session.cookies,
        remoteAddress: from,
        ...(payload ? { payload } : {}),
      })
  }
  const admin = caller(res, ADMIN_IP)
  await admin('POST', '/api/users', {
    username: 'bob',
    password: OTHER,
    role: 'viewer',
    currentPassword: PASSWORD,
  })
  const login = (ip: string, username = 'bob', password = OTHER) =>
    t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { username, password },
      remoteAddress: ip,
    })
  const bob = caller(await login(BOB_IP), BOB_IP)
  const audit = (action: string) =>
    t.app.ctx.store.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as Array<{
      outcome: string
      details: string | null
    }>
  return { t, admin, bob, login, audit, caller }
}

describe('the panel access page', () => {
  it('shows the list, the address the administrator is on, and who is signed in from where', async () => {
    const { admin } = await team()
    const res = await admin('GET', '/api/users/access')
    expect(res.json()).toMatchObject({
      entries: [],
      yourAddress: ADMIN_IP,
      yourRange: ADMIN_IP,
      youAllowed: true,
      untrustedProxy: false,
    })
    const sessions = res.json().sessions as Array<{
      username: string
      ip: string
      current: boolean
      allowed: boolean
    }>
    expect(sessions.map((s) => [s.username, s.ip, s.current, s.allowed]).sort()).toEqual([
      ['admin', ADMIN_IP, true, true],
      ['bob', BOB_IP, false, true],
    ])
  })

  it('previews a list: which entries do not read, who would be signed out, and whether it leaves you out', async () => {
    const { admin } = await team()
    const res = await admin('POST', '/api/users/access/preview', {
      entries: [
        { range: '198.51.100.0/24', label: 'Office' },
        { range: 'office.example', label: '' },
        { range: '198.51.100.0/24', label: 'twice' },
      ],
    })
    expect(res.json()).toMatchObject({
      entries: [{ range: '198.51.100.0/24', label: 'Office' }],
      invalid: [1],
      youAllowed: false,
    })
    const byUser = Object.fromEntries(
      (res.json().sessions as Array<{ username: string; allowed: boolean }>).map((s) => [
        s.username,
        s.allowed,
      ]),
    )
    expect(byUser).toEqual({ admin: false, bob: true })
  })

  it('says when requests come through a proxy nobody named as trusted', async () => {
    const { admin } = await team()
    expect((await admin('GET', '/api/users/access')).json().untrustedProxy).toBe(false)
    const res = await admin('GET', '/api/users/access', undefined, ADMIN_IP, {
      'x-forwarded-for': '192.0.2.50',
    })
    expect(res.json()).toMatchObject({ untrustedProxy: true, yourAddress: ADMIN_IP })
  })
})

describe('saving the list', () => {
  it('asks for the administrator’s password, and for their word when it leaves their address out', async () => {
    const { t, admin } = await team()
    const office = [{ range: '198.51.100.0/24', label: 'Office' }]
    expect((await admin('PUT', '/api/users/access', { entries: office })).json()).toMatchObject({
      details: { reason: 'wrong_password' },
    })
    expect(
      (await admin('PUT', '/api/users/access', { entries: office, password: PASSWORD })).json(),
    ).toMatchObject({
      details: { reason: 'access_excludes_you', address: ADMIN_IP },
    })
    expect(
      (
        await admin('PUT', '/api/users/access', {
          entries: [{ range: 'office.example', label: '' }],
          password: PASSWORD,
        })
      ).json(),
    ).toMatchObject({ details: { reason: 'access_invalid', invalid: [0] } })
    expect(t.app.ctx.accessList.current()).toEqual([])
  })

  it('ends every session outside the list, and refuses those addresses from then on', async () => {
    const { t, admin, bob, login, audit } = await team()
    const res = await admin('PUT', '/api/users/access', {
      entries: [
        { range: `${ADMIN_IP}`, label: 'Me' },
        { range: '192.0.2.0/24', label: 'VPN' },
      ],
      password: PASSWORD,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      youAllowed: true,
      sessions: [expect.objectContaining({ username: 'admin' })],
    })
    expect(res.json().sessions).toHaveLength(1)
    // Bob's session ended; from his address nothing answers, the sign-in neither.
    const refused = await bob('GET', '/api/auth/me')
    expect(refused.statusCode).toBe(403)
    expect(refused.json()).toMatchObject({ details: { reason: 'ip_not_allowed', address: BOB_IP } })
    expect((await login(BOB_IP)).json()).toMatchObject({ details: { reason: 'ip_not_allowed' } })
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/status', remoteAddress: BOB_IP })).json(),
    ).toMatchObject({ details: { reason: 'ip_not_allowed' } })
    // From a range in the list, bob signs in.
    expect((await login('192.0.2.77')).statusCode).toBe(200)
    // The health checks answer every address.
    expect((await t.app.inject({ method: 'GET', url: '/healthz', remoteAddress: BOB_IP })).statusCode).toBe(
      200,
    )
    expect((await admin('GET', '/api/auth/me')).statusCode).toBe(200)
    expect(audit('users.access').map((r) => [r.outcome, JSON.parse(r.details!)])).toEqual([
      [
        'success',
        expect.objectContaining({ ranges: [ADMIN_IP, '192.0.2.0/24'], signedOut: 1, lockedOut: false }),
      ],
    ])
  })

  it('refuses the socket, plugin frames and the OIDC callback outside the list too', async () => {
    const { t, admin } = await team()
    await admin('PUT', '/api/users/access', { entries: [{ range: ADMIN_IP, label: '' }], password: PASSWORD })
    for (const url of ['/ws', '/plugin-frame/some-ticket/index.html', '/oidc/callback?state=s&code=c']) {
      const res = await t.app.inject({ method: 'GET', url, headers: H, remoteAddress: BOB_IP })
      expect(res.json(), url).toMatchObject({ details: { reason: 'ip_not_allowed' } })
    }
  })

  // Review of panel access (minor 3): a socket is judged by its own address, not its session's.
  it('closes an open socket from an address the list no longer lets in', async () => {
    const { t } = await team()
    await t.app.ready()
    const user = t.app.ctx.users.findByUsername('bob')!
    const { sessionId, session } = t.app.ctx.sessions.create(user.id, { ip: '127.0.0.1' })
    let closedWith!: (code: number) => void
    const closed = new Promise<number>((r) => (closedWith = r))
    let readied!: () => void
    const ready = new Promise<void>((r) => (readied = r))
    const request = {
      headers: { ...H, cookie: `mm_sid=${sessionId}` },
      socket: { encrypted: false, remoteAddress: '127.0.0.1' },
    } as never
    const ws = await t.app.injectWS('/ws', request, {
      onInit: (socket) => {
        socket.on('ping', () => socket.pong())
        socket.on('message', (data) => {
          if (JSON.parse(String(data)).type === 'ready') readied()
        })
        socket.on('close', (code) => closedWith(code))
      },
    })
    ws.send(JSON.stringify({ type: 'hello', csrf: session.csrfToken }))
    await ready
    // A list that still lets it in leaves it open.
    t.app.ctx.accessList.set([{ range: '127.0.0.1', label: '' }])
    t.app.ctx.access.changed()
    const early = await Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), 150))])
    expect(early).toBe('open')
    t.app.ctx.accessList.set([{ range: ADMIN_IP, label: '' }])
    t.app.ctx.access.changed()
    await expect(closed).resolves.toBeGreaterThan(0)
  })

  it('refuses a label with control characters', async () => {
    const { admin } = await team()
    const res = await admin('POST', '/api/users/access/preview', {
      entries: [{ range: ADMIN_IP, label: 'a' + String.fromCharCode(27) + '[2J' }],
    })
    expect(res.statusCode).toBe(400)
  })

  it('ends a session brought from an address outside the list', async () => {
    const { t, admin } = await team()
    await admin('PUT', '/api/users/access', { entries: [{ range: ADMIN_IP, label: '' }], password: PASSWORD })
    const elsewhere = await admin('GET', '/api/auth/me', undefined, '198.51.100.99')
    expect(elsewhere.json()).toMatchObject({ details: { reason: 'ip_not_allowed' } })
    expect((await admin('GET', '/api/auth/me')).statusCode).toBe(401)
    expect(t.app.ctx.sessions.listActive().filter((s) => s.username === 'admin')).toEqual([])
  })

  it('locks the administrator out only when they said so, and an empty list lets everyone back', async () => {
    const { t, admin, login } = await team()
    const res = await admin('PUT', '/api/users/access', {
      entries: [{ range: BOB_IP, label: '' }],
      password: PASSWORD,
      lockMeOut: true,
    })
    expect(res.statusCode).toBe(200)
    expect((await admin('GET', '/api/auth/me')).statusCode).toBe(403)
    expect((await login(ADMIN_IP, 'admin', PASSWORD)).json()).toMatchObject({
      details: { reason: 'ip_not_allowed' },
    })
    const bobs = await login(BOB_IP)
    expect(bobs.statusCode).toBe(200)
    // The command line's clear (or an empty list) lets every address in again.
    t.app.ctx.accessList.set([])
    expect((await login(ADMIN_IP, 'admin', PASSWORD)).statusCode).toBe(200)
  })

  it('is for administrators only', async () => {
    const { bob, t } = await team()
    for (const [method, url, payload] of [
      ['GET', '/api/users/access', undefined],
      ['POST', '/api/users/access/preview', { entries: [] }],
      ['PUT', '/api/users/access', { entries: [{ range: BOB_IP, label: '' }], password: OTHER }],
    ] as const)
      expect((await bob(method, url, payload)).statusCode, url).toBe(403)
    expect(t.app.ctx.accessList.current()).toEqual([])
  })
})

describe('local mode', () => {
  it('has no list to keep: it answers only this computer anyway', async () => {
    const t = await makeApp()
    apps.push(t)
    t.app.ctx.accessList.set([{ range: '203.0.113.1', label: '' }])
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: H })
    expect(res.statusCode).toBe(200)
  })
})
