import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { H, makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const PASSWORD = 'tarçın-kavanoz-42-mavi'
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
  const admin = { cookies: { mm_sid: sid(res)! }, csrf: res.json().csrfToken as string }
  // Security audit 2026-10-16: account changes are confirmed with the caller's own password (every
  // account here has the same one); admin-reauth.test.ts covers what happens without it.
  const confirmed = (method: string, url: string, payload?: object) =>
    (method === 'POST' || method === 'PATCH') && url.startsWith('/api/users')
      ? { currentPassword: PASSWORD, ...payload }
      : payload
  const as = (s: typeof admin) => ({
    req: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
      const body = confirmed(method, url, payload)
      return t.app.inject({
        method,
        url,
        headers: { ...H, 'x-csrf-token': s.csrf },
        cookies: s.cookies,
        ...(body ? { payload: body } : {}),
      })
    },
  })
  const loginAs = async (username: string, password = PASSWORD) => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { username, password },
    })
    return { cookies: { mm_sid: sid(r)! }, csrf: r.json().csrfToken as string }
  }
  return { t, admin: as(admin), adminId: res.json().user.id as string, as, loginAs }
}

describe('user administration', () => {
  it('creates, lists, updates and deletes users', async () => {
    const { admin } = await team()
    const created = await admin.req('POST', '/api/users', {
      username: 'bob',
      password: PASSWORD,
      role: 'viewer',
    })
    expect(created.statusCode).toBe(200)
    const bob = created.json()
    expect(bob).toMatchObject({ username: 'bob', role: 'viewer', disabled: false })
    expect(
      (await admin.req('GET', '/api/users')).json().map((u: { username: string }) => u.username),
    ).toEqual(['admin', 'bob'])
    expect(
      (await admin.req('POST', '/api/users', { username: 'BOB', password: PASSWORD, role: 'viewer' }))
        .statusCode,
    ).toBe(409)
    expect(
      (await admin.req('POST', '/api/users', { username: 'carol', password: 'short', role: 'viewer' }))
        .statusCode,
    ).toBe(400)
    expect(
      (await admin.req('POST', '/api/users', { username: 'x y', password: PASSWORD, role: 'viewer' }))
        .statusCode,
    ).toBe(400)
    expect((await admin.req('PATCH', `/api/users/${bob.id}`, { role: 'editor' })).json().role).toBe('editor')
    expect((await admin.req('PATCH', `/api/users/${bob.id}`, {})).statusCode).toBe(400)
    expect((await admin.req('DELETE', `/api/users/${bob.id}`)).statusCode).toBe(204)
    expect((await admin.req('PATCH', `/api/users/${bob.id}`, { role: 'viewer' })).statusCode).toBe(404)
    expect((await admin.req('PATCH', '/api/users/not-a-uuid', { role: 'viewer' })).statusCode).toBe(400)
  })

  it('removes the transfer files and reports of a disabled or deleted user (phase 3d-1 §8.3)', async () => {
    const { t, admin } = await team()
    const { files, reports } = t.app.ctx.transfer
    const make = async (username: string) => {
      const u = (
        await admin.req('POST', '/api/users', { username, password: PASSWORD, role: 'editor' })
      ).json()
      await files.receive({
        owner: u.id,
        connectionId: 'c1',
        name: 'a',
        body: Readable.from([Buffer.from('x')]),
      })
      reports.save(
        'j-' + u.id,
        u.id,
        {
          kind: 'export',
          written: 0,
          bytes: 0,
          omittedFields: [],
          cutCells: 0,
          expiresAt: 4e12,
          masked: false,
        },
        4e12,
      )
      return u.id as string
    }
    const carol = await make('carol')
    const dave = await make('dave')
    expect(existsSync(join(t.dir, 'transfer', carol))).toBe(true)
    expect((await admin.req('PATCH', `/api/users/${carol}`, { disabled: true })).statusCode).toBe(200)
    expect((await admin.req('DELETE', `/api/users/${dave}`)).statusCode).toBe(204)
    for (const id of [carol, dave]) {
      expect(files.usage(id)).toBe(0)
      expect(reports.get(id, `j-${id}`)).toBeUndefined()
      expect(existsSync(join(t.dir, 'transfer', id))).toBe(false)
    }
  })

  it('removes the saved transfer settings of a deleted user, keeps those of a disabled one', async () => {
    const { t, admin } = await team()
    const { presets } = t.app.ctx.transfer
    const make = async (username: string) => {
      const u = (
        await admin.req('POST', '/api/users', { username, password: PASSWORD, role: 'editor' })
      ).json()
      presets.create(u.id, { kind: 'import', name: 'p', namespace: null, body: { mode: 'insert' } })
      return u.id as string
    }
    const erin = await make('erin')
    const finn = await make('finn')
    await admin.req('PATCH', `/api/users/${erin}`, { disabled: true })
    await admin.req('DELETE', `/api/users/${finn}`)
    expect(presets.list(erin)).toHaveLength(1)
    expect(presets.list(finn)).toEqual([])
  })

  it('protects the last admin and the caller themselves', async () => {
    const { admin, adminId } = await team()
    expect((await admin.req('PATCH', `/api/users/${adminId}`, { role: 'viewer' })).statusCode).toBe(409)
    expect((await admin.req('PATCH', `/api/users/${adminId}`, { disabled: true })).statusCode).toBe(409)
    expect((await admin.req('DELETE', `/api/users/${adminId}`)).statusCode).toBe(409)
  })

  it('disabling or resetting a user kills their sessions immediately (Review Focus 4)', async () => {
    const { admin, as, loginAs } = await team()
    const bob = (
      await admin.req('POST', '/api/users', { username: 'bob', password: PASSWORD, role: 'editor' })
    ).json()
    const bobSession = as(await loginAs('bob'))
    expect((await bobSession.req('GET', '/api/auth/me')).statusCode).toBe(200)
    await admin.req('PATCH', `/api/users/${bob.id}`, { disabled: true })
    expect((await bobSession.req('GET', '/api/auth/me')).statusCode).toBe(401)
    await admin.req('PATCH', `/api/users/${bob.id}`, { disabled: false })
    const again = as(await loginAs('bob'))
    expect(
      (await admin.req('POST', `/api/users/${bob.id}/password`, { password: 'baska-parola-2026-yesil' }))
        .statusCode,
    ).toBe(204)
    expect((await again.req('GET', '/api/auth/me')).statusCode).toBe(401)
  })

  it('lets an admin reset a user’s two-factor settings (lost device)', async () => {
    const { t, admin } = await team()
    const bob = (
      await admin.req('POST', '/api/users', { username: 'bob', password: PASSWORD, role: 'editor' })
    ).json()
    t.app.ctx.users.setTotp(bob.id, 'sealed', true)
    t.app.ctx.recoveryCodes.replace(bob.id)
    t.app.ctx.passkeys.add({
      id: 'k1',
      userId: bob.id,
      name: 'Key',
      publicKey: new Uint8Array(1),
      counter: 0,
      transports: [],
    })
    const { sessionId } = t.app.ctx.sessions.create(bob.id, {})
    expect((await admin.req('POST', `/api/users/${bob.id}/reset-2fa`)).statusCode).toBe(204)
    expect(t.app.ctx.users.findById(bob.id)).toMatchObject({ totpEnabled: false, totpSecretSealed: null })
    expect(t.app.ctx.passkeys.countForUser(bob.id)).toBe(0)
    expect(t.app.ctx.recoveryCodes.remaining(bob.id)).toBe(0)
    expect(t.app.ctx.sessions.get(sessionId)).toBeUndefined()
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { username: 'bob', password: PASSWORD },
    })
    expect(login.json().csrfToken).toEqual(expect.any(String))
    expect(
      (await admin.req('POST', '/api/users/00000000-0000-4000-8000-000000000000/reset-2fa')).statusCode,
    ).toBe(404)
  })

  // Review of L2 (I2): an administrator's session removed its own second factors here, with no
  // second factor asked — then signed in with the password alone. Their own go through Account
  // settings, which asks for one.
  it('never resets the caller’s own two-factor settings', async () => {
    const { t, admin } = await team()
    const self = t.app.ctx.users.findByUsername('admin')!
    t.app.ctx.users.setTotp(self.id, 'sealed', true)
    const res = await admin.req('POST', `/api/users/${self.id}/reset-2fa`)
    expect(res.statusCode).toBe(409)
    expect(res.json().details).toMatchObject({ reason: 'self_2fa_reset' })
    expect(t.app.ctx.users.findById(self.id)!.totpEnabled).toBe(true)
  })

  it('denies non-admins and is unavailable in local mode', async () => {
    const { admin, as, loginAs } = await team()
    await admin.req('POST', '/api/users', { username: 'eve', password: PASSWORD, role: 'editor' })
    const eve = as(await loginAs('eve'))
    expect((await eve.req('GET', '/api/users')).statusCode).toBe(403)
    expect((await eve.req('GET', '/api/audit')).statusCode).toBe(403)

    const local = await makeApp()
    apps.push(local)
    const res = await local.app.inject({ method: 'GET', url: '/api/users', headers: H })
    expect(res.statusCode).toBe(409)
  })
})

