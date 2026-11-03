import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { BSON } from 'bson'
import { openStore, type Store } from '../src/store/db'
import { BackupStore } from '../src/backup/store'
import { backupLimits } from '../src/backup/limits'
import { resolveConfig } from '../src/config'
import { createDumpSink, openArchive } from '../src/backup/pipeline'
import { inspectBackup } from '../src/backup/inspect'
import type { ArchiveEvent } from '../src/backup/archive-reader'
import { fixture } from './support/mongo-tools'

let dir: string
let store: Store
let backups: BackupStore
const PW = 'correct horse battery staple'
const signal = new AbortController().signal

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mm-pipe-'))
  store = await openStore(join(dir, 'mm.db'))
  backups = new BackupStore(
    store.db,
    join(dir, 'backups'),
    backupLimits(resolveConfig({ cli: { dataDir: dir } })),
    Date.now,
  )
  backups.init()
})
afterEach(() => {
  backups.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function dumpTo(format: 'archive' | 'gzip' | 'mmbak') {
  const { row, path } = backups.reserveBackup({
    owner: 'u1',
    jobId: 'j',
    connectionId: 'c',
    name: 'x',
    meta: null,
  })
  const sink = createDumpSink({
    path,
    format,
    ...(format === 'mmbak' ? { password: PW } : {}),
    chunkBytes: 4096,
    tool: { name: 'mm', version: 't' },
    now: 1,
    onBytes: () => undefined,
  })
  await sink.writer.begin({ serverVersion: '8.2.6', toolVersion: 't', mongoManager: null }, [
    { db: 'shop', coll: 'orders', type: 'collection', options: {}, indexes: [] },
  ])
  await sink.writer.open('shop', 'orders')
  for (let i = 0; i < 500; i++)
    await sink.writer.write(Buffer.from(BSON.serialize({ _id: i, pad: 'x'.repeat(100) })))
  await sink.writer.close()
  await sink.writer.finish()
  const done = await sink.done()
  backups.completeBackup(row.id, { ...done, finishedAt: 2 })
  return backups.get('u1', row.id)!
}
async function all(events: AsyncIterable<ArchiveEvent>) {
  const out: ArchiveEvent[] = []
  for await (const e of events) out.push(e)
  return out
}
async function upload(data: Buffer, upTo: number) {
  const up = backups.createUpload({ owner: 'u1', name: 'f', size: data.length })
  if (upTo > 0)
    await backups.appendUpload({
      owner: 'u1',
      id: up.id,
      offset: 0,
      body: Readable.from([data.subarray(0, upTo)]),
    })
  return up.id
}

describe('backup pipeline (spec §7.1)', () => {
  it('writes and reads back each format, with a matching SHA-256', async () => {
    for (const format of ['archive', 'gzip', 'mmbak'] as const) {
      const row = await dumpTo(format)
      const { container, events } = await openArchive(backups, row, {
        password: PW,
        signal,
        follow: 'complete',
      })
      expect(container).toBe(format)
      expect(
        (await all(events)).filter((e) => e.kind === 'doc'),
        format,
      ).toHaveLength(500)
      const sum = createHash('sha256')
        .update(readFileSync(backups.pathOf(row)))
        .digest('hex')
      expect(row.sha256).toBe(sum)
      expect(row.size).toBe(readFileSync(backups.pathOf(row)).length)
    }
  })

  it('fails a write when the output fails partway, instead of waiting forever (final review C2)', async () => {
    for (const format of ['archive', 'gzip'] as const) {
      const sink = createDumpSink({
        path: join(dir, `fail-${format}`),
        format,
        chunkBytes: 1024 * 1024,
        tool: { name: 't', version: '1' },
        now: 1,
        // Like the quota: past 64 KiB, the counter throws and the output pipeline is destroyed.
        onBytes: (total) => {
          if (total > 64 * 1024) throw new Error('over quota')
        },
      })
      const { writer } = sink
      await writer.begin({ serverVersion: '8.0.0', toolVersion: 't', mongoManager: null }, [
        { db: 'd', coll: 'c', type: 'collection', options: {}, indexes: [] },
      ])
      await writer.open('d', 'c')
      const run = (async () => {
        for (let i = 0; i < 5000; i++) {
          // A pause between documents, as when the next batch comes from MongoDB.
          if (i % 50 === 0) await new Promise((r) => setTimeout(r, 1))
          // Random bytes: gzip cannot shrink them below the limit.
          await writer.write(Buffer.from(BSON.serialize({ i, pad: randomBytes(512).toString('hex') })))
        }
      })()
      const outcome = await Promise.race([
        run.then(
          () => 'finished',
          () => 'failed',
        ),
        new Promise((r) => setTimeout(() => r('hung'), 10_000)),
      ])
      expect(outcome, format).toBe('failed')
      await expect(sink.done()).rejects.toThrow()
    }
  })

  it('reports the file bytes it reads, for progress over compressed files (final review minor 3)', async () => {
    for (const format of ['gzip', 'mmbak'] as const) {
      const row = await dumpTo(format)
      let read = 0
      const { events } = await openArchive(backups, row, {
        password: PW,
        signal,
        follow: 'complete',
        onFileBytes: (n) => (read += n),
      })
      await all(events)
      expect(read, format).toBe(row.size)
    }
  })

  it('asks for a password, and refuses a wrong one or a foreign file', async () => {
    const row = await dumpTo('mmbak')
    expect(await inspectBackup(backups, row, { signal })).toEqual({ state: 'password' })
    await expect(inspectBackup(backups, row, { signal, password: 'wrong password!' })).rejects.toMatchObject({
      details: { reason: 'backup_password' },
    })
    const id = await upload(Buffer.from('hello'), 5)
    await expect(inspectBackup(backups, backups.get('u1', id)!, { signal })).rejects.toMatchObject({
      details: { reason: 'not_backup' },
    })
  })

  it('inspects while the upload grows (U4, Review Focus 3)', async () => {
    const real = fixture('shop.archive')
    const id = await upload(real, 0)
    expect(await inspectBackup(backups, backups.get('u1', id)!, { signal })).toMatchObject({
      state: 'waiting',
      received: 0,
      size: real.length,
    })
    // The prelude of a plain archive is at its start: one byte short of its end is not enough,
    // its end is.
    let end = 4
    while (real.readInt32LE(end) !== -1) end += real.readInt32LE(end)
    end += 4
    await backups.appendUpload({
      owner: 'u1',
      id,
      offset: 0,
      body: Readable.from([real.subarray(0, end - 1)]),
    })
    expect(await inspectBackup(backups, backups.get('u1', id)!, { signal })).toMatchObject({
      state: 'waiting',
    })
    await backups.appendUpload({
      owner: 'u1',
      id,
      offset: end - 1,
      body: Readable.from([real.subarray(end - 1, end)]),
    })
    const mid = await inspectBackup(backups, backups.get('u1', id)!, { signal })
    expect(mid).toMatchObject({ state: 'ready', summary: { container: 'archive' } })
    const half = end
    await backups.appendUpload({ owner: 'u1', id, offset: half, body: Readable.from([real.subarray(half)]) })
    const done = await inspectBackup(backups, backups.get('u1', id)!, { signal })
    expect(done.state).toBe('ready')
    if (done.state === 'ready')
      expect(done.summary.namespaces.map((n) => n.coll).sort()).toEqual([
        'capped',
        'empty',
        'orders',
        'ts',
        'v',
      ])
  })

  it('waits for a zip to complete before reading it, and reads a gzip archive', async () => {
    const zip = fixture('shop-dir.zip')
    const id = await upload(zip, 100)
    expect(await inspectBackup(backups, backups.get('u1', id)!, { signal })).toMatchObject({
      state: 'waiting',
    })
    await backups.appendUpload({ owner: 'u1', id, offset: 100, body: Readable.from([zip.subarray(100)]) })
    expect(await inspectBackup(backups, backups.get('u1', id)!, { signal })).toMatchObject({
      state: 'ready',
      summary: { container: 'directory' },
    })
    const gz = fixture('shop.archive.gz')
    const gid = await upload(gz, gz.length)
    expect(await inspectBackup(backups, backups.get('u1', gid)!, { signal })).toMatchObject({
      state: 'ready',
      summary: { container: 'gzip' },
    })
  })
})
