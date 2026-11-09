// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  AzureConfigSchema,
  GcsConfigSchema,
  GdriveConfigSchema,
  HOST_FINGERPRINT,
  S3ConfigSchema,
  SftpConfigSchema,
  WebdavConfigSchema,
  type TestStep,
} from '@mongo-manager/shared'
import type { Egress } from '../../net/egress'
import { EgressError, scrubText } from '../../net/egress'
import type { ServerContext } from '../../http/context'
import type { BackupLimits } from '../limits'
import { createAzureAdapter } from './azure'
import { createFolderAdapter } from './folder'
import { createDriveAdapter } from './gdrive'
import { GoogleTokens, STORAGE_SCOPE, parseServiceAccountKey, type GoogleHosts } from './google-auth'
import { createGcsAdapter } from './gcs'
import { probeKey } from './layout'
import type { DestinationRecord } from './repo'
import { createS3Adapter } from './s3'
import { createSftpAdapter } from './sftp'
import { DestinationError, toDestinationError, type DestinationAdapter } from './types'
import { createWebdavAdapter } from './webdav'

export interface RegistryDeps {
  egress: Egress
  googleHosts: GoogleHosts
  limits: BackupLimits
  dataDir: string
  now(): number
  tokens: Map<string, GoogleTokens>
  saveStatus(id: string, patch: Partial<DestinationRecord['status']>): void
  /** Retries per request; routes pass 0 (someone is waiting), jobs keep the full policy. */
  retries?: number
}

export const layoutPrefix = (r: Pick<DestinationRecord, 'type' | 'config'>) =>
  r.type === 's3' || r.type === 'gcs' || r.type === 'azure' ? String(r.config.prefix ?? '') : ''

const need = (secrets: Record<string, string>, keys: string[]) => {
  if (keys.some((k) => !secrets[k]))
    throw new DestinationError(
      'secrets_missing',
      'The destination’s credentials are missing; enter them again',
    )
}

export function adapterFor(
  record: DestinationRecord,
  secrets: Record<string, string>,
  deps: RegistryDeps,
): DestinationAdapter {
  const common = {
    egress: deps.egress,
    partBytes: deps.limits.destPartBytes,
    now: deps.now,
    ...(deps.retries !== undefined ? { retries: deps.retries } : {}),
  }
  switch (record.type) {
    case 'folder':
      return createFolderAdapter({
        path: String(record.config.path),
        roots: deps.limits.folderRoots,
        dataDir: deps.dataDir,
      })
    case 's3':
      need(secrets, ['accessKeyId', 'secretAccessKey'])
      return createS3Adapter({
        ...common,
        config: S3ConfigSchema.parse(record.config),
        secrets: { accessKeyId: secrets.accessKeyId!, secretAccessKey: secrets.secretAccessKey! },
      })
    case 'webdav':
      need(secrets, ['password'])
      return createWebdavAdapter({
        ...common,
        config: WebdavConfigSchema.parse(record.config),
        secrets: { password: secrets.password! },
      })
    case 'gdrive': {
      const config = GdriveConfigSchema.parse(record.config)
      const sa = config.auth === 'serviceAccount'
      need(secrets, sa ? ['serviceAccountKey'] : ['clientSecret', 'refreshToken'])
      const key = sa ? parseServiceAccountKey(secrets.serviceAccountKey!) : null
      // One token cache per destination version: an edit starts a new one.
      const cacheKey = `${record.id}|${record.updatedAt}`
      let tokens = deps.tokens.get(cacheKey)
      if (!tokens) {
        tokens = new GoogleTokens({
          egress: deps.egress,
          hosts: deps.googleHosts,
          source: key
            ? { kind: 'serviceAccount', key }
            : {
                kind: 'oauth',
                clientId: config.clientId!,
                clientSecret: secrets.clientSecret!,
                refreshToken: secrets.refreshToken!,
              },
          now: deps.now,
        })
        for (const k of deps.tokens.keys()) if (k.startsWith(`${record.id}|`)) deps.tokens.delete(k)
        deps.tokens.set(cacheKey, tokens)
      }
      return createDriveAdapter({
        ...common,
        hosts: deps.googleHosts,
        tokens,
        config,
        account: key ? key.client_email : (record.status.account ?? null),
        folderId: record.status.folderId ?? null,
        saveFolderId: (folderId) => deps.saveStatus(record.id, { folderId }),
      })
    }
    case 'azure': {
      const config = AzureConfigSchema.parse(record.config)
      need(secrets, config.auth === 'sas' ? ['sasToken'] : ['accountKey'])
      return createAzureAdapter({
        ...common,
        config,
        secrets:
          config.auth === 'sas' ? { sasToken: secrets.sasToken! } : { accountKey: secrets.accountKey! },
      })
    }
    case 'sftp': {
      const config = SftpConfigSchema.parse(record.config)
      need(secrets, config.auth === 'password' ? ['password'] : ['privateKey'])
      return createSftpAdapter({
        ...common,
        config,
        secrets:
          config.auth === 'password'
            ? { password: secrets.password! }
            : {
                privateKey: secrets.privateKey!,
                ...(secrets.passphrase ? { passphrase: secrets.passphrase } : {}),
              },
      })
    }
    case 'gcs': {
      // W4.5: a service account with the storage scope; tokens cached per destination version.
      need(secrets, ['serviceAccountKey'])
      const key = parseServiceAccountKey(secrets.serviceAccountKey!)
      const cacheKey = `${record.id}|${record.updatedAt}`
      let tokens = deps.tokens.get(cacheKey)
      if (!tokens) {
        tokens = new GoogleTokens({
          egress: deps.egress,
          hosts: deps.googleHosts,
          source: { kind: 'serviceAccount', key },
          now: deps.now,
          scope: STORAGE_SCOPE,
        })
        for (const k of deps.tokens.keys()) if (k.startsWith(`${record.id}|`)) deps.tokens.delete(k)
        deps.tokens.set(cacheKey, tokens)
      }
      return createGcsAdapter({
        ...common,
        hosts: deps.googleHosts,
        tokens,
        config: GcsConfigSchema.parse(record.config),
        account: key.client_email,
      })
    }
  }
}

