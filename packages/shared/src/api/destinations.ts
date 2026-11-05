// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import type { BackupFormat, BackupScope } from './backup'
import type { JobView } from './jobs'

/** Phase 3d-3b spec §1.1: where backups can go. */
export const DESTINATION_TYPES = ['folder', 's3', 'gdrive', 'webdav', 'gcs', 'azure', 'sftp'] as const
export type DestinationType = (typeof DESTINATION_TYPES)[number]
export const GRANT_LEVELS = ['send', 'browse'] as const
export type GrantLevel = (typeof GRANT_LEVELS)[number]
export const S3_PRESETS = ['aws', 'minio', 'r2', 'b2', 'spaces', 'spacesCold', 'wasabi', 'custom'] as const
export type S3Preset = (typeof S3_PRESETS)[number]
export const WEBDAV_PRESETS = ['generic', 'nextcloud'] as const
export const S3_STORAGE_CLASSES = [
  'STANDARD',
  'STANDARD_IA',
  'ONEZONE_IA',
  'INTELLIGENT_TIERING',
  'GLACIER_IR',
  'GLACIER',
  'DEEP_ARCHIVE',
] as const
/** Spec §2.3: objects in these classes need a thaw in the provider's console before a restore. */
export const ARCHIVE_STORAGE_CLASSES: readonly string[] = ['GLACIER', 'DEEP_ARCHIVE']
export const MAX_SEND_DESTINATIONS = 8

const Name = z.string().trim().min(1).max(64)
const Pem = z
  .string()
  .max(65_536)
  .refine((p) => p.includes('-----BEGIN CERTIFICATE-----'), 'A PEM certificate is expected')
/** http(s) only, no credentials in the URL; the egress policy decides about http (spec §3). */
const WebUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => {
    // Zod runs this even when .url() failed: an unparsable address is an issue, never an exception.
    let url: URL
    try {
      url = new URL(u)
    } catch {
      return false
    }
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  }, 'An https:// address without credentials is expected')
  // Final review B27: requests are built on the address; a query or fragment would ride along (an
  // empty "?" or "#" too, which URL itself forgets).
  .refine((u) => !/[?#]/.test(u), 'The address cannot have a query (?…) or a fragment (#…)')
/** Final review B27: the bucket and the prefix have their own fields; a path here would be ignored or misread. */
const S3Endpoint = WebUrl.refine((u) => {
  try {
    return new URL(u).pathname === '/'
  } catch {
    return true
  }
}, 'The endpoint is the server only: put the bucket and the prefix in their own fields')
const SEGMENT = /^[A-Za-z0-9._ -]{1,128}$/
/** A relative path of safe segments; never "." or "..". */
const RelPath = z
  .string()
  .max(512)
  .refine(
    (p) =>
      p === '' || p.split('/').every((s) => SEGMENT.test(s) && s !== '.' && s !== '..' && s.trim() === s),
    'Letters, digits, spaces, dots, dashes and underscores, separated by "/"',
  )
const Secret = z.string().min(1).max(8192)

export const PolicySchema = z.strictObject({ encryptedOnly: z.boolean().default(true) })
export type DestinationPolicy = z.infer<typeof PolicySchema>
const policy = PolicySchema.default({ encryptedOnly: true })

export const FolderConfigSchema = z.strictObject({ path: z.string().min(1).max(4096) })
export const S3ConfigSchema = z.strictObject({
  preset: z.enum(S3_PRESETS),
  endpoint: S3Endpoint,
  region: z.string().regex(/^[a-z0-9-]{1,32}$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  prefix: RelPath.default(''),
  pathStyle: z.boolean().default(false),
  storageClass: z.enum(S3_STORAGE_CLASSES).default('STANDARD'),
  sse: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('none') }),
      z.strictObject({ kind: z.literal('AES256') }),
      z.strictObject({ kind: z.literal('aws:kms'), keyId: z.string().max(2048).optional() }),
    ])
    .default({ kind: 'none' }),
  caPem: Pem.optional(),
})
export const S3SecretsSchema = z.strictObject({
  accessKeyId: z.string().regex(/^[\x21-\x7e]{3,128}$/),
  secretAccessKey: z.string().min(8).max(256),
})
export const WebdavConfigSchema = z.strictObject({
  preset: z.enum(WEBDAV_PRESETS),
  url: WebUrl,
  folder: RelPath.default(''),
  username: z.string().min(1).max(256),
  verifyReadBack: z.boolean().default(false),
  caPem: Pem.optional(),
})
export const WebdavSecretsSchema = z.strictObject({ password: Secret })
export const GdriveConfigSchema = z
  .strictObject({
    auth: z.enum(['oauth', 'serviceAccount']),
    folderName: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[^/\\'"]+$/)
      .default('Mongo Manager backups'),
    clientId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{8,256}$/)
      .optional(),
    sharedDriveId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,128}$/)
      .optional(),
  })
  .refine((c) => c.auth !== 'serviceAccount' || c.sharedDriveId, {
    message: 'A service account writes into a Shared Drive: its id is required',
    path: ['sharedDriveId'],
  })
  .refine((c) => c.auth !== 'oauth' || c.clientId, {
    message: 'The OAuth client id is required',
    path: ['clientId'],
  })
