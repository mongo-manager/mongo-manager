import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { PassThrough } from 'node:stream'
import { BSON } from 'bson'
import { MongoClient, type Document } from 'mongodb'
import type { DrillReport } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { mongoTools } from './support/mongo-tools'
import { drillKind } from '../src/backup/drill-job'
import { ArchiveWriter } from '../src/backup/archive-writer'
import { rawSeries, serverLevel } from '../src/backup/series'
import { optionsTargetMayRefuse } from '../src/transfer/collection-spec'
import { slow } from './support/slowness'

/**
 * CI 2026-10-18 (MongoDB 8.3): a time series' buckets are read, written and kept in a dump where
 * mongo-tools has them for the server's version (series.ts): from 8.3 through the series' own name
 * with rawData, before through system.buckets.<name>. Every operation is profiled, and what each
 * one named is checked; the backup, the restore and the drill each go through a series whole.
 */
const tools = await mongoTools()
let a: TestMongo
let b: TestMongo
let ca: MongoClient
let cb: MongoClient
let raw: boolean
beforeAll(async () => {
  ;[a, b] = await Promise.all([
    startMongo({ args: ['--profile', '2'] }),
    startMongo({ args: ['--profile', '2'] }),
  ])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
  raw = rawSeries(String((await ca.db('admin').command({ buildInfo: 1 })).version))
}, slow(180_000))
afterAll(async () => {
  await Promise.all([ca?.close(), cb?.close()])
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  for (const d of ['shop', 'shop2']) await Promise.all([ca.db(d).dropDatabase(), cb.db(d).dropDatabase()])
  await ca.db('shop').createCollection('ts', { timeseries: { timeField: 't', metaField: 'm' } })
  await ca
    .db('shop')
    .collection('ts')
    .insertMany(Array.from({ length: 30 }, (_, i) => ({ t: new Date(i * 60_000), m: i % 3, x: i })))
})

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
async function backup(h: H, u: U): Promise<string> {
  const body = { scope: { kind: 'database', db: 'shop' }, format: 'gzip' }
  const base = `/api/connections/${h.ids.A}/backup`
  const plan = (await u.call('POST', `${base}/plan`, body)).json()
  const res = await u.call('POST', base, { ...body, planHash: plan.planHash })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  expect(job.state, job.error ?? '').toBe('done')
  return (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId as string
}
async function restore(h: H, u: U, source: Document) {
  const body = {
    source,
    mapping: [{ from: { db: 'shop', coll: 'ts' }, to: { db: 'shop2', coll: 'ts' } }],
  }
  const base = `/api/connections/${h.ids.B}/restore`
  const plan = await u.call('POST', `${base}/plan`, body)
  expect(plan.statusCode, plan.body).toBe(200)
  const res = await u.call('POST', base, { ...body, planHash: plan.json().planHash })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  expect(job.state, job.error ?? '').toBe('done')
}
/** The commands the profiler saw on `db` naming the series `coll` or its buckets. */
async function named(client: MongoClient, db: string, op: 'find' | 'insert', coll: string) {
  const seen = await client
    .db(db)
    .collection('system.profile')
    .find({ [`command.${op}`]: { $in: [coll, `system.buckets.${coll}`] } })
    .toArray()
  return seen.map((p) => `${String(p.command[op])}${p.command.rawData === true ? ' rawData' : ''}`)
}
const expected = (coll: string) => (raw ? `${coll} rawData` : `system.buckets.${coll}`)
const docs = async (client: MongoClient, db: string) =>
  (
    await client
      .db(db)
      .collection('ts')
      .find({}, { projection: { _id: 0 } })
      .sort({ x: 1 })
      .toArray()
  ).map((d) => d.x)

describe('a time series backed up, restored and drilled where its version keeps it', () => {
  it('reads it, keeps it and writes it back through the names mongo-tools uses', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const backupId = await backup(h, u)
      expect(new Set(await named(ca, 'shop', 'find', 'ts'))).toEqual(new Set([expected('ts')]))
      await restore(h, u, { kind: 'backup', backupId })
      expect(new Set(await named(cb, 'shop2', 'insert', 'ts'))).toEqual(new Set([expected('ts')]))
      expect(await docs(cb, 'shop2')).toEqual(Array.from({ length: 30 }, (_, i) => i))
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('drills it whole, writing and reading it back the same way', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const backupId = await backup(h, u)
      let seen: string[] = []
      const kind = drillKind({
        client: (id) => h.ctx.manager.getClient(id),
        ctx: () => h.ctx,
        afterLoad: async (client, scratch, names) => {
          const series = names.find((n) => n.endsWith('ts'))!
          const own = series.replace(/^system\.buckets\./, '')
          seen = [...(await named(client, scratch, 'insert', own))]
        },
      })
      const job = h.ctx.jobs.start(
        kind,
        { userId: u.id, connectionId: h.ids.A, db: 'shop', coll: '*', target: 'drill backup' },
        { owner: u.id, backupId, schedule: null },
      )
      const done = await waitJob(h.t, job.id, 60_000)
      expect(done.state, done.error ?? '').toBe('done')
      const report = h.ctx.transfer.reports.get(u.id, job.id) as DrillReport
      const ts = report.namespaces.find((n) => n.ns === 'shop.ts')!
      expect(ts).toMatchObject({ contents: 'match', crc: 'ok' })
      expect(ts.archived).toBeGreaterThan(0)
      expect(ts.restored).toBe(ts.archived)
      expect(seen.length).toBeGreaterThan(0)
      expect(
        seen.every((s) => s.endsWith(raw ? ' rawData' : '') && s.includes('system.buckets.') !== raw),
      ).toBe(true)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it.skipIf(!tools)("restores mongodump's own archive of it", { timeout: 90_000 }, async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const r = spawnSync(tools!.dump, [`--uri=mongodb://127.0.0.1:${a.port}`, '--db=shop', '--archive'], {
        maxBuffer: 64 * 1024 * 1024,
      })
      expect(r.status, String(r.stderr)).toBe(0)
      const id = (
        await u.call('POST', '/api/backups/uploads', { name: 'ts.archive', size: r.stdout.length })
      ).json().uploadId as string
      await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, r.stdout)
      await restore(h, u, { kind: 'upload', uploadId: id })
      expect(await docs(cb, 'shop2')).toEqual(Array.from({ length: 30 }, (_, i) => i))
    } finally {
      await h.t.close()
    }
  })
})

