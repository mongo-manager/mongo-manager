import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Double, GridFSBucket, Int32, Long, ObjectId, type MongoClient } from 'mongodb'
import { setFileFields } from '../src/routes/data/gridfs'
import type { GridFsFile, GridFsPage } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'
import { registerKeyVaults } from '../src/connections/access'

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

/** A database of its own with two buckets and a plain collection. */
async function seed(client: MongoClient) {
  const db = `gf${randomUUID().slice(0, 8)}`
  const put = (bucket: string, name: string, bytes: Buffer, metadata?: object) =>
    new Promise<ObjectId>((resolve, reject) => {
      const up = new GridFSBucket(client.db(db), { bucketName: bucket }).openUploadStream(name, { metadata })
      up.on('finish', () => resolve(up.id as ObjectId)).on('error', reject)
      up.end(bytes)
    })
  const report = await put('fs', 'Report Q1.pdf', Buffer.alloc(3000, 1), {
    contentType: 'application/pdf',
    owner: 'ada@example.com',
  })
  await put('fs', 'report q2.pdf', Buffer.alloc(10, 2), { contentType: 'application/pdf' })
  await put('fs', 'photo.png', Buffer.alloc(500, 3))
  await put('photos', 'cat.jpg', Buffer.from('meow'))
  await client.db(db).collection('plain').insertOne({ a: 1 })
  return { db, report, put }
}
const idOf = (id: unknown) => Buffer.from(JSON.stringify({ $oid: String(id) })).toString('base64url')
type Harness = Awaited<ReturnType<typeof dataHarness>>
const seedId = async (client: MongoClient, db: string, name: string) =>
  (await client.db(db).collection('fs.files').findOne({ filename: name }))?._id
/** The version of a file's metadata the app shows, which a change of it names. */
const versionOf = async (h: Harness, db: string, name: string): Promise<string> =>
  ((await h.call('GET', `/databases/${db}/gridfs/fs/files`)).json() as GridFsPage).files.find(
    (f) => f.filename === name,
  )!.version!

async function local(overrides: Record<string, unknown> = {}) {
  const h = await dataHarness(mongo, overrides)
  closers.push(h.t.close)
  const client = await h.client()
  return { h, client, ...(await seed(client)) }
}

