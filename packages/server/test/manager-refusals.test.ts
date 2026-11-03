import { afterEach, describe, expect, it, vi } from 'vitest'
import { MongoClient, MongoServerError } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { ConnectionManager, REFUSAL_KEPT_MS, type ManagerDeps } from '../src/connections/manager'
import { ConnectionError } from '../src/connections/errors'
import { connectionAppError } from '../src/data/mongo-errors'
import { H, makeApp, type TestApp } from './helpers'
import { fakeCryptSharedLib } from './support/crypt-shared'

/**
 * Fourth review of the unreachable fix (I1): a sign-in the server refused was tried again unasked:
 * the health check every 30 s, each widget, each tab opened, Retry twice over. With a directory's
 * lockout rules that locks the account out. A refused sign-in is kept: the server is not dialled
 * again for it until the connection is edited, a test of it passes, or the time it is kept is up.
 */
const settings = ConnectionSettingsSchema.parse({ hosts: [{ host: 'db', port: 27017 }] })
const viaSsh = ConnectionSettingsSchema.parse({
  hosts: [{ host: 'db' }],
  ssh: { enabled: true, host: 's', username: 'u', method: 'password', password: 'p' },
})

const managers: ConnectionManager[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const m of managers.splice(0)) await m.closeAll(1_000)
})

/** A manager whose clients fail to connect as `fail` says, counting how often it dials. */
function managerFailing(fail: () => Error, deps: Partial<ManagerDeps> = {}) {
  const dials = { count: 0 }
  const m = new ConnectionManager({
    load: () => ({ settings }),
    createClient: () => {
      dials.count++
      return {
        connect: async () => {
          throw fail()
        },
        close: async () => undefined,
        db: () => ({ command: async () => ({}) }),
      } as unknown as MongoClient
    },
    ...deps,
  })
  managers.push(m)
  return { m, dials }
}
const authFailed = () =>
  new MongoServerError({ code: 18, codeName: 'AuthenticationFailed', errmsg: 'Authentication failed.' })
const refused = (m: ConnectionManager) => m.getClient('c1').catch((e: unknown) => e)

describe('a sign-in the server refused', () => {
  it('is not tried again: the next ask is answered with it, and says it was kept', async () => {
    const { m, dials } = managerFailing(authFailed)
    const first = await refused(m)
    expect(dials.count).toBe(1)
    expect(first).not.toMatchObject({ remembered: true })
    for (let i = 0; i < 3; i++) {
      const again = await refused(m)
      expect(again).toBeInstanceOf(ConnectionError)
      expect(again).toMatchObject({ kind: 'auth', remembered: true })
    }
    expect(dials.count).toBe(1)
    // The route's answer says so, so the page can say how to try again.
    expect(connectionAppError(await refused(m)).details).toMatchObject({ kind: 'auth', remembered: true })
  })

  it('is tried again once the connection is edited, a test passes, or the time is up', async () => {
    const { m, dials } = managerFailing(authFailed)
    await refused(m)
    await m.invalidate('c1')
    await refused(m)
    expect(dials.count).toBe(2)
    m.forgetRefusal('c1')
    await refused(m)
    expect(dials.count).toBe(3)
    // A clock that never goes back (fifth review, nit 2).
    const now = performance.now()
    vi.spyOn(performance, 'now').mockReturnValue(now + REFUSAL_KEPT_MS + 1)
    await refused(m)
    expect(dials.count).toBe(4)
  })

  it('is kept for an SSH sign-in refused and a host key that changed, not for SSH out of reach', async () => {
    const cases: Array<[Error, number]> = [
      [new ConnectionError('ssh', 'SSH connection failed: All configured authentication methods failed'), 1],
      [new ConnectionError('ssh-host-key', 'The SSH server key changed', 'SHA256:x'), 1],
      [new ConnectionError('ssh', 'SSH connection failed: connect ECONNREFUSED 10.0.0.1:22'), 3],
    ]
    for (const [error, expected] of cases) {
      let opened = 0
      const m = new ConnectionManager({
        load: () => ({ settings: viaSsh }),
        openTunnel: async () => {
          opened++
          throw error
        },
      })
      managers.push(m)
      for (let i = 0; i < 3; i++) await refused(m)
      expect(opened, error.message).toBe(expected)
    }
  })

  it('never keeps what passes by itself: the network, a timeout, DNS', async () => {
    for (const fail of [
      () => new Error('connect ECONNREFUSED 127.0.0.1:27017'),
      () => new Error('getaddrinfo ENOTFOUND db'),
      () =>
        Object.assign(new Error('Server selection timed out after 30000 ms'), {
          name: 'MongoServerSelectionError',
        }),
    ]) {
      const { m, dials } = managerFailing(fail)
      for (let i = 0; i < 3; i++) await refused(m)
      expect(dials.count).toBe(3)
    }
  })

  it('of a connection with no person in its sign-in is not touched by a person signing in again', async () => {
    const { m, dials } = managerFailing(authFailed)
    await refused(m)
    await m.invalidateUser('c1', 'someone')
    // Local mode's one person: not an OIDC connection, nothing of theirs is touched.
    await refused(m)
    expect(dials.count).toBe(1)
  })
})