export const GdriveSecretsSchema = z.strictObject({
  clientSecret: Secret.optional(),
  serviceAccountKey: z.string().min(2).max(16_384).optional(),
})
/** W4.5: Google Cloud Storage — a bucket, a prefix, and the storage class the backups are written in. */
export const GCS_STORAGE_CLASSES = ['STANDARD', 'NEARLINE', 'COLDLINE', 'ARCHIVE'] as const
export const GcsConfigSchema = z.strictObject({
  /** Google's bucket naming: 3–63 lowercase letters, digits, dashes, underscores and dots. */
  bucket: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/),
  prefix: RelPath.default(''),
  storageClass: z.enum(GCS_STORAGE_CLASSES).default('STANDARD'),
})
export const GcsSecretsSchema = z.strictObject({ serviceAccountKey: z.string().min(2).max(16_384) })

/**
 * W4.5: Azure Blob Storage — a storage account's container, signed with a SAS token or the account's
 * shared key. The tier the backups are written in ("default" leaves the account's own).
 */
export const AZURE_ACCESS_TIERS = ['default', 'Hot', 'Cool', 'Cold', 'Archive'] as const
export const AZURE_AUTHS = ['sas', 'sharedKey'] as const
/**
 * The query fields a SAS token may hold (Azure's documented service and account SAS fields). Any
 * other field is refused: the token is appended to every request, so it must not be able to change
 * what a request does (a "comp" or a "restype" of its own).
 */
