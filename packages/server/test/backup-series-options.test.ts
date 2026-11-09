// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dirname } from 'node:path'
import { PassThrough } from 'node:stream'
import { BSON } from 'bson'
import { MongoClient, type Document } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { mongoTools } from './support/mongo-tools'
import { runVersion, versionAtLeast } from './support/run-version'
import { ArchiveWriter, type NamespaceMeta } from '../src/backup/archive-writer'
import { ZipWriter } from '../src/transfer/formats/zip'
import { rawSeries, serverLevel } from '../src/backup/series'
import { slow } from './support/slowness'

/**
 * MongoDB 9.0 (local run, 2026-10-20): a 9.0 series says `fixedBucketing` among its options, and
 * mongorestore passed it to an 8.0 server, which refused to create the collection; the plan had said
 * nothing. What a target takes is set by its feature level (its FCV: a 9.0 at FCV 8.0 refuses it
 * too), and the same holds for 9.0's 2dsphereIndexVersion 4 and for a series' own bucketing, which
 * 6.0 cannot have (review of db45c424). The plan refuses mongorestore for what the target may
 * refuse, and says which; the built-in engine leaves out what the target lacks, and skips, saying
 * why, a series it cannot make as it was.
 */
const tools = await mongoTools()
const ALLOWED = ['timeField', 'metaField', 'granularity', 'bucketMaxSpanSeconds', 'bucketRoundingSeconds']
let a: TestMongo
let b: TestMongo
let ca: MongoClient
let cb: MongoClient
let release: string
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
  cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
  release = String((await ca.db('admin').command({ buildInfo: 1 })).version)
  await ca.db('shop').dropDatabase()
  await ca.db('shop').createCollection('ts', { timeseries: { timeField: 't', metaField: 'm' } })
  await ca
    .db('shop')
    .collection('ts')
    .insertMany(Array.from({ length: 30 }, (_, i) => ({ t: new Date(i * 60_000), m: i % 3, x: i })))
}, slow(180_000))
afterAll(async () => {
  await Promise.all([ca?.close(), cb?.close()])
  await Promise.all([a?.stop(), b?.stop()])
})

const RUN = runVersion()
const atLeast = versionAtLeast

/**
 * An archive of `shop.ts` (its options to the allowlist, then `extra`) and of `shop.geo` with
 * `geoIndexes`, as a server of `serverVersion` would write it.
 */
async function archive(
  extra: Document,
  opts: { serverVersion?: string; geoIndexes?: Document[]; checked?: Document } = {},
): Promise<Buffer> {
  const serverVersion = opts.serverVersion ?? '99.0.0'
  const buckets = rawSeries(release)
    ? await ca
        .db('shop')
        .collection('ts')
        .find({}, { rawData: true } as never)
        .toArray()
    : await ca.db('shop').collection('system.buckets.ts').find({}).toArray()
  expect(buckets.length).toBeGreaterThan(0)
  const [info] = await ca.db('shop').listCollections({ name: 'ts' }).toArray()
  const options = (info as Document).options as Document
  const series = Object.fromEntries(
    Object.entries(options.timeseries as Document).filter(([k]) => ALLOWED.includes(k)),
  )
  const metas: NamespaceMeta[] = [
    {
      db: 'shop',
      coll: 'ts',
      type: 'timeseries',
      options: { ...options, timeseries: { ...series, ...extra } },
      indexes: [],
    },
  ]
  if (opts.geoIndexes)
    metas.push({
      db: 'shop',
      coll: 'geo',
      type: 'collection',
      options: {},
      indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }, ...opts.geoIndexes],
    })
  if (opts.checked)
    metas.push({ db: 'shop', coll: 'checked', type: 'collection', options: opts.checked, indexes: [] })
  const pass = new PassThrough()
  const parts: Buffer[] = []
  pass.on('data', (c: Buffer) => parts.push(c))
  const w = new ArchiveWriter(pass)
  await w.begin({ serverVersion, toolVersion: '100.16.0', mongoManager: null }, metas)
  // From 8.3 on, a dump keeps a series' buckets under its own name (series.ts).
  await w.open('shop', rawSeries(serverVersion) ? 'ts' : 'system.buckets.ts')
  for (const d of buckets) await w.write(Buffer.from(BSON.serialize(d)))
  await w.close()
  if (opts.checked) {
    await w.open('shop', 'checked')
    await w.write(Buffer.from(BSON.serialize({ _id: 1, a: 1 })))
    await w.close()
  }
  if (opts.geoIndexes) {
    await w.open('shop', 'geo')
    await w.write(Buffer.from(BSON.serialize({ _id: 1, loc: { type: 'Point', coordinates: [29, 41] } })))
    await w.close()
  }
  await w.finish()
  pass.end()
  return Buffer.concat(parts)
}

