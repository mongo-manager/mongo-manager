// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { openRegularFile } from '../open-regular'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import { AppError, Errors } from '../errors'
import type { Principal } from '../http/context'
import { SWEEP_EVERY_MS, UPLOAD_IDLE_MS, type TransferLimits } from './limits'

export type TransferFileKind = 'upload' | 'export' | 'rejected'

export interface TransferFile {
  id: string
  owner: string
  kind: TransferFileKind
  name: string
  size: number
  complete: boolean
  jobId: string | null
  connectionId: string
  namespace: string | null
  format: string | null
  gzip: boolean
  masked: boolean
  rulesVersion: number | null
  createdAt: number
  expiresAt: number
}

interface Row {
  id: string
  owner: string
  kind: TransferFileKind
  name: string
  size: number
  complete: number
  job_id: string | null
  connection_id: string
  namespace: string | null
  format: string | null
  gzip: number
  masked: number
  rules_version: number | null
  created_at: number
  expires_at: number
}

const toFile = (r: Row): TransferFile => ({
  id: r.id,
  owner: r.owner,
  kind: r.kind,
  name: r.name,
  size: r.size,
  complete: r.complete === 1,
  jobId: r.job_id,
  connectionId: r.connection_id,
  namespace: r.namespace,
  format: r.format,
  gzip: r.gzip === 1,
  masked: r.masked === 1,
  rulesVersion: r.rules_version,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
})

/** User ids and 'local': the only names a directory under the root may have (spec §7 T15). */
const SAFE_OWNER = /^[A-Za-z0-9_-]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FILE_NAME = /^([0-9a-f-]{36})\.(upload|export|rejected)$/
/** Temporary files a running job writes next to its upload (an inflated workbook). */
const TEMP_NAME = /^[0-9a-f-]{36}\.tmp$/
/** A display name only: never part of a path. */
const displayName = (name: string) =>
  // eslint-disable-next-line no-control-regex
  name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'file'

export const ownerOf = (principal: Principal): string =>
  principal.kind === 'user' ? principal.userId : 'local'

const quotaFull = () => Errors.conflict('Your transfer storage is full', { reason: 'transfer_quota' })
/** Security review 2026-10-13 (low): all users together, so they cannot fill the disk. */
const serverFull = () => Errors.conflict('The server’s transfer storage is full', { reason: 'transfer_full' })
/** How much an upload grows between two looks at its owner's quota. */
const QUOTA_CHECK_EVERY = 256 * 1024

/**
 * Phase 3d-1 spec §4, §7 (T1, T3, T15), §8.3: the files of uploads, exports and rejected records under
 * <data-dir>/transfer/<owner>/<uuid>.<kind>, with their rows in transfer_files. Paths are built from
 * the owner and a server UUID only; nothing from a request names a path.
 */
