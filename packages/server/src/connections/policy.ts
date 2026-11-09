// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { realpathSync, statSync } from 'node:fs'
import type { ConnectionSettings } from '@mongo-manager/shared'
import { isLoopbackHost, type Config } from '../config'
import { safeEqual } from '../http/security'
import { moduleUnavailableMessage, type OptionalModules } from '../optional/modules'
import { fullPath } from '../backup/series'

/**
 * W7, W8 (completion): what a server lets its connections sign in with and load. The settings
 * schema (shared) takes Kerberos, OIDC and client-side encryption as settings; whether they may be
 * used depends on the mode, the server's own settings and the optional packages installed, so it
 * is decided here — when a connection is saved, tested, imported, and again each time it connects
 * (a policy changed since it was saved still holds).
 */
export interface ConnectionPolicy {
  teamMode: boolean
  allowKerberos: boolean
  allowWorkloadIdentity: boolean
  /** The operator's crypt_shared library (MM_CRYPT_SHARED_LIB_PATH). */
  cryptSharedLibPath: string | undefined
  /** Security review C1: KMS hosts an operator allows besides the providers' own (MM_KMS_ALLOWED_HOSTS). */
  kmsAllowedHosts: string[]
  /** Security review I2: whether a library path is a regular file on this computer (tests replace it). */
  isLibraryFile?: (path: string) => boolean
  modules: OptionalModules
}

export function policyOf(config: Config, modules: OptionalModules): ConnectionPolicy {
  return {
    teamMode: config.auth,
    allowKerberos: config.allowKerberos,
    allowWorkloadIdentity: config.allowWorkloadIdentity,
    cryptSharedLibPath: config.encryption.cryptSharedLibPath,
    kmsAllowedHosts: config.encryption.allowedHosts,
    modules,
  }
}

export type PolicyReason =
  | 'kerberos_unavailable'
  | 'kerberos_team_disabled'
  | 'workload_identity_team_disabled'
  | 'encryption_unavailable'
  | 'crypt_shared_path_team'
  | 'crypt_shared_path_needed'
  | 'crypt_shared_path_invalid'
  | 'mongocryptd_not_local'
  | 'oidc_host_not_allowed'
  | 'oidc_needs_tls'
  | 'oidc_token_resource_unconfirmed'
  | 'oidc_workload_unconfirmed'

export interface PolicyProblem {
  reason: PolicyReason
  message: string
  /** The form field it is about (a settings path). */
  field: string
}

/**
 * Security review Minor 9: mongocryptd's address is a loopback host and a port, nothing more — no
 * credentials, no second host and no options (a proxy, TLS settings) the driver would act on.
 */
function isLocalMongocryptd(uri: string): boolean {
  return /^mongodb:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}\/?$/i.test(uri)
}

/** A network path: \\host\share, //host/share, \\?\UNC\… (Windows loads these over SMB). */
const isNetworkPath = (p: string) => /^(?:\\\\|\/\/|\\\/|\/\\)/.test(p)

function isLibraryFile(path: string): boolean {
  try {
    // Its real path too: a link on this computer pointing at a share is still a share.
    const real = realpathSync.native(path)
    return !isNetworkPath(real) && statSync(real).isFile()
  } catch {
    return false
  }
}

/** Security review I2: why a library path a connection names may not be loaded; null when it may. */
export function libraryPathProblem(path: string, isFile: (path: string) => boolean): string | null {
  if (isNetworkPath(path))
    return 'A library on a network share is never loaded: copy mongo_crypt_v1 to this computer and give its path'
  // Fourth review of the CI fixes (minor 10): a full path with its drive on Windows (\\x is on the
  // current drive), as the server's own MM_CRYPT_SHARED_LIB_PATH is.
  if (!fullPath(path)) return null // said below: crypt_shared_path_needed
  const name = path.split(/[\\/]/).pop() ?? ''
  if (!/^mongo_crypt_v1\.(?:so|dylib|dll)$/.test(name))
    return 'The crypt_shared library is the file mongo_crypt_v1.so, mongo_crypt_v1.dylib or mongo_crypt_v1.dll'
  if (!isFile(path)) return `${path} is not a file on this computer`
  return null
}

