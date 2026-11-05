// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  KERBEROS_CANONICALIZE,
  SECRET_MASK,
  type AiAgentTool,
  type AuthMechanism,
  type ConnectionColor,
  type ExtraUriOption,
  type OidcEnvironment,
} from '@mongo-manager/shared/browser'
import type { ConnectionSettings } from '@mongo-manager/shared'
import type { ConnectionDto, ConnectionInputBody } from '@/api/connections'

type ReadPreference = NonNullable<ConnectionSettings['readPreference']>

export interface HostRow {
  host: string
  port: string
}
export interface OptionRow {
  key: ExtraUriOption | ''
  value: string
}

/** Everything the editor edits; numbers stay strings until they are sent. */
export interface ConnectionForm {
  name: string
  group: string
  color: ConnectionColor | ''
  favorite: boolean
  readOnly: boolean
  /** Phase 4a-1 spec §2.4. */
  aiPolicy: 'off' | 'local' | 'any'
  /** W6.3: the agent may propose changes on this connection. */
  aiAgentWrites: boolean
  /** C5: the agent's tools turned off on it. */
  aiAgentToolsOff: AiAgentTool[]
  scheme: 'mongodb' | 'mongodb+srv'
  hosts: HostRow[]
  defaultDatabase: string
  replicaSet: string
  directConnection: boolean
  auth: {
    mechanism: AuthMechanism
    username: string
    password: string
    authSource: string
    mechanismProperties: string
    /** W7: MONGODB-OIDC; allowed hosts as typed, comma separated. */
    oidc: {
      redirectUri: string
      /** Security review I5: the identity provider an administrator expects (issuer URL), or empty. */
      expectedIssuer: string
      allowedHosts: string
      environment: OidcEnvironment | ''
      tokenResource: string
      /** Security review I3: the token resource confirmed (the very value), or empty. */
      tokenResourceConfirmed: string
      /** W7 re-review: the workload identity confirmed (the very environment), or empty. */
      environmentConfirmed: string
    }
    /** W8: Kerberos (GSSAPI). */
    kerberos: { serviceName: string; serviceRealm: string; canonicalizeHostName: Canonicalize | '' }
  }
  /** W8: client-side encryption (CSFLE / Queryable Encryption). */
  encryption: EncryptionForm
  tls: {
    enabled: boolean
    caPem: string
    certificateKeyPem: string
    certificateKeyPassword: string
    allowInvalidHostnames: boolean
    allowInvalidCertificates: boolean
  }
  ssh: {
    enabled: boolean
    host: string
    port: string
    username: string
    method: 'password' | 'privateKey'
    password: string
    privateKey: string
    passphrase: string
    hostFingerprint: string
  }
  readPreference: ReadPreference | ''
  appName: string
  connectTimeoutMS: string
  serverSelectionTimeoutMS: string
  options: OptionRow[]
}

type Canonicalize = (typeof KERBEROS_CANONICALIZE)[number]

export interface EncryptionForm {
  enabled: boolean
  mode: 'auto' | 'decryptOnly'
  keyVaultNamespace: string
  local: { on: boolean; key: string }
  aws: { on: boolean; accessKeyId: string; secretAccessKey: string; sessionToken: string }
  azure: {
    on: boolean
    tenantId: string
    clientId: string
    clientSecret: string
    identityPlatformEndpoint: string
  }
  gcp: { on: boolean; email: string; privateKey: string; endpoint: string }
  kmip: { on: boolean; endpoint: string; caPem: string; certificateKeyPem: string }
  library: 'cryptShared' | 'mongocryptd'
  cryptSharedLibPath: string
  mongocryptdUri: string
  schemaMap: string
  encryptedFieldsMap: string
}

export type Section = 'general' | 'server' | 'auth' | 'tls' | 'ssh' | 'encryption' | 'advanced'
// User request 2026-10-16: under Advanced options, the server first; General holds the place and rules.
export const SECTIONS: readonly Section[] = [
  'server',
  'auth',
  'tls',
  'ssh',
  'encryption',
  'general',
  'advanced',
]

