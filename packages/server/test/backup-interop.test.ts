import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BSON, EJSON, Long } from 'bson'
import { MongoClient } from 'mongodb'
import { readArchive, type ArchiveEvent } from '../src/backup/archive-reader'
import { ArchiveWriter, ARCHIVE_MAGIC, TERMINATOR, metadataText } from '../src/backup/archive-writer'
import { Crc64 } from '../src/backup/crc64'
import { startMongo, type TestMongo } from './support/mongo'
import { fixture, fixturesDir, mongoTools } from './support/mongo-tools'
import { slow } from './support/slowness'

const expected = JSON.parse(readFileSync(join(fixturesDir, 'fixtures.json'), 'utf8')) as {
  counts: Record<string, number>
}
const tools = await mongoTools()

async function events(buf: Buffer): Promise<ArchiveEvent[]> {
  const out: ArchiveEvent[] = []
  for await (const e of readArchive(
    (async function* () {
      yield buf
    })(),
  ))
    out.push(e)
  return out
}
const docCounts = (ev: ArchiveEvent[]) => {
  const n: Record<string, number> = {}
  for (const e of ev) if (e.kind === 'doc') n[`${e.db}.${e.coll}`] = (n[`${e.db}.${e.coll}`] ?? 0) + 1
  return n
}
const switchesOf = (ev: ArchiveEvent[]) => {
  let n = 0
  let last = ''
  for (const e of ev)
    if (e.kind === 'doc' && `${e.db}.${e.coll}` !== last) {
      n++
      last = `${e.db}.${e.coll}`
    }
  return n
}

/** A hand-built archive with interleaved segments, as mongodump writes in parallel (Review Focus 4). */
function interleaved(): Buffer {
  const parts: Buffer[] = []
  const magic = Buffer.alloc(4)
  magic.writeUInt32LE(ARCHIVE_MAGIC)
  parts.push(
    magic,
    Buffer.from(
      BSON.serialize({ concurrent_collections: 2, version: '0.1', server_version: '8', tool_version: 't' }),
    ),
  )
  for (const coll of ['a', 'b'])
    parts.push(
      Buffer.from(
        BSON.serialize({
          db: 'p',
          collection: coll,
          metadata: metadataText({ db: 'p', coll, type: 'collection', options: {}, indexes: [] }),
          size: 0,
          type: 'collection',
        }),
      ),
    )
  parts.push(TERMINATOR)
  const crc = { a: new Crc64(), b: new Crc64() }
  const segment = (coll: 'a' | 'b', values: number[]) => {
    parts.push(Buffer.from(BSON.serialize({ db: 'p', collection: coll, EOF: false, CRC: Long.ZERO })))
    for (const v of values) {
      const d = Buffer.from(BSON.serialize({ v }))
      crc[coll].update(d)
      parts.push(d)
    }
    parts.push(TERMINATOR)
  }
  segment('a', [1, 2])
  segment('b', [10])
  segment('a', [3])
  segment('b', [11, 12])
  for (const coll of ['a', 'b'] as const)
    parts.push(
      Buffer.from(BSON.serialize({ db: 'p', collection: coll, EOF: true, CRC: crc[coll].signed() })),
      TERMINATOR,
    )
  return Buffer.concat(parts)
}

describe('real mongodump archives (B20, reader side, committed fixtures)', () => {
  it('reads the plain and gzip archives: metadata, documents, buckets and CRCs', async () => {
    for (const buf of [fixture('shop.archive'), gunzipSync(fixture('shop.archive.gz'))]) {
      const ev = await events(buf)
      const metas = ev
        .filter((e) => e.kind === 'meta')
        .map((e) => (e as { meta: { coll: string; type: string } }).meta)
      expect(metas.map((m) => `${m.coll}:${m.type}`).sort()).toEqual([
        'capped:collection',
        'empty:collection',
        'orders:collection',
        'ts:timeseries',
        'v:view',
      ])
      const n = docCounts(ev)
      expect(n['shop.orders']).toBe(expected.counts['shop.orders'])
      expect(n['shop.system.buckets.ts']).toBeGreaterThan(0)
      expect(ev.filter((e) => e.kind === 'end').every((e) => (e as { crc: string }).crc === 'ok')).toBe(true)
    }
  })

  it('reads interleaved segments and checks each namespace CRC (Review Focus 4)', async () => {
    const ev = await events(interleaved())
    expect(switchesOf(ev)).toBe(4)
    expect(docCounts(ev)).toEqual({ 'p.a': 3, 'p.b': 3 })
    expect(ev.filter((e) => e.kind === 'end').map((e) => (e as { crc: string }).crc)).toEqual(['ok', 'ok'])
  })
})