describe('GridFS buckets (phase 4b §1)', () => {
  it('lists the buckets of a database, not its other collections', async () => {
    const { h, db } = await local()
    const res = await h.call('GET', `/databases/${db}/gridfs`)
    expect(res.json()).toEqual([{ name: 'fs' }, { name: 'photos' }])
  })

  it('lists files with their size, type and metadata; searches by the start of a name, any case', async () => {
    const { h, db } = await local()
    const page = (await h.call('GET', `/databases/${db}/gridfs/fs/files`)).json() as GridFsPage
    expect(page.files.map((f) => f.filename).sort()).toEqual(['Report Q1.pdf', 'photo.png', 'report q2.pdf'])
    const q1 = page.files.find((f) => f.filename === 'Report Q1.pdf')!
    expect(q1).toMatchObject({
      length: 3000,
      contentType: 'application/pdf',
      metadata: { owner: 'ada@example.com' },
    })
    expect(typeof q1.id).toBe('string')
    const found = (await h.call('GET', `/databases/${db}/gridfs/fs/files?q=rep`)).json() as GridFsPage
    expect(found.files.map((f) => f.filename).sort()).toEqual(['Report Q1.pdf', 'report q2.pdf'])
    // A search is a prefix, never a pattern.
    expect(
      ((await h.call('GET', `/databases/${db}/gridfs/fs/files?q=.*`)).json() as GridFsPage).files,
    ).toEqual([])
    const bySize = (
      await h.call('GET', `/databases/${db}/gridfs/fs/files?sort=length&dir=asc&limit=2`)
    ).json() as GridFsPage
    expect(bySize.files.map((f) => f.length)).toEqual([10, 500])
    expect(bySize.next).toBe(2)
  })

  it('downloads a file as an attachment that never renders, its name safe in the header', async () => {
    const { h, db, put } = await local()
    const evil = await put(
      'fs',
      'evil"\r\nX-Injected: 1 ünïcode.html',
      Buffer.from('<script>alert(1)</script>'),
      {
        contentType: 'text/html',
      },
    )
    const res = await h.call('GET', `/databases/${db}/gridfs/fs/files/${idOf(evil)}/download`)
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.toString()).toBe('<script>alert(1)</script>')
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-injected']).toBeUndefined()
    expect(String(res.headers['content-disposition'])).toMatch(
      /^attachment; filename="[^"\r\n]*"; filename\*=UTF-8''/,
    )
    expect(h.t.app.ctx.audit.list({ action: 'gridfs.download' })[0]).toMatchObject({ outcome: 'success' })
  })

  it('uploads, renames, describes and deletes a file; every change audited without its content', async () => {
    const { h, db, client } = await local()
    const up = await h.raw(
      'PUT',
      `/databases/${db}/gridfs/fs/files?filename=${encodeURIComponent('notes.txt')}&contentType=text%2Fplain`,
      Buffer.from('hello gridfs'),
    )
    expect(up.statusCode).toBe(201)
    const file = up.json() as GridFsFile
    expect(file).toMatchObject({ filename: 'notes.txt', length: 12, contentType: 'text/plain' })
    const back = await h.call('GET', `/databases/${db}/gridfs/fs/files/${file.id}/download`)
    expect(back.rawPayload.toString()).toBe('hello gridfs')
    const renamed = await h.call('PATCH', `/databases/${db}/gridfs/fs/files/${file.id}`, {
      filename: 'notes-2.txt',
      metadata: { tag: 'kept' },
      version: file.version,
    })
    expect(renamed.json()).toMatchObject({ filename: 'notes-2.txt', metadata: { tag: 'kept' } })
    expect((await h.call('DELETE', `/databases/${db}/gridfs/fs/files/${file.id}`)).statusCode).toBe(204)
    expect(await client.db(db).collection('fs.files').countDocuments({ filename: 'notes-2.txt' })).toBe(0)
    const actions = h.t.app.ctx.audit.list({ limit: 50 }).map((e) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['gridfs.upload', 'gridfs.update', 'gridfs.delete']))
    expect(JSON.stringify(h.t.app.ctx.audit.list({ limit: 50 }))).not.toContain('hello gridfs')
  })

  it('stops an upload over the limit and leaves no chunks behind', async () => {
    const { h, db, client } = await local({ gridfsMaxMb: 1 })
    const chunksBefore = await client.db(db).collection('fs.chunks').countDocuments()
    const big = Buffer.alloc(1024 * 1024 + 10, 7)
    const res = await h.raw('PUT', `/databases/${db}/gridfs/fs/files?filename=big.bin`, big)
    expect(res.statusCode).toBe(413)
    expect(await client.db(db).collection('fs.files').countDocuments({ filename: 'big.bin' })).toBe(0)
    expect(await client.db(db).collection('fs.chunks').countDocuments()).toBe(chunksBefore)
  })

  it('counts a streamed upload that says no size, and stops it past the limit', async () => {
    const { h, db, client } = await local({ gridfsMaxMb: 1 })
    const chunksBefore = await client.db(db).collection('fs.chunks').countDocuments()
    // No content-length: chunks of 256 KiB, five of them (past 1 MB).
    const body = Readable.from(Array.from({ length: 5 }, () => Buffer.alloc(256 * 1024, 9)))
    const res = await h.t.app.inject({
      method: 'PUT',
      url: `/api/connections/${h.connectionId}/databases/${db}/gridfs/fs/files?filename=streamed.bin`,
      headers: { ...h.headers, 'content-type': 'application/octet-stream' },
      payload: body,
    })
    expect(res.statusCode).toBe(413)
    expect(await client.db(db).collection('fs.files').countDocuments({ filename: 'streamed.bin' })).toBe(0)
    expect(await client.db(db).collection('fs.chunks').countDocuments()).toBe(chunksBefore)
  })

  it('refuses a bad bucket, file id, file name or body', async () => {
    const { h, db } = await local()
    for (const bucket of ['a.b', '$x', 'x'.repeat(65)])
      expect(
        (await h.call('GET', `/databases/${db}/gridfs/${encodeURIComponent(bucket)}/files`)).statusCode,
      ).toBe(400)
    expect((await h.call('GET', `/databases/${db}/gridfs/fs/files/not!an!id/download`)).statusCode).toBe(400)
    expect(
      (await h.call('GET', `/databases/${db}/gridfs/fs/files/${idOf(new ObjectId())}/download`)).statusCode,
    ).toBe(404)
    expect(
      (
        await h.raw(
          'PUT',
          `/databases/${db}/gridfs/fs/files?filename=${encodeURIComponent('a\u0000b')}`,
          Buffer.from('x'),
        )
      ).statusCode,
    ).toBe(400)
    // Only raw bytes are taken.
    expect(
      (await h.call('PUT', `/databases/${db}/gridfs/fs/files?filename=x.json`, { a: 1 })).statusCode,
    ).toBe(415)
  })
})