const str = (v: string | undefined | null): string => v ?? ''
const num = (v: number | undefined): string => (v === undefined ? '' : String(v))
const optional = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim())
/** Secrets are sent verbatim: leading or trailing spaces can be part of a password. */
const optionalRaw = (v: string): string | undefined => (v === '' ? undefined : v)
/** Unparseable input becomes NaN → JSON null, so the server reports the exact field. */
const optionalNumber = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v.trim()))

function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

export const isMasked = (value: string): boolean => value === SECRET_MASK

export function emptyEncryption(): EncryptionForm {
  return {
    enabled: false,
    mode: 'auto',
    keyVaultNamespace: 'encryption.__keyVault',
    local: { on: false, key: '' },
    aws: { on: false, accessKeyId: '', secretAccessKey: '', sessionToken: '' },
    azure: { on: false, tenantId: '', clientId: '', clientSecret: '', identityPlatformEndpoint: '' },
    gcp: { on: false, email: '', privateKey: '', endpoint: '' },
    kmip: { on: false, endpoint: '', caPem: '', certificateKeyPem: '' },
    library: 'cryptShared',
    cryptSharedLibPath: '',
    mongocryptdUri: '',
    schemaMap: '',
    encryptedFieldsMap: '',
  }
}

const emptyAuthExtras = () => ({
  oidc: {
    redirectUri: '',
    expectedIssuer: '',
    allowedHosts: '',
    environment: '' as const,
    tokenResource: '',
    tokenResourceConfirmed: '',
    environmentConfirmed: '',
  },
  kerberos: { serviceName: '', serviceRealm: '', canonicalizeHostName: '' as const },
})

function emptySsh(): ConnectionForm['ssh'] {
  return {
    enabled: false,
    host: '',
    port: '22',
    username: '',
    method: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    hostFingerprint: '',
  }
}

export function emptyForm(): ConnectionForm {
  return {
    name: '',
    group: '',
    color: '',
    favorite: false,
    readOnly: false,
    aiPolicy: 'any',
    aiAgentWrites: true,
    aiAgentToolsOff: [],
    scheme: 'mongodb',
    // User report 2026-10-16: a new form is empty; localhost:27017 is only suggested (placeholders).
    hosts: [{ host: '', port: '' }],
    defaultDatabase: '',
    replicaSet: '',
    directConnection: false,
    auth: {
      mechanism: 'none',
      username: '',
      password: '',
      authSource: '',
      mechanismProperties: '',
      ...emptyAuthExtras(),
    },
    encryption: emptyEncryption(),
    tls: {
      enabled: false,
      caPem: '',
      certificateKeyPem: '',
      certificateKeyPassword: '',
      allowInvalidHostnames: false,
      allowInvalidCertificates: false,
    },
    ssh: emptySsh(),
    readPreference: '',
    appName: '',
    connectTimeoutMS: '',
    serverSelectionTimeoutMS: '',
    options: [],
  }
}

