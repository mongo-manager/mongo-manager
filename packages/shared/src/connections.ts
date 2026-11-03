import { z } from 'zod'
import { AI_AGENT_CONNECTION_TOOLS, type AiAgentTool } from './api/aiAgent'
import { ConnectionString } from 'mongodb-connection-string-url'
import {
  AUTH_MECHANISMS,
  CONNECTION_COLORS,
  EXTRA_URI_OPTIONS,
  REFUSED_URI_OPTIONS,
  KERBEROS_CANONICALIZE,
  KMS_SECRET_FIELDS,
  OIDC_ENVIRONMENTS,
  READ_PREFERENCES,
  SECRET_FIELDS,
  SECRET_MASK,
  type AuthMechanism,
  type ExtraUriOption,
} from './connection-constants'

export * from './connection-constants'

const MODELED_OPTIONS = new Set(
  [
    'replicaSet',
    'directConnection',
    'authMechanism',
    'authSource',
    'authMechanismProperties',
    'tls',
    'ssl',
    'tlsAllowInvalidHostnames',
    'tlsAllowInvalidCertificates',
    'tlsInsecure',
    'readPreference',
    'appName',
    'connectTimeoutMS',
    'serverSelectionTimeoutMS',
  ].map((k) => k.toLowerCase()),
)
const FILE_OPTIONS = new Set(
  [
    'tlsCAFile',
    'tlsCertificateKeyFile',
    'tlsCertificateKeyFilePassword',
    'tlsCertificateFile',
    'tlsCRLFile',
    'sslCA',
    'sslCert',
    'sslKey',
    'sslPass',
    'sslCRL',
  ].map((k) => k.toLowerCase()),
)
const EXTRA_BY_LOWER = new Map<string, ExtraUriOption>(EXTRA_URI_OPTIONS.map((k) => [k.toLowerCase(), k]))
const REFUSED_BY_LOWER = new Map<string, string>(REFUSED_URI_OPTIONS.map((k) => [k.toLowerCase(), k]))

/** The refused option a key names, in its own spelling, if it names one. */
export const refusedUriOption = (key: string): string | undefined => REFUSED_BY_LOWER.get(key.toLowerCase())

/** The library's own refusal, said "Invalid connection string" once when that is all it says. */
const unreadable = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e)
  return new ConnectionUriError(
    message === 'Invalid connection string' ? message : `Invalid connection string: ${message}`,
  )
}

/** Why a refused option is refused. */
const refusal = (option: string) => `${option} is not supported: the app bounds each operation itself`

/**
 * Extra options without the refused ones: settings stored before they were refused open as well.
 * Settings stored with no options at all have none.
 */
function extraOptionsOnly(
  options: Record<string, string | undefined> | undefined,
): Partial<Record<ExtraUriOption, string>> {
  const out: Partial<Record<ExtraUriOption, string>> = {}
  // A "__proto__" key (JSON.parse makes one) is no option, and would set the prototype.
  for (const [key, value] of Object.entries(options ?? {}))
    if (value !== undefined && key !== '__proto__' && !refusedUriOption(key))
      out[key as ExtraUriOption] = value
  return out
}

/**
 * Settings without the refused URI options (read back from storage, which is not parsed again).
 * Settings stored with no options have none, as the schema gives them: the form reads them.
 */
export function withoutRefusedOptions<T extends { options?: Record<string, string | undefined> }>(s: T): T {
  return { ...s, options: extraOptionsOnly(s.options) }
}

/** A connection string without the refused options, and those it had, each named once. */
export function withoutRefusedUriOptions(uri: string): { uri: string; dropped: string[] } {
  let cs: ConnectionString
  try {
    cs = new ConnectionString(uri.trim())
  } catch (e) {
    throw unreadable(e)
  }
  const keys = [...cs.searchParams.keys()].filter((k) => refusedUriOption(k))
  for (const key of keys) cs.searchParams.delete(key)
  return { uri: cs.toString(), dropped: [...new Set(keys.map((k) => refusedUriOption(k)!))] }
}

const HostSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    // No "%" or "\": percent-encoded paths become Unix sockets, backslashes Windows named pipes.
    .regex(/^[^\s/?#@,[\]%\\]+$/, 'Invalid host name'),
  port: z.number().int().min(1).max(65535).optional(),
})

