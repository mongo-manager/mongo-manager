import type {
  AiAgentTool,
  ConnectionColor,
  ConnectionSettings,
  CollectionOptions,
  CreateCollection,
  CreateDataKey,
  CreateEncryptedCollection,
  DataKeyInfo,
  EncryptedFieldInfo,
  EncryptionSummary,
  JobView,
  Permission,
  RewrapDataKeys,
  Role,
  UpdateView,
} from '@mongo-manager/shared'
import { api, path } from './client'

export interface ConnectionDto {
  id: string
  name: string
  group: string | null
  color: ConnectionColor | null
  favorite: boolean
  readOnly: boolean
  /** Phase 4a-1: the AI assistant on this connection. */
  aiPolicy: 'off' | 'local' | 'any'
  /** W6.3: the agentic assistant may propose changes here (each needs the person's click). */
  aiAgentWrites?: boolean
  /** Design 2026-10-25 (C5): the agent's tools an administrator turned off here. */
  aiAgentToolsOff?: AiAgentTool[]
  /** Stored settings with secrets replaced by SECRET_MASK. */
  settings: ConnectionSettings
  /** Connection string without credentials, for display. */
  uri: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  /** The caller's effective role on this connection. */
  access: Role
  /** What the caller may do on this connection (read-only aware). */
  permissions: Permission[]
  /** Phase 3a-1: whether the caller may open the advanced shell here. */
  shell?: boolean
  /** Phase 3b: whether personal values are hidden from the caller here. */
  restricted?: boolean
  /** User report 2026-10-30: MongoDB's users and roles kept from this caller (masked access). */
  accountsRestricted?: boolean
  /** Phase 3d-1: whether the caller may export files from this connection. */
  export?: boolean
}

export type ConnectionErrorKind =
  | 'auth'
  | 'network'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'ssh'
  | 'ssh-host-key'
  | 'dependency'
  | 'config'
  | 'busy'
  | 'unsupported'
  | 'oidc'
  | 'encryption'
  | 'closed'
  | 'unknown'

export type TestResult =
  | {
      ok: true
      latencyMs: number
      serverVersion: string
      topology: 'standalone' | 'replicaSet' | 'sharded' | 'loadBalanced'
      setName?: string
      sshFingerprint?: string
    }
  | {
      ok: false
      error: {
        kind: ConnectionErrorKind
        message: string
        sshFingerprint?: string
        issuer?: string
        /** A refusal the server keeps: nothing was dialled for this test. */
        remembered?: boolean
      }
    }

/** W7, W8: an optional package's state on this server (npm package only). */
export type ModuleStatus = 'available' | 'missing' | 'broken' | 'not_in_package'

/** W7, W8: what the connection form may offer on this server. */
export interface ConnectionCapabilities {
  mode: 'local' | 'team'
  distribution: 'npm' | 'standalone' | 'docker' | 'copy' | 'source'
  kerberos: { available: boolean; status: ModuleStatus; allowed: boolean; reason?: string }
  encryption: {
    available: boolean
    status: ModuleStatus
    reason?: string
    /** The operator set a crypt_shared library (MM_CRYPT_SHARED_LIB_PATH). */
    serverCryptShared: boolean
    /** A connection may name its own library (local mode only). */
    ownCryptSharedPath: boolean
  }
  oidc: { workloadIdentity: boolean; redirectUri: string; deviceFlow?: boolean }
}

/** W7: a person's OIDC sign-in on a connection (never a token). */
export interface OidcStatus {
  signIn: 'none' | 'workload' | 'person'
  signedIn: boolean
  issuer?: string
  expiresAt?: number | null
  device?: {
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
    expiresAt: number
    state: 'pending' | 'done' | 'denied' | 'expired' | 'failed'
    /** The identity provider the code is for (security review I5). */
    issuer?: string
  }
}
/** Security review I5: where the person signs in and where their token goes, shown before they go. */
export type OidcStart = { issuer: string; tokenHosts: string[] } & (
  { flow: 'code'; authorizeUrl: string } | { flow: 'device'; device: NonNullable<OidcStatus['device']> }
)
export interface OidcSession {
  userId: string
  username: string | null
  issuer: string
  updatedAt: number
  /** Security review I6: as whom they signed in at the identity provider. */
  signedInAs: string | null
  subject: string | null
}

