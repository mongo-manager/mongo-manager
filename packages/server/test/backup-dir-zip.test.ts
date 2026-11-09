// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { createWriteStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { BSON } from 'bson'
import { readDirectoryZip } from '../src/backup/dir-zip-reader'
import type { ArchiveEvent } from '../src/backup/archive-reader'
import { ZipWriter } from '../src/transfer/formats/zip'
import { AppError } from '../src/errors'
import { fixturesDir } from './support/mongo-tools'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function eventsOf(path: string, opts?: { maxEntries?: number }): Promise<ArchiveEvent[]> {
  const handle = await open(path, 'r')
  try {
    const out: ArchiveEvent[] = []
    for await (const e of readDirectoryZip(handle, statSync(path).size, opts)) out.push(e)
    return out
  } finally {
    await handle.close()
  }
}
async function makeZip(entries: Array<[string, Buffer]>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mm-zip-'))
  dirs.push(dir)
  const path = join(dir, 'x.zip')
  const file = createWriteStream(path)
  const zip = new ZipWriter(file)
  for (const [name, data] of entries) await zip.add(name, data)
  await zip.finish()
  file.end()
  await once(file, 'close')
  return path
}
const meta = (coll: string) =>
  Buffer.from(
    JSON.stringify({
      indexes: [{ v: { $numberInt: '2' }, key: { _id: { $numberInt: '1' } }, name: '_id_' }],
      collectionName: coll,
      type: 'collection',
    }),
  )
const bson = (...docs: object[]) => Buffer.concat(docs.map((d) => Buffer.from(BSON.serialize(d))))

const seriesMeta = Buffer.from(
  JSON.stringify({
    options: { timeseries: { timeField: 't' } },
    indexes: [],
    collectionName: 'ts',
    type: 'timeseries',
  }),
)
const dataOf = (ev: ArchiveEvent[]) =>
  ev.flatMap((e) => (e.kind === 'doc' || e.kind === 'end' ? [`${e.kind} ${e.db}.${e.coll}`] : []))

// CI 2026-10-18: mongodump of an 8.3 server keeps a time series' buckets in <name>.bson, an older
// one in system.buckets.<name>.bson; both are given as the rest of the code reads them.
describe('a time series in a directory zip', () => {
  it('in either layout, read under system.buckets', async () => {
    for (const file of ['shop/ts.bson', 'shop/system.buckets.ts.bson']) {
      const ev = await eventsOf(
        await makeZip([
          ['shop/ts.metadata.json', seriesMeta],
          [file, bson({ _id: 1, control: { version: 1 } })],
        ]),
      )
      expect(dataOf(ev), file).toEqual(['doc shop.system.buckets.ts', 'end shop.system.buckets.ts'])
    }
  })

  it('under both names at once, refused as damaged', async () => {
    const path = await makeZip([
      ['shop/ts.metadata.json', seriesMeta],
      ['shop/ts.bson', bson({ _id: 1 })],
      ['shop/system.buckets.ts.bson', bson({ _id: 2 })],
    ])
    await expect(eventsOf(path)).rejects.toThrow(/a time series is kept under two names/)
    // A name with dots in it too.
    const dotted = Buffer.from(
      JSON.stringify({
        options: { timeseries: { timeField: 't' } },
        indexes: [],
        collectionName: 'm.ts',
        type: 'timeseries',
      }),
    )
    const both = await makeZip([
      ['shop/m.ts.metadata.json', dotted],
      ['shop/m.ts.bson', bson({ _id: 1 })],
      ['shop/system.buckets.m.ts.bson', bson({ _id: 2 })],
    ])
    await expect(eventsOf(both)).rejects.toThrow(/a time series is kept under two names/)
    // Review of the CI fixes (minor 12): or a collection's metadata named as its buckets.
    const named = await makeZip([
      ['shop/ts.metadata.json', seriesMeta],
      ['shop/system.buckets.ts.metadata.json', meta('system.buckets.ts')],
    ])
    await expect(eventsOf(named)).rejects.toThrow(/a time series is kept under two names/)
  })
})