const SAS_FIELDS = new Set([
  'sv', 'ss', 'srt', 'sp', 'se', 'st', 'spr', 'sip', 'sig', 'sr', 'si', 'ses', 'sdd', 'skoid', 'sktid',
  'skt', 'ske', 'sks', 'skv', 'saoid', 'suoid', 'scid', 'rscc', 'rscd', 'rsce', 'rscl', 'rsct',
]) // prettier-ignore
/** A SAS token's fields, from the token as Azure's portal shows it (with or without its "?"); null when it is not one. */
export function sasFields(token: string): Array<[string, string]> | null {
  const text = token.trim().replace(/^\?/, '')
  if (!text || text.length > 4096 || /[\s#]/.test(text)) return null
  const fields: Array<[string, string]> = []
  for (const part of text.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) return null
    const name = part.slice(0, eq)
    let value: string
    try {
      value = decodeURIComponent(part.slice(eq + 1))
    } catch {
      return null
    }
    if (!SAS_FIELDS.has(name) || fields.some(([n]) => n === name)) return null
    fields.push([name, value])
  }
  return fields.some(([n]) => n === 'sig') && fields.some(([n]) => n === 'sv') ? fields : null
}
export const AzureConfigSchema = z.strictObject({
  /** A storage account's name: 3–24 lowercase letters and digits (it is part of the host). */
  account: z.string().regex(/^[a-z0-9]{3,24}$/),
  /** A container's name: 3–63 lowercase letters, digits and single dashes. */
  container: z.string().regex(/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  prefix: RelPath.default(''),
  auth: z.enum(AZURE_AUTHS),
  accessTier: z.enum(AZURE_ACCESS_TIERS).default('default'),
  /** Another cloud's or a private endpoint's Blob service; https://<account>.blob.core.windows.net when absent. */
  endpoint: S3Endpoint.refine(
    (u) => u.toLowerCase().startsWith('https://'),
    'An https:// address is expected',
  ).optional(),
  caPem: Pem.optional(),
})
export const AzureSecretsSchema = z.strictObject({
  sasToken: z
    .string()
    .max(4096)
    .refine((t) => sasFields(t) !== null, 'A SAS token (sv=…&sig=…) is expected')
    .optional(),
  /** A storage account key: 64 bytes in base64. */
  accountKey: z
    .string()
    .regex(/^[A-Za-z0-9+/]{86}==$/, 'A storage account key (88 characters of base64) is expected')
    .optional(),
})

/**
 * W4.5: SFTP — a folder on an SSH server, signed in with a password or a private key. The server's
 * host key is pinned by its SHA-256 fingerprint (as SSH tunnels pin theirs): nothing is sent to a
 * server whose key is not the pinned one, and none before one is pinned.
 */
export const SFTP_AUTHS = ['password', 'privateKey'] as const
export const HOST_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/
export const SftpConfigSchema = z.strictObject({
  /** A host name or an IP address (no user, port or path in it). */
  host: z
    .string()
    .min(1)
    .max(253)
    // Split, not one pattern over the whole name: a repeated group with an optional dot backtracks.
    .refine(
      (h) =>
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) ||
        /^\[?[0-9a-fA-F]{0,4}(?::[0-9a-fA-F.]{0,15}){2,8}\]?$/.test(h) ||
        h
          .replace(/\.$/, '')
          .split('.')
          .every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l)),
      'A host name or an IP address',
    ),
  port: z.number().int().min(1).max(65_535).default(22),
  username: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\s:@/\\]+$/),
  /** The folder backups go under ("" is the login folder); absolute with a leading "/". */
  folder: z
    .string()
    .max(1024)
    .refine((f) => f === '' || f === '/' || RelPath.safeParse(f.replace(/^\//, '')).success, {
      message: 'Letters, digits, spaces, dots, dashes and underscores, separated by "/"',
    })
    .default(''),
  auth: z.enum(SFTP_AUTHS),
  hostFingerprint: z.string().regex(HOST_FINGERPRINT).optional(),
  /** SFTP has no checksum of its own: each copy is read back whole unless this is turned off. */
  verifyReadBack: z.boolean().default(true),
})
export const SftpSecretsSchema = z.strictObject({
  password: Secret.optional(),
  privateKey: z
    .string()
    .max(16_384)
    .refine(
      (k) => /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(k.trim()),
      'A private key in PEM or OpenSSH form is expected',
    )
    .optional(),
  passphrase: Secret.optional(),
})

const entry = <T extends string, C extends z.ZodTypeAny, S extends z.ZodTypeAny>(
  type: T,
  config: C,
  secrets: S,
) =>
  z.strictObject({
    type: z.literal(type),
    name: Name,
    config,
    secrets: secrets.optional(),
    policy,
    /** Drive with OAuth: the approved device flow that holds the refresh token (never sent back). */
    deviceFlowId: z.string().uuid().optional(),
  })