describe.skipIf(!tools)('mongorestore and mongodump against our code (B20, live)', () => {
  let m: TestMongo
  let client: MongoClient
  const uri = () => `mongodb://127.0.0.1:${m.port}`
  beforeAll(async () => {
    m = await startMongo()
    client = await new MongoClient(uri()).connect()
  }, slow(120_000))
  afterAll(async () => {
    await client?.close()
    await m?.stop()
  })

  it('mongorestore restores an archive our writer made, with a Mongo Manager header', async () => {
    const docs = (await events(fixture('shop.archive'))).filter(
      (e) => e.kind === 'doc' && e.coll === 'orders',
    ) as Array<{ raw: Buffer }>
    const pass = new PassThrough()
    const parts: Buffer[] = []
    pass.on('data', (c: Buffer) => parts.push(c))
    const w = new ArchiveWriter(pass)
    const { version } = await client.db('admin').command({ buildInfo: 1 })
    await w.begin(
      {
        serverVersion: String(version),
        toolVersion: 'mongo-manager test',
        mongoManager: {
          tool: 'mongo-manager test',
          scope: null,
          masked: true,
          anonymous: false,
          maskedPaths: ['shop.orders.email'],
          rules: [],
          startedAt: 1,
        },
      },
      [
        {
          db: 'shop',
          coll: 'orders',
          type: 'collection',
          options: {},
          indexes: [
            { v: 2, key: { _id: 1 }, name: '_id_' },
            { v: 2, key: { email: 1 }, name: 'email_1', unique: true, sparse: true },
          ],
        },
      ],
    )
    await w.open('shop', 'orders')
    for (const d of docs) await w.write(d.raw)
    await w.close()
    await w.finish()
    pass.end()
    const r = spawnSync(tools!.restore, [`--uri=${uri()}`, '--archive', '--nsFrom=shop.*', '--nsTo=ours.*'], {
      input: Buffer.concat(parts),
    })
    expect(r.status, String(r.stderr)).toBe(0)
    const sortById = (list: Array<Record<string, unknown>>) =>
      list.sort((a, b) => String(a._id).localeCompare(String(b._id)))
    const got = sortById(await client.db('ours').collection('orders').find().toArray())
    const want = sortById(docs.map((d) => BSON.deserialize(d.raw)))
    expect(EJSON.stringify(got, { relaxed: false })).toBe(EJSON.stringify(want, { relaxed: false }))
    expect((await client.db('ours').collection('orders').indexes()).map((i) => i.name).sort()).toEqual([
      '_id_',
      'email_1',
    ])
  })

  it('our reader reads a live mongodump, including parallel collections', async () => {
    const par = client.db('par')
    for (const name of ['a', 'b', 'c', 'd'])
      await par
        .collection(name)
        .insertMany(Array.from({ length: 20_000 }, (_, i) => ({ i, pad: 'x'.repeat(50) })))
    const r = spawnSync(
      tools!.dump,
      [`--uri=${uri()}`, '--archive', '--db=par', '--numParallelCollections=4'],
      {
        maxBuffer: 256 * 1024 * 1024,
      },
    )
    expect(r.status, String(r.stderr)).toBe(0)
    const ev = await events(r.stdout)
    expect(docCounts(ev)).toEqual({ 'par.a': 20_000, 'par.b': 20_000, 'par.c': 20_000, 'par.d': 20_000 })
    expect(ev.filter((e) => e.kind === 'end').every((e) => (e as { crc: string }).crc === 'ok')).toBe(true)
  })
})
