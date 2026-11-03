import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { openRegularFile } from '../open-regular'
import { join, resolve, sep } from 'node:path'
import {
  PLUGIN_MANIFEST,
  PLUGIN_MAX_BYTES,
  PluginIdSchema,
  compareVersions,
  PluginSettingsValuesSchema,
  cspImageSource,
  pluginSettingsSchema,
  type PluginAdminView,
  type PluginManifest,
  type PluginOrigin,
  type PluginPermission,
  type PluginRuntimeView,
  type PluginScan,
  type PluginSource,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { safeEqual } from '../http/security'
import { readPluginArchive } from './archive'
import { checkManifest, readPluginFolder, sha256 } from './folder'
import type { PluginRepo, PluginRow } from './repo'

/** A plugin's README: its name in the plugin's folder (one a language: README.tr.md), how much is shown. */
const README = 'README.md'
const readmeIn = (lang: string) => `README.${lang}.md`
const README_BYTES = 64 * 1024
/** The text shown, cut on a character, never inside one (review M5). */
function upTo(bytes: Buffer, max: number): { text: string; truncated: boolean } {
  if (bytes.length <= max) return { text: new TextDecoder('utf-8').decode(bytes), truncated: false }
  let end = max
  // Back to the first byte of the character the cut would split (UTF-8 continuation bytes 10xxxxxx).
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return { text: new TextDecoder('utf-8').decode(bytes.subarray(0, end)), truncated: true }
}

export interface PluginServiceDeps {
  repo: PluginRepo
  /** `<data-dir>/plugins`: folders placed by hand, and uploads. */
  userRoot: string
  /** Plugins shipped with the build (phase 4b §4), when there are any. */
  bundledRoot?: string
  /** MM_PLUGINS: off, nothing is found, installed or run. */
  enabled: boolean
  now: () => number
  warn: (message: string, details?: object) => void
  /** A bundled plugin's approval moved to its new files (audited: no administrator did it). */
  updated?: (details: {
    id: string
    from: string | null
    to: string
    fromDigest: string | null
    digest: string
    permissions: PluginPermission[]
  }) => void
}

/** Stored values the manifest still declares, each still of its type (a new version may differ). */
function keptSettings(
  manifest: PluginManifest,
  stored: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const schema = pluginSettingsSchema(manifest.settings)
  return Object.fromEntries(
    Object.entries(stored).filter(
      ([key, value]) =>
        schema.safeParse({ [key]: value }).success ||
        // Review of the security pass (Minor): an address an earlier version took (plain http to any
        // host) is kept for its administrators to see and replace; no frame is given it (usable()).
        (Object.hasOwn(manifest.settings, key) &&
          manifest.settings[key]!.type === 'url' &&
          typeof value === 'string' &&
          value.length <= 500),
    ),
  )
}

/** The settings a frame is given: an address no longer taken is left out (see keptSettings). */
function usable(
  manifest: PluginManifest,
  settings: Record<string, string | boolean>,
): Record<string, string | boolean> {
  return Object.fromEntries(
    Object.entries(settings).filter(
      ([key, value]) =>
        !Object.hasOwn(manifest.settings, key) ||
        manifest.settings[key]!.type !== 'url' ||
        (typeof value === 'string' && cspImageSource(value) !== null),
    ),
  )
}

/** Whether two digests name the same files: compared in constant time; none is none. */
const sameFiles = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : safeEqual(a, b)

/** Whether a plugin may run: approved for its very files, nothing wrong with them. */
export const approvedCurrent = (row: PluginRow) =>
  row.approvedDigest !== null &&
  row.digest !== null &&
  safeEqual(row.approvedDigest, row.digest) &&
  !row.error &&
  !!row.manifest

/**
 * Phase 4b §2: the plugins — found in their folders at start-up and on "Scan again", installed from
 * an administrator's `.tgz`, approved for the files shown, disabled, set up and removed. One change
 * at a time. A plugin runs only while it is enabled and approved for the files it has now.
 */
/**
 * Whether approving it needs its id typed (user request 2026-10-11): a high finding, or no scan at
 * all (review 2026-10-11), in a plugin not shipped with the app — which is the app's own code.
 */
export const riskToAccept = (p: { source: PluginSource; scan: PluginScan | null }): boolean =>
  p.source !== 'bundled' && (!p.scan || p.scan.counts.high > 0)

/** User request 2026-11-02: SQL import and export (pages, routes, the agent's SQL export) are this plugin's. */
export const SQL_PLUGIN = 'sql-to-mongodb'

export class PluginService {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly deps: PluginServiceDeps) {}

  get enabled(): boolean {
    return this.deps.enabled
  }

  /** One change at a time: a scan never sees an install half done. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  assertOn(): void {
    if (!this.deps.enabled) throw Errors.forbidden('Plugins are turned off on this server (MM_PLUGINS=0)')
  }

  private rootOf(source: PluginSource): string {
    return source === 'bundled' ? this.deps.bundledRoot! : this.deps.userRoot
  }

  /** The folder of a plugin: its id is plain, so it stays inside its root. */
  dirOf(row: Pick<PluginRow, 'id' | 'source'>): string {
    return join(this.rootOf(row.source), PluginIdSchema.parse(row.id))
  }

  /** Reads a plugin's folder again and stores what it holds; changed files disable it. */
  /** `origin`: where an install came from (kept until the plugin is installed again). */
  private async refresh(
    id: string,
    source: PluginSource,
    installedBy?: string | null,
    origin?: PluginOrigin | null,
  ): Promise<PluginRow> {
    const found = await readPluginFolder(join(this.rootOf(source), id), id)
    const row = this.deps.repo.get(id)
    const next = {
      id,
      source,
      manifest: found.manifest,
      digest: found.digest,
      files: found.files,
      bytes: found.bytes,
      error: found.error,
      enabled: false,
      approvedPermissions: row?.approvedPermissions ?? [],
      approvedDigest: row?.approvedDigest ?? null,
      settings: found.manifest ? keptSettings(found.manifest, row?.settings ?? {}) : (row?.settings ?? {}),
      installedBy: installedBy !== undefined ? installedBy : (row?.installedBy ?? null),
      installedAt: installedBy !== undefined || !row ? this.deps.now() : row.installedAt,
      scan: found.scan,
      origin: installedBy !== undefined ? (origin ?? null) : (row?.origin ?? null),
      // Kept while the files are the same; set again only by a carry below.
      approvalCarried: !!row?.approvalCarried && sameFiles(row.digest, found.digest),
    }
    // User request 2026-10-10: a plugin shipped with the app, approved before, keeps its approval
    // through an update asking for nothing more (its approval moves to the new files). Anything
    // else — a new permission, a folder or an uploaded plugin — waits for an administrator.
    const carried =
      // Only a bundled plugin's own approval (review I1): never one given to a folder or an upload
      // that had its id.
      source === 'bundled' &&
      row?.source === 'bundled' &&
      // Only while it runs (user report 2026-10-11): one an administrator turned off, or never
      // turned on, waits for them with its new files.
      row.enabled &&
      !!row.approvedDigest &&
      !!found.manifest &&
      !!found.digest &&
      !found.error &&
      !safeEqual(row.approvedDigest, found.digest) &&
      found.manifest.permissions.every((p) => row.approvedPermissions.includes(p))
    let updatedFrom = row?.updatedFrom ?? null
    let moved: Parameters<NonNullable<PluginServiceDeps['updated']>>[0] | null = null
    if (carried) {
      next.approvalCarried = true
      next.approvedDigest = found.digest
      // Exactly what it asks for now (review I2): a permission it dropped never comes back unasked.
      next.approvedPermissions = [...found.manifest!.permissions]
      const before = row.manifest?.version ?? null
      // An update, not a step back (review M10).
      if (before !== found.manifest!.version)
        updatedFrom = before && compareVersions(found.manifest!.version, before) > 0 ? before : null
      moved = {
        id,
        from: before,
        to: found.manifest!.version,
        fromDigest: row.approvedDigest,
        digest: found.digest!,
        permissions: next.approvedPermissions,
      }
    } else if (row && !sameFiles(row.digest, found.digest)) {
      // A bundled plugin's update is said even when it waits for approval: what changed is shown.
      const before = row.manifest?.version ?? null
      const after = found.manifest?.version ?? null
      updatedFrom =
        source === 'bundled' &&
        row.source === 'bundled' &&
        before &&
        after &&
        compareVersions(after, before) > 0
          ? before
          : null
    }
    next.enabled = !!row?.enabled && approvedCurrent({ ...next, updatedAt: 0, updatedFrom })
    const stored = this.deps.repo.put({ ...next, updatedFrom })
    // Audited once it holds (review M7).
    if (moved) this.deps.updated?.(moved)
    return stored
  }

  private async folders(root: string | undefined): Promise<string[]> {
    if (!root || !existsSync(root)) return []
    return (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && PluginIdSchema.safeParse(e.name).success)
      .map((e) => e.name)
  }

  /** Finds every plugin folder; those gone are kept, disabled, saying so. Leftovers of an install go. */
  scan(): Promise<number> {
    return this.serial(async () => {
      if (!this.deps.enabled) return 0
      if (existsSync(this.deps.userRoot))
        for (const e of await readdir(this.deps.userRoot, { withFileTypes: true })) {
          if (!e.isDirectory()) continue
          const leftover = join(this.deps.userRoot, e.name)
          // A crash between the swap's two steps: the plugin moved aside comes back (4b review M7).
          const old = /^\.old-([a-z0-9-]+)\.[0-9a-f-]+$/.exec(e.name)
          if (
            old &&
            PluginIdSchema.safeParse(old[1]).success &&
            !existsSync(join(this.deps.userRoot, old[1]!))
          )
            await rename(leftover, join(this.deps.userRoot, old[1]!))
          else if (old || /^\.staging-/.test(e.name)) await rm(leftover, { recursive: true, force: true })
        }
      const bundled = new Set(await this.folders(this.deps.bundledRoot))
      const seen = new Set<string>()
      for (const id of bundled) {
        await this.refresh(id, 'bundled')
        seen.add(id)
      }
      for (const id of await this.folders(this.deps.userRoot)) {
        // A bundled plugin's id is its own: a folder of that name is not used.
        if (bundled.has(id)) {
          this.deps.warn('a plugin folder has the id of a bundled plugin and is not used', { id })
          continue
        }
        await this.refresh(id, this.deps.repo.get(id)?.source === 'upload' ? 'upload' : 'folder')
        seen.add(id)
      }
      for (const row of this.deps.repo.list())
        if (!seen.has(row.id))
          this.deps.repo.put({
            ...row,
            enabled: false,
            digest: null,
            files: {},
            error: 'The plugin folder is gone',
            scan: null,
          })
      return seen.size
    })
  }

  /** Installs (or replaces) an uploaded plugin, disabled unless these very files were approved. */
  install(archive: Buffer, by: string | null, origin: PluginOrigin | null = null): Promise<PluginAdminView> {
    this.assertOn()
    return this.serial(async () => {
      const entries = readPluginArchive(archive)
      const manifestText = entries.find((e) => e.path === PLUGIN_MANIFEST)?.data
      const id = (() => {
        try {
          return PluginIdSchema.parse(JSON.parse(manifestText?.toString('utf8') ?? '{}').id)
        } catch {
          throw Errors.validation('The manifest has no valid id')
        }
      })()
      try {
        checkManifest(manifestText, id, new Set(entries.map((e) => e.path)))
      } catch (e) {
        throw Errors.validation((e as Error).message)
      }
      const existing = this.deps.repo.get(id)
      const root = this.deps.userRoot
      const target = join(root, id)
      if (existing?.source === 'bundled' || (await this.folders(this.deps.bundledRoot)).includes(id))
        throw Errors.conflict('A plugin shipped with Mongo Manager has this id')
      if ((existing && existing.source !== 'upload') || (!existing && existsSync(target)))
        throw Errors.conflict('A plugin folder of this id is managed by hand on the server')
      // Written beside, then swapped in: a failed install leaves the plugin as it was.
      await mkdir(root, { recursive: true })
      const staging = join(root, `.staging-${id}.${randomUUID()}`)
      const old = join(root, `.old-${id}.${randomUUID()}`)
      try {
        await mkdir(staging)
        const base = resolve(staging) + sep
        for (const e of entries) {
          const file = resolve(staging, ...e.path.split('/'))
          if (!file.startsWith(base)) throw Errors.validation('Not a plain path in a plugin')
          await mkdir(resolve(file, '..'), { recursive: true })
          await writeFile(file, e.data, { flag: 'wx', mode: 0o644 })
        }
        if (existsSync(target)) await rename(target, old)
        await rename(staging, target)
      } catch (e) {
        await rm(staging, { recursive: true, force: true })
        if (existsSync(old) && !existsSync(target)) await rename(old, target)
        throw e
      }
      await rm(old, { recursive: true, force: true })
      return this.view(await this.refresh(id, 'upload', by, origin))
    })
  }

  private found(id: string): PluginRow {
    const row = this.deps.repo.get(id)
    if (!row) throw Errors.notFound('Plugin not found')
    return row
  }

  /** Enables a plugin for the permissions it asks, approved for the files the administrator saw. */
  /**
   * Approves a plugin for the files shown. One with a high finding (user request 2026-10-11) only
   * with its id typed — never a bare yes; a plugin shipped with the app is the app's own code.
   */
  approve(id: string, digest: string, acceptRisk?: string): Promise<PluginAdminView> {
    this.assertOn()
    return this.serial(async () => {
      const row = await this.refresh(id, this.found(id).source)
      // Broken, then changed, then risky (review 2026-10-11): the scan of files not seen is not asked
      // about. A plugin whose scan failed is approved only as one with a high finding is.
      if (row.error || !row.manifest)
        throw Errors.conflict(`This plugin cannot be used: ${row.error ?? 'no manifest'}`)
      if (row.digest === null || !safeEqual(row.digest, digest))
        throw Errors.conflict("The plugin's files changed: look at them again")
      if (riskToAccept(row) && acceptRisk !== id)
        throw Errors.conflict('Its security scan found high risks: type its id to accept them', {
          reason: 'risk_not_accepted',
        })
      return this.view(
        this.deps.repo.put({
          ...row,
          enabled: true,
          approvedPermissions: [...row.manifest.permissions],
          approvedDigest: digest,
          approvalCarried: false,
        }),
      )
    })
  }

  disable(id: string): Promise<PluginAdminView> {
    return this.serial(async () => this.view(this.deps.repo.put({ ...this.found(id), enabled: false })))
  }

  /** Values for the settings its manifest declares, each of its type. */
  setSettings(id: string, values: unknown): Promise<PluginAdminView> {
    this.assertOn()
    return this.serial(async () => {
      const row = this.found(id)
      if (!row.manifest) throw Errors.conflict('This plugin has no valid manifest')
      const bounded = PluginSettingsValuesSchema.safeParse(values)
      const checked = bounded.success
        ? pluginSettingsSchema(row.manifest.settings).safeParse(bounded.data)
        : bounded
      if (!checked.success)
        throw Errors.validation('Settings not valid for this plugin', checked.error.issues.slice(0, 5))
      const settings = Object.fromEntries(
        Object.entries(checked.data as Record<string, unknown>).filter(
          ([, v]) => v !== undefined && v !== '',
        ),
      ) as Record<string, string | boolean>
      return this.view(this.deps.repo.put({ ...row, settings }))
    })
  }

  /** Forgets a plugin; an uploaded one's folder goes too. A bundled one is disabled, never removed. */
  remove(id: string): Promise<PluginRow> {
    return this.serial(async () => {
      const row = this.found(id)
      if (row.source === 'bundled')
        throw Errors.validation('A plugin shipped with Mongo Manager is disabled, not removed')
      if (row.source === 'upload') await rm(this.dirOf(row), { recursive: true, force: true })
      this.deps.repo.remove(id)
      return row
    })
  }

  get(id: string): PluginRow | null {
    return this.deps.repo.get(id)
  }

  view(row: PluginRow): PluginAdminView {
    const asked = row.manifest?.permissions ?? []
    return {
      id: row.id,
      source: row.source,
      manifest: row.manifest,
      digest: row.digest,
      fileCount: Object.keys(row.files).length,
      bytes: row.bytes,
      enabled: row.enabled && approvedCurrent(row),
      approvedPermissions: row.approvedPermissions,
      approvedCurrent: approvedCurrent(row),
      newPermissions: asked.filter((p) => !row.approvedPermissions.includes(p)),
      settings: row.settings,
      installedBy: row.installedBy,
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
      error: row.error,
      updatedFrom: row.updatedFrom,
      readme: Object.hasOwn(row.files, README),
      scan: row.scan,
      origin: row.origin,
      approvalCarried: row.approvalCarried,
    }
  }

  /**
   * A plugin's README, for its details page (user request 2026-10-10): in the reader's language when
   * the plugin has one (2026-10-11), else in English. Only the file the scan saw — a regular file
   * whose content still has the hash it had (review M4) — at most 64 KiB, cut on a character. Null
   * when there is none, or it changed or went since.
   */
  async readme(id: string, lang?: string): Promise<{ text: string | null; truncated: boolean }> {
    this.assertOn()
    const row = this.found(id)
    const name = lang && Object.hasOwn(row.files, readmeIn(lang)) ? readmeIn(lang) : README
    const expected = Object.hasOwn(row.files, name) ? row.files[name]! : null
    if (!expected) return { text: null, truncated: false }
    const path = join(this.rootOf(row.source), id, name)
    try {
      // Opened first, then checked: the size read is the opened file's (CodeQL 2026-11-01).
      const handle = await openRegularFile(path)
      if (!handle) return { text: null, truncated: false }
      try {
        if ((await handle.stat()).size > PLUGIN_MAX_BYTES) return { text: null, truncated: false }
        const bytes = await handle.readFile()
        if (!safeEqual(sha256(bytes), expected)) return { text: null, truncated: false }
        return upTo(bytes, README_BYTES)
      } finally {
        await handle.close()
      }
    } catch {
      return { text: null, truncated: false }
    }
  }

  adminList(): PluginAdminView[] {
    return this.deps.enabled ? this.deps.repo.list().map((r) => this.view(r)) : []
  }

  /** Whether a plugin runs: enabled and approved for its files (user request 2026-11-02, SQL pages). */
  runs(id: string): boolean {
    if (!this.deps.enabled) return false
    const row = this.deps.repo.get(id)
    return !!row && row.enabled && approvedCurrent(row)
  }

  /** The plugins that run: enabled, approved for their files, with the permissions approved. */
  runtime(): PluginRuntimeView[] {
    if (!this.deps.enabled) return []
    return this.deps.repo
      .list()
      .filter((r) => r.enabled && approvedCurrent(r))
      .map((r) => ({
        id: r.id,
        version: r.manifest!.version,
        name: r.manifest!.name,
        entry: r.manifest!.entry,
        permissions: r.manifest!.permissions.filter((p): p is PluginPermission =>
          r.approvedPermissions.includes(p),
        ),
        contributes: r.manifest!.contributes,
        settings: usable(r.manifest!, r.settings),
      }))
  }
}