/** The MongoDB driver's own OIDC ALLOWED_HOSTS default: Atlas and this computer. */
export const DEFAULT_OIDC_HOSTS = [
  '*.mongodb.net',
  '*.mongodb-qa.net',
  '*.mongodb-dev.net',
  '*.mongodbgov.net',
  'localhost',
  '127.0.0.1',
  '::1',
]

function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return patterns.some((p) => {
    const q = p.toLowerCase()
    return q.startsWith('*.') ? h.endsWith(q.slice(1)) && h.length > q.length - 1 : h === q
  })
}

/** The crypt_shared library this connection would load: the operator's in team mode. */
export function cryptSharedPathFor(
  settings: ConnectionSettings,
  policy: ConnectionPolicy,
): string | undefined {
  const own = settings.encryption?.cryptSharedLibPath
  if (policy.teamMode) return policy.cryptSharedLibPath
  return own ?? policy.cryptSharedLibPath
}

/**
 * Why this connection may not be used on this server; null when it may. An import tolerates what
 * it dropped itself (security review I2, I3) — and only that: every other check still holds.
 */
export function connectionProblem(
  settings: ConnectionSettings,
  policy: ConnectionPolicy,
  o: { tolerate?: ReadonlySet<PolicyReason> } = {},
): PolicyProblem | null {
  for (const p of problemsOf(settings, policy)) if (!o.tolerate?.has(p.reason)) return p
  return null
}

