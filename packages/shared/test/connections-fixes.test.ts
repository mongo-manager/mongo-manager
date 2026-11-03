import { describe, expect, it } from 'vitest'
import {
  ConnectionSettingsSchema,
  SECRET_MASK,
  maskSecrets,
  mergeSecrets,
  secretReuseProblem,
} from '../src/connections'

const base = {
  hosts: [{ host: 'db.example', port: 27017 }],
  auth: { mechanism: 'DEFAULT', username: 'app', password: 'pw' },
  ssh: { enabled: true, host: 'bastion', port: 22, username: 'u', method: 'password', password: 'sp' },
}

describe('fix: masked secrets only follow the same target', () => {
  const stored = ConnectionSettingsSchema.parse(base)
  const masked = maskSecrets(stored)

  it('allows reuse when the target is unchanged', () => {
    expect(secretReuseProblem({ ...masked, appName: 'renamed' }, stored)).toBeNull()
  })

  // Review of the connection form fix (2026-10-16): a host without a port is the same server as the
  // host on 27017, the default; a password stays without re-entry.
  it('takes a mongodb host without a port for the same host on 27017', () => {
    const portless = { ...masked, hosts: [{ host: 'db.example' }] }
    expect(secretReuseProblem(portless, stored)).toBeNull()
    expect(secretReuseProblem({ ...masked, hosts: [{ host: 'db.example', port: 27018 }] }, stored)).toMatch(
      /re-enter/i,
    )
  })

  it('refuses reuse when the host, scheme, mechanism or SSH endpoint changes', () => {
    const cases = [
      { ...masked, hosts: [{ host: 'attacker.example', port: 27017 }] },
      { ...masked, auth: { ...masked.auth, mechanism: 'PLAIN' as const } },
      { ...masked, ssh: { ...masked.ssh!, host: 'evil-bastion' } },
      { ...masked, ssh: { ...masked.ssh!, port: 2222 } },
    ]
    for (const c of cases) expect(secretReuseProblem(c, stored), JSON.stringify(c.hosts)).toMatch(/re-enter/i)
  })

  // Security audit 2026-10-16 (minor): how the password travels is part of the target — TLS turned
  // off or loosened, another CA, another SRV service, the mechanism's properties or the SSH account
  // could send a stored password (LDAP's PLAIN in the clear) where the user never typed it.
  it('refuses reuse when TLS, the CA, certificate checks or other transport settings change', () => {
    const tls = ConnectionSettingsSchema.parse({
      ...base,
      tls: { enabled: true, caPem: '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----' },
      auth: { mechanism: 'PLAIN', username: 'app', password: 'pw' },
    })
    const m = maskSecrets(tls)
    const cases = [
      { ...m, tls: { ...m.tls, enabled: false } },
      { ...m, tls: { ...m.tls, caPem: '-----BEGIN CERTIFICATE-----\nEVIL\n-----END CERTIFICATE-----' } },
      { ...m, tls: { ...m.tls, caPem: undefined } },
      { ...m, tls: { ...m.tls, allowInvalidCertificates: true } },
      { ...m, tls: { ...m.tls, allowInvalidHostnames: true } },
      { ...m, options: { srvServiceName: 'evil' } },
      { ...m, auth: { ...m.auth, mechanismProperties: 'SERVICE_HOST:evil.example' } },
      { ...m, ssh: { ...m.ssh!, username: 'other' } },
    ]
    for (const c of cases) expect(secretReuseProblem(c, tls), JSON.stringify(c.tls)).toMatch(/re-enter/i)
    // What does not change where or how the secret goes keeps it.
    expect(secretReuseProblem({ ...m, appName: 'x', readPreference: 'secondary' }, tls)).toBeNull()
  })

  // Independent review of the security pass (I4): trust on first use. A pin the form learned from a
  // test (the stored record has none yet), or a form loaded before the first connect pinned it, is no
  // other server; only two different pins are.
  it('reuses secrets across a first pin, and refuses them for another pinned host key', () => {
    const unpinned = ConnectionSettingsSchema.parse(base)
    const pinned = ConnectionSettingsSchema.parse({
      ...base,
      ssh: { ...base.ssh, hostFingerprint: 'SHA256:aaa' },
    })
    const pin = (s: typeof unpinned, hostFingerprint?: string) => {
      const m = maskSecrets(s)
      return { ...m, ssh: { ...m.ssh!, hostFingerprint } }
    }
    expect(secretReuseProblem(pin(unpinned, 'SHA256:aaa'), unpinned)).toBeNull()
    expect(secretReuseProblem(pin(pinned, undefined), pinned)).toBeNull()
    expect(secretReuseProblem(pin(pinned, 'SHA256:aaa'), pinned)).toBeNull()
    expect(secretReuseProblem(pin(pinned, 'SHA256:bbb'), pinned)).toMatch(/re-enter/i)
  })

  it('does not object when no secret is masked', () => {
    const fresh = {
      ...masked,
      hosts: [{ host: 'other', port: 1 }],
      auth: { ...masked.auth, password: 'typed-again' },
      ssh: { ...masked.ssh!, password: 'typed' },
    }
    expect(secretReuseProblem(fresh, stored)).toBeNull()
    expect(SECRET_MASK).toBe('••••••••')
  })
})