/** Copies connection settings into the form; name, group, colour and flags are left alone. */
export function applySettings(
  form: ConnectionForm,
  s: ConnectionSettings,
  opts: { keepSsh?: boolean } = {},
): void {
  form.scheme = s.scheme
  form.hosts = s.hosts.map((h) => ({ host: h.host, port: num(h.port) }))
  form.defaultDatabase = str(s.defaultDatabase)
  form.replicaSet = str(s.replicaSet)
  form.directConnection = s.directConnection ?? false
  form.auth = {
    mechanism: s.auth.mechanism,
    username: str(s.auth.username),
    password: str(s.auth.password),
    authSource: str(s.auth.authSource),
    mechanismProperties: str(s.auth.mechanismProperties),
    oidc: {
      redirectUri: str(s.auth.oidc?.redirectUri),
      expectedIssuer: str(s.auth.oidc?.expectedIssuer),
      allowedHosts: (s.auth.oidc?.allowedHosts ?? []).join(', '),
      environment: s.auth.oidc?.environment ?? '',
      tokenResource: str(s.auth.oidc?.tokenResource),
      tokenResourceConfirmed: str(s.auth.oidc?.tokenResourceConfirmed),
      environmentConfirmed: str(s.auth.oidc?.environmentConfirmed),
    },
    kerberos: {
      serviceName: str(s.auth.kerberos?.serviceName),
      serviceRealm: str(s.auth.kerberos?.serviceRealm),
      canonicalizeHostName: s.auth.kerberos?.canonicalizeHostName ?? '',
    },
  }
  const e = s.encryption
  form.encryption = e
    ? {
        enabled: e.enabled,
        mode: e.mode,
        keyVaultNamespace: e.keyVaultNamespace,
        local: { on: !!e.kms.local, key: str(e.kms.local?.key) },
        aws: {
          on: !!e.kms.aws,
          accessKeyId: str(e.kms.aws?.accessKeyId),
          secretAccessKey: str(e.kms.aws?.secretAccessKey),
          sessionToken: str(e.kms.aws?.sessionToken),
        },
        azure: {
          on: !!e.kms.azure,
          tenantId: str(e.kms.azure?.tenantId),
          clientId: str(e.kms.azure?.clientId),
          clientSecret: str(e.kms.azure?.clientSecret),
          identityPlatformEndpoint: str(e.kms.azure?.identityPlatformEndpoint),
        },
        gcp: {
          on: !!e.kms.gcp,
          email: str(e.kms.gcp?.email),
          privateKey: str(e.kms.gcp?.privateKey),
          endpoint: str(e.kms.gcp?.endpoint),
        },
        kmip: {
          on: !!e.kms.kmip,
          endpoint: str(e.kms.kmip?.endpoint),
          caPem: str(e.kms.kmip?.caPem),
          certificateKeyPem: str(e.kms.kmip?.certificateKeyPem),
        },
        library: e.library,
        cryptSharedLibPath: str(e.cryptSharedLibPath),
        mongocryptdUri: str(e.mongocryptdUri),
        schemaMap: str(e.schemaMap),
        encryptedFieldsMap: str(e.encryptedFieldsMap),
      }
    : emptyEncryption()
  form.tls = {
    enabled: s.tls.enabled,
    caPem: str(s.tls.caPem),
    certificateKeyPem: str(s.tls.certificateKeyPem),
    certificateKeyPassword: str(s.tls.certificateKeyPassword),
    allowInvalidHostnames: s.tls.allowInvalidHostnames,
    allowInvalidCertificates: s.tls.allowInvalidCertificates,
  }
  if (!opts.keepSsh) {
    form.ssh = s.ssh
      ? {
          enabled: s.ssh.enabled,
          host: s.ssh.host,
          port: String(s.ssh.port),
          username: s.ssh.username,
          method: s.ssh.method,
          password: str(s.ssh.password),
          privateKey: str(s.ssh.privateKey),
          passphrase: str(s.ssh.passphrase),
          hostFingerprint: str(s.ssh.hostFingerprint),
        }
      : emptySsh()
  }
  form.readPreference = s.readPreference ?? ''
  form.appName = str(s.appName)
  form.connectTimeoutMS = num(s.connectTimeoutMS)
  form.serverSelectionTimeoutMS = num(s.serverSelectionTimeoutMS)
  form.options = Object.entries(s.options).map(([key, value]) => ({
    key: key as ExtraUriOption,
    value: value ?? '',
  }))
}

export function formFromDto(
  dto: ConnectionDto,
  opts: { duplicateName?: (name: string) => string } = {},
): ConnectionForm {
  const form = emptyForm()
  form.name = opts.duplicateName ? opts.duplicateName(dto.name) : dto.name
  form.group = str(dto.group)
  form.color = dto.color ?? ''
  form.favorite = dto.favorite
  form.readOnly = dto.readOnly
  form.aiPolicy = dto.aiPolicy ?? 'any'
  form.aiAgentWrites = dto.aiAgentWrites ?? true
  form.aiAgentToolsOff = [...(dto.aiAgentToolsOff ?? [])]
  applySettings(form, dto.settings)
  if (opts.duplicateName) {
    // A new connection cannot reuse another one's stored secrets: they must be typed again.
    const clear = (v: string) => (isMasked(v) ? '' : v)
    form.auth.password = clear(form.auth.password)
    form.tls.certificateKeyPem = clear(form.tls.certificateKeyPem)
    form.tls.certificateKeyPassword = clear(form.tls.certificateKeyPassword)
    form.ssh.password = clear(form.ssh.password)
    form.ssh.privateKey = clear(form.ssh.privateKey)
    form.ssh.passphrase = clear(form.ssh.passphrase)
    // W8: and every KMS credential.
    form.encryption.local.key = clear(form.encryption.local.key)
    form.encryption.aws.secretAccessKey = clear(form.encryption.aws.secretAccessKey)
    form.encryption.aws.sessionToken = clear(form.encryption.aws.sessionToken)
    form.encryption.azure.clientSecret = clear(form.encryption.azure.clientSecret)
    form.encryption.gcp.privateKey = clear(form.encryption.gcp.privateKey)
    form.encryption.kmip.certificateKeyPem = clear(form.encryption.kmip.certificateKeyPem)
    // Masked mechanism-property values (e.g. AWS_SESSION_TOKEN) are secrets too.
    form.auth.mechanismProperties = form.auth.mechanismProperties
      .split(',')
      .filter((pair) => pair.trim() !== '' && !pair.includes(SECRET_MASK))
      .join(',')
  }
  return form
}