describe("a saved connection's test", () => {
  const apps: TestApp[] = []
  afterEach(async () => {
    for (const t of apps.splice(0)) await t.close()
  })

  it('forgets its kept refusal when it passes, and only then', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const connectionId = ctx.connections.create(
      { name: 'C', favorite: false, readOnly: false, settings },
      null,
    ).id
    const u = ctx.users.create({ username: 'adm', passwordHash: 'x', role: 'admin' })
    const { sessionId, session } = ctx.sessions.create(u.id, {})
    const testIt = () =>
      t.app.inject({
        method: 'POST',
        url: `/api/connections/${connectionId}/test`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
      })
    const forget = vi.spyOn(ctx.manager, 'forgetRefusal')
    const test = vi.spyOn(ctx.manager, 'test')
    test.mockResolvedValueOnce({ ok: false, error: { kind: 'auth', message: 'refused' } })
    expect((await testIt()).statusCode).toBe(200)
    expect(forget).not.toHaveBeenCalled()
    test.mockResolvedValueOnce({ ok: true, latencyMs: 1, serverVersion: '8.0.0', topology: 'standalone' })
    expect((await testIt()).statusCode).toBe(200)
    // The tester's, and the connection's own (fifth review, M3).
    expect(forget).toHaveBeenCalledWith(connectionId, expect.any(String))
  })
})

describe('a refusal of one person, on a connection each person signs in to (W7)', () => {
  it('is forgotten when that person signs in again, and kept for the others', async () => {
    const oidc = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'db.example', port: 27017 }],
      tls: { enabled: true },
      auth: { mechanism: 'MONGODB-OIDC', oidc: { allowedHosts: ['db.example'] } },
    })
    const { m, dials } = managerFailing(authFailed, {
      load: () => ({ settings: oidc }),
      policy: () => ({
        teamMode: true,
        allowKerberos: false,
        allowWorkloadIdentity: false,
        cryptSharedLibPath: undefined,
        kmsAllowedHosts: [],
        modules: {
          distribution: 'npm',
          clientEncryption: { status: 'missing', version: null },
          kerberos: { status: 'missing', version: null },
        },
      }),
      oidcCallback: () => async () => ({ accessToken: 't' }),
    })
    const as = (user: string) => m.getClient('c1', { user }).catch((e: unknown) => e)
    await as('ann')
    await as('bob')
    expect(dials.count).toBe(2)
    await m.invalidateUser('c1', 'ann')
    await as('ann')
    await as('bob')
    expect(dials.count).toBe(3)
  })
})

describe('a refusal noted for a person (re-review of A5, N-b)', () => {
  it('keeps that person out, without a dial, and leaves the others free', async () => {
    const oidc = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'db.example', port: 27017 }],
      tls: { enabled: true },
      auth: { mechanism: 'MONGODB-OIDC', oidc: { allowedHosts: ['db.example'] } },
    })
    const { m, dials } = managerFailing(authFailed, {
      load: () => ({ settings: oidc }),
      policy: () => ({
        teamMode: true,
        allowKerberos: false,
        allowWorkloadIdentity: false,
        cryptSharedLibPath: undefined,
        kmsAllowedHosts: [],
        modules: {
          distribution: 'npm',
          clientEncryption: { status: 'missing', version: null },
          kerberos: { status: 'missing', version: null },
        },
      }),
      oidcCallback: () => async () => ({ accessToken: 't' }),
    })
    m.noteRefusal('c1', new ConnectionError('auth', 'refused'), 'ann')
    expect(m.refusalOf('c1', 'ann')?.kind).toBe('auth')
    expect(m.refusalOf('c1', 'bob')).toBeNull()
    expect(await m.getClient('c1', { user: 'ann' }).catch((e: unknown) => e)).toMatchObject({
      kind: 'auth',
      remembered: true,
    })
    expect(dials.count).toBe(0)
    // Where everyone signs in with the same credential, it is everyone's.
    const shared = new ConnectionManager({ load: () => ({ settings }) })
    managers.push(shared)
    shared.noteRefusal('c1', new ConnectionError('auth', 'refused'), 'ann')
    expect(shared.refusalOf('c1', 'bob')?.kind).toBe('auth')
  })
})

