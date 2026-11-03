import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { backup, type DatabaseSync } from 'node:sqlite'
import { z, type ZodType } from 'zod'
import {
  IMAGE_OLD_MS,
  RELEASE_PUBLIC_KEYS,
  ReleaseInfoSchema,
  compareReleaseVersions,
  parseReleaseVersion,
  readLastUpdate,
  readUpdateState,
  writeUpdateState,
  type ReleaseInfo,
  type UpdateDistribution,
  type UpdateOffer,
  type UpdateOfferReason,
  type UpdateStatus,
  type UpdaterOrigin,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { restrictPermissions } from '../store/db'
import type { Egress } from '../net/egress'
import { verifiedHome } from '../optional/modules'
import { CheckError, checkLatest, releasePage, type CheckedRelease } from './check'
import { downloadVersion } from './install'

/** What the service keeps its two settings in (the app's settings table). */
export interface SettingsStore {
  get<T>(key: string, schema: ZodType<T>, fallback: T): T
  set<T>(key: string, value: T): void
}

export interface UpdateServiceDeps {
  settings: SettingsStore
  /** Public addresses only, through MM_UPDATE_PROXY when set. */
  egress: Egress
  /** MM_UPDATES. */
  enabled: boolean
  keys?: readonly string[]
  now(): number
  dataDir: string
  /** The running version. */
  installed: string
  /** The launcher's word, when it started this program. */
  origin: UpdaterOrigin | null
  /** How it was installed, when no launcher started it. */
  fallbackDistribution: UpdateDistribution
  /** MM_IMAGE_VERSION, MM_IMAGE_CREATED (the Docker image's). */
  env: Record<string, string | undefined>
  nodeVersion: string
  /** The app's database, copied before the switch (install only). */
  db?: DatabaseSync
  /** Asks the launcher to start the app again (exit 75). */
  restart?: () => void
  /** Backups, transfers, imports and live syncs under way: an install asks first. */
  runningJobs?: () => number
  /** The moment every page gets to say the server is restarting (tests: 0). */
  restartDelayMs?: number
}

const SETTINGS_KEY = 'updates'
const CHECK_KEY = 'updates_check'
const DAY_MS = 86_400_000
/** The first daily check, after a start: the server settles first. */
const FIRST_CHECK_MS = 5 * 60_000

const Version = z.string().refine((v) => parseReleaseVersion(v) !== null)
const SettingsSchema = z.object({ auto: z.boolean() })
const CheckSchema = z.object({
  at: z.number(),
  outcome: z.enum(['current', 'available', 'failed']),
  reason: z.enum(['unreachable', 'rate_limited', 'bad_answer', 'signature', 'no_asset']).optional(),
  retryAt: z.number().optional(),
  latest: z
    .object({
      version: Version,
      publishedAt: z.string().max(40),
      notes: z.string().max(20_000),
      url: z.string().max(1000),
      info: ReleaseInfoSchema,
    })
    .nullable(),
})
type StoredCheck = z.infer<typeof CheckSchema>

/**
 * The updater's state (2026-11-03): the last check (kept across restarts, so a restart does not
 * check again), the daily check when an administrator turned it on, and what Update can do here.
 */
export class UpdateService {
  private timer: NodeJS.Timeout | null = null
  private started = false
  private running: Promise<UpdateStatus> | null = null
  progress: UpdateStatus['progress'] = null
  /** The install under way (tests await it). */
  installing: Promise<void> | null = null
  private failure: UpdateStatus['installFailure'] = undefined
  private readonly restartingListeners = new Set<(version: string) => void>()

  constructor(readonly deps: UpdateServiceDeps) {}

  private get keys(): readonly string[] {
    return this.deps.keys ?? RELEASE_PUBLIC_KEYS
  }

  /** Off by MM_UPDATES, or no key to check a release with (a fork that emptied the list). */
  get disabled(): boolean {
    return !this.deps.enabled || this.keys.length === 0
  }

  get distribution(): UpdateDistribution {
    const o = this.deps.origin
    if (!o) return this.deps.fallbackDistribution
    if (o.distribution === 'bundle') return verifiedHome(o.installDir) ? 'npm' : 'copy'
    return o.distribution
  }

  get auto(): boolean {
    return this.deps.settings.get(SETTINGS_KEY, SettingsSchema, { auto: false }).auto
  }

  private stored(): StoredCheck | null {
    return this.deps.settings.get<StoredCheck | null>(CHECK_KEY, CheckSchema, null)
  }

  private off() {
    return Errors.forbidden('Updates are turned off on this server', { reason: 'updates_off' })
  }

  /** The newer release last found, with what it needs; null when there is none. */
  available(): (StoredCheck['latest'] & object) | null {
    const latest = this.stored()?.latest
    return latest && compareReleaseVersions(latest.version, this.deps.installed) > 0 ? latest : null
  }

  private image(): UpdateStatus['image'] {
    const version = this.deps.env.MM_IMAGE_VERSION ?? null
    const created = this.deps.env.MM_IMAGE_CREATED ?? null
    const at = created ? Date.parse(created) : NaN
    return {
      version: version && parseReleaseVersion(version) ? version : null,
      created: Number.isFinite(at) ? created : null,
      old: Number.isFinite(at) && this.deps.now() - at > IMAGE_OLD_MS,
    }
  }

  /** What Update can do for this install, for a release that needs `info`. */
  offerFor(info: ReleaseInfo): { offer: UpdateOffer; offerReason?: UpdateOfferReason } {
    const distribution = this.distribution
    if (distribution === 'source') return { offer: 'notice', offerReason: 'source' }
    const o = this.deps.origin
    if (!o || (o.distribution === 'standalone' && !o.target))
      return { offer: 'reinstall', offerReason: 'no_launcher' }
    if (distribution === 'docker') {
      const image = this.image()!.version
      if (!image || compareReleaseVersions(info.minImage, image) > 0)
        return { offer: 'pull_image', offerReason: 'image_old' }
    }
    // Final review (I7): the installed program (the launcher) is too old to run it.
    if (info.minLauncher && compareReleaseVersions(info.minLauncher, o.bundledVersion) > 0)
      return { offer: distribution === 'docker' ? 'pull_image' : 'reinstall', offerReason: 'launcher_old' }
    if (
      parseReleaseVersion(this.deps.nodeVersion) &&
      compareReleaseVersions(info.node, this.deps.nodeVersion) > 0
    )
      return { offer: distribution === 'docker' ? 'pull_image' : 'reinstall', offerReason: 'node_old' }
    return { offer: 'install' }
  }

  status(admin: boolean): UpdateStatus {
    const base: UpdateStatus = {
      installed: this.deps.installed,
      distribution: this.distribution,
      disabled: this.disabled,
      launcher: this.deps.origin !== null,
      // Everyone's privacy line says whether the daily check is on: it must be true for each reader.
      auto: !this.disabled && this.auto,
      lastCheck: null,
      latest: null,
      offer: null,
      progress: null,
    }
    if (!admin || this.disabled) return base
    const stored = this.stored()
    const available = this.available()
    const last = readLastUpdate(join(this.deps.dataDir, 'app'))
    return {
      ...base,
      lastCheck: stored
        ? {
            at: stored.at,
            outcome: stored.outcome === 'available' && !available ? 'current' : stored.outcome,
            ...(stored.reason ? { reason: stored.reason } : {}),
            ...(stored.retryAt ? { retryAt: stored.retryAt } : {}),
          }
        : null,
      latest: available
        ? {
            version: available.version,
            publishedAt: available.publishedAt,
            notes: available.notes,
            // The release page, made here: never an address read back from the store as it is.
            url: releasePage(available.version),
          }
        : null,
      ...(available ? this.offerFor(available.info) : {}),
      ...(this.distribution === 'docker' ? { image: this.image() } : {}),
      ...(last
        ? {
            lastUpdate: {
              version: last.version,
              outcome: last.outcome,
              ...(last.code ? { code: last.code } : {}),
              ...(last.reason ? { reason: last.reason } : {}),
              at: last.at,
            },
          }
        : {}),
      progress: this.progress,
      ...(this.failure ? { installFailure: this.failure } : {}),
    }
  }

  /** Asks GitHub now (one check at a time: a second call waits for the first). */
  check(): Promise<UpdateStatus> {
    if (this.disabled) return Promise.reject(this.off())
    this.running ??= this.runCheck().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** The release found by the last check, with its assets: what an install downloads. */
  lastRelease: CheckedRelease | null = null

  private async runCheck(): Promise<UpdateStatus> {
    const at = this.deps.now()
    let stored: StoredCheck
    try {
      const release = await checkLatest(this.deps.egress, this.keys)
      this.lastRelease = release
      const { version, publishedAt, notes, url, info } = release
      const newer = compareReleaseVersions(version, this.deps.installed) > 0
      stored = {
        at,
        outcome: newer ? 'available' : 'current',
        latest: { version, publishedAt, notes, url, info },
      }
    } catch (e) {
      if (!(e instanceof CheckError)) throw e
      stored = {
        at,
        outcome: 'failed',
        reason: e.reason,
        ...(e.retryAt ? { retryAt: e.retryAt } : {}),
        latest: null,
      }
    }
    this.deps.settings.set(CHECK_KEY, stored)
    return this.status(true)
  }

  /** Every signed-in page is told before the server goes (the realtime hub listens). */
  onRestarting(listener: (version: string) => void): () => void {
    this.restartingListeners.add(listener)
    return () => this.restartingListeners.delete(listener)
  }

  /**
   * Spec §5.2: the offered version, installed. What can be refused is refused here, at once; the
   * download, the database copy and the restart then run on their own (progress in the status).
   */
  install(version: string, confirmJobs: boolean): void {
    if (this.disabled) throw this.off()
    if (this.installing)
      throw Errors.conflict('An update is already being installed', { reason: 'update_running' })
    const available = this.available()
    if (!available || this.offerFor(available.info).offer !== 'install')
      throw Errors.conflict('There is no update to install here', { reason: 'update_unavailable' })
    if (available.version !== version)
      throw Errors.conflict('A newer version was found since; check again', { reason: 'update_changed' })
    const jobs = this.deps.runningJobs?.() ?? 0
    if (jobs > 0 && !confirmJobs)
      throw Errors.conflict('Jobs are running; they stop when Mongo Manager restarts', {
        reason: 'update_jobs',
        jobs,
      })
    this.failure = undefined
    this.progress = { phase: 'downloading', percent: 0 }
    this.installing = this.runInstall(version).finally(() => {
      this.installing = null
    })
  }

  private async runInstall(version: string): Promise<void> {
    const origin = this.deps.origin!
    const appDir = join(this.deps.dataDir, 'app')
    const dbCopy = `mongo-manager.db.before-${version}`
    const copyPath = join(this.deps.dataDir, dbCopy)
    try {
      await downloadVersion({
        egress: this.deps.egress,
        dataDir: this.deps.dataDir,
        version,
        kind: origin.distribution === 'standalone' ? 'standalone' : 'package',
        target: origin.target,
        keys: this.keys,
        ...(this.lastRelease ? { release: this.lastRelease } : {}),
        onProgress: (p) => (this.progress = p),
      })
      this.progress = { phase: 'preparing' }
      if (!this.deps.db) throw new Error('no database to copy')
      rmSync(copyPath, { force: true })
      // The database as it is now, through SQLite's own online backup: a whole copy, never a torn one.
      await backup(this.deps.db, copyPath)
      restrictPermissions(this.deps.dataDir, [copyPath])
      const state = readUpdateState(appDir)
      // The version this one runs from, when it was downloaded too (the bundled one needs no folder).
      const from = this.deps.installed !== origin.bundledVersion ? this.deps.installed : null
      writeUpdateState(appDir, {
        ...state,
        pending: { version, from, dbCopy },
        failed: state.failed.filter((v) => v !== version),
      })
      this.progress = { phase: 'restarting' }
      for (const l of this.restartingListeners) l(version)
      await new Promise((r) => setTimeout(r, this.deps.restartDelayMs ?? 1_000))
      this.deps.restart?.()
    } catch (e) {
      rmSync(copyPath, { force: true })
      this.progress = null
      const detail =
        e instanceof AppError ? (e.details as { detail?: string } | undefined)?.detail : undefined
      this.failure = { reason: detail ?? 'failed', at: this.deps.now() }
    }
  }

  setAuto(on: boolean): UpdateStatus {
    if (this.disabled) throw this.off()
    this.deps.settings.set(SETTINGS_KEY, { auto: on })
    this.schedule()
    return this.status(true)
  }

  start(): void {
    this.started = true
    this.schedule()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The next daily check: a day after the last one, at the soonest five minutes from now. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.started || this.disabled || !this.auto) return
    const last = this.stored()?.at
    const now = this.deps.now()
    const delay = last !== undefined && now - last < DAY_MS ? last + DAY_MS - now : FIRST_CHECK_MS
    this.timer = setTimeout(
      () => {
        this.timer = null
        // A failure (offline, rate limited) waits for the next day too: no retry sooner (spec §7).
        this.check().then(
          () => this.schedule(),
          () => this.schedule(),
        )
      },
      Math.max(delay, 1_000),
    )
    this.timer.unref()
  }
}