/** A host name, optionally with a leading "*." (OIDC ALLOWED_HOSTS), or an IP address. */
const ALLOWED_HOST = /^(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$|^\d{1,3}(?:\.\d{1,3}){3}$|^::1$/
/** A KMS endpoint: host[:port], nothing else (no scheme, path or credentials). */
const ENDPOINT = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?$/

/**
 * W7: where the identity provider sends the browser back. https, or http on this computer only
 * (RFC 8252 §7.3): an authorization code must not cross a network in the clear.
 */
export function isRedirectUri(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password || url.hash) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/.test(url.hostname)
}

/**
 * W7 (completion): MONGODB-OIDC. Each person signs in with their identity provider (the issuer
 * and client ID come from the MongoDB server); `environment` is the host's own workload identity
 * instead, only when an administrator chose it here (and, in team mode, allowed it on the server).
 */
const OidcSchema = z.object({
  redirectUri: z
    .string()
    .trim()
    .max(2048)
    .refine(isRedirectUri, 'An https:// address, or http:// on localhost')
    .optional(),
  allowedHosts: z
    .array(z.string().trim().min(1).max(255).regex(ALLOWED_HOST, 'A host name'))
    .max(32)
    .optional(),
  environment: z.enum(OIDC_ENVIRONMENTS).optional(),
  tokenResource: z.string().trim().max(1024).optional(),
  /**
   * Security review I5: the identity provider (issuer URL) an administrator expects. The MongoDB
   * server names the issuer; any other one is refused before anyone is sent to it.
   */
  expectedIssuer: z
    .string()
    .trim()
    .max(2048)
    .refine(isRedirectUri, 'An https:// address, or http:// on localhost')
    .optional(),
  /**
   * Security review I3: the token resource someone confirmed in the form (the very value). A pasted
   * connection string fills tokenResource, never this; an imported file's is dropped.
   */
  tokenResourceConfirmed: z.string().trim().max(1024).optional(),
  /**
   * W7 re-review: the workload identity someone confirmed in the form (the very environment) — this
   * server's own cloud identity signs in to the connection's hosts. An imported file's is dropped.
   */
  environmentConfirmed: z.enum(OIDC_ENVIRONMENTS).optional(),
})

/** W8: Kerberos (GSSAPI) properties, each a plain name (they travel as "KEY:value" pairs). */
const KerberosSchema = z.object({
  serviceName: z
    .string()
    .trim()
    .max(255)
    .regex(/^[^\s,:]+$/, 'No spaces, commas or colons')
    .optional(),
  serviceRealm: z
    .string()
    .trim()
    .max(255)
    .regex(/^[^\s,:]+$/, 'No spaces, commas or colons')
    .optional(),
  canonicalizeHostName: z.enum(KERBEROS_CANONICALIZE).optional(),
})

const AuthSchema = z.object({
  mechanism: z.enum(AUTH_MECHANISMS).default('none'),
  username: z.string().max(1024).optional(),
  password: z.string().max(1024).optional(),
  authSource: z.string().max(255).optional(),
  mechanismProperties: z.string().max(4096).optional(),
  oidc: OidcSchema.optional(),
  kerberos: KerberosSchema.optional(),
})

const secretText = (max: number) => z.string().min(1).max(max)
/** 96 bytes in base64 (128 characters, no padding), or the display mask of a stored key. */
const LOCAL_KEY = z
  .string()
  .refine(
    (v) => v === SECRET_MASK || /^[A-Za-z0-9+/]{128}$/.test(v),
    'A 96-byte key in base64 (128 characters)',
  )

/**
 * W8 (completion): CSFLE / Queryable Encryption on this connection — the KMS providers that keep
 * the data keys (their credentials sealed with the connection, masked in every answer), the key
 * vault, how queries are analysed (crypt_shared or mongocryptd), and the maps of encrypted fields
 * when the server's own collection options are not to be used. Needs the optional
 * mongodb-client-encryption package (npm package only).
 */
const KmsSchema = z
  .object({
    local: z.object({ key: LOCAL_KEY }).optional(),
    aws: z
      .object({
        accessKeyId: z.string().trim().min(1).max(256),
        secretAccessKey: secretText(1024),
        sessionToken: z.string().max(4096).optional(),
      })
      .optional(),
    azure: z
      .object({
        tenantId: z.string().trim().min(1).max(256),
        clientId: z.string().trim().min(1).max(256),
        clientSecret: secretText(1024),
        identityPlatformEndpoint: z.string().trim().max(255).regex(ENDPOINT, 'host[:port]').optional(),
      })
      .optional(),
    gcp: z
      .object({
        email: z.string().trim().min(3).max(320),
        privateKey: secretText(16_384),
        endpoint: z.string().trim().max(255).regex(ENDPOINT, 'host[:port]').optional(),
      })
      .optional(),
    kmip: z
      .object({
        endpoint: z.string().trim().min(1).max(255).regex(ENDPOINT, 'host[:port]'),
        caPem: z.string().max(200_000).optional(),
        certificateKeyPem: z.string().max(200_000).optional(),
      })
      .optional(),
  })
  .refine((k) => Object.values(k).some((v) => v !== undefined), 'Add at least one key provider')

