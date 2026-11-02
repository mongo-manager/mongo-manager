import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Db, MongoClient } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { fixture } from './support/mongo-tools'
import { slow } from './support/slowness'

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
  for (const d of ['shop', 'shop2', 'shop3']) await cb.db(d).dropDatabase()
  await ca.db('shop').dropDatabase()
})

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
async function upload(u: U, name: string) {
  const file = fixture(name)
  const id = (await u.call('POST', '/api/backups/uploads', { name, size: file.length })).json().uploadId
  await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
  return id as string
}
const all = ['orders', 'empty', 'capped', 'ts', 'v']
const mapping = (to: string, colls = all) =>
  colls.map((c) => ({ from: { db: 'shop', coll: c }, to: { db: to, coll: c } }))
const plan = (h: H, u: U, body: object) => u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, body)

describe('restore plan (spec §3.2, §5.2, U5, U6, U7)', () => {
  it('plans a restore into a new database: actions, TTL confirmation and impact', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, 'shop.archive')
      const res = await plan(h, u, { source: { kind: 'upload', uploadId: id }, mapping: mapping('shop2') })
      expect(res.statusCode, res.body).toBe(200)
      const p = res.json()
      expect(
        p.namespaces.every((n: { action: string; exists: boolean }) => n.action === 'create' && !n.exists),
      ).toBe(true)
      expect(p.namespaces.find((n: { to: { coll: string } }) => n.to.coll === 'orders').ttl).toEqual([
        'at_ttl',
      ])
      expect(p.summary).toMatchObject({ container: 'archive', serverVersion: expect.any(String) })
      expect(p.refusals).toEqual(['confirm_ttl'])
      const ok = await plan(h, u, {
        source: { kind: 'upload', uploadId: id },
        mapping: mapping('shop2'),
        confirmTtl: true,
      })
      expect(ok.json().refusals).toEqual([])
      expect(ok.json().planHash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await h.t.close()
    }
  })

  it('asks for the typed name to replace a non-empty target, and refuses replacing a time series', async () => {
    const h = await backupHarness(a, b)
    try {
      await cb.db('shop').collection('orders').insertOne({ x: 1 })
      await cb.db('shop').createCollection('ts', { timeseries: { timeField: 't', metaField: 'm' } })
      const u = h.user({ role: 'admin' })
      const id = await upload(u, 'shop.archive')
      const base = {
        source: { kind: 'upload', uploadId: id },
        mode: 'replace',
        confirmTtl: true,
        mapping: mapping('shop', ['orders']),
      }
      const p = (await plan(h, u, base)).json()
      expect(p.namespaces[0]).toMatchObject({
        exists: true,
        documents: 1,
        action: 'replace',
        confirmName: true,
      })
      expect(p.refusals).toEqual(['confirm_name'])
      expect((await plan(h, u, { ...base, confirmNames: ['shop.orders'] })).json().refusals).toEqual([])
      const ts = (await plan(h, u, { ...base, mapping: mapping('shop', ['ts']) })).json()
      expect(ts.refusals).toContain('timeseries_replace')
    } finally {
      await h.t.close()
    }
  })

  it('writes time series buckets only where a matching time series is or will be (final review I5)', async () => {
    const h = await backupHarness(a, b)
    try {
      await cb.db('shop').collection('ts').insertOne({ plain: true })
      await cb.db('shop2').createCollection('ts', { timeseries: { timeField: 'when' } })
      const u = h.user({ role: 'admin' })
      const id = await upload(u, 'shop.archive')
      const go = (to: string) =>
        plan(h, u, { source: { kind: 'upload', uploadId: id }, mapping: mapping(to, ['ts']) })
      expect((await go('shop')).json().namespaces[0].skipped).toMatch(/time series/)
      expect((await go('shop2')).json().namespaces[0].skipped).toMatch(/time series/)
      expect((await go('shop3')).json().namespaces[0].skipped).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })

  it('lists each target database once, however many namespaces go there (final review minor 17)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, 'shop.archive')
      const spy = vi.spyOn(Db.prototype, 'listCollections')
      const res = await plan(h, u, {
        source: { kind: 'upload', uploadId: id },
        mapping: mapping('shop2'),
        confirmTtl: true,
      })
      expect(res.statusCode, res.body).toBe(200)
      const onTarget = spy.mock.contexts.filter((db) => (db as Db).databaseName === 'shop2').length
      spy.mockRestore()
      expect(onTarget).toBe(1)
    } finally {
      await h.t.close()
    }
  })

  it('refuses unknown or doubled mappings, and plans nothing for a foreign upload (B9)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, 'shop.archive')
      const go = (body: object) => plan(h, u, { source: { kind: 'upload', uploadId: id }, ...body })
      expect(
        (await go({ mapping: [{ from: { db: 'shop', coll: 'nope' }, to: { db: 'x', coll: 'y' } }] })).json()
          .details.reason,
      ).toBe('unknown_namespace')
      expect(
        (
          await go({
            mapping: [
              { from: { db: 'shop', coll: 'orders' }, to: { db: 'x', coll: 'y' } },
              { from: { db: 'shop', coll: 'empty' }, to: { db: 'x', coll: 'y' } },
            ],
          })
        ).json().details.reason,
      ).toBe('duplicate_target')
      const other = h.user({ role: 'admin' })
      expect(
        (await plan(h, other, { source: { kind: 'upload', uploadId: id }, mapping: mapping('x') }))
          .statusCode,
      ).toBe(404)
    } finally {
      await h.t.close()
    }
  })

  it('needs confirmMasked to write a masked backup over existing data (B11)', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      await ca
        .db('shop')
        .collection('orders')
        .insertMany([{ _id: 1, email: 'real@x' }] as never)
      await cb
        .db('shop')
        .collection('orders')
        .insertMany([{ _id: 1, email: 'real@x' }] as never)
      const u = h.user({ role: 'editor', masked: ['A'] })
      const body = { scope: { kind: 'collection', db: 'shop', coll: 'orders' }, format: 'gzip' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const start = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: dp.planHash,
      })
      const job = await waitJob(h.t, start.json().job.id, 60_000)
      const backupId = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId
      const p = (
        await plan(h, u, {
          source: { kind: 'backup', backupId },
          mode: 'upsert',
          mapping: [{ from: { db: 'shop', coll: 'orders' }, to: { db: 'shop', coll: 'orders' } }],
        })
      ).json()
      expect(p.refusals).toContain('confirm_masked')
      expect(p.summary.mongoManager).toMatchObject({ masked: true })
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('skips a time series for a caller restricted on its target: buckets cannot pass the gate', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('B', [{ db: 'shop2', coll: 'ts', field: 'm' }])
      const u = h.user({ role: 'editor', masked: ['B'] })
      const id = await upload(u, 'shop.archive')
      const p = (
        await plan(h, u, {
          source: { kind: 'upload', uploadId: id },
          mapping: mapping('shop2', ['ts', 'empty']),
        })
      ).json()
      expect(p.namespaces.find((n: { to: { coll: string } }) => n.to.coll === 'ts').skipped).toMatch(
        /personal/,
      )
      expect(
        p.namespaces.find((n: { to: { coll: string } }) => n.to.coll === 'empty').skipped,
      ).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })

  it('warns when restoring over the deployment the backup was taken from (final review I9, U5)', async () => {
    const h = await backupHarness(a, b)
    try {
      await ca.db('shop').collection('orders').insertOne({ x: 1 })
      const u = h.user({ role: 'admin' })
      const body = { scope: { kind: 'collection', db: 'shop', coll: 'orders' }, format: 'gzip' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const job = await waitJob(
        h.t,
        (
          await u.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        60_000,
      )
      const backupId = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId
      const restore = { source: { kind: 'backup', backupId }, mapping: mapping('shop', ['orders']) }
      const onSource = (await u.call('POST', `/api/connections/${h.ids.A}/restore/plan`, restore)).json()
      expect(onSource.checks).toContainEqual(expect.objectContaining({ key: 'source', level: 'warn' }))
      const elsewhere = (await plan(h, u, restore)).json()
      expect(elsewhere.checks.some((c: { key: string }) => c.key === 'source')).toBe(false)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // W4 × W8 (merge review), abuse case: a backup holding a key vault (from elsewhere, or made before
  // a connection named it) restored into an ordinary collection — data keys an editor could read.
  it('never restores a key vault some connection names, whatever it is restored into', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, 'shop.archive')
      h.ctx.connections.create(
        {
          name: 'vaulted',
          favorite: false,
          readOnly: false,
          settings: ConnectionSettingsSchema.parse({
            hosts: [{ host: '127.0.0.1', port: a.port }],
            encryption: {
              enabled: true,
              keyVaultNamespace: 'shop.orders',
              kms: { local: { key: 'A'.repeat(128) } },
              library: 'mongocryptd',
            },
          }),
        },
        null,
      )
      const res = await plan(h, u, {
        source: { kind: 'upload', uploadId: id },
        mapping: mapping('plain', ['orders', 'empty']),
      })
      expect(res.statusCode, res.body).toBe(200)
      const ns = res.json().namespaces as Array<{ to: { coll: string }; skipped?: string }>
      expect(ns.find((n) => n.to.coll === 'orders')?.skipped).toMatch(/Encryption keys/)
      expect(ns.find((n) => n.to.coll === 'empty')?.skipped).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })

  it('lists the source rules an unmasked backup carries that the target lacks', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      await ca.db('shop').collection('orders').insertOne({ email: 'a@x' })
      const u = h.user({ role: 'editor' })
      const body = { scope: { kind: 'collection', db: 'shop', coll: 'orders' }, format: 'gzip' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const start = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: dp.planHash,
      })
      const job = await waitJob(h.t, start.json().job.id, 60_000)
      const backupId = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId
      const restore = {
        source: { kind: 'backup', backupId },
        mapping: [{ from: { db: 'shop', coll: 'orders' }, to: { db: 'shop2', coll: 'orders' } }],
      }
      const p = (await plan(h, u, restore)).json()
      expect(p.missingRules).toEqual(['shop2.orders.email'])
      expect(p.refusals).toContain('confirm_personal')
      expect(p.mayAddRules).toBe(false)
      expect((await plan(h, u, { ...restore, confirmPersonal: true })).json().refusals).toEqual([])
      expect((await plan(h, u, { ...restore, addRulesToTarget: true })).json().refusals).toContain(
        'add_rules_forbidden',
      )
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
