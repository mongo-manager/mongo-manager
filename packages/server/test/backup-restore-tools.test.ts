import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dirname } from 'node:path'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { fixture, mongoTools } from './support/mongo-tools'
import { restoreToolArgs } from '../src/backup/restore-job'
import { slow } from './support/slowness'

const tools = await mongoTools()

describe('mongorestore arguments (B15)', () => {
  it('maps every namespace, staging for replace, never --drop', () => {
    const pairs = [
      { from: { db: 'shop', coll: 'orders' }, to: { db: 'shop2', coll: 'orders' }, action: 'replace' },
      { from: { db: 'shop', coll: 'v' }, to: { db: 'shop2', coll: 'v' }, action: 'create' },
    ] as never
    const args = restoreToolArgs(pairs, new Map([['shop2.orders', 'mm_restore_00000000000000aa']]), {
      gzip: true,
      indexes: false,
      options: true,
      stopOnError: true,
      dryRun: false,
    })
    expect(args).toEqual([
      '--archive',
      '--gzip',
      '--nsInclude=shop.orders',
      '--nsFrom=shop.orders',
      '--nsTo=shop2.mm_restore_00000000000000aa',
      '--nsInclude=shop.v',
      '--nsFrom=shop.v',
      '--nsTo=shop2.v',
      '--noIndexRestore',
      '--stopOnError',
    ])
    expect(args.join(' ')).not.toContain('--drop')
    expect(
      restoreToolArgs(pairs, new Map(), {
        gzip: false,
        indexes: true,
        options: false,
        stopOnError: false,
        dryRun: true,
      }),
    ).toContain('--dryRun')
  })

  // Review of d7ddbaae: an archive of 6.0 to 8.2 keeps a series' buckets under system.buckets, and
  // mongorestore renamed the series but not its buckets: they went to the source's own namespace.
  it("renames a time series' buckets with it", () => {
    const series = [
      {
        from: { db: 'shop', coll: 'ts' },
        to: { db: 'shop2', coll: 'ts2' },
        action: 'create',
        meta: { type: 'timeseries' },
      },
    ] as never
    const args = restoreToolArgs(series, new Map(), {
      gzip: false,
      indexes: true,
      options: true,
      stopOnError: false,
      dryRun: false,
    })
    expect(args).toEqual([
      '--archive',
      '--nsInclude=shop.ts',
      '--nsFrom=shop.ts',
      '--nsTo=shop2.ts2',
      '--nsFrom=shop.system.buckets.ts',
      '--nsTo=shop2.system.buckets.ts2',
    ])
  })
})

describe.skipIf(!tools)('restore through mongorestore (spec §5.3)', () => {
  let a: TestMongo
  let b: TestMongo
  let cb: MongoClient
  beforeAll(async () => {
    ;[a, b] = await Promise.all([startMongo(), startMongo()])
    cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
  }, slow(180_000))
  afterAll(async () => {
    await cb?.close()
    await Promise.all([a?.stop(), b?.stop()])
  })

  it('keeps mongorestore out when a view would read a renamed collection (final review I8)', async () => {
    const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
    try {
      const u = h.user({ role: 'admin' })
      const file = fixture('shop.archive.gz')
      const id = (await u.call('POST', '/api/backups/uploads', { name: 'x.gz', size: file.length })).json()
        .uploadId
      await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
      const p = (
        await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
          source: { kind: 'upload', uploadId: id },
          engine: 'tools',
          confirmTtl: true,
          mapping: [
            { from: { db: 'shop', coll: 'orders' }, to: { db: 'shop8', coll: 'orders_r' } },
            { from: { db: 'shop', coll: 'v' }, to: { db: 'shop8', coll: 'v' } },
          ],
        })
      ).json()
      expect(p.refusals).toContain('tools_unavailable')
      expect(p.checks.find((c: { key: string }) => c.key === 'tools').params.reason).toBe('views')
    } finally {
      await h.t.close()
    }
  })

  // Review M1: mongorestore drops what it replaces with its indexes and options: a replace that
  // keeps the target's own cannot go through it.
  it('keeps mongorestore out when a replace keeps the target’s own settings', async () => {
    const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
    try {
      await cb.db('shop9').collection('orders').insertOne({ mine: true })
      const u = h.user({ role: 'admin' })
      const file = fixture('shop.archive.gz')
      const id = (await u.call('POST', '/api/backups/uploads', { name: 'x.gz', size: file.length })).json()
        .uploadId
      await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
      const p = (
        await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
          source: { kind: 'upload', uploadId: id },
          engine: 'tools',
          mode: 'replace',
          indexes: false,
          confirmTtl: true,
          confirmNames: ['shop9.orders'],
          mapping: [{ from: { db: 'shop', coll: 'orders' }, to: { db: 'shop9', coll: 'orders' } }],
        })
      ).json()
      expect(p.refusals).toContain('tools_unavailable')
      expect(p.checks.find((c: { key: string }) => c.key === 'tools').params.reason).toBe('keeps_own')
    } finally {
      await cb.db('shop9').dropDatabase()
      await h.t.close()
    }
  })

  it('restores, and replaces through staging', async () => {
    const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
    try {
      await cb.db('shop9').collection('orders').insertOne({ old: true })
      const u = h.user({ role: 'admin' })
      const file = fixture('shop.archive.gz')
      const id = (await u.call('POST', '/api/backups/uploads', { name: 'x.gz', size: file.length })).json()
        .uploadId
      await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
      const body = {
        source: { kind: 'upload', uploadId: id },
        engine: 'tools',
        mode: 'replace',
        confirmTtl: true,
        confirmNames: ['shop9.orders'],
        mapping: [{ from: { db: 'shop', coll: 'orders' }, to: { db: 'shop9', coll: 'orders' } }],
      }
      const base = `/api/connections/${h.ids.B}/restore`
      const plan = (await u.call('POST', `${base}/plan`, body)).json()
      expect(plan.refusals).toEqual([])
      const job = await waitJob(
        h.t,
        (await u.call('POST', base, { ...body, planHash: plan.planHash })).json().job.id,
        60_000,
      )
      const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(job.state, JSON.stringify(report)).toBe('done')
      expect(await cb.db('shop9').collection('orders').countDocuments({ old: true })).toBe(0)
      expect(await cb.db('shop9').collection('orders').countDocuments()).toBe(2)
      expect(
        (await cb.db('shop9').listCollections().toArray())
          .map((c) => c.name)
          .filter((n) => n.startsWith('mm_restore_')),
      ).toEqual([])
      expect(report).toMatchObject({ engine: 'tools' })
      // mongorestore ran: its log is kept (the built-in engine has none).
      expect(report.toolLog.some((l: string) => /document\(s\) restored successfully/.test(l))).toBe(true)
      expect(report.namespaces[0]).toMatchObject({ inserted: 2, failed: 0 })
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