export const EncryptionSchema = z.object({
  enabled: z.boolean().default(false),
  /** auto: reads decrypted and writes encrypted; decryptOnly: reads only (MongoDB Community). */
  mode: z.enum(['auto', 'decryptOnly']).default('auto'),
  keyVaultNamespace: z
    .string()
    .trim()
    .max(255)
    .regex(/^[^.$\s/\\"*<>:|?]+\.[^$\s]+$/, 'database.collection'),
  kms: KmsSchema,
  library: z.enum(['cryptShared', 'mongocryptd']).default('cryptShared'),
  /** The crypt_shared library: per connection in local mode; in team mode the server's own only. */
  cryptSharedLibPath: z.string().trim().max(4096).optional(),
  /** mongocryptd on this computer (loopback only); spawned from PATH when none is given. */
  mongocryptdUri: z.string().trim().max(1024).optional(),
  /** Extended JSON: { "db.coll": { $jsonSchema … } } (CSFLE). Empty: the server's validators. */
  schemaMap: z.string().max(1_000_000).optional(),
  /** Extended JSON: { "db.coll": { fields: [ … ] } } (QE). Empty: the server's collection options. */
  encryptedFieldsMap: z.string().max(1_000_000).optional(),
})
export type EncryptionSettings = z.output<typeof EncryptionSchema>

const TlsSchema = z.object({
  enabled: z.boolean().default(false),
  caPem: z.string().max(200_000).optional(),
  certificateKeyPem: z.string().max(200_000).optional(),
  certificateKeyPassword: z.string().max(1024).optional(),
  allowInvalidHostnames: z.boolean().default(false),
  allowInvalidCertificates: z.boolean().default(false),
})

const SshSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(255),
  method: z.enum(['password', 'privateKey']),
  password: z.string().max(1024).optional(),
  privateKey: z.string().max(100_000).optional(),
  passphrase: z.string().max(1024).optional(),
  hostFingerprint: z.string().max(200).transform(normalizeFingerprint).optional(),
})

/** Accepts ssh-keygen output with or without the SHA256: prefix and base64 padding. */
function normalizeFingerprint(value: string): string | undefined {
  const bare = value
    .trim()
    .replace(/^sha256:/i, '')
    .replace(/=+$/, '')
  return bare ? `SHA256:${bare}` : undefined
}

const USERNAME_MECHANISMS = new Set<AuthMechanism>([
  'DEFAULT',
  'SCRAM-SHA-256',
  'SCRAM-SHA-1',
  'PLAIN',
  'GSSAPI',
])

const ConnectionSettingsObject = z
  .object({
    scheme: z.enum(['mongodb', 'mongodb+srv']).default('mongodb'),
    hosts: z.array(HostSchema).min(1).max(50),
    defaultDatabase: z.string().max(64).optional(),
    replicaSet: z.string().max(255).optional(),
    directConnection: z.boolean().optional(),
    auth: AuthSchema.default({ mechanism: 'none' }),
    tls: TlsSchema.default({ enabled: false, allowInvalidHostnames: false, allowInvalidCertificates: false }),
    ssh: SshSchema.optional(),
    readPreference: z.enum(READ_PREFERENCES).optional(),
    appName: z.string().max(128).optional(),
    connectTimeoutMS: z.number().int().min(500).max(120_000).optional(),
    serverSelectionTimeoutMS: z.number().int().min(500).max(120_000).optional(),
    // A refused option is refused in words, however it is spelled and whatever its value, before
    // the record's own check (which would call it an unknown key or a wrong type).
    options: z
      .preprocess(
        (value, ctx) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value
          const kept: Record<string, unknown> = {}
          for (const [key, v] of Object.entries(value)) {
            const option = refusedUriOption(key)
            if (option) ctx.addIssue({ code: 'custom', path: [key], message: refusal(option) })
            else kept[key] = v
          }
          return kept
        },
        z.partialRecord(z.enum(EXTRA_URI_OPTIONS), z.string().max(1024)),
      )
      .default({}),
    encryption: EncryptionSchema.optional(),
  })
  .superRefine((s, ctx) => {
    if (s.scheme === 'mongodb+srv') {
      if (s.hosts.length !== 1 || s.hosts[0]!.port !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['hosts'],
          message: 'mongodb+srv needs exactly one host name without a port',
        })
      }
      if (s.directConnection) {
        ctx.addIssue({
          code: 'custom',
          path: ['directConnection'],
          message: 'directConnection cannot be used with mongodb+srv',
        })
      }
    }
    if (s.ssh?.enabled && (s.scheme !== 'mongodb' || s.hosts.length !== 1)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ssh'],
        message: 'An SSH tunnel reaches exactly one host: use a single mongodb:// host',
      })
    }
  })