describe('audit trail (S18)', () => {
  it('records successes, failures and denials with the username but never the password', async () => {
    const { t, admin, as, loginAs } = await team()
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { username: 'admin', password: 'wrong-password-99' },
    })
    await admin.req('POST', '/api/users', { username: 'eve', password: PASSWORD, role: 'viewer' })
    const eve = as(await loginAs('eve'))
    await eve.req('POST', '/api/users', { username: 'mallory', password: PASSWORD, role: 'admin' })
    await t.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { ...H, origin: 'http://evil.example' },
      payload: {},
    })

    const entries = (await admin.req('GET', '/api/audit?limit=50')).json() as Array<Record<string, unknown>>
    const summary = entries.map((e) => [e.action, e.outcome, e.username]).reverse()
    expect(summary).toEqual([
      ['auth.setup', 'success', 'admin'],
      ['auth.login', 'denied', 'admin'],
      ['users.create', 'success', 'admin'],
      ['auth.login', 'success', 'eve'],
      ['users.create', 'denied', 'eve'],
      ['users.create', 'denied', null],
    ])
    expect(JSON.stringify(entries)).not.toContain(PASSWORD)
    expect(entries.every((e) => e.ip === '127.0.0.1')).toBe(true)
    const logins = (await admin.req('GET', '/api/audit?action=auth.login')).json()
    expect(logins).toHaveLength(2)
    expect((await admin.req('GET', '/api/audit?limit=0')).statusCode).toBe(400)
  })
})