/** W7: OIDC's own fields, sent only for OIDC. */
function oidcFrom(f: ConnectionForm): Record<string, unknown> | undefined {
  const o = f.auth.oidc
  const hosts = o.allowedHosts
    .split(/[,\s]+/)
    .map((h) => h.trim())
    .filter(Boolean)
  const out = compact({
    redirectUri: optional(o.redirectUri),
    expectedIssuer: o.environment ? undefined : optional(o.expectedIssuer),
    allowedHosts: hosts.length ? hosts : undefined,
    environment: o.environment || undefined,
    tokenResource: o.environment ? optional(o.tokenResource) : undefined,
    // Security review I3: confirmed only for the value as it stands now.
    tokenResourceConfirmed:
      o.environment && o.tokenResource.trim() && o.tokenResourceConfirmed.trim() === o.tokenResource.trim()
        ? o.tokenResource.trim()
        : undefined,
    // W7 re-review: the workload identity, confirmed for the environment as it stands now.
    environmentConfirmed:
      o.environment && o.environmentConfirmed === o.environment ? o.environment : undefined,
  })
  return Object.keys(out).length ? out : undefined
}

/** W8: Kerberos's own fields, sent only for GSSAPI. */
function kerberosFrom(f: ConnectionForm): Record<string, unknown> | undefined {
  const k = f.auth.kerberos
  const out = compact({
    serviceName: optional(k.serviceName),
    serviceRealm: optional(k.serviceRealm),
    canonicalizeHostName: k.canonicalizeHostName || undefined,
  })
  return Object.keys(out).length ? out : undefined
}

/** W8: the encryption section, sent only when it is on (its secrets verbatim, masks as they are). */
export function encryptionFrom(e: EncryptionForm): Record<string, unknown> | undefined {
  if (!e.enabled) return undefined
  return compact({
    enabled: true,
    mode: e.mode,
    keyVaultNamespace: e.keyVaultNamespace.trim(),
    kms: compact({
      local: e.local.on ? { key: e.local.key.trim() } : undefined,
      aws: e.aws.on
        ? compact({
            accessKeyId: e.aws.accessKeyId.trim(),
            secretAccessKey: optionalRaw(e.aws.secretAccessKey),
            sessionToken: optionalRaw(e.aws.sessionToken),
          })
        : undefined,
      azure: e.azure.on
        ? compact({
            tenantId: e.azure.tenantId.trim(),
            clientId: e.azure.clientId.trim(),
            clientSecret: optionalRaw(e.azure.clientSecret),
            identityPlatformEndpoint: optional(e.azure.identityPlatformEndpoint),
          })
        : undefined,
      gcp: e.gcp.on
        ? compact({
            email: e.gcp.email.trim(),
            privateKey: optionalRaw(e.gcp.privateKey),
            endpoint: optional(e.gcp.endpoint),
          })
        : undefined,
      kmip: e.kmip.on
        ? compact({
            endpoint: e.kmip.endpoint.trim(),
            caPem: optionalRaw(e.kmip.caPem),
            certificateKeyPem: optionalRaw(e.kmip.certificateKeyPem),
          })
        : undefined,
    }),
    library: e.library,
    cryptSharedLibPath: e.library === 'cryptShared' ? optional(e.cryptSharedLibPath) : undefined,
    mongocryptdUri: e.library === 'mongocryptd' ? optional(e.mongocryptdUri) : undefined,
    schemaMap: optional(e.schemaMap),
    encryptedFieldsMap: optional(e.encryptedFieldsMap),
  })
}

