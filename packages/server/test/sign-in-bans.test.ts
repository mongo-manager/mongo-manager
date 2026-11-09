// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { openStore } from '../src/store/db'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BAN_FAILURES,
  BAN_FAILURES_48,
  BAN_LIST_MAX,
  BAN_STEPS_MS,
  BAN_WINDOW_MS,
  STRIKE_MEMORY_MS,
  SignInBans,
  banAddress,
  banNetwork,
  banTarget,
  isLoopbackIp,
  plainIp,
} from '../src/auth/bans'
import { PasswordWork } from '../src/auth/passwordWork'
import { SIGN_IN_RATE_LIMIT } from '../src/routes/auth'

/**
 * Sign-in bans (2026-10-30): an address that keeps failing at the team-mode sign-in is refused there,
 * at once and longer each time, across restarts; an administrator sees, blocks and lifts; a flood of
 * sign-ins from many addresses waits for a few password checks at a time or is refused as busy.
 */
const MIN = 60_000
const PASSWORD = 'tarçın-kavanoz-42-mavi'
const OTHER = 'baska-parola-2026-yesil'
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function bansAt(opts: { trustsProxies?: boolean; maxAddresses?: number } = {}) {
  const store = await openStore(mkdtempSync(join(tmpdir(), 'mm-bans-')))
  const clock = { now: Date.UTC(2026, 0, 1) }
  return { store, clock, bans: new SignInBans(store.db, () => clock.now, opts) }
}
const strike = (bans: SignInBans, ip: string) => {
  let ban = null
  for (let i = 0; i < BAN_FAILURES; i++) ban = bans.note(ip)
  return ban!
}

