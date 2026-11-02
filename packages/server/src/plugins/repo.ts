import type { DatabaseSync } from 'node:sqlite'
import type { SecretBox } from '../crypto/secret-box'
import type {
  PluginManifest,
  PluginOrigin,
  PluginPermission,
  PluginScan,
  PluginSource,
} from '@mongo-manager/shared'

/** A plugin's stored state (table `plugins`, phase 4b §2). */
export interface PluginRow {
  id: string
  source: PluginSource
  manifest: PluginManifest | null
  digest: string | null
  files: Record<string, string>
  bytes: number
  error: string | null
  enabled: boolean
  approvedPermissions: PluginPermission[]
  approvedDigest: string | null
  settings: Record<string, string | boolean>
  installedBy: string | null
  installedAt: number
  updatedAt: number
  /** A bundled plugin's version before an update that kept its approval (user request 2026-10-10). */
  updatedFrom: string | null
  /** What its files were found to try (user request 2026-10-11). */
  scan: PluginScan | null
  /** Where it was installed from, when that was GitHub (user request 2026-10-11). */
  origin: PluginOrigin | null
  /** Its approval moved to these files on its own, as a bundled update (review 2026-10-11). */
  approvalCarried: boolean
}

interface Raw {
  id: string
  source: PluginSource
  manifest: string | null
  digest: string | null
  files: string
  bytes: number
  error: string | null
  enabled: number
  approved_permissions: string
  approved_digest: string | null
  settings: string
  installed_by: string | null
  installed_at: number
  updated_at: number
  updated_from: string | null
  scan: string | null
  origin: string | null
  approval_carried: number
}

/**
 * A manifest as stored, with what later versions of the schema give by default (review 2026-10-13
 * of the hint tooltips, M7): a cell renderer stored before it had a display is shown beside the value.
 */
function withDefaults(manifest: PluginManifest): PluginManifest {
  const renderers = manifest.contributes?.cellRenderers
  if (!Array.isArray(renderers)) return manifest
  return {
    ...manifest,
    contributes: {
      ...manifest.contributes,
      cellRenderers: renderers.map((r) => ({ ...r, display: r.display ?? 'inline' })),
    },
  }
}

/** Security audit 2026-10-16 (minor): a plugin's settings, sealed for that plugin alone. */
export const pluginSettingsContext = (id: string): string => `plugin-settings:${id}`
const SEALED = /^v1\./

const fromRaw = (r: Raw): PluginRow => ({
  id: r.id,
  source: r.source,
  manifest: r.manifest ? withDefaults(JSON.parse(r.manifest) as PluginManifest) : null,
  digest: r.digest,
  files: JSON.parse(r.files) as Record<string, string>,
  bytes: r.bytes,
  error: r.error,
  enabled: r.enabled === 1,
  approvedPermissions: JSON.parse(r.approved_permissions) as PluginPermission[],
  approvedDigest: r.approved_digest,
  settings: JSON.parse(r.settings) as Record<string, string | boolean>,
  installedBy: r.installed_by,
  installedAt: r.installed_at,
  updatedAt: r.updated_at,
  updatedFrom: r.updated_from ?? null,
  scan: r.scan ? (JSON.parse(r.scan) as PluginScan) : null,
  origin: r.origin ? (JSON.parse(r.origin) as PluginOrigin) : null,
  approvalCarried: r.approval_carried === 1,
})

export class PluginRepo {
  /**
   * `box`: security audit 2026-10-16 (minor) — settings are sealed at rest with the server's key (a
   * tile server address can carry an access token); rows an older version stored in the clear are
   * sealed now. Without it (tests of the store alone) they are stored and read as plain JSON.
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly box?: SecretBox,
  ) {
    if (!box) return
    const plain = this.db
      .prepare("SELECT id, settings FROM plugins WHERE settings NOT LIKE 'v1.%'")
      .all() as Array<{ id: string; settings: string }>
    const update = this.db.prepare('UPDATE plugins SET settings = ? WHERE id = ?')
    for (const row of plain) update.run(this.seal(row.id, row.settings), row.id)
  }

  private seal(id: string, json: string): string {
    return this.box ? this.box.seal(json, pluginSettingsContext(id)) : json
  }

  /**
   * Independent review of the security pass (minor): a row whose settings cannot be opened (another
   * key, damage) is that plugin's problem alone — shown as broken (disabled, its error saying why),
   * never a list that fails for every plugin.
   */
  private read(r: Raw): PluginRow {
    if (!SEALED.test(r.settings)) return fromRaw(r)
    try {
      if (!this.box) throw new Error('no key')
      return fromRaw({ ...r, settings: this.box.open(r.settings, pluginSettingsContext(r.id)) })
    } catch {
      return {
        ...fromRaw({ ...r, settings: '{}' }),
        enabled: false,
        error: 'Its settings could not be opened with this server’s key; set them up again',
      }
    }
  }

  list(): PluginRow[] {
    return (this.db.prepare('SELECT * FROM plugins ORDER BY id').all() as unknown as Raw[]).map((r) =>
      this.read(r),
    )
  }

  get(id: string): PluginRow | null {
    const r = this.db.prepare('SELECT * FROM plugins WHERE id = ?').get(id) as unknown as Raw | undefined
    return r ? this.read(r) : null
  }

  /** Inserts or replaces a plugin's whole state. */
  put(row: Omit<PluginRow, 'updatedAt'>): PluginRow {
    this.db
      .prepare(
        `INSERT INTO plugins (id, source, manifest, digest, files, bytes, error, enabled, approved_permissions,
           approved_digest, settings, installed_by, installed_at, updated_at, updated_from, scan, origin, approval_carried)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET source = excluded.source, manifest = excluded.manifest,
           digest = excluded.digest, files = excluded.files, bytes = excluded.bytes, error = excluded.error,
           enabled = excluded.enabled, approved_permissions = excluded.approved_permissions,
           approved_digest = excluded.approved_digest, settings = excluded.settings,
           installed_by = excluded.installed_by, installed_at = excluded.installed_at,
           updated_at = excluded.updated_at, updated_from = excluded.updated_from, scan = excluded.scan, origin = excluded.origin,
           approval_carried = excluded.approval_carried`,
      )
      .run(
        row.id,
        row.source,
        row.manifest ? JSON.stringify(row.manifest) : null,
        row.digest,
        JSON.stringify(row.files),
        row.bytes,
        row.error,
        row.enabled ? 1 : 0,
        JSON.stringify(row.approvedPermissions),
        row.approvedDigest,
        this.seal(row.id, JSON.stringify(row.settings)),
        row.installedBy,
        row.installedAt,
        this.now(),
        row.updatedFrom,
        row.scan ? JSON.stringify(row.scan) : null,
        row.origin ? JSON.stringify(row.origin) : null,
        row.approvalCarried ? 1 : 0,
      )
    return this.get(row.id)!
  }

  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM plugins WHERE id = ?').run(id).changes) > 0
  }
}
