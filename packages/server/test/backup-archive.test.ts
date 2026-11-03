import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { BSON, Long, Decimal128, ObjectId, Binary } from 'bson'
import { Crc64 } from '../src/backup/crc64'
import { scanBson } from '../src/backup/bson-scan'
import { ArchiveWriter, ARCHIVE_MAGIC } from '../src/backup/archive-writer'
import { readArchive, type ArchiveEvent } from '../src/backup/archive-reader'
import { AppError } from '../src/errors'
import { fixture } from './support/mongo-tools'
import { VERSION } from '../src/version'

async function collect(src: AsyncIterable<Buffer>): Promise<ArchiveEvent[]> {
  const out: ArchiveEvent[] = []
  for await (const e of readArchive(src)) out.push(e)
  return out
}
async function written(fn: (w: ArchiveWriter) => Promise<void>): Promise<Buffer> {
  const pass = new PassThrough()
  const chunks: Buffer[] = []
  pass.on('data', (c: Buffer) => chunks.push(c))
  const w = new ArchiveWriter(pass)
  await fn(w)
  pass.end()
  return Buffer.concat(chunks)
}
const once = (b: Buffer) =>
  (async function* () {
    yield b
  })()
/** Every byte in its own chunk: the reader must not depend on chunk boundaries. */
const dribble = (b: Buffer) =>
  (async function* () {
    for (let i = 0; i < b.length; i++) yield b.subarray(i, i + 1)
  })()

describe('CRC-64 (Go hash/crc64, ECMA table)', () => {
  it('matches the known check value and is chunk-independent', () => {
    const c = new Crc64()
    c.update(Buffer.from('123456789'))
    // Go: crc64.Checksum([]byte("123456789"), crc64.MakeTable(crc64.ECMA)) = 0x995dc9bbdf1939fa
    expect(c.digest()).toBe(0x995dc9bbdf1939fan)
    const d = new Crc64()
    for (const ch of '123456789') d.update(Buffer.from(ch))
    expect(d.digest()).toBe(c.digest())
    expect(new Crc64().digest()).toBe(0n)
  })
})

describe('BSON scanner (spec §8 B2)', () => {
  it('accepts real documents and refuses damaged or deep ones', () => {
    const doc = Buffer.from(
      BSON.serialize({ a: 1, b: { c: [1, 'x', new ObjectId()] }, d: Long.fromNumber(5) }),
    )
    expect(() => scanBson(doc, 100)).not.toThrow()
    const bad = Buffer.from(doc)
    bad.writeInt32LE(doc.length + 10, 0)
    expect(() => scanBson(bad, 100)).toThrow(AppError)
    let deep: Record<string, unknown> = { v: 1 }
    for (let i = 0; i < 120; i++) deep = { d: deep }
    expect(() => scanBson(Buffer.from(BSON.serialize(deep)), 100)).toThrow(/nested/i)
    const unknownType = Buffer.from(BSON.serialize({ a: 1 }))
    unknownType[4] = 0x7a
    expect(() => scanBson(unknownType, 100)).toThrow(AppError)
  })
})