function* problemsOf(settings: ConnectionSettings, policy: ConnectionPolicy): Generator<PolicyProblem> {
  const { auth } = settings
  if (auth.mechanism === 'GSSAPI') {
    if (policy.modules.kerberos.status !== 'available')
      yield {
        reason: 'kerberos_unavailable',
        message: moduleUnavailableMessage('kerberos', policy.modules.kerberos),
        field: 'auth.mechanism',
      }
    // Abuse case: in team mode every user would sign in with the server's own Kerberos ticket.
    if (policy.teamMode && !policy.allowKerberos)
      yield {
        reason: 'kerberos_team_disabled',
        message:
          'Kerberos signs in with the Mongo Manager server’s own ticket, for every user: an administrator must allow it on the server first (MM_ALLOW_KERBEROS)',
        field: 'auth.mechanism',
      }
  }
  if (
    auth.mechanism === 'MONGODB-OIDC' &&
    auth.oidc?.environment &&
    policy.teamMode &&
    !policy.allowWorkloadIdentity
  )
    yield {
      reason: 'workload_identity_team_disabled',
      message:
        'A workload identity is the Mongo Manager server’s own cloud identity, for every user: an administrator must allow it on the server first (MM_ALLOW_WORKLOAD_IDENTITY)',
      field: 'auth.oidc.environment',
    }
  // W7: a person's tokens go only to allowed hosts. The driver checks the hosts it dials — through
  // an SSH tunnel that is 127.0.0.1 — so the hosts named here are checked as well. Security review
  // I3: a workload identity's too — it is this server's own cloud token, worth as much to a stranger.
  if (auth.mechanism === 'MONGODB-OIDC') {
    const allowed = auth.oidc?.allowedHosts?.length ? auth.oidc.allowedHosts : DEFAULT_OIDC_HOSTS
    const refused = settings.hosts.find((h) => !hostAllowed(h.host, allowed))
    if (refused)
      yield {
        reason: 'oidc_host_not_allowed',
        message: `${refused.host} is not an allowed host for OIDC sign-in: add it to the allowed hosts if your tokens may go there`,
        field: 'auth.oidc.allowedHosts',
      }
    // Security review I4: a token never crosses the network in the clear (nor over TLS that accepts
    // any certificate) — unless to this computer, or inside an SSH tunnel.
    const tls = settings.tls
    const sealed = tls.enabled && !tls.allowInvalidCertificates && !tls.allowInvalidHostnames
    const local = settings.hosts.every((h) => isLoopbackHost(h.host.replace(/^\[|\]$/g, '')))
    if (!sealed && !local && !settings.ssh?.enabled)
      yield {
        reason: 'oidc_needs_tls',
        message:
          'OIDC sends an access token to the server: turn TLS on (with certificate checks), or reach the server through an SSH tunnel',
        field: 'tls.enabled',
      }
    // W7 re-review: a workload identity is this server's own cloud identity signing in to the
    // connection's hosts — used once someone confirmed that very environment here (an imported
    // file's confirmation is dropped).
    const environment = auth.oidc?.environment
    if (environment && auth.oidc?.environmentConfirmed !== environment)
      yield {
        reason: 'oidc_workload_unconfirmed',
        message: `Confirm the workload identity (${environment}): this server's own cloud identity signs in to the connection's hosts`,
        field: 'auth.oidc.environment',
      }
    // Security review I3: the audience the host's identity mints a token for, confirmed as is (a
    // pasted connection string fills it without anyone choosing it).
    const resource = auth.oidc?.tokenResource
    if (resource && !safeEqual(auth.oidc?.tokenResourceConfirmed ?? '', resource))
      yield {
        reason: 'oidc_token_resource_unconfirmed',
        message: `Confirm the token resource ${resource}: this server's own cloud identity gets a token for it and sends it to the connection's hosts`,
        field: 'auth.oidc.tokenResource',
      }
  }
  const e = settings.encryption
  if (e?.enabled) {
    if (policy.modules.clientEncryption.status !== 'available')
      yield {
        reason: 'encryption_unavailable',
        message: moduleUnavailableMessage('mongodb-client-encryption', policy.modules.clientEncryption),
        field: 'encryption.enabled',
      }
    if (e.library === 'cryptShared') {
      // A library path is code this server loads: in team mode only the operator's own.
      if (policy.teamMode && e.cryptSharedLibPath && e.cryptSharedLibPath !== policy.cryptSharedLibPath)
        yield {
          reason: 'crypt_shared_path_team',
          message:
            'In team mode only the server’s own crypt_shared library is loaded (MM_CRYPT_SHARED_LIB_PATH): leave the path empty',
          field: 'encryption.cryptSharedLibPath',
        }
      // Security review I2: a path the connection names (local mode; an imported file can carry
      // one) is a mongo_crypt_v1 file on this computer — never a network share, never another file.
      const own = !policy.teamMode ? e.cryptSharedLibPath : undefined
      if (own) {
        const problem = libraryPathProblem(own, policy.isLibraryFile ?? isLibraryFile)
        if (problem)
          yield {
            reason: 'crypt_shared_path_invalid',
            message: problem,
            field: 'encryption.cryptSharedLibPath',
          }
      }
      // Never the system's library search (a DLL planted in the working directory).
      const path = cryptSharedPathFor(settings, policy)
      if (!path || !fullPath(path))
        yield {
          reason: 'crypt_shared_path_needed',
          message: policy.teamMode
            ? 'The server has no crypt_shared library (MM_CRYPT_SHARED_LIB_PATH): ask an administrator, or use mongocryptd'
            : 'Give the absolute path of the crypt_shared library (mongo_crypt_v1), or use mongocryptd',
          field: 'encryption.cryptSharedLibPath',
        }
    }
    if (e.library === 'mongocryptd' && e.mongocryptdUri && !isLocalMongocryptd(e.mongocryptdUri))
      yield {
        reason: 'mongocryptd_not_local',
        message:
          'mongocryptd sees every query in the clear: it must run on this computer (mongodb://localhost:27020)',
        field: 'encryption.mongocryptdUri',
      }
  }
}