export interface DatabaseInfo {
  name: string
  /** Null where personal data is hidden from you (its size would tell what is hidden). */
  sizeOnDisk: number | null
  empty: boolean
}
export interface DatabaseList {
  databases: DatabaseInfo[]
  /** Null when a database's size is hidden: the total would tell it. */
  totalSize: number | null
}
export interface CollectionInfo {
  name: string
  type: string
  options: Record<string, unknown>
  readOnly: boolean
}
export interface DatabaseStats {
  collections: number
  views: number
  objects: number
  /** The sizes are null where personal data is hidden from you in this database. */
  dataSize: number | null
  storageSize: number | null
  indexes: number
  indexSize: number | null
  sizesHidden?: true
}
export interface CollectionStats {
  count: number
  /** The sizes are null where personal data is hidden from you in this collection. */
  size: number | null
  storageSize: number | null
  avgObjSize: number | null
  totalIndexSize: number | null
  nindexes: number
  capped: boolean
  /** Bytes per index (phase 1i). */
  indexSizes?: Record<string, number>
  sizesHidden?: true
}
export interface ConnectionExport {
  format: 'mongo-manager-connections'
  version: 1
  exportedAt: string
  connections: unknown[]
}
export interface ConnectionInputBody {
  name: string
  aiPolicy?: 'off' | 'local' | 'any'
  aiAgentWrites?: boolean
  aiAgentToolsOff?: AiAgentTool[]
  group?: string
  color?: ConnectionColor
  favorite: boolean
  readOnly: boolean
  settings: Record<string, unknown>
}

/** Hierarchical keys: invalidating a prefix refreshes everything below it. */
export const queryKeys = {
  connections: ['connections'] as const,
  databases: (id: string) => ['connections', id, 'databases'] as const,
  databaseStats: (id: string, db: string) => ['connections', id, 'databases', db, 'stats'] as const,
  collections: (id: string, db: string) => ['connections', id, 'databases', db, 'collections'] as const,
  collectionStats: (id: string, db: string, coll: string) =>
    ['connections', id, 'databases', db, 'collections', coll, 'stats'] as const,
}

const conn = (id: string) => path`connections/${id}`
const dbPath = (id: string, db: string) => path`connections/${id}/databases/${db}`
const collPath = (id: string, db: string, coll: string) =>
  path`connections/${id}/databases/${db}/collections/${coll}`