/**
 * Settings as a pasted connection string gives them: well formed, but perhaps without what signing in
 * needs (the form is filled, and says what is missing when it is saved or tested).
 */
export const ConnectionSettingsDraftSchema = ConnectionSettingsObject

export const ConnectionSettingsSchema = ConnectionSettingsObject.superRefine((s, ctx) => {
  if (USERNAME_MECHANISMS.has(s.auth.mechanism) && !s.auth.username) {
    ctx.addIssue({ code: 'custom', path: ['auth', 'username'], message: 'Username is required' })
  }
  // W7: OIDC takes its settings from the form's own fields; free properties could name ENVIRONMENT,
  // a callback or hosts the form never showed. Whether Kerberos and a workload identity may be used
  // is the server's own policy (connections/policy.ts): it knows the mode and its packages.
  if (s.auth.mechanism === 'MONGODB-OIDC' && s.auth.mechanismProperties?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['auth', 'mechanismProperties'],
      message: 'OIDC takes its settings from the OIDC fields, not from mechanism properties',
    })
  }
  if (s.auth.mechanism === 'GSSAPI' && s.auth.mechanismProperties?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['auth', 'mechanismProperties'],
      message: 'Kerberos takes its settings from the Kerberos fields, not from mechanism properties',
    })
  }
  if (s.auth.oidc?.tokenResource && !s.auth.oidc.environment) {
    ctx.addIssue({
      code: 'custom',
      path: ['auth', 'oidc', 'tokenResource'],
      message: 'A token resource belongs to a workload identity',
    })
  }
  // Without its own keys MONGODB-AWS would sign in as the Mongo Manager host (its instance role).
  if (s.auth.mechanism === 'MONGODB-AWS') {
    if (!s.auth.username)
      ctx.addIssue({ code: 'custom', path: ['auth', 'username'], message: 'Access key ID is required' })
    if (!s.auth.password)
      ctx.addIssue({ code: 'custom', path: ['auth', 'password'], message: 'Secret access key is required' })
  }
  // ENVIRONMENT makes the driver use the host's own cloud/Kubernetes identity and send it to the server.
  if (s.auth.mechanismProperties && /(^|,)\s*ENVIRONMENT\s*:/i.test(s.auth.mechanismProperties)) {
    ctx.addIssue({
      code: 'custom',
      path: ['auth', 'mechanismProperties'],
      message: 'ENVIRONMENT (ambient cloud credentials of the Mongo Manager host) is not allowed',
    })
  }
})

export type ConnectionSettings = z.output<typeof ConnectionSettingsSchema>
export type SshSettings = NonNullable<ConnectionSettings['ssh']>

/** Phase 4a-1 spec §2.4: the AI assistant on this connection. */
const AiPolicy = z.enum(['off', 'local', 'any'])
/** C5: tools off, each once, kept in the order the agent lists them. */
const kept = (list: readonly string[]): AiAgentTool[] =>
  AI_AGENT_CONNECTION_TOOLS.filter((t) => list.includes(t))
/** As set: only a tool that acts on a connection. */
const AiAgentToolsOffSchema = z
  .array(z.enum(AI_AGENT_CONNECTION_TOOLS as [AiAgentTool, ...AiAgentTool[]]))
  .max(AI_AGENT_CONNECTION_TOOLS.length)
  .transform(kept)
/**
 * Review of C5 (minor 3): as a file brings them (an import, a create): a name this build has no tool
 * for is dropped, as the store drops one — a newer build's file is not refused whole.
 */
const AiAgentToolsOffKeptSchema = z.array(z.string().max(64)).max(200).transform(kept)

export const ConnectionMetaSchema = z.object({
  name: z.string().trim().min(1).max(100),
  group: z.string().trim().max(100).optional(),
  color: z.enum(CONNECTION_COLORS).optional(),
  favorite: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  aiPolicy: AiPolicy.default('any'),
  /** W6.3: the agentic assistant may propose changes here (each still needs the person's click). */
  aiAgentWrites: z.boolean().default(true),
  /** Design 2026-10-25 (C5): the agent's tools an administrator turned off here. */
  aiAgentToolsOff: AiAgentToolsOffKeptSchema.default([]),
})
export const ConnectionInputSchema = ConnectionMetaSchema.extend({ settings: ConnectionSettingsSchema })
export type ConnectionInput = z.output<typeof ConnectionInputSchema>

