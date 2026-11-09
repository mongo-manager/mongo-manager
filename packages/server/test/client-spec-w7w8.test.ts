// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it, vi } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { clientSpec } from '../src/connections/client-spec'
import { withToolConfig } from '../src/backup/tools'

const settings = (extra: object) =>
  ConnectionSettingsSchema.parse({ hosts: [{ host: 'h1', port: 27017 }], ...extra })

describe('W8: Kerberos (GSSAPI) in the driver options', () => {
  it('passes the principal and its own three properties, nothing else', () => {
    const spec = clientSpec(
      settings({
        auth: {
          mechanism: 'GSSAPI',
          username: 'u@REALM',
          kerberos: {
            serviceName: 'mongodb',
            serviceRealm: 'REALM',
            canonicalizeHostName: 'forwardAndReverse',
          },
        },
      }),
    )
    expect(spec.uri).toContain('authMechanism=GSSAPI')
    expect(spec.uri).not.toContain('SERVICE_NAME')
    expect(spec.options.auth).toEqual({ username: 'u@REALM' })
    expect(spec.options.authMechanismProperties).toEqual({
      SERVICE_NAME: 'mongodb',
      SERVICE_REALM: 'REALM',
      CANONICALIZE_HOST_NAME: 'forwardAndReverse',
    })
  })
})

describe('W7: MONGODB-OIDC in the driver options', () => {
  const human = settings({
    auth: { mechanism: 'MONGODB-OIDC', oidc: { allowedHosts: ['db.corp.example'] } },
  })

  it('signs in through the broker’s human callback, limited to the allowed hosts', () => {
    const callback = vi.fn()
    const spec = clientSpec(human, undefined, {}, { oidcCallback: callback })
    const props = spec.options.authMechanismProperties as Record<string, unknown>
    expect(props.OIDC_HUMAN_CALLBACK).toBe(callback)
    expect(props.ALLOWED_HOSTS).toEqual(['db.corp.example'])
    // Never the machine's identity: no ENVIRONMENT, no machine callback.
    expect(props.ENVIRONMENT).toBeUndefined()
    expect(props.OIDC_CALLBACK).toBeUndefined()
    expect(spec.options.auth).toBeUndefined()
  })

  it('refuses to build a human OIDC client without the broker (no sign-in flow to fall back on)', () => {
    expect(() => clientSpec(human)).toThrow(/OIDC/)
  })

  it('uses a workload identity only when the connection names one', () => {
    const spec = clientSpec(
      settings({
        auth: { mechanism: 'MONGODB-OIDC', oidc: { environment: 'azure', tokenResource: 'api://x' } },
      }),
      undefined,
      {},
      { oidcCallback: vi.fn() },
    )
    const props = spec.options.authMechanismProperties as Record<string, unknown>
    expect(props).toEqual({ ENVIRONMENT: 'azure', TOKEN_RESOURCE: 'api://x' })
  })
})

describe('W8: automatic encryption in the driver options', () => {
  it('passes the encryption options it is given, and none otherwise', () => {
    const autoEncryption = { keyVaultNamespace: 'encryption.__keyVault', kmsProviders: {} }
    expect(clientSpec(settings({}), undefined, {}, { autoEncryption }).options.autoEncryption).toBe(
      autoEncryption,
    )
    expect(clientSpec(settings({})).options.autoEncryption).toBeUndefined()
  })
})

describe('W7, W8: the database tools never sign in as the host or with someone’s token', () => {
  // The tools would read the host's Kerberos ticket cache, or need a person's OIDC token.
  it('refuses to run a tool for a Kerberos or an OIDC connection', async () => {
    for (const auth of [
      { mechanism: 'GSSAPI', username: 'u' },
      { mechanism: 'MONGODB-OIDC' },
      { mechanism: 'MONGODB-OIDC', oidc: { environment: 'k8s' } },
    ]) {
      const fn = vi.fn()
      await expect(withToolConfig(settings({ auth }), fn)).rejects.toThrow(/Kerberos|OIDC/)
      expect(fn).not.toHaveBeenCalled()
    }
  })
})