export const connectionsApi = {
  list: () => api.get<ConnectionDto[]>('connections'),
  create: (input: ConnectionInputBody) => api.post<ConnectionDto>('connections', input),
  update: (id: string, patch: Record<string, unknown>) => api.patch<ConnectionDto>(conn(id), patch),
  remove: (id: string) => api.delete<void>(conn(id)),
  test: (settings: unknown, connectionId?: string) =>
    api.post<TestResult>('connections/test', { settings, ...(connectionId ? { connectionId } : {}) }),
  testSaved: (id: string) => api.post<TestResult>(`${conn(id)}/test`),
  parseUri: (uri: string) => api.post<{ settings: ConnectionSettings }>('connections/parse-uri', { uri }),
  exportAll: (includeSecrets: boolean, password?: string) =>
    api.post<ConnectionExport>('connections/export', { includeSecrets, ...(password ? { password } : {}) }),
  importAll: (file: unknown) =>
    api.post<{ created: number; libraryPathsDropped?: number; refusedOptionsDropped?: number }>(
      'connections/import',
      file,
    ),
  databases: (id: string) => api.get<DatabaseList>(`${conn(id)}/databases`),
  createDatabase: (id: string, name: string, collection: string) =>
    api.post<{ name: string }>(`${conn(id)}/databases`, { name, collection }),
  dropDatabase: (id: string, db: string) => api.delete<void>(dbPath(id, db), { confirm: db }),
  databaseStats: (id: string, db: string) => api.get<DatabaseStats>(`${dbPath(id, db)}/stats`),
  collections: (id: string, db: string) => api.get<CollectionInfo[]>(`${dbPath(id, db)}/collections`),
  createCollection: (id: string, db: string, body: CreateCollection) =>
    api.post<{ name: string }>(`${dbPath(id, db)}/collections`, body),
  dropCollection: (id: string, db: string, coll: string) =>
    api.delete<void>(collPath(id, db, coll), { confirm: coll }),
  /** Copies the documents into a new collection (indexes are not copied). */
  duplicateCollection: (id: string, db: string, coll: string, to: string) =>
    api.post<{ job: JobView }>(`${collPath(id, db, coll)}/duplicate`, { to }),
  renameCollection: (id: string, db: string, coll: string, to: string) =>
    api.post<{ name: string }>(`${collPath(id, db, coll)}/rename`, { to }),
  collectionStats: (id: string, db: string, coll: string) =>
    api.get<CollectionStats>(`${collPath(id, db, coll)}/stats`),
  /** W2.4: change-stream pre/post images on or off, the collection named to confirm. */
  setCollectionOptions: (id: string, db: string, coll: string, body: CollectionOptions) =>
    api.patch<{ changeStreamPreAndPostImages: boolean }>(`${collPath(id, db, coll)}/options`, body),
  /** Re-review (minor 3): a view's definition to edit, as stored (types kept). */
  viewDefinition: (id: string, db: string, coll: string) =>
    api.get<{ viewOn: string; pipeline: unknown[] }>(`${collPath(id, db, coll)}/view`),
  /** W2.2: a view's source and pipeline replaced, the view named to confirm. */
  updateView: (id: string, db: string, coll: string, body: UpdateView) =>
    api.put<{ name: string; viewOn: string }>(`${collPath(id, db, coll)}/view`, body),
  /** W7, W8: what the connection form may offer on this server. */
  capabilities: () => api.get<ConnectionCapabilities>('connections/capabilities'),
  /** W7: the caller's own OIDC sign-in on a connection. */
  oidcStatus: (id: string) => api.get<OidcStatus>(`${conn(id)}/oidc`),
  oidcStart: (id: string, flow: 'code' | 'device', returnTo?: string) =>
    api.post<OidcStart>(`${conn(id)}/oidc/start`, { flow, ...(returnTo ? { returnTo } : {}) }),
  oidcSignOut: (id: string) => api.delete<void>(`${conn(id)}/oidc`),
  oidcSessions: (id: string) => api.get<OidcSession[]>(`${conn(id)}/oidc/sessions`),
  oidcRevokeAll: (id: string) => api.delete<void>(`${conn(id)}/oidc/sessions`),
  /** W8: client-side encryption. */
  encryption: (id: string) => api.get<EncryptionSummary>(`${conn(id)}/encryption`),
  dataKeys: (id: string) => api.get<DataKeyInfo[]>(`${conn(id)}/encryption/keys`),
  createDataKey: (id: string, body: CreateDataKey) =>
    api.post<{ id: string }>(`${conn(id)}/encryption/keys`, body),
  rewrapDataKeys: (id: string, body: RewrapDataKeys) =>
    api.post<{ rewrapped: number }>(`${conn(id)}/encryption/keys/rewrap`, body),
  createEncryptedCollection: (id: string, db: string, body: CreateEncryptedCollection) =>
    api.post<{ name: string; fields: Array<{ path: string; keyId: string }> }>(
      `${dbPath(id, db)}/encrypted-collections`,
      body,
    ),
  encryptedFields: (id: string, db: string, coll: string) =>
    api.get<{ kind: 'queryable' | 'csfle' | null; fields: EncryptedFieldInfo[] }>(
      `${collPath(id, db, coll)}/encrypted-fields`,
    ),
}