describe('GridFS abuse cases (4b review)', () => {
  const raw = (json: string) => Buffer.from(json).toString('base64url')

  it('refuses an id that is a query operator: one request never reaches other files', async () => {
    const { h, db, client } = await local()
    const files = () => client.db(db).collection('fs.files').countDocuments()
    const chunks = () => client.db(db).collection('fs.chunks').countDocuments()
    const before = { files: await files(), chunks: await chunks() }
    for (const id of [raw('{"$ne":null}'), raw('{"$gt":{"$minKey":1}}'), raw('{"$in":[]}')]) {
      expect((await h.call('DELETE', `/databases/${db}/gridfs/fs/files/${id}`)).statusCode).toBe(400)
      expect(
        (await h.call('PATCH', `/databases/${db}/gridfs/fs/files/${id}`, { filename: 'pwned' })).statusCode,
      ).toBe(400)
      expect((await h.call('GET', `/databases/${db}/gridfs/fs/files/${id}/download`)).statusCode).toBe(400)
    }
    // A regex is a value, matched only by an equal regex: never a pattern over the names.
    const pattern = raw('{"$regularExpression":{"pattern":".","options":""}}')
    expect((await h.call('DELETE', `/databases/${db}/gridfs/fs/files/${pattern}`)).statusCode).toBe(404)
    expect({ files: await files(), chunks: await chunks() }).toEqual(before)
    expect(await client.db(db).collection('fs.files').countDocuments({ filename: 'pwned' })).toBe(0)
  })

  it('removes every chunk of an upload whose client goes away mid-stream', async () => {
    const { h, db, client } = await local()
    const chunksBefore = await client.db(db).collection('fs.chunks').countDocuments()
    let sent = 0
    // Three chunks' worth, then the connection breaks.
    const body = new Readable({
      read() {
        if (sent++ < 3) this.push(Buffer.alloc(300 * 1024, 5))
        else this.destroy(new Error('socket hang up'))
      },
    })
    const res = await h.t.app
      .inject({
        method: 'PUT',
        url: `/api/connections/${h.connectionId}/databases/${db}/gridfs/fs/files?filename=cut.bin`,
        headers: { ...h.headers, 'content-type': 'application/octet-stream' },
        payload: body,
      })
      .catch(() => null)
    if (res) expect(res.statusCode).toBeGreaterThanOrEqual(400)
    // Settled once the handler has cleaned up (its last write awaited before the removal).
    await new Promise((r) => setTimeout(r, 300))
    expect(await client.db(db).collection('fs.files').countDocuments({ filename: 'cut.bin' })).toBe(0)
    expect(await client.db(db).collection('fs.chunks').countDocuments()).toBe(chunksBefore)
  })

  it('stores an upload readable by GridFS itself, in chunks, an empty one too', async () => {
    const { h, db, client } = await local()
    const bytes = Buffer.from(Array.from({ length: 600 * 1024 }, (_, i) => i % 251))
    const up = (
      await h.raw('PUT', `/databases/${db}/gridfs/fs/files?filename=big.bin`, bytes)
    ).json() as GridFsFile
    expect(up.length).toBe(bytes.length)
    const back: Buffer[] = []
    for await (const piece of new GridFSBucket(client.db(db)).openDownloadStreamByName('big.bin'))
      back.push(piece as Buffer)
    expect(Buffer.concat(back).equals(bytes)).toBe(true)
    const empty = await h.raw('PUT', `/databases/${db}/gridfs/fs/files?filename=empty.txt`, Buffer.alloc(0))
    expect(empty.statusCode).toBe(201)
    expect(
      (await h.call('GET', `/databases/${db}/gridfs/fs/files/${(empty.json() as GridFsFile).id}/download`))
        .rawPayload.length,
    ).toBe(0)
  })

  it('downloads a file whose id is a long string (a URL parameter far past 100 characters)', async () => {
    const { h, db, client } = await local()
    const id = `report-${'x'.repeat(200)}`
    await new Promise((resolve, reject) => {
      const up = new GridFSBucket(client.db(db)).openUploadStreamWithId(id as never, 'long.txt')
      up.on('finish', resolve).on('error', reject)
      up.end(Buffer.from('long id'))
    })
    const fileId = Buffer.from(JSON.stringify(id)).toString('base64url')
    expect(fileId.length).toBeGreaterThan(200)
    const res = await h.call('GET', `/databases/${db}/gridfs/fs/files/${fileId}/download`)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('long id')
  })

  it('refuses names that pose as others (bidi controls, C1 controls, line separators)', async () => {
    const { h, db, report } = await local()
    for (const name of ['invoice\u202Efdp.exe', 'a\u2066b', 'a\u0085b', 'a\u2028b', 'a\u200Fb']) {
      expect(
        (
          await h.raw(
            'PUT',
            `/databases/${db}/gridfs/fs/files?filename=${encodeURIComponent(name)}`,
            Buffer.from('x'),
          )
        ).statusCode,
      ).toBe(400)
      expect(
        (await h.call('PATCH', `/databases/${db}/gridfs/fs/files/${idOf(report)}`, { filename: name }))
          .statusCode,
      ).toBe(400)
    }
  })

  it('downloads a file stored elsewhere under a spoofing or endless name with a safe, bounded name', async () => {
    const { h, db, put } = await local()
    const spoof = await put('fs', `invoice\u202Efdp${'x'.repeat(5000)}.exe`, Buffer.from('x'))
    const res = await h.call('GET', `/databases/${db}/gridfs/fs/files/${idOf(spoof)}/download`)
    expect(res.statusCode).toBe(200)
    const header = String(res.headers['content-disposition'])
    expect(header.length).toBeLessThan(1500)
    expect(header).not.toMatch(/%E2%80%AE/i)
    expect(header).toMatch(/\.exe"; filename\*=UTF-8''.*\.exe$/)
  })

  it('refuses metadata keys that MongoDB reads as operators or paths', async () => {
    const { h, db, report } = await local()
    const version = await versionOf(h, db, 'Report Q1.pdf')
    for (const metadata of [{ $where: 'sleep(1)' }, { 'a.b': 1 }, { nested: { $gt: 1 } }])
      expect(
        (await h.call('PATCH', `/databases/${db}/gridfs/fs/files/${idOf(report)}`, { metadata, version }))
          .statusCode,
      ).toBe(400)
    // Extended JSON values are values, not keys.
    expect(
      (
        await h.call('PATCH', `/databases/${db}/gridfs/fs/files/${idOf(report)}`, {
          metadata: { at: { $date: '2026-10-09T00:00:00Z' } },
          version,
        })
      ).statusCode,
    ).toBe(200)
  })

  it('audits a change of metadata as an update, naming what changed', async () => {
    const { h, db, report } = await local()
    await h.call('PATCH', `/databases/${db}/gridfs/fs/files/${idOf(report)}`, {
      metadata: { a: 1 },
      version: await versionOf(h, db, 'Report Q1.pdf'),
    })
    expect(h.t.app.ctx.audit.list({ action: 'gridfs.update' })[0]).toMatchObject({
      details: expect.objectContaining({ metadata: true }),
    })
    expect(h.t.app.ctx.audit.list({ action: 'gridfs.update' })[0]!.details).not.toHaveProperty('to')
  })

  // Data review 2026-10-13 (M3): metadata is replaced whole, from what the dialog showed — so only
  // the version shown, and only metadata the app reads back as it is.
  it('changes metadata only from the version shown, and never one it would misread', async () => {
    const { h, db, put, client } = await local()
    const odd = await put('fs', 'odd.bin', Buffer.from('x'), { n: { $numberInt: '5' }, tag: 'a' })
    const listed = ((await h.call('GET', `/databases/${db}/gridfs/fs/files`)).json() as GridFsPage).files
    const oddView = listed.find((f) => f.filename === 'odd.bin')!
    expect(oddView.caution).toEqual({ kind: 'ejson_like', field: 'metadata.n' })
    expect(listed.find((f) => f.filename === 'photo.png')!.caution).toBeNull()
    const refused = await h.call('PATCH', `/databases/${db}/gridfs/fs/files/${idOf(odd)}`, {
      metadata: { n: 5, tag: 'b' },
      version: oddView.version,
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().details).toMatchObject({ reason: 'not_round_trip', field: 'metadata.n' })
    // Its name can still change: the metadata is not written.
    const renamed = await h.call('PATCH', `/databases/${db}/gridfs/fs/files/${idOf(odd)}`, {
      filename: 'odd2.bin',
    })
    expect(renamed.statusCode).toBe(200)
    const stored = await client.db(db).collection('fs.files').findOne({ _id: odd })
    expect(stored!.metadata).toEqual({ n: { $numberInt: '5' }, tag: 'a' })
    // Round 2 (M6): clearing it misreads nothing.
    const cleared = await h.call('PATCH', `/databases/${db}/gridfs/fs/files/${idOf(odd)}`, {
      metadata: null,
      version: oddView.version,
    })
    expect(cleared.statusCode).toBe(200)

    const version = await versionOf(h, db, 'Report Q1.pdf')
    const path = `/databases/${db}/gridfs/fs/files/${idOf((await seedId(client, db, 'Report Q1.pdf'))!)}`
    expect((await h.call('PATCH', path, { metadata: { a: 1 } })).statusCode).toBe(400)
    expect((await h.call('PATCH', path, { metadata: { a: 1 }, version })).statusCode).toBe(200)
    // Someone else's change came in between: the old version is refused, nothing overwritten.
    const stale = await h.call('PATCH', path, { metadata: { a: 2 }, version })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('DOCUMENT_CHANGED')
    expect(
      (await client.db(db).collection('fs.files').findOne({ filename: 'Report Q1.pdf' }))!.metadata,
    ).toEqual({
      a: 1,
    })
  })

  // Round 2 (I3): metadata is shown as stored — a double stays a double, a long a long — so a
  // save from the dialog writes back the same types.
  it('shows metadata with its stored number types', async () => {
    const { h, db, put } = await local()
    await put('fs', 'typed.bin', Buffer.from('x'), {
      d: new Double(1),
      l: Long.fromNumber(7),
      i: new Int32(2),
    })
    const file = ((await h.call('GET', `/databases/${db}/gridfs/fs/files`)).json() as GridFsPage).files.find(
      (f) => f.filename === 'typed.bin',
    )!
    expect(file.metadata).toEqual({
      d: { $numberDouble: '1.0' },
      l: { $numberLong: '7' },
      i: { $numberInt: '2' },
    })
    expect(file.length).toBe(1)
  })

  // Round 2 (M4, M14): the pin compares the metadata exactly, whatever the bucket's collation.
  it('replaces metadata only while it is exactly the version read', async () => {
    const { client, db } = await local()
    const d = client.db(db)
    await d.createCollection('ci.files', { collation: { locale: 'en', strength: 2 } })
    await d.collection('ci.files').insertOne({ _id: 1 as never, metadata: { a: 'report' } })
    const read = (await d.collection('ci.files').findOne({ _id: 1 as never }))!
    await d.collection('ci.files').updateOne({ _id: 1 as never }, { $set: { metadata: { a: 'Report' } } })
    expect(await setFileFields(d.collection('ci.files'), read, { metadata: { a: 'mine' } }, true)).toBe(false)
    expect((await d.collection('ci.files').findOne({ _id: 1 as never }))!.metadata).toEqual({ a: 'Report' })
    const now = (await d.collection('ci.files').findOne({ _id: 1 as never }))!
    expect(await setFileFields(d.collection('ci.files'), now, { metadata: { a: 'mine' } }, true)).toBe(true)
  })

  // Round 2 (M5): a file whose id is null is read by the chunks that name it — and chunks naming no
  // file would be read as its own, so it is not downloaded while there are any.
  it('refuses to download a file whose id is null while chunks name no file', async () => {
    const { h, db, client } = await local()
    const d = client.db(db)
    await d.command({
      insert: 'fs.files',
      documents: [{ _id: null, filename: 'null.bin', length: 1, chunkSize: 255, uploadDate: new Date() }],
    })
    await d.collection('fs.chunks').insertMany([
      { files_id: null, n: 0, data: Buffer.from('x') },
      { n: 7, data: Buffer.from('y') },
    ] as never)
    const res = await h.call(
      'GET',
      `/databases/${db}/gridfs/fs/files/${Buffer.from('null').toString('base64url')}/download`,
    )
    expect(res.statusCode).toBe(422)
    expect(res.json().details).toMatchObject({ reason: 'ambiguous' })
  })

  // Security review 2026-10-13 round 2 (I6): a list of files reads only what it shows, with a byte
  // cap; a page past it ends early and the next starts where it stopped.
  it('lists files with a byte cap, never their other fields', async () => {
    const h = await dataHarness(mongo, {}, { documents: { maxPageBytes: 3000 } })
    closers.push(h.t.close)
    const client = await h.client()
    const db = `gf${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('fs.files')
      .insertMany(
        Array.from({ length: 6 }, (_, i) => ({
          filename: `f${i}`,
          length: 1,
          chunkSize: 255,
          uploadDate: new Date(Date.UTC(2026, 0, i + 1)),
          metadata: { note: 'x'.repeat(1000) },
          planted: 'y'.repeat(100_000),
        })),
      )
    const page = (
      await h.call('GET', `/databases/${db}/gridfs/fs/files?limit=5&sort=filename&dir=asc`)
    ).json() as GridFsPage
    // About 1.1 KB each as shown (the planted 100 KB field is never read): two fit in 3000 bytes.
    expect(page.files.length).toBe(2)
    expect(page.next).toBe(page.files.length)
    const rest = (
      await h.call('GET', `/databases/${db}/gridfs/fs/files?limit=5&sort=filename&dir=asc&skip=${page.next}`)
    ).json() as GridFsPage
    expect(rest.files[0]!.filename).toBe(`f${page.files.length}`)
  })

  // Data review 2026-10-13 (M7): `files_id: {$eq: null}` matches the chunks with no files_id too.
  it('deletes the chunks of a file whose id is null, and no chunk that names no file', async () => {
    const { h, db, client } = await local()
    const d = client.db(db)
    await d.command({
      insert: 'fs.files',
      documents: [{ _id: null, filename: 'null.bin', length: 1, chunkSize: 255, uploadDate: new Date() }],
    })
    await d.collection('fs.chunks').insertMany([
      { files_id: null, n: 0, data: Buffer.from('x') },
      { n: 7, data: Buffer.from('stray') },
    ] as never)
    const id = Buffer.from('null').toString('base64url')
    expect((await h.call('DELETE', `/databases/${db}/gridfs/fs/files/${id}`)).statusCode).toBe(204)
    expect(await d.collection('fs.chunks').countDocuments({ files_id: null })).toBe(1)
    expect(await d.collection('fs.chunks').countDocuments({ n: 7 })).toBe(1)
    expect(await d.collection('fs.chunks').countDocuments({ files_id: { $type: 'null' } })).toBe(0)
  })

  it('ends the pages where a skip may go', async () => {
    const { h, db, client } = await local()
    await client
      .db(db)
      .collection('fs.files')
      .insertMany(
        Array.from({ length: 10_100 }, (_, i) => ({
          filename: `f${i}`,
          length: 0,
          chunkSize: 261120,
          uploadDate: new Date(i),
        })),
      )
    const page = (
      await h.call('GET', `/databases/${db}/gridfs/fs/files?skip=9980&limit=20`)
    ).json() as GridFsPage
    expect(page.next).toBe(10_000)
    const last = (
      await h.call('GET', `/databases/${db}/gridfs/fs/files?skip=10000&limit=50`)
    ).json() as GridFsPage
    expect(last.files).toHaveLength(50)
    expect(last.next).toBeNull()
  })
})

describe('GridFS and who may do what (phase 4b §1)', () => {
  async function team(connection: { readOnly?: boolean } = {}) {
    const h = await teamHarness(mongo, {}, connection)
    closers.push(h.t.close)
    const client = await h.client()
    return { h, client, ...(await seed(client)) }
  }

  it('lets a viewer list and download, never write', async () => {
    const { h, db, report } = await team()
    const viewer = h.user('viewer')
    expect((await viewer.call('GET', `/databases/${db}/gridfs/fs/files`)).statusCode).toBe(200)
    expect(
      (await viewer.call('GET', `/databases/${db}/gridfs/fs/files/${idOf(report)}/download`)).statusCode,
    ).toBe(200)
    expect(
      (await viewer.raw('PUT', `/databases/${db}/gridfs/fs/files?filename=x`, Buffer.from('x'))).statusCode,
    ).toBe(403)
    expect((await viewer.call('DELETE', `/databases/${db}/gridfs/fs/files/${idOf(report)}`)).statusCode).toBe(
      403,
    )
  })

  it('shows a restricted user the files masked, and refuses them downloads and writes', async () => {
    const { h, db, report } = await team()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'fs.files', field: 'metadata.owner' }])
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    const page = (await masked.call('GET', `/databases/${db}/gridfs/fs/files`)).json() as GridFsPage
    const q1 = page.files.find((f) => f.filename === 'Report Q1.pdf')!
    expect(JSON.stringify(q1.metadata)).not.toContain('ada@example.com')
    expect(
      (await masked.call('GET', `/databases/${db}/gridfs/fs/files/${idOf(report)}/download`)).statusCode,
    ).toBe(403)
    expect(
      (await masked.raw('PUT', `/databases/${db}/gridfs/fs/files?filename=x`, Buffer.from('x'))).statusCode,
    ).toBe(403)
    expect(
      (await masked.call('PATCH', `/databases/${db}/gridfs/fs/files/${idOf(report)}`, { filename: 'y' }))
        .statusCode,
    ).toBe(403)
    // Security review 2026-10-13 (M2): the file contents denied as a download are not read from its
    // chunks either — by a find, a pipeline reaching them, or an export.
    const chunks = `/databases/${db}/collections/fs.chunks`
    expect((await masked.call('POST', `${chunks}/find`, { filter: {}, limit: 5 })).statusCode).toBe(403)
    expect(
      (
        await masked.call('POST', `/databases/${db}/collections/plain/aggregate/run`, {
          stages: [{ $lookup: { from: 'fs.chunks', pipeline: [], as: 'c' } }],
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (await masked.call('POST', `${chunks}/export`, { source: { kind: 'collection' }, format: 'ndjson' }))
        .statusCode,
    ).toBe(403)
    // Nor written there by a pipeline: $out and $merge into a bucket's chunks (round 2, I3).
    for (const stage of [{ $out: 'fs.chunks' }, { $merge: { into: 'fs.chunks', whenMatched: 'replace' } }])
      expect(
        (
          await masked.call('POST', `/databases/${db}/collections/plain/aggregate/write-preview`, {
            stages: [stage],
          })
        ).statusCode,
      ).toBe(403)
  })

  // User report 2026-10-27: personal data rules on one database only; the files of a bucket no rule
  // applies to are not personal data (the rules say what is), so a restricted user downloads,
  // previews, reads and changes them as anyone may — and is refused wherever a rule reaches the bucket.
  it('lets a restricted user use a bucket no rule applies to, and refuses where one does', async () => {
    const { h, db, report } = await team()
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    const file = `/databases/${db}/gridfs/fs/files/${idOf(report)}`
    const chunks = `/databases/${db}/collections/fs.chunks`
    const lookup = {
      stages: [{ $lookup: { from: 'fs.chunks', pipeline: [{ $limit: 1 }], as: 'c' } }, { $limit: 1 }],
    }
    const statuses = async () => ({
      locked: ((await masked.call('GET', `/databases/${db}/gridfs/fs/files`)).json() as GridFsPage).locked,
      download: (await masked.call('GET', `${file}/download`)).statusCode,
      preview: (await masked.call('GET', `${file}/preview`)).statusCode,
      find: (await masked.call('POST', `${chunks}/find`, { filter: {}, limit: 1 })).statusCode,
      pipeline: (await masked.call('POST', `/databases/${db}/collections/plain/aggregate/run`, lookup))
        .statusCode,
      rename: (await masked.call('PATCH', file, { filename: 'Report Q1.pdf' })).statusCode,
    })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db: 'crm_elsewhere', coll: 'people', field: 'email' }])
    const free = async (label: string) => {
      const s = await statuses()
      // A PDF has no preview (415); never a refusal, never a failure.
      expect([200, 415], label).toContain(s.preview)
      expect({ ...s, preview: 0 }, label).toEqual({
        locked: false,
        download: 200,
        preview: 0,
        find: 200,
        pipeline: 200,
        rename: 200,
      })
    }
    await free('rules elsewhere')
    // Uploads and deletes too.
    const upload = await masked.raw(
      'PUT',
      `/databases/${db}/gridfs/fs/files?filename=free.txt`,
      Buffer.from('x'),
    )
    expect(upload.statusCode, upload.body).toBe(201)
    const uploaded = (upload.json() as { id: string }).id
    expect((await masked.call('DELETE', `/databases/${db}/gridfs/fs/files/${uploaded}`)).statusCode).toBe(204)
    // A rule on the bucket's files, its chunks, every collection of its database or of every database.
    for (const rule of [
      { db, coll: 'fs.files', field: 'metadata.owner' },
      { db, coll: 'fs.chunks', field: 'data' },
      { db, coll: '*', field: 'email' },
      { db: '*', coll: '*', field: 'email' },
    ]) {
      h.t.app.ctx.personalFields.set(h.connectionId, [rule])
      expect(await statuses(), JSON.stringify(rule)).toEqual({
        locked: true,
        download: 403,
        preview: 403,
        find: 403,
        pipeline: 403,
        rename: 403,
      })
    }
    // A rule on another bucket of the same database leaves this one free.
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'photos.files', field: 'metadata.owner' }])
    await free('rule on another bucket')
  })

  // Review of the rule scope (I1): a bucket made of views over a ruled bucket reads the ruled files —
  // judged by what it reads, as a view of a collection is.
  it('locks a bucket of views over a bucket a rule reaches, and masks its files as the source', async () => {
    const { h, db, client, report } = await team()
    await client.db(db).createCollection('share.files', { viewOn: 'fs.files', pipeline: [] })
    await client.db(db).createCollection('share.chunks', { viewOn: 'fs.chunks', pipeline: [] })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'fs.files', field: 'metadata.owner' }])
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    const list = await masked.call('GET', `/databases/${db}/gridfs/share/files`)
    expect(list.statusCode, list.body).toBe(200)
    const page = list.json() as GridFsPage
    expect(page.locked).toBe(true)
    expect(JSON.stringify(page.files)).not.toContain('ada@example.com')
    const file = `/databases/${db}/gridfs/share/files/${idOf(report)}`
    expect((await masked.call('GET', `${file}/download`)).statusCode).toBe(403)
    expect((await masked.call('GET', `${file}/preview`)).statusCode).toBe(403)
    // The refusal names the bucket and says what was refused.
    expect((await masked.call('GET', `${file}/download`)).json().message).toMatch(/GridFS file contents/)
  })

  // Review of the rule scope (M1): as $out and $merge, a rename or a duplicate by a restricted user
  // never writes into a bucket a rule reaches, nor into a collection with rules.
  it('refuses a restricted user a rename or duplicate into a ruled bucket or collection', async () => {
    const { h, db, client } = await team()
    await client.db(db).collection('plain2').insertOne({ b: 1 })
    h.t.app.ctx.personalFields.set(h.connectionId, [
      { db, coll: 'album.files', field: 'metadata.owner' },
      { db, coll: 'people', field: 'email' },
    ])
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    const rename = (from: string, to: string) =>
      masked.call('POST', `/databases/${db}/collections/${from}/rename`, { to })
    const duplicate = (from: string, to: string) =>
      masked.call('POST', `/databases/${db}/collections/${from}/duplicate`, { to })
    for (const to of ['album.chunks', 'album.files', 'people']) {
      expect((await rename('plain', to)).statusCode, to).toBe(403)
      expect((await duplicate('plain', to)).statusCode, to).toBe(403)
    }
    const names = (await client.db(db).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
    expect(names).toContain('plain')
    expect(names).not.toContain('album.chunks')
    expect(names).not.toContain('album.files')
    expect(names).not.toContain('people')
    // Elsewhere, as anyone may.
    expect((await rename('plain2', 'plain3')).statusCode).toBe(200)
  })

  // Review of the rule scope (M3): where personal data is hidden, as the server knows it — for the
  // badge of each tab (a collection's database counts: a $lookup reads it; a bucket by what it reads).
  it('says where the rules reach a restricted user, and nowhere for one who sees the values', async () => {
    const { h, db, client } = await team()
    await client.db(db).createCollection('share.files', { viewOn: 'fs.files', pipeline: [] })
    await client.db(db).createCollection('share.chunks', { viewOn: 'fs.chunks', pipeline: [] })
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'fs.files', field: 'metadata.owner' }])
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    const reaches = async (who: typeof masked, query: string) =>
      ((await who.call('GET', `/personal-fields/applied${query}`)).json() as { reaches: boolean }).reaches
    expect(await reaches(masked, '')).toBe(true)
    expect(await reaches(masked, `?db=${db}`)).toBe(true)
    expect(await reaches(masked, '?db=elsewhere')).toBe(false)
    expect(await reaches(masked, `?db=${db}&coll=plain`)).toBe(true)
    expect(await reaches(masked, '?db=elsewhere&coll=plain')).toBe(false)
    expect(await reaches(masked, `?db=${db}&bucket=fs`)).toBe(true)
    expect(await reaches(masked, `?db=${db}&bucket=share`)).toBe(true)
    expect(await reaches(masked, `?db=${db}&bucket=photos`)).toBe(false)
    const viewer = h.user('viewer')
    expect(await reaches(viewer, `?db=${db}&bucket=fs`)).toBe(false)
  })

  // Review of the rule scope (nit, ruling): the key vault's database is locked whole for a restricted
  // user — nothing there is checked for what a key's document holds — and said as hidden.
  it('locks every bucket of the key vault’s database, with no rule at all', async () => {
    const { h, db } = await team()
    const stop = registerKeyVaults({ keyVaultNamespaces: () => new Set([`${db}.__keyVault`]) })
    try {
      h.t.app.ctx.personalFields.set(h.connectionId, [])
      const masked = h.user('editor')
      h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
      h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
      const page = (await masked.call('GET', `/databases/${db}/gridfs/fs/files`)).json() as GridFsPage
      expect(page.locked).toBe(true)
      expect(
        ((await masked.call('GET', `/personal-fields/applied?db=${db}`)).json() as { reaches: boolean })
          .reaches,
      ).toBe(true)
    } finally {
      stop()
    }
  })

  it('hides every personal field of a file from a restricted user: its id, name, size, date and type', async () => {
    const { h, db, client } = await team()
    await new Promise((resolve, reject) => {
      const up = new GridFSBucket(client.db(db)).openUploadStreamWithId(
        'ada@example.com' as never,
        'ada-secret.pdf',
        {
          metadata: { contentType: 'text/secret', owner: 'ada' },
        },
      )
      up.on('finish', resolve).on('error', reject)
      up.end(Buffer.from('x'))
    })
    await client
      .db(db)
      .collection('fs.files')
      .updateOne({ _id: 'ada@example.com' as never }, { $set: { contentType: 'text/secret' } })
    h.t.app.ctx.personalFields.set(
      h.connectionId,
      ['_id', 'filename', 'uploadDate', 'length', 'contentType', 'metadata'].map((field) => ({
        db,
        coll: 'fs.files',
        field,
      })),
    )
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    // Sorting by a personal date is refused when asked for; the default order then needs none.
    expect((await masked.call('GET', `/databases/${db}/gridfs/fs/files?sort=uploadDate`)).statusCode).toBe(
      403,
    )
    const res = await masked.call('GET', `/databases/${db}/gridfs/fs/files`)
    expect(res.statusCode).toBe(200)
    const listed = res.json() as GridFsPage
    expect(listed.files).toHaveLength(4)
    const text = Buffer.from(JSON.stringify(listed)).toString()
    for (const secret of ['ada@example', 'ada-secret', 'text/secret', 'Report', 'application/pdf', '3000'])
      expect(text, secret).not.toContain(secret)
    // The ids too: every one decodes to nothing personal.
    expect(listed.files.every((f) => f.id === null)).toBe(true)
    expect(listed.files[0]).toMatchObject({
      filename: '***',
      length: null,
      uploadDate: null,
      contentType: null,
      metadata: null,
      masked: expect.arrayContaining(['_id', 'filename', 'uploadDate', 'length', 'contentType', 'metadata']),
    })
  })

  it('refuses a restricted user a search or a sort by a personal field (no guessing names)', async () => {
    const { h, db } = await team()
    h.t.app.ctx.personalFields.set(h.connectionId, [
      { db, coll: 'fs.files', field: 'filename' },
      { db, coll: 'fs.files', field: 'length' },
    ])
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    for (const query of ['q=rep', 'sort=filename', 'sort=length']) {
      const res = await masked.call('GET', `/databases/${db}/gridfs/fs/files?${query}`)
      expect(res.statusCode, query).toBe(403)
      expect(res.json().details.reason, query).toBe('personal_field')
    }
    expect((await masked.call('GET', `/databases/${db}/gridfs/fs/files?sort=uploadDate`)).statusCode).toBe(
      200,
    )
    // Everyone else searches as before.
    expect((await h.user('editor').call('GET', `/databases/${db}/gridfs/fs/files?q=rep`)).statusCode).toBe(
      200,
    )
  })

  it('shows masked metadata as hidden, never as characters', async () => {
    const { h, db } = await team()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'fs.files', field: 'metadata' }])
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    const page = (await masked.call('GET', `/databases/${db}/gridfs/fs/files`)).json() as GridFsPage
    const q1 = page.files.find((f) => f.filename === 'Report Q1.pdf')!
    expect(q1.metadata).toBeNull()
    expect(q1.masked).toContain('metadata')
    // Its type was in the metadata: hidden too.
    expect(q1.contentType).toBeNull()
    expect(typeof q1.id).toBe('string')
  })

  it('refuses a restricted user deletes where a rule reaches the bucket', async () => {
    const { h, db, report, client } = await team()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'fs.files', field: 'metadata.owner' }])
    const masked = h.user('editor')
    h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
    h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
    expect((await masked.call('DELETE', `/databases/${db}/gridfs/fs/files/${idOf(report)}`)).statusCode).toBe(
      403,
    )
    expect(await client.db(db).collection('fs.files').countDocuments({ _id: report })).toBe(1)
  })

  it('refuses writes on a read-only connection and in a system database', async () => {
    const ro = await team({ readOnly: true })
    const editor = ro.h.user('editor')
    const upload = await editor.raw('PUT', `/databases/${ro.db}/gridfs/fs/files?filename=x`, Buffer.from('x'))
    expect(upload.statusCode).toBe(403)
    const target = `/databases/${ro.db}/gridfs/fs/files/${idOf(ro.report)}`
    const patch = await editor.call('PATCH', target, { filename: 'y' })
    const del = await editor.call('DELETE', target)
    for (const res of [upload, patch, del]) {
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe(upload.json().code)
    }
    expect(await ro.client.db(ro.db).collection('fs.files').countDocuments({ _id: ro.report })).toBe(1)
    const rw = await team()
    const ed = rw.h.user('editor')
    expect(
      (await ed.raw('PUT', '/databases/admin/gridfs/fs/files?filename=x', Buffer.from('x'))).statusCode,
    ).toBe(403)
    const sys = `/databases/admin/gridfs/fs/files/${idOf(new ObjectId())}`
    expect((await ed.call('PATCH', sys, { filename: 'y' })).statusCode).toBe(403)
    expect((await ed.call('DELETE', sys)).statusCode).toBe(403)
  })
})