export const ConnectionPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    group: z.string().trim().max(100).nullable().optional(),
    color: z.enum(CONNECTION_COLORS).nullable().optional(),
    favorite: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    aiPolicy: AiPolicy.optional(),
    aiAgentWrites: z.boolean().optional(),
    aiAgentToolsOff: AiAgentToolsOffSchema.optional(),
    settings: ConnectionSettingsSchema.optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'Nothing to update')
export type ConnectionPatch = z.output<typeof ConnectionPatchSchema>

export class ConnectionUriError extends Error {
  override name = 'ConnectionUriError'
  /** What the app can say in its own language (an option refused, and which). */
  constructor(
    message: string,
    readonly details?: { reason: 'option_not_supported'; option: string },
  ) {
    super(message)
  }
}

export function formatHost(h: { host: string; port?: number | undefined }): string {
  const host = h.host.includes(':') ? `[${h.host}]` : h.host
  return h.port ? `${host}:${h.port}` : host
}

function parseHost(entry: string): { host: string; port?: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry) ?? /^([^:]+)(?::(\d+))?$/.exec(entry)
  if (!m) throw new ConnectionUriError(`Invalid host "${entry}"`)
  return { host: m[1]!, ...(m[2] ? { port: Number(m[2]) } : {}) }
}

/**
 * W7, W8: a pasted string's Kerberos and OIDC properties go to the form's own fields; what the
 * form has no field for stays in mechanismProperties, where saving says it is not taken.
 */
function structuredProperties(
  mechanism: AuthMechanism,
  raw: string | undefined,
): { mechanismProperties?: string; kerberos?: object; oidc?: object } {
  if (!raw || (mechanism !== 'GSSAPI' && mechanism !== 'MONGODB-OIDC')) return { mechanismProperties: raw }
  const rest: Array<[string, string]> = []
  const kerberos: Record<string, string> = {}
  const oidc: Record<string, string> = {}
  for (const [key, value] of parseProperties(raw)) {
    const k = key.trim().toUpperCase()
    const v = value.trim()
    if (mechanism === 'GSSAPI' && k === 'SERVICE_NAME') kerberos.serviceName = v
    else if (mechanism === 'GSSAPI' && k === 'SERVICE_REALM') kerberos.serviceRealm = v
    else if (mechanism === 'GSSAPI' && k === 'CANONICALIZE_HOST_NAME')
      kerberos.canonicalizeHostName = v === 'true' ? 'forward' : v === 'false' ? 'none' : v
    else if (mechanism === 'MONGODB-OIDC' && k === 'ENVIRONMENT') oidc.environment = v.toLowerCase()
    else if (mechanism === 'MONGODB-OIDC' && k === 'TOKEN_RESOURCE') oidc.tokenResource = v
    else rest.push([key, value])
  }
  return {
    ...(rest.length ? { mechanismProperties: joinProperties(rest) } : {}),
    ...(Object.keys(kerberos).length ? { kerberos } : {}),
    ...(Object.keys(oidc).length ? { oidc } : {}),
  }
}

const flag = (v: string | null) => (v === null ? undefined : /^(true|1|yes)$/i.test(v))
const int = (v: string | null) => (v === null ? undefined : Number(v))