describe('fix: no ambient cloud credentials and no socket paths', () => {
  it('rejects OIDC ENVIRONMENT properties', () => {
    for (const props of ['ENVIRONMENT:k8s', 'TOKEN_RESOURCE:x, environment:azure']) {
      const r = ConnectionSettingsSchema.safeParse({
        hosts: [{ host: 'h' }],
        auth: { mechanism: 'MONGODB-OIDC', mechanismProperties: props },
      })
      expect(r.success, props).toBe(false)
    }
  })

  // MONGODB-AWS without keys would sign in as the server's host (its instance role).
  it('asks MONGODB-AWS for the connection’s own access key ID and secret access key', () => {
    const aws = (auth: object) =>
      ConnectionSettingsSchema.safeParse({
        hosts: [{ host: 'h' }],
        auth: { mechanism: 'MONGODB-AWS', ...auth },
      })
    const none = aws({})
    expect(none.success).toBe(false)
    expect(none.error!.issues.map((i) => i.path.join('.')).sort()).toEqual(['auth.password', 'auth.username'])
    expect(aws({ username: 'AKIA' }).success).toBe(false)
    expect(aws({ username: 'AKIA', password: 'secret' }).success).toBe(true)
  })

  // W8 (completion): Kerberos signs in with the host's own ticket. The schema takes it; the
  // server's policy refuses it in team mode unless an administrator allowed it (policy.test.ts).
  it('takes Kerberos (GSSAPI) as a setting; the server decides whether it may be used', () => {
    const r = ConnectionSettingsSchema.safeParse({
      hosts: [{ host: 'h' }],
      auth: { mechanism: 'GSSAPI', username: 'u@REALM' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects percent-encoded or backslash hosts that reach sockets or pipes', () => {
    for (const host of ['%2Ftmp%2Fmongodb-27017.sock', '\\\\.\\pipe\\mongo', 'a%2Fb']) {
      expect(ConnectionSettingsSchema.safeParse({ hosts: [{ host }] }).success, host).toBe(false)
    }
  })
})

describe('minor fixes: fingerprints and mechanism properties', () => {
  it('normalises pasted SSH fingerprints', () => {
    const fp = (hostFingerprint: string) =>
      ConnectionSettingsSchema.parse({
        hosts: [{ host: 'h' }],
        ssh: { enabled: true, host: 's', username: 'u', method: 'password', password: 'p', hostFingerprint },
      }).ssh?.hostFingerprint
    expect(fp('SHA256:abcDEF123+/xyz')).toBe('SHA256:abcDEF123+/xyz')
    expect(fp('  abcDEF123+/xyz=  ')).toBe('SHA256:abcDEF123+/xyz')
    expect(fp('sha256:abc==')).toBe('SHA256:abc')
  })

  it('masks only secret mechanism properties and merges them per key', () => {
    const stored = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'h' }],
      auth: {
        mechanism: 'MONGODB-AWS',
        username: 'AKIA',
        password: 'secret',
        mechanismProperties: 'SERVICE_NAME:mongo,AWS_SESSION_TOKEN:tok123',
      },
    })
    const masked = maskSecrets(stored)
    expect(masked.auth.mechanismProperties).toBe(`SERVICE_NAME:mongo,AWS_SESSION_TOKEN:${SECRET_MASK}`)
    const edited = {
      ...masked,
      auth: { ...masked.auth, mechanismProperties: `SERVICE_NAME:other,AWS_SESSION_TOKEN:${SECRET_MASK}` },
    }
    expect(mergeSecrets(edited, stored).auth.mechanismProperties).toBe(
      'SERVICE_NAME:other,AWS_SESSION_TOKEN:tok123',
    )
    expect(mergeSecrets(masked, undefined).auth.mechanismProperties).toBe('SERVICE_NAME:mongo')
  })
})