// Review of the CI fixes (finding 9): across versions, both ways, and the layouts a version does not
// say. Where this run's servers are 8.3 or later (CI's 8.3 leg), against an 8.0 one.
describe.runIf(rawSeries(process.env.MONGOMS_VERSION))('a time series across 8.3 and older servers', () => {
  let old: TestMongo
  let co: MongoClient
  beforeAll(async () => {
    old = await startMongo({ version: '8.0.32' })
    co = await new MongoClient(`mongodb://127.0.0.1:${old.port}`).connect()
  }, slow(180_000))
  afterAll(async () => {
    await co?.close()
    await old?.stop()
  })
  beforeEach(async () => {
    await co.db('shop').dropDatabase()
    await co.db('shop').createCollection('ts', { timeseries: { timeField: 't', metaField: 'm' } })
    await co
      .db('shop')
      .collection('ts')
      .insertMany(Array.from({ length: 30 }, (_, i) => ({ t: new Date(i * 60_000), m: i % 3, x: i })))
    await co.db('shop2').dropDatabase()
  })

  it('restores an 8.3 backup into 8.0, and an 8.0 one into 8.3', async () => {
    const up = await backupHarness(a, old)
    try {
      const u = up.user({ role: 'admin' })
      await restore(up, u, { kind: 'backup', backupId: await backup(up, u) })
      expect(await docs(co, 'shop2')).toEqual(Array.from({ length: 30 }, (_, i) => i))
    } finally {
      await up.t.close()
    }
    const down = await backupHarness(old, b)
    try {
      const u = down.user({ role: 'admin' })
      await restore(down, u, { kind: 'backup', backupId: await backup(down, u) })
      expect(await docs(cb, 'shop2')).toEqual(Array.from({ length: 30 }, (_, i) => i))
    } finally {
      await down.t.close()
    }
  }, 300_000)

  // An archive of an 8.3 server in the older layout (Mongo Manager's before this fix, mongodump's
  // before 100.16): the built-in engine restores it; mongorestore would find nothing, so the tools
  // engine is refused for it, and says why.
  it('restores an 8.3 archive in the older layout with the built-in engine only', async () => {
    const buckets = await ca
      .db('shop')
      .collection('ts')
      .find({}, { rawData: true } as never)
      .toArray()
    expect(buckets.length).toBeGreaterThan(0)
    const pass = new PassThrough()
    const parts: Buffer[] = []
    pass.on('data', (c: Buffer) => parts.push(c))
    const w = new ArchiveWriter(pass)
    const [info] = await ca.db('shop').listCollections({ name: 'ts' }).toArray()
    await w.begin({ serverVersion: '8.3.11', toolVersion: 'mongo-manager 2.0.0', mongoManager: null }, [
      { db: 'shop', coll: 'ts', type: 'timeseries', options: (info as Document).options, indexes: [] },
    ])
    await w.open('shop', 'system.buckets.ts')
    for (const d of buckets) await w.write(Buffer.from(BSON.serialize(d)))
    await w.close()
    await w.finish()
    pass.end()
    const file = Buffer.concat(parts)
    const h = await backupHarness(
      a,
      b,
      tools ? ({ backup: { toolsPath: dirname(tools.dump) } } as never) : {},
    )
    try {
      const u = h.user({ role: 'admin' })
      const upload = async () => {
        const id = (
          await u.call('POST', '/api/backups/uploads', { name: 'old.archive', size: file.length })
        ).json().uploadId as string
        await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
        return id
      }
      if (tools) {
        const plan = (
          await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
            source: { kind: 'upload', uploadId: await upload() },
            engine: 'tools',
            mapping: [{ from: { db: 'shop', coll: 'ts' }, to: { db: 'shop2', coll: 'ts' } }],
          })
        ).json()
        expect(plan.refusals).toContain('tools_unavailable')
        expect(plan.checks.find((c: { key: string }) => c.key === 'tools')).toMatchObject({
          level: 'block',
          params: { reason: 'series' },
        })
      }
      await restore(h, u, { kind: 'upload', uploadId: await upload() })
      expect(await docs(cb, 'shop2')).toEqual(Array.from({ length: 30 }, (_, i) => i))
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Second review (minors 6, 8c): Mongo Manager's own 8.3 backup says its series are under their own
  // names, so mongorestore restores it; and mongorestore takes an 8.3 backup into an 8.0 server.
  it.skipIf(!tools)(
    'restores its own 8.3 backup with mongorestore, into 8.3 and into 8.0',
    { timeout: 300_000 },
    async () => {
      for (const [target, client] of [
        [b, cb],
        [old, co],
      ] as const) {
        await client.db('shop2').dropDatabase()
        const h = await backupHarness(a, target, { backup: { toolsPath: dirname(tools!.dump) } } as never)
        try {
          const u = h.user({ role: 'admin' })
          const backupId = await backup(h, u)
          const body = {
            source: { kind: 'backup', backupId },
            engine: 'tools',
            mapping: [{ from: { db: 'shop', coll: 'ts' }, to: { db: 'shop2', coll: 'ts' } }],
          }
          const base = `/api/connections/${h.ids.B}/restore`
          const plan = (await u.call('POST', `${base}/plan`, body)).json()
          // MongoDB 9.0 (local run, 2026-10-20): its series options hold fixedBucketing, which 8.0
          // refuses; into 8.0 the plan says so instead (backup-series-options.test.ts).
          const [info] = await ca.db('shop').listCollections({ name: 'ts' }).toArray()
          const version = String((await ca.db('admin').command({ buildInfo: 1 })).version)
          const beyond = optionsTargetMayRefuse(
            { options: (info as Document).options as Document, indexes: [] },
            await serverLevel(client),
            version,
            false,
          )
          if (beyond.length) {
            expect(plan.checks.find((c: { key: string }) => c.key === 'tools')).toMatchObject({
              level: 'block',
              params: { reason: 'newer_options', fields: beyond.join(', ') },
            })
            continue
          }
          expect(plan.refusals).toEqual([])
          const job = await waitJob(
            h.t,
            (await u.call('POST', base, { ...body, planHash: plan.planHash })).json().job.id,
            60_000,
          )
          expect(job.state, job.error ?? '').toBe('done')
          expect(await docs(client, 'shop2')).toEqual(Array.from({ length: 30 }, (_, i) => i))
        } finally {
          await h.t.close()
        }
      }
    },
  )

  it.skipIf(!tools)(
    "restores mongodump's own 8.3 archive of it with mongorestore too",
    { timeout: 90_000 },
    async () => {
      const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
      try {
        const u = h.user({ role: 'admin' })
        const r = spawnSync(tools!.dump, [`--uri=mongodb://127.0.0.1:${a.port}`, '--db=shop', '--archive'], {
          maxBuffer: 64 * 1024 * 1024,
        })
        expect(r.status, String(r.stderr)).toBe(0)
        const id = (
          await u.call('POST', '/api/backups/uploads', { name: 'ts.archive', size: r.stdout.length })
        ).json().uploadId as string
        await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, r.stdout)
        const body = {
          source: { kind: 'upload', uploadId: id },
          engine: 'tools',
          mapping: [{ from: { db: 'shop', coll: 'ts' }, to: { db: 'shop2', coll: 'ts' } }],
        }
        const base = `/api/connections/${h.ids.B}/restore`
        const plan = (await u.call('POST', `${base}/plan`, body)).json()
        expect(plan.refusals).toEqual([])
        const job = await waitJob(
          h.t,
          (await u.call('POST', base, { ...body, planHash: plan.planHash })).json().job.id,
          60_000,
        )
        expect(job.state, job.error ?? '').toBe('done')
        expect(await docs(cb, 'shop2')).toEqual(Array.from({ length: 30 }, (_, i) => i))
      } finally {
        await h.t.close()
      }
    },
  )
})