export function parseConnectionUri(uri: string): ConnectionSettings {
  let cs: ConnectionString
  try {
    cs = new ConnectionString(uri.trim())
  } catch (e) {
    throw unreadable(e)
  }
  const params = cs.searchParams
  const files: string[] = []
  const unsupported: string[] = []
  const refused = new Set<string>()
  const options: Partial<Record<ExtraUriOption, string>> = {}
  for (const [key, value] of params) {
    const lower = key.toLowerCase()
    if (MODELED_OPTIONS.has(lower)) continue
    if (FILE_OPTIONS.has(lower)) files.push(key)
    else if (refusedUriOption(lower)) refused.add(refusedUriOption(lower)!)
    else if (EXTRA_BY_LOWER.has(lower)) options[EXTRA_BY_LOWER.get(lower)!] = value
    else unsupported.push(key)
  }
  if (files.length > 0) {
    throw new ConnectionUriError(
      `File-based TLS options (${files.join(', ')}) are not supported; paste the certificate into the TLS section instead`,
    )
  }
  if (refused.size > 0) {
    const option = [...refused].join(', ')
    throw new ConnectionUriError(`${refusal(option)}; remove it from the connection string`, {
      reason: 'option_not_supported',
      option,
    })
  }
  if (unsupported.length > 0)
    throw new ConnectionUriError(`Unsupported connection string options: ${unsupported.join(', ')}`)

  const username = cs.username ? decodeURIComponent(cs.username) : undefined
  const password = cs.password ? decodeURIComponent(cs.password) : undefined
  const mechanismParam = params.get('authMechanism')
  let mechanism: AuthMechanism = username ? 'DEFAULT' : 'none'
  if (mechanismParam) {
    const found = AUTH_MECHANISMS.find((m) => m.toLowerCase() === mechanismParam.toLowerCase())
    if (!found || found === 'none' || found === 'DEFAULT')
      throw new ConnectionUriError(`Unsupported authMechanism "${mechanismParam}"`)
    mechanism = found
  }
  const tlsParam = params.get('tls') ?? params.get('ssl')
  const insecure = flag(params.get('tlsInsecure'))
  const structured = structuredProperties(mechanism, params.get('authMechanismProperties') ?? undefined)
  const candidate = {
    scheme: cs.isSRV ? 'mongodb+srv' : 'mongodb',
    hosts: cs.hosts.map(parseHost),
    defaultDatabase:
      cs.pathname && cs.pathname !== '/' ? decodeURIComponent(cs.pathname.slice(1)) : undefined,
    replicaSet: params.get('replicaSet') ?? undefined,
    directConnection: flag(params.get('directConnection')),
    auth: {
      mechanism,
      username,
      password,
      authSource: params.get('authSource') ?? undefined,
      ...structured,
    },
    tls: {
      enabled: tlsParam === null ? cs.isSRV : flag(tlsParam) === true,
      allowInvalidHostnames: flag(params.get('tlsAllowInvalidHostnames')) ?? insecure ?? false,
      allowInvalidCertificates: flag(params.get('tlsAllowInvalidCertificates')) ?? insecure ?? false,
    },
    readPreference: params.get('readPreference') ?? undefined,
    appName: params.get('appName') ?? undefined,
    connectTimeoutMS: int(params.get('connectTimeoutMS')),
    serverSelectionTimeoutMS: int(params.get('serverSelectionTimeoutMS')),
    options,
  }
  // Filled into the form as pasted: what signing in still needs is said when it is saved or tested.
  const result = ConnectionSettingsDraftSchema.safeParse(candidate)
  if (!result.success) {
    throw new ConnectionUriError(
      result.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; '),
    )
  }
  return result.data
}

export function buildConnectionUri(
  s: ConnectionSettings,
  opts: { includeCredentials?: boolean } = {},
): string {
  const db = s.defaultDatabase ? encodeURIComponent(s.defaultDatabase) : ''
  const cs = new ConnectionString(`${s.scheme}://${s.hosts.map(formatHost).join(',')}/${db}`)
  if (opts.includeCredentials && s.auth.username) {
    cs.username = encodeURIComponent(s.auth.username)
    if (s.auth.password) cs.password = encodeURIComponent(s.auth.password)
  }
  const p = cs.searchParams
  if (s.replicaSet) p.set('replicaSet', s.replicaSet)
  if (s.directConnection !== undefined) p.set('directConnection', String(s.directConnection))
  if (s.auth.mechanism !== 'none' && s.auth.mechanism !== 'DEFAULT') p.set('authMechanism', s.auth.mechanism)
  if (s.auth.authSource) p.set('authSource', s.auth.authSource)
  if (opts.includeCredentials) {
    const k = s.auth.kerberos
    const o = s.auth.oidc
    const pairs: Array<[string, string]> = [
      ...parseProperties(s.auth.mechanismProperties ?? ''),
      ...(s.auth.mechanism === 'GSSAPI' && k
        ? ([
            ['SERVICE_NAME', k.serviceName],
            ['SERVICE_REALM', k.serviceRealm],
            ['CANONICALIZE_HOST_NAME', k.canonicalizeHostName],
          ].filter(([, v]) => v) as Array<[string, string]>)
        : []),
      ...(s.auth.mechanism === 'MONGODB-OIDC' && o?.environment
        ? ([
            ['ENVIRONMENT', o.environment],
            ['TOKEN_RESOURCE', o.tokenResource],
          ].filter(([, v]) => v) as Array<[string, string]>)
        : []),
    ]
    if (pairs.length) p.set('authMechanismProperties', joinProperties(pairs))
  }
  if (s.tls.enabled !== (s.scheme === 'mongodb+srv')) p.set('tls', String(s.tls.enabled))
  if (s.tls.allowInvalidHostnames) p.set('tlsAllowInvalidHostnames', 'true')
  if (s.tls.allowInvalidCertificates) p.set('tlsAllowInvalidCertificates', 'true')
  if (s.readPreference) p.set('readPreference', s.readPreference)
  if (s.appName) p.set('appName', s.appName)
  if (s.connectTimeoutMS !== undefined) p.set('connectTimeoutMS', String(s.connectTimeoutMS))
  if (s.serverSelectionTimeoutMS !== undefined)
    p.set('serverSelectionTimeoutMS', String(s.serverSelectionTimeoutMS))
  for (const [key, value] of Object.entries(extraOptionsOnly(s.options))) p.set(key, value)
  return cs.toString()
}