describe('a refusal kept, more cases (fifth review)', () => {
  it('is one for the plain client and the decrypting one: the same credential (M2)', async () => {
    const encrypted = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'db', port: 27017 }],
      encryption: {
        enabled: true,
        keyVaultNamespace: 'encryption.__keyVault',
        kms: { local: { key: 'A'.repeat(128) } },
      },
    })
    const { m, dials } = managerFailing(authFailed, {
      load: () => ({ settings: encrypted }),
      autoEncryption: async () => ({ keyVaultNamespace: 'encryption.__keyVault', kmsProviders: {} }),
      policy: () => ({
        teamMode: false,
        allowKerberos: false,
        allowWorkloadIdentity: false,
        cryptSharedLibPath: fakeCryptSharedLib(),
        kmsAllowedHosts: [],
        modules: {
          distribution: 'npm',
          clientEncryption: { status: 'available', version: '6.5.0' },
          kerberos: { status: 'missing', version: null },
        },
      }),
    })
    await refused(m)
    expect(await m.getClient('c1', { decrypt: true }).catch((e: unknown) => e)).toMatchObject({
      kind: 'auth',
      remembered: true,
    })
    expect(dials.count).toBe(1)
  })

  it("a person whose test passed forgets theirs and the connection's own, not another person's (M3)", () => {
    const m = new ConnectionManager({ load: () => ({ settings }) })
    managers.push(m)
    const SEP = String.fromCharCode(0)
    const refusal = new ConnectionError('auth', 'refused')
    m.noteRefusal('c1', refusal)
    m.noteRefusal(`c1${SEP}u:ann`, refusal)
    m.noteRefusal(`c1${SEP}u:bob`, refusal)
    m.forgetRefusal('c1', 'ann')
    expect(m.refusalOf('c1')).toBeNull()
    expect(m.refusalOf('c1', 'ann')).toBeNull()
    expect(m.refusalOf('c1', 'bob')).toBe(refusal)
  })

  it('is not kept when the connection was edited while the open that met it ran (M5)', async () => {
    let refuse: (e: Error) => void = () => undefined
    let dials = 0
    const m = new ConnectionManager({
      load: () => ({ settings }),
      createClient: () => {
        dials++
        return {
          connect: () =>
            dials === 1 ? new Promise<void>((_, reject) => (refuse = reject)) : Promise.reject(authFailed()),
          close: async () => undefined,
          db: () => ({ command: async () => ({}) }),
        } as unknown as MongoClient
      },
    })
    managers.push(m)
    const first = refused(m)
    // Sixth review (M5): once its client is made, whatever the runner's speed.
    await vi.waitFor(() => expect(dials).toBe(1))
    await m.invalidate('c1')
    refuse(authFailed())
    await first
    // The edit came first: the late refusal is the old settings', not kept.
    expect(m.refusalOf('c1')).toBeNull()
    await refused(m)
    expect(dials).toBe(2)
  })
})

describe("a saved connection's test while a refusal is kept (fifth review, M1)", () => {
  const apps: TestApp[] = []
  afterEach(async () => {
    for (const t of apps.splice(0)) await t.close()
  })

  it('signs in again only for its administrators; a viewer is answered with the refusal', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const connectionId = ctx.connections.create(
      { name: 'C', favorite: false, readOnly: false, settings },
      null,
    ).id
    const as = (role: 'viewer' | 'admin') => {
      const u = ctx.users.create({ username: `u-${role}`, passwordHash: 'x', role })
      if (role === 'viewer') ctx.grants.set(connectionId, u.id, 'viewer')
      const { sessionId, session } = ctx.sessions.create(u.id, {})
      return () =>
        t.app.inject({
          method: 'POST',
          url: `/api/connections/${connectionId}/test`,
          headers: { ...H, 'x-csrf-token': session.csrfToken },
          cookies: { mm_sid: sessionId },
        })
    }
    const test = vi
      .spyOn(ctx.manager, 'test')
      .mockResolvedValue({ ok: false, error: { kind: 'auth', message: 'x' } })
    ctx.manager.noteRefusal(connectionId, new ConnectionError('auth', 'Authentication failed'))
    const viewer = await as('viewer')()
    expect(viewer.json()).toMatchObject({
      ok: false,
      error: { kind: 'auth', message: 'Authentication failed', remembered: true },
    })
    expect(test).not.toHaveBeenCalled()
    await as('admin')()
    expect(test).toHaveBeenCalledTimes(1)
  })
})

describe("the connection dialog's test of a saved connection (sixth review, nit 4)", () => {
  const apps: TestApp[] = []
  afterEach(async () => {
    for (const t of apps.splice(0)) await t.close()
  })

  it('forgets its refusal when its saved settings pass, not when other settings do', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const connectionId = ctx.connections.create(
      { name: 'C', favorite: false, readOnly: false, settings },
      null,
    ).id
    const u = ctx.users.create({ username: 'adm', passwordHash: 'x', role: 'admin' })
    const { sessionId, session } = ctx.sessions.create(u.id, {})
    const testWith = (s: object) =>
      t.app.inject({
        method: 'POST',
        url: '/api/connections/test',
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        payload: { connectionId, settings: s },
      })
    vi.spyOn(ctx.manager, 'test').mockResolvedValue({
      ok: true,
      latencyMs: 1,
      serverVersion: '8.0.0',
      topology: 'standalone',
    })
    const forget = vi.spyOn(ctx.manager, 'forgetRefusal')
    expect((await testWith({ ...settings, hosts: [{ host: 'other', port: 27017 }] })).statusCode).toBe(200)
    expect(forget).not.toHaveBeenCalled()
    expect((await testWith(settings)).statusCode).toBe(200)
    expect(forget).toHaveBeenCalledWith(connectionId, expect.any(String))
  })
})
