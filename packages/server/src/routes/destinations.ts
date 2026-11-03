import type { FastifyInstance } from 'fastify'
import { removeRemoteCopy } from '../backup/destinations/remove'
import { z } from 'zod'
import {
  DestinationInputSchema,
  DestinationPatchSchema,
  DeviceFlowStartSchema,
  FetchRequestSchema,
  ThawRequestSchema,
  FolderConfigSchema,
  AzureConfigSchema,
  AzureSecretsSchema,
  GcsConfigSchema,
  GcsSecretsSchema,
  GdriveConfigSchema,
  GdriveSecretsSchema,
  GrantsSchema,
  S3ConfigSchema,
  S3SecretsSchema,
  SftpConfigSchema,
  SftpSecretsSchema,
  WebdavConfigSchema,
  WebdavSecretsSchema,
  permissionsFor,
  type DestinationSummary,
  type DestinationType,
  type DestinationView,
  type DeviceFlowView,
  type DevicePollView,
  type FetchStartView,
  type GrantLevel,
  type RemoteBackup,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth, requirePermission } from '../http/guards'
import type { Principal, ServerContext } from '../http/context'
import { resolveFolder } from '../backup/destinations/folder'
import { parseServiceAccountKey, pollDeviceFlow, startDeviceFlow } from '../backup/destinations/google-auth'
import { adapterFor, layoutPrefix, registryDeps, testDestination } from '../backup/destinations/registry'
import {
  identityOf,
  requiredSecrets,
  type CopyRecord,
  type DestinationRecord,
} from '../backup/destinations/repo'
import {
  MANIFEST_LIMIT,
  decodeCursor,
  encodeCursor,
  formatOfKey,
  isSafeKey,
  manifestKeyOf,
  nameOfKey,
  parseManifest,
} from '../backup/destinations/layout'
import { mapLimited } from '../backup/concurrency'
import { assertBackupRoom } from '../backup/room'
import { assertEncryptedWriteAllowed, effectiveRole } from '../connections/access'
import {
  DestinationError,
  toDestinationError,
  type DestinationAdapter,
  type RemoteItem,
} from '../backup/destinations/types'
import { EgressError } from '../net/egress'
import { XmlError } from '../net/xml'
import { assertBackupAccess } from '../backup/access'
import { noteJob, startSend } from '../backup/send-job'
import { toView } from '../jobs/visibility'
import { ownerOf } from '../transfer/files'

const IdParams = z.object({ id: z.string().uuid() })
const FlowParams = z.object({ flowId: z.string().uuid() })
const CONFIG = {
  folder: FolderConfigSchema,
  s3: S3ConfigSchema,
  webdav: WebdavConfigSchema,
  gdrive: GdriveConfigSchema,
  gcs: GcsConfigSchema,
  azure: AzureConfigSchema,
  sftp: SftpConfigSchema,
} as const
/** Secret fields a client may set, per type (refreshToken comes only from a device flow). */
const SETTABLE: Record<DestinationType, string[]> = {
  folder: [],
  s3: ['accessKeyId', 'secretAccessKey'],
  webdav: ['password'],
  gdrive: ['clientSecret', 'serviceAccountKey'],
  gcs: ['serviceAccountKey'],
  azure: ['sasToken', 'accountKey'],
  sftp: ['password', 'privateKey', 'passphrase'],
}

/** Final review B20: a patch's secrets pass their type's own checks (formats, lengths). */
const SECRETS = {
  folder: z.strictObject({}),
  s3: S3SecretsSchema.partial(),
  webdav: WebdavSecretsSchema.partial(),
  gdrive: GdriveSecretsSchema,
  gcs: GcsSecretsSchema.partial(),
  azure: AzureSecretsSchema,
  sftp: SftpSecretsSchema,
} as const
/** Final review B23: manifests read for one page of a listing (Cold Storage bills every GET). */
export const MANIFEST_READS_PER_PAGE = 100
/** W4.5: archived copies whose thaw is read (a HEAD each) for one page of a listing. */
export const THAW_STATS_PER_PAGE = 20

const adminId = (p: Principal) => p.userId

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Final review B10: a patch over the stored config. A field left out keeps its value; one sent as
 * null is removed (an optional field such as caPem, or sse.keyId inside the object sent).
 */
export function mergeConfig(
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const strip = (v: unknown): unknown =>
    isPlain(v)
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== null)
            .map(([k, x]) => [k, strip(x)]),
        )
      : v
  const out: Record<string, unknown> = { ...stored }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else out[k] = strip(v)
  }
  return out
}

/**
 * Final review B7: where a destination's files are; copies made anywhere else are not there. (Not
 * identityOf: a new CA certificate needs the credentials again, but moves no file.)
 */
function locationOf(type: DestinationType, c: Record<string, unknown>): string {
  const parts =
    type === 'folder'
      ? [c.path]
      : type === 's3'
        ? [c.endpoint, c.bucket, c.prefix ?? '']
        : type === 'webdav'
          ? [c.url, c.username, c.folder ?? '']
          : type === 'gcs'
            ? [c.bucket, c.prefix ?? '']
            : type === 'azure'
              ? [c.endpoint ?? '', c.account, c.container, c.prefix ?? '']
              : type === 'sftp'
                ? [c.host, c.port ?? 22, c.username, c.folder ?? '']
                : [c.auth, c.clientId ?? '', c.sharedDriveId ?? '', c.folderName ?? '']
  return JSON.stringify([type, ...parts.map(String)])
}