type Section = Record<string, unknown> | undefined

/** Mechanism properties mix plain settings (SERVICE_NAME) and secrets (AWS_SESSION_TOKEN): mask per key. */
// A secret's word anywhere in the key, or a key that ends in _KEY: two tests, so neither reads as
// anchored by the other.
const isSecretProperty = (key: string) =>
  /SECRET|PASSWORD|SESSION_TOKEN|ACCESS_TOKEN/i.test(key) || /_KEY$/i.test(key)

function parseProperties(raw: string): Array<[string, string]> {
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf(':')
      return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)]
    })
}

const joinProperties = (pairs: Array<[string, string]>) => pairs.map(([k, v]) => `${k}:${v}`).join(',')

/**
 * Settings as they compare for "the same connection" (fourth review of the open's stop, nit 4):
 * read through the schema, so a record stored before a setting had its default has it, and the
 * mechanism properties in the one spelling a masked answer gives them back in.
 */
export function comparableSettings(s: ConnectionSettings): ConnectionSettings {
  const parsed = ConnectionSettingsSchema.safeParse(s)
  const copy = structuredClone(parsed.success ? parsed.data : s)
  if (copy.auth.mechanismProperties !== undefined) {
    const joined = joinProperties(parseProperties(copy.auth.mechanismProperties))
    if (joined) copy.auth.mechanismProperties = joined
    else delete copy.auth.mechanismProperties
  }
  return copy
}

/** W8: each KMS provider's secret fields, as [provider part, key] (KMS_SECRET_FIELDS). */
const kmsPart = (s: ConnectionSettings, provider: string): Section =>
  (s.encryption?.kms as Record<string, Section> | undefined)?.[provider]

export function maskSecrets(s: ConnectionSettings): ConnectionSettings {
  const copy = structuredClone(s)
  for (const [section, key] of SECRET_FIELDS) {
    const part = copy[section] as Section
    if (part && typeof part[key] === 'string' && part[key] !== '') part[key] = SECRET_MASK
  }
  // W8: KMS credentials are secrets as passwords are: never in an answer.
  for (const [provider, key] of KMS_SECRET_FIELDS) {
    const part = kmsPart(copy, provider)
    if (part && typeof part[key] === 'string' && part[key] !== '') part[key] = SECRET_MASK
  }
  if (copy.auth.mechanismProperties) {
    copy.auth.mechanismProperties = joinProperties(
      parseProperties(copy.auth.mechanismProperties).map(([k, v]) => [
        k,
        isSecretProperty(k) && v ? SECRET_MASK : v,
      ]),
    )
  }
  return copy
}

/** True when any secret (including mechanism-property values) still holds the display mask. */
export function hasMaskedSecret(s: ConnectionSettings): boolean {
  return (
    SECRET_FIELDS.some(([section, key]) => (s[section] as Section)?.[key] === SECRET_MASK) ||
    KMS_SECRET_FIELDS.some(([provider, key]) => kmsPart(s, provider)?.[key] === SECRET_MASK) ||
    (s.auth.mechanismProperties?.includes(SECRET_MASK) ?? false)
  )
}

/**
 * W8: where KMS credentials are used — the key vault and each provider's account and endpoint. A
 * stored secret is reused only for the same ones: a changed endpoint must not receive it unasked.
 */
function kmsTargetOf(s: ConnectionSettings): unknown {
  const e = s.encryption
  if (!e) return null
  return {
    keyVault: e.keyVaultNamespace,
    local: e.kms.local ? true : null,
    aws: e.kms.aws ? e.kms.aws.accessKeyId : null,
    azure: e.kms.azure
      ? [e.kms.azure.tenantId, e.kms.azure.clientId, e.kms.azure.identityPlatformEndpoint ?? null]
      : null,
    gcp: e.kms.gcp ? [e.kms.gcp.email, e.kms.gcp.endpoint ?? null] : null,
    kmip: e.kms.kmip ? [e.kms.kmip.endpoint, e.kms.kmip.caPem ?? null] : null,
  }
}

