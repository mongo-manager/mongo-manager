// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  ConnectionSettingsSchema,
  SECRET_MASK,
  buildConnectionUri,
  hasMaskedSecret,
  isRedirectUri,
  maskSecrets,
  mergeSecrets,
  parseConnectionUri,
  secretReuseProblem,
} from '../src/connections'

const LOCAL_KEY = 'A'.repeat(128)
const host = { hosts: [{ host: 'db.example', port: 27017 }] }

const encrypted = (kms: object, extra: object = {}) =>
  ConnectionSettingsSchema.parse({
    ...host,
    encryption: { enabled: true, keyVaultNamespace: 'encryption.__keyVault', kms, ...extra },
  })

describe('W7: MONGODB-OIDC settings', () => {
  it('takes OIDC without a username or password', () => {
    const r = ConnectionSettingsSchema.safeParse({ ...host, auth: { mechanism: 'MONGODB-OIDC' } })
    expect(r.success).toBe(true)
  })

  it('refuses free mechanism properties for OIDC (ENVIRONMENT or a callback the form never showed)', () => {
    for (const props of ['ALLOWED_HOSTS:x', 'ENVIRONMENT:k8s', 'TOKEN_RESOURCE:x']) {
      const r = ConnectionSettingsSchema.safeParse({
        ...host,
        auth: { mechanism: 'MONGODB-OIDC', mechanismProperties: props },
      })
      expect(r.success, props).toBe(false)
    }
  })

  it('takes a redirect address only over https, or http on this computer', () => {
    expect(isRedirectUri('https://mm.example/oidc/callback')).toBe(true)
    expect(isRedirectUri('http://localhost:4321/oidc/callback')).toBe(true)
    expect(isRedirectUri('http://127.0.0.1:4321/oidc/callback')).toBe(true)
    expect(isRedirectUri('http://[::1]:4321/oidc/callback')).toBe(true)
    // A code in the clear across a network, or an address that hides a host: never.
    expect(isRedirectUri('http://mm.example/oidc/callback')).toBe(false)
    expect(isRedirectUri('http://localhost.evil.example/cb')).toBe(false)
    expect(isRedirectUri('https://u:p@mm.example/cb')).toBe(false)
    expect(isRedirectUri('javascript:alert(1)')).toBe(false)
    const bad = ConnectionSettingsSchema.safeParse({
      ...host,
      auth: { mechanism: 'MONGODB-OIDC', oidc: { redirectUri: 'http://mm.example/cb' } },
    })
    expect(bad.success).toBe(false)
  })

  it('takes allowed hosts as host names only', () => {
    const ok = ConnectionSettingsSchema.safeParse({
      ...host,
      auth: {
        mechanism: 'MONGODB-OIDC',
        oidc: { allowedHosts: ['*.mongodb.net', 'db.corp.example', '::1'] },
      },
    })
    expect(ok.success).toBe(true)
    for (const h of ['https://x', 'a b', 'x/y', '*']) {
      const r = ConnectionSettingsSchema.safeParse({
        ...host,
        auth: { mechanism: 'MONGODB-OIDC', oidc: { allowedHosts: [h] } },
      })
      expect(r.success, h).toBe(false)
    }
  })

  it('keeps a workload identity only as its own field, and a token resource only with one', () => {
    const r = ConnectionSettingsSchema.safeParse({
      ...host,
      auth: { mechanism: 'MONGODB-OIDC', oidc: { tokenResource: 'api://x' } },
    })
    expect(r.success).toBe(false)
    const parsed = parseConnectionUri(
      'mongodb://db.example/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:azure,TOKEN_RESOURCE:api%3A%2F%2Fx',
    )
    expect(parsed.auth.oidc).toEqual({ environment: 'azure', tokenResource: 'api://x' })
    expect(parsed.auth.mechanismProperties).toBeUndefined()
  })
})

describe('W8: Kerberos settings', () => {
  it('takes GSSAPI with its own fields (whether it may be used is the server’s policy)', () => {
    const r = ConnectionSettingsSchema.safeParse({
      ...host,
      auth: {
        mechanism: 'GSSAPI',
        username: 'u@REALM',
        kerberos: { serviceName: 'mongodb', serviceRealm: 'REALM', canonicalizeHostName: 'forward' },
      },
    })
    expect(r.success).toBe(true)
  })

  it('refuses free properties and values that would split into other properties', () => {
    const props = ConnectionSettingsSchema.safeParse({
      ...host,
      auth: { mechanism: 'GSSAPI', username: 'u', mechanismProperties: 'SERVICE_NAME:x' },
    })
    expect(props.success).toBe(false)
    const injected = ConnectionSettingsSchema.safeParse({
      ...host,
      auth: { mechanism: 'GSSAPI', username: 'u', kerberos: { serviceName: 'x,SERVICE_HOST:evil' } },
    })
    expect(injected.success).toBe(false)
  })

  it('reads a pasted string’s Kerberos properties into the fields and writes them back', () => {
    const s = parseConnectionUri(
      'mongodb://u%40REALM@db.example/?authMechanism=GSSAPI&authMechanismProperties=SERVICE_NAME:mdb,CANONICALIZE_HOST_NAME:true',
    )
    expect(s.auth.kerberos).toEqual({ serviceName: 'mdb', canonicalizeHostName: 'forward' })
    expect(s.auth.mechanismProperties).toBeUndefined()
    expect(parseConnectionUri(buildConnectionUri(s, { includeCredentials: true }))).toEqual(s)
  })
})

