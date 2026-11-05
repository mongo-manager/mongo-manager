// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough, Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from '../src/store/migrations'
import { TransferFiles } from '../src/transfer/files'
import { TransferReports } from '../src/transfer/reports'
import { AppError } from '../src/errors'
import { MiB } from '../src/transfer/limits'

let dir: string
let db: DatabaseSync
let clock: number
const limits = { maxUpload: 1 * MiB, quota: 2 * MiB, ttlMs: 3600_000, maxJobMs: 3600_000 }
const files = () => {
  const f = new TransferFiles(db, join(dir, 'transfer'), limits, () => clock)
  f.init()
  return f
}
const body = (bytes: number) => Readable.from([Buffer.alloc(bytes, 0x61)])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-transfer-'))
  db = new DatabaseSync(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  clock = 1_000_000
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (e) {
    return e instanceof AppError ? e.code : String(e)
  }
  return undefined
}

describe('transfer file store (phase 3d-1 §4, §7 T1, T3, T15)', () => {
  it('stores an upload under the owner, readable only by its owner', async () => {
    const f = files()
    const up = await f.receive({ owner: 'u1', connectionId: 'c1', name: 'a.csv', body: body(10) })
    expect(up).toMatchObject({ owner: 'u1', kind: 'upload', size: 10, complete: true, name: 'a.csv' })
    expect(f.get('u1', up.id)).toBeDefined()
    expect(f.get('u2', up.id)).toBeUndefined()
    expect(readdirSync(join(dir, 'transfer', 'u1'))).toEqual([`${up.id}.upload`])
  })

  it('keeps only a display name: control characters are dropped, the name never reaches a path', async () => {
    const f = files()
    const up = await f.receive({ owner: 'u1', connectionId: 'c1', name: '../../a\r\nb.csv', body: body(1) })
    expect(up.name).toBe('../../ab.csv')
    expect(readdirSync(join(dir, 'transfer', 'u1'))).toEqual([`${up.id}.upload`])
  })

  it('refuses an upload over the size limit or the quota, and leaves nothing behind (T1)', async () => {
    const f = files()
    expect(await code(f.receive({ owner: 'u1', connectionId: 'c1', name: 'big', body: body(MiB + 1) }))).toBe(
      'PAYLOAD_TOO_LARGE',
    )
    expect(
      await code(
        f.receive({ owner: 'u1', connectionId: 'c1', name: 'x', body: body(1), declaredLength: MiB + 1 }),
      ),
    ).toBe('PAYLOAD_TOO_LARGE')
    await f.receive({ owner: 'u1', connectionId: 'c1', name: 'a', body: body(MiB) })
    await f.receive({ owner: 'u1', connectionId: 'c1', name: 'b', body: body(MiB - 10) })
    expect(await code(f.receive({ owner: 'u1', connectionId: 'c1', name: 'c', body: body(20) }))).toBe(
      'CONFLICT',
    )
    expect(f.usage('u1')).toBe(2 * MiB - 10)
    expect(readdirSync(join(dir, 'transfer', 'u1'))).toHaveLength(2)
  })

  // Security review 2026-10-13 (low): each user had a quota, the server none — many users could fill
  // the disk that holds the data directory.
  it('holds all users to a total as well, and says it is the server’s', async () => {
    const f = new TransferFiles(db, join(dir, 'transfer'), { ...limits, total: 3 * MiB }, () => clock)
    f.init()
    await f.receive({ owner: 'u1', connectionId: 'c1', name: 'a', body: body(MiB) })
    await f.receive({ owner: 'u1', connectionId: 'c1', name: 'b', body: body(MiB) })
    await f.receive({ owner: 'u2', connectionId: 'c1', name: 'a', body: body(MiB - 10) })
    expect(f.room('u2')).toBe(10)
    let refused: unknown
    await f
      .receive({ owner: 'u2', connectionId: 'c1', name: 'b', body: body(20) })
      .catch((e) => (refused = e))
    expect(refused).toMatchObject({ code: 'CONFLICT', details: { reason: 'transfer_full' } })
    expect(() => f.holdTemporary('u3').add(11)).toThrow(
      expect.objectContaining({ details: { reason: 'transfer_full' } }),
    )
    // A user's own quota is still named as theirs.
    const own = new TransferFiles(db, join(dir, 'transfer'), { ...limits, total: 100 * MiB }, () => clock)
    expect(() => own.holdTemporary('u1').add(1)).toThrow(
      expect.objectContaining({ details: { reason: 'transfer_quota' } }),
    )
  })

  it('aborted uploads: the partial file is deleted and the quota released (Review Focus 5)', async () => {
    const f = files()
    const aborted = new PassThrough()
    const pending = f.receive({ owner: 'u1', connectionId: 'c1', name: 'a', body: aborted })
    aborted.write(Buffer.alloc(100))
    setImmediate(() => aborted.destroy(new Error('client went away')))
    expect(await code(pending)).toBe('VALIDATION_ERROR')
    expect(f.usage('u1')).toBe(0)
    expect(readdirSync(join(dir, 'transfer', 'u1'))).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM transfer_files').get()).toEqual({ n: 0 })
  })

  it('stops an upload idle for 30 s (T3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = files()
      const slow = new PassThrough()
      const pending = f.receive({ owner: 'u1', connectionId: 'c1', name: 'a', body: slow })
      slow.write(Buffer.alloc(10))
      const result = code(pending)
      await vi.advanceTimersByTimeAsync(30_001)
      expect(await result).toBe('VALIDATION_ERROR')
      expect(f.usage('u1')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never follows a link planted in place of the owner directory (T15)', async () => {
    const f = files()
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    rmSync(join(dir, 'transfer', 'u1'), { recursive: true, force: true })
    try {
      symlinkSync(outside, join(dir, 'transfer', 'u1'), 'junction')
    } catch (e) {
      console.warn(`symlinks unavailable here, T15 link case not run: ${String(e)}`)
      return
    }
    expect(await code(f.receive({ owner: 'u1', connectionId: 'c1', name: 'a', body: body(1) }))).toBe(
      'FORBIDDEN',
    )
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses owners that are not safe directory names (T15)', async () => {
    const f = files()
    expect(await code(f.receive({ owner: '../x', connectionId: 'c1', name: 'a', body: body(1) }))).toBe(
      'FORBIDDEN',
    )
    expect(f.get('u1', '../x')).toBeUndefined()
  })

  it('sweeps expired files, incomplete rows and orphans', async () => {
    const f = files()
    const up = await f.receive({ owner: 'u1', connectionId: 'c1', name: 'a', body: body(5) })
    writeFileSync(join(dir, 'transfer', 'u1', '00000000-0000-4000-8000-000000000000.upload'), 'orphan')
    writeFileSync(join(dir, 'transfer', 'u1', 'note.txt'), 'stray')
    const { file } = f.reserve({ owner: 'u1', kind: 'export', connectionId: 'c1', name: 'e', jobId: 'j1' })
    clock += 3600_001
    f.sweep()
    expect(f.get('u1', up.id)).toBeUndefined()
    expect(f.get('u1', file.id)).toBeDefined()
    expect(readdirSync(join(dir, 'transfer', 'u1'))).toEqual([])
    clock += limits.maxJobMs
    f.sweep()
    expect(f.get('u1', file.id)).toBeUndefined()
  })

  it('removes rows left incomplete by a crash when it starts', async () => {
    const first = files()
    const { file } = first.reserve({
      owner: 'u1',
      kind: 'export',
      connectionId: 'c1',
      name: 'e',
      jobId: 'j1',
    })
    const again = files()
    expect(again.get('u1', file.id)).toBeUndefined()
  })

  it('deletes everything of an owner, reports included', async () => {
    const f = files()
    const reports = new TransferReports(db, () => clock)
    await f.receive({ owner: 'u1', connectionId: 'c1', name: 'a', body: body(5) })
    reports.save(
      'j1',
      'u1',
      {
        kind: 'export',
        written: 1,
        bytes: 1,
        omittedFields: [],
        cutCells: 0,
        expiresAt: clock + 10,
        masked: false,
      },
      clock + 10,
    )
    expect(reports.get('u1', 'j1')).toBeDefined()
    expect(reports.get('u2', 'j1')).toBeUndefined()
    f.deleteAllFor('u1')
    reports.deleteAllFor('u1')
    expect(f.usage('u1')).toBe(0)
    expect(reports.get('u1', 'j1')).toBeUndefined()
    expect(existsSync(join(dir, 'transfer', 'u1'))).toBe(false)
  })
})

