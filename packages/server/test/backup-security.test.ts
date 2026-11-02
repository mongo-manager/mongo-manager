import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { BSON, Binary } from 'bson'
import { createGzip, gunzipSync } from 'node:zlib'
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { fixture, mongoTools } from './support/mongo-tools'
import { ArchiveWriter } from '../src/backup/archive-writer'
import { ZipWriter } from '../src/transfer/formats/zip'
import { slow } from './support/slowness'

/**
 * Phase 3d-3a spec §8: the abuse cases, through the HTTP routes as a user would reach them.
 * B11 (confirm_masked) is pinned in backup-restore-plan, B14 (secrets only in the config file) in
 * backup-dump-tools, B16 (the process tree is killed) in backup-tools, B18 (a failure leaves no
 * backup) in backup-dump-job, and B20 (mongorestore reads our archives) in backup-interop and
 * backup-dump-job.
 */
const tools = await mongoTools()
const S = 'S3NT1N3L'
const PW = 'correct horse battery staple'
let a: TestMongo
let b: TestMongo
let ca: MongoClient
let cb: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
}, slow(180_000))
afterAll(async () => {
  await Promise.all([ca?.close(), cb?.close()])
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  for (const c of [ca, cb]) for (const d of ['shop', 'shop2']) await c.db(d).dropDatabase()
  await ca
    .db('shop')
    .collection('orders')
    .insertMany(Array.from({ length: 20 }, (_, i) => ({ _id: i as never, email: `${S}-${i}@x`, n: i })))
})

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
async function upload(u: U, file: Buffer) {
  const id = (await u.call('POST', '/api/backups/uploads', { name: 'f', size: file.length })).json().uploadId
  await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
  return id as string
}
async function archiveOf(metas: object[], docs: Array<[string, string, object]>) {
  const pass = new PassThrough()
  const parts: Buffer[] = []
  pass.on('data', (c: Buffer) => parts.push(c))
  const w = new ArchiveWriter(pass)
  await w.begin({ serverVersion: '8.0.0', toolVersion: 't', mongoManager: null }, metas as never)
  const by = new Map<string, object[]>()
  for (const [db, coll, d] of docs) by.set(`${db}.${coll}`, [...(by.get(`${db}.${coll}`) ?? []), d])
  for (const [ns, list] of by) {
    await w.open(ns.slice(0, ns.indexOf('.')), ns.slice(ns.indexOf('.') + 1))
    for (const d of list) await w.write(Buffer.from(BSON.serialize(d)))
    await w.close()
  }
  await w.finish()
  pass.end()
  return Buffer.concat(parts)
}
const plan = (h: H, u: U, body: object) => u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, body)
const inspect = (u: U, id: string, password?: string) =>
  u.call('POST', '/api/backups/inspect', {
    source: { kind: 'upload', uploadId: id },
    ...(password ? { password } : {}),
  })
async function restore(h: H, u: U, body: object) {
  const p = await plan(h, u, body)
  expect(p.statusCode, p.body).toBe(200)
  const start = await u.call('POST', `/api/connections/${h.ids.B}/restore`, {
    ...body,
    planHash: p.json().planHash,
  })
  expect(start.statusCode, start.body).toBe(202)
  const job = await waitJob(h.t, start.json().job.id, 120_000)
  return { job, report: (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() }
}
async function dump(h: H, u: U, body: Record<string, unknown>, password?: string) {
  const dp = await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)
  expect(dp.statusCode, dp.body).toBe(200)
  const start = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
    ...body,
    planHash: dp.json().planHash,
    ...(password ? { password } : {}),
  })
  expect(start.statusCode, start.body).toBe(202)
  const job = await waitJob(h.t, start.json().job.id, 60_000)
  expect(job.state).toBe('done')
  const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
  return { backupId: report.backupId as string, report }
}
const ordersTo = (db: string) => [{ from: { db: 'shop', coll: 'orders' }, to: { db, coll: 'orders' } }]