describe('W8: client-side encryption settings', () => {
  it('needs a key vault namespace and at least one key provider', () => {
    expect(
      ConnectionSettingsSchema.safeParse({
        ...host,
        encryption: { enabled: true, keyVaultNamespace: 'encryption.__keyVault', kms: {} },
      }).success,
    ).toBe(false)
    expect(
      ConnectionSettingsSchema.safeParse({
        ...host,
        encryption: { enabled: true, keyVaultNamespace: 'nodot', kms: { local: { key: LOCAL_KEY } } },
      }).success,
    ).toBe(false)
    expect(encrypted({ local: { key: LOCAL_KEY } }).encryption!.library).toBe('cryptShared')
  })

  it('takes a local key of exactly 96 bytes in base64', () => {
    for (const key of ['A'.repeat(127), 'A'.repeat(129), `${'A'.repeat(126)}==`, '!'.repeat(128)]) {
      const r = ConnectionSettingsSchema.safeParse({
        ...host,
        encryption: { enabled: true, keyVaultNamespace: 'a.b', kms: { local: { key } } },
      })
      expect(r.success, key).toBe(false)
    }
  })

  it('takes KMS endpoints as host[:port] only', () => {
    for (const endpoint of ['https://kms.example', 'kms.example/path', 'u@kms.example', 'kms example']) {
      const r = ConnectionSettingsSchema.safeParse({
        ...host,
        encryption: { enabled: true, keyVaultNamespace: 'a.b', kms: { kmip: { endpoint } } },
      })
      expect(r.success, endpoint).toBe(false)
    }
    expect(encrypted({ kmip: { endpoint: 'kmip.example:5696' } }).encryption!.kms.kmip!.endpoint).toBe(
      'kmip.example:5696',
    )
  })

  const full = () =>
    encrypted({
      local: { key: LOCAL_KEY },
      aws: { accessKeyId: 'AKIA', secretAccessKey: 'aws-secret', sessionToken: 'aws-session' },
      azure: { tenantId: 't', clientId: 'c', clientSecret: 'azure-secret' },
      gcp: { email: 'sa@p.iam', privateKey: 'gcp-key' },
      kmip: { endpoint: 'kmip.example', certificateKeyPem: 'kmip-pem' },
    })

  it('masks every KMS credential in answers, and restores them from the stored settings', () => {
    const stored = full()
    const masked = maskSecrets(stored)
    const text = JSON.stringify(masked)
    for (const secret of [LOCAL_KEY, 'aws-secret', 'aws-session', 'azure-secret', 'gcp-key', 'kmip-pem'])
      expect(text).not.toContain(secret)
    // What is not secret stays readable (the form shows it).
    expect(masked.encryption!.kms.aws!.accessKeyId).toBe('AKIA')
    expect(masked.encryption!.kms.local!.key).toBe(SECRET_MASK)
    expect(hasMaskedSecret(masked)).toBe(true)
    expect(secretReuseProblem(masked, stored)).toBeNull()
    expect(mergeSecrets(masked, stored)).toEqual(stored)
  })

  it('does not reuse stored KMS credentials for another account or endpoint', () => {
    const stored = full()
    const masked = maskSecrets(stored)
    const changes = [
      (m: typeof masked) => (m.encryption!.kms.aws!.accessKeyId = 'AKIA-OTHER'),
      (m: typeof masked) => (m.encryption!.kms.azure!.identityPlatformEndpoint = 'login.evil.example'),
      (m: typeof masked) => (m.encryption!.kms.gcp!.endpoint = 'oauth.evil.example'),
      (m: typeof masked) => (m.encryption!.kms.kmip!.endpoint = 'kmip.evil.example'),
      (m: typeof masked) => (m.encryption!.keyVaultNamespace = 'other.__keyVault'),
    ]
    for (const change of changes) {
      const next = structuredClone(masked)
      change(next)
      expect(secretReuseProblem(next, stored), String(change)).toMatch(/re-enter/)
    }
  })

  it('drops a masked KMS secret that has nothing stored behind it', () => {
    const incoming = encrypted({ aws: { accessKeyId: 'AKIA', secretAccessKey: SECRET_MASK } })
    expect(mergeSecrets(incoming, undefined).encryption!.kms.aws!.secretAccessKey).toBeUndefined()
  })
})
