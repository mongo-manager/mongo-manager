// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { openRegularFile } from '../open-regular'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import type { BackupEngine, BackupFormat, BackupScope } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { SWEEP_EVERY_MS, UPLOAD_IDLE_MS } from '../transfer/limits'
import type { BackupLimits } from './limits'

export interface BackupMeta {
  scope: BackupScope
  engine: BackupEngine
  format: BackupFormat
  masked: boolean
  anonymous: boolean
  namespaces: number
  startedAt: number
  finishedAt: number | null
  rulesVersion: number
  /** Phase 3d-3b (plan ruling 4): the scope held personal-field rules when it was dumped. */
  personal?: boolean
  /** Phase 3d-3c: the backup key whose server slot a scheduled .mmbak carries. */
  keyId?: string
  /** Review of B2 (I2): the namespaces it holds, kept as long as it is (its dump report is a day's). */
  included?: Array<{ db: string; coll: string }>
}

export interface BackupFileRow {
  id: string
  owner: string
  kind: 'backup' | 'upload'
  name: string
  size: number
  declaredSize: number | null
  complete: boolean
  jobId: string | null
  connectionId: string | null
  meta: BackupMeta | null
  sha256: string | null
  createdAt: number
  expiresAt: number
  /** Phase 3d-3b (plan ruling 3): a fetched upload, complete only once its digest matched. */
  awaitingVerify: boolean
  /** Phase 3d-3c: the schedule that made it (null for a manual backup, an upload, or a deleted schedule). */
  scheduleId: string | null
  /** Final review B26: where a fetched upload comes from, so a new fetch of it resumes. */
  fetchSource?: FetchSource | null
}

export interface FetchSource {
  destinationId: string
  key: string
}

interface Row {
  id: string
  owner: string
  kind: 'backup' | 'upload'
  name: string
  size: number
  declared_size: number | null
  complete: number
  job_id: string | null
  connection_id: string | null
  meta: string | null
  sha256: string | null
  created_at: number
  expires_at: number
  awaiting_verify: number
  schedule_id: string | null
}

/** A fetched upload has no backup meta: its meta column holds where it comes from (B26). */
const parseMeta = (raw: string | null): { meta: BackupMeta | null; fetch: FetchSource | null } => {
  if (!raw) return { meta: null, fetch: null }
  const parsed = JSON.parse(raw) as BackupMeta | { fetch: FetchSource }
  return 'fetch' in parsed ? { meta: null, fetch: parsed.fetch } : { meta: parsed, fetch: null }
}

const toRow = (r: Row): BackupFileRow => ({
  ...toRowFields(r),
  fetchSource: parseMeta(r.meta).fetch,
})

const toRowFields = (r: Row): BackupFileRow => ({
  id: r.id,
  owner: r.owner,
  kind: r.kind,
  name: r.name,
  size: r.size,
  declaredSize: r.declared_size,
  complete: r.complete === 1,
  jobId: r.job_id,
  connectionId: r.connection_id,
  meta: parseMeta(r.meta).meta,
  sha256: r.sha256,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  awaitingVerify: r.awaiting_verify === 1,
  scheduleId: r.schedule_id,
})

const SAFE_OWNER = /^[A-Za-z0-9_-]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FILE_NAME = /^([0-9a-f-]{36})\.(backup|upload)$/
/** A display name only: never part of a path. */
const displayName = (name: string) =>
  // eslint-disable-next-line no-control-regex
  name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'backup'
const full = () => Errors.conflict('Your backup storage is full', { reason: 'backup_quota' })
/** Bytes held or reserved: an upload's declared size counts from its creation. */
const HELD = 'COALESCE(SUM(MAX(size, COALESCE(declared_size, 0))), 0)'
/** Plan ruling 15: a "keep on the server too" schedule's copy expires by retention only (9999-12-31). */
export const RETAINED = Date.UTC(9999, 11, 31)

/**
 * Phase 3d-3a spec §7.3 (plan rulings 1–3): kept backups and restore uploads under
 * <data-dir>/backups/<owner>/<uuid>.<kind>, rows in `backups`. Paths come from the owner and a
 * server UUID only. Reserved sizes count against both quotas from the start, so concurrent uploads
 * and jobs cannot overrun them together.
 */
