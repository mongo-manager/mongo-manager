// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { SoftAuthenticator } from './soft-authenticator'
import { hashPassword } from '../src/auth/passwords'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const PASSWORD = 'tarçın-kavanoz-42-mavi'
const ORIGIN = 'http://localhost:4321'
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
  })
  const session = { cookies: { mm_sid: sid(res)! }, csrf: res.json().csrfToken as string }
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { ...H, 'x-csrf-token': session.csrf },
      cookies: session.cookies,
      ...(payload ? { payload } : {}),
    })
  const post = (url: string, payload: object) => t.app.inject({ method: 'POST', url, headers: H, payload })
  const authenticator = new SoftAuthenticator(ORIGIN, 'localhost')
  const addPasskey = async (name: string, device = authenticator) => {
    const options = (await call('POST', '/api/auth/passkeys/options', { password: PASSWORD })).json()
    return call('POST', '/api/auth/passkeys', { name, response: device.register(options) })
  }
  return { t, call, post, authenticator, addPasskey }
}

describe('passkey registration', () => {
  it('registers with recovery codes on the first factor and lists passkeys', async () => {
    const { call, addPasskey } = await team()
    const options = (await call('POST', '/api/auth/passkeys/options', { password: PASSWORD })).json()
    expect(options).toMatchObject({
      rp: { id: 'localhost', name: 'Mongo Manager' },
      user: { name: 'admin' },
      attestation: 'none',
    })

    const first = await addPasskey('Laptop')
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ passkey: { name: 'Laptop' }, recoveryCodes: expect.any(Array) })
    const second = await addPasskey('Phone')
    expect(second.json().recoveryCodes).toBeUndefined()

    const list = (await call('GET', '/api/auth/passkeys')).json()
    expect(list.map((p: { name: string }) => p.name)).toEqual(['Laptop', 'Phone'])
    expect(list[0].publicKey).toBeUndefined()
    const next = (await call('POST', '/api/auth/passkeys/options', { password: PASSWORD })).json()
    expect(next.excludeCredentials).toHaveLength(2)
    expect((await call('GET', '/api/auth/me')).json().twoFactor).toMatchObject({
      enabled: true,
      passkeys: 2,
      recoveryCodesRemaining: 10,
    })
  })

  it('rejects a reused challenge, a foreign origin and a missing ceremony', async () => {
    const { call, authenticator } = await team()
    const options = (await call('POST', '/api/auth/passkeys/options', { password: PASSWORD })).json()
    const response = authenticator.register(options)
    expect((await call('POST', '/api/auth/passkeys', { name: 'A', response })).statusCode).toBe(200)
    expect((await call('POST', '/api/auth/passkeys', { name: 'B', response })).statusCode).toBe(400)

    const evil = new SoftAuthenticator('http://evil.example', 'localhost')
    const options2 = (await call('POST', '/api/auth/passkeys/options', { password: PASSWORD })).json()
    expect(
      (await call('POST', '/api/auth/passkeys', { name: 'C', response: evil.register(options2) })).statusCode,
    ).toBe(400)
    expect(
      (
        await call('POST', '/api/auth/passkeys', {
          name: 'D',
          response: { id: 'x', type: 'public-key', response: {} },
        })
      ).statusCode,
    ).toBe(400)
  })

  it('renames, and deletes only with the password; deleting the last factor restores one-step login', async () => {
    const { call, post, addPasskey } = await team()
    const { passkey } = (await addPasskey('Laptop')).json()
    expect(
      (await call('PATCH', `/api/auth/passkeys/${passkey.id}`, { name: 'Work laptop' })).json().name,
    ).toBe('Work laptop')
    expect((await call('PATCH', '/api/auth/passkeys/unknown', { name: 'x' })).statusCode).toBe(404)
    expect(
      (await call('DELETE', `/api/auth/passkeys/${passkey.id}`, { password: 'wrong-password-99' }))
        .statusCode,
    ).toBe(400)
    expect(
      (await call('DELETE', `/api/auth/passkeys/${passkey.id}`, { password: PASSWORD })).statusCode,
    ).toBe(204)
    expect((await call('GET', '/api/auth/me')).json().twoFactor).toMatchObject({
      enabled: false,
      recoveryCodesRemaining: 0,
    })
    expect(
      (await post('/api/auth/login', { username: 'admin', password: PASSWORD })).json().csrfToken,
    ).toEqual(expect.any(String))
  })
})

