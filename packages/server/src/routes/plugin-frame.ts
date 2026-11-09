// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { PluginPathSchema } from '@mongo-manager/shared'
import { Errors } from '../errors'
import { safeEqual } from '../http/security'
import { sha256 } from '../plugins/folder'
import {
  ASSET_TICKET_MS,
  PAGE_TICKET_MS,
  frameCsp,
  isPage,
  openSession,
  readTicket,
  typeOf,
} from '../plugins/frame'
import { approvedCurrent } from '../plugins/service'

/** Verified plugin files kept in memory, up to this many bytes in all. */
const CACHE_BYTES = 64 * 1024 * 1024

/**
 * Phase 4b §3: a plugin's files for its sandboxed frame, at `<base>/plugin-frame/<ticket>/<path>`.
 * No cookie: the ticket (signed, short-lived) names the plugin, the files approved and the session it
 * was issued in, which must still be live. Served only
 * while the plugin is enabled and approved for those files, each checked against its approved
 * SHA-256 as it is read; with the frame's own policy.
 */
export async function pluginFrameRoutes(app: FastifyInstance, opts: { key: Buffer }): Promise<void> {
  const { ctx } = app
  const cache = new Map<string, Buffer>()
  let cached = 0

  app.get('/plugin-frame/:ticket/*', async (request, reply) => {
    const { ticket: text, '*': rawPath } = request.params as { ticket: string; '*': string }
    const ticket = readTicket(opts.key, text)
    const refused = () => Errors.forbidden('This plugin frame is not available')
    if (!ticket) throw refused()
    // Security audit 2026-10-16: only while the session it was issued in lasts (not counted as its
    // activity: the frame's files never keep a session alive). The frame sends no cookie (an opaque
    // origin), so the ticket names its session, sealed.
    if (ctx.config.auth) {
      const idHash = openSession(opts.key, ticket.s)
      // A session renewed in place by the same user (review I5) is followed; a sign-out is not.
      const session = idHash ? ctx.sessions.peekRenewed(idHash) : undefined
      const user = session ? ctx.users.findById(session.userId) : undefined
      if (!user || user.disabled) throw refused()
    }
    // Security review 2026-10-13 (low): the app's policy allows its origin's scripts, and these files
    // are on that origin. The sandboxed frame is an opaque origin, so its own requests are cross-site;
    // a page of the app may open the frame, never load its files as its own.
    const site = request.headers['sec-fetch-site']
    const dest = request.headers['sec-fetch-dest']
    if ((site === 'same-origin' || site === 'same-site') && dest !== 'iframe' && dest !== 'document')
      throw refused()
    const row = ctx.plugins.enabled ? ctx.plugins.get(ticket.p) : null
    // The plugin as the ticket knew it: still enabled, approved for the same files.
    if (
      !row ||
      !row.enabled ||
      !approvedCurrent(row) ||
      row.manifest!.version !== ticket.v ||
      !safeEqual(row.approvedDigest!, ticket.d)
    )
      throw refused()
    const path = rawPath ?? ''
    const type = typeOf(path)
    const age = ctx.now() - ticket.i
    // A page (html in any case, svg) loads within the short window; its later files within the long.
    if (age < 0 || age > (isPage(type) ? PAGE_TICKET_MS : ASSET_TICKET_MS)) throw refused()
    const expected =
      PluginPathSchema.safeParse(path).success && Object.hasOwn(row.files, path) ? row.files[path] : undefined
    if (!expected) throw Errors.notFound('No such file in this plugin')
    const key = `${row.id}\u0000${path}\u0000${expected}`
    let data = cache.get(key)
    if (!data) {
      // Inside the plugin's own folder, whatever the path (CodeQL 2026-11-01): the schema and the
      // approved list already allow nothing else; this says so where the file is read.
      const dir = resolve(ctx.plugins.dirOf(row))
      const file = resolve(dir, ...path.split('/'))
      if (!file.startsWith(dir + sep)) throw Errors.notFound('No such file in this plugin')
      const read = await readFile(file).catch(() => null)
      // Changed on disk since it was approved: never served (a scan disables the plugin).
      if (!read || !safeEqual(sha256(read), expected)) {
        request.log.warn({ plugin: row.id, path }, 'plugin file differs from the approved one')
        throw Errors.notFound('No such file in this plugin')
      }
      data = read
      if (cached + data.length > CACHE_BYTES) {
        cache.clear()
        cached = 0
      }
      cache.set(key, data)
      cached += data.length
    }
    // The policy names this ticket's folder of files on the address the browser used.
    const host = request.host
    if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host)) throw Errors.validation('Not a host')
    const route = request.url.split('?')[0]!
    const own = `${request.protocol === 'https' ? 'https' : 'http'}://${host}${route.slice(0, route.indexOf(text) + text.length)}/`
    return (
      reply
        .header('content-type', type)
        .header('content-security-policy', frameCsp(row.manifest!, row.settings, own))
        .header('x-frame-options', 'SAMEORIGIN')
        .header('cross-origin-resource-policy', 'cross-origin')
        .header('access-control-allow-origin', '*')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        // Security audit 2026-10-16: a name looked up ahead is a request connect-src never sees.
        .header('x-dns-prefetch-control', 'off')
        // Review of the security pass (Minor): never kept by the browser — signed out, a file is asked
        // for again and refused (a ticket is a page's own address anyway: nothing to share).
        .header('cache-control', 'no-store')
        .send(data)
    )
  })
}
