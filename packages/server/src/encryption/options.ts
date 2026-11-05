// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createSecureContext } from 'node:tls'
import { EJSON, type Document } from 'bson'
import type { AutoEncryptionOptions, KMSProviders } from 'mongodb'
import type { ConnectionSettings, EncryptionSettings, MasterKey } from '@mongo-manager/shared'
import { ConnectionError } from '../connections/errors'
import { pastedPem } from '../net/pem'
import { cryptSharedPathFor, type ConnectionPolicy } from '../connections/policy'
import type { Egress } from '../net/egress'

/**
 * W8 (completion): a connection's CSFLE / Queryable Encryption settings as the driver's options.
 * Every credential is the connection's own: a provider without one would make the driver fetch the
 * host's own identity on demand (instance role, metadata server), so it is refused. Every socket to
 * a key management service is opened through the egress guard (kmsConnectCallback), so a KMS
 * endpoint naming the metadata service or a private address is never reached unless listed.
 */
const KMIP_PORT = 5696

export function kmsProvidersFor(e: EncryptionSettings): KMSProviders {
  const kms: KMSProviders = {}
  const need = (provider: string, value: string | undefined): string => {
    if (!value)
      throw new ConnectionError(
        'encryption',
        `The ${provider} key provider has no credentials: enter them again (the host's own identity is never used)`,
      )
    return value
  }
  const k = e.kms
  if (k.local) kms.local = { key: Buffer.from(need('local', k.local.key), 'base64') }
  if (k.aws)
    kms.aws = {
      accessKeyId: need('aws', k.aws.accessKeyId),
      secretAccessKey: need('aws', k.aws.secretAccessKey),
      ...(k.aws.sessionToken ? { sessionToken: k.aws.sessionToken } : {}),
    }
  if (k.azure)
    kms.azure = {
      tenantId: need('azure', k.azure.tenantId),
      clientId: need('azure', k.azure.clientId),
      clientSecret: need('azure', k.azure.clientSecret),
      ...(k.azure.identityPlatformEndpoint
        ? { identityPlatformEndpoint: k.azure.identityPlatformEndpoint }
        : {}),
    }
  if (k.gcp)
    kms.gcp = {
      email: need('gcp', k.gcp.email),
      privateKey: need('gcp', k.gcp.privateKey),
      ...(k.gcp.endpoint ? { endpoint: k.gcp.endpoint } : {}),
    }
  if (k.kmip) {
    const endpoint = need('kmip', k.kmip.endpoint)
    kms.kmip = { endpoint: /:\d+$/.test(endpoint) ? endpoint : `${endpoint}:${KMIP_PORT}` }
  }
  return kms
}