describe('passkey availability on this address', () => {
  it('reports localhost and HTTPS domains as supported, and IP addresses and plain-HTTP domains as not', async () => {
    const { call } = await team()
    expect((await call('GET', '/api/auth/passkeys/support')).json()).toEqual({ available: true })

    const t2 = await makeApp({
      auth: true,
      allowedHosts: ['127.0.0.1', 'mm.example.com'],
      trustedProxies: ['10.0.0.1'],
    })
    apps.push(t2)
    const token = t2.app.ctx.setup.ensureToken()
    const ipHeaders = { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' }
    const setupRes = await t2.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: ipHeaders,
      payload: { token, username: 'admin', password: PASSWORD },
    })
    const cookies = { mm_sid: sid(setupRes)! }
    const csrf = setupRes.json().csrfToken as string

    const ip = await t2.app.inject({
      method: 'GET',
      url: '/api/auth/passkeys/support',
      headers: ipHeaders,
      cookies,
    })
    expect(ip.json()).toMatchObject({
      available: false,
      reason: 'ip-address',
      message: expect.stringContaining('localhost'),
    })
    const blocked = await t2.app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/options',
      headers: { ...ipHeaders, 'x-csrf-token': csrf },
      cookies,
    })
    expect(blocked.statusCode).toBe(409)

    const plainDomain = await t2.app.inject({
      method: 'GET',
      url: '/api/auth/passkeys/support',
      headers: { host: 'mm.example.com' },
      cookies,
    })
    expect(plainDomain.json()).toMatchObject({ available: false, reason: 'insecure-context' })

    const viaHttpsProxy = await t2.app.inject({
      method: 'GET',
      url: '/api/auth/passkeys/support',
      remoteAddress: '10.0.0.1',
      headers: { host: 'internal:4321', 'x-forwarded-host': 'mm.example.com', 'x-forwarded-proto': 'https' },
      cookies: { '__Host-mm_sid': cookies.mm_sid },
    })
    expect(viaHttpsProxy.json()).toEqual({ available: true })
  })
})

describe('passkey login', () => {
  it('signs in with the passkey as the second step', async () => {
    const { t, post, authenticator, addPasskey } = await team()
    await addPasskey('Laptop')
    const step1 = (await post('/api/auth/login', { username: 'admin', password: PASSWORD })).json()
    expect(step1).toMatchObject({ mfaRequired: true, methods: ['passkey', 'recovery'] })
    const options = (await post('/api/auth/login/passkey/options', { ticket: step1.ticket })).json()
    expect(options.allowCredentials).toHaveLength(1)
    const res = await post('/api/auth/login/passkey', {
      ticket: step1.ticket,
      response: authenticator.authenticate(options),
    })
    expect(res.statusCode).toBe(200)
    expect(sid(res)).toBeDefined()
    const stored = t.app.ctx.passkeys.listForUser(res.json().user.id)[0]!
    expect(stored.counter).toBe(1)
    expect(stored.lastUsedAt).toBe(t.clock.now)
  })

  // Review of the deferred fixes (M8): a ticket ended by a password change still listed the passkeys.
  it('offers no passkey for a sign-in the password change ended', async () => {
    const { t, post, addPasskey } = await team()
    await addPasskey('Laptop')
    const step1 = (await post('/api/auth/login', { username: 'admin', password: PASSWORD })).json()
    const admin = t.app.ctx.users.findByUsername('admin')!
    t.app.ctx.users.setPassword(admin.id, await hashPassword('yeni-parola-2026-mavi'))
    const options = await post('/api/auth/login/passkey/options', { ticket: step1.ticket })
    expect(options.statusCode).toBe(401)
    expect(options.json().details).toEqual({ reason: 'mfa_ticket_expired' })
  })

  it('rejects a cloned authenticator, a replayed assertion and a missing challenge', async () => {
    const { post, authenticator, addPasskey } = await team()
    const { passkey } = (await addPasskey('Laptop')).json()
    const login = async () =>
      (await post('/api/auth/login', { username: 'admin', password: PASSWORD })).json().ticket as string

    const t1 = await login()
    const o1 = (await post('/api/auth/login/passkey/options', { ticket: t1 })).json()
    const assertion = authenticator.authenticate(o1)
    expect((await post('/api/auth/login/passkey', { ticket: t1, response: assertion })).statusCode).toBe(200)

    const t2 = await login()
    await post('/api/auth/login/passkey/options', { ticket: t2 })
    expect((await post('/api/auth/login/passkey', { ticket: t2, response: assertion })).statusCode).toBe(401)

    const t3 = await login()
    const o3 = (await post('/api/auth/login/passkey/options', { ticket: t3 })).json()
    authenticator.rewind(passkey.id)
    expect(
      (await post('/api/auth/login/passkey', { ticket: t3, response: authenticator.authenticate(o3) }))
        .statusCode,
    ).toBe(401)

    const t4 = await login()
    expect((await post('/api/auth/login/passkey', { ticket: t4, response: assertion })).statusCode).toBe(401)
  })

  it('does not accept another user’s passkey', async () => {
    const { t, post, addPasskey } = await team()
    await addPasskey('Admin key')
    const bobId = t.app.ctx.users.create({ username: 'bob', passwordHash: 'x', role: 'viewer' }).id
    const bobDevice = new SoftAuthenticator(ORIGIN, 'localhost')
    const bobCredential = bobDevice.register({ challenge: 'unused' })
    t.app.ctx.passkeys.add({
      id: bobCredential.id,
      userId: bobId,
      name: 'Bob key',
      publicKey: new Uint8Array(65),
      counter: 0,
      transports: [],
    })

    const ticket = (await post('/api/auth/login', { username: 'admin', password: PASSWORD })).json().ticket
    const options = (await post('/api/auth/login/passkey/options', { ticket })).json()
    const res = await post('/api/auth/login/passkey', {
      ticket,
      response: bobDevice.authenticate(options, bobCredential.id),
    })
    expect(res.statusCode).toBe(401)
  })
})
