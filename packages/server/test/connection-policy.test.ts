import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { connectionProblem, libraryPathProblem, type ConnectionPolicy } from '../src/connections/policy'
import type { OptionalModules } from '../src/optional/modules'
import { configFromEnv, resolveConfig } from '../src/config'

const both: OptionalModules = {
  distribution: 'npm',
  clientEncryption: { status: 'available', version: '6.5.0' },
  kerberos: { status: 'available', version: '2.2.2' },
}
const none: OptionalModules = {
  distribution: 'npm',
  clientEncryption: { status: 'missing', version: null },
  kerberos: { status: 'missing', version: null },
}
const policy = (over: Partial<ConnectionPolicy> = {}): ConnectionPolicy => ({
  teamMode: false,
  allowKerberos: false,
  allowWorkloadIdentity: false,
  cryptSharedLibPath: undefined,
  kmsAllowedHosts: [],
  modules: both,
  isLibraryFile: () => true,
  ...over,
})
const settings = (s: object) => ConnectionSettingsSchema.parse({ hosts: [{ host: 'db.example' }], ...s })
const kerberos = settings({ auth: { mechanism: 'GSSAPI', username: 'u@REALM' } })
const LOCAL_KEY = 'A'.repeat(128)
/**
 * A full path on the computer the tests run on (fourth review of the CI fixes: on Windows, /opt/...
 * is on the current drive, never a library's place).
 */
const OPT = process.platform === 'win32' ? 'C:\\opt\\' : '/opt/'
const LIB = `${OPT}mongo_crypt_v1.${process.platform === 'win32' ? 'dll' : 'so'}`
const encryption = (e: object = {}) =>
  settings({
    encryption: {
      enabled: true,
      keyVaultNamespace: 'encryption.__keyVault',
      kms: { local: { key: LOCAL_KEY } },
      cryptSharedLibPath: LIB,
      ...e,
    },
  })

describe('W8: Kerberos is the server machine’s ticket', () => {
  it('is allowed in local mode when the kerberos package is there', () => {
    expect(connectionProblem(kerberos, policy())).toBeNull()
  })

  it('is refused without the package, saying how to get it', () => {
    const p = connectionProblem(kerberos, policy({ modules: none }))
    expect(p?.reason).toBe('kerberos_unavailable')
    expect(p?.message).toMatch(/npm i -g kerberos/)
    const sea = connectionProblem(
      kerberos,
      policy({
        modules: {
          ...none,
          distribution: 'standalone',
          kerberos: { status: 'not_in_package', version: null },
        },
      }),
    )
    expect(sea?.message).toMatch(/not available in this package/)
  })

  // Abuse case: in team mode every user would sign in as the Mongo Manager server's own account.
  it('is refused in team mode unless an administrator allowed it on the server', () => {
    expect(connectionProblem(kerberos, policy({ teamMode: true }))?.reason).toBe('kerberos_team_disabled')
    expect(connectionProblem(kerberos, policy({ teamMode: true, allowKerberos: true }))).toBeNull()
  })

  it('is allowed by MM_ALLOW_KERBEROS, off by default', () => {
    expect(resolveConfig({}).allowKerberos).toBe(false)
    expect(resolveConfig({ env: { MM_ALLOW_KERBEROS: '1' } }).allowKerberos).toBe(true)
    expect(configFromEnv({ MM_ALLOW_WORKLOAD_IDENTITY: 'true' }).allowWorkloadIdentity).toBe(true)
  })
})

