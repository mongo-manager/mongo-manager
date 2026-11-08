// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { connectionScope } from '../aggregation/cache'
import type { TestResult } from '../connections/manager'
import { readerKey } from '../data/page'
import { z } from 'zod'
import {
  comparableSettings,
  refusedUriOption,
  ConnectionInputSchema,
  ConnectionPatchSchema,
  ConnectionSettingsSchema,
  ConnectionUriError,
  hasMaskedSecret,
  maskSecrets,
  mergeSecrets,
  formatHost,
  parseConnectionUri,
  permissionsFor,
  secretReuseProblem,
  type ConnectionSettings,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { transaction } from '../store/db'
import { requireAuth, requirePermission, requireTeamMode, userPrincipal } from '../http/guards'
import {
  effectiveRole,
  isRestricted,
  mayExport,
  mayUseShell,
  personOf,
  requireConnection,
  restrictedByOthers,
} from '../connections/access'
import { connectionProblem, type PolicyReason } from '../connections/policy'
import { moduleUnavailableMessage } from '../optional/modules'
import { ownOrigin } from '../http/security'
import { OIDC_SIGN_IN_NEEDED } from '../connections/errors'
import type { OIDCCallbackFunction } from 'mongodb'
import { toConnectionDto, type ConnectionRecord } from '../connections/repo'
import { checkPassword } from './auth'
import { forgetConnectionPins } from '../queries/pins'

const UriBody = z.object({ uri: z.string().min(1).max(8192) })
const TestBody = z.object({ settings: ConnectionSettingsSchema, connectionId: z.string().max(64).optional() })
const ExportBody = z.object({
  includeSecrets: z.boolean().default(false),
  password: z.string().max(1024).optional(),
})
const ImportBody = z.object({
  format: z.literal('mongo-manager-connections'),
  version: z.literal(1),
  connections: z.array(ConnectionInputSchema).max(1000),
})
const GrantParams = z.object({ id: z.string().max(64), userId: z.uuid() })
const GrantBody = z.object({
  role: z.enum(['admin', 'editor', 'viewer', 'none']).nullable(),
  // Phase 3a-1: whether this user may open the shell on the connection (an editor's opt-in).
  shell: z.boolean().optional(),
  // Phase 3b: this user may not see the connection's personal data (never together with the shell).
  masked: z.boolean().optional(),
  // Phase 3d-1: a viewer may export files from this connection (admins and editors may by role).
  export: z.boolean().optional(),
})

/** Machine-readable reasons let the UI explain these refusals in the user's language. */
const MASK_ON_CREATE = { reason: 'masked_secret_on_create' } as const
const MASK_REUSE = { reason: 'masked_secret_reuse' } as const

/**
 * A form loaded before the first SSH connect has no fingerprint: the stored pin is kept for the same
 * SSH host — before the secrets are checked (independent review I4), for a save and for a test
 * (second review), so neither runs with the stored secrets and no host-key check.
 */
function withStoredPin(incoming: ConnectionSettings, stored: ConnectionSettings): ConnectionSettings {
  // Fifth review of the open's stop (minor 3): as secretReuseProblem reads it, so a record stored
  // before the SSH port had its default keeps its pin, rather than passing that check without it.
  const pinned = comparableSettings(stored).ssh
  if (
    incoming.ssh &&
    !incoming.ssh.hostFingerprint &&
    pinned?.hostFingerprint &&
    pinned.host === incoming.ssh.host &&
    pinned.port === incoming.ssh.port
  )
    return { ...incoming, ssh: { ...incoming.ssh, hostFingerprint: pinned.hostFingerprint } }
  return incoming
}

/** The same connection settings, however each was spelt or stored (comparableSettings). */
const sameSettings = (a: ConnectionSettings, b: ConnectionSettings): boolean =>
  stable(comparableSettings(a)) === stable(comparableSettings(b))

/** JSON with sorted keys: two settings objects compared by content, whatever their key order. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

/**
 * Takes the refused URI options out of a connections file's settings before it is parsed (the
 * schema refuses them), and counts the connections that had one.
 */
function dropRefusedOptions(body: unknown): number {
  const list = (body as { connections?: unknown } | null)?.connections
  if (!Array.isArray(list)) return 0
  let count = 0
  for (const c of list) {
    const options = (c as { settings?: { options?: unknown } } | null)?.settings?.options
    if (!options || typeof options !== 'object' || Array.isArray(options)) continue
    const keys = Object.keys(options).filter((k) => refusedUriOption(k))
    for (const key of keys) delete (options as Record<string, unknown>)[key]
    if (keys.length) count++
  }
  return count
}

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const manage = requirePermission('connections:manage')
  /** Security audit 2026-10-16 (minor): one test at a time per user, within the server's slots. */
  const test = async (
    request: FastifyRequest,
    settings: ConnectionSettings,
    saved?: string,
  ): Promise<TestResult> => {
    // W7, W8: what the server does not allow is said before anything is dialled.
    const problem = connectionProblem(settings, ctx.policy())
    if (problem) return { ok: false, error: { kind: 'config', message: problem.message } }
    // Fifth review (M1): while a refusal is kept, only the connection's administrators sign in
    // again with its test: a viewer pressing Test over and over would lock the account out.
    if (saved) {
      const kept = ctx.manager.refusalOf(saved, personOf(request.principal!))
      const role = effectiveRole(ctx, request.principal!, saved)
      if (kept && !(role && permissionsFor(role).has('connections:manage')))
        return { ok: false, error: { kind: kept.kind, message: kept.message, remembered: true } }
    }
    const release = ctx.connectionTests.acquire(readerKey(request))
    if (!release)
      return {
        ok: false,
        error: { kind: 'busy', message: 'Your connection test is still running; try again in a moment' },
      }
    try {
      // W7: a saved connection is tested with this person's own sign-in; settings being edited
      // only learn which identity provider the server names (no token goes to an unsaved server).
      let issuer: string | undefined
      const own = saved ? ctx.oidc.callback(saved, personOf(request.principal!)) : null
      const oidcCallback: OIDCCallbackFunction | undefined =
        settings.auth.mechanism === 'MONGODB-OIDC' && !settings.auth.oidc?.environment
          ? async (params) => {
              issuer = params.idpInfo?.issuer
              if (own) return own(params)
              throw new Error(OIDC_SIGN_IN_NEEDED)
            }
          : undefined
      const result = await ctx.manager.test(settings, oidcCallback ? { oidcCallback } : {})
      // Its sign-in works again: a refusal kept for the saved connection is forgotten.
      if (result.ok && saved) ctx.manager.forgetRefusal(saved, personOf(request.principal!))
      if (!result.ok && result.error.kind === 'oidc' && issuer) result.error.issuer = issuer
      return result
    } finally {
      release()
    }
  }

  /**
   * W7, W8: what this server allows — Kerberos and a workload identity in team mode, client-side
   * encryption and its library — checked when a connection is saved, imported or tested.
   */
  const assertAllowed = (
    settings: ConnectionSettings,
    entry?: { index: number; name: string },
    o: { tolerate?: ReadonlySet<PolicyReason> } = {},
  ) => {
    // An import dropped a library path and a token resource's confirmation (security review I2,
    // I3): the connection asks for them again; every other check holds.
    const problem = connectionProblem(settings, ctx.policy(), { tolerate: o.tolerate })
    if (!problem) return
    // An import is all or nothing: the entry refused is named (review minor 3).
    if (entry)
      throw Errors.validation(`${entry.name}: ${problem.message}`, {
        reason: problem.reason,
        field: `connections.${entry.index}.settings.${problem.field}`,
      })
    throw Errors.validation(problem.message, { reason: problem.reason, field: problem.field })
  }

  const visible = (request: Parameters<typeof requireAuth>[0], all: ConnectionRecord[]) => {
    const principal = request.principal!
    return all.filter((c) => effectiveRole(ctx, principal, c.id) !== null)
  }

  /** DTO plus what the caller may do on this connection, so the UI can hide impossible actions. */
  const dto = (request: Parameters<typeof requireAuth>[0], c: ConnectionRecord) => {
    const role = effectiveRole(ctx, request.principal!, c.id) ?? 'viewer'
    return {
      ...toConnectionDto(c),
      access: role,
      permissions: [...permissionsFor(role, { readOnly: ctx.config.readOnly || c.readOnly })],
      // Phase 3a-1: whether this caller may open the shell here (admin, or editor with the grant).
      shell: mayUseShell(ctx, request.principal!, c.id),
      // Phase 3b: whether personal values are hidden from this caller here.
      restricted: isRestricted(ctx, request.principal!, c.id),
      // User report 2026-10-30: whether MongoDB's users and roles are kept from this caller here.
      accountsRestricted: restrictedByOthers(ctx, request.principal!, c.id),
      // Phase 3d-1: whether this caller may export files here.
      export: mayExport(ctx, request.principal!, c.id),
    }
  }

  app.get('/connections', { preHandler: requireAuth }, async (request) =>
    visible(request, ctx.connections.list()).map((c) => dto(request, c)),
  )

  /**
   * W7, W8: what the connection form may offer on this server — Kerberos and client-side encryption
   * (optional packages, npm package only; Kerberos refused in team mode unless allowed), a workload
   * identity for OIDC, and the redirect address OIDC sign-ins come back to by default.
   */
  app.get('/connections/capabilities', { preHandler: requireAuth }, async (request) => {
    const p = ctx.policy()
    const { kerberos, clientEncryption } = p.modules
    return {
      mode: p.teamMode ? ('team' as const) : ('local' as const),
      distribution: p.modules.distribution,
      kerberos: {
        available: kerberos.status === 'available',
        status: kerberos.status,
        allowed: !p.teamMode || p.allowKerberos,
        ...(kerberos.status === 'available'
          ? {}
          : { reason: moduleUnavailableMessage('kerberos', kerberos) }),
      },
      encryption: {
        available: clientEncryption.status === 'available',
        status: clientEncryption.status,
        ...(clientEncryption.status === 'available'
          ? {}
          : { reason: moduleUnavailableMessage('mongodb-client-encryption', clientEncryption) }),
        // Team mode loads only the operator's crypt_shared library (its path is not shown).
        serverCryptShared: !!p.cryptSharedLibPath,
        ownCryptSharedPath: !p.teamMode,
      },
      oidc: {
        workloadIdentity: !p.teamMode || p.allowWorkloadIdentity,
        redirectUri: `${ownOrigin(request)}${ctx.config.basePath}oidc/callback`,
        // Security review I6: sign-in with a code, off in team mode unless allowed.
        deviceFlow: ctx.config.oidcDeviceFlow ?? !p.teamMode,
      },
    }
  })

  app.post(
    '/connections',
    { preHandler: manage, config: { audit: 'connections.create' } },
    async (request) => {
      const input = parseInput(ConnectionInputSchema, request.body)
      if (hasMaskedSecret(input.settings)) {
        throw Errors.validation(
          'Secrets must be entered, not masked, when creating a connection',
          MASK_ON_CREATE,
        )
      }
      request.auditInfo = { details: { name: input.name } }
      assertAllowed(input.settings)
      const createdBy = request.principal!.kind === 'user' ? request.principal!.userId : null
      return dto(request, ctx.connections.create(input, createdBy))
    },
  )

  app.post('/connections/parse-uri', { preHandler: requireAuth }, async (request) => {
    const { uri } = parseInput(UriBody, request.body)
    try {
      return { settings: maskSecrets(parseConnectionUri(uri)) }
    } catch (e) {
      if (e instanceof ConnectionUriError) throw Errors.validation(e.message, e.details)
      throw e
    }
  })

  app.post(
    '/connections/test',
    { preHandler: manage, config: { audit: 'connections.test' } },
    async (request) => {
      const body = parseInput(TestBody, request.body)
      let stored: ConnectionSettings | undefined
      if (body.connectionId) {
        const record = ctx.connections.get(body.connectionId)
        if (!record || effectiveRole(ctx, request.principal!, record.id) === null)
          throw Errors.notFound('Connection not found')
        stored = record.settings
      }
      request.auditInfo = {
        details: {
          hosts: body.settings.hosts.map(formatHost),
          ...(body.connectionId ? { connectionId: body.connectionId } : {}),
        },
      }
      // Second review (minor): a test of a pinned record checks the host key it pinned, as a save does.
      const incoming = stored ? withStoredPin(body.settings, stored) : body.settings
      const problem = secretReuseProblem(incoming, stored)
      if (problem) throw Errors.validation(problem, MASK_REUSE)
      const merged = mergeSecrets(incoming, stored)
      const result = await test(request, merged)
      // Sixth review (nit 4): the saved settings, tested from the dialog, passed: their refusal goes.
      if (result.ok && body.connectionId && stored && sameSettings(merged, stored))
        ctx.manager.forgetRefusal(body.connectionId, personOf(request.principal!))
      return result
    },
  )

  app.post(
    '/connections/export',
    { preHandler: manage, config: { audit: 'connections.export' } },
    async (request) => {
      const body = parseInput(ExportBody, request.body)
      request.auditInfo = { details: { includeSecrets: body.includeSecrets } }
      if (body.includeSecrets && ctx.config.auth) {
        const record = ctx.users.findById(userPrincipal(request).userId)
        if (!record || !body.password || !(await checkPassword(ctx, record, body.password))) {
          throw Errors.validation('Enter your password to export secrets')
        }
      }
      return {
        format: 'mongo-manager-connections',
        version: 1,
        exportedAt: new Date(ctx.now()).toISOString(),
        connections: visible(request, ctx.connections.list()).map((c) => ({
          name: c.name,
          ...(c.group ? { group: c.group } : {}),
          ...(c.color ? { color: c.color } : {}),
          favorite: c.favorite,
          readOnly: c.readOnly,
          // Final review I2: the AI policy travels with the connection.
          aiPolicy: c.aiPolicy,
          // W6.3: and whether the agent may propose changes on it.
          aiAgentWrites: c.aiAgentWrites,
          // C5: and the tools turned off on it.
          aiAgentToolsOff: c.aiAgentToolsOff,
          settings: body.includeSecrets ? c.settings : maskSecrets(c.settings),
        })),
      }
    },
  )

  app.post(
    '/connections/import',
    { preHandler: manage, config: { audit: 'connections.import' } },
    async (request) => {
      // Fourth review: a file saved before timeoutMS was refused imports without it, and says so.
      const refusedOptionsDropped = dropRefusedOptions(request.body)
      const body = parseInput(ImportBody, request.body)
      // Security review I2: a crypt_shared path is code this server would load — never one a file
      // brought in. I3: a token resource's confirmation is someone's here, never a file's. Both are
      // dropped (and said); the connection asks for them again before it is used, and the import
      // tolerates exactly those two refusals for the entries concerned.
      let libraryPathsDropped = 0
      const entries = body.connections.map((c) => {
        let settings = c.settings
        const tolerate = new Set<PolicyReason>()
        const e = settings.encryption
        if (e?.cryptSharedLibPath) {
          libraryPathsDropped++
          tolerate.add('crypt_shared_path_needed')
          const { cryptSharedLibPath: _path, ...rest } = e
          settings = { ...settings, encryption: rest }
        }
        const oidc = settings.auth.oidc
        // W7 re-review: a workload identity, as its token resource, is confirmed here again.
        if (oidc?.tokenResource) tolerate.add('oidc_token_resource_unconfirmed')
        if (oidc?.environment) tolerate.add('oidc_workload_unconfirmed')
        if (oidc && (oidc.tokenResourceConfirmed !== undefined || oidc.environmentConfirmed !== undefined)) {
          const { tokenResourceConfirmed: _resource, environmentConfirmed: _environment, ...rest } = oidc
          settings = { ...settings, auth: { ...settings.auth, oidc: rest } }
        }
        return { connection: { ...c, settings }, tolerate }
      })
      entries.forEach(({ connection: c, tolerate }, index) =>
        assertAllowed(c.settings, { index, name: c.name }, { tolerate }),
      )
      const connections = entries.map((e) => e.connection)
      const createdBy = request.principal!.kind === 'user' ? request.principal!.userId : null
      transaction(ctx.store.db, () => {
        for (const c of connections)
          ctx.connections.create({ ...c, settings: mergeSecrets(c.settings, undefined) }, createdBy)
      })
      request.auditInfo = {
        details: { created: connections.length, libraryPathsDropped, refusedOptionsDropped },
      }
      return {
        created: connections.length,
        ...(libraryPathsDropped ? { libraryPathsDropped } : {}),
        ...(refusedOptionsDropped ? { refusedOptionsDropped } : {}),
      }
    },
  )

  app.get(
    '/connections/:id',
    { preHandler: requireConnection('connections:read'), config: { masking: 'names-only' } },
    async (request) => dto(request, request.connection!),
  )

  app.patch(
    '/connections/:id',
    {
      preHandler: [requireConnection('connections:read'), manage],
      config: { masking: 'names-only', audit: 'connections.update' },
    },
    async (request) => {
      const { aiPolicy, aiAgentWrites, aiAgentToolsOff, ...patch } = parseInput(
        ConnectionPatchSchema,
        request.body,
      )
      const current = request.connection!
      // A form loaded before the first SSH connect has no fingerprint; keep the pin for the same SSH
      // host — restored before the secrets are checked (independent review I4), so the pin is not
      // taken for a change of server.
      const incoming = patch.settings ? withStoredPin(patch.settings, current.settings) : undefined
      if (incoming) {
        const problem = secretReuseProblem(incoming, current.settings)
        if (problem) throw Errors.validation(problem, MASK_REUSE)
      }
      const settings = incoming ? mergeSecrets(incoming, current.settings) : undefined
      // Phase 4a-1 plan ruling 10, final review I3: the AI policy is not a connection change, and a
      // form saved with nothing else changed (the policy alone) reconnects and closes nothing.
      const same =
        (patch.name === undefined || patch.name === current.name) &&
        (patch.group === undefined || patch.group === current.group) &&
        (patch.color === undefined || patch.color === current.color) &&
        (patch.favorite === undefined || patch.favorite === current.favorite) &&
        (patch.readOnly === undefined || patch.readOnly === current.readOnly) &&
        (settings === undefined || sameSettings(settings, current.settings))
      if (same) {
        if (aiPolicy) ctx.connections.setAiPolicy(current.id, aiPolicy)
        if (aiAgentWrites !== undefined) ctx.connections.setAiAgentWrites(current.id, aiAgentWrites)
        if (aiAgentToolsOff !== undefined) ctx.connections.setAiAgentToolsOff(current.id, aiAgentToolsOff)
        return dto(request, ctx.connections.get(current.id)!)
      }
      if (settings) assertAllowed(settings)
      const updated = ctx.connections.update(current.id, { ...patch, ...(settings ? { settings } : {}) })
      // Review of the open's stop (minor 3): a name, a colour, a group, a star changes nothing of
      // what its clients, feeds and health were made of; they stay. Seventh review (nit): what
      // asks how it signs in meanwhile reads the new settings.
      const moved = settings !== undefined && !sameSettings(settings, current.settings)
      if (moved) {
        ctx.manager.rescope(current.id)
        // Fifth review (nit 1): what asks meanwhile is not answered with the old settings' refusal.
        ctx.manager.forgetRefusal(current.id)
      }
      // Written once the rest was accepted (a refused save leaves the policy as it was).
      if (aiPolicy && updated) ctx.connections.setAiPolicy(current.id, aiPolicy)
      if (aiAgentWrites !== undefined && updated) ctx.connections.setAiAgentWrites(current.id, aiAgentWrites)
      if (aiAgentToolsOff !== undefined && updated)
        ctx.connections.setAiAgentToolsOff(current.id, aiAgentToolsOff)
      // W7: another server or identity provider may answer now: everyone signs in again.
      if (moved) await ctx.oidc.forgetConnection(current.id)
      // Phase 3e-2 S9: a sync whose connection now points elsewhere waits for its owner's review.
      await ctx.liveSync.connectionChanged(current.id)
      if (moved) {
        // Phase 3e-1: feeds watched the old settings; they end and say so (before the client closes).
        await ctx.watch.closeFor(current.id, 'connection')
        await ctx.manager.invalidate(current.id)
        // W3 review (M9): another server may answer now; its health is checked afresh.
        ctx.health.forget(current.id)
      }
      // Any open shell was opened under the old settings (read-only, target host); close it so no
      // command runs under stale rules (spec §6, Review Focus 5). The hub also re-checks per command.
      if (moved || (patch.readOnly !== undefined && patch.readOnly !== current.readOnly))
        await ctx.shell.closeFor({ connectionId: current.id }, 'access')
      // Another server may sit behind the same id now: its old previews are stale (phase 2a).
      if (moved) ctx.aggregation.cache.bump(connectionScope(current.id))
      if (!updated) throw Errors.notFound('Connection not found')
      return dto(request, updated)
    },
  )

  app.delete(
    '/connections/:id',
    {
      preHandler: [requireConnection('connections:read'), manage],
      config: { masking: 'names-only', audit: 'connections.delete' },
    },
    async (request, reply) => {
      const id = request.connection!.id
      // W3 review (I1): the alerts its deletion causes still say which connection it was.
      ctx.alerts.remember(id, request.connection!.name)
      // W7, security review Minor 3: its sign-ins are revoked at the provider before the cascade
      // drops them (and its waiting sign-ins end).
      await ctx.oidc.forgetConnection(id)
      ctx.connections.delete(id)
      // W3 review (M9): no stale health is shown for it.
      ctx.health.forget(id)
      // W1 review (minor 2): every user's pins of its saved queries go with it.
      forgetConnectionPins(ctx.preferences, id)
      // Phase 3e-2 plan ruling 6: its syncs stop (the targets keep their data).
      await ctx.liveSync.connectionDeleted(id)
      // Phase 3b §6: its history went with it; the recorder lets go of its timer.
      ctx.historyRecorder.sync()
      await ctx.watch.closeFor(id, 'access')
      await ctx.manager.invalidate(id)
      await ctx.shell.closeFor({ connectionId: id }, 'access')
      return reply.status(204).send()
    },
  )

  app.post(
    '/connections/:id/test',
    {
      preHandler: requireConnection('connections:read'),
      config: { masking: 'names-only', audit: 'connections.test' },
    },
    async (request) => test(request, request.connection!.settings, request.connection!.id),
  )

  app.get(
    '/connections/:id/grants',
    {
      preHandler: [requireTeamMode, requireConnection('connections:read'), requirePermission('users:manage')],
      config: { masking: 'names-only' },
    },
    async (request) => ctx.grants.list(request.connection!.id),
  )

  app.put(
    '/connections/:id/grants/:userId',
    {
      preHandler: [requireTeamMode, requireConnection('connections:read'), requirePermission('users:manage')],
      config: { masking: 'names-only', audit: 'connections.grant' },
    },
    async (request, reply) => {
      const { userId } = parseInput(GrantParams, request.params)
      const { role, shell, masked, export: exports } = parseInput(GrantBody, request.body)
      if (!ctx.users.findById(userId)) throw Errors.notFound('User not found')
      const connectionId = request.connection!.id
      // Phase 3b §2.2: a user who may not see personal data never gets the shell, where code runs.
      // Checked against the flags the grant will have, before anything is stored.
      const current = ctx.grants.list(connectionId).find((g) => g.userId === userId)
      if (role !== null && (shell ?? current?.shell ?? false) && (masked ?? current?.masked ?? false))
        throw Errors.conflict('A user who cannot see personal data cannot use the shell', {
          reason: 'masked_shell',
        })
      ctx.grants.set(connectionId, userId, role)
      // The flags live on the grant row, so set them after the role (which may have created it).
      if (masked !== undefined && role !== null) ctx.grants.setMasked(connectionId, userId, masked)
      if (shell !== undefined && role !== null) ctx.grants.setShell(connectionId, userId, shell)
      if (exports !== undefined && role !== null) ctx.grants.setExport(connectionId, userId, exports)
      // The role or shell grant just changed; close that user's open shells on this connection so
      // none keeps running under the old grant (spec §6). The hub also re-checks per command.
      await ctx.shell.closeFor({ connectionId: request.connection!.id, userId }, 'access')
      request.auditInfo = { details: { userId, role, shell, masked, export: exports } }
      return reply.status(204).send()
    },
  )
}