/** An entered map: Extended JSON keyed by "db.coll"; an error never quotes it (it may hold key ids). */
function parseMap(text: string | undefined, name: string): Document | undefined {
  if (!text?.trim()) return undefined
  let value: unknown
  try {
    value = EJSON.parse(text, { relaxed: false })
  } catch {
    throw new ConnectionError('encryption', `The ${name} is not valid Extended JSON`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConnectionError('encryption', `The ${name} must be an object keyed by database.collection`)
  for (const [ns, entry] of Object.entries(value)) {
    if (!/^[^.$\s]+\.[^$\s]+$/.test(ns) || !entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new ConnectionError('encryption', `The ${name} must be an object keyed by database.collection`)
  }
  return value as Document
}

/** KMIP over TLS with the connection's own CA and client certificate, from memory (no files). */
function kmipTls(e: EncryptionSettings): AutoEncryptionOptions['tlsOptions'] {
  const ca = pastedPem(e.kms.kmip?.caPem)
  const certificateKey = pastedPem(e.kms.kmip?.certificateKeyPem)
  if (!ca && !certificateKey) return undefined
  try {
    return {
      kmip: {
        secureContext: createSecureContext({
          ...(ca ? { ca } : {}),
          ...(certificateKey ? { cert: certificateKey, key: certificateKey } : {}),
        }),
      },
    }
  } catch {
    throw new ConnectionError('encryption', 'The KMIP certificate could not be read')
  }
}

/**
 * Security review C1: where a KMS socket may go. A data key names its own master key's endpoint
 * (Azure keyVaultEndpoint, GCP or AWS endpoint), and anyone who can write the key vault could point
 * it elsewhere — the next decrypting read would hand that host a token minted with the connection's
 * sealed secret. So only the providers' own hosts (on 443), the endpoints the connection's
 * administrator wrote in its settings, and the operator's list (MM_KMS_ALLOWED_HOSTS) are reached.
 */
const OFFICIAL_KMS_HOSTS: readonly RegExp[] = [
  // AWS KMS: kms[-fips].<region>.amazonaws.com, and .com.cn in the China regions. A region is
  // letters-dash-…-digit (us-east-1, us-gov-west-1, cn-north-1), never a bucket or service name.
  /^kms(?:-fips)?\.[a-z]{2}(?:-[a-z]+)+-\d{1,2}\.amazonaws\.com(?:\.cn)?$/,
  // Azure Key Vault and Managed HSM: public, US Government, China and Germany clouds.
  /^[a-z0-9-]+\.(?:vault|managedhsm)\.(?:azure\.net|usgovcloudapi\.net|azure\.cn|microsoftazure\.de)$/,
  // Azure's identity platform (the token for Key Vault).
  /^login\.(?:microsoftonline\.com|microsoftonline\.us|chinacloudapi\.cn|microsoftonline\.de)$/,
  // Google Cloud KMS (global, and its documented regional endpoints cloudkms.<location>.rep) and the
  // OAuth token endpoint — never another Google API (storage would serve anyone's bucket).
  /^(?:cloudkms|oauth2)\.googleapis\.com$/,
  /^cloudkms\.[a-z]+(?:-[a-z]+)*\d*\.rep\.googleapis\.com$/,
]

/** host[:port] → [host, port]; a missing port is the default given. */
function hostPort(endpoint: string, defaultPort: number): [string, number] {
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(endpoint.trim().toLowerCase())!
  return [m[1]!, m[2] ? Number(m[2]) : defaultPort]
}

export function kmsHostAllowed(
  host: string,
  port: number,
  settings: ConnectionSettings,
  policy: Pick<ConnectionPolicy, 'kmsAllowedHosts'>,
): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (port === 443 && OFFICIAL_KMS_HOSTS.some((re) => re.test(h))) return true
  const k = settings.encryption?.kms
  const named: Array<[string, number]> = [
    ...(k?.azure?.identityPlatformEndpoint ? [hostPort(k.azure.identityPlatformEndpoint, 443)] : []),
    ...(k?.gcp?.endpoint ? [hostPort(k.gcp.endpoint, 443)] : []),
    ...(k?.kmip?.endpoint ? [hostPort(k.kmip.endpoint, KMIP_PORT)] : []),
    ...policy.kmsAllowedHosts.map((e) => hostPort(e, 443)),
  ]
  return named.some(([nh, np]) => nh === h && np === port)
}

export class KmsHostError extends Error {
  readonly reason = 'kms_host_not_allowed'
  constructor(host: string, port: number) {
    super(`${host}:${port} is not a key management service this connection may reach (MM_KMS_ALLOWED_HOSTS)`)
  }
}

/** The KMS socket of a connection: the allowlist above, then the egress guard. */
export function kmsConnect(
  settings: ConnectionSettings,
  policy: Pick<ConnectionPolicy, 'kmsAllowedHosts'>,
  socket: NonNullable<Egress['socket']>,
): NonNullable<AutoEncryptionOptions['kmsConnectCallback']> {
  return async ({ host, port, signal }) => {
    if (!kmsHostAllowed(host, port, settings, policy)) throw new KmsHostError(host, port)
    return socket({ host, port, signal })
  }
}

/** Why a master key asked for (create, rewrap) names an endpoint this connection may not reach. */
export function masterKeyProblem(
  masterKey: MasterKey,
  settings: ConnectionSettings,
  policy: Pick<ConnectionPolicy, 'kmsAllowedHosts'>,
): string | null {
  const endpoint =
    masterKey.provider === 'azure'
      ? masterKey.keyVaultEndpoint
      : masterKey.provider === 'aws' || masterKey.provider === 'gcp' || masterKey.provider === 'kmip'
        ? masterKey.endpoint
        : undefined
  if (!endpoint) return null
  const [host, port] = hostPort(endpoint, masterKey.provider === 'kmip' ? KMIP_PORT : 443)
  return kmsHostAllowed(host, port, settings, policy)
    ? null
    : `${endpoint} is not a key management service this connection may reach: use the provider's own host, an endpoint of the connection's settings, or one an operator listed in MM_KMS_ALLOWED_HOSTS`
}

export async function autoEncryptionFor(
  settings: ConnectionSettings,
  policy: ConnectionPolicy,
  egress: Pick<Egress, 'socket'>,
): Promise<AutoEncryptionOptions> {
  const e = settings.encryption
  if (!e?.enabled)
    throw new ConnectionError('encryption', 'Client-side encryption is not set up on this connection')
  const schemaMap = parseMap(e.schemaMap, 'schema map')
  const encryptedFieldsMap = parseMap(e.encryptedFieldsMap, 'encrypted fields map')
  const tlsOptions = kmipTls(e)
  const extraOptions: NonNullable<AutoEncryptionOptions['extraOptions']> = {
    ...(e.library === 'cryptShared'
      ? {
          // The policy made sure there is one, absolute, and the operator's in team mode.
          cryptSharedLibPath: cryptSharedPathFor(settings, policy) as `${string}mongo_crypt_v1.so`,
          cryptSharedLibRequired: true,
          mongocryptdBypassSpawn: true,
        }
      : // From PATH (the operator's), never a path a connection names.
        { ...(e.mongocryptdUri ? { mongocryptdURI: e.mongocryptdUri } : {}) }),
    // Security review I1: never the system's library search ($SYSTEM, the driver's default) — in
    // mongocryptd mode it would load whatever mongo_crypt_v1 the library path finds.
    ...({ cryptSharedLibSearchPaths: [] } as object),
  }
  const socket = egress.socket
  if (!socket) throw new ConnectionError('encryption', 'Key management services cannot be reached from here')
  return {
    keyVaultNamespace: e.keyVaultNamespace,
    kmsProviders: kmsProvidersFor(e),
    ...(schemaMap ? { schemaMap } : {}),
    ...(encryptedFieldsMap ? { encryptedFieldsMap } : {}),
    ...(e.mode === 'decryptOnly' ? { bypassAutoEncryption: true } : {}),
    ...(tlsOptions ? { tlsOptions } : {}),
    extraOptions,
    kmsConnectCallback: kmsConnect(settings, policy, socket),
  }
}