export const DestinationInputSchema = z.discriminatedUnion('type', [
  entry('folder', FolderConfigSchema, z.strictObject({})),
  entry('s3', S3ConfigSchema, S3SecretsSchema),
  entry('gdrive', GdriveConfigSchema, GdriveSecretsSchema),
  entry('webdav', WebdavConfigSchema, WebdavSecretsSchema),
  entry('gcs', GcsConfigSchema, GcsSecretsSchema),
  entry('azure', AzureConfigSchema, AzureSecretsSchema),
  entry('sftp', SftpConfigSchema, SftpSecretsSchema),
])
export type DestinationInput = z.infer<typeof DestinationInputSchema>
/** Spec §4.4: secrets are write-only; a field left out keeps its stored value; empty is refused. */
export const DestinationPatchSchema = z.strictObject({
  name: Name.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), Secret).optional(),
  policy: PolicySchema.optional(),
  deviceFlowId: z.string().uuid().optional(),
})
export type DestinationPatch = z.infer<typeof DestinationPatchSchema>

export type DestinationConfig =
  | z.infer<typeof FolderConfigSchema>
  | z.infer<typeof S3ConfigSchema>
  | z.infer<typeof GdriveConfigSchema>
  | z.infer<typeof WebdavConfigSchema>
  | z.infer<typeof GcsConfigSchema>
  | z.infer<typeof AzureConfigSchema>
  | z.infer<typeof SftpConfigSchema>

export const TEST_STEPS = ['resolve', 'connect', 'auth', 'write', 'read', 'delete'] as const
export type TestStepName = (typeof TEST_STEPS)[number]
export interface TestStep {
  step: TestStepName
  ok: boolean
  /** null: not measured (a step that did not run, or a local folder). */
  ms: number | null
  /** A reason code, mapped to words by the UI (destinations.reason.<code>). */
  reason?: string
  /** The provider's own error code, scrubbed (administrators only see tests). */
  detail?: string
  /**
   * W4.5 (SFTP): the SHA-256 fingerprint of the host key the server showed, when it is not the
   * pinned one (or none is pinned yet) — for the administrator to compare and trust.
   */
  hostKey?: string
  /** Short names review 7: which folder refusal a `path` one is (a FolderRefusal, or newer). */
  why?: string
  /** Short names review 7: the folder name a `path_name` refusal is about, quoted and escaped. */
  name?: string
}

/**
 * Short names reviews 7 and 8: why a server folder is refused — a `path` refusal's `why`, worded by
 * the web as destinations.pathWhy.<code> (a test keeps the two in step).
 */
export const FOLDER_REFUSALS = [
  'no_roots',
  'root_missing',
  'network',
  'absolute',
  'roots',
  'data',
  'create',
  'too_long',
  'read_only',
  'link',
  'outside',
  'not_folder',
  'layout',
] as const
export type FolderRefusal = (typeof FOLDER_REFUSALS)[number]

export interface DestinationStatus {
  state: 'unknown' | 'ok' | 'failed' | 'reconnect'
  checkedAt: number | null
  reason?: string
  /** Short names review 8 (M-6): a failed test's folder refusal and name, as on its step. */
  why?: string
  name?: string
  /** Drive: the connected account's e-mail address (OAuth) or the service account's. */
  account?: string
}

/** What an administrator sees: never a secret, only whether one is stored. */
export interface DestinationView {
  id: string
  name: string
  type: DestinationType
  config: Record<string, unknown>
  secrets: Record<string, boolean>
  /** The last four characters of an S3 access key id, to recognise it. */
  keyHint: string | null
  policy: DestinationPolicy
  status: DestinationStatus
  grants: Array<{ userId: string; username: string; level: GrantLevel }>
  usage: { copies: number; bytes: number }
  createdAt: number
  updatedAt: number
}

