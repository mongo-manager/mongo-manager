// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { BSON } from 'bson'
import { ArchiveWriter } from '../src/backup/archive-writer'
import { readArchive, type ArchiveEvent } from '../src/backup/archive-reader'
import {
  fullPath,
  knownVersion,
  localFullPath,
  olderServer,
  rawSeries,
  seriesAccess,
  toolsFindSeries,
} from '../src/backup/series'
import { resolveConfig } from '../src/config'
import { VERSION } from '../src/version'

/**
 * CI 2026-10-18 (MongoDB 8.3): mongo-tools' rule, SupportsRawData (common/db/version.go): from 8.3
 * a time series' buckets are read and written through its own name with rawData, and a dump keeps
 * them under that name; before, under system.buckets.<name>.
 */
describe('where a time series keeps its buckets', () => {
  it('by the version, read as mongo-tools reads it', () => {
    for (const v of ['8.3.0', '8.3.11', '8.4.0-rc1', '9.0.0', '10.0.1+build', '8.3.0-alpha+x'])
      expect(rawSeries(v), v).toBe(true)
    for (const v of ['8.2.6', '8.0.32', '7.0.43', '6.0.29', '8.2.99']) expect(rawSeries(v), v).toBe(false)
    // An unreadable version is an old one, as mongo-tools takes it.
    for (const v of [null, undefined, '', 'unknown', '8.3', '8.3.x', '8.3.0.1', '.8.3', 'v8.3.0'])
      expect(rawSeries(v), String(v)).toBe(false)
  })

  // Review of the CI fixes (minor 4): a version mongo-tools cannot read is never guessed at.
  it('knows a version only as mongo-tools reads one', () => {
    for (const v of ['8.3.11', '6.0.29', '8.3.0-rc1', '7.0.0+x']) expect(knownVersion(v), v).toBe(true)
    for (const v of [null, undefined, '', 'unknown', '8.3', '8.3.11abc', '8.3.0.1'])
      expect(knownVersion(v), String(v)).toBe(false)
  })

  // Review of the CI fixes (important 2): mongorestore 100.16 on finds an 8.3 archive's series only
  // under its own name, which only mongodump 100.16 on is known to have used.
  it('says whether mongorestore finds a series in an archive, by who made it', () => {
    for (const [archive, tool] of [
      ['8.0.32', 'mongo-manager 2.0.0'],
      ['8.2.6', '100.9.0'],
      [null, null],
      ['8.3.11', '100.16.0'],
      ['8.3.11', '100.19.1'],
      ['9.0.0', 'r101.0.0'],
    ] as const)
      expect(toolsFindSeries(archive, tool), `${archive} ${tool}`).toBe(true)
    for (const [archive, tool] of [
      ['8.3.11', 'mongo-manager 2.0.0'],
      ['8.3.11', '100.15.9'],
      ['8.3.11', null],
      ['9.0.0', 'unknown'],
    ] as const)
      expect(toolsFindSeries(archive, tool), `${archive} ${tool}`).toBe(false)
    // Second review (minor 6): Mongo Manager's own, whose header says its series are under their names.
    expect(toolsFindSeries('8.3.11', 'mongo-manager 2.0.0', true)).toBe(true)
  })

  // Third review (minor 6): on Windows a full path names its drive or share; \\tools is on the
  // current drive.
  it('takes a path as full only where it names its place', () => {
    for (const p of ['C:\\tools', 'c:/tools', '\\\\server\\share\\tools', '//server/share'])
      expect(fullPath(p, 'win32'), p).toBe(true)
    for (const p of ['\\tools', '/tools', 'tools', '.', 'C:tools', ''])
      expect(fullPath(p, 'win32'), p).toBe(false)
    expect(fullPath('/opt/tools', 'linux')).toBe(true)
    for (const p of ['tools', './tools', '']) expect(fullPath(p, 'linux'), p).toBe(false)
    // Fourth review (minors 12, 13): never a share where a place on this computer is meant.
    for (const p of ['\\\\server\\share\\tools', '//server/share', '\\\\?\\C:\\tools'])
      expect(localFullPath(p, 'win32'), p).toBe(false)
    expect(localFullPath('D:\\tools', 'win32')).toBe(true)
  })

  // Fourth review (minor 9): the config's paths are checked for the platform it is for, and said
  // plainly; a service install reads another machine's.
  it('checks the config paths for the platform the config is for', () => {
    const env = { MM_MONGODB_TOOLS_PATH: '/opt/tools', MM_BACKUP_FOLDER_ROOTS: '/srv/backups' }
    expect(resolveConfig({ env, platform: 'linux' }).backup.toolsPath).toBe('/opt/tools')
    expect(() => resolveConfig({ env, platform: 'win32' })).toThrow(
      /absolute path on this computer, with its drive/,
    )
    expect(() =>
      resolveConfig({ env: { MM_BACKUP_FOLDER_ROOTS: '\\\\server\\share' }, platform: 'win32' }),
    ).toThrow(/backup\.folderRoots/)
    expect(() => resolveConfig({ env: { MM_MONGODB_TOOLS_PATH: 'tools' }, platform: 'linux' })).toThrow(
      /must be an absolute path on this computer(?!, with)/,
    )
  })

  it('names the namespace and the options a find or an insert takes', () => {
    expect(seriesAccess('ts', '8.3.11')).toEqual({ coll: 'ts', options: { rawData: true } })
    expect(seriesAccess('ts', '8.0.32')).toEqual({ coll: 'system.buckets.ts', options: {} })
  })
})