describe('backup abuse cases (spec §8)', () => {
  it('B1: a decompression bomb inside the archive fails the restore and leaves the target as it was', async () => {
    const h = await backupHarness(a, b)
    try {
      await cb.db('shop').collection('orders').insertOne({ keep: true })
      const u = h.user({ role: 'admin' })
      // 300 documents of 1 MiB zeros: a valid archive whose gzip is about a thousand times smaller.
      const gz = createGzip()
      const parts: Buffer[] = []
      gz.on('data', (c: Buffer) => parts.push(c))
      const ended = new Promise((resolve) => gz.on('end', resolve))
      const w = new ArchiveWriter(gz)
      await w.begin({ serverVersion: '8.0.0', toolVersion: 't', mongoManager: null }, [
        {
          db: 'shop',
          coll: 'orders',
          type: 'collection',
          options: {},
          indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }],
        },
      ] as never)
      await w.open('shop', 'orders')
      const zeros = new Binary(Buffer.alloc(1024 * 1024))
      for (let i = 0; i < 300; i++) await w.write(Buffer.from(BSON.serialize({ _id: i, z: zeros })))
      await w.close()
      await w.finish()
      gz.end()
      await ended
      const bomb = Buffer.concat(parts)
      expect(bomb.length).toBeLessThan(2 * 1024 * 1024)
      const id = await upload(u, bomb)
      const { job } = await restore(h, u, {
        source: { kind: 'upload', uploadId: id },
        mode: 'replace',
        confirmNames: ['shop.orders'],
        mapping: ordersTo('shop'),
      })
      expect(job.state).toBe('failed')
      expect(
        await cb
          .db('shop')
          .collection('orders')
          .find({}, { projection: { _id: 0 } })
          .toArray(),
      ).toEqual([{ keep: true }])
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('B2: a forged or cut archive is refused with a clear error, and its restore fails', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const good = fixture('shop.archive')
      const cut = await upload(u, good.subarray(0, good.length - 7))
      expect((await inspect(u, cut)).statusCode).toBe(200)
      const { job } = await restore(h, u, {
        source: { kind: 'upload', uploadId: cut },
        confirmTtl: true,
        mapping: ordersTo('shop2'),
      })
      expect(job.state).toBe('failed')
      const huge = await upload(
        u,
        Buffer.concat([good.subarray(0, 4), Buffer.from([0xff, 0xff, 0xff, 0x7f])]),
      )
      expect((await inspect(u, huge)).statusCode).toBe(400)
      const r = await inspect(u, await upload(u, Buffer.from('not a backup at all')))
      expect(r.json().details.reason).toBe('not_backup')
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('B3: system targets are refused', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, fixture('shop.archive'))
      for (const to of [
        { db: 'admin', coll: 'system.users' },
        { db: 'admin', coll: 'x' },
        { db: 'local', coll: 'x' },
        { db: 'config', coll: 'x' },
        { db: 'shop', coll: 'system.views' },
        { db: 'shop', coll: 'system.js' },
        { db: 'sh$op', coll: 'x' },
        { db: 'shop', coll: 'a$b' },
        { db: '../x', coll: 'x' },
      ])
        expect(
          (
            await plan(h, u, {
              source: { kind: 'upload', uploadId: id },
              mapping: [{ from: { db: 'shop', coll: 'orders' }, to }],
            })
          ).statusCode,
          JSON.stringify(to),
        ).toBe(400)
    } finally {
      await h.t.close()
    }
  })

  it('B4: JavaScript in a view or validator is not restored while server JS is off', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const file = await archiveOf(
        [
          { db: 'shop', coll: 'base', type: 'collection', options: {}, indexes: [] },
          {
            db: 'shop',
            coll: 'jsview',
            type: 'view',
            options: {
              viewOn: 'base',
              pipeline: [
                {
                  $match: {
                    $expr: { $function: { body: 'function() { return true }', args: [], lang: 'js' } },
                  },
                },
              ],
            },
            indexes: [],
          },
          {
            db: 'shop',
            coll: 'jsval',
            type: 'collection',
            options: { validator: { $where: 'true' } },
            indexes: [],
          },
          // Security review 2026-10-16 (I-1): MongoDB's internal JavaScript operators too.
          {
            db: 'shop',
            coll: 'jsinternal',
            type: 'view',
            options: {
              viewOn: 'base',
              pipeline: [
                { $project: { e: { $_internalJsEmit: { eval: 'function () {}', this: '$$ROOT' } } } },
              ],
            },
            indexes: [],
          },
          {
            db: 'shop',
            coll: 'writes',
            type: 'view',
            options: { viewOn: 'base', pipeline: [{ $merge: { into: 'base' } }] },
            indexes: [],
          },
        ],
        [['shop', 'base', { a: 1 }]],
      )
      const id = await upload(u, file)
      const p = (
        await plan(h, u, {
          source: { kind: 'upload', uploadId: id },
          mapping: ['base', 'jsview', 'jsval', 'jsinternal', 'writes'].map((c) => ({
            from: { db: 'shop', coll: c },
            to: { db: 'shop2', coll: c },
          })),
        })
      ).json()
      const by = (c: string) => p.namespaces.find((n: { to: { coll: string } }) => n.to.coll === c)
      expect(by('jsview').skipped).toMatch(/JavaScript/)
      expect(by('jsval').skipped).toMatch(/JavaScript/)
      expect(by('jsinternal').skipped).toMatch(/JavaScript/)
      expect(by('writes').skipped).toMatch(/writes/)
      expect(by('base').skipped).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })

  it('B5: a zip with a path trick is refused', async () => {
    const h = await backupHarness(a, b)
    const dir = mkdtempSync(join(tmpdir(), 'mm-b5-'))
    try {
      const u = h.user({ role: 'admin' })
      const path = join(dir, 'x.zip')
      const out = createWriteStream(path)
      const zip = new ZipWriter(out)
      // An otherwise valid dump folder, with one entry that climbs out of it.
      await zip.add(
        'dump/shop/orders.metadata.json',
        JSON.stringify({ options: {}, indexes: [], type: 'collection' }),
      )
      await zip.add('dump/shop/orders.bson', Buffer.from(BSON.serialize({ a: 1 })))
      await zip.add('dump/shop/../../x.bson', Buffer.from(BSON.serialize({ a: 1 })))
      await zip.finish()
      await new Promise((resolve) => out.end(resolve))
      const r = await inspect(u, await upload(u, readFileSync(path)))
      expect(r.statusCode, r.body).toBe(400)
      expect(r.json().message).toMatch(/unsafe path/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await h.t.close()
    }
  })

  it('B6, B13: a tampered .mmbak and a wrong password are refused; no password is stored', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const { backupId } = await dump(
        h,
        u,
        { scope: { kind: 'collection', db: 'shop', coll: 'orders' }, format: 'mmbak' },
        PW,
      )
      const file = Buffer.from((await u.get(`/api/backups/${backupId}/download`)).rawPayload)
      file[file.length - 20] = file[file.length - 20]! ^ 1
      const id = await upload(u, file)
      const body = { source: { kind: 'upload', uploadId: id }, password: PW, mapping: ordersTo('shop2') }
      const p = await plan(h, u, body)
      // The prelude may sit in an intact chunk: then the restore must fail on the damaged one.
      if (p.statusCode === 200) {
        const r = await u.call('POST', `/api/connections/${h.ids.B}/restore`, {
          ...body,
          planHash: p.json().planHash,
        })
        expect((await waitJob(h.t, r.json().job.id, 60_000)).state).toBe('failed')
        expect(await cb.db('shop2').collection('orders').countDocuments()).toBe(0)
      } else expect(p.json().details.reason).toBe('mmbak')
      expect((await inspect(u, id, 'definitely wrong')).json().details.reason).toBe('backup_password')
      // Security review round 2 (Minor 10): a refused password gives the read slot back.
      expect((await inspect(u, id, 'wrong again')).json().details.reason).toBe('backup_password')
      const leave = h.ctx.backup.reads.enter(u.id)
      leave()
      const stored = JSON.stringify([
        h.ctx.store.db.prepare('SELECT * FROM jobs').all(),
        h.ctx.store.db.prepare('SELECT * FROM audit_log').all(),
        h.ctx.store.db.prepare('SELECT * FROM transfer_reports').all(),
        h.ctx.store.db.prepare('SELECT * FROM backups').all(),
      ])
      expect(stored).not.toContain(PW)
      expect(stored).not.toContain('definitely wrong')
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('B7: no personal value leaves in a restricted backup — data, views or index filters', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const shop = ca.db('shop')
      await shop.createCollection('v', { viewOn: 'orders', pipeline: [{ $project: { e: '$email' } }] })
      await shop.collection('orders').createIndex({ email: 1 }, { name: 'email_1' })
      await shop
        .collection('orders')
        .createIndex({ n: 1 }, { name: 'n_partial', partialFilterExpression: { email: `${S}-1@x` } })
      const u = h.user({ masked: ['A'] })
      for (const format of ['archive', 'gzip'] as const) {
        const body = { scope: { kind: 'database', db: 'shop' }, format }
        const { backupId, report } = await dump(h, u, body)
        const raw = Buffer.from((await u.get(`/api/backups/${backupId}/download`)).rawPayload)
        const bytes = format === 'gzip' ? gunzipSync(raw) : raw
        expect(bytes.includes(Buffer.from(S)), format).toBe(false)
        // The documents are in it, masked: the data path itself was taken.
        expect(report.masked).toBe(true)
        const orders = report.namespaces.find((n: { coll: string }) => n.coll === 'orders')
        expect(orders.skipped).toBeUndefined()
        expect(orders.written).toBe(20)
      }
      // The same dump by an unrestricted user holds the values, which proves the seed.
      const admin = h.user({ role: 'admin' })
      const { backupId: id } = await dump(h, admin, {
        scope: { kind: 'database', db: 'shop' },
        format: 'archive',
      })
      expect(
        Buffer.from((await admin.get(`/api/backups/${id}/download`)).rawPayload).includes(Buffer.from(S)),
      ).toBe(true)
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('B7: a collection whose validator holds a personal value keeps its masked data, not the validator', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      await ca.db('shop').command({
        collMod: 'orders',
        validator: { $jsonSchema: { properties: { email: { bsonType: 'string', pattern: S } } } },
        validationLevel: 'off',
      })
      const u = h.user({ masked: ['A'] })
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'archive' }
      const plan = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const orders = plan.namespaces.find((n: { coll: string }) => n.coll === 'orders')
      expect(orders.skipped).toBeUndefined()
      expect(orders.note).toMatch(/validator/)
      const { backupId, report } = await dump(h, u, body)
      expect(report.namespaces.find((n: { coll: string }) => n.coll === 'orders').written).toBe(20)
      const raw = Buffer.from((await u.get(`/api/backups/${backupId}/download`)).rawPayload)
      expect(raw.includes(Buffer.from(S))).toBe(false)
      expect(raw.includes(Buffer.from('$jsonSchema'))).toBe(false)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // With the tools found, so the refusal is the role's and not a missing binary.
  it.skipIf(!tools)('B8: only an admin of the connection can use the tools engine', async () => {
    const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
    try {
      const admin = h.user({ role: 'admin' })
      const ok = { scope: { kind: 'server' }, engine: 'tools', format: 'gzip' }
      expect(
        (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, ok)).json().tools.available,
      ).toBe(true)
      for (const u of [h.user({ role: 'editor' }), h.user({ role: 'editor', masked: ['A'] })]) {
        const body = { scope: { kind: 'server' }, engine: 'tools', format: 'gzip' }
        const p = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
        expect(p.refusals).toContain('tools_unavailable')
        expect(p.tools.reason).toBe('not_admin')
        expect(
          (await u.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: p.planHash }))
            .statusCode,
        ).toBe(409)
      }
    } finally {
      await h.t.close()
    }
  })

  it('B9: ids of other users are not found anywhere', async () => {
    const h = await backupHarness(a, b)
    try {
      const owner = h.user({ role: 'admin' })
      const thief = h.user({ role: 'admin' })
      const id = await upload(owner, fixture('shop.archive'))
      const { backupId } = await dump(h, owner, {
        scope: { kind: 'collection', db: 'shop', coll: 'orders' },
        format: 'gzip',
      })
      expect((await inspect(thief, id)).statusCode).toBe(404)
      expect(
        (await plan(h, thief, { source: { kind: 'upload', uploadId: id }, mapping: ordersTo('shop2') }))
          .statusCode,
      ).toBe(404)
      expect(
        (await plan(h, thief, { source: { kind: 'backup', backupId }, mapping: ordersTo('shop2') }))
          .statusCode,
      ).toBe(404)
      expect((await thief.get(`/api/backups/uploads/${id}`)).statusCode).toBe(404)
      expect(
        (await thief.raw('PUT', `/api/backups/uploads/${id}?offset=0`, Buffer.from('x'))).statusCode,
      ).toBe(404)
      expect((await thief.call('DELETE', `/api/backups/uploads/${id}`)).statusCode).toBe(404)
      expect((await thief.get(`/api/backups/${backupId}/download`)).statusCode).toBe(404)
      expect((await thief.call('DELETE', `/api/backups/${backupId}`)).statusCode).toBe(404)
      expect((await owner.get(`/api/backups/uploads/${id}`)).statusCode).toBe(200)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('B10: a user restricted on the target cannot build an index over hidden values, nor write them', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('B', [{ db: 'shop2', coll: '*', field: 'email' }])
      await cb
        .db('shop2')
        .collection('orders')
        .insertOne({ email: `${S}@hidden` })
      const u = h.user({ role: 'editor', masked: ['B'] })
      const file = await archiveOf(
        [
          {
            db: 'shop',
            coll: 'orders',
            type: 'collection',
            options: {},
            indexes: [
              { v: 2, key: { _id: 1 }, name: '_id_' },
              { v: 2, key: { email: 1 }, name: 'email_u', unique: true },
            ],
          },
        ],
        [
          ['shop', 'orders', { _id: 'a', email: 'planted@x' }],
          ['shop', 'orders', { _id: 'b', n: 1 }],
        ],
      )
      const id = await upload(u, file)
      const { job, report } = await restore(h, u, {
        source: { kind: 'upload', uploadId: id },
        mapping: ordersTo('shop2'),
      })
      expect(job.state).toBe('done')
      expect(report.namespaces[0].indexes.built).toEqual([])
      expect((await cb.db('shop2').collection('orders').indexes()).map((i) => i.name)).not.toContain(
        'email_u',
      )
      // A personal value is not written by a caller who cannot see it (phase 3c §5.1).
      expect(report.namespaces[0]).toMatchObject({ inserted: 1, failed: 1 })
      expect(await cb.db('shop2').collection('orders').countDocuments({ email: 'planted@x' })).toBe(0)
      expect(JSON.stringify(report)).not.toContain(S)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('B12: a masked backup is withdrawn when the rules change', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const u = h.user({ masked: ['A'] })
      const { backupId } = await dump(h, u, {
        scope: { kind: 'collection', db: 'shop', coll: 'orders' },
        format: 'gzip',
      })
      h.rules('A', [
        { db: 'shop', coll: 'orders', field: 'email' },
        { db: 'shop', coll: 'orders', field: 'n' },
      ])
      expect((await u.get(`/api/backups/${backupId}/download`)).statusCode).toBe(410)
      expect(
        (await plan(h, u, { source: { kind: 'backup', backupId }, mapping: ordersTo('shop2') })).statusCode,
      ).toBe(410)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('B15, B19: plan hashes compare in constant time', () => {
    const src = readFileSync(join(__dirname, '../src/routes/backup.ts'), 'utf8')
    expect(src.match(/safeEqual\(prepared\.plan\.planHash, echoed\)/g)).toHaveLength(2)
    expect(src).not.toMatch(/planHash\s*[!=]==/)
  })

  it('B17: an upload past the quota or past its declared size is refused', async () => {
    const h = await backupHarness(a, b, { backup: { quotaMb: 16 } } as never)
    try {
      const u = h.user({ role: 'admin' })
      expect(
        (await u.call('POST', '/api/backups/uploads', { name: 'big', size: 17 * 1024 * 1024 })).json().details
          .reason,
      ).toBe('backup_quota')
      const id = (await u.call('POST', '/api/backups/uploads', { name: 'small', size: 10 })).json().uploadId
      const over = await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, Buffer.alloc(11))
      expect(over.statusCode).toBeGreaterThanOrEqual(400)
      expect((await u.get(`/api/backups/uploads/${id}`)).json().received).toBe(0)
      expect((await u.raw('PUT', `/api/backups/uploads/${id}?offset=5`, Buffer.alloc(1))).statusCode).toBe(
        409,
      )
    } finally {
      await h.t.close()
    }
  })
})