describe('the sign-in bans', () => {
  it('ban an address at its 30th failure in 15 minutes, for 15 minutes', async () => {
    const { bans, clock } = await bansAt()
    for (let i = 1; i < BAN_FAILURES; i++) expect(bans.note('203.0.113.7')).toBeNull()
    expect(bans.bannedUntil('203.0.113.7')).toBe(0)
    const ban = bans.note('203.0.113.7')
    expect(ban).toMatchObject({ address: '203.0.113.7', reason: 'sign_in', strikes: 1, by: null })
    expect(ban!.until - ban!.bannedAt).toBe(15 * MIN)
    expect(bans.current('203.0.113.7')).toEqual({ reason: 'sign_in', until: clock.now + 15 * MIN })
    // Another address is not touched.
    expect(bans.bannedUntil('203.0.113.8')).toBe(0)
    clock.now += 15 * MIN
    expect(bans.bannedUntil('203.0.113.7')).toBe(0)
  })

  it('forget failures older than the window', async () => {
    const { bans, clock } = await bansAt()
    for (let i = 1; i < BAN_FAILURES; i++) bans.note('198.51.100.1')
    clock.now += BAN_WINDOW_MS
    expect(bans.note('198.51.100.1')).toBeNull()
  })

  it('count nothing from an address already banned, so its ban never grows', async () => {
    const { bans } = await bansAt()
    strike(bans, '203.0.113.7')
    const until = bans.bannedUntil('203.0.113.7')
    for (let i = 0; i < 3 * BAN_FAILURES; i++) expect(bans.note('203.0.113.7')).toBeNull()
    expect(bans.bannedUntil('203.0.113.7')).toBe(until)
    expect(bans.list().total).toBe(1)
  })

  it('ban longer each time an address comes back within a week, and forget it after', async () => {
    const { bans, clock } = await bansAt()
    for (const [i, ms] of [...BAN_STEPS_MS, BAN_STEPS_MS.at(-1)!].entries()) {
      const ban = strike(bans, '203.0.113.7')
      expect(ban.strikes).toBe(i + 1)
      expect(ban.until - ban.bannedAt).toBe(ms)
      clock.now = ban.until
    }
    expect(BAN_STEPS_MS.map((ms) => ms / MIN)).toEqual([15, 60, 360, 1440])
    clock.now += STRIKE_MEMORY_MS + 1
    expect(strike(bans, '203.0.113.7')).toMatchObject({ strikes: 1 })
  })

  it('never ban this machine', async () => {
    const { bans } = await bansAt({ trustsProxies: true })
    for (const ip of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) {
      expect(isLoopbackIp(ip), ip).toBe(true)
      expect(bans.exemption(ip), ip).toBe('loopback')
      for (let i = 0; i < 2 * BAN_FAILURES; i++) expect(bans.note(ip)).toBeNull()
      expect(bans.bannedUntil(ip)).toBe(0)
    }
    for (const ip of ['::2', '10.0.0.1', '::ffff:10.0.0.1', 'localhost', ''])
      expect(isLoopbackIp(ip), ip).toBe(false)
  })

  // Review of the bans (I2): with no proxy named, the Docker gateway (a private address) carries
  // every client; banning it would ban the team. Named proxies make addresses real: then they are.
  it('never ban a private address while no proxy is trusted, and do once one is', async () => {
    const untrusted = (await bansAt()).bans
    const trusted = (await bansAt({ trustsProxies: true })).bans
    for (const ip of [
      '10.1.2.3',
      '172.31.240.1',
      '192.168.1.9',
      '100.64.0.1',
      '169.254.1.1',
      'fd00::5',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(untrusted.exemption(ip), ip).toBe('private')
      expect(strike(untrusted, ip), ip).toBeNull()
      expect(trusted.exemption(ip), ip).toBeNull()
      expect(strike(trusted, ip), ip).toMatchObject({ strikes: 1 })
    }
    for (const ip of ['172.32.0.1', '198.18.0.1', '2001:db8::1'])
      expect(untrusted.exemption(ip), ip).toBeNull()
  })

  it('hold an IPv6 address by its /64, as the throttle does', async () => {
    const { bans } = await bansAt()
    expect(banAddress('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(banAddress('::ffff:192.0.2.4')).toBe('192.0.2.4')
    for (let i = 0; i < BAN_FAILURES; i++) bans.note(`2001:db8:1:2::${i + 1}`)
    expect(bans.bannedUntil('2001:db8:1:2:ffff::9')).toBeGreaterThan(0)
    expect(bans.bannedUntil('2001:db8:1:3::1')).toBe(0)
  })

  // Review of the bans (I4): a /48 holds 65,536 /64s; rotating through them bans the /48.
  it('ban an IPv6 /48 whose /64s keep failing in turn', async () => {
    const { bans } = await bansAt()
    expect(banNetwork('2001:db8:7:abcd::1')).toBe('2001:db8:7::/48')
    expect(banNetwork('203.0.113.7')).toBeNull()
    let ban = null
    for (let i = 0; i < BAN_FAILURES_48; i++) ban = bans.note(`2001:db8:7:${(i % 200).toString(16)}::1`)
    expect(ban).toMatchObject({ address: '2001:db8:7::/48', reason: 'sign_in', strikes: 1 })
    expect(bans.bannedUntil('2001:db8:7:ffff::9')).toBeGreaterThan(0)
    expect(bans.bannedUntil('2001:db8:8::1')).toBe(0)
    expect(bans.lift('2001:db8:7::/48')).toBe('lifted')
    expect(bans.bannedUntil('2001:db8:7:ffff::9')).toBe(0)
  })

  it('outlive a restart, and lift with the strikes forgotten', async () => {
    const { bans, store, clock } = await bansAt()
    strike(bans, '203.0.113.7')
    const again = new SignInBans(store.db, () => clock.now)
    expect(again.bannedUntil('203.0.113.7')).toBeGreaterThan(clock.now)
    expect(again.lift('203.0.113.7')).toBe('lifted')
    expect(again.lift('203.0.113.7')).toBe('none')
    expect(bans.bannedUntil('203.0.113.7')).toBe(0)
    expect(strike(again, '203.0.113.7')).toMatchObject({ strikes: 1 })
    // An ended ban's record is forgotten by a lift, and said apart.
    clock.now += 16 * MIN
    expect(again.lift('203.0.113.7')).toBe('forgotten')
    expect(strike(again, '203.0.113.7')).toMatchObject({ strikes: 1 })
  })

  it('lift every ban and every record of one', async () => {
    const { bans, clock } = await bansAt()
    strike(bans, '203.0.113.7')
    clock.now += 16 * MIN
    strike(bans, '198.51.100.7')
    bans.block('198.51.100.8', 60 * MIN, 'admin')
    expect(bans.liftAll()).toBe(2)
    expect(bans.list()).toEqual({ bans: [], total: 0 })
    expect(strike(bans, '203.0.113.7')).toMatchObject({ strikes: 1 })
  })

  it('block an address for a while, keeping its strikes, never shortening a ban, longest first', async () => {
    const { bans, clock } = await bansAt()
    strike(bans, '203.0.113.7')
    const manual = bans.block('203.0.113.7', 24 * 60 * MIN, 'admin')
    expect(manual).toMatchObject({
      reason: 'manual',
      strikes: 1,
      by: 'admin',
      until: clock.now + 24 * 60 * MIN,
    })
    // Review of the bans (minor 1): a shorter block leaves the longer ban as it was.
    expect(bans.block('203.0.113.7', 60 * MIN, 'mallory').until).toBe(clock.now + 24 * 60 * MIN)
    bans.block('198.51.100.9', 60 * MIN, 'admin')
    expect(bans.list().bans.map((b) => b.address)).toEqual(['203.0.113.7', '198.51.100.9'])
    clock.now += 61 * MIN
    expect(bans.list().bans.map((b) => b.address)).toEqual(['203.0.113.7'])
  })

  it('list at most 500, with how many there are', async () => {
    const { bans } = await bansAt()
    for (let i = 0; i < BAN_LIST_MAX + 3; i++)
      bans.block(`198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`, MIN, 'a')
    const { bans: shown, total } = bans.list()
    expect(shown).toHaveLength(BAN_LIST_MAX)
    expect(total).toBe(BAN_LIST_MAX + 3)
  })

  it('keep memory bounded under a flood from many addresses', async () => {
    const { bans } = await bansAt({ maxAddresses: 100 })
    for (let i = 0; i < BAN_FAILURES - 1; i++) bans.note('203.0.113.7')
    for (let i = 0; i < 1_000; i++) bans.note(`198.18.${Math.floor(i / 250)}.${(i % 250) + 1}`)
    expect((bans as unknown as { failures: Map<string, unknown> }).failures.size).toBeLessThanOrEqual(100)
  })

  it('read an address as an administrator types it, and a ban as it is shown', () => {
    expect(plainIp(' 203.0.113.7 ')).toBe('203.0.113.7')
    expect(plainIp('2001:db8::1')).toBe('2001:db8::1')
    expect(plainIp('::ffff:192.0.2.1')).toBe('::ffff:192.0.2.1')
    for (const bad of ['::ffff:a00:1', 'fe80::1%eth0', '::', '0.0.0.0', '10.0.0.0/8', 'example.com', ''])
      expect(plainIp(bad), bad).toBeNull()
    expect(banTarget('2001:DB8:1:2::/64')).toBe('2001:db8:1:2::/64')
    expect(banTarget('2001:db8:7::/48')).toBe('2001:db8:7::/48')
    expect(banTarget('2001:db8:7:9:1::5')).toBe('2001:db8:7:9::/64')
    expect(banTarget('203.0.113.7')).toBe('203.0.113.7')
    for (const bad of ['2001:db8::/32', '203.0.113.0/24', 'nope']) expect(banTarget(bad), bad).toBeNull()
  })
})

describe('the sign-in’s password checks', () => {
  it('run a few at a time, the rest waiting in turn, and refuse past the queue', async () => {
    const work = new PasswordWork(2, 2, 1)
    let running = 0
    let most = 0
    const order: number[] = []
    const releases: Array<() => void> = []
    const job = (n: number) =>
      work.run(async () => {
        running += 1
        most = Math.max(most, running)
        await new Promise<void>((r) => releases.push(r))
        running -= 1
        order.push(n)
      })
    const all = [1, 2, 3, 4].map((n) => {
      work.admit()
      return job(n)
    })
    expect(() => work.admit()).toThrow(expect.objectContaining({ code: 'RATE_LIMITED', statusCode: 429 }))
    // A place is kept for an account where it signed in lately.
    work.admit(true)
    all.push(job(5))
    expect(() => work.admit(true)).toThrow(expect.objectContaining({ code: 'RATE_LIMITED' }))
    while (order.length < 5) {
      await new Promise((r) => setTimeout(r, 0))
      releases.shift()?.()
    }
    await Promise.all(all)
    expect(most).toBe(2)
    expect(order).toEqual([1, 2, 3, 4, 5])
    expect(() => work.admit()).not.toThrow()
  })

  it('give the place back when a check fails', async () => {
    const work = new PasswordWork(1, 0)
    await expect(work.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(() => work.admit()).not.toThrow()
  })

  it('report busy refusals at most once a minute, with how many there were', () => {
    const work = new PasswordWork()
    expect(work.refused(0)).toBe(1)
    expect(work.refused(10_000)).toBeNull()
    expect(work.refused(20_000)).toBeNull()
    expect(work.refused(60_000)).toBe(3)
  })
})

const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'mm_sid')?.value

async function team() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const token = t.app.ctx.setup.ensureToken()
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: H,
    payload: { token, username: 'admin', password: PASSWORD },
    remoteAddress: '192.0.2.1',
  })
  const session = { cookies: { mm_sid: sid(res)! }, csrf: res.json().csrfToken as string }
  const admin = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { ...H, 'x-csrf-token': session.csrf },
      cookies: session.cookies,
      remoteAddress: '192.0.2.1',
      ...(payload ? { payload } : {}),
    })
  await admin('POST', '/api/users', {
    username: 'bob',
    password: OTHER,
    role: 'viewer',
    currentPassword: PASSWORD,
  })
  const login = (ip: string, username: string, password: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { username, password },
      remoteAddress: ip,
    })
  const audit = (action: string) =>
    t.app.ctx.store.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as Array<{
      ip: string | null
      outcome: string
      details: string | null
    }>
  const noted = () => {
    const seen: string[] = []
    const real = t.app.ctx.bans.note.bind(t.app.ctx.bans)
    t.app.ctx.bans.note = (ip) => (seen.push(ip), real(ip))
    return seen
  }
  return { t, admin, login, audit, noted }
}

