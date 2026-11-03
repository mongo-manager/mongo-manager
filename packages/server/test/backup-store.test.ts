import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { openStore, type Store } from '../src/store/db'
import { BackupStore } from '../src/backup/store'
import { backupLimits } from '../src/backup/limits'
import { resolveConfig } from '../src/config'
import { AppError } from '../src/errors'
import { fileBytes } from '../src/backup/pipeline'

let dir: string
let store: Store
let backups: BackupStore
let now = 1_000_000
const MiB = 1024 * 1024
const limitsFor = (d: string) => backupLimits(resolveConfig({ cli: { dataDir: d } }))

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mm-backup-'))
  store = await openStore(join(dir, 'mm.db'))
  backups = new BackupStore(
    store.db,
    join(dir, 'backups'),
    { ...limitsFor(dir), quota: 10 * MiB, totalQuota: 12 * MiB, maxUpload: 8 * MiB },
    () => now,
  )
  backups.init()
})
afterEach(() => {
  backups.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const body = (n: number, fill = 1) => Readable.from([Buffer.alloc(n, fill)])

describe('backup store (phase 3d-3a spec §7.3, plan rulings 1–3)', () => {
  it('resumes an upload from the received size and completes it at the declared size', async () => {
    const up = backups.createUpload({ owner: 'u1', name: 'shop.archive', size: 3 * MiB })
    expect(up).toMatchObject({ kind: 'upload', size: 0, declaredSize: 3 * MiB, complete: false })
    let r = await backups.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(MiB) })
    expect(r).toEqual({ received: MiB, complete: false })
    // A retry of a part already received is refused with the size to resume from.
    await expect(
      backups.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(MiB) }),
    ).rejects.toMatchObject({ statusCode: 409, details: { reason: 'upload_offset', received: MiB } })
    r = await backups.appendUpload({ owner: 'u1', id: up.id, offset: MiB, body: body(2 * MiB, 2) })
    expect(r).toEqual({ received: 3 * MiB, complete: true })
    const file = readFileSync(backups.pathOf(backups.get('u1', up.id)!))
    expect(file.length).toBe(3 * MiB)
    expect(file[MiB]).toBe(2)
  })

  it('takes one part of an upload at a time, and reads no further than what was recorded (final review I1)', async () => {
    const up = backups.createUpload({ owner: 'u1', name: 'x', size: 3 * MiB })
    await backups.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(MiB) })
    // Two parts at the same offset at once (a retry while the first is still being written).
    const slow = (fill: number) =>
      Readable.from(
        (async function* () {
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 5))
            yield Buffer.alloc(MiB / 8, fill)
          }
        })(),
      )
    const results = await Promise.allSettled([
      backups.appendUpload({ owner: 'u1', id: up.id, offset: MiB, body: slow(2) }),
      backups.appendUpload({ owner: 'u1', id: up.id, offset: MiB, body: slow(3) }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ statusCode: 409, details: { reason: 'upload_busy' } })
    const row = backups.get('u1', up.id)!
    expect(readFileSync(backups.pathOf(row)).length).toBe(row.size)
    // Bytes past the recorded size are never read.
    writeFileSync(backups.pathOf(row), Buffer.alloc(10, 9), { flag: 'a' })
    const read: Buffer[] = []
    for await (const c of fileBytes(backups, row, {
      follow: 'complete',
      signal: new AbortController().signal,
    }))
      read.push(c)
    expect(Buffer.concat(read).length).toBe(row.size)
  })

  it('refuses more bytes than declared, uploads over the limit and over the quotas', async () => {
    const up = backups.createUpload({ owner: 'u1', name: 'a', size: MiB })
    await expect(
      backups.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(MiB + 1) }),
    ).rejects.toBeInstanceOf(AppError)
    expect(() => backups.createUpload({ owner: 'u1', name: 'b', size: 9 * MiB })).toThrow(/too large/i)
    backups.createUpload({ owner: 'u1', name: 'c', size: 8 * MiB })
    // u1 has 1 + 8 MiB reserved of 10: a 2 MiB upload passes the per-user quota.
    expect(() => backups.createUpload({ owner: 'u1', name: 'd', size: 2 * MiB })).toThrow(/storage is full/i)
    // The total quota (12 MiB) binds another user too.
    expect(() => backups.createUpload({ owner: 'u2', name: 'e', size: 4 * MiB })).toThrow(/storage is full/i)
  })

  it('keeps owners apart and refuses a link in place of an owner directory', async () => {
    const up = backups.createUpload({ owner: 'u1', name: 'a', size: 10 })
    expect(backups.get('u2', up.id)).toBeUndefined()
    rmSync(join(dir, 'backups', 'u3'), { recursive: true, force: true })
    symlinkSync(tmpdir(), join(dir, 'backups', 'u3'), 'junction')
    expect(() => backups.createUpload({ owner: 'u3', name: 'x', size: 10 })).toThrow()
    expect(() => backups.createUpload({ owner: '../x', name: 'x', size: 10 })).toThrow()
  })

  it('lists a backup only once it is complete, and sweeps expired and orphan files', () => {
    const { row, path } = backups.reserveBackup({
      owner: 'u1',
      jobId: 'j1',
      connectionId: 'c1',
      name: 'shop.mmbak',
      meta: {
        scope: { kind: 'database', db: 'shop', views: true },
        engine: 'builtin',
        format: 'mmbak',
        masked: false,
        anonymous: false,
        namespaces: 2,
        startedAt: now,
        finishedAt: null,
        rulesVersion: 1,
      },
    })
    writeFileSync(path, 'x')
    expect(backups.list('u1', {})).toEqual([])
    backups.completeBackup(row.id, { size: 1, sha256: 'f'.repeat(64), finishedAt: now + 5 })
    expect(backups.list('u1', {}).map((b) => b.id)).toEqual([row.id])
    expect(backups.list('u1', { connectionId: 'other' })).toEqual([])
    writeFileSync(join(dir, 'backups', 'u1', 'not-ours.txt'), 'x')
    now += 25 * 3600_000
    backups.sweep()
    expect(backups.list('u1', {})).toEqual([])
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(dir, 'backups', 'u1', 'not-ours.txt'))).toBe(false)
  })

  it('removes partial files a crash left behind', () => {
    const { path } = backups.reserveBackup({
      owner: 'u1',
      jobId: 'j1',
      connectionId: 'c1',
      name: 'a',
      meta: null,
    })
    writeFileSync(path, 'partial')
    backups.close()
    const again = new BackupStore(store.db, join(dir, 'backups'), limitsFor(dir), () => now)
    again.init()
    expect(existsSync(path)).toBe(false)
    again.close()
  })

  it('wakes a reader when an upload grows', async () => {
    const up = backups.createUpload({ owner: 'u1', name: 'a', size: 20 })
    const ctl = new AbortController()
    const waited = backups.waitForGrowth(up.id, ctl.signal, 5_000)
    await backups.appendUpload({ owner: 'u1', id: up.id, offset: 0, body: body(10) })
    await expect(waited).resolves.toBe(true)
  })

  it('creates the destination tables and the fetch flag (migration 15)', () => {
    const tables = (
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables).toEqual(
      expect.arrayContaining(['backup_destinations', 'backup_destination_grants', 'backup_remote_copies']),
    )
    const cols = (store.db.prepare('PRAGMA table_info(backups)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(cols).toContain('awaiting_verify')
  })
})
