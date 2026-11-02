import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FindCursor, MongoClient } from 'mongodb'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { readMmbakHeader } from '../src/backup/mmbak'
import { JobRunner } from '../src/jobs/runner'
import type { JobRecord } from '../src/jobs/types'
import { openArchive } from '../src/backup/pipeline'
import type { ArchiveEvent } from '../src/backup/archive-reader'
import { mongoTools } from './support/mongo-tools'
import { slow } from './support/slowness'

const S = 'S3NT1N3L'
const PW = 'correct horse battery staple'
const tools = await mongoTools()
let a: TestMongo
let b: TestMongo
let ca: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  await ca.db('shop').dropDatabase()
  const shop = ca.db('shop')
  await shop
    .collection('orders')
    .insertMany(Array.from({ length: 300 }, (_, i) => ({ _id: i as never, email: `${S}-${i}@x`, n: i })))
  await shop.collection('orders').createIndex({ n: 1 }, { name: 'n_1' })
  await shop.createCollection('v', { viewOn: 'orders', pipeline: [{ $project: { email: 1 } }] })
  await shop.createCollection('ts', { timeseries: { timeField: 't' } })
  await shop.collection('ts').insertMany([
    { t: new Date(0), x: 1 },
    { t: new Date(1), x: 2 },
  ])
})
afterEach(() => vi.restoreAllMocks())

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
async function dump(h: H, u: U, body: Record<string, unknown>) {
  const base = `/api/connections/${h.ids.A}/backup`
  const { password: _pw, ...planBody } = body
  const plan = await u.call('POST', `${base}/plan`, planBody)
  expect(plan.statusCode, plan.body).toBe(200)
  const res = await u.call('POST', base, { ...body, planHash: plan.json().planHash })
  if (res.statusCode !== 202) return { res }
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
  return { res, job, report }
}
async function events(h: H, owner: string, id: string, password?: string): Promise<ArchiveEvent[]> {
  const row = h.ctx.backup.store.get(owner, id)!
  const { events } = await openArchive(h.ctx.backup.store, row, {
    ...(password ? { password } : {}),
    signal: new AbortController().signal,
    follow: 'complete',
  })
  const out: ArchiveEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('dump job (spec §5.1, §7.2)', () => {
  it('uses the configured part size when the request names none (final review minor 2)', async () => {
    const h = await backupHarness(a, b, { backup: { chunkMb: 16 } } as never)
    try {
      const u = h.user({ role: 'admin' })
      expect((await u.get('/api/backups/usage')).json().chunkMb).toBe(16)
      const body = { scope: { kind: 'collection', db: 'shop', coll: 'orders' }, format: 'mmbak' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const start = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: dp.planHash,
        password: 'correct horse battery staple',
      })
      const job = await waitJob(h.t, start.json().job.id, 60_000)
      const backupId = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId
      const file = readFileSync(h.ctx.backup.store.pathOf(h.ctx.backup.store.get(u.id, backupId)!))
      const header = readMmbakHeader(file)
      expect(header !== 'more' && header.header.chunkBytes).toBe(16 * 1024 * 1024)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('backs up a database in each format; the file holds every document and the metadata', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      for (const format of ['archive', 'gzip', 'mmbak'] as const) {
        const { job, report } = await dump(h, u, {
          scope: { kind: 'database', db: 'shop' },
          format,
          ...(format === 'mmbak' ? { password: PW } : {}),
        })
        expect(job!.state, JSON.stringify(report)).toBe('done')
        expect(report).toMatchObject({ kind: 'dump', format, masked: false })
        const ev = await events(h, u.id, report.backupId, format === 'mmbak' ? PW : undefined)
        const n = (coll: string) => ev.filter((e) => e.kind === 'doc' && e.coll === coll).length
        expect(n('orders')).toBe(300)
        expect(n('system.buckets.ts')).toBeGreaterThan(0)
        expect(
          ev
            .filter((e) => e.kind === 'meta')
            .map((e) => (e as { meta: { coll: string } }).meta.coll)
            .sort(),
        ).toEqual(['orders', 'ts', 'v'])
        expect(ev.filter((e) => e.kind === 'end').every((e) => (e as { crc: string }).crc === 'ok')).toBe(
          true,
        )
        expect(report.throughput).toBeGreaterThan(0)
        expect(report.namespaces.find((x: { coll: string }) => x.coll === 'orders').written).toBe(300)
        expect(h.ctx.backup.store.list(u.id, {}).map((r) => r.id)).toContain(report.backupId)
      }
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('writes only the indexes the server lists: a time series has no _id index (found by B20)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const { report } = await dump(h, u, { scope: { kind: 'database', db: 'shop' }, format: 'archive' })
      const metas = (await events(h, u.id, report.backupId))
        .filter((e) => e.kind === 'meta')
        .flatMap((e) => (e.kind === 'meta' ? [e.meta] : []))
      expect(metas.find((m) => m.coll === 'ts')!.indexes.map((i) => String(i.name))).not.toContain('_id_')
      expect(
        metas
          .find((m) => m.coll === 'orders')!
          .indexes.map((i) => i.name)
          .sort(),
      ).toEqual(['_id_', 'n_1'])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('shows a restricted user no size of what rules hide (twelfth review of explain masking, I3)', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'archive' }
      const u = h.user({ masked: ['A'] })
      const plan = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const orders = plan.namespaces.find((n: { coll: string }) => n.coll === 'orders')
      expect(orders).toMatchObject({ documents: 300, bytes: null })
      expect(plan.estimate).toEqual({ bytes: null, fileBytes: null, seconds: null })
      const checks = plan.checks.filter((c: { key: string }) => c.key === 'size' || c.key === 'quota')
      expect(checks.map((c: { params?: object }) => c.params)).toEqual([
        { hidden: 1 },
        { room: expect.any(Number), hidden: 1 },
      ])
      expect(plan.recommended.reason).not.toBe('size')
      // Unrestricted, the same plan has its sizes.
      const admin = (await h.user().call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      expect(admin.estimate.bytes).toBeGreaterThan(0)
      expect(admin.namespaces.find((n: { coll: string }) => n.coll === 'orders').bytes).toBeGreaterThan(0)
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('leaves out a collection no order hides a hidden _id in, with no size (fourteenth review, I-A)', async () => {
    const h = await backupHarness(a, b)
    try {
      await ca.db('shop').createCollection('keyed', { clusteredIndex: { key: { _id: 1 }, unique: true } })
      await ca
        .db('shop')
        .collection('keyed')
        .insertMany([{ _id: `${S}-a` as never }, { _id: `${S}-b` as never }])
      h.rules('A', [{ db: 'shop', coll: 'keyed', field: '_id' }])
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'archive' }
      const plan = (
        await h.user({ masked: ['A'] }).call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)
      ).json()
      const keyed = plan.namespaces.find((n: { coll: string }) => n.coll === 'keyed')
      expect(keyed).toMatchObject({
        skipped: expect.stringContaining('order of a hidden value'),
        bytes: null,
      })
      // A collection read in _id order, past document _ids, says beforehand that one stops it,
      // beside the note on its validator (fifteenth review, Minor 1).
      await ca.db('shop').createCollection('vkeyed', {
        clusteredIndex: { key: { _id: 1 }, unique: true },
        validator: { 'contact.phone': { $ne: '555-0100' } },
      })
      h.rules('A', [
        { db: 'shop', coll: 'keyed', field: '_id' },
        { db: 'shop', coll: 'vkeyed', field: '**.phone' },
      ])
      const again = (
        await h.user({ masked: ['A'] }).call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)
      ).json()
      const vkeyed = again.namespaces.find((n: { coll: string }) => n.coll === 'vkeyed')
      expect(vkeyed.note).toContain('validator')
      expect(vkeyed.note).toContain('a document _id stops the backup')
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('plans a restricted backup of more than a hundred collections, each with its own lookups (fourteenth review, I-B)', async () => {
    const h = await backupHarness(a, b)
    try {
      const many = ca.db('many')
      await many.dropDatabase()
      for (let i = 0; i < 120; i += 20)
        await Promise.all(
          Array.from({ length: 20 }, async (_, j) => {
            // Each with a validator: whichever the listing gives past the hundredth, one is there.
            await many.createCollection(`c${i + j}`, { validator: { n: { $exists: true } } })
            await many.collection(`c${i + j}`).insertOne({ n: i + j, email: `${S}-${i + j}@x` })
          }),
        )
      // A view and a validator past the hundredth namespace keep what they are (fifteenth review, I-1).
      await many.createCollection('zz_valid', { validator: { n: { $exists: true } } })
      await many.createCollection('zz_view', { viewOn: 'c1', pipeline: [{ $match: { n: 1 } }] })
      h.rules('A', [{ db: 'many', coll: 'c0', field: 'email' }])
      const body = { scope: { kind: 'database', db: 'many' }, format: 'archive' }
      const res = await h
        .user({ masked: ['A'] })
        .call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)
      expect(res.statusCode, res.body).toBe(200)
      const plan = res.json()
      expect(plan.namespaces).toHaveLength(122)
      expect(plan.namespaces.filter((n: { skipped?: string }) => n.skipped)).toEqual([])
      expect(plan.namespaces.filter((n: { note?: string }) => n.note)).toEqual([])
    } finally {
      await ca.db('many').dropDatabase()
      await h.t.close()
    }
  }, 120_000)

  it('reports a restricted dump’s progress with no size of what rules hide (twelfth review, I3)', async () => {
    const h = await backupHarness(a, b)
    // Every progress the job reports, whether or not it reaches a listener.
    const seen: Array<{ done: number; total: number }> = []
    const runner = JobRunner.prototype as unknown as {
      emit: (live: { record: JobRecord }, force: boolean) => void
    }
    const emit = runner.emit
    vi.spyOn(runner, 'emit').mockImplementation(function (this: unknown, live, force) {
      if (live.record.progress) seen.push({ ...live.record.progress })
      return emit.call(this, live, force)
    })
    try {
      await ca
        .db('shop')
        .collection('big')
        .insertMany(Array.from({ length: 2500 }, (_, i) => ({ email: `${S}-${i}@x`, pad: 'x'.repeat(200) })))
      h.rules('A', [{ db: 'shop', coll: 'big', field: 'email' }])
      const u = h.user({ masked: ['A'] })
      const { job } = await dump(h, u, {
        scope: { kind: 'collection', db: 'shop', coll: 'big' },
        format: 'archive',
      })
      expect(job!.state).toBe('done')
      // Each counts what was read so far: never the stored size still to come.
      expect(seen.length).toBeGreaterThan(1)
      expect(seen.every((p) => p.total === p.done)).toBe(true)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('a restricted dump holds no personal value (B7, Review Focus 5)', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const u = h.user({ masked: ['A'] })
      const { job, report } = await dump(h, u, { scope: { kind: 'database', db: 'shop' }, format: 'archive' })
      expect(job!.state, JSON.stringify(report)).toBe('done')
      expect(report.masked).toBe(true)
      const file = readFileSync(h.ctx.backup.store.pathOf(h.ctx.backup.store.get(u.id, report.backupId)!))
      expect(file.includes(Buffer.from(S))).toBe(false)
      const ev = await events(h, u.id, report.backupId)
      expect(ev[0]).toMatchObject({
        kind: 'header',
        mongoManager: { masked: true, maskedPaths: ['shop.orders.email'] },
      })
      expect(ev.filter((e) => e.kind === 'doc' && e.coll === 'orders')).toHaveLength(300)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('never stores the password (B13) and refuses a changed plan or a missing password', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const { report } = await dump(h, u, {
        scope: { kind: 'collection', db: 'shop', coll: 'orders' },
        format: 'mmbak',
        password: PW,
      })
      const stored = JSON.stringify([
        h.ctx.store.db.prepare('SELECT * FROM jobs').all(),
        h.ctx.store.db.prepare('SELECT * FROM audit_log').all(),
        h.ctx.store.db.prepare('SELECT * FROM transfer_reports').all(),
        h.ctx.store.db.prepare('SELECT * FROM backups').all(),
      ])
      expect(stored).not.toContain(PW)
      expect(JSON.stringify(report)).not.toContain(PW)
      const base = `/api/connections/${h.ids.A}/backup`
      const changed = await u.call('POST', base, {
        scope: { kind: 'server' },
        format: 'gzip',
        planHash: 'f'.repeat(64),
      })
      expect(changed.statusCode).toBe(409)
      expect(changed.json().details.reason).toBe('plan_changed')
      const nopw = await u.call('POST', base, { scope: { kind: 'server' }, planHash: 'f'.repeat(64) })
      expect(nopw.statusCode).toBe(400)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('a failure while reading leaves no backup behind (B18)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user()
      const real = FindCursor.prototype.next
      let calls = 0
      vi.spyOn(FindCursor.prototype, 'next').mockImplementation(async function (this: FindCursor) {
        if (++calls === 50) throw Object.assign(new Error('connection reset'), { name: 'MongoNetworkError' })
        return real.call(this)
      })
      const { job } = await dump(h, u, {
        scope: { kind: 'collection', db: 'shop', coll: 'orders' },
        format: 'gzip',
      })
      expect(job!.state).toBe('failed')
      expect(h.ctx.backup.store.list(u.id, {})).toEqual([])
      expect(h.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM backups WHERE kind = 'backup'").get()).toEqual(
        { n: 0 },
      )
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('refuses a backup the quota cannot hold (B17)', async () => {
    const h = await backupHarness(a, b, { backup: { quotaMb: 16 } } as never)
    try {
      await ca
        .db('shop')
        .collection('big')
        .insertMany(Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(250_000) })))
      const u = h.user()
      const plan = (
        await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, {
          scope: { kind: 'collection', db: 'shop', coll: 'big' },
          format: 'archive',
        })
      ).json()
      expect(plan.refusals).toContain('backup_quota')
      const start = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
        scope: { kind: 'collection', db: 'shop', coll: 'big' },
        format: 'archive',
        planHash: plan.planHash,
      })
      expect(start.statusCode).toBe(409)
      expect(start.json().details.reasons).toContain('backup_quota')
    } finally {
      await h.t.close()
    }
  })

  it.skipIf(!tools)(
    'mongorestore restores a dump the job wrote (B20, writer side)',
    { timeout: 90_000 },
    async () => {
      const h = await backupHarness(a, b)
      try {
        const u = h.user()
        const { report } = await dump(h, u, { scope: { kind: 'database', db: 'shop' }, format: 'gzip' })
        const path = h.ctx.backup.store.pathOf(h.ctx.backup.store.get(u.id, report.backupId)!)
        const r = spawnSync(tools!.restore, [
          `--uri=mongodb://127.0.0.1:${b.port}`,
          `--archive=${path}`,
          '--gzip',
        ])
        expect(r.status, String(r.stderr)).toBe(0)
        const cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
        try {
          expect(await cb.db('shop').collection('orders').countDocuments()).toBe(300)
          expect(await cb.db('shop').collection('ts').countDocuments()).toBe(2)
          expect((await cb.db('shop').listCollections({ name: 'v' }).toArray())[0]?.type).toBe('view')
          expect((await cb.db('shop').collection('orders').indexes()).map((i) => i.name).sort()).toEqual([
            '_id_',
            'n_1',
          ])
        } finally {
          await cb.db('shop').dropDatabase()
          await cb.close()
        }
      } finally {
        await h.t.close()
      }
    },
  )
})
