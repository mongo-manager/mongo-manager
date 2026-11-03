import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { PluginManifestSchema } from '@mongo-manager/shared'
import { PluginRepo, type PluginRow } from '../../src/plugins/repo'

/**
 * User request 2026-11-02: the SQL import and export pages run with the SQL → MongoDB plugin. The
 * tests of those pages turn it on as an administrator would have: its real manifest, enabled and
 * approved for its files. `over` turns it the other ways a row can be: off, or changed since approved.
 */
export function runSqlPlugin(app: FastifyInstance, over: Partial<PluginRow> = {}): void {
  const manifest = PluginManifestSchema.parse(
    JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          '..',
          '..',
          '..',
          'plugins',
          'sql-to-mongodb',
          'public',
          'mongo-manager-plugin.json',
        ),
        'utf8',
      ),
    ),
  )
  new PluginRepo(app.ctx.store.db, () => 1).put({
    id: manifest.id,
    source: 'bundled',
    manifest,
    digest: 'a'.repeat(64),
    files: {},
    bytes: 0,
    error: null,
    enabled: true,
    approvedPermissions: manifest.permissions,
    approvedDigest: 'a'.repeat(64),
    settings: {},
    installedBy: null,
    installedAt: 1,
    updatedFrom: null,
    scan: null,
    origin: null,
    approvalCarried: false,
    ...over,
  })
}