/**
 * Where and how a connection's secrets travel. Security audit 2026-10-16 (minor): the transport is
 * part of it — TLS off or loosened, another CA or SRV service, other mechanism properties or another
 * SSH account would send a stored password (LDAP's PLAIN: in the clear) where it was never typed.
 */
function targetOf(s: ConnectionSettings): string {
  return JSON.stringify({
    scheme: s.scheme,
    // A mongodb:// host without a port is the same server on 27017 (review of 2026-10-16).
    hosts: s.hosts
      .map((h) => formatHost(s.scheme === 'mongodb' ? { host: h.host, port: h.port ?? 27017 } : h))
      .sort(),
    srvServiceName: s.options?.srvServiceName ?? null,
    mechanism: s.auth.mechanism,
    properties: parseProperties(s.auth.mechanismProperties ?? '')
      .filter(([k]) => !isSecretProperty(k))
      .map(([k, v]) => `${k}:${v}`)
      .sort(),
    tls: {
      enabled: s.tls.enabled,
      ca: s.tls.caPem ?? null,
      allowInvalidHostnames: s.tls.allowInvalidHostnames,
      allowInvalidCertificates: s.tls.allowInvalidCertificates,
    },
    ssh: s.ssh?.enabled ? { at: `${s.ssh.host}:${s.ssh.port}`, username: s.ssh.username } : null,
    kms: kmsTargetOf(s),
  })
}

/**
 * Independent review of the security pass (I4): the SSH host key pinned on first use. Only two pins
 * that differ are another server; a pin on one side alone is the first use (a test that learned it, a
 * form loaded before the first connect pinned it) and changes nothing.
 */
function pinChanged(incoming: ConnectionSettings, stored: ConnectionSettings): boolean {
  const a = incoming.ssh?.enabled ? incoming.ssh.hostFingerprint : undefined
  const b = stored.ssh?.enabled ? stored.ssh.hostFingerprint : undefined
  return !!a && !!b && a !== b
}

/**
 * Masked secrets may only be reused for the same server, auth mechanism, transport (TLS, CA,
 * certificate checks) and SSH endpoint; otherwise a stored password could be sent to a new (possibly
 * hostile) host, or the same host in the clear, without re-entry.
 * Returns a user-facing problem, or null when reuse is safe.
 */
export function secretReuseProblem(
  incoming: ConnectionSettings,
  stored: ConnectionSettings | undefined,
): string | null {
  if (!hasMaskedSecret(incoming)) return null
  // Fourth review of the open's stop (nit 4): a record stored before a setting had its default is
  // the same server, as the form gives it back.
  const [now, before] = [comparableSettings(incoming), stored && comparableSettings(stored)]
  if (before && targetOf(now) === targetOf(before) && !pinChanged(now, before)) return null
  return 'The server, authentication method, TLS settings, SSH host or key provider changed: re-enter the password and other secrets'
}

export function mergeSecrets(
  incoming: ConnectionSettings,
  stored: ConnectionSettings | undefined,
): ConnectionSettings {
  const copy = structuredClone(incoming)
  for (const [section, key] of SECRET_FIELDS) {
    const part = copy[section] as Section
    if (!part || part[key] !== SECRET_MASK) continue
    const previous = (stored?.[section] as Section)?.[key]
    if (typeof previous === 'string') part[key] = previous
    else delete part[key]
  }
  for (const [provider, key] of KMS_SECRET_FIELDS) {
    const part = kmsPart(copy, provider)
    if (!part || part[key] !== SECRET_MASK) continue
    const previous = stored ? kmsPart(stored, provider)?.[key] : undefined
    if (typeof previous === 'string') part[key] = previous
    else delete part[key]
  }
  if (copy.auth.mechanismProperties?.includes(SECRET_MASK)) {
    const previous = new Map(parseProperties(stored?.auth.mechanismProperties ?? ''))
    const merged = parseProperties(copy.auth.mechanismProperties).flatMap(
      ([k, v]): Array<[string, string]> => {
        if (v !== SECRET_MASK) return [[k, v]]
        const kept = previous.get(k)
        return kept === undefined ? [] : [[k, kept]]
      },
    )
    if (merged.length > 0) copy.auth.mechanismProperties = joinProperties(merged)
    else delete copy.auth.mechanismProperties
  }
  return copy
}