type H = Awaited<ReturnType<typeof backupHarness>>
function restoring(h: H) {
  const u = h.user({ role: 'admin' })
  const base = `/api/connections/${h.ids.B}/restore`
  const upload = async (file: Buffer) => {
    const id = (await u.call('POST', '/api/backups/uploads', { name: 'x.archive', size: file.length })).json()
      .uploadId as string
    await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
    return id
  }
  const plan = async (file: Buffer, body: Document) =>
    (
      await u.call('POST', `${base}/plan`, {
        source: { kind: 'upload', uploadId: await upload(file) },
        ...body,
      })
    ).json()
  const run = async (file: Buffer, body: Document) => {
    const full = { source: { kind: 'upload', uploadId: await upload(file) }, ...body }
    const p = await u.call('POST', `${base}/plan`, full)
    expect(p.statusCode, p.body).toBe(200)
    expect(p.json().refusals).toEqual([])
    const res = await u.call('POST', base, { ...full, planHash: p.json().planHash })
    expect(res.statusCode, res.body).toBe(202)
    const job = await waitJob(h.t, res.json().job.id, 60_000)
    expect(job.state, job.error ?? '').toBe('done')
    return p.json()
  }
  return { plan, run }
}
const toolsCheck = (plan: { checks: { key: string }[] }) => plan.checks.find((c) => c.key === 'tools')
const series = [{ from: { db: 'shop', coll: 'ts' }, to: { db: 'shop2', coll: 'ts' } }]
const geo = [{ from: { db: 'shop', coll: 'geo' }, to: { db: 'shop2', coll: 'geo' } }]

