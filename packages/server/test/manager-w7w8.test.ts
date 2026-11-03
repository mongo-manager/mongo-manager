import { describe, expect, it, vi } from 'vitest'
import type { MongoClient, MongoClientOptions } from 'mongodb'
import { ConnectionSettingsSchema, type ConnectionSettings } from '@mongo-manager/shared'
import { ConnectionManager, type ManagerDeps } from '../src/connections/manager'
import type { ConnectionPolicy } from '../src/connections/policy'
import { fakeCryptSharedLib } from './support/crypt-shared'

/** A client that connects to nothing: what the manager built it with is all these tests look at. */
interface FakeClient {
  options: MongoClientOptions
  closed: boolean
}
function fakeFactory() {
  const made: FakeClient[] = []
  const createClient = (_uri: string, options: MongoClientOptions) => {
    const c: FakeClient & Record<string, unknown> = {
      options,
      closed: false,
      connect: async () => c,
      close: async () => {
        c.closed = true
      },
      db: () => ({ command: async () => ({ version: '7.0.0', ok: 1 }) }),
    }
    made.push(c)
    return c as unknown as MongoClient
  }
  return { made, createClient }
}

const modules = {
  distribution: 'npm' as const,
  clientEncryption: { status: 'available' as const, version: '6.5.0' },
  kerberos: { status: 'available' as const, version: '2.2.2' },
}
const policy =
  (over: Partial<ConnectionPolicy> = {}): (() => ConnectionPolicy) =>
  () => ({
    teamMode: true,
    allowKerberos: false,
    allowWorkloadIdentity: false,
    // A mongo_crypt_v1 file on this computer (a full path where the tests run, fifth review).
    cryptSharedLibPath: fakeCryptSharedLib(),
    kmsAllowedHosts: [],
    modules,
    ...over,
  })
const parse = (s: object): ConnectionSettings =>
  ConnectionSettingsSchema.parse({ hosts: [{ host: 'db.example', port: 27017 }], ...s })
const oidc = parse({
  tls: { enabled: true },
  auth: { mechanism: 'MONGODB-OIDC', oidc: { allowedHosts: ['db.example'] } },
})
const encrypted = parse({
  encryption: {
    enabled: true,
    keyVaultNamespace: 'encryption.__keyVault',
    kms: { local: { key: 'A'.repeat(128) } },
  },
})

function manager(settings: ConnectionSettings, over: Partial<ManagerDeps> = {}) {
  const f = fakeFactory()
  const oidcCallback = vi.fn((_id: string, user: string) =>
    Object.assign(async () => ({ accessToken: user }), { user }),
  )
  const autoEncryption = vi.fn(async () => ({ keyVaultNamespace: 'encryption.__keyVault', kmsProviders: {} }))
  const m = new ConnectionManager({
    load: () => ({ settings }),
    createClient: f.createClient,
    policy: policy(),
    oidcCallback,
    autoEncryption,
    ...over,
  })
  return { m, made: f.made, oidcCallback, autoEncryption }
}

const callbackOf = (c: MongoClient) =>
  (
    (c as unknown as FakeClient).options.authMechanismProperties as unknown as {
      OIDC_HUMAN_CALLBACK: { user: string }
    }
  ).OIDC_HUMAN_CALLBACK