describe('mongodump directory zips (spec §4.2)', () => {
  it('reads the real directory fixture under a dump/ folder, metadata first', async () => {
    const ev = await eventsOf(join(fixturesDir, 'shop-dir.zip'))
    const prelude = ev.findIndex((e) => e.kind === 'prelude-end')
    expect(ev.slice(0, prelude).some((e) => e.kind === 'meta')).toBe(true)
    expect(ev.slice(prelude).some((e) => e.kind === 'meta')).toBe(false)
    const counts: Record<string, number> = {}
    for (const e of ev)
      if (e.kind === 'doc') counts[`${e.db}.${e.coll}`] = (counts[`${e.db}.${e.coll}`] ?? 0) + 1
    const expected = JSON.parse(readFileSync(join(fixturesDir, 'fixtures.json'), 'utf8'))
    expect(counts['shop.orders']).toBe(expected.counts['shop.orders'])
    expect(counts['shop.system.buckets.ts']).toBeGreaterThan(0)
    expect(ev.filter((e) => e.kind === 'end').every((e) => (e as { crc: string }).crc === 'absent')).toBe(
      true,
    )
    const types = ev
      .filter((e) => e.kind === 'meta')
      .map((e) => (e as { meta: { coll: string; type: string } }).meta)
    expect(types.find((m) => m.coll === 'v')?.type).toBe('view')
    expect(types.find((m) => m.coll === 'ts')?.type).toBe('timeseries')
  })

  it('reads gzipped entries and a .bson without metadata', async () => {
    const path = await makeZip([
      ['shop/a.bson.gz', gzipSync(bson({ x: 1 }, { x: 2 }))],
      ['shop/a.metadata.json.gz', gzipSync(meta('a'))],
      ['shop/b.bson', bson({ y: 1 })],
    ])
    const ev = await eventsOf(path)
    expect(
      ev
        .filter((e) => e.kind === 'meta')
        .map((e) => (e as { meta: { coll: string } }).meta.coll)
        .sort(),
    ).toEqual(['a', 'b'])
    expect(ev.filter((e) => e.kind === 'doc')).toHaveLength(3)
  })

  it('refuses path tricks, links, damaged BSON and too many entries (B5, B2)', async () => {
    const cases: Array<[string, Promise<string>, { maxEntries?: number }?]> = [
      ['parent segment', makeZip([['shop/../x.bson', bson({ a: 1 })]])],
      ['backslash', makeZip([['shop\\x.bson', bson({ a: 1 })]])],
      ['absolute', makeZip([['/shop/x.bson', bson({ a: 1 })]])],
      ['damaged bson', makeZip([['shop/x.bson', Buffer.from([9, 0, 0, 0, 1, 2])]])],
      [
        'too many',
        makeZip([
          ['shop/a.bson', bson({})],
          ['shop/b.bson', bson({})],
          ['shop/c.bson', bson({})],
        ]),
        { maxEntries: 2 },
      ],
    ]
    // A symbolic link entry: Unix "made by" and S_IFLNK in the external attributes.
    const linkPath = await makeZip([['shop/x.bson', bson({ a: 1 })]])
    const buf = readFileSync(linkPath)
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    buf[cd + 5] = 3
    buf.writeUInt32LE((0o120777 << 16) >>> 0, cd + 38)
    writeFileSync(linkPath, buf)
    cases.push(['symbolic link', Promise.resolve(linkPath)])
    for (const [label, made, opts] of cases)
      await expect(eventsOf(await made, opts), label).rejects.toBeInstanceOf(AppError)
    await expect(eventsOf(linkPath)).rejects.toThrow(/symbolic links/)
    await expect(eventsOf(await cases[0]![1])).rejects.toThrow(/unsafe path/)
  })
})

describe('directory zip bounds (final review I6)', () => {
  it('refuses more metadata in all than an archive may hold, however small each entry', async () => {
    // Twenty entries of 1 MiB of metadata each, each within the inflate ratio (random letters
    // compress about twice): 20 MiB in all, from about 11 MiB of zip.
    // In place in one buffer: a string built a character at a time took most of the test's time,
    // and ran past its timeout under a full suite's load.
    const letters = (n: number) => {
      const bytes = randomBytes(n)
      for (let i = 0; i < n; i++) bytes[i] = 97 + (bytes[i]! % 16)
      return bytes.toString('latin1')
    }
    const big = (coll: string) =>
      gzipSync(
        Buffer.from(
          JSON.stringify({
            options: { pad: letters(1024 * 1024) },
            indexes: [],
            collectionName: coll,
            type: 'collection',
          }),
        ),
      )
    const path = await makeZip(
      Array.from({ length: 20 }, (_, i) => [`shop/c${i}.metadata.json.gz`, big(`c${i}`)] as [string, Buffer]),
    )
    await expect(eventsOf(path)).rejects.toMatchObject({
      message: expect.stringMatching(/too much metadata/),
    })
  })

  it('stops a .bson entry that expands past the backup inflate ratio (B1)', async () => {
    const zeros = new Uint8Array(1024 * 1024)
    const docs = Buffer.concat(
      Array.from({ length: 100 }, (_, i) => Buffer.from(BSON.serialize({ i, z: zeros }))),
    )
    const path = await makeZip([
      ['shop/z.metadata.json', meta('z')],
      ['shop/z.bson', docs],
    ])
    expect(statSync(path).size).toBeLessThan(docs.length / 200)
    await expect(eventsOf(path)).rejects.toMatchObject({ details: { reason: 'inflate' } })
  })
})

describe('directory zip names (final review, declined item: mongodump escapes file names)', () => {
  it('reads collection names as mongodump escaped them in the file names', async () => {
    const path = await makeZip([
      ['dump/shop/a%2Fb.metadata.json', meta('a/b')],
      ['dump/shop/a%2Fb.bson', bson({ x: 1 })],
      ['dump/shop/g+h.bson', bson({ y: 1 })],
      ['dump/shop/e%25f.bson', bson({ z: 1 })],
    ])
    const events = await eventsOf(path)
    const names = events.flatMap((e) => (e.kind === 'meta' ? [e.meta.coll] : [])).sort()
    expect(names).toEqual(['a/b', 'e%f', 'g h'])
    expect(
      events
        .filter((e) => e.kind === 'doc')
        .map((e) => (e as { coll: string }).coll)
        .sort(),
    ).toEqual(['a/b', 'e%f', 'g h'])
  })

  it('refuses a file name that is not escaped as mongodump escapes them', async () => {
    const path = await makeZip([['dump/shop/bad%zz.bson', bson({ x: 1 })]])
    await expect(eventsOf(path)).rejects.toBeInstanceOf(AppError)
  })
})