const NETWORK_REASONS = new Set(['dns', 'address_refused', 'address_never', 'http_refused', 'bad_url'])

/** Plan ruling 11: resolve, connect, auth, write, read, delete — stopping at the first failure. */
export async function testDestination(
  adapter: DestinationAdapter,
  prefix: string,
  deps: Pick<RegistryDeps, 'egress' | 'now'>,
  signal: AbortSignal,
): Promise<{ steps: TestStep[]; account?: string }> {
  const steps: TestStep[] = []
  const fail = (e: unknown): Omit<TestStep, 'step'> => {
    const d = toDestinationError(e)
    return {
      ok: false,
      ms: null,
      reason: d.reason,
      ...(d.extra.code ? { detail: scrubText(d.extra.code) } : {}),
      // Short names review 7 (I-1, M-5): which folder refusal, and the name refused — the admin's
      // own setting, quoted and escaped already, so in fields of their own and not scrubbed.
      ...(d.extra.why ? { why: d.extra.why } : {}),
      ...(d.extra.name ? { name: d.extra.name } : {}),
      // W4.5: a fingerprint is public and fixed in form; scrubText would hide it as a secret.
      ...(d.extra.hostKey && HOST_FINGERPRINT.test(d.extra.hostKey) ? { hostKey: d.extra.hostKey } : {}),
    }
  }
  const skipRest = () => {
    for (const s of ['resolve', 'connect', 'auth', 'write', 'read', 'delete'] as const)
      if (!steps.some((x) => x.step === s)) steps.push({ step: s, ok: false, ms: null, reason: 'skipped' })
    return { steps }
  }
  const endpoint = adapter.endpoint()
  if (!endpoint) {
    steps.push(
      { step: 'resolve', ok: true, ms: null, reason: 'local' },
      { step: 'connect', ok: true, ms: null, reason: 'local' },
    )
  } else {
    try {
      const t = adapter.probe
        ? await adapter.probe(signal)
        : await deps.egress.probe(endpoint, adapter.caPem(), signal)
      steps.push(
        { step: 'resolve', ok: true, ms: t.resolveMs },
        { step: 'connect', ok: true, ms: t.connectMs },
      )
    } catch (e) {
      const reason = e instanceof EgressError ? e.reason : 'network'
      if (NETWORK_REASONS.has(reason)) steps.push({ step: 'resolve', ...fail(e) })
      else steps.push({ step: 'resolve', ok: true, ms: null }, { step: 'connect', ...fail(e) })
      return skipRest()
    }
  }
  let account: string | undefined
  const timed = async (step: TestStep['step'], fn: () => Promise<unknown>): Promise<boolean> => {
    const t0 = deps.now()
    try {
      await fn()
      steps.push({ step, ok: true, ms: Math.max(0, deps.now() - t0) })
      return true
    } catch (e) {
      steps.push({ step, ...fail(e) })
      return false
    }
  }
  if (!(await timed('auth', async () => (account = (await adapter.authCheck(signal)).account))))
    return skipRest()
  const key = probeKey(prefix)
  const body = Buffer.from('mongo-manager destination test')
  if (!(await timed('write', () => adapter.putSmall(key, body, signal)))) return skipRest()
  await timed('read', async () => {
    const back = await adapter.getSmall(key, 1024, signal)
    if (!back?.equals(body)) throw new DestinationError('verify', 'The test object read back differs')
  })
  // The probe is removed even when reading it failed.
  await timed('delete', () => adapter.remove(key, signal))
  return { steps, ...(account ? { account } : {}) }
}

export function registryDeps(ctx: ServerContext): RegistryDeps {
  return {
    egress: ctx.backup.egress,
    googleHosts: ctx.backup.googleHosts,
    limits: ctx.backup.limits,
    dataDir: ctx.config.dataDir,
    now: ctx.now,
    tokens: ctx.backup.tokens,
    saveStatus: (id, patch) => {
      const r = ctx.backup.destinations.get(id)
      if (r) ctx.backup.destinations.setStatus(id, { ...r.status, ...patch })
    },
  }
}