describe('W7: OIDC clients are per person in team mode', () => {
  it('opens one client per person, each signed in with that person’s own tokens', async () => {
    const { m, oidcCallback } = manager(oidc)
    const ana = await m.getClient('c1', { user: 'ana' })
    const bob = await m.getClient('c1', { user: 'bob' })
    expect(ana).not.toBe(bob)
    expect(await m.getClient('c1', { user: 'ana' })).toBe(ana)
    expect(callbackOf(ana).user).toBe('ana')
    expect(callbackOf(bob).user).toBe('bob')
    expect(oidcCallback.mock.calls.map((c) => c[1]).sort()).toEqual(['ana', 'bob'])
    await m.closeAll()
  })

  // Abuse case: work running on its own (monitoring, a schedule) would borrow someone's sign-in.
  it('refuses a client with no person behind it', async () => {
    const { m, made } = manager(oidc)
    await expect(m.getClient('c1')).rejects.toThrow(/signs each person in/)
    expect(made).toHaveLength(0)
    await m.closeAll()
  })

  it('closes one person’s client after their sign-in changes, and only theirs', async () => {
    const { m } = manager(oidc)
    const ana = await m.getClient('c1', { user: 'ana' })
    const bob = await m.getClient('c1', { user: 'bob' })
    await m.invalidateUser('c1', 'ana')
    expect((ana as unknown as FakeClient).closed).toBe(true)
    expect((bob as unknown as FakeClient).closed).toBe(false)
    expect(await m.getClient('c1', { user: 'ana' })).not.toBe(ana)
    await m.invalidate('c1')
    expect((bob as unknown as FakeClient).closed).toBe(true)
    await m.closeAll()
  })

  it('closes no client of a connection that does not sign people in with OIDC', async () => {
    const { m } = manager(parse({ auth: { mechanism: 'SCRAM-SHA-256', username: 'u', password: 'p' } }))
    const shared = await m.getClient('c1')
    await m.invalidateUser('c1', 'ana')
    expect((shared as unknown as FakeClient).closed).toBe(false)
    expect(await m.getClient('c1')).toBe(shared)
    await m.closeAll()
  })

  it('has the one local user in local mode, whatever the caller says', async () => {
    const { m, oidcCallback } = manager(oidc, { policy: policy({ teamMode: false }) })
    const a = await m.getClient('c1')
    expect(await m.getClient('c1', { user: 'someone' })).toBe(a)
    expect(oidcCallback).toHaveBeenCalledWith('c1', 'local')
    await m.closeAll()
  })

  it('shares a workload identity the administrator allowed, with no per-person client', async () => {
    const workload = parse({
      tls: { enabled: true },
      auth: {
        mechanism: 'MONGODB-OIDC',
        oidc: { environment: 'k8s', environmentConfirmed: 'k8s', allowedHosts: ['db.example'] },
      },
    })
    const { m } = manager(workload, { policy: policy({ allowWorkloadIdentity: true }) })
    expect(await m.getClient('c1')).toBe(await m.getClient('c1', { user: 'ana' }))
    await m.closeAll()
    const refused = manager(workload)
    await expect(refused.m.getClient('c1')).rejects.toThrow(/MM_ALLOW_WORKLOAD_IDENTITY/)
    await refused.m.closeAll()
  })
})

describe('W8: only interactive use by someone who may see the data decrypts', () => {
  it('keeps a decrypting client apart from the one that reads values as stored', async () => {
    const { m, autoEncryption } = manager(encrypted)
    const plain = await m.getClient('c1')
    const decrypting = await m.getClient('c1', { decrypt: true })
    expect(plain).not.toBe(decrypting)
    expect((plain as unknown as FakeClient).options.autoEncryption).toBeUndefined()
    expect((decrypting as unknown as FakeClient).options.autoEncryption).toBeDefined()
    expect(autoEncryption).toHaveBeenCalledTimes(1)
    await m.closeAll()
  })

  it('opens no decrypting client when the package is gone since the connection was saved', async () => {
    const { m, made } = manager(encrypted, {
      policy: policy({ modules: { ...modules, clientEncryption: { status: 'missing', version: null } } }),
    })
    await expect(m.getClient('c1', { decrypt: true })).rejects.toThrow(/mongodb-client-encryption/)
    expect(made).toHaveLength(0)
    await m.closeAll()
  })
})

describe('W8: Kerberos follows the server’s policy each time it connects', () => {
  const kerberos = parse({ auth: { mechanism: 'GSSAPI', username: 'u@REALM' } })

  it('refuses it in team mode unless allowed, before an SSH tunnel is dialled', async () => {
    const openTunnel = vi.fn(() => new Promise<never>(() => undefined))
    const tunnelled = {
      ...kerberos,
      ssh: { enabled: true, host: 's', port: 22, username: 'u', method: 'password' as const, password: 'p' },
    }
    const { m, made } = manager(tunnelled, { openTunnel })
    await expect(m.getClient('c1')).rejects.toThrow(/MM_ALLOW_KERBEROS/)
    expect(openTunnel).not.toHaveBeenCalled()
    expect(made).toHaveLength(0)
    await m.closeAll()
  })

  it('connects when allowed', async () => {
    const { m } = manager(kerberos, { policy: policy({ allowKerberos: true }) })
    const c = await m.getClient('c1')
    expect((c as unknown as FakeClient).options.authMechanismProperties).toBeUndefined()
    await m.closeAll()
  })

  it('refuses everything new by default when no policy is given (the safe side)', async () => {
    const f = fakeFactory()
    const m = new ConnectionManager({ load: () => ({ settings: kerberos }), createClient: f.createClient })
    await expect(m.getClient('c1')).rejects.toThrow(/Kerberos/)
    await m.closeAll()
  })
})

// CI 2026-10-22 (manager-opening.test.ts): a client stopped before it began, while its encryption
// was being set up, is never made. The app's own setup has no wait today; one that comes (a key
// provider asked over the network) is covered.
describe('a client stopped while its encryption is set up', () => {
  it('is never made', async () => {
    const { m, made } = manager(encrypted, {
      autoEncryption: async () => {
        await new Promise((r) => setTimeout(r, 200))
        return { keyVaultNamespace: 'encryption.__keyVault', kmsProviders: {} }
      },
    })
    const opening = m.getClient('c1', { decrypt: true }).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 20))
    await m.closeAll()
    expect(await opening).toMatchObject({ message: 'The server is shutting down' })
    expect(made).toHaveLength(0)
  })
})
