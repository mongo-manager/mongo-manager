import { computed, reactive, type InjectionKey } from 'vue'
import {
  HOST_FINGERPRINT,
  sasFields,
  type DestinationType,
  type DestinationView,
  type GrantLevel,
  type S3Preset,
} from '@mongo-manager/shared/browser'
import { S3_PRESET_INFO } from './presets'
import { serviceAccountEmail } from './serviceAccount'

export type Step = 'type' | 'provider' | 'connection' | 'access' | 'test'
export interface Draft {
  type: DestinationType
  name: string
  preset: string
  account: string
  config: Record<string, unknown>
  /** null: keep the stored value (an edit); a string: the value to send. */
  secrets: Record<string, string | null>
  policy: { encryptedOnly: boolean }
  deviceFlowId: string | null
  driveAccount: string | null
  grants: Array<{ userId: string; username: string; level: GrantLevel }>
}

const SECRETS: Record<DestinationType, string[]> = {
  folder: [],
  s3: ['accessKeyId', 'secretAccessKey'],
  webdav: ['password'],
  gdrive: ['clientSecret', 'serviceAccountKey'],
  gcs: ['serviceAccountKey'],
  azure: ['sasToken', 'accountKey'],
  sftp: ['password', 'privateKey', 'passphrase'],
}
/** What the stored secrets are bound to (the server's identityOf): a change asks for them again. */
const identity = (type: DestinationType, c: Record<string, unknown>) =>
  type === 'folder'
    ? `${c.path}`
    : type === 's3'
      ? `${c.endpoint}|${c.bucket}`
      : type === 'webdav'
        ? `${c.url}|${c.username}`
        : type === 'gcs'
          ? `${c.bucket}`
          : type === 'azure'
            ? `${c.endpoint ?? ''}|${c.account}|${c.container}|${c.auth}|${c.caPem ?? ''}`
            : type === 'sftp'
              ? `${c.host}|${c.port}|${c.username}|${c.auth}|${c.hostFingerprint ?? ''}`
              : `${c.auth}|${c.clientId ?? ''}|${c.sharedDriveId ?? ''}`

const fresh = (type: DestinationType): Record<string, unknown> =>
  type === 's3'
    ? {
        preset: 'aws',
        endpoint: S3_PRESET_INFO.aws.endpoint('us-east-1', ''),
        region: 'us-east-1',
        bucket: '',
        prefix: '',
        pathStyle: false,
        storageClass: 'STANDARD',
        sse: { kind: 'none' },
      }
    : type === 'webdav'
      ? { preset: 'nextcloud', url: '', folder: 'Backups', username: '', verifyReadBack: false }
      : type === 'gdrive'
        ? { auth: 'oauth', folderName: 'Mongo Manager backups', clientId: '' }
        : type === 'gcs'
          ? { bucket: '', prefix: '', storageClass: 'STANDARD' }
          : type === 'azure'
            ? { account: '', container: '', prefix: '', auth: 'sas', accessTier: 'default' }
            : type === 'sftp'
              ? { host: '', port: 22, username: '', folder: '', auth: 'password', verifyReadBack: true }
              : { path: '' }

/**
 * Phase 3d-3b final review: R2's account id is not stored on its own; it is the first label of the
 * stored endpoint (https://<account>.r2.cloudflarestorage.com), so an edit can rebuild the endpoint.
 */
const accountOf = (existing?: DestinationView): string => {
  if (existing?.type !== 's3' || existing.config.preset !== 'r2') return ''
  return (
    /^https:\/\/([a-z0-9-]+)\.r2\.cloudflarestorage\.com\/?$/i.exec(String(existing.config.endpoint))?.[1] ??
    ''
  )
}