describe('W7: OIDC never signs in as the machine unless chosen and allowed', () => {
  const tls = { enabled: true }
  const human = settings({
    hosts: [{ host: 'cluster0.ab12.mongodb.net' }],
    tls,
    auth: { mechanism: 'MONGODB-OIDC' },
  })
  const workload = settings({
    hosts: [{ host: 'cluster0.ab12.mongodb.net' }],
    tls,
    auth: { mechanism: 'MONGODB-OIDC', oidc: { environment: 'azure', environmentConfirmed: 'azure' } },
  })

  it('signs each person in through their identity provider, in either mode', () => {
    expect(connectionProblem(human, policy())).toBeNull()
    expect(connectionProblem(human, policy({ teamMode: true }))).toBeNull()
  })

  it('takes a workload identity chosen on the connection in local mode', () => {
    expect(connectionProblem(workload, policy())).toBeNull()
  })

  // Abuse case: through an SSH tunnel the driver sees 127.0.0.1 (always allowed): the hosts the
  // tokens really go to are checked against the allowed hosts here too.
  it('sends a person’s tokens only to allowed hosts (Atlas and this computer unless others are listed)', () => {
    const at = (host: string, allowedHosts?: string[]) =>
      settings({
        hosts: [{ host }],
        tls,
        auth: { mechanism: 'MONGODB-OIDC', ...(allowedHosts ? { oidc: { allowedHosts } } : {}) },
      })
    expect(connectionProblem(at('cluster0.ab12.mongodb.net'), policy())).toBeNull()
    expect(connectionProblem(at('localhost'), policy())).toBeNull()
    expect(connectionProblem(at('db.corp.example'), policy())?.reason).toBe('oidc_host_not_allowed')
    expect(connectionProblem(at('db.corp.example', ['*.corp.example']), policy())).toBeNull()
    expect(connectionProblem(at('evilcorp.example', ['*.corp.example']), policy())?.reason).toBe(
      'oidc_host_not_allowed',
    )
    expect(connectionProblem(at('DB.Corp.Example', ['db.corp.example']), policy())).toBeNull()
  })

  // Security review I3, abuse case: a workload identity is this server's own cloud token — sent to
  // a host someone chose, it is theirs to use. Allowed hosts hold for it as for a person's.
  it('sends a workload identity’s token only to allowed hosts too', () => {
    const at = (host: string, allowedHosts?: string[]) =>
      settings({
        hosts: [{ host }],
        tls,
        auth: {
          mechanism: 'MONGODB-OIDC',
          oidc: {
            environment: 'k8s',
            environmentConfirmed: 'k8s',
            ...(allowedHosts ? { allowedHosts } : {}),
          },
        },
      })
    expect(connectionProblem(at('attacker.example'), policy())?.reason).toBe('oidc_host_not_allowed')
    expect(connectionProblem(at('db.corp.example', ['db.corp.example']), policy())).toBeNull()
  })

  // Security review I3, abuse case: a pasted connection string fills TOKEN_RESOURCE — the audience
  // the host's identity mints a token for. It is used only once someone confirmed that very value.
  it('uses a token resource only once it was confirmed, that very value', () => {
    const withResource = (oidc: object) =>
      settings({
        hosts: [{ host: 'cluster0.ab12.mongodb.net' }],
        tls,
        auth: {
          mechanism: 'MONGODB-OIDC',
          oidc: { environment: 'azure', environmentConfirmed: 'azure', ...oidc },
        },
      })
    const resource = 'api://mongodb-prod'
    for (const p of [policy(), policy({ teamMode: true, allowWorkloadIdentity: true })]) {
      expect(connectionProblem(withResource({ tokenResource: resource }), p)?.reason).toBe(
        'oidc_token_resource_unconfirmed',
      )
      expect(
        connectionProblem(withResource({ tokenResource: resource, tokenResourceConfirmed: 'api://other' }), p)
          ?.reason,
      ).toBe('oidc_token_resource_unconfirmed')
      expect(
        connectionProblem(withResource({ tokenResource: resource, tokenResourceConfirmed: resource }), p),
      ).toBeNull()
    }
    // An import tolerates the confirmation it dropped — and nothing after it.
    const imported = settings({
      hosts: [{ host: 'cluster0.ab12.mongodb.net' }],
      tls,
      auth: { mechanism: 'MONGODB-OIDC', oidc: { environment: 'azure', tokenResource: resource } },
      encryption: {
        enabled: true,
        keyVaultNamespace: 'encryption.__keyVault',
        kms: { local: { key: LOCAL_KEY } },
      },
    })
    const tolerate = new Set(['oidc_token_resource_unconfirmed', 'oidc_workload_unconfirmed'] as const)
    expect(connectionProblem(imported, policy({ modules: none }), { tolerate })?.reason).toBe(
      'encryption_unavailable',
    )
  })

  // Re-review item 3, abuse case: an imported Kubernetes workload identity (no token resource) would
  // have this server's own identity sign in to whatever hosts the file names, with nobody asked.
  it('uses a workload identity only once that very environment was confirmed', () => {
    const k8s = (oidc: object) =>
      settings({
        hosts: [{ host: 'cluster0.ab12.mongodb.net' }],
        tls,
        auth: { mechanism: 'MONGODB-OIDC', oidc: { environment: 'k8s', ...oidc } },
      })
    expect(connectionProblem(k8s({ environmentConfirmed: undefined }), policy())?.reason).toBe(
      'oidc_workload_unconfirmed',
    )
    expect(connectionProblem(k8s({ environmentConfirmed: 'azure' }), policy())?.reason).toBe(
      'oidc_workload_unconfirmed',
    )
    expect(connectionProblem(k8s({ environmentConfirmed: 'k8s' }), policy())).toBeNull()
  })

  // Security review I4, abuse case: without TLS a person's access token crosses the network in the
  // clear, for anyone on the path to take.
  it('sends tokens only over TLS, unless to this computer or through an SSH tunnel', () => {
    const over = (s: object) =>
      settings({ hosts: [{ host: 'cluster0.ab12.mongodb.net' }], auth: { mechanism: 'MONGODB-OIDC' }, ...s })
    expect(connectionProblem(over({}), policy())?.reason).toBe('oidc_needs_tls')
    expect(
      connectionProblem(over({ tls: { enabled: true, allowInvalidCertificates: true } }), policy())?.reason,
    ).toBe('oidc_needs_tls')
    expect(
      connectionProblem(over({ tls: { enabled: true, allowInvalidHostnames: true } }), policy())?.reason,
    ).toBe('oidc_needs_tls')
    expect(connectionProblem(over({ tls: { enabled: true } }), policy())).toBeNull()
    expect(connectionProblem(over({ hosts: [{ host: '127.0.0.1' }] }), policy())).toBeNull()
    expect(connectionProblem(over({ hosts: [{ host: 'localhost' }, { host: '::1' }] }), policy())).toBeNull()
    expect(
      connectionProblem(
        over({
          hosts: [{ host: 'db.corp.example' }],
          auth: { mechanism: 'MONGODB-OIDC', oidc: { allowedHosts: ['db.corp.example'] } },
          ssh: { enabled: true, host: 'bastion.example', username: 'u', method: 'password', password: 'p' },
        }),
        policy(),
      ),
    ).toBeNull()
    expect(
      connectionProblem(over({ auth: { mechanism: 'MONGODB-OIDC', oidc: { environment: 'gcp' } } }), policy())
        ?.reason,
    ).toBe('oidc_needs_tls')
  })

  it('refuses a workload identity in team mode unless the server allows it', () => {
    expect(connectionProblem(workload, policy({ teamMode: true }))?.reason).toBe(
      'workload_identity_team_disabled',
    )
    expect(connectionProblem(workload, policy({ teamMode: true, allowWorkloadIdentity: true }))).toBeNull()
  })
})

