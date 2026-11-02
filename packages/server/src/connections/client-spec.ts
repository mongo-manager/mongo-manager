import type { AutoEncryptionOptions, MongoClientOptions, OIDCCallbackFunction } from 'mongodb'
import { buildConnectionUri, type ConnectionSettings } from '@mongo-manager/shared'
import { AWS_KEYS_NEEDED, ConnectionError } from './errors'
import { pastedPem } from '../net/pem'
import type { SocksCredentials } from './socks'

export interface ClientSpec {
  uri: string
  options: MongoClientOptions
}

/** W7, W8: what a client needs besides its settings — made by the server for each client. */
export interface SignInHooks {
  /** The OIDC human callback of this connection and person (oidc/broker): tokens, never a flow. */
  oidcCallback?: OIDCCallbackFunction
  /** Automatic encryption for this client (encryption/options); absent: values stay as stored. */
  autoEncryption?: AutoEncryptionOptions
}

/** W7: a human OIDC sign-in needs the server's broker; without it there is nothing to sign in with. */
export const OIDC_NEEDS_BROKER =
  'MONGODB-OIDC signs each person in through their identity provider: this client has no sign-in for it'

function parseMechanismProperties(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw
      .split(',')
      .map((pair) => pair.split(':'))
      .filter((kv): kv is [string, string] => kv.length >= 2 && kv[0] !== '')
      .map(([k, ...rest]) => [k.trim(), rest.join(':').trim()])
      // Review minor 2: " AWS_SESSION_TOKEN" (typed after ", ") is the key it names.
      .filter(([k]) => k !== ''),
  )
}

/** MONGODB-AWS: the connection's own access key, secret and optional session token. */
function awsKeys(
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
  sessionToken: string | undefined,
): () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }> {
  return () =>
    accessKeyId && secretAccessKey
      ? Promise.resolve({ accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) })
      : Promise.reject(new Error(AWS_KEYS_NEEDED))
}

/** Settings → driver input. Credentials travel in options, never in the URI (spec §5 S11). */
export function clientSpec(
  settings: ConnectionSettings,
  tunnel?: { host: string; port: number; credentials: SocksCredentials },
  overrides: Partial<MongoClientOptions> = {},
  hooks: SignInHooks = {},
): ClientSpec {
  const effective: ConnectionSettings = tunnel
    ? {
        ...settings,
        scheme: 'mongodb',
        hosts: [{ host: tunnel.host, port: tunnel.port }],
        directConnection: true,
      }
    : settings
  const { auth, tls } = settings
  // W7, W8: whether Kerberos, a workload identity or encryption may be used here is the server's
  // policy (connections/policy.ts), checked by the manager before this is called.
  const options: MongoClientOptions = {
    appName: settings.appName ?? 'Mongo Manager',
    serverSelectionTimeoutMS: settings.serverSelectionTimeoutMS ?? 10_000,
    connectTimeoutMS: settings.connectTimeoutMS ?? 10_000,
    // The tunnel's endpoint is a SOCKS5 proxy that answers only to its own credentials (socks.ts).
    ...(tunnel
      ? {
          proxyHost: tunnel.host,
          proxyPort: tunnel.port,
          proxyUsername: tunnel.credentials.username,
          proxyPassword: tunnel.credentials.password,
        }
      : {}),
  }
  if (auth.mechanism === 'MONGODB-AWS') {
    // The driver takes AWS keys only from a credential provider, and without one reads the host's
    // own identity (its environment, profile or instance role): a user of this server would sign
    // in as the server. The connection's own keys, and nothing else.
    const {
      AWS_SESSION_TOKEN: sessionToken,
      AWS_CREDENTIAL_PROVIDER: _ignored,
      ...rest
    } = parseMechanismProperties(auth.mechanismProperties ?? '')
    options.authMechanismProperties = {
      ...rest,
      AWS_CREDENTIAL_PROVIDER: awsKeys(auth.username, auth.password, sessionToken),
    } as MongoClientOptions['authMechanismProperties']
  } else if (auth.mechanism === 'MONGODB-OIDC') {
    // W7: the user name is only a hint for the identity provider; there is never a password.
    if (auth.username) options.auth = { username: auth.username }
    const o = auth.oidc ?? {}
    if (o.environment) {
      // The host's own workload identity: chosen on this connection, allowed by the policy.
      options.authMechanismProperties = {
        ENVIRONMENT: o.environment,
        ...(o.tokenResource ? { TOKEN_RESOURCE: o.tokenResource } : {}),
      }
    } else {
      if (!hooks.oidcCallback) throw new ConnectionError('config', OIDC_NEEDS_BROKER)
      // A person's own tokens from the broker. ALLOWED_HOSTS bounds where the driver sends them
      // (its default list: Atlas and this computer).
      options.authMechanismProperties = {
        OIDC_HUMAN_CALLBACK: hooks.oidcCallback,
        ...(o.allowedHosts?.length ? { ALLOWED_HOSTS: o.allowedHosts } : {}),
      }
    }
  } else {
    if (auth.mechanism !== 'none' && auth.username) {
      options.auth = { username: auth.username, ...(auth.password ? { password: auth.password } : {}) }
    }
    // W8: Kerberos takes its three properties from their own fields, nothing typed freely.
    if (auth.mechanism === 'GSSAPI') {
      const k = auth.kerberos ?? {}
      const props = {
        ...(k.serviceName ? { SERVICE_NAME: k.serviceName } : {}),
        ...(k.serviceRealm ? { SERVICE_REALM: k.serviceRealm } : {}),
        ...(k.canonicalizeHostName ? { CANONICALIZE_HOST_NAME: k.canonicalizeHostName } : {}),
      }
      if (Object.keys(props).length)
        options.authMechanismProperties = props as MongoClientOptions['authMechanismProperties']
    }
    // Review I1: no other method uses properties; ones stored for another method (Kerberos'
    // CANONICALIZE_HOST_NAME) would make the driver refuse the connection.
  }
  if (hooks.autoEncryption) options.autoEncryption = hooks.autoEncryption
  if (tls.enabled) {
    options.tls = true
    const ca = pastedPem(tls.caPem)
    if (ca) options.ca = ca
    const certificateKey = pastedPem(tls.certificateKeyPem)
    if (certificateKey) {
      options.cert = certificateKey
      options.key = certificateKey
      if (tls.certificateKeyPassword) options.passphrase = tls.certificateKeyPassword
    }
    if (tunnel) options.servername = settings.hosts[0]!.host
  }
  return { uri: buildConnectionUri(effective), options: { ...options, ...overrides } }
}