export class BackupStore {
  private realRoot = ''
  private timer?: NodeJS.Timeout
  private readonly events = new EventEmitter()
  /** Uploads whose part is being written now (final review I1). */
  private readonly appending = new Set<string>()
  /** Phase 3d-3b final review B9: rows a running send or fetch uses; the sweep leaves them. */
  private readonly held = new Map<string, number>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly root: string,
    private readonly limits: BackupLimits,
    private readonly now: () => number,
  ) {
    this.events.setMaxListeners(0)
  }

  init(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.realRoot = realpathSync(this.root)
    // A crash leaves backups that never completed: their files are partial. Uploads may resume.
    for (const r of this.db
      .prepare("SELECT * FROM backups WHERE complete = 0 AND kind = 'backup'")
      .all() as unknown as Row[])
      this.remove(toRow(r))
    this.sweep()
  }

  /** The owner's directory, created if missing; a link in its place is refused. */
  ownerDir(owner: string): string {
    if (!SAFE_OWNER.test(owner)) throw Errors.forbidden('Invalid file owner')
    const path = join(this.realRoot, owner)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path)
      throw Errors.forbidden('The backup directory is not where it should be')
    return path
  }

  pathOf(row: BackupFileRow): string {
    if (!UUID.test(row.id)) throw Errors.notFound()
    return join(this.ownerDir(row.owner), `${row.id}.${row.kind}`)
  }

  usage(owner: string): number {
    return (this.db.prepare(`SELECT ${HELD} AS n FROM backups WHERE owner = ?`).get(owner) as { n: number }).n
  }

  private totalUsage(): number {
    return (this.db.prepare(`SELECT ${HELD} AS n FROM backups`).get() as { n: number }).n
  }

  /** Room left for an owner, under both the per-user and the total quota. */
  room(owner: string): number {
    return Math.min(this.limits.quota - this.usage(owner), this.limits.totalQuota - this.totalUsage())
  }

  get(owner: string, id: string): BackupFileRow | undefined {
    if (!UUID.test(id)) return undefined
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ? AND owner = ?').get(id, owner) as
      Row | undefined
    return row && toRow(row)
  }

  /** A row by id, for a running job or a reader that already holds it. */
  byId(id: string): BackupFileRow | undefined {
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as Row | undefined
    return row && toRow(row)
  }

  /** The owner's complete, unexpired backups, newest first. */
  list(owner: string, filter: { connectionId?: string }): BackupFileRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM backups WHERE owner = ? AND kind = 'backup' AND complete = 1 AND expires_at > ? ORDER BY created_at DESC",
      )
      .all(owner, this.now()) as unknown as Row[]
    return rows.map(toRow).filter((r) => !filter.connectionId || r.connectionId === filter.connectionId)
  }

  private insert(row: BackupFileRow): void {
    this.db
      .prepare(
        `INSERT INTO backups (id, owner, kind, name, size, declared_size, complete, job_id, connection_id, meta,
          sha256, created_at, expires_at, awaiting_verify, schedule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.owner,
        row.kind,
        row.name,
        row.size,
        row.declaredSize,
        row.complete ? 1 : 0,
        row.jobId,
        row.connectionId,
        row.meta
          ? JSON.stringify(row.meta)
          : row.fetchSource
            ? JSON.stringify({ fetch: row.fetchSource })
            : null,
        row.sha256,
        row.createdAt,
        row.expiresAt,
        row.awaitingVerify ? 1 : 0,
        row.scheduleId,
      )
  }

  createUpload(input: {
    owner: string
    name: string
    size: number
    awaitingVerify?: boolean
    /** Final review B26: a fetch's source, so a new fetch of the same file resumes this upload. */
    fetchSource?: FetchSource
  }): BackupFileRow {
    if (input.size > this.limits.maxUpload)
      throw Errors.validation('The file is too large to upload', { reason: 'backup_upload_size' })
    this.ownerDir(input.owner)
    if (input.size > this.room(input.owner)) throw full()
    const now = this.now()
    const row: BackupFileRow = {
      id: randomUUID(),
      owner: input.owner,
      kind: 'upload',
      name: displayName(input.name),
      size: 0,
      declaredSize: input.size,
      complete: false,
      jobId: null,
      connectionId: null,
      meta: null,
      sha256: null,
      createdAt: now,
      expiresAt: now + this.limits.ttlMs,
      awaitingVerify: input.awaitingVerify === true,
      scheduleId: null,
      fetchSource: input.fetchSource ?? null,
    }
    this.insert(row)
    return row
  }

  /** Final review B26: the owner's unfinished download of this file, if one is left to resume. */
  fetchPartial(owner: string, source: FetchSource, size: number): BackupFileRow | undefined {
    return (
      this.db
        .prepare(
          "SELECT * FROM backups WHERE owner = ? AND kind = 'upload' AND complete = 0 AND awaiting_verify = 1 AND declared_size = ? AND expires_at > ? ORDER BY created_at DESC",
        )
        .all(owner, size, this.now()) as unknown as Row[]
    )
      .map(toRow)
      .find(
        (r) =>
          r.fetchSource?.destinationId === source.destinationId &&
          r.fetchSource.key === source.key &&
          !this.held.has(r.id),
      )
  }

  /** Final review B9: a running send or fetch holds its row; the sweep never removes a held one. */
  hold(id: string): () => void {
    this.held.set(id, (this.held.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.held.get(id) ?? 1) - 1
      if (n <= 0) this.held.delete(id)
      else this.held.set(id, n)
    }
  }

  /**
   * Plan ruling 2: appends a part at `offset`, which must be the bytes received so far (a resumed
   * client asks for that number first). Nothing past the declared size is accepted.
   */
  async appendUpload(input: {
    owner: string
    id: string
    offset: number
    body: Readable
    declaredLength?: number
    /** Phase 3d-3b: a fetch job writing its own upload. */
    byJob?: boolean
  }): Promise<{ received: number; complete: boolean }> {
    // CI 2026-10-21: listened to from the moment it is handed over. A body that breaks before it is
    // read (a first part clears its empty file first) is read as broken then, never an uncaught error.
    input.body.on('error', () => undefined)
    const row = this.get(input.owner, input.id)
    if (!row || row.kind !== 'upload') throw Errors.notFound('Upload not found')
    if (row.complete) throw Errors.conflict('The upload is complete', { reason: 'upload_complete' })
    // Plan ruling 3: a fetched upload is written by its job only, and completes when its digest matched.
    if (row.awaitingVerify && !input.byJob)
      throw Errors.conflict('This file is being downloaded from a destination', { reason: 'upload_fetching' })
    if (input.offset !== row.size)
      throw Errors.conflict('Resume the upload from the bytes already received', {
        reason: 'upload_offset',
        received: row.size,
      })
    // Final review I1: one part of an upload at a time; two at once would interleave in the file.
    if (this.appending.has(row.id))
      throw Errors.conflict('A part of this upload is still being received', { reason: 'upload_busy' })
    this.appending.add(row.id)
    try {
      return await this.appendPart(row, input)
    } finally {
      this.appending.delete(row.id)
    }
  }

  private async appendPart(
    row: BackupFileRow,
    input: { owner: string; id: string; offset: number; body: Readable; declaredLength?: number },
  ): Promise<{ received: number; complete: boolean }> {
    const declared = row.declaredSize ?? 0
    // Refused before a byte is read: the reply goes out while the body is still unread.
    if (input.declaredLength !== undefined && row.size + input.declaredLength > declared)
      throw Errors.validation('More bytes than declared', { reason: 'upload_overflow' })
    let size = row.size
    let idle: NodeJS.Timeout | undefined
    let failure: AppError | undefined
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => {
        failure = Errors.validation('The upload stalled', { reason: 'upload_idle' })
        input.body.destroy(failure)
      }, UPLOAD_IDLE_MS)
    }
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        if (size + chunk.length > declared) {
          failure = Errors.validation('More bytes than declared', { reason: 'upload_overflow' })
          return done(failure)
        }
        size += chunk.length
        arm()
        done(null, chunk)
      },
    })
    arm()
    const path = this.pathOf(row)
    // Nothing recorded yet: an earlier part may have created the file without writing a byte
    // (empty, or broken before its first byte). It holds nothing to keep, so it starts afresh,
    // still create-only.
    if (row.size === 0) await rm(path, { force: true })
    try {
      await pipeline(
        input.body,
        counter,
        createWriteStream(path, { flags: row.size === 0 ? 'wx' : 'a', mode: 0o600 }),
      )
    } catch {
      // The bytes written before the failure stay: the client resumes from them.
      const onDisk = await this.fileSize(path)
      this.setSize(row.id, Math.min(onDisk ?? row.size, declared))
      this.events.emit(`grow:${row.id}`)
      throw failure ?? Errors.validation('The upload did not complete', { reason: 'upload_aborted' })
    } finally {
      clearTimeout(idle)
    }
    const complete = size === declared && !row.awaitingVerify
    this.db
      .prepare('UPDATE backups SET size = ?, complete = ?, expires_at = ? WHERE id = ?')
      .run(size, complete ? 1 : 0, this.now() + this.limits.ttlMs, row.id)
    this.events.emit(`grow:${row.id}`)
    return { received: size, complete }
  }

  private async fileSize(path: string): Promise<number | null> {
    try {
      const h = await open(path, 'r')
      try {
        return (await h.stat()).size
      } finally {
        await h.close()
      }
    } catch {
      return null
    }
  }

  private setSize(id: string, size: number): void {
    this.db.prepare('UPDATE backups SET size = ? WHERE id = ?').run(size, id)
  }

  /** Plan ruling 3: the fetch job verified the digest; the upload may now be restored. */
  finishFetched(id: string, sha256: string): void {
    this.db
      .prepare(
        'UPDATE backups SET complete = 1, awaiting_verify = 0, sha256 = ?, expires_at = ? WHERE id = ?',
      )
      .run(sha256, this.now() + this.limits.ttlMs, id)
    this.events.emit(`grow:${id}`)
  }

  /** U4: resolves true when the upload grows or completes, false after `ms` or on abort. */
  async waitForGrowth(id: string, signal: AbortSignal, ms: number): Promise<boolean> {
    try {
      await once(this.events, `grow:${id}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]) })
      return true
    } catch {
      return false
    }
  }

  reserveBackup(input: {
    owner: string
    jobId: string
    connectionId: string
    name: string
    meta: BackupMeta | null
    /** Phase 3d-3c: the schedule whose run makes it. */
    scheduleId?: string | null
  }): { row: BackupFileRow; path: string } {
    const now = this.now()
    const row: BackupFileRow = {
      id: randomUUID(),
      owner: input.owner,
      kind: 'backup',
      name: displayName(input.name),
      size: 0,
      declaredSize: null,
      complete: false,
      jobId: input.jobId,
      connectionId: input.connectionId,
      meta: input.meta,
      sha256: null,
      createdAt: now,
      expiresAt: now + this.limits.ttlMs + this.limits.maxJobMs,
      awaitingVerify: false,
      scheduleId: input.scheduleId ?? null,
    }
    const path = this.pathOf(row)
    this.insert(row)
    return { row, path }
  }

  /** A growing backup's size, so the quotas count it while it is written; throws once over them. */
  grow(id: string, owner: string, size: number): void {
    this.setSize(id, size)
    if (this.room(owner) < 0) throw full()
  }

  completeBackup(id: string, done: { size: number; sha256: string; finishedAt: number }): void {
    const row = this.byId(id)
    if (!row) return
    const meta = row.meta ? { ...row.meta, finishedAt: done.finishedAt } : null
    this.db
      .prepare('UPDATE backups SET size = ?, sha256 = ?, complete = 1, meta = ?, expires_at = ? WHERE id = ?')
      .run(done.size, done.sha256, meta ? JSON.stringify(meta) : null, this.now() + this.limits.ttlMs, id)
  }

  /** Opens a file for reading; a link in its place is refused, never followed: opened first, checked after (CodeQL 2026-11-01). */
  async openRead(row: BackupFileRow): Promise<FileHandle> {
    const handle = await openRegularFile(this.pathOf(row))
    if (!handle) throw Errors.notFound('File not found')
    return handle
  }

  private remove(row: BackupFileRow): void {
    this.db.prepare('DELETE FROM backups WHERE id = ?').run(row.id)
    // Phase 3d-3b: copies sent to destinations outlive the local file.
    this.db.prepare('UPDATE backup_remote_copies SET backup_id = NULL WHERE backup_id = ?').run(row.id)
    if (this.realRoot && SAFE_OWNER.test(row.owner) && UUID.test(row.id))
      try {
        rmSync(join(this.realRoot, row.owner, `${row.id}.${row.kind}`), { force: true })
      } catch {
        // Still open (Windows): the sweep removes it later.
      }
  }

  /** Final review minor 5: a file a job reads is kept at least until the job's time is up. */
  keepUntil(id: string, until: number): void {
    this.db.prepare('UPDATE backups SET expires_at = MAX(expires_at, ?) WHERE id = ?').run(until, id)
  }

  /** Plan ruling 15: the copy stays until its schedule's retention removes it. */
  retain(id: string): void {
    this.db.prepare('UPDATE backups SET expires_at = ? WHERE id = ?').run(RETAINED, id)
  }

  /** A deleted schedule's server copies get the normal time to live from now on. */
  releaseRetained(scheduleId: string): void {
    this.db
      .prepare('UPDATE backups SET expires_at = ? WHERE schedule_id = ? AND expires_at = ?')
      .run(this.now() + this.limits.ttlMs, scheduleId, RETAINED)
  }

  /** Spec §1.4: a schedule's complete backups on this server, newest first (retention's candidates). */
  bySchedule(scheduleId: string): BackupFileRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM backups WHERE schedule_id = ? AND kind = 'backup' AND complete = 1 ORDER BY created_at DESC",
        )
        .all(scheduleId) as unknown as Row[]
    ).map(toRow)
  }

  delete(owner: string, id: string): boolean {
    const row = this.get(owner, id)
    if (row) this.remove(row)
    return Boolean(row)
  }

  deleteAllFor(owner: string): void {
    for (const r of this.db.prepare('SELECT * FROM backups WHERE owner = ?').all(owner) as unknown as Row[])
      this.remove(toRow(r))
  }

  /** Expired rows and their files, and files without a row. */
  sweep(): void {
    // Plan ruling 15: retained copies whose schedule is gone (deleted, or its connection was) expire
    // normally; final review I1: so do those of a schedule that no longer keeps copies on the server.
    this.db
      .prepare(
        `UPDATE backups SET expires_at = ? WHERE expires_at = ? AND (schedule_id IS NULL OR schedule_id NOT IN
          (SELECT id FROM backup_schedules WHERE keep_on_server = 1))`,
      )
      .run(this.now() + this.limits.ttlMs, RETAINED)
    for (const r of this.db
      .prepare('SELECT * FROM backups WHERE expires_at <= ?')
      .all(this.now()) as unknown as Row[])
      if (!this.held.has(r.id)) this.remove(toRow(r))
    if (!this.realRoot || !existsSync(this.realRoot)) return
    const known = this.db.prepare('SELECT 1 FROM backups WHERE id = ? AND owner = ?')
    for (const owner of readdirSync(this.realRoot)) {
      const dir = join(this.realRoot, owner)
      try {
        if (!SAFE_OWNER.test(owner) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
          rmSync(dir, { recursive: true, force: true })
          continue
        }
        for (const name of readdirSync(dir)) {
          const m = FILE_NAME.exec(name)
          if (!m || !known.get(m[1]!, owner)) rmSync(join(dir, name), { force: true })
        }
      } catch {
        // One unreadable entry never stops the sweep.
      }
    }
  }

  startSweep(): void {
    this.timer = setInterval(() => this.sweep(), SWEEP_EVERY_MS)
    this.timer.unref()
  }

  close(): void {
    clearInterval(this.timer)
  }
}