export class TransferFiles {
  private realRoot = ''
  private timer?: NodeJS.Timeout
  /** Bytes of temporary files (an inflated gzip workbook) by owner: they count too (final review I6). */
  private readonly temporary = new Map<string, number>()
  /** Uploads being inflated in place, by id: one at a time each (inflateInPlace). */
  private readonly inflating = new Map<string, Promise<unknown>>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly root: string,
    private readonly limits: TransferLimits,
    private readonly now: () => number,
  ) {}

  init(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.realRoot = realpathSync(this.root)
    // A crash leaves rows that never completed: their files are partial. W4 review I7: not a growing
    // file (a live sync's rejected records, a Watch recording), which is never complete while it
    // grows: it keeps what reached the disk — a recording is finished (its feed is gone), a sync's
    // records go on growing when it runs again.
    for (const r of this.db
      .prepare('SELECT * FROM transfer_files WHERE complete = 0')
      .all() as unknown as Array<Row & { growing: number }>) {
      const file = toFile(r)
      if (r.growing !== 1) {
        this.remove(file)
        continue
      }
      let size: number
      try {
        const path = this.pathOf(file)
        size = existsSync(path) && !lstatSync(path).isSymbolicLink() ? statSync(path).size : -1
      } catch {
        size = -1
      }
      if (size < 0) this.remove(file)
      // W4 re-review (minor): its size only — its time is renewed by its sync, if that runs again.
      else if (file.kind === 'rejected') this.grow(file.id, size)
      else this.complete(file.id, size)
    }
    this.sweep()
  }

  /** The owner's directory, created if missing; a link in its place is refused (T15). */
  ownerDir(owner: string): string {
    if (!SAFE_OWNER.test(owner)) throw Errors.forbidden('Invalid file owner')
    const path = join(this.realRoot, owner)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path)
      throw Errors.forbidden('The transfer directory is not where it should be')
    return path
  }

  pathOf(file: TransferFile): string {
    if (!UUID.test(file.id)) throw Errors.notFound()
    return join(this.ownerDir(file.owner), `${file.id}.${file.kind}`)
  }

  usage(owner: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size), 0) AS n FROM transfer_files WHERE owner = ?')
      .get(owner) as { n: number }
    return row.n + (this.temporary.get(owner) ?? 0)
  }

  /**
   * Counts a temporary file of the owner against the quota while it is written and kept: add()
   * throws once the owner's files would pass it; release() forgets the bytes (once).
   */
  holdTemporary(owner: string): { add(n: number): void; release(): void } {
    let held = 0
    let released = false
    const set = (delta: number) => {
      const n = (this.temporary.get(owner) ?? 0) + delta
      if (n > 0) this.temporary.set(owner, n)
      else this.temporary.delete(owner)
    }
    return {
      add: (n) => {
        if (released) return
        held += n
        set(n)
        if (this.room(owner) < 0) throw this.full(owner)
      },
      release: () => {
        if (released) return
        released = true
        set(-held)
      },
    }
  }

  /** Room left for an owner's job file, in bytes: in their quota and in the server's total. */
  room(owner: string): number {
    return Math.min(this.limits.quota - this.usage(owner), this.totalRoom())
  }

  /**
   * W4 review (minor): `n` bytes of the owner's space taken at once, before they are written, so two
   * writers of one owner (two recordings, a sync's rejected records) never both take the last of it.
   * False: no room. `release(n)` gives back the claim once the bytes are counted in the file's size.
   */
  claim(owner: string, n: number): boolean {
    if (this.room(owner) < n) return false
    this.temporary.set(owner, (this.temporary.get(owner) ?? 0) + n)
    return true
  }

  release(owner: string, n: number): void {
    const left = (this.temporary.get(owner) ?? 0) - n
    if (left > 0) this.temporary.set(owner, left)
    else this.temporary.delete(owner)
  }

  /** What to say when an owner's file would not fit: their quota, or the server's total. */
  full(owner: string): AppError {
    return this.totalRoom() < this.limits.quota - this.usage(owner) ? serverFull() : quotaFull()
  }

  private totalRoom(): number {
    if (this.limits.total === undefined) return Infinity
    const row = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM transfer_files').get() as {
      n: number
    }
    let held = 0
    for (const n of this.temporary.values()) held += n
    return this.limits.total - row.n - held
  }

  /**
   * Security audit 2026-10-16 (minor): a gzipped upload that needs random access (a workbook) is
   * inflated once, in place — not into a temporary copy at every preview and again for the import.
   * The inflated bytes count against the owner's quota while they are written, then the row holds
   * their size; `gzip` keeps saying the upload came compressed. One upload at a time: a second caller
   * waits and finds it inflated. `gunzip` bounds the output (boundedGunzip).
   */
  async inflateInPlace(file: TransferFile, gunzip: () => Transform): Promise<TransferFile> {
    const before = this.inflating.get(file.id) ?? Promise.resolve()
    const run = before.then(async () => {
      const current = this.get(file.owner, file.id)
      if (!current || current.kind !== 'upload' || !current.complete)
        throw Errors.notFound('Upload not found')
      const path = this.pathOf(current)
      const head = await open(path, 'r')
      const magic = Buffer.alloc(2)
      try {
        await head.read(magic, 0, 2, 0)
      } finally {
        await head.close()
      }
      if (magic[0] !== 0x1f || magic[1] !== 0x8b) return current
      const temp = join(this.ownerDir(current.owner), `${randomUUID()}.tmp`)
      const held = this.holdTemporary(current.owner)
      try {
        let size = 0
        await pipeline(
          createReadStream(path),
          gunzip(),
          new Transform({
            transform(chunk: Buffer, _enc, done) {
              try {
                size += chunk.length
                held.add(chunk.length)
                done(null, chunk)
              } catch (e) {
                done(e as Error)
              }
            },
          }),
          createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
        )
        renameSync(temp, path)
        this.db.prepare('UPDATE transfer_files SET size = ?, gzip = 1 WHERE id = ?').run(size, current.id)
      } finally {
        held.release()
        rmSync(temp, { force: true })
      }
      return this.get(current.owner, current.id)!
    })
    const settled = run.catch(() => undefined)
    this.inflating.set(file.id, settled)
    void settled.then(() => {
      if (this.inflating.get(file.id) === settled) this.inflating.delete(file.id)
    })
    return run
  }

  get(owner: string, id: string): TransferFile | undefined {
    if (!UUID.test(id)) return undefined
    const row = this.db.prepare('SELECT * FROM transfer_files WHERE id = ? AND owner = ?').get(id, owner) as
      Row | undefined
    return row && toFile(row)
  }

  /** W4.7: an owner's files of one connection, newest first (the quota keeps them few). */
  listFor(owner: string, connectionId: string): TransferFile[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM transfer_files WHERE owner = ? AND connection_id = ? ORDER BY created_at DESC LIMIT 500',
        )
        .all(owner, connectionId) as unknown as Row[]
    ).map(toFile)
  }

  byJob(owner: string, jobId: string, kind: TransferFileKind): TransferFile | undefined {
    const row = this.db
      .prepare('SELECT * FROM transfer_files WHERE job_id = ? AND owner = ? AND kind = ?')
      .get(jobId, owner, kind) as Row | undefined
    return row && toFile(row)
  }

  private insert(file: TransferFile): void {
    this.db
      .prepare(
        `INSERT INTO transfer_files (id, owner, kind, name, size, complete, job_id, connection_id, namespace,
          format, gzip, masked, rules_version, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        file.id,
        file.owner,
        file.kind,
        file.name,
        file.size,
        file.complete ? 1 : 0,
        file.jobId,
        file.connectionId,
        file.namespace,
        file.format,
        file.gzip ? 1 : 0,
        file.masked ? 1 : 0,
        file.rulesVersion,
        file.createdAt,
        file.expiresAt,
      )
  }

  /** Streams a request body to a new upload; any failure deletes the partial file (T1, T3). */
  async receive(input: {
    owner: string
    connectionId: string
    name: string
    body: Readable
    declaredLength?: number
  }): Promise<TransferFile> {
    const dir = this.ownerDir(input.owner)
    if (input.declaredLength !== undefined && input.declaredLength > this.limits.maxUpload)
      throw Errors.payloadTooLarge()
    const quota = this.room(input.owner)
    if (quota <= 0) throw this.full(input.owner)
    const room = Math.min(this.limits.maxUpload, quota)
    const now = this.now()
    const file: TransferFile = {
      id: randomUUID(),
      owner: input.owner,
      kind: 'upload',
      name: displayName(input.name),
      size: 0,
      complete: false,
      jobId: null,
      connectionId: input.connectionId,
      namespace: null,
      format: null,
      gzip: false,
      masked: false,
      rulesVersion: null,
      createdAt: now,
      expiresAt: now + this.limits.ttlMs,
    }
    this.insert(file)
    const path = join(dir, `${file.id}.upload`)
    let size = 0
    let checked = 0
    let idle: NodeJS.Timeout | undefined
    let failure: AppError | undefined
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => {
        failure = Errors.validation('The upload stalled', { reason: 'upload_idle' })
        input.body.destroy(failure)
      }, UPLOAD_IDLE_MS)
    }
    /**
     * After a refusal, the rest of a body whose length was declared (at most maxUpload) is read
     * and dropped, so the client gets the answer rather than a cut connection. A body without a
     * declared length, or longer than declared, is cut.
     */
    const refuse = (error: AppError, done: (e?: Error | null) => void) => {
      failure ??= error
      if (input.declaredLength === undefined || size > input.declaredLength) return done(failure)
      arm()
      done()
    }
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        size += chunk.length
        if (failure) return refuse(failure, done)
        if (size > room)
          return refuse(
            size > this.limits.maxUpload ? Errors.payloadTooLarge() : this.full(input.owner),
            done,
          )
        // The owner's other uploads and jobs grow meanwhile: the quota is checked as it is now (I6).
        if (size - checked >= QUOTA_CHECK_EVERY) {
          checked = size
          this.grow(file.id, size)
          if (this.room(input.owner) < 0) return refuse(this.full(input.owner), done)
        }
        arm()
        done(null, chunk)
      },
    })
    arm()
    try {
      await pipeline(input.body, counter, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
      if (failure) throw failure
    } catch {
      this.remove(file)
      throw failure ?? Errors.validation('The upload did not complete', { reason: 'upload_aborted' })
    } finally {
      clearTimeout(idle)
    }
    this.complete(file.id, size)
    return { ...file, size, complete: true, expiresAt: this.now() + this.limits.ttlMs }
  }

  /**
   * A row and a path for a file a job writes; complete() or delete() ends it. Until then it may live
   * as long as the job may run, plus the TTL.
   */
  reserve(input: {
    owner: string
    kind: 'export' | 'rejected'
    /** W4 review I7: appended to over time (rejected records, a recording): kept across a restart. */
    growing?: boolean
    connectionId: string
    name: string
    jobId: string
    namespace?: string
    format?: string
    gzip?: boolean
    masked?: boolean
    rulesVersion?: number | null
  }): { file: TransferFile; path: string } {
    const now = this.now()
    const file: TransferFile = {
      id: randomUUID(),
      owner: input.owner,
      kind: input.kind,
      name: displayName(input.name),
      size: 0,
      complete: false,
      jobId: input.jobId,
      connectionId: input.connectionId,
      namespace: input.namespace ?? null,
      format: input.format ?? null,
      gzip: input.gzip ?? false,
      masked: input.masked ?? false,
      rulesVersion: input.rulesVersion ?? null,
      createdAt: now,
      expiresAt: now + this.limits.ttlMs + this.limits.maxJobMs,
    }
    const path = this.pathOf(file)
    this.insert(file)
    if (input.growing) this.db.prepare('UPDATE transfer_files SET growing = 1 WHERE id = ?').run(file.id)
    return { file, path }
  }

  /** Records a growing job file's size, so the quota counts it while it is written. */
  grow(id: string, size: number): void {
    this.db.prepare('UPDATE transfer_files SET size = ? WHERE id = ?').run(size, id)
  }

  /**
   * W4.6: a file that keeps growing for as long as its owner runs (a live sync's rejected records):
   * its size, and a life of the TTL past the job time from now, renewed on every write.
   */
  touch(id: string, size: number): void {
    this.db
      .prepare('UPDATE transfer_files SET size = ?, expires_at = ? WHERE id = ?')
      .run(size, this.now() + this.limits.ttlMs + this.limits.maxJobMs, id)
  }

  complete(id: string, size: number): void {
    this.db
      .prepare('UPDATE transfer_files SET size = ?, complete = 1, expires_at = ? WHERE id = ?')
      .run(size, this.now() + this.limits.ttlMs, id)
  }

  /** Opens a file for reading; a link in its place is refused, never followed: opened first, checked after (CodeQL 2026-11-01) (T15). */
  async openRead(file: TransferFile): Promise<FileHandle> {
    const handle = await openRegularFile(this.pathOf(file))
    if (!handle) throw Errors.notFound('File not found')
    return handle
  }

  private unlink(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch {
      // Still open somewhere (Windows): the sweep tries again later.
    }
  }

  private remove(file: TransferFile): void {
    this.db.prepare('DELETE FROM transfer_files WHERE id = ?').run(file.id)
    if (this.realRoot && SAFE_OWNER.test(file.owner) && UUID.test(file.id))
      this.unlink(join(this.realRoot, file.owner, `${file.id}.${file.kind}`))
  }

  delete(owner: string, id: string): void {
    const file = this.get(owner, id)
    if (file) this.remove(file)
  }

  deleteAllFor(owner: string): void {
    for (const r of this.db
      .prepare('SELECT * FROM transfer_files WHERE owner = ?')
      .all(owner) as unknown as Row[])
      this.remove(toFile(r))
    if (this.realRoot && SAFE_OWNER.test(owner))
      try {
        rmSync(join(this.realRoot, owner), { recursive: true, force: true })
      } catch {
        // The sweep removes what is left.
      }
  }

  /** Expired rows and their files, and files without a row (spec §8.3). */
  sweep(): void {
    const now = this.now()
    for (const r of this.db
      .prepare('SELECT * FROM transfer_files WHERE expires_at <= ?')
      .all(now) as unknown as Row[])
      this.remove(toFile(r))
    if (!this.realRoot || !existsSync(this.realRoot)) return
    const known = this.db.prepare('SELECT 1 FROM transfer_files WHERE id = ? AND owner = ?')
    for (const owner of readdirSync(this.realRoot)) {
      const dir = join(this.realRoot, owner)
      try {
        if (!SAFE_OWNER.test(owner) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
          rmSync(dir, { recursive: true, force: true })
          continue
        }
        for (const name of readdirSync(dir)) {
          const path = join(dir, name)
          // A running job's temporary file is kept while that job may still run.
          if (TEMP_NAME.test(name) && Date.now() - statSync(path).mtimeMs < this.limits.maxJobMs) continue
          const m = FILE_NAME.exec(name)
          if (!m || !known.get(m[1]!, owner)) this.unlink(path)
        }
      } catch {
        // One unreadable entry never stops the sweep.
      }
    }
  }

  startSweep(extra?: () => void): void {
    this.timer = setInterval(() => {
      this.sweep()
      extra?.()
    }, SWEEP_EVERY_MS)
    this.timer.unref()
  }

  close(): void {
    clearInterval(this.timer)
  }
}
