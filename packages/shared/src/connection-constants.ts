/** Connection constants with no dependencies: safe to bundle for the browser. */
export const AUTH_MECHANISMS = [
  'none',
  'DEFAULT',
  'SCRAM-SHA-256',
  'SCRAM-SHA-1',
  'MONGODB-X509',
  'PLAIN',
  'GSSAPI',
  'MONGODB-AWS',
  'MONGODB-OIDC',
] as const
export type AuthMechanism = (typeof AUTH_MECHANISMS)[number]

/**
 * W7, W8 (completion): Kerberos signs in with the ticket of the account Mongo Manager runs as,
 * and needs the optional `kerberos` package; OIDC signs each user in through their identity
 * provider. Whether a server offers them is its own (GET /api/connections/capabilities).
 */
export const KERBEROS_CANONICALIZE = ['none', 'forward', 'forwardAndReverse'] as const
/** OIDC workload identities: the host's own cloud identity, only where an administrator allows it. */
export const OIDC_ENVIRONMENTS = ['azure', 'gcp', 'k8s'] as const
export type OidcEnvironment = (typeof OIDC_ENVIRONMENTS)[number]

/** W8: the key management services CSFLE / Queryable Encryption keys can be kept in. */
export const KMS_PROVIDERS = ['local', 'aws', 'azure', 'gcp', 'kmip'] as const
export type KmsProvider = (typeof KMS_PROVIDERS)[number]
/** W8: the secrets of each KMS provider (masked in answers, kept only for the same KMS target). */
export const KMS_SECRET_FIELDS = [
  ['local', 'key'],
  ['aws', 'secretAccessKey'],
  ['aws', 'sessionToken'],
  ['azure', 'clientSecret'],
  ['gcp', 'privateKey'],
  ['kmip', 'certificateKeyPem'],
] as const

export const READ_PREFERENCES = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
] as const
export const CONNECTION_COLORS = [
  'gray',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const
export type ConnectionColor = (typeof CONNECTION_COLORS)[number]

/** URI options accepted verbatim. Nothing here can make the server read local files. */
export const EXTRA_URI_OPTIONS = [
  'retryWrites',
  'retryReads',
  'w',
  'wtimeoutMS',
  'journal',
  'maxPoolSize',
  'minPoolSize',
  'maxIdleTimeMS',
  'maxConnecting',
  'waitQueueTimeoutMS',
  'compressors',
  'zlibCompressionLevel',
  'readConcernLevel',
  'maxStalenessSeconds',
  'localThresholdMS',
  'heartbeatFrequencyMS',
  'socketTimeoutMS',
  'loadBalanced',
  'srvMaxHosts',
  'srvServiceName',
] as const
export type ExtraUriOption = (typeof EXTRA_URI_OPTIONS)[number]

/**
 * URI options refused: the app bounds each of its operations itself. The driver's timeoutMS (its
 * client-side operation timeout) would overwrite those bounds with its own, refuse explains and
 * change streams beside them, and end long reads such as exports and backups at its limit. Settings
 * and files saved with one before still open and import, without it.
 */
export const REFUSED_URI_OPTIONS = ['timeoutMS'] as const

export const SECRET_MASK = '••••••••'
export const SECRET_FIELDS = [
  ['auth', 'password'],
  ['tls', 'certificateKeyPem'],
  ['tls', 'certificateKeyPassword'],
  ['ssh', 'password'],
  ['ssh', 'privateKey'],
  ['ssh', 'passphrase'],
] as const