describe('a banned address at the sign-in', () => {
  it('is banned by its own failures, writes one audit row, and is refused before any password', async () => {
    const { t, login, audit } = await team()
    const before = audit('auth.login').length
    // Failures, then refusals by the throttle: all count. Each guess is 20 s apart, so the
    // per-minute budget never refuses one.
    for (let i = 0; i < BAN_FAILURES; i++) {
      await login('203.0.113.7', `user${i}`, 'wrong-password-123')
      t.clock.now += 20_000
    }
    expect(t.app.ctx.bans.bannedUntil('203.0.113.7')).toBeGreaterThan(t.clock.now)
    const refused = await login('203.0.113.7', 'bob', OTHER)
    expect(refused.statusCode).toBe(429)
    expect(refused.json()).toMatchObject({
      code: 'RATE_LIMITED',
      details: { reason: 'address_banned', retryAfterMs: expect.any(Number) },
    })
    expect(sid(refused)).toBeUndefined()
    // Elsewhere, bob signs in.
    expect((await login('198.51.100.20', 'bob', OTHER)).statusCode).toBe(200)
    const bans = audit('auth.ban')
    expect(bans).toHaveLength(1)
    expect(bans[0]).toMatchObject({ ip: '203.0.113.7', outcome: 'denied' })
    expect(JSON.parse(bans[0]!.details!)).toMatchObject({ address: '203.0.113.7', strikes: 1, minutes: 15 })
    // The refusals that checked nothing are no rows of their own: one per failed password only.
    const rows = audit('auth.login').slice(before)
    expect(rows.every((r) => JSON.parse(r.details!).status !== 429)).toBe(true)
  })

  it('still lets an account that signed in from there lately past a ban by failures, its guesses held back', async () => {
    const { t, login } = await team()
    expect((await login('203.0.113.7', 'bob', OTHER)).statusCode).toBe(200)
    strike(t.app.ctx.bans, '203.0.113.7')
    expect((await login('203.0.113.7', 'admin', PASSWORD)).json()).toMatchObject({
      details: { reason: 'address_banned' },
    })
    expect((await login('203.0.113.7', 'BOB', OTHER)).statusCode).toBe(200)
    for (let i = 0; i < 6; i++) await login('203.0.113.7', 'bob', 'wrong-password-123')
    expect((await login('203.0.113.7', 'bob', OTHER)).statusCode).toBe(429)
  })

  // Review of the bans (I1): the account an administrator blocked an address for may be that one.
  it('holds an administrator’s block for everyone, before the body is read', async () => {
    const { t, login } = await team()
    expect((await login('203.0.113.8', 'bob', OTHER)).statusCode).toBe(200)
    t.app.ctx.bans.block('203.0.113.8', 60 * MIN, 'admin')
    expect((await login('203.0.113.8', 'bob', OTHER)).json()).toMatchObject({
      details: { reason: 'address_banned' },
    })
    const unread = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { nothing: true },
      remoteAddress: '203.0.113.8',
    })
    expect(unread.json()).toMatchObject({ details: { reason: 'address_banned' } })
  })

  it('refuses the first-run setup too', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const token = t.app.ctx.setup.ensureToken()
    strike(t.app.ctx.bans, '203.0.113.7')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: H,
      payload: { token, username: 'admin', password: PASSWORD },
      remoteAddress: '203.0.113.7',
    })
    expect(res.json()).toMatchObject({ details: { reason: 'address_banned' } })
    expect(t.app.ctx.users.count()).toBe(0)
  })

  // Review of the bans (minor 3): a ticket got before the ban does not outlive it there.
  it('refuses a second step there with a ticket from before the ban', async () => {
    const { t } = await team()
    const bob = t.app.ctx.users.findByUsername('bob')!
    const ticket = t.app.ctx.tickets.issue(bob.id, bob.passwordHash)
    strike(t.app.ctx.bans, '203.0.113.9')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login/recovery',
      headers: H,
      payload: { ticket, code: 'abcd-efgh' },
      remoteAddress: '203.0.113.9',
    })
    expect(res.json()).toMatchObject({ details: { reason: 'address_banned' } })
  })

  it('counts nothing for a sign-in ticket that stands for nobody', async () => {
    const { t, noted } = await team()
    const seen = noted()
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: H,
      payload: { ticket: 'no-such-ticket', code: '123456' },
      remoteAddress: '203.0.113.9',
    })
    expect(res.statusCode).toBe(401)
    expect(seen).toEqual([])
  })

  // Review of the bans (minor 2): guesses from elsewhere held the account back; its owner retrying
  // from a new address must not get that address banned for it.
  it('counts no refusal where only the account is held back', async () => {
    const { t, login, noted } = await team()
    for (let i = 0; i < 60; i++) t.app.ctx.throttle.recordFailure('account:bob')
    const seen = noted()
    expect((await login('203.0.113.70', 'bob', OTHER)).statusCode).toBe(429)
    expect(seen).toEqual([])
  })

  it('never bans this machine, or a private address while no proxy is trusted', async () => {
    const { t, login } = await team()
    for (const ip of ['127.0.0.1', '172.31.240.1']) {
      for (let i = 0; i < BAN_FAILURES + 5; i++) {
        await login(ip, `user${i}`, 'wrong-password-123')
        t.clock.now += 20_000
      }
    }
    expect(t.app.ctx.bans.list().total).toBe(0)
  })

  it('shares one budget per address and minute across the sign-in steps', async () => {
    const { t } = await team()
    const step = (url: string, payload: object) =>
      t.app.inject({ method: 'POST', url, headers: H, payload, remoteAddress: '198.51.100.77' })
    for (let i = 0; i < SIGN_IN_RATE_LIMIT / 2; i++) {
      await step('/api/auth/login', { username: `u${i}`, password: 'wrong-password-123' })
      await step('/api/auth/login/recovery', { ticket: 'none', code: 'abcd-efgh' })
    }
    const over = await step('/api/auth/login', { username: 'bob', password: OTHER })
    expect(over.statusCode).toBe(429)
    // Another address has its own.
    const other = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { username: 'bob', password: OTHER },
      remoteAddress: '198.51.100.78',
    })
    expect(other.statusCode).toBe(200)
  })

  it('is refused as busy when the checks are full — the account never counted, once a minute in the log', async () => {
    const { t, login, audit } = await team()
    t.app.ctx.passwordWork = new PasswordWork(0, 0, 0)
    for (const ip of ['198.51.100.5', '198.51.100.6']) {
      const res = await login(ip, 'bob', OTHER)
      expect(res.json()).toMatchObject({ code: 'RATE_LIMITED', details: { reason: 'server_busy' } })
    }
    expect(t.app.ctx.throttle.retryAfterMs('ip:198.51.100.5')).toBe(0)
    expect(audit('auth.busy').map((r) => JSON.parse(r.details!))).toEqual([{ refused: 1 }])
    expect(audit('auth.login').filter((r) => JSON.parse(r.details!).status === 429)).toEqual([])
    t.app.ctx.passwordWork = new PasswordWork()
    for (let i = 0; i < 5; i++) await login('198.51.100.5', 'bob', 'wrong-password-123')
    expect((await login('198.51.100.5', 'bob', OTHER)).statusCode).toBe(200)
  })

  it('keeps a place for an account where it signed in lately while the checks are full', async () => {
    const { t, login } = await team()
    expect((await login('198.51.100.9', 'bob', OTHER)).statusCode).toBe(200)
    const work = new PasswordWork(1, 0, 1)
    t.app.ctx.passwordWork = work
    let release = () => {}
    const held = work.run(() => new Promise<void>((r) => (release = r)))
    expect((await login('198.51.100.10', 'admin', PASSWORD)).json()).toMatchObject({
      details: { reason: 'server_busy' },
    })
    const known = login('198.51.100.9', 'bob', OTHER)
    await new Promise((r) => setTimeout(r, 20))
    release()
    await held
    expect((await known).statusCode).toBe(200)
  })
})