/** D2: the editor's state, what it sends on save, and whether each step is complete. */
export function useDestinationDraft(existing?: DestinationView) {
  const draft = reactive<Draft>({
    type: existing?.type ?? 's3',
    name: existing?.name ?? '',
    preset: String(existing?.config.preset ?? (existing?.type === 'webdav' ? 'nextcloud' : 'aws')),
    account: accountOf(existing),
    config: existing ? { ...existing.config } : fresh('s3'),
    secrets: Object.fromEntries(
      (existing ? SECRETS[existing.type] : []).map((k) => [k, existing?.secrets[k] ? null : '']),
    ),
    policy: { ...(existing?.policy ?? { encryptedOnly: true }) },
    deviceFlowId: null,
    driveAccount: existing?.status.account ?? null,
    grants: existing ? existing.grants.map((g) => ({ ...g })) : [],
  })
  function setType(type: DestinationType) {
    draft.type = type
    draft.config = fresh(type)
    draft.secrets = Object.fromEntries(SECRETS[type].map((k) => [k, '']))
    draft.preset = String(draft.config.preset ?? '')
  }
  function setPreset(preset: S3Preset) {
    draft.preset = preset
    const info = S3_PRESET_INFO[preset]
    draft.config = {
      ...draft.config,
      preset,
      region: info.region,
      pathStyle: info.pathStyle,
      endpoint: info.endpoint(info.region, draft.account),
    }
  }
  const identityChanged = computed(
    () =>
      Boolean(existing) && identity(draft.type, draft.config) !== identity(existing!.type, existing!.config),
  )
  const relevantSecrets = computed(() =>
    draft.type === 'gdrive'
      ? draft.config.auth === 'oauth'
        ? []
        : ['serviceAccountKey']
      : draft.type === 'azure'
        ? [draft.config.auth === 'sharedKey' ? 'accountKey' : 'sasToken']
        : draft.type === 'sftp'
          ? [draft.config.auth === 'privateKey' ? 'privateKey' : 'password']
          : SECRETS[draft.type],
  )
  const secretsToSend = computed(() => {
    // W4.5: Azure and SFTP are sent only the credentials their way of signing in uses.
    const sent =
      draft.type === 'azure' || draft.type === 'sftp'
        ? [...relevantSecrets.value, ...(draft.config.auth === 'privateKey' ? ['passphrase'] : [])]
        : null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(draft.secrets)) if (v && (!sent || sent.includes(k))) out[k] = v
    return out
  })
  const secretsReady = computed(() =>
    relevantSecrets.value.every((k) =>
      identityChanged.value || !existing ? Boolean(draft.secrets[k]) : draft.secrets[k] !== '',
    ),
  )
  const connectionReady = computed(() => {
    const c = draft.config
    if (!draft.name.trim()) return false
    if (draft.type === 'folder') return String(c.path ?? '').trim().length > 0
    if (draft.type === 's3')
      return (
        /^https?:\/\//.test(String(c.endpoint)) &&
        /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(c.bucket)) &&
        secretsReady.value
      )
    if (draft.type === 'webdav')
      return /^https?:\/\//.test(String(c.url)) && String(c.username).length > 0 && secretsReady.value
    if (draft.type === 'gcs')
      return (
        /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(String(c.bucket)) &&
        secretsReady.value &&
        // A key typed now must be a service account's (a stored one stays as it is).
        (draft.secrets.serviceAccountKey === null ||
          serviceAccountEmail(String(draft.secrets.serviceAccountKey)) !== null)
      )
    if (draft.type === 'azure')
      return (
        /^[a-z0-9]{3,24}$/.test(String(c.account)) &&
        /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(String(c.container)) &&
        (!c.endpoint || /^https:\/\//i.test(String(c.endpoint))) &&
        secretsReady.value &&
        (draft.config.auth !== 'sas' || !draft.secrets.sasToken || sasFields(draft.secrets.sasToken) !== null)
      )
    if (draft.type === 'sftp') {
      const port = Number(c.port)
      // The host key is not asked for here: the test shows the server's, to be compared and trusted.
      return (
        String(c.host ?? '').trim().length > 0 &&
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65_535 &&
        String(c.username ?? '').trim().length > 0 &&
        (!c.hostFingerprint || HOST_FINGERPRINT.test(String(c.hostFingerprint))) &&
        secretsReady.value
      )
    }
    return c.auth === 'oauth'
      ? Boolean(draft.deviceFlowId || (existing && !identityChanged.value))
      : Boolean(c.sharedDriveId) && secretsReady.value
  })
  /** What the server is given: Drive's fields of the other sign-in kind, and empty ids, are left out. */
  const sentConfig = computed(() => {
    if (draft.type === 'azure') {
      // An endpoint left empty is Azure's public one: not sent.
      const { endpoint, ...rest } = draft.config as Record<string, unknown>
      return { ...rest, ...(endpoint ? { endpoint } : {}) }
    }
    if (draft.type === 'sftp') {
      // No host key until one is trusted; the port is a number.
      const { hostFingerprint, ...rest } = draft.config as Record<string, unknown>
      return { ...rest, port: Number(rest.port), ...(hostFingerprint ? { hostFingerprint } : {}) }
    }
    if (draft.type !== 'gdrive') return draft.config
    const { clientId, sharedDriveId, ...rest } = draft.config as Record<string, unknown>
    const oauth = rest.auth === 'oauth'
    return {
      ...rest,
      ...(oauth && clientId ? { clientId } : {}),
      ...(!oauth && sharedDriveId ? { sharedDriveId } : {}),
    }
  })
  const body = computed(() => ({
    type: draft.type,
    name: draft.name.trim(),
    config: sentConfig.value,
    ...(Object.keys(secretsToSend.value).length ? { secrets: secretsToSend.value } : {}),
    policy: draft.policy,
    ...(draft.deviceFlowId ? { deviceFlowId: draft.deviceFlowId } : {}),
  }))
  /**
   * A PATCH keeps every config field it does not name (B's contract): an optional field the user
   * cleared is sent as null so the server removes it — the CA certificate, a KMS key id.
   */
  const patchConfig = computed(() => {
    const out: Record<string, unknown> = { ...sentConfig.value }
    const before = existing?.config ?? {}
    if (before.caPem && !out.caPem) out.caPem = null
    if (before.endpoint && !out.endpoint && draft.type === 'azure') out.endpoint = null
    if (before.hostFingerprint && !out.hostFingerprint && draft.type === 'sftp') out.hostFingerprint = null
    const sse = out.sse as { kind?: string; keyId?: string } | undefined
    if ((before.sse as { keyId?: string } | undefined)?.keyId && sse?.kind === 'aws:kms' && !sse.keyId)
      out.sse = { ...sse, keyId: null }
    return out
  })
  const patch = computed(() => ({
    name: draft.name.trim(),
    config: patchConfig.value,
    ...(Object.keys(secretsToSend.value).length ? { secrets: secretsToSend.value } : {}),
    policy: draft.policy,
    ...(draft.deviceFlowId ? { deviceFlowId: draft.deviceFlowId } : {}),
  }))
  /** What a connection test depends on: name, access and policy do not change how it connects. */
  const connectionKey = () => JSON.stringify([draft.config, draft.secrets, draft.deviceFlowId, draft.account])
  const openedConnection = connectionKey()
  const connectionChanged = computed(() => connectionKey() !== openedConnection)
  return {
    draft,
    setType,
    setPreset,
    body,
    patch,
    identityChanged,
    connectionReady,
    connectionKey,
    connectionChanged,
  }
}

export const DRAFT_KEY: InjectionKey<ReturnType<typeof useDestinationDraft>> = Symbol('destination-draft')
