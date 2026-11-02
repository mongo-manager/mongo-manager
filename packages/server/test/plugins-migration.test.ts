import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { MIGRATIONS } from '../src/store/migrations'
import { PluginRepo } from '../src/plugins/repo'

// Review 2026-10-11: migration 32 marks the bundled updates that kept their approval before it.
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the plugins table, migrated', () => {
  it('marks as carried only an enabled bundled update approved for its files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-plugins-mig-'))
    dirs.push(dir)
    const before = await openStore(
      dir,
      MIGRATIONS.filter((m) => m.version <= 31),
    )
    const insert = before.db.prepare(
      `INSERT INTO plugins (id, source, manifest, digest, files, bytes, error, enabled, approved_permissions,
         approved_digest, settings, installed_by, installed_at, updated_at, updated_from)
       VALUES (?, ?, NULL, ?, '{}', 0, NULL, ?, '[]', ?, '{}', NULL, 0, 0, ?)`,
    )
    insert.run('carried', 'bundled', 'd1', 1, 'd1', '1.0.0')
    insert.run('waiting', 'bundled', 'd2', 0, 'd0', '1.0.0')
    insert.run('approved', 'bundled', 'd3', 1, 'd3', null)
    insert.run('uploaded', 'upload', 'd4', 1, 'd4', '1.0.0')
    before.close()
    const after = await openStore(dir)
    const repo = new PluginRepo(after.db, () => 0)
    expect(Object.fromEntries(repo.list().map((r) => [r.id, r.approvalCarried]))).toEqual({
      approved: false,
      carried: true,
      uploaded: false,
      waiting: false,
    })
    after.close()
  })

  // Review 2026-10-13 of the hint tooltips (M7): a manifest stored before cell renderers had a
  // display reads as it always showed — beside the value.
  it('reads a stored cell renderer without a display as one shown beside the value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-plugins-display-'))
    dirs.push(dir)
    const store = await openStore(dir)
    const manifest = {
      id: 'old',
      name: { en: 'Old' },
      version: '1.0.0',
      entry: 'index.html',
      permissions: ['documents:read'],
      contributes: {
        collectionTabs: [],
        documentActions: [],
        sidebarPanels: [],
        cellRenderers: [
          { id: 'a', match: 'objectId' },
          { id: 'b', match: 'number', display: 'tooltip' },
        ],
      },
    }
    store.db
      .prepare(
        `INSERT INTO plugins (id, source, manifest, digest, files, bytes, error, enabled, approved_permissions,
           approved_digest, settings, installed_by, installed_at, updated_at, updated_from)
         VALUES ('old', 'upload', ?, 'd', '{}', 0, NULL, 1, '[]', 'd', '{}', NULL, 0, 0, NULL)`,
      )
      .run(JSON.stringify(manifest))
    const repo = new PluginRepo(store.db, () => 0)
    expect(repo.list()[0]!.manifest!.contributes.cellRenderers.map((r) => r.display)).toEqual([
      'inline',
      'tooltip',
    ])
    store.close()
  })
})