export function settingsFromForm(f: ConnectionForm): Record<string, unknown> {
  const withPassword = !['none', 'MONGODB-X509', 'MONGODB-OIDC'].includes(f.auth.mechanism)
  return compact({
    scheme: f.scheme,
    hosts: f.hosts.map((h) =>
      compact({ host: h.host.trim(), port: f.scheme === 'mongodb+srv' ? undefined : optionalNumber(h.port) }),
    ),
    defaultDatabase: optional(f.defaultDatabase),
    replicaSet: optional(f.replicaSet),
    directConnection: f.directConnection || undefined,
    auth:
      f.auth.mechanism === 'none'
        ? { mechanism: 'none' }
        : compact({
            mechanism: f.auth.mechanism,
            username: optional(f.auth.username),
            password: withPassword ? optionalRaw(f.auth.password) : undefined,
            authSource: optional(f.auth.authSource),
            // Only MONGODB-AWS uses them (and shows the field): hidden ones are never sent.
            mechanismProperties:
              f.auth.mechanism === 'MONGODB-AWS' ? optional(f.auth.mechanismProperties) : undefined,
            oidc: f.auth.mechanism === 'MONGODB-OIDC' ? oidcFrom(f) : undefined,
            kerberos: f.auth.mechanism === 'GSSAPI' ? kerberosFrom(f) : undefined,
          }),
    encryption: encryptionFrom(f.encryption),
    tls: f.tls.enabled
      ? compact({
          enabled: true,
          caPem: optionalRaw(f.tls.caPem),
          certificateKeyPem: optionalRaw(f.tls.certificateKeyPem),
          certificateKeyPassword: optionalRaw(f.tls.certificateKeyPassword),
          allowInvalidHostnames: f.tls.allowInvalidHostnames,
          allowInvalidCertificates: f.tls.allowInvalidCertificates,
        })
      : { enabled: false },
    ssh: f.ssh.enabled
      ? compact({
          enabled: true,
          host: f.ssh.host.trim(),
          port: optionalNumber(f.ssh.port) ?? 22,
          username: f.ssh.username.trim(),
          method: f.ssh.method,
          password: f.ssh.method === 'password' ? optionalRaw(f.ssh.password) : undefined,
          privateKey: f.ssh.method === 'privateKey' ? optionalRaw(f.ssh.privateKey) : undefined,
          passphrase: f.ssh.method === 'privateKey' ? optionalRaw(f.ssh.passphrase) : undefined,
          hostFingerprint: optional(f.ssh.hostFingerprint),
        })
      : undefined,
    readPreference: f.readPreference || undefined,
    appName: optional(f.appName),
    connectTimeoutMS: optionalNumber(f.connectTimeoutMS),
    serverSelectionTimeoutMS: optionalNumber(f.serverSelectionTimeoutMS),
    options: Object.fromEntries(
      f.options.filter((o) => o.key && o.value.trim() !== '').map((o) => [o.key, o.value.trim()]),
    ),
  })
}

export function inputFromForm(f: ConnectionForm): ConnectionInputBody {
  return {
    name: f.name.trim(),
    ...(f.group.trim() ? { group: f.group.trim() } : {}),
    ...(f.color ? { color: f.color } : {}),
    favorite: f.favorite,
    readOnly: f.readOnly,
    aiPolicy: f.aiPolicy,
    aiAgentWrites: f.aiAgentWrites,
    aiAgentToolsOff: [...f.aiAgentToolsOff],
    settings: settingsFromForm(f),
  }
}

export function patchFromForm(f: ConnectionForm): Record<string, unknown> {
  return {
    name: f.name.trim(),
    group: f.group.trim() || null,
    color: f.color || null,
    favorite: f.favorite,
    readOnly: f.readOnly,
    aiPolicy: f.aiPolicy,
    aiAgentWrites: f.aiAgentWrites,
    aiAgentToolsOff: [...f.aiAgentToolsOff],
    settings: settingsFromForm(f),
  }
}

export { fieldErrors, sectionOf } from './fieldPaths'