describe('user admin refusals name their reason', () => {
  it('self demotion, self delete, self password reset and the last admin', async () => {
    const { t, admin, adminId } = await team()
    const reason = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res
      expect(r.statusCode).toBe(409)
      return r.json().details
    }
    expect(await reason(admin.req('PATCH', `/api/users/${adminId}`, { role: 'viewer' }))).toEqual({
      reason: 'self_demote',
    })
    expect(await reason(admin.req('DELETE', `/api/users/${adminId}`))).toEqual({ reason: 'self_delete' })
    expect(
      await reason(admin.req('POST', `/api/users/${adminId}/password`, { password: 'another-pass-1234' })),
    ).toEqual({ reason: 'self_password' })
    const other = (
      await admin.req('POST', '/api/users', { username: 'root2', password: PASSWORD, role: 'admin' })
    ).json()
    expect(
      await reason(
        admin.req('POST', '/api/users', { username: 'root2', password: PASSWORD, role: 'viewer' }),
      ),
    ).toEqual({ reason: 'username_taken' })
    // The acting admin is always active, so a real request cannot reach "last admin" without a
    // self refusal first; pin the reason by reporting a single active admin.
    const spy = vi.spyOn(t.app.ctx.users, 'countActiveAdmins').mockReturnValue(1)
    expect(await reason(admin.req('PATCH', `/api/users/${other.id}`, { role: 'viewer' }))).toEqual({
      reason: 'last_admin',
    })
    expect(await reason(admin.req('DELETE', `/api/users/${other.id}`))).toEqual({ reason: 'last_admin' })
    spy.mockRestore()
  })
})