/** An archive our writer makes: one time series and its buckets under the names given. */
async function archive(serverVersion: string, names: string[]): Promise<Buffer> {
  const pass = new PassThrough()
  const parts: Buffer[] = []
  pass.on('data', (c: Buffer) => parts.push(c))
  const w = new ArchiveWriter(pass)
  await w.begin({ serverVersion, toolVersion: 'test', mongoManager: null }, [
    { db: 'shop', coll: 'ts', type: 'timeseries', options: { timeseries: { timeField: 't' } }, indexes: [] },
  ])
  for (const name of names) {
    await w.open('shop', name)
    await w.write(Buffer.from(BSON.serialize({ _id: name, control: { version: 1 } })))
    await w.close()
  }
  await w.finish()
  pass.end()
  return Buffer.concat(parts)
}
async function read(buf: Buffer): Promise<ArchiveEvent[]> {
  const out: ArchiveEvent[] = []
  for await (const e of readArchive(
    (async function* () {
      yield buf
    })(),
  ))
    out.push(e)
  return out
}
const data = (ev: ArchiveEvent[]) =>
  ev.flatMap((e) => (e.kind === 'doc' || e.kind === 'end' ? [`${e.kind} ${e.db}.${e.coll}`] : []))

describe('an archive of a time series, read', () => {
  it('of 8.3 or later: its buckets under its own name, given as the rest of the code reads them', async () => {
    expect(data(await read(await archive('8.3.11', ['ts'])))).toEqual([
      'doc shop.system.buckets.ts',
      'end shop.system.buckets.ts',
    ])
  })

  it('of an older server: under system.buckets, as before', async () => {
    expect(data(await read(await archive('8.0.32', ['system.buckets.ts'])))).toEqual([
      'doc shop.system.buckets.ts',
      'end shop.system.buckets.ts',
    ])
  })

  // Our own dumps of an 8.3 server kept the older layout before this fix; they still read.
  it('in the other layout than its version says, still read', async () => {
    expect(data(await read(await archive('8.3.11', ['system.buckets.ts'])))).toEqual([
      'doc shop.system.buckets.ts',
      'end shop.system.buckets.ts',
    ])
    expect(data(await read(await archive('8.0.32', ['ts'])))).toEqual([
      'doc shop.system.buckets.ts',
      'end shop.system.buckets.ts',
    ])
  })

  it('under both names at once, refused as damaged', async () => {
    await expect(read(await archive('8.3.11', ['ts', 'system.buckets.ts']))).rejects.toThrow(
      /a time series is kept under two names/,
    )
  })

  // Review of the CI fixes (minor 12): a prelude that names a collection as a series' buckets.
  it('with a collection named as its buckets in the prelude, refused as damaged', async () => {
    const pass = new PassThrough()
    const parts: Buffer[] = []
    pass.on('data', (c: Buffer) => parts.push(c))
    const w = new ArchiveWriter(pass)
    await w.begin({ serverVersion: '8.0.32', toolVersion: 'test', mongoManager: null }, [
      {
        db: 'shop',
        coll: 'ts',
        type: 'timeseries',
        options: { timeseries: { timeField: 't' } },
        indexes: [],
      },
      { db: 'shop', coll: 'system.buckets.ts', type: 'collection', options: {}, indexes: [] },
    ])
    await w.finish()
    pass.end()
    await expect(read(Buffer.concat(parts))).rejects.toThrow(/a time series is kept under two names/)
  })

  // Third review of the CI fixes (important 1): a header with a key this reader does not know keeps
  // its masked flag and rules (a restore asks before writing *** over values); one it cannot read is
  // damage, never taken for a foreign archive's.
  it("keeps what it knows of a later version's Mongo Manager header, and refuses one it cannot read", async () => {
    const header = (mongoManager: Record<string, unknown>) => {
      const pass = new PassThrough()
      const parts: Buffer[] = []
      pass.on('data', (c: Buffer) => parts.push(c))
      const w = new ArchiveWriter(pass)
      return w
        .begin({ serverVersion: '8.0.32', toolVersion: 'test', mongoManager: mongoManager as never }, [])
        .then(() => w.finish())
        .then(() => {
          pass.end()
          return Buffer.concat(parts)
        })
    }
    const base = {
      tool: 'mongo-manager 9.9.9',
      scope: null,
      masked: true,
      anonymous: false,
      maskedPaths: ['shop.users.email'],
      rules: [{ db: 'shop', coll: 'users', field: 'email' }],
      startedAt: 1,
    }
    const [first] = await read(await header({ ...base, laterKey: { any: 1 } }))
    expect(first!.kind === 'header' && first!.mongoManager).toMatchObject({
      masked: true,
      rules: [{ db: 'shop', coll: 'users', field: 'email' }],
    })
    await expect(
      read(await header({ ...base, tool: `mongo-manager ${VERSION}`, masked: 'yes' })),
    ).rejects.toThrow(/damaged: its Mongo Manager header/)
  })

  // Review of the CI fixes (minor 4): a header mongorestore would refuse is never written.
  it('is written with a server version mongo-tools reads, or 0.0.0', async () => {
    for (const [given, written] of [
      ['8.3.11', '8.3.11'],
      ['8.3.0-rc1', '8.3.0-rc1'],
      ['8.3', '0.0.0'],
      ['8.3.11abc', '0.0.0'],
      ['unknown', '0.0.0'],
    ]) {
      const head = (await read(await archive(given!, ['system.buckets.ts'])))[0]!
      expect(head.kind === 'header' && head.serverVersion, given).toBe(written)
    }
  })
})

// MongoDB 9.0 (local run, 2026-10-20): a 9.0 series says `fixedBucketing` among its options, which an
// 8.0 server refuses to create. Whether a target is older than the server a backup came from is by
// major and minor, as the options a server knows change between releases, never between patches.
describe('a server older than the one a backup came from', () => {
  it('by major and minor, and never when either version is unknown', () => {
    expect(olderServer('8.0.32', '9.0.4')).toBe(true)
    expect(olderServer('8.3.13', '9.0.0')).toBe(true)
    expect(olderServer('8.0.32', '8.3.11')).toBe(true)
    expect(olderServer('9.0.3', '9.0.4')).toBe(false)
    expect(olderServer('9.0.4', '9.0.4')).toBe(false)
    expect(olderServer('9.0.4', '8.0.32')).toBe(false)
    expect(olderServer('10.0.0', '9.9.0')).toBe(false)
    expect(olderServer(null, '9.0.4')).toBe(false)
    expect(olderServer('8.0.32', 'unknown')).toBe(false)
  })
})