/** What a user with a grant sees (spec §4.3). */
export interface DestinationSummary {
  id: string
  name: string
  type: DestinationType
  level: GrantLevel | 'admin'
  policy: DestinationPolicy
  /**
   * Final review B34: how a copy sent here is verified — read back whole (a folder; WebDAV with
   * "verify by reading back"), by the provider's checksum (S3, Drive), or by its size (WebDAV).
   */
  verify?: 'readBack' | 'checksum' | 'size'
  /** Phase 3d-3c spec §1.4: Spaces Cold Storage bills 30 days per object, whatever retention says. */
  coldStorage?: boolean
}

export const GrantsSchema = z.strictObject({
  grants: z
    .array(z.strictObject({ userId: z.string().min(1).max(64), level: z.enum(GRANT_LEVELS) }))
    .max(500)
    .refine((g) => new Set(g.map((x) => x.userId)).size === g.length, 'A user is listed twice'),
})

export const SendRequestSchema = z.strictObject({
  destinationIds: z.array(z.string().uuid()).min(1).max(MAX_SEND_DESTINATIONS),
  deleteLocal: z.boolean().default(false),
})
export const FetchRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(64),
  key: z.string().min(1).max(1024),
})
/**
 * W4.5: a thaw of an archived copy (S3 GLACIER or DEEP_ARCHIVE) — a readable copy for `days`, at the
 * tier's speed: Expedited (minutes; not for DEEP_ARCHIVE), Standard (hours), Bulk (cheapest, longest).
 */
export const THAW_TIERS = ['Expedited', 'Standard', 'Bulk'] as const
export const ThawRequestSchema = z.strictObject({
  key: z.string().min(1).max(1024),
  days: z.number().int().min(1).max(30),
  tier: z.enum(THAW_TIERS),
})
export type ThawState = 'none' | 'thawing' | 'thawed'
/**
 * Final review B31: the client secret as typed, or — to reconnect a saved Drive — that destination,
 * whose stored secret the server uses (it never comes back to the browser). Exactly one of the two.
 */
export const DeviceFlowStartSchema = z
  .strictObject({
    clientId: z.string().regex(/^[A-Za-z0-9._-]{8,256}$/),
    clientSecret: Secret.optional(),
    destinationId: z.string().uuid().optional(),
  })
  .refine((b) => (b.clientSecret === undefined) !== (b.destinationId === undefined), {
    message: 'Give the client secret, or the destination whose stored secret is used',
    path: ['clientSecret'],
  })
export interface DeviceFlowView {
  flowId: string
  userCode: string
  verificationUrl: string
  expiresAt: number
  interval: number
}
export interface DevicePollView {
  state: 'pending' | 'approved' | 'denied' | 'expired'
  account?: string
}

export interface CopyView {
  id: string
  destinationId: string
  destinationName: string
  state: 'sending' | 'complete' | 'failed'
  sent: number
  size: number
  error: string | null
  /** Final review B32: why a copy failed, as a reason code (destinations.reason.*); null otherwise. */
  reason?: string | null
  completedAt: number | null
}

export interface RemoteBackup {
  key: string
  name: string
  size: number
  createdAt: number | null
  format: BackupFormat | null
  archived: boolean
  /** W4.5: an archived copy's thaw (null: not archived, or not known in this page). */
  thaw: ThawState | null
  /** complete: ours or with a manifest; incomplete: ours, still sending or failed; foreign: no record, no manifest. */
  state: 'complete' | 'incomplete' | 'foreign'
  copyId: string | null
  /** The sender's username, for copies this installation knows. */
  sender: string | null
  mine: boolean
  scope: BackupScope | null
  connectionId: string | null
  masked: boolean | null
  anonymous: boolean | null
}
export interface RemoteBackupPage {
  items: RemoteBackup[]
  cursor: string | null
}

/** Phase 3d-3b: a started fetch; a new fetch of a file whose download broke off resumes its upload. */
export interface FetchStartView {
  uploadId: string
  job: JobView
  /** False: a foreign file without a manifest, verified against nothing (spec §4.2 "says so"). */
  verified: boolean
}