describe('W8: client-side encryption needs its package and a library the operator chose', () => {
  it('is refused without mongodb-client-encryption', () => {
    const p = connectionProblem(encryption(), policy({ modules: none }))
    expect(p?.reason).toBe('encryption_unavailable')
    expect(p?.message).toMatch(/npm i -g mongodb-client-encryption/)
  })

  it('is fine when switched off, whatever is installed', () => {
    expect(connectionProblem(encryption({ enabled: false }), policy({ modules: none }))).toBeNull()
  })

  // Abuse case: a library path is code the server loads. In team mode only the operator's own.
  it('loads a crypt_shared path of the connection in local mode only', () => {
    expect(connectionProblem(encryption(), policy())).toBeNull()
    const team = connectionProblem(encryption(), policy({ teamMode: true }))
    expect(team?.reason).toBe('crypt_shared_path_team')
    expect(connectionProblem(encryption(), policy({ teamMode: true, cryptSharedLibPath: LIB }))).toBeNull()
    expect(
      connectionProblem(
        encryption({ cryptSharedLibPath: undefined }),
        policy({ teamMode: true, cryptSharedLibPath: LIB }),
      ),
    ).toBeNull()
  })

  it('needs a crypt_shared path from somewhere, never the system’s library search', () => {
    expect(connectionProblem(encryption({ cryptSharedLibPath: undefined }), policy())?.reason).toBe(
      'crypt_shared_path_needed',
    )
    expect(connectionProblem(encryption({ cryptSharedLibPath: 'relative/lib.so' }), policy())?.reason).toBe(
      'crypt_shared_path_needed',
    )
  })

  it('reaches mongocryptd on this computer only', () => {
    const remote = encryption({ library: 'mongocryptd', mongocryptdUri: 'mongodb://cryptd.example:27020' })
    expect(connectionProblem(remote, policy())?.reason).toBe('mongocryptd_not_local')
    const local = encryption({ library: 'mongocryptd', mongocryptdUri: 'mongodb://localhost:27020' })
    expect(connectionProblem(local, policy())).toBeNull()
    expect(connectionProblem(encryption({ library: 'mongocryptd' }), policy())).toBeNull()
  })

  // Security review Minor 9: a loopback host and a port, nothing else — no credentials, no second
  // host, no options (tls, proxies, a directConnection elsewhere).
  it('takes a mongocryptd address of a loopback host and a port only', () => {
    for (const uri of ['mongodb://127.0.0.1:27020', 'mongodb://[::1]:27020', 'mongodb://localhost:27020/'])
      expect(
        connectionProblem(encryption({ library: 'mongocryptd', mongocryptdUri: uri }), policy()),
        uri,
      ).toBeNull()
    for (const uri of [
      'mongodb://localhost:27020/?proxyHost=evil.example',
      'mongodb://localhost:27020?tls=true',
      'mongodb://u:p@localhost:27020',
      'mongodb://localhost:27020,evil.example:27020',
      'mongodb://localhost',
      'mongodb+srv://localhost',
      'mongodb://localhost.evil.example:27020',
    ])
      expect(
        connectionProblem(encryption({ library: 'mongocryptd', mongocryptdUri: uri }), policy())?.reason,
        uri,
      ).toBe('mongocryptd_not_local')
  })

  // Security review I2, abuse case: an imported connection names a library on a network share (or
  // any file at all) — the server would load and run it.
  it('loads only a mongo_crypt_v1 file on this computer that exists', () => {
    // Every path is a file here (a share answers over SMB) except the missing one: the refusals
    // below are the policy's own.
    const p = policy({ isLibraryFile: (path) => !path.includes('missing') })
    const reason = (path: string) => connectionProblem(encryption({ cryptSharedLibPath: path }), p)?.reason
    expect(reason(LIB)).toBeUndefined()
    for (const bad of [
      '\\\\attacker.example\\share\\mongo_crypt_v1.dll',
      '//attacker.example/share/mongo_crypt_v1.so',
      '\\\\?\\UNC\\attacker.example\\share\\mongo_crypt_v1.dll',
      `${OPT}evil.so`,
      `${LIB}.evil`,
      `${OPT}missing${OPT.at(-1)}mongo_crypt_v1.so`,
    ])
      expect(reason(bad), bad).toBe('crypt_shared_path_invalid')
  })

  it('checks the file itself on this computer: a regular file, not a folder of that name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-crypt-'))
    try {
      const file = join(dir, 'mongo_crypt_v1.so')
      writeFileSync(file, 'x')
      const folder = join(dir, 'sub', 'mongo_crypt_v1.so')
      mkdirSync(folder, { recursive: true })
      const real = policy({ isLibraryFile: undefined })
      expect(connectionProblem(encryption({ cryptSharedLibPath: file }), real)).toBeNull()
      expect(connectionProblem(encryption({ cryptSharedLibPath: folder }), real)?.reason).toBe(
        'crypt_shared_path_invalid',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the server’s crypt_shared path from MM_CRYPT_SHARED_LIB_PATH (absolute only)', () => {
    // A full path where the tests run: on Windows, /opt/... is on the current drive (third review of
    // the CI fixes, minor 6), and refused like any relative one.
    const lib = process.platform === 'win32' ? 'C:\\lib\\mongo_crypt_v1.dll' : '/opt/mongo_crypt_v1.so'
    expect(resolveConfig({ env: { MM_CRYPT_SHARED_LIB_PATH: lib } }).encryption.cryptSharedLibPath).toBe(lib)
    expect(() => resolveConfig({ env: { MM_CRYPT_SHARED_LIB_PATH: 'lib.so' } })).toThrow(/absolute/)
    if (process.platform === 'win32') {
      expect(() => resolveConfig({ env: { MM_CRYPT_SHARED_LIB_PATH: '\\lib\\x.dll' } })).toThrow(/absolute/)
      // Fourth review (minor 10): a connection's own path neither (\\x is on the current drive).
      expect(libraryPathProblem('\\lib\\mongo_crypt_v1.dll', () => true)).toBeNull()
    }
    expect(resolveConfig({ env: { MM_OIDC_PRIVATE_NETWORKS: '10.0.0.0/8' } }).oidc.privateNetworks).toEqual([
      '10.0.0.0/8',
    ])
  })
})