describe('options an older server may not take', () => {
  it.skipIf(!tools)(
    'are refused to mongorestore in the plan, and restored by the built-in engine',
    { timeout: 90_000 },
    async () => {
      const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
      try {
        const { plan, run } = restoring(h)
        // An option of a later release than any here: no target here takes it.
        const unknown = await archive({ laterOption: true })
        const refused = await plan(unknown, { engine: 'tools', mapping: series })
        expect(refused.refusals).toContain('tools_unavailable')
        expect(toolsCheck(refused)).toEqual({
          key: 'tools',
          level: 'block',
          params: { reason: 'newer_options', fields: 'laterOption' },
        })

        // The names come from the archive: five at most are said, each cut at 64 characters.
        const many = Object.fromEntries(['L'.repeat(100), 'a2', 'a3', 'a4', 'a5', 'a6'].map((k) => [k, 1]))
        expect(
          toolsCheck(await plan(await archive(many), { engine: 'tools', mapping: series })),
        ).toMatchObject({
          params: { reason: 'newer_options', fields: `${'L'.repeat(64)}, a2, a3, a4, a5, …` },
        })

        // Options the target knows: mongorestore is offered.
        expect(toolsCheck(await plan(await archive({}), { engine: 'tools', mapping: series }))).toMatchObject(
          {
            level: 'ok',
          },
        )

        // Review of 182c2882: into an existing series mongorestore stops at once ("timeseries
        // collection … already exists on the destination … use --drop"): refused in the plan.
        await cb.db('shop2').dropDatabase()
        await cb.db('shop2').createCollection('ts', { timeseries: { timeField: 't', metaField: 'm' } })
        const into = await plan(await archive({}), { engine: 'tools', mapping: series, mode: 'insert' })
        expect(toolsCheck(into)).toEqual({
          key: 'tools',
          level: 'block',
          params: { reason: 'series_exists' },
        })

        // The built-in engine restores the first one whole.
        await cb.db('shop2').dropDatabase()
        await run(unknown, { mapping: series })
        const xs = (await cb.db('shop2').collection('ts').find({}).toArray()).map((d) => d.x as number)
        expect(xs.sort((p, q) => p - q)).toEqual(Array.from({ length: 30 }, (_, i) => i))
      } finally {
        await h.t.close()
      }
    },
  )

  it.skipIf(!tools)(
    'says a 2dsphere index of 8.3 to mongorestore, and the built-in engine builds it',
    { timeout: 90_000 },
    async () => {
      const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
      try {
        const { plan, run } = restoring(h)
        const file = await archive(
          {},
          {
            serverVersion: '9.0.4',
            geoIndexes: [{ v: 2, key: { loc: '2dsphere' }, name: 'loc_2dsphere', '2dsphereIndexVersion': 4 }],
          },
        )
        const four = atLeast(release, 8, 3)
        const check = toolsCheck(await plan(file, { engine: 'tools', mapping: geo }))
        if (four) expect(check).toMatchObject({ level: 'ok' })
        else
          expect(check).toMatchObject({
            level: 'block',
            params: { reason: 'newer_options', fields: '2dsphereIndexVersion 4' },
          })
        // Without indexes, mongorestore passes none.
        expect(toolsCheck(await plan(file, { engine: 'tools', mapping: geo, indexes: false }))).toMatchObject(
          {
            level: 'ok',
          },
        )
        await cb.db('shop2').dropDatabase()
        await run(file, { mapping: geo })
        const built = (await cb.db('shop2').collection('geo').indexes()).find(
          (i) => i.name === 'loc_2dsphere',
        )
        expect(built?.['2dsphereIndexVersion']).toBe(four ? 4 : 3)
      } finally {
        await h.t.close()
      }
    },
  )

  // Review of 69adc29a (I-4): errorAndLog arrived in 8.1. Below it, a collection whose validator
  // is wanted is skipped, saying why, and mongorestore is told; without validators, both go on.
  it('says a validation action of 8.1 to a target below it, and goes on without validators', async () => {
    // 7.0, not 8.0.30 on: those refuse the check job's Linux 7.0 (SERVER-121912).
    const eight = await startMongo({ version: '7.0.45' })
    try {
      const h = await backupHarness(
        a,
        eight,
        tools ? ({ backup: { toolsPath: dirname(tools.dump) } } as never) : {},
      )
      try {
        const { plan } = restoring(h)
        const file = await archive(
          {},
          {
            serverVersion: '8.2.6',
            checked: { validator: { a: { $type: 'int' } }, validationAction: 'errorAndLog' },
          },
        )
        const mapping = [{ from: { db: 'shop', coll: 'checked' }, to: { db: 'shop2', coll: 'checked' } }]
        const why =
          'Its validation action errorAndLog needs MongoDB 8.1 or later on the target: leave its validator out to write it without one'
        expect(JSON.stringify(await plan(file, { mapping }))).toContain(why)
        const without = await plan(file, { mapping, options: false })
        expect(JSON.stringify(without)).not.toContain(why)
        expect(without.refusals).toEqual([])
        if (tools) {
          // Its namespace skipped, mongorestore has nothing of it to pass.
          expect(JSON.stringify(await plan(file, { mapping, engine: 'tools' }))).toContain(why)
          expect(toolsCheck(await plan(file, { mapping, engine: 'tools', options: false }))).toMatchObject({
            level: 'ok',
          })
        }
      } finally {
        await h.t.close()
      }
    } finally {
      await eight.stop()
    }
  }, 120_000)

  // Review of d7ddbaae: from an archive that keeps its buckets under system.buckets (6.0 to 8.2),
  // mongorestore renamed the series but not its buckets, which went to the source's namespace on
  // the target, and said it succeeded. They go where the series goes.
  // CI 2026-10-21 (wait-budget.ts): from a source of 8.3 or later it restores three times, from one
  // below it twice, each waiting up to 60 s.
  it.skipIf(!tools)(
    'restores a renamed series with mongorestore where it is sent, whatever its layout',
    { timeout: 240_000 },
    async () => {
      const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
      try {
        const { run } = restoring(h)
        await Promise.all([cb.db('shop').dropDatabase(), cb.db('shop2').dropDatabase()])
        for (const serverVersion of [release, '8.2.6', '8.3.13']) {
          // 8.3's layout is written by 8.3 and later only.
          if (rawSeries(serverVersion) && !rawSeries(release)) continue
          await cb.db('shop2').dropDatabase()
          // Under another name too (review of 182c2882): a wrong --nsTo would leave it empty.
          const renamed = [{ from: { db: 'shop', coll: 'ts' }, to: { db: 'shop2', coll: 'ts2' } }]
          await run(await archive({}, { serverVersion }), { engine: 'tools', mapping: renamed })
          const xs = (await cb.db('shop2').collection('ts2').find({}).toArray()).map((d) => d.x as number)
          expect(
            xs.sort((p, q) => p - q),
            serverVersion,
          ).toEqual(Array.from({ length: 30 }, (_, i) => i))
          expect(await cb.db('shop').listCollections().toArray(), serverVersion).toEqual([])
        }
      } finally {
        await h.t.close()
      }
    },
  )

  // Review of abf29ea7 (minor): mongorestore cannot open an encrypted backup at all; that is said
  // first, not a series' reason the user would act on in vain.
  it.skipIf(!tools)(
    'says first that mongorestore cannot open an encrypted backup',
    { timeout: 90_000 },
    async () => {
      const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
      try {
        const u = h.user({ role: 'admin' })
        const PW = 'correct horse battery staple'
        const body = { scope: { kind: 'database', db: 'shop' }, format: 'mmbak' }
        const dump = `/api/connections/${h.ids.A}/backup`
        const p = (await u.call('POST', `${dump}/plan`, body)).json()
        const res = await u.call('POST', dump, { ...body, planHash: p.planHash, password: PW })
        expect(res.statusCode, res.body).toBe(202)
        const job = await waitJob(h.t, res.json().job.id, 60_000)
        expect(job.state, job.error ?? '').toBe('done')
        const backupId = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId as string
        await cb.db('shop2').dropDatabase()
        await cb.db('shop2').createCollection('ts', { timeseries: { timeField: 't', metaField: 'm' } })
        const plan = (
          await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
            source: { kind: 'backup', backupId },
            password: PW,
            engine: 'tools',
            mapping: series,
            mode: 'insert',
            options: false,
          })
        ).json()
        expect(toolsCheck(plan)).toEqual({ key: 'tools', level: 'block', params: { reason: 'mmbak' } })
      } finally {
        await h.t.close()
      }
    },
  )

  // Review of 8c4d62cc (minor): a folder zip too.
  it.skipIf(!tools)('says first that mongorestore cannot open a folder zip', async () => {
    const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
    try {
      const u = h.user({ role: 'admin' })
      const pass = new PassThrough()
      const parts: Buffer[] = []
      pass.on('data', (c: Buffer) => parts.push(c))
      const zip = new ZipWriter(pass)
      const metadata = {
        options: { timeseries: { timeField: 't', metaField: 'm' } },
        indexes: [],
        collectionName: 'ts',
        type: 'timeseries',
      }
      await zip.add('shop/ts.metadata.json', Buffer.from(JSON.stringify(metadata)))
      await zip.add('shop/system.buckets.ts.bson', Buffer.alloc(0))
      await zip.finish()
      pass.end()
      const file = Buffer.concat(parts)
      const id = (
        await u.call('POST', '/api/backups/uploads', { name: 'dump.zip', size: file.length })
      ).json().uploadId as string
      await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
      await cb.db('shop2').dropDatabase()
      const plan = (
        await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
          source: { kind: 'upload', uploadId: id },
          engine: 'tools',
          mapping: series,
          options: false,
        })
      ).json()
      expect(toolsCheck(plan)).toEqual({ key: 'tools', level: 'block', params: { reason: 'directory' } })
    } finally {
      await h.t.close()
    }
  })

  // Review of 8e719ba7 (I-3): mongorestore refuses --noOptionsRestore for any time series ("cannot
  // specify --noOptionsRestore when restoring timeseries collections"): said in the plan.
  it.skipIf(!tools)('refuses mongorestore for a time series without its options', async () => {
    const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
    try {
      const { plan } = restoring(h)
      await cb.db('shop2').dropDatabase()
      const file = await archive({}, { serverVersion: release })
      expect(toolsCheck(await plan(file, { engine: 'tools', mapping: series, options: false }))).toEqual({
        key: 'tools',
        level: 'block',
        params: { reason: 'series_without_options' },
      })
      expect(toolsCheck(await plan(file, { engine: 'tools', mapping: series }))).toMatchObject({
        level: 'ok',
      })
    } finally {
      await h.t.close()
    }
  })

  // Review of 69adc29a (I-3): written into an existing series of another bucketing, its buckets
  // would be missed by queries by time; such a target is skipped, saying why, by either engine.
  it.runIf(atLeast(RUN, 6, 3))(
    'never writes buckets into an existing series of another bucketing',
    async () => {
      const h = await backupHarness(
        a,
        b,
        tools ? ({ backup: { toolsPath: dirname(tools.dump) } } as never) : {},
      )
      try {
        const { plan } = restoring(h)
        await cb.db('shop2').dropDatabase()
        await cb.db('shop2').createCollection('ts', {
          timeseries: {
            timeField: 't',
            metaField: 'm',
            bucketMaxSpanSeconds: 86400,
            bucketRoundingSeconds: 86400,
          },
        })
        const file = await archive({}, { serverVersion: release })
        for (const engine of tools ? ['builtin', 'tools'] : ['builtin']) {
          const p = await plan(file, { engine, mapping: series, mode: 'insert' })
          expect(JSON.stringify(p), engine).toContain(
            'The target is not a time series with the same time field, meta field and bucketing',
          )
        }
      } finally {
        await h.t.close()
      }
    },
  )

  // A target at a lower feature level than its release (after an upgrade): its FCV decides.
  it.skipIf(!tools)(
    'goes by the target’s FCV, not its release',
    async () => {
      const low = await startMongo()
      const cl = await new MongoClient(`mongodb://127.0.0.1:${low.port}`).connect()
      try {
        const [m, n] = release.split('.').map(Number) as [number, number]
        const lowest = n === 0 ? `${m - 1}.0` : `${m}.0`
        const set = { setFeatureCompatibilityVersion: lowest }
        // 7.0 on asks for confirm; 6.0 does not know it. Just started, a server may still be building
        // its own indexes, which holds a transition back for a moment.
        const lower = async (tries = 50): Promise<unknown> =>
          cl
            .db('admin')
            .command({ ...set, confirm: true })
            .catch(async (e: Error) => {
              if (/index build is in progress/.test(e.message) && tries > 0) {
                await new Promise((r) => setTimeout(r, 200))
                return lower(tries - 1)
              }
              if (!/confirm/.test(e.message)) throw e
              return cl.db('admin').command(set)
            })
        await lower()
        expect(await serverLevel(cl)).toEqual({
          fcv: lowest.split('.').map(Number),
          release: [m, n],
        })
        const h = await backupHarness(a, low, { backup: { toolsPath: dirname(tools!.dump) } } as never)
        try {
          const { plan } = restoring(h)
          // From the target's own release: still more than its feature level takes.
          const file = await archive({ fixedBucketing: true }, { serverVersion: release })
          expect(toolsCheck(await plan(file, { engine: 'tools', mapping: series }))).toMatchObject({
            level: 'block',
            params: { reason: 'newer_options', fields: 'fixedBucketing' },
          })
          // Review of 69adc29a (M-4): 8.3's 2dsphere 4 too, where the release takes it but the FCV not.
          const geoFile = await archive(
            {},
            {
              serverVersion: release,
              geoIndexes: [
                { v: 2, key: { loc: '2dsphere' }, name: 'loc_2dsphere', '2dsphereIndexVersion': 4 },
              ],
            },
          )
          expect(toolsCheck(await plan(geoFile, { engine: 'tools', mapping: geo }))).toMatchObject({
            level: 'block',
            params: { reason: 'newer_options', fields: '2dsphereIndexVersion 4' },
          })
        } finally {
          await h.t.close()
        }
      } finally {
        await cl.close()
        await low.stop()
      }
    },
    120_000,
  )

  // MongoDB 6.0 has no bucketRoundingSeconds, and refuses the bucketMaxSpanSeconds it goes with.
  it.runIf(atLeast(RUN, 6, 3))(
    'skips, saying why, a series whose own bucketing a 6.0 target cannot have',
    async () => {
      const six = await startMongo({ version: '6.0.29' })
      try {
        await ca.db('own').dropDatabase()
        await ca.db('own').createCollection('b', {
          timeseries: { timeField: 't', bucketMaxSpanSeconds: 600, bucketRoundingSeconds: 600 },
        })
        await ca
          .db('own')
          .collection('b')
          .insertOne({ t: new Date(0) })
        const h = await backupHarness(
          a,
          six,
          tools ? ({ backup: { toolsPath: dirname(tools.dump) } } as never) : {},
        )
        try {
          const u = h.user({ role: 'admin' })
          const body = { scope: { kind: 'database', db: 'own' }, format: 'gzip' }
          const dump = `/api/connections/${h.ids.A}/backup`
          const p = (await u.call('POST', `${dump}/plan`, body)).json()
          const res = await u.call('POST', dump, { ...body, planHash: p.planHash })
          const job = await waitJob(h.t, res.json().job.id, 60_000)
          expect(job.state, job.error ?? '').toBe('done')
          const backupId = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId as string
          const mapping = [{ from: { db: 'own', coll: 'b' }, to: { db: 'own2', coll: 'b' } }]
          const restore = `/api/connections/${h.ids.B}/restore/plan`
          const builtIn = (
            await u.call('POST', restore, { source: { kind: 'backup', backupId }, mapping })
          ).json()
          expect(JSON.stringify(builtIn)).toContain(
            'Its own bucketing (bucketRoundingSeconds) needs MongoDB 6.3 or later on the target',
          )
          if (tools) {
            const byTools = (
              await u.call('POST', restore, {
                source: { kind: 'backup', backupId },
                mapping,
                engine: 'tools',
              })
            ).json()
            // Skipped there too: mongorestore is given only the namespaces that go.
            expect(JSON.stringify(byTools)).toContain(
              'Its own bucketing (bucketRoundingSeconds) needs MongoDB 6.3 or later on the target',
            )
          }
        } finally {
          await h.t.close()
        }
      } finally {
        await six.stop()
      }
    },
    180_000,
  )

  // Review of db45c424 (M-4): a series' own fixedBucketing false is kept where the target takes it.
  it.runIf(atLeast(RUN, 9, 0))(
    'keeps a series’ fixedBucketing false into a target that takes it',
    async () => {
      await ca.db('fb').dropDatabase()
      await ca.db('fb').createCollection('s', {
        timeseries: { timeField: 't', bucketMaxSpanSeconds: 600, bucketRoundingSeconds: 600 },
      })
      await ca
        .db('fb')
        .collection('s')
        .insertOne({ t: new Date(0) })
      await ca
        .db('fb')
        .command({ collMod: 's', timeseries: { bucketMaxSpanSeconds: 1200, bucketRoundingSeconds: 1200 } })
      const [source] = await ca.db('fb').listCollections({ name: 's' }).toArray()
      const h = await backupHarness(a, b)
      try {
        const u = h.user({ role: 'admin' })
        const body = { scope: { kind: 'database', db: 'fb' }, format: 'gzip' }
        const dump = `/api/connections/${h.ids.A}/backup`
        const p = (await u.call('POST', `${dump}/plan`, body)).json()
        const job = await waitJob(
          h.t,
          (await u.call('POST', dump, { ...body, planHash: p.planHash })).json().job.id,
          60_000,
        )
        expect(job.state, job.error ?? '').toBe('done')
        const backupId = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json().backupId as string
        await cb.db('fb2').dropDatabase()
        const mapping = [{ from: { db: 'fb', coll: 's' }, to: { db: 'fb2', coll: 's' } }]
        const restore = `/api/connections/${h.ids.B}/restore`
        const pl = (
          await u.call('POST', `${restore}/plan`, { source: { kind: 'backup', backupId }, mapping })
        ).json()
        const r = await u.call('POST', restore, {
          source: { kind: 'backup', backupId },
          mapping,
          planHash: pl.planHash,
        })
        expect((await waitJob(h.t, r.json().job.id, 60_000)).state).toBe('done')
        const [target] = await cb.db('fb2').listCollections({ name: 's' }).toArray()
        expect((target as Document).options.timeseries.fixedBucketing).toBe(
          (source as Document).options.timeseries.fixedBucketing,
        )
      } finally {
        await h.t.close()
      }
    },
    180_000,
  )
})