/** A config as the client may send it: validated by its type's schema; DestinationErrors become 400. */
function parseConfig(type: DestinationType, raw: unknown): Record<string, unknown> {
  const r = CONFIG[type].safeParse(raw)
  if (!r.success)
    throw Errors.validation('The destination’s settings are not valid', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  return r.data as Record<string, unknown>
}

/** A destination's refusal, or a connection that failed on the way to it, says why (never a bare 500). */
function asHttp(e: unknown): never {
  if (e instanceof DestinationError || e instanceof EgressError || e instanceof XmlError) {
    const d = toDestinationError(e instanceof XmlError ? new DestinationError('provider', e.message) : e)
    // Short names reviews 6 and 7 (I-1): a refused folder name, and which folder refusal, go with
    // it, for the editor to say and to give the fix that fits.
    throw Errors.validation(d.message, {
      reason: d.reason,
      ...(d.extra.name ? { name: d.extra.name } : {}),
      ...(d.extra.why ? { why: d.extra.why } : {}),
    })
  }
  throw e
}

export function toDestinationView(ctx: ServerContext, r: DestinationRecord): DestinationView {
  const secrets: Record<string, boolean> = {}
  for (const f of [
    ...SETTABLE[r.type],
    ...(r.type === 'gdrive' && r.config.auth === 'oauth' ? ['refreshToken'] : []),
  ])
    secrets[f] = r.secretFields.includes(f)
  let keyHint: string | null = null
  if (r.type === 's3' && r.secretFields.includes('accessKeyId'))
    keyHint = ctx.backup.destinations.secrets(r.id).accessKeyId!.slice(-4)
  const { folderId: _f, ...status } = r.status
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    // Plan ruling 10: nothing server-managed lives in the config (Drive's folder id is in the status).
    config: r.config,
    secrets,
    keyHint,
    policy: r.policy,
    status,
    grants: ctx.backup.destinations.grants(r.id),
    usage: ctx.backup.destinations.usage(r.id),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/**
 * Final review B34: how the send job verifies a copy there — a folder and a WebDAV share with
 * "verify by reading back" read it back whole; S3 and Drive compare the provider's checksums; a
 * WebDAV share otherwise compares the size.
 */
export function verifyOf(r: DestinationRecord): NonNullable<DestinationSummary['verify']> {
  if (r.type === 'folder') return 'readBack'
  if (r.type === 'webdav') return r.config.verifyReadBack === true ? 'readBack' : 'size'
  // W4.5: SFTP keeps no checksum; reading back is on unless the administrator turned it off.
  if (r.type === 'sftp') return r.config.verifyReadBack === false ? 'size' : 'readBack'
  // W4 review I3: Azure checks each block's MD5 as it arrives, but keeps none of a large blob whole:
  // the copy as a whole is compared by its size (a small one is checked whole; the larger case speaks).
  if (r.type === 'azure') return 'size'
  return 'checksum'
}

/** 404 when the caller has no access: a destination's existence is not revealed (spec §4.3). */
export function requireLevel(ctx: ServerContext, principal: Principal, id: string): GrantLevel | 'admin' {
  const level = ctx.backup.destinations.levelOf(id, principal)
  if (!level) throw Errors.notFound('Destination not found')
  return level
}

/** D10: cancels running send and fetch jobs that match. */
export async function cancelTransfers(
  ctx: ServerContext,
  match: (t: { userId: string | null; destinationIds: string[] }) => boolean,
): Promise<void> {
  await Promise.all(
    [...ctx.backup.transfers]
      .filter(([, t]) => match(t))
      .map(([jobId]) => ctx.jobs.cancel(jobId).catch(() => undefined)),
  )
}

export async function destinationRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const admin = requirePermission('settings:manage')
  const repo = () => ctx.backup.destinations
  // Someone waits on every call made here: no retries (the background jobs keep the full policy).
  const interactive = () => ({ ...registryDeps(ctx), retries: 0 })

  /** Secrets from a request, normalised: a service-account key keeps only its four fields. */
  function cleanSecrets(
    type: DestinationType,
    raw: Record<string, string> | undefined,
  ): Record<string, string> {
    const out: Record<string, string> = {}
    for (const k of Object.keys(raw ?? {}))
      if (!SETTABLE[type].includes(k))
        throw Errors.validation(`"${k}" is not a credential of this destination`)
    const checked = SECRETS[type].safeParse(raw ?? {})
    if (!checked.success)
      // The issues name the field and the rule, never the value.
      throw Errors.validation('A credential is not valid', {
        reason: 'secrets_invalid',
        issues: checked.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    for (const [k, v] of Object.entries(raw ?? {})) {
      // The kept fields plus their type, so the stored key reads back as a service account key.
      try {
        out[k] =
          k === 'serviceAccountKey'
            ? JSON.stringify({ type: 'service_account', ...parseServiceAccountKey(v) })
            : v
      } catch (e) {
        asHttp(e)
      }
    }
    return out
  }

  /**
   * Final review B16: an approved Drive sign-in for this client, looked at but not used up — it is
   * taken only once everything else passed and the destination is saved.
   */
  function approvedFlow(principal: Principal, flowId: string, clientId: string) {
    const flow = ctx.backup.deviceFlows.get(adminId(principal), flowId)
    if (!flow || flow.state !== 'approved' || !flow.refreshToken)
      throw Errors.validation('Connect the Google account first: the sign-in is not approved', {
        reason: 'device_flow_not_approved',
      })
    if (flow.clientId !== clientId)
      throw Errors.validation('The client id differs from the one that was connected', {
        reason: 'device_flow_client',
      })
    return flow
  }

  function checkFolder(type: DestinationType, config: Record<string, unknown>) {
    if (type !== 'folder') return
    try {
      resolveFolder(String(config.path), ctx.backup.limits.folderRoots, ctx.config.dataDir)
    } catch (e) {
      asHttp(e)
    }
  }

  app.get(
    '/backup-destinations',
    { preHandler: requireAuth },
    async (request): Promise<DestinationSummary[]> =>
      repo()
        .list()
        .flatMap((r) => {
          const level = repo().levelOf(r.id, request.principal!)
          return level
            ? [
                {
                  id: r.id,
                  name: r.name,
                  type: r.type,
                  level,
                  policy: r.policy,
                  verify: verifyOf(r),
                  // Phase 3d-3c spec §1.4: the schedule editor's Cold Storage warning.
                  coldStorage: r.type === 's3' && r.config.preset === 'spacesCold',
                },
              ]
            : []
        }),
  )

  app.get('/backup-destinations/all', { preHandler: admin }, async () =>
    repo()
      .list()
      .map((r) => toDestinationView(ctx, r)),
  )

  app.post(
    '/backup-destinations',
    { preHandler: admin, config: { audit: 'backup.destination.create' } },
    async (request, reply) => {
      const body = parseInput(DestinationInputSchema, request.body)
      const config = parseConfig(body.type, body.config)
      checkFolder(body.type, config)
      const secrets = cleanSecrets(body.type, body.secrets as Record<string, string> | undefined)
      let account: string | undefined
      let flowId: string | undefined
      if (body.type === 'gdrive' && config.auth === 'oauth') {
        if (!body.deviceFlowId)
          throw Errors.validation('Connect the Google account first', { reason: 'device_flow_not_approved' })
        const flow = approvedFlow(request.principal!, body.deviceFlowId, String(config.clientId))
        secrets.clientSecret = flow.clientSecret
        secrets.refreshToken = flow.refreshToken!
        account = flow.account
        flowId = flow.id
      }
      const record = repo().create({
        name: body.name,
        type: body.type,
        config,
        secrets,
        policy: body.policy,
        createdBy: request.principal!.kind === 'user' ? request.principal!.userId : null,
      })
      // Final review B16: the sign-in is used up only now that the destination is saved.
      if (flowId) ctx.backup.deviceFlows.take(adminId(request.principal!), flowId, String(config.clientId))
      if (account) repo().setStatus(record.id, { ...record.status, account })
      request.auditInfo = {
        details: {
          destination: record.id,
          name: record.name,
          type: record.type,
          encryptedOnly: record.policy.encryptedOnly,
        },
      }
      if (!record.policy.encryptedOnly) auditPolicy(request.principal!, request.ip, record.id, false)
      return reply.status(201).send(toDestinationView(ctx, repo().get(record.id)!))
    },
  )

  function auditPolicy(p: Principal, ip: string, id: string, encryptedOnly: boolean) {
    ctx.audit.append({
      action: 'backup.destination.policy',
      outcome: 'success',
      userId: p.kind === 'user' ? p.userId : null,
      username: null,
      ip,
      connectionId: null,
      namespace: null,
      details: { destination: id, encryptedOnly },
    })
  }

  app.patch(
    '/backup-destinations/:id',
    { preHandler: admin, config: { audit: 'backup.destination.update' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const body = parseInput(DestinationPatchSchema, request.body)
      const record = repo().get(id)
      if (!record) throw Errors.notFound('Destination not found')
      const config = body.config
        ? parseConfig(record.type, mergeConfig(record.config, body.config))
        : undefined
      if (config) checkFolder(record.type, config)
      const secrets = cleanSecrets(record.type, body.secrets)
      let account: string | undefined
      let flowId: string | undefined
      const clientId = String((config ?? record.config).clientId)
      if (body.deviceFlowId && record.type === 'gdrive') {
        // Final gate: the sign-in must be for the client this destination keeps (or is given now).
        const flow = approvedFlow(request.principal!, body.deviceFlowId, clientId)
        secrets.clientSecret = flow.clientSecret
        secrets.refreshToken = flow.refreshToken!
        account = flow.account
        flowId = flow.id
      }
      // Another Google account is another Drive: the copies of the previous one are not in it.
      const relocated =
        (config !== undefined &&
          locationOf(record.type, record.config) !== locationOf(record.type, config)) ||
        (flowId !== undefined && account !== record.status.account)
      const oldSecrets = relocated ? repo().secrets(id) : {}
      const { record: after, identityChanged } = repo().update(id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(config ? { config } : {}),
        ...(Object.keys(secrets).length ? { secrets } : {}),
        ...(body.policy ? { policy: body.policy } : {}),
      })
      // Final review B16: the sign-in is used up only now that the change is saved.
      if (flowId) ctx.backup.deviceFlows.take(adminId(request.principal!), flowId, clientId)
      if (account) repo().setStatus(id, { state: 'unknown', checkedAt: null, account })
      for (const k of ctx.backup.tokens.keys()) if (k.startsWith(`${id}|`)) ctx.backup.tokens.delete(k)
      let forgotten = 0
      if (relocated) {
        // Final review B7: the destination now points elsewhere and its copies are not there. Sends
        // to it stop, their unfinished uploads are abandoned where they were (best effort), and the
        // copies are forgotten, so nothing trusts, deletes a local copy for, or retries them.
        await cancelTransfers(ctx, (t) => t.destinationIds.includes(id))
        const unfinished = ctx.backup.copies.byDestination(id).filter((c) => c.state !== 'complete')
        if (unfinished.length)
          try {
            const adapter = adapterFor(record, oldSecrets, interactive())
            for (const c of unfinished) {
              const resume = ctx.backup.copies.resume(c.id)
              if (resume) await adapter.abandon(resume, AbortSignal.timeout(15_000)).catch(() => undefined)
            }
          } catch {
            // Without working credentials nothing can be abandoned; the provider's own expiry applies.
          }
        forgotten = ctx.backup.copies.forgetDestination(id)
        // Drive keeps its folder's id in the status: another folder name is another folder.
        const { folderId, ...status } = repo().get(id)!.status
        if (folderId) repo().setStatus(id, status)
      }
      if (body.policy && body.policy.encryptedOnly !== record.policy.encryptedOnly) {
        auditPolicy(request.principal!, request.ip, id, body.policy.encryptedOnly)
        // Final review B21: a plain send under way there stops (its other destinations go on).
        if (body.policy.encryptedOnly)
          for (const t of ctx.backup.transfers.values())
            if (t.kind === 'send' && t.plain && t.destinationIds.includes(id))
              t.stop?.(id, `${after.name} accepts encrypted backups only`, 'destination_encrypted_only')
      }
      request.auditInfo = {
        details: { destination: id, fields: Object.keys(body), identityChanged, relocated, forgotten },
      }
      return toDestinationView(ctx, repo().get(after.id)!)
    },
  )

  app.delete(
    '/backup-destinations/:id',
    { preHandler: admin, config: { audit: 'backup.destination.delete' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      const record = repo().get(id)
      if (!record) throw Errors.notFound('Destination not found')
      // Short names review 15 (M1): its own copies are said as deleted, before the job is stopped
      // (the stop wins over the cancellation; the send's other destinations read as cancelled).
      for (const t of ctx.backup.transfers.values())
        if (t.destinationIds.includes(id)) t.stop?.(id, 'The destination was deleted', 'destination_deleted')
      await cancelTransfers(ctx, (t) => t.destinationIds.includes(id))
      // Unfinished provider-side uploads are abandoned; complete remote files stay (the UI says so).
      const unfinished = ctx.backup.copies.byDestination(id).filter((c) => c.state !== 'complete')
      if (unfinished.length) {
        try {
          const adapter = adapterFor(record, repo().secrets(id), interactive())
          for (const c of unfinished) {
            const resume = ctx.backup.copies.resume(c.id)
            if (resume) await adapter.abandon(resume, AbortSignal.timeout(15_000)).catch(() => undefined)
          }
        } catch {
          // Without working credentials nothing can be abandoned; the provider's own expiry applies.
        }
      }
      repo().remove(id)
      for (const k of ctx.backup.tokens.keys()) if (k.startsWith(`${id}|`)) ctx.backup.tokens.delete(k)
      request.auditInfo = { details: { destination: id, name: record.name, type: record.type } }
      return reply.status(204).send()
    },
  )

  async function runTest(
    request: import('fastify').FastifyRequest,
    record: DestinationRecord,
    secrets: Record<string, string>,
    /** A draft runs with tokens and a status of its own: nothing of a saved destination is used or saved. */
    draft = false,
  ) {
    const leave = ctx.backup.destTests.enter(`test:${adminId(request.principal!)}`)
    try {
      const ctl = new AbortController()
      request.raw.once('close', () => ctl.abort())
      const adapter = (() => {
        try {
          return adapterFor(
            record,
            secrets,
            draft ? { ...interactive(), tokens: new Map(), saveStatus: () => undefined } : interactive(),
          )
        } catch (e) {
          return asHttp(e)
        }
      })()
      return await testDestination(
        adapter,
        layoutPrefix(record),
        { egress: ctx.backup.egress, now: ctx.now },
        AbortSignal.any([ctl.signal, AbortSignal.timeout(120_000)]),
      )
    } finally {
      leave()
    }
  }

  app.post(
    '/backup-destinations/test',
    { preHandler: admin, config: { audit: 'backup.destination.test' } },
    async (request) => {
      const body = parseInput(DestinationInputSchema, request.body)
      const config = parseConfig(body.type, body.config)
      checkFolder(body.type, config)
      const secrets = cleanSecrets(body.type, body.secrets as Record<string, string> | undefined)
      if (body.type === 'gdrive' && config.auth === 'oauth') {
        const flow = body.deviceFlowId
          ? ctx.backup.deviceFlows.get(adminId(request.principal!), body.deviceFlowId)
          : undefined
        if (!flow?.refreshToken)
          throw Errors.validation('Connect the Google account first', { reason: 'device_flow_not_approved' })
        secrets.clientSecret = flow.clientSecret
        secrets.refreshToken = flow.refreshToken
      }
      const draft: DestinationRecord = {
        id: '00000000-0000-4000-8000-000000000000',
        name: body.name,
        type: body.type,
        config,
        policy: body.policy,
        status: { state: 'unknown', checkedAt: null },
        createdBy: null,
        createdAt: 0,
        updatedAt: ctx.now(),
        secretFields: Object.keys(secrets),
      }
      const out = await runTest(request, draft, secrets, true)
      request.auditInfo = { details: { type: body.type, ok: out.steps.every((s) => s.ok) } }
      return out
    },
  )

  app.post(
    '/backup-destinations/:id/test',
    { preHandler: admin, config: { audit: 'backup.destination.test' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      // Cross-area contract: an optional body, the editor's unsaved patch, tested over the saved one.
      const body =
        request.body === undefined || request.body === null
          ? {}
          : parseInput(DestinationPatchSchema, request.body)
      const record = repo().get(id)
      if (!record) throw Errors.notFound('Destination not found')
      if (Object.keys(body).length) {
        const config = body.config
          ? parseConfig(record.type, mergeConfig(record.config, body.config))
          : record.config
        checkFolder(record.type, config)
        const given = cleanSecrets(record.type, body.secrets)
        if (body.deviceFlowId && record.type === 'gdrive') {
          const flow = approvedFlow(request.principal!, body.deviceFlowId, String(config.clientId))
          given.clientSecret = flow.clientSecret
          given.refreshToken = flow.refreshToken!
        }
        // Plan ruling 9: the stored secrets never go to another address, not even for a test.
        let secrets: Record<string, string>
        if (identityOf(record.type, record.config) !== identityOf(record.type, config)) {
          if (requiredSecrets(record.type, config).some((k) => !given[k]))
            throw Errors.validation('Enter the credentials again: they belong to the previous address', {
              reason: 'secrets_required',
            })
          secrets = given
        } else secrets = { ...repo().secrets(id), ...given }
        // Drive's folder id belongs to the saved folder name.
        const { folderId: _f, ...unplaced } = record.status
        const moved = locationOf(record.type, record.config) !== locationOf(record.type, config)
        const out = await runTest(
          request,
          { ...record, config, status: moved ? unplaced : record.status, secretFields: Object.keys(secrets) },
          secrets,
          true,
        )
        // Nothing is saved, not even the status: the draft is not the destination.
        request.auditInfo = {
          details: {
            destination: id,
            draft: true,
            ok: out.steps.every((s) => s.ok || s.reason === 'skipped'),
          },
        }
        return out
      }
      const out = await runTest(request, record, repo().secrets(id))
      const failed = out.steps.find((s) => !s.ok && s.reason !== 'skipped')
      // Final review B15: a passed test leaves no earlier failure's reason behind.
      // Short names review 8 (M-6): which folder refusal and the name refused are kept with the
      // reason, for the card to say; none of an earlier failure's is left behind.
      const { reason: _reason, why: _why, name: _name, ...status } = repo().get(id)!.status
      repo().setStatus(id, {
        ...status,
        state: failed ? (failed.reason === 'reconnect' ? 'reconnect' : 'failed') : 'ok',
        checkedAt: ctx.now(),
        ...(failed?.reason ? { reason: failed.reason } : {}),
        ...(failed?.why ? { why: failed.why } : {}),
        ...(failed?.name ? { name: failed.name } : {}),
        ...(out.account ? { account: out.account } : {}),
      })
      request.auditInfo = { details: { destination: id, ok: !failed } }
      return out
    },
  )

  app.put(
    '/backup-destinations/:id/grants',
    { preHandler: admin, config: { audit: 'backup.destination.grants' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const { grants } = parseInput(GrantsSchema, request.body)
      if (!repo().get(id)) throw Errors.notFound('Destination not found')
      for (const g of grants)
        if (!ctx.users.findById(g.userId)) throw Errors.validation('Unknown user', { reason: 'unknown_user' })
      const { lost } = repo().setGrants(id, grants)
      await cancelTransfers(
        ctx,
        (t) => t.userId !== null && lost.includes(t.userId) && t.destinationIds.includes(id),
      )
      request.auditInfo = { details: { destination: id, grants: grants.length, lost: lost.length } }
      return repo().grants(id)
    },
  )

  app.post(
    '/backup-destinations/google/device',
    { preHandler: admin },
    async (request): Promise<DeviceFlowView> => {
      const body = parseInput(DeviceFlowStartSchema, request.body)
      // Final review B31: a saved Drive is reconnected with its stored secret, which never leaves
      // the server — and only for the client id it was stored with.
      let clientSecret = body.clientSecret
      if (body.destinationId !== undefined) {
        const saved = repo().get(body.destinationId)
        if (!saved || saved.type !== 'gdrive') throw Errors.notFound('Destination not found')
        const stored = repo().secrets(saved.id).clientSecret
        if (saved.config.clientId !== body.clientId || !stored)
          throw Errors.validation('Enter the client secret: none is stored for this client id', {
            reason: 'secrets_required',
          })
        clientSecret = stored
      }
      const started = await startDeviceFlow(
        ctx.backup.egress,
        ctx.backup.googleHosts,
        body.clientId,
        AbortSignal.timeout(30_000),
      ).catch(asHttp)
      const flow = ctx.backup.deviceFlows.add(adminId(request.principal!), {
        clientId: body.clientId,
        clientSecret: clientSecret!,
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUrl: started.verificationUrl,
        expiresAt: ctx.now() + started.expiresIn * 1000,
        interval: started.interval,
      })
      return {
        flowId: flow.id,
        userCode: flow.userCode,
        verificationUrl: flow.verificationUrl,
        expiresAt: flow.expiresAt,
        interval: flow.interval,
      }
    },
  )

  app.get(
    '/backup-destinations/google/device/:flowId',
    { preHandler: admin },
    async (request): Promise<DevicePollView> => {
      const { flowId } = parseInput(FlowParams, request.params)
      const principal = request.principal!
      const flow = ctx.backup.deviceFlows.get(adminId(principal), flowId)
      if (!flow) throw Errors.notFound('This sign-in expired; start again')
      if (flow.state === 'pending' && ctx.now() >= flow.nextPollAt) {
        // Google's own pace: never more often than the interval it gave (grown on slow_down). The
        // next poll is due from now, set before the await, so two polls never ask at once (B17).
        flow.nextPollAt = ctx.now() + flow.interval * 1000
        const r = await pollDeviceFlow(
          ctx.backup.egress,
          ctx.backup.googleHosts,
          { clientId: flow.clientId, clientSecret: flow.clientSecret, deviceCode: flow.deviceCode },
          AbortSignal.timeout(30_000),
        ).catch(asHttp)
        // Final review B17: what another poll settled meanwhile stands; an approval is never undone.
        if (flow.state !== 'pending')
          return { state: flow.state, ...(flow.account ? { account: flow.account } : {}) }
        if (r.state === 'slow_down') flow.interval += 5
        else if (r.state === 'approved') {
          flow.state = 'approved'
          flow.refreshToken = r.refreshToken
          const about = await ctx.backup.egress
            .buffer({
              method: 'GET',
              url: `${ctx.backup.googleHosts.api}/drive/v3/about?fields=user(emailAddress)`,
              headers: { authorization: `Bearer ${r.accessToken}` },
              ...(ctx.backup.googleHosts.caPem ? { caPem: ctx.backup.googleHosts.caPem } : {}),
              signal: AbortSignal.timeout(15_000),
            })
            .then((x) => JSON.parse(x.body.toString()) as { user?: { emailAddress?: string } })
            .catch(() => ({}) as { user?: { emailAddress?: string } })
          if (about.user?.emailAddress) flow.account = about.user.emailAddress
        } else if (r.state === 'denied' || r.state === 'expired') flow.state = r.state
        flow.nextPollAt = ctx.now() + flow.interval * 1000
        if (flow.state !== 'pending')
          ctx.audit.append({
            action: 'backup.destination.connect',
            outcome: flow.state === 'approved' ? 'success' : 'failure',
            userId: principal.kind === 'user' ? principal.userId : null,
            username: null,
            ip: request.ip,
            connectionId: null,
            namespace: null,
            details: { state: flow.state, ...(flow.account ? { account: flow.account } : {}) },
          })
      }
      return { state: flow.state, ...(flow.account ? { account: flow.account } : {}) }
    },
  )

  const CopyParams = z.object({ copyId: z.string().uuid() })
  const ownCopy = (request: import('fastify').FastifyRequest) => {
    const { copyId } = parseInput(CopyParams, request.params)
    const copy = ctx.backup.copies.get(copyId)
    if (
      !copy ||
      copy.owner !== ownerOf(request.principal!) ||
      !ctx.backup.destinations.levelOf(copy.destinationId, request.principal!)
    )
      throw Errors.notFound('Copy not found')
    return copy
  }

  app.post(
    '/backup-copies/:copyId/retry',
    { preHandler: requireAuth, config: { audit: 'backup.send.start' } },
    async (request, reply) => {
      const copy = ownCopy(request)
      if (copy.state !== 'failed')
        throw Errors.conflict('Only a failed copy can be retried', { reason: 'copy_not_failed' })
      const row = copy.backupId ? ctx.backup.store.get(copy.owner, copy.backupId) : undefined
      if (!row)
        throw Errors.conflict('The backup is no longer on the server; take it again', {
          reason: 'local_gone',
        })
      assertBackupAccess(ctx, request.principal!, row)
      // Final review B14: a retry keeps the original send's "delete the local copy".
      const job = startSend(ctx, request.principal!, row, [copy.destinationId], copy.deleteLocal === true)
      request.auditInfo = { details: { job: job.id, copy: copy.id, retry: true } }
      return reply.status(202).send({ job: toView(ctx, request.principal!, job) })
    },
  )

  app.delete(
    '/backup-copies/:copyId',
    { preHandler: requireAuth, config: { audit: 'backup.copy.discard' } },
    async (request, reply) => {
      const copy = ownCopy(request)
      if (copy.state === 'complete')
        throw Errors.conflict('A complete copy is deleted from the destination’s list', {
          reason: 'copy_complete',
        })
      if (copy.state === 'sending')
        throw Errors.conflict('This copy is being sent; cancel its job first', { reason: 'copy_sending' })
      const record = ctx.backup.destinations.get(copy.destinationId)!
      const resume = ctx.backup.copies.resume(copy.id)
      if (resume)
        await adapterFor(record, ctx.backup.destinations.secrets(record.id), interactive())
          .abandon(resume, AbortSignal.timeout(15_000))
          .catch(() => undefined)
      ctx.backup.copies.remove(copy.id)
      request.auditInfo = { details: { copy: copy.id, destination: copy.destinationId } }
      return reply.status(204).send()
    },
  )

  /** D8: the 3d-3a download checks, on the connection and rules the copy was made from. */
  function assertCopyAccess(principal: Principal, copy: CopyRecord): void {
    if (!copy.meta || !copy.connectionId) throw Errors.notFound('Backup not found')
    assertBackupAccess(ctx, principal, {
      id: copy.id,
      owner: copy.owner,
      kind: 'backup',
      name: nameOfKey(copy.remoteKey),
      size: copy.size,
      declaredSize: null,
      complete: true,
      awaitingVerify: false,
      jobId: null,
      connectionId: copy.connectionId,
      meta: copy.meta,
      sha256: copy.sha256,
      createdAt: copy.createdAt,
      expiresAt: Number.MAX_SAFE_INTEGER,
      scheduleId: null,
    })
  }

  const ListQuery = z.object({ cursor: z.string().max(8192).optional() })

  /** Final review B23: where a listing goes on — the provider's page, and how far into it. */
  const PageCursor = z.strictObject({
    c: z.string().max(4096).nullable(),
    s: z.number().int().min(0).max(100_000),
  })
  const readCursor = (raw: string | undefined): { c: string | null; s: number } => {
    const text = decodeCursor(raw)
    if (text === null) return { c: null, s: 0 }
    try {
      return PageCursor.parse(JSON.parse(text))
    } catch {
      throw Errors.validation('This listing cannot go on from here; start it again', { reason: 'cursor' })
    }
  }

  app.get('/backup-destinations/:id/backups', { preHandler: requireAuth }, async (request) => {
    const { id } = parseInput(IdParams, request.params)
    const { cursor } = parseInput(ListQuery, request.query)
    const principal = request.principal!
    const level = requireLevel(ctx, principal, id)
    const record = repo().get(id)!
    const me = ownerOf(principal)
    const from = readCursor(cursor)
    // Final review B23: every listing is outbound requests (and billed reads): per user, bounded.
    const leave = ctx.backup.destLists.enter(`list:${me}`)
    try {
      const ctl = new AbortController()
      request.raw.once('close', () => ctl.abort())
      const signal = AbortSignal.any([ctl.signal, AbortSignal.timeout(60_000)])
      const adapter = (() => {
        try {
          return adapterFor(record, repo().secrets(id), interactive())
        } catch (e) {
          return asHttp(e)
        }
      })()
      const page = await adapter.list(from.c, signal).catch(asHttp)
      const rows: Array<{ item: RemoteItem; copy: CopyRecord | null }> = []
      let reads = 0
      let stop: number | null = null
      for (let i = from.s; i < page.items.length; i++) {
        const item = page.items[i]!
        const copy = ctx.backup.copies.byKey(id, item.key) ?? null
        // Spec §4.3: a send-level user lists only the copies they sent.
        if (level === 'send' && copy?.owner !== me) continue
        // At most a page's worth of manifest reads per request; the rest of the provider's page
        // comes with the next cursor.
        if (!copy && reads++ === MANIFEST_READS_PER_PAGE) {
          stop = i
          break
        }
        rows.push({ item, copy })
      }
      const next =
        stop !== null ? { c: from.c, s: stop } : page.cursor !== null ? { c: page.cursor, s: 0 } : null
      const items = await listed(rows, adapter, signal, principal, level, me)
      return { items, cursor: encodeCursor(next && JSON.stringify(next)) }
    } finally {
      leave()
    }
  })

  /**
   * Final review B19: a copy's scope (database and collection names) and connection are shown to
   * its sender, an administrator, or someone who may read that connection — not to every browser.
   */
  const mayKnowScope = (principal: Principal, level: GrantLevel | 'admin', me: string, copy: CopyRecord) => {
    if (copy.owner === me || level === 'admin') return true
    if (!copy.connectionId || !ctx.connections.get(copy.connectionId)) return false
    const role = effectiveRole(ctx, principal, copy.connectionId)
    return role !== null && permissionsFor(role).has('documents:read')
  }

  async function listed(
    rows: Array<{ item: RemoteItem; copy: CopyRecord | null }>,
    adapter: DestinationAdapter,
    signal: AbortSignal,
    principal: Principal,
    level: GrantLevel | 'admin',
    me: string,
  ): Promise<RemoteBackup[]> {
    let thawReads = 0
    return mapLimited(rows, 4, async ({ item, copy }): Promise<RemoteBackup> => {
      const manifest = copy
        ? null
        : parseManifest(
            await adapter.getSmall(manifestKeyOf(item.key), MANIFEST_LIMIT, signal).catch(() => null),
          )
      // W4.5: an archived copy's thaw is known from its HEAD (the listing does not say) — a bounded
      // number per page; a thawed one can be restored.
      const thawStat =
        item.archived && adapter.thaw && thawReads++ < THAW_STATS_PER_PAGE
          ? await adapter.stat(item.key, signal).catch(() => null)
          : null
      const thaw = item.archived ? (thawStat?.thaw ?? null) : null
      const sender = copy
        ? (ctx.users.findById(copy.owner)?.username ?? (copy.owner === 'local' ? 'local' : null))
        : null
      return {
        key: item.key,
        name: nameOfKey(item.key),
        size: item.size,
        createdAt: manifest?.createdAt ?? copy?.createdAt ?? item.modifiedAt,
        format: copy?.format ?? manifest?.format ?? formatOfKey(item.key),
        archived: item.archived && thaw !== 'thawed',
        thaw,
        state: copy
          ? copy.state === 'complete'
            ? 'complete'
            : 'incomplete'
          : manifest
            ? 'complete'
            : 'foreign',
        copyId: copy?.id ?? null,
        sender,
        mine: copy?.owner === me,
        ...(copy && mayKnowScope(principal, level, me, copy)
          ? {
              scope: copy.meta?.scope ?? null,
              connectionId: copy.connectionId,
              masked: copy.meta?.masked ?? null,
              anonymous: copy.meta?.anonymous ?? null,
            }
          : { scope: null, connectionId: null, masked: null, anonymous: null }),
      }
    })
  }

  /**
   * W4.5: thaw an archived copy (S3 RestoreObject) so it can be restored — anyone who may fetch it
   * (a send-level user: their own copies). It costs money at the provider: bounded per user, audited.
   */
  app.post(
    '/backup-destinations/:id/backups/thaw',
    { preHandler: requireAuth, config: { audit: 'backup.destination.thaw' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const body = parseInput(ThawRequestSchema, request.body)
      const principal = request.principal!
      const level = requireLevel(ctx, principal, id)
      const record = repo().get(id)!
      if (!isSafeKey(body.key, layoutPrefix(record)))
        throw Errors.validation('This is not a backup of this destination', { reason: 'path' })
      if (level === 'send') {
        const copy = ctx.backup.copies.byKey(id, body.key)
        if (!copy || copy.owner !== ownerOf(principal)) throw Errors.notFound('Backup not found')
        assertCopyAccess(principal, copy)
      }
      const adapter = (() => {
        try {
          return adapterFor(record, repo().secrets(id), interactive())
        } catch (e) {
          return asHttp(e)
        }
      })()
      if (!adapter.thaw)
        throw Errors.conflict('This destination keeps nothing archived', { reason: 'thaw_unsupported' })
      const leave = ctx.backup.destTests.enter(`thaw:${ownerOf(principal)}`)
      try {
        const answer = await adapter
          .thaw(body.key, { days: body.days, tier: body.tier }, AbortSignal.timeout(60_000))
          .catch((e: unknown) => {
            if (e instanceof DestinationError && e.reason === 'not_archived')
              throw Errors.conflict(e.message, { reason: 'not_archived' })
            return asHttp(e)
          })
        request.auditInfo = {
          details: {
            destination: id,
            name: nameOfKey(body.key),
            days: body.days,
            tier: body.tier,
            state: answer.state,
          },
        }
        return answer
      } finally {
        leave()
      }
    },
  )

  app.post(
    '/backup-destinations/:id/backups/fetch',
    { preHandler: requireAuth, config: { audit: 'backup.fetch.start' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      const body = parseInput(FetchRequestSchema, request.body)
      const principal = request.principal!
      const level = requireLevel(ctx, principal, id)
      const record = repo().get(id)!
      if (!isSafeKey(body.key, layoutPrefix(record)))
        throw Errors.validation('This is not a backup of this destination', { reason: 'path' })
      // Plan ruling 2: the job belongs to the connection the restore goes to, with the restore's rights.
      const role = ctx.connections.get(body.connectionId)
        ? effectiveRole(ctx, principal, body.connectionId)
        : null
      if (!role) throw Errors.notFound('Connection not found')
      const perms = permissionsFor(role)
      if (!perms.has('documents:write') || !perms.has('jobs:run')) throw Errors.forbidden()
      // Security review Minor 8: the restore it leads to writes documents onto that connection.
      assertEncryptedWriteAllowed(ctx, principal, ctx.connections.get(body.connectionId)!)
      const owner = ownerOf(principal)
      const copy = ctx.backup.copies.byKey(id, body.key)
      if (level === 'send') {
        if (!copy || copy.owner !== owner) throw Errors.notFound('Backup not found')
        assertCopyAccess(principal, copy)
      }
      // Final review B24: a copy still sending, or one that failed, is no backup to restore.
      if (copy && copy.state !== 'complete')
        throw Errors.conflict('This copy did not finish; it cannot be restored', {
          reason: 'copy_incomplete',
        })
      const signal = AbortSignal.timeout(60_000)
      const adapter = (() => {
        try {
          return adapterFor(record, repo().secrets(id), interactive())
        } catch (e) {
          return asHttp(e)
        }
      })()
      const st = await adapter.stat(body.key, signal).catch(asHttp)
      if (!st) throw Errors.notFound('The backup is no longer at the destination')
      if (st.archived)
        // W4 review (minor): thawing is done here now, not in the provider's console.
        throw Errors.conflict('The backup is archived; thaw it first (Thaw… in the destination’s backups)', {
          reason: 'archived',
        })
      const manifest = copy
        ? null
        : parseManifest(
            await adapter.getSmall(manifestKeyOf(body.key), MANIFEST_LIMIT, signal).catch(() => null),
          )
      // D14: a record or manifest that disagrees with the object is a reason to stop, not to trust either.
      if ((copy && copy.size !== st.size) || (manifest && manifest.size !== st.size))
        throw Errors.conflict('The destination’s file does not match its record', { reason: 'verify' })
      assertBackupRoom(ctx, principal)
      // Final review B26: the caller's download of this file that broke off is resumed, not restarted.
      const source = { destinationId: id, key: body.key }
      const upload =
        ctx.backup.store.fetchPartial(owner, source, st.size) ??
        ctx.backup.store.createUpload({
          owner,
          name: nameOfKey(body.key),
          size: st.size,
          awaitingVerify: true,
          fetchSource: source,
        })
      ctx.backup.store.keepUntil(upload.id, ctx.now() + ctx.backup.limits.maxJobMs)
      // Final review B29: a foreign file without a manifest is verified against nothing, and says so.
      const verified = Boolean(copy ?? manifest)
      const job = ctx.jobs.start(
        ctx.jobKinds['backup.fetch'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: body.connectionId,
          db: '*',
          coll: '*',
          target: nameOfKey(body.key),
        },
        {
          owner,
          userId: principal.kind === 'user' ? principal.userId : null,
          destinationId: id,
          key: body.key,
          uploadId: upload.id,
          expectSha256: copy?.sha256 ?? manifest?.sha256 ?? null,
          size: st.size,
        },
      )
      request.auditInfo = {
        details: {
          job: job.id,
          destination: id,
          name: nameOfKey(body.key),
          size: st.size,
          verified,
          resumed: upload.size > 0,
        },
      }
      noteJob(ctx, job.id, { verified })
      const answer: FetchStartView = { uploadId: upload.id, job: toView(ctx, principal, job), verified }
      return reply.status(202).send(answer)
    },
  )

  const RemoteParams = z.object({ id: z.string().uuid(), copyId: z.string().uuid() })
  app.delete(
    '/backup-destinations/:id/backups/:copyId',
    { preHandler: requireAuth, config: { audit: 'backup.remote.delete' } },
    async (request, reply) => {
      const { id, copyId } = parseInput(RemoteParams, request.params)
      const principal = request.principal!
      const level = requireLevel(ctx, principal, id)
      const copy = ctx.backup.copies.get(copyId)
      if (!copy || copy.destinationId !== id || (level !== 'admin' && copy.owner !== ownerOf(principal)))
        throw Errors.notFound('Backup not found')
      if (copy.state !== 'complete')
        throw Errors.conflict('Discard an unfinished copy from its backup instead', {
          reason: 'copy_incomplete',
        })
      await removeRemoteCopy(ctx, copy, AbortSignal.timeout(60_000), interactive()).catch(asHttp)
      request.auditInfo = { details: { destination: id, copy: copy.id } }
      return reply.status(204).send()
    },
  )
}