describe('an administrator and the bans', () => {
  it('lists them with the rule, blocks an address, and lifts it with their password', async () => {
    const { t, admin, login, audit } = await team()
    const listed = await admin('GET', '/api/users/bans')
    expect(listed.json()).toEqual({
      bans: [],
      total: 0,
      rule: { failures: 30, windowMinutes: 15, stepsMinutes: [15, 60, 360, 1440] },
    })
    const blocked = await admin('POST', '/api/users/bans', { address: '203.0.113.50', hours: 24 })
    expect(blocked.statusCode).toBe(200)
    expect(blocked.json().bans).toEqual([
      expect.objectContaining({
        address: '203.0.113.50',
        reason: 'manual',
        by: 'admin',
        until: t.clock.now + 24 * 60 * MIN,
      }),
    ])
    expect((await login('203.0.113.50', 'bob', OTHER)).json()).toMatchObject({
      details: { reason: 'address_banned' },
    })

    // Lifting asks for the administrator's own password.
    const bare = await admin('POST', '/api/users/bans/lift', { address: '203.0.113.50' })
    expect(bare.json()).toMatchObject({ details: { reason: 'wrong_password' } })
    const wrong = await admin('POST', '/api/users/bans/lift', { address: '203.0.113.50', password: OTHER })
    expect(wrong.statusCode).toBe(400)
    expect(t.app.ctx.bans.bannedUntil('203.0.113.50')).toBeGreaterThan(0)
    const lifted = await admin('POST', '/api/users/bans/lift', {
      address: '203.0.113.50',
      password: PASSWORD,
    })
    expect(lifted.statusCode).toBe(200)
    expect(lifted.json()).toMatchObject({ bans: [], total: 0 })
    expect((await login('203.0.113.50', 'bob', OTHER)).statusCode).toBe(200)
    expect(audit('users.bans.block').map((r) => JSON.parse(r.details!))).toEqual([
      expect.objectContaining({ address: '203.0.113.50', hours: 24 }),
    ])
    expect(audit('users.bans.lift').map((r) => [r.outcome, JSON.parse(r.details!).outcome])).toEqual([
      ['failure', undefined],
      ['failure', undefined],
      ['success', 'lifted'],
    ])
  })

  it('lifts an IPv6 ban by the address shown, and starts the address afresh at the throttle', async () => {
    const { t, admin } = await team()
    for (let i = 0; i < 25; i++) t.app.ctx.throttle.recordFailure('ip:2001:db8:5:6::/64')
    t.app.ctx.bans.block('2001:db8:5:6::1', 60 * MIN, 'admin')
    const res = await admin('POST', '/api/users/bans/lift', {
      address: '2001:DB8:5:6::/64',
      password: PASSWORD,
    })
    expect(res.statusCode).toBe(200)
    expect(t.app.ctx.bans.bannedUntil('2001:db8:5:6::1')).toBe(0)
    expect(t.app.ctx.throttle.retryAfterMs('ip:2001:db8:5:6::/64')).toBe(0)
  })

  it('refuses to block what is no address, this machine, a private one, or their own', async () => {
    const { admin, t } = await team()
    const block = (address: string, hours = 1) => admin('POST', '/api/users/bans', { address, hours })
    const reason = async (address: string) => (await block(address)).json().details?.reason
    expect(await reason('example.com')).toBe('ban_not_an_address')
    expect(await reason('10.0.0.0/8')).toBe('ban_not_an_address')
    expect(await reason('fe80::1%eth0')).toBe('ban_not_an_address')
    expect(await reason('0.0.0.0')).toBe('ban_not_an_address')
    expect(await reason('127.0.0.1')).toBe('ban_loopback')
    expect(await reason('::1')).toBe('ban_loopback')
    expect(await reason('192.168.1.20')).toBe('ban_private')
    expect(await reason('192.0.2.1')).toBe('ban_own_address')
    expect((await block('203.0.113.1', 5)).statusCode).toBe(400)
    expect(t.app.ctx.bans.list().total).toBe(0)
  })

  it('is for administrators only', async () => {
    const { t, login } = await team()
    const res = await login('198.51.100.30', 'bob', OTHER)
    const bob = { cookies: { mm_sid: sid(res)! }, csrf: res.json().csrfToken as string }
    for (const [method, url, payload] of [
      ['GET', '/api/users/bans', undefined],
      ['POST', '/api/users/bans', { address: '203.0.113.60', hours: 1 }],
      ['POST', '/api/users/bans/lift', { address: '203.0.113.60', password: OTHER }],
    ] as const) {
      const r = await t.app.inject({
        method,
        url,
        headers: { ...H, 'x-csrf-token': bob.csrf },
        cookies: bob.cookies,
        remoteAddress: '198.51.100.30',
        ...(payload ? { payload } : {}),
      })
      expect(r.statusCode, url).toBe(403)
    }
    expect(t.app.ctx.bans.list().total).toBe(0)
  })
})
