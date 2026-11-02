import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PluginApproveSchema, PluginGithubInstallSchema, PluginIdSchema } from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth, requirePermission } from '../http/guards'
import { PAGE_TICKET_MS, sealSession, signTicket } from '../plugins/frame'
import { fetchGithubRelease, parseGithubRef } from '../plugins/github'
import { riskToAccept } from '../plugins/service'

const IdParams = z.strictObject({ pluginId: PluginIdSchema })
/** A README's language (2026-10-11): a two-letter code, nothing that names another file. */
const ReadmeQuery = z.strictObject({
  lang: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
})
const SettingsBody = z.strictObject({ values: z.unknown() })
/** An uploaded plugin's `.tgz`: a little over what a plugin may hold, compressed. */
const UPLOAD_BYTES = 30 * 1024 * 1024
const ARCHIVE_TYPES = ['application/gzip', 'application/x-gzip', 'application/octet-stream']

/**
 * Phase 4b §2: the plugins. Every signed-in user's app learns which run and what they add;
 * administrators (`settings:manage`) see them all, upload, scan, approve, disable, set up and remove
 * them — each change audited, never a file's content.
 */
export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const plugins = ctx.plugins
  const admin = requirePermission('settings:manage')

  app.get('/plugins', { preHandler: requireAuth }, async () => plugins.runtime())

  // Phase 4b §3: a frame ticket for a plugin that runs (its page loads within ten minutes).
  app.get('/plugins/:pluginId/ticket', { preHandler: requireAuth }, async (request) => {
    const { pluginId } = parseInput(IdParams, request.params)
    const running = plugins.runtime().find((p) => p.id === pluginId)
    const row = running ? plugins.get(pluginId) : null
    if (!running || !row?.approvedDigest) throw Errors.notFound('Plugin not found')
    const issued = ctx.now()
    // Security audit 2026-10-16: good only while this session lasts (signed out, it is refused).
    const principal = request.principal
    const ticket = signTicket(ctx.pluginFrameKey, {
      p: row.id,
      v: running.version,
      d: row.approvedDigest,
      i: issued,
      s: principal?.kind === 'user' ? sealSession(ctx.pluginFrameKey, principal.sessionIdHash) : '',
    })
    return { base: `plugin-frame/${ticket}/`, entry: running.entry, expiresAt: issued + PAGE_TICKET_MS }
  })

  // User request 2026-10-10: a plugin's README for its details page (administrators, as the rest).
  app.get('/plugins/:pluginId/readme', { preHandler: admin }, async (request) => {
    const { pluginId } = parseInput(IdParams, request.params)
    const { lang } = parseInput(ReadmeQuery, request.query)
    return plugins.readme(pluginId, lang)
  })

  app.get('/plugins/manage', { preHandler: admin }, async () => ({
    enabled: plugins.enabled,
    github: plugins.enabled && ctx.config.pluginsGithub,
    plugins: plugins.adminList(),
  }))

  // User request 2026-10-11: a plugin from a public GitHub repository's release, installed as an
  // upload is (disabled, scanned, waiting for approval). The address is checked before reaching out.
  app.post(
    '/plugins/github',
    { preHandler: admin, config: { audit: 'plugins.github' } },
    async (request, reply) => {
      const { url } = parseInput(PluginGithubInstallSchema, request.body)
      if (!ctx.config.pluginsGithub)
        throw Errors.forbidden('Installing plugins from GitHub is turned off on this server', {
          reason: 'github_off',
        })
      const ref = parseGithubRef(url)
      request.auditInfo = { details: { repository: `${ref.owner}/${ref.repo}`, release: ref.tag } }
      plugins.assertOn()
      const { archive, origin } = await fetchGithubRelease(ctx.pluginsEgress, ref, UPLOAD_BYTES)
      const by = request.principal?.kind === 'user' ? request.principal.userId : null
      const view = await plugins.install(archive, by, origin)
      request.auditInfo = {
        details: {
          repository: origin.repository,
          release: origin.release,
          asset: origin.asset,
          id: view.id,
          version: view.manifest?.version,
          digest: view.digest,
        },
      }
      return reply.status(201).send(view)
    },
  )

  app.post('/plugins/scan', { preHandler: admin, config: { audit: 'plugins.scan' } }, async (request) => {
    const found = await plugins.scan()
    request.auditInfo = { details: { found } }
    return { enabled: plugins.enabled, plugins: plugins.adminList() }
  })

  // A plugin archive arrives as raw bytes, bounded, buffered in memory. Security audit 2026-10-16
  // (Important 1): its parser lives in a scope of its own holding this one route, and the caller is
  // checked on the request's head (onRequest) — no one else's 30 MiB is ever read.
  await app.register(async (upload) => {
    upload.addContentTypeParser(
      ARCHIVE_TYPES,
      { parseAs: 'buffer', bodyLimit: UPLOAD_BYTES },
      (_r, body, done) => done(null, body),
    )
    upload.put(
      '/plugins',
      { onRequest: admin, bodyLimit: UPLOAD_BYTES, config: { audit: 'plugins.upload' } },
      async (request, reply) => {
        const type = String(request.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim()
        if (!ARCHIVE_TYPES.includes(type) || !Buffer.isBuffer(request.body)) throw Errors.unsupportedType()
        const by = request.principal?.kind === 'user' ? request.principal.userId : null
        const view = await plugins.install(request.body, by)
        request.auditInfo = {
          details: {
            id: view.id,
            version: view.manifest?.version,
            digest: view.digest,
            enabled: view.enabled,
          },
        }
        return reply.status(201).send(view)
      },
    )
  })

  app.post(
    '/plugins/:pluginId/approve',
    { preHandler: admin, config: { audit: 'plugins.approve' } },
    async (request) => {
      const { pluginId } = parseInput(IdParams, request.params)
      const { digest, acceptRisk } = parseInput(PluginApproveSchema, request.body)
      request.auditInfo = { details: { id: pluginId, digest } }
      const view = await plugins.approve(pluginId, digest, acceptRisk)
      request.auditInfo = {
        details: {
          id: pluginId,
          version: view.manifest?.version,
          digest,
          permissions: view.approvedPermissions,
          scan: view.scan?.counts ?? null,
          riskAccepted: acceptRisk === pluginId && riskToAccept(view),
        },
      }
      return view
    },
  )

  app.post(
    '/plugins/:pluginId/disable',
    { preHandler: admin, config: { audit: 'plugins.disable' } },
    async (request) => {
      const { pluginId } = parseInput(IdParams, request.params)
      request.auditInfo = { details: { id: pluginId } }
      return plugins.disable(pluginId)
    },
  )

  app.put(
    '/plugins/:pluginId/settings',
    { preHandler: admin, config: { audit: 'plugins.settings' } },
    async (request) => {
      const { pluginId } = parseInput(IdParams, request.params)
      const { values } = parseInput(SettingsBody, request.body)
      request.auditInfo = {
        details: {
          id: pluginId,
          keys: values && typeof values === 'object' ? Object.keys(values).slice(0, 10) : [],
        },
      }
      return plugins.setSettings(pluginId, values)
    },
  )

  app.delete(
    '/plugins/:pluginId',
    { preHandler: admin, config: { audit: 'plugins.remove' } },
    async (request, reply) => {
      const { pluginId } = parseInput(IdParams, request.params)
      request.auditInfo = { details: { id: pluginId } }
      const row = await plugins.remove(pluginId)
      request.auditInfo = { details: { id: pluginId, version: row.manifest?.version, source: row.source } }
      return reply.status(204).send()
    },
  )
}