describe('archive writer and reader (spec §4.1)', () => {
  const docs = [
    {
      _id: 1,
      s: 'é𝄞',
      l: Long.fromNumber(2 ** 40),
      d: Decimal128.fromString('1.10'),
      b: new Binary(Buffer.from([0, 1])),
    },
    { _id: new ObjectId(), n: null, a: [1, [2, [3]]] },
  ]

  it('writes an archive and reads it back, byte for byte, whatever the chunking', async () => {
    const buf = await written(async (w) => {
      await w.begin({ serverVersion: '8.2.6', toolVersion: 'mongo-manager 2.0.0', mongoManager: null }, [
        {
          db: 'shop',
          coll: 'orders',
          type: 'collection',
          options: {},
          indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }],
        },
        { db: 'shop', coll: 'v', type: 'view', options: { viewOn: 'orders', pipeline: [] }, indexes: [] },
      ])
      await w.open('shop', 'orders')
      for (const d of docs) await w.write(Buffer.from(BSON.serialize(d)))
      await w.close()
      await w.open('shop', 'v')
      await w.close()
      await w.finish()
    })
    expect(buf.readUInt32LE(0)).toBe(ARCHIVE_MAGIC)
    for (const src of [once(buf), dribble(buf)]) {
      const events = await collect(src)
      expect(events[0]).toMatchObject({
        kind: 'header',
        serverVersion: '8.2.6',
        concurrent: 1,
        mongoManager: null,
      })
      expect(
        events.filter((e) => e.kind === 'meta').map((e) => (e as { meta: { coll: string } }).meta.coll),
      ).toEqual(['orders', 'v'])
      const read = events.filter((e) => e.kind === 'doc').map((e) => (e as { raw: Buffer }).raw)
      expect(read).toEqual(docs.map((d) => Buffer.from(BSON.serialize(d))))
      expect(events.filter((e) => e.kind === 'end')).toEqual([
        { kind: 'end', db: 'shop', coll: 'orders', crc: 'ok' },
        { kind: 'end', db: 'shop', coll: 'v', crc: 'ok' },
      ])
    }
  })

  it('reports a CRC mismatch, and refuses forged structure (B2)', async () => {
    const good = await written(async (w) => {
      await w.begin({ serverVersion: 'x', toolVersion: 'y', mongoManager: null }, [
        { db: 'a', coll: 'b', type: 'collection', options: {}, indexes: [] },
      ])
      await w.open('a', 'b')
      await w.write(Buffer.from(BSON.serialize({ x: 1 })))
      await w.close()
      await w.finish()
    })
    const flipped = Buffer.from(good)
    const at = flipped.lastIndexOf(Buffer.from('CRC'))
    flipped[at + 4]! ^= 0xff
    const ends = (await collect(once(flipped))).filter((e) => e.kind === 'end')
    expect(ends).toEqual([{ kind: 'end', db: 'a', coll: 'b', crc: 'mismatch' }])

    // A segment for a namespace the prelude never named.
    const ghost = await written(async (w) => {
      await w.begin({ serverVersion: 'x', toolVersion: 'y', mongoManager: null }, [
        { db: 'a', coll: 'b', type: 'collection', options: {}, indexes: [] },
      ])
      await w.open('a', 'zz')
      await w.write(Buffer.from(BSON.serialize({ x: 1 })))
      await w.close()
      await w.finish()
    })
    const forged: Array<[string, Buffer]> = [
      ['not an archive', Buffer.from('hello world, not an archive')],
      ['truncated', good.subarray(0, good.length - 9)],
      ['huge length', Buffer.concat([good.subarray(0, 4), Buffer.from([0xff, 0xff, 0xff, 0x7f])])],
      ['unknown namespace', ghost],
    ]
    for (const [label, buf] of forged)
      await expect(collect(once(buf)), label).rejects.toBeInstanceOf(AppError)
  })

  it('refuses an archive cut anywhere, even at a segment boundary (final review C1)', async () => {
    const full = fixture('shop.archive')
    await expect(collect(once(full))).resolves.toBeTruthy()
    let refused = 0
    for (let n = 8; n < full.length; n++) {
      const cut = await collect(once(full.subarray(0, n))).then(
        () => null,
        (e: unknown) => e,
      )
      expect(cut, `cut at ${n} of ${full.length}`).toBeInstanceOf(AppError)
      refused++
    }
    expect(refused).toBe(full.length - 8)
  })

  it('writes a server version mongorestore can parse, whatever it was given', async () => {
    const buf = await written(async (w) => {
      await w.begin({ serverVersion: 'weird', toolVersion: 't', mongoManager: null }, [])
      await w.finish()
    })
    const [header] = await collect(once(buf))
    expect(header).toMatchObject({ serverVersion: '0.0.0' })
  })

  // Third and fourth reviews of the CI fixes: a malformed header is damage, never a foreign archive's
  // (its masked flag and rules would go); one made by a later Mongo Manager says so.
  it('keeps a valid Mongo Manager header and refuses a malformed one', async () => {
    const mm = {
      // This version's own header: one of a later version is refused for another reason.
      tool: `mongo-manager ${VERSION}`,
      scope: { kind: 'server' as const },
      masked: true,
      anonymous: false,
      maskedPaths: ['shop.orders.email'],
      rules: [{ db: 'shop', coll: 'orders', field: 'email' }],
      startedAt: 5,
    }
    const buf = await written(async (w) => {
      await w.begin({ serverVersion: 'x', toolVersion: 'y', mongoManager: mm }, [])
      await w.finish()
    })
    const [header] = await collect(once(buf))
    expect(header).toMatchObject({ kind: 'header', mongoManager: mm })
    const bad = await written(async (w) => {
      await w.begin(
        { serverVersion: 'x', toolVersion: 'y', mongoManager: { ...mm, masked: 'yes' } as never },
        [],
      )
      await w.finish()
    })
    await expect(collect(once(bad))).rejects.toThrow(/The backup is damaged: its Mongo Manager header/)
    const later = await written(async (w) => {
      await w.begin(
        {
          serverVersion: 'x',
          toolVersion: 'y',
          mongoManager: { ...mm, tool: 'mongo-manager 99.0.0', scope: { kind: 'galaxy' } } as never,
        },
        [],
      )
      await w.finish()
    })
    await expect(collect(once(later))).rejects.toThrow(
      /made by a later Mongo Manager \(99\.0\.0\): update Mongo Manager to restore it/,
    )
  })
})