// W4 review I7: a live sync's rejected records and a recording in progress grow over time and are
// never "complete" while they do; a restart must not take them for a crashed job's partial file.
describe('growing files across a restart (W4 review I7)', () => {
  it('keeps them — a recording finished, a sync’s rejected records still growing — and drops partial job files', () => {
    const before = files()
    const rejected = before.reserve({
      owner: 'u1',
      kind: 'rejected',
      connectionId: 'c1',
      name: 'r',
      jobId: 's1',
      growing: true,
    })
    writeFileSync(rejected.path, 'abc')
    before.touch(rejected.file.id, 1)
    const recording = before.reserve({
      owner: 'u1',
      kind: 'export',
      connectionId: 'c1',
      name: 'w',
      jobId: 'watch:x',
      growing: true,
    })
    writeFileSync(recording.path, 'hello')
    const partial = before.reserve({
      owner: 'u1',
      kind: 'export',
      connectionId: 'c1',
      name: 'e',
      jobId: 'j1',
    })
    writeFileSync(partial.path, 'half')
    // W4 re-review (minor): later — a restart alone does not give a growing file more time (the live
    // sync it belongs to does, when it runs again).
    clock += 60_000
    const after = files()
    expect(after.get('u1', rejected.file.id)!.expiresAt).toBe(rejected.file.expiresAt)
    expect(after.get('u1', partial.file.id)).toBeUndefined()
    expect(existsSync(partial.path)).toBe(false)
    // What the disk holds is what is counted and sent.
    expect(after.get('u1', rejected.file.id)).toMatchObject({ complete: false, size: 3 })
    expect(after.get('u1', recording.file.id)).toMatchObject({ complete: true, size: 5 })
    expect(existsSync(rejected.path) && existsSync(recording.path)).toBe(true)
  })
})
