import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { GridFSBucket, type MongoClient, type ObjectId } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 1),
])
const idOf = (id: unknown) => Buffer.from(JSON.stringify({ $oid: String(id) })).toString('base64url')

async function files(client: MongoClient) {
  const db = `gp${randomUUID().slice(0, 8)}`
  const put = (name: string, bytes: Buffer, contentType?: string) =>
    new Promise<ObjectId>((resolve, reject) => {
      const up = new GridFSBucket(client.db(db)).openUploadStream(name, {
        metadata: contentType ? { contentType } : {},
      })
      up.on('finish', () => resolve(up.id as ObjectId)).on('error', reject)
      up.end(bytes)
    })
  return { db, put }
}
async function local() {
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const client = await h.client()
  const f = await files(client)
  const preview = (id: ObjectId) => h.call('GET', `/databases/${f.db}/gridfs/fs/files/${idOf(id)}/preview`)
  return { h, ...f, preview }
}

describe('GridFS previews (user request 2026-10-10)', () => {
  it('shows an image by what its bytes are, never by the type it was stored with, sandboxed', async () => {
    const { put, preview } = await local()
    const res = await preview(await put('logo.png', PNG, 'text/html'))
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-preview-kind']).toBe('image')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; sandbox")
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.rawPayload.equals(PNG)).toBe(true)
  })

  it('shows markup — html, svg, an html file named like an image — as plain text only', async () => {
    const { put, preview } = await local()
    for (const [name, body, type] of [
      ['photo.png', '<html><script>alert(1)</script></html>', 'image/png'],
      [
        'icon.svg',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        'image/svg+xml',
      ],
      ['page.html', '<!doctype html><script>alert(1)</script>', 'text/html'],
    ] as const) {
      const res = await preview(await put(name, Buffer.from(body), type))
      expect(res.statusCode, name).toBe(200)
      expect(res.headers['content-type'], name).toBe('text/plain; charset=utf-8')
      expect(res.headers['x-preview-kind'], name).toBe('text')
      expect(res.body, name).toBe(body)
    }
  })

  it('reads only the start of a long text, never cutting a character in two', async () => {
    const { put, preview } = await local()
    // "ş" is two bytes: one straddles the 256 KiB limit.
    const text = `${'a'.repeat(256 * 1024 - 1)}ş${'b'.repeat(50_000)}`
    const res = await preview(await put('long.log', Buffer.from(text)))
    expect(res.headers['x-preview-truncated']).toBe('1')
    expect(res.body).toBe('a'.repeat(256 * 1024 - 1))
    const short = await preview(await put('short.txt', Buffer.from('kısa metin')))
    expect(short.headers['x-preview-truncated']).toBeUndefined()
    expect(short.body).toBe('kısa metin')
  })

  it('knows sound and video by their bytes', async () => {
    const { put, preview } = await local()
    const box = (brand: string) =>
      Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(20)])
    const riff = (kind: string) =>
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(kind), Buffer.alloc(20)])
    const cases: Array<[Buffer, string, string]> = [
      [box('isom'), 'video/mp4', 'video'],
      [box('M4A '), 'audio/mp4', 'audio'],
      [box('avif'), 'image/avif', 'image'],
      [Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]), 'video/webm', 'video'],
      [Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]), 'audio/mpeg', 'audio'],
      [Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)]), 'audio/ogg', 'audio'],
      [riff('WAVE'), 'audio/wav', 'audio'],
      [riff('WEBP'), 'image/webp', 'image'],
      [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]), 'image/jpeg', 'image'],
      [Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]), 'image/gif', 'image'],
    ]
    for (const [bytes, type, kind] of cases) {
      const res = await preview(await put('x.bin', bytes))
      expect(res.headers['content-type'], type).toBe(type)
      expect(res.headers['x-preview-kind'], type).toBe(kind)
    }
  })

  it('offers no preview of other bytes, nor of an image too large for one', async () => {
    const { put, preview } = await local()
    const binary = await preview(await put('data.bin', Buffer.from([1, 2, 0, 3, 4])))
    expect(binary.statusCode).toBe(415)
    expect(binary.json().details.reason).toBe('no_preview')
    const empty = await preview(await put('empty.txt', Buffer.alloc(0)))
    expect(empty.statusCode).toBe(200)
    expect(empty.body).toBe('')
    const big = await preview(await put('huge.png', Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)])))
    expect(big.statusCode).toBe(413)
    expect(big.json().details.reason).toBe('too_large')
  })

  it('streams a large image whole, beyond what it read first', async () => {
    const { put, preview } = await local()
    const big = Buffer.concat([PNG, Buffer.from(Array.from({ length: 600 * 1024 }, (_, i) => i % 253))])
    const res = await preview(await put('photo.png', big))
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-length']).toBe(String(big.length))
    expect(res.rawPayload.equals(big)).toBe(true)
  })

  it('refuses a sound or video over 50 MB', async () => {
    const { put, preview } = await local()
    const video = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypisom'),
      Buffer.alloc(50 * 1024 * 1024 + 1),
    ])
    const res = await preview(await put('film.mp4', video))
    expect(res.statusCode).toBe(413)
  })

  it('says a file is damaged when content is missing, never sending part of it', async () => {
    const { h, db, put, preview } = await local()
    const client = await h.client()
    const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024, 7)])
    for (const n of [1, 2]) {
      const id = await put(`hole${n}.png`, big)
      await client.db(db).collection('fs.chunks').deleteOne({ files_id: id, n })
      const res = await preview(id)
      expect(res.statusCode, `chunk ${n}`).toBe(422)
      expect(res.json().details.reason).toBe('damaged')
      const download = await h.call('GET', `/databases/${db}/gridfs/fs/files/${idOf(id)}/download`)
      expect(download.statusCode, `download ${n}`).toBe(422)
    }
  })

  it('knows an AVIF by a compatible brand too', async () => {
    const { put, preview } = await local()
    const avif = Buffer.concat([
      Buffer.from([0, 0, 0, 0x1c]),
      Buffer.from('ftypmif1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mif1avifmiaf'),
      Buffer.alloc(16),
    ])
    expect((await preview(await put('pic.avif', avif))).headers['content-type']).toBe('image/avif')
  })

  it('refuses an id that is a query operator', async () => {
    const { h, db } = await local()
    const id = Buffer.from('{"$ne":null}').toString('base64url')
    expect((await h.call('GET', `/databases/${db}/gridfs/fs/files/${id}/preview`)).statusCode).toBe(400)
  })
})

describe('GridFS previews and who may see them', () => {
  it('lets a reader preview, never a restricted user where a rule reaches the bucket; audits it without the content', async () => {
    const h = await teamHarness(mongo)
    closers.push(h.t.close)
    const { db, put } = await files(await h.client())
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'fs.chunks', field: 'data' }])
    const id = await put('notes.txt', Buffer.from('secret text'))
    const path = `/databases/${db}/gridfs/fs/files/${idOf(id)}/preview`
    expect((await h.user('viewer').call('GET', path)).statusCode).toBe(200)
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    expect((await masked.call('GET', path)).statusCode).toBe(403)
    const entries = h.t.app.ctx.audit.list({ action: 'gridfs.preview' })
    expect(entries.map((e) => e.outcome)).toEqual(expect.arrayContaining(['success', 'denied']))
    expect(entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(entries)).not.toContain('secret text')
  })
})
