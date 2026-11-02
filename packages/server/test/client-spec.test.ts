import { describe, expect, it, vi } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { clientSpec } from '../src/connections/client-spec'
import { ConnectionManager } from '../src/connections/manager'
import { classifyError, redactUris } from '../src/connections/errors'

const settings = (extra: object) =>
  ConnectionSettingsSchema.parse({ hosts: [{ host: 'h1', port: 27017 }], ...extra })

describe('clientSpec', () => {
  it('never gives the driver a stored timeoutMS: the app bounds each operation itself', () => {
    const spec = clientSpec({ ...settings({}), options: { timeoutMS: '5000', maxPoolSize: '5' } } as never)
    expect(spec.uri).not.toMatch(/timeoutMS/i)
    expect(spec.uri).toContain('maxPoolSize=5')
    expect((spec.options as { timeoutMS?: unknown }).timeoutMS).toBeUndefined()
  })

  it('keeps credentials out of the URI and passes them as options', () => {
    const spec = clientSpec(
      settings({
        auth: { mechanism: 'SCRAM-SHA-256', username: 'app', password: 's3cret', authSource: 'admin' },
      }),
    )
    expect(spec.uri).toBe('mongodb://h1:27017/?authMechanism=SCRAM-SHA-256&authSource=admin')
    expect(spec.options.auth).toEqual({ username: 'app', password: 's3cret' })
    expect(spec.options.serverSelectionTimeoutMS).toBe(10_000)
    expect(spec.options.appName).toBe('Mongo Manager')
  })

  it('maps pasted TLS material and mechanism properties', () => {
    const spec = clientSpec(
      settings({
        auth: {
          mechanism: 'MONGODB-AWS',
          username: 'AKIA',
          password: 'secret',
          mechanismProperties: 'SERVICE_NAME:mongo,CANONICALIZE_HOST_NAME:true',
        },
        tls: { enabled: true, caPem: 'CA', certificateKeyPem: 'CERTKEY', certificateKeyPassword: 'kp' },
      }),
    )
    expect(spec.options).toMatchObject({
      tls: true,
      ca: 'CA',
      cert: 'CERTKEY',
      key: 'CERTKEY',
      passphrase: 'kp',
    })
    expect(spec.options.authMechanismProperties).toMatchObject({
      SERVICE_NAME: 'mongo',
      CANONICALIZE_HOST_NAME: 'true',
    })
    expect(spec.uri).not.toContain('SERVICE_NAME')
  })

  // MONGODB-AWS: the driver takes no keys in the URI or as credentials; they reach it through a
  // credential provider. Only the connection's own keys: never the host's own AWS identity (its
  // environment, profile or instance role), which a user of the server must not borrow.
  it('signs in to AWS with the connection’s own keys only, through a credential provider', async () => {
    const spec = clientSpec(
      settings({
        auth: {
          mechanism: 'MONGODB-AWS',
          username: 'AKIAEXAMPLE',
          password: 'secret/key',
          mechanismProperties: 'AWS_SESSION_TOKEN:tok:en,FOO:bar',
        },
      }),
    )
    expect(spec.options.auth).toBeUndefined()
    const props = spec.options.authMechanismProperties as Record<string, unknown>
    expect(props.AWS_SESSION_TOKEN).toBeUndefined()
    expect(props.FOO).toBe('bar')
    const provider = props.AWS_CREDENTIAL_PROVIDER as () => Promise<unknown>
    await expect(provider()).resolves.toEqual({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret/key',
      sessionToken: 'tok:en',
    })
    expect(spec.uri).not.toContain('AKIAEXAMPLE')
    expect(spec.uri).not.toContain('tok')
    // A connection stored without keys never falls back to the host's own.
    const bare = clientSpec({
      ...settings({}),
      auth: { mechanism: 'MONGODB-AWS' },
    } as never)
    const none = (bare.options.authMechanismProperties as Record<string, unknown>)
      .AWS_CREDENTIAL_PROVIDER as () => Promise<unknown>
    await expect(none()).rejects.toThrow(/access key ID and a secret access key/)
  })

  // Review minor 2: a space after a comma kept the session token from the driver (" AWS_SESSION_TOKEN").
  it('reads property keys as typed with spaces around them', async () => {
    const spec = clientSpec(
      settings({
        auth: {
          mechanism: 'MONGODB-AWS',
          username: 'AKIA',
          password: 'secret',
          mechanismProperties: 'FOO:x, AWS_SESSION_TOKEN:tok',
        },
      }),
    )
    const props = spec.options.authMechanismProperties as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(['AWS_CREDENTIAL_PROVIDER', 'FOO'])
    await expect((props.AWS_CREDENTIAL_PROVIDER as () => Promise<unknown>)()).resolves.toMatchObject({
      sessionToken: 'tok',
    })
  })

  // Review I1: properties stored for another method (a Kerberos connection changed to SCRAM) are
  // never passed: the driver refuses CANONICALIZE_HOST_NAME:true for every method.
  it('passes mechanism properties only to MONGODB-AWS', () => {
    const spec = clientSpec({
      ...settings({}),
      auth: {
        mechanism: 'SCRAM-SHA-256',
        username: 'u',
        password: 'p',
        mechanismProperties: 'CANONICALIZE_HOST_NAME:true',
      },
    } as never)
    expect(spec.options.authMechanismProperties).toBeUndefined()
  })

  // W7: a human OIDC sign-in needs the server's broker (client-spec-w7w8.test.ts covers the rest).
  it('refuses MONGODB-OIDC without the sign-in broker', () => {
    expect(() => clientSpec({ ...settings({}), auth: { mechanism: 'MONGODB-OIDC' } } as never)).toThrow(
      /OIDC/,
    )
  })

  // Review minor 5: a refused method is refused before an SSH tunnel is dialled (W8: Kerberos is
  // refused by the server's policy; with none given, the manager refuses it).
  it('refuses Kerberos before opening an SSH tunnel', async () => {
    const openTunnel = vi.fn(() => new Promise<never>(() => undefined))
    const stored = {
      ...settings({ ssh: { enabled: true, host: 's', username: 'u', method: 'password', password: 'p' } }),
      auth: { mechanism: 'GSSAPI', username: 'u' },
    } as never
    const manager = new ConnectionManager({ load: () => ({ settings: stored }), openTunnel })
    await expect(manager.getClient('c1')).rejects.toThrow(/Kerberos/)
    expect(openTunnel).not.toHaveBeenCalled()
    await manager.closeAll(100)
  })

  it('rewrites the target to the tunnel and keeps TLS host verification on the real host name', () => {
    const spec = clientSpec(settings({ tls: { enabled: true }, replicaSet: 'rs0' }), {
      host: '127.0.0.1',
      port: 40000,
      credentials: { username: 'mm-u', password: 'p' },
    })
    expect(spec.uri).toBe('mongodb://127.0.0.1:40000/?replicaSet=rs0&directConnection=true&tls=true')
    expect(spec.options.servername).toBe('h1')
    // The endpoint is the tunnel's SOCKS5 proxy, reached with its own credentials (plan 1c).
    expect(spec.options).toMatchObject({
      proxyHost: '127.0.0.1',
      proxyPort: 40000,
      proxyUsername: 'mm-u',
      proxyPassword: 'p',
    })
    expect(clientSpec(settings({})).options).not.toHaveProperty('proxyHost')
  })

  it('repairs pasted PEM blocks that were concatenated without a newline', () => {
    const glued =
      '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE----------BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----'
    const spec = clientSpec(settings({ tls: { enabled: true, certificateKeyPem: glued, caPem: glued } }))
    expect(spec.options.cert).toBe(
      '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----',
    )
    expect(spec.options.key).toBe(spec.options.cert)
    expect(spec.options.ca).toBe(spec.options.cert)
  })

  it('applies overrides last', () => {
    expect(
      clientSpec(settings({}), undefined, { serverSelectionTimeoutMS: 5_000 }).options
        .serverSelectionTimeoutMS,
    ).toBe(5_000)
  })
})

describe('classifyError', () => {
  it('recognises common failures and redacts URIs', () => {
    expect(
      classifyError(
        Object.assign(new Error('Authentication failed.'), { name: 'MongoServerError', code: 18 }),
      ).kind,
    ).toBe('auth')
    expect(classifyError(new Error('getaddrinfo ENOTFOUND nope.invalid')).kind).toBe('dns')
    expect(classifyError(new Error('querySrv ENOTFOUND _mongodb._tcp.x')).kind).toBe('dns')
    expect(classifyError(new Error('self-signed certificate in certificate chain')).kind).toBe('tls')
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:1')).kind).toBe('network')
    expect(
      classifyError(
        Object.assign(new Error('Server selection timed out after 5000 ms'), {
          name: 'MongoServerSelectionError',
        }),
      ).kind,
    ).toBe('timeout')
    expect(
      classifyError(
        Object.assign(new Error('Optional module `kerberos` not found'), {
          name: 'MongoMissingDependencyError',
        }),
      ).kind,
    ).toBe('dependency')
    expect(classifyError(new Error('boom mongodb://u:p@h/x')).message).not.toContain('u:p@h')
    expect(redactUris('see mongodb+srv://a:b@c/d?x=1 now')).toBe('see [connection string] now')
  })
})
