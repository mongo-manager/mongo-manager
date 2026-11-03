import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EJSON } from 'bson'
import { Collection, MongoBulkWriteError, MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { waitJob } from './support/jobs'
import { TargetWriter } from '../src/transfer/target-writer'
import { copyNeeds } from '../src/transfer/copy-access'
import { decideCreate } from '../src/transfer/copy-plan'
import { ordered } from '../src/transfer/merge-join'
import { clip } from '../src/transfer/clip'
import { toView } from '../src/jobs/visibility'
import { slow } from './support/slowness'

/** Phase 3d-2 final review: each finding pinned by a test (sentinel S in every personal value). */
const S = 'S3NT1N3L'
let a: TestMongo
let b: TestMongo
let ca: MongoClient
let cb: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ;[ca, cb] = await Promise.all([
    new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect(),
    new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect(),
  ])
}, slow(180_000))
afterAll(async () => {
  await Promise.all([ca?.close(), cb?.close()])
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  await Promise.all([ca, cb].flatMap((c) => ['shop', 'copy'].map((d) => c.db(d).dropDatabase())))
  await ca
    .db('shop')
    .collection('orders')
    .insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        _id: i as never,
        name: `n${i}`,
        email: `${S}-${i}@x`,
      })),
    )
})
afterEach(() => {
  vi.restoreAllMocks()
})

type H = Awaited<ReturnType<typeof transferHarness>>
type U = ReturnType<H['user']>
const RULES = [{ db: 'shop', coll: 'orders', field: 'email' }]
const at = (h: H, coll: string, id = h.ids.A) => `/api/connections/${id}/databases/shop/collections/${coll}`

async function copy(h: H, u: U, coll: string, body: object) {
  const base = `${at(h, coll)}/copy`
  const plan = await u.call('POST', `${base}/plan`, body)
  if (plan.statusCode !== 200) return { status: plan.statusCode, body: plan.json() }
  const res = await u.call('POST', base, { ...body, planHash: plan.json().planHash })
  if (res.statusCode !== 202) return { status: res.statusCode, body: res.json(), plan: plan.json() }
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  return {
    status: 202,
    job,
    plan: plan.json(),
    report: (await u.get(`/api/transfer/jobs/${job.id}/report`)).json(),
  }
}
async function compare(h: H, u: U, coll: string, target: object, extra: object = {}) {
  const res = await u.call('POST', `${at(h, coll)}/compare`, { target, ...extra })
  if (res.statusCode !== 202) return { status: res.statusCode, body: res.json() }
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  return { status: 202, job, report: (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() }
}
const dump = async (c: MongoClient, db: string, coll: string) =>
  EJSON.stringify(await c.db(db).collection(coll).find().toArray(), { relaxed: false })
const target = (h: H, coll: string, id = h.ids.B) => ({ connectionId: id, db: 'copy', coll })

describe('final review, masking (phase 3d-2)', () => {
  it('C1: a restricted copy of a view or a $lookup pipeline masks what the gate says, not only the name', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', RULES)
      await ca.db('shop').createCollection('v', { viewOn: 'orders', pipeline: [] })
      const u = h.user({ masked: ['A'] })
      const view = await copy(h, u, 'v', {
        source: { kind: 'collection' },
        target: target(h, 'v'),
        mode: 'insert',
        indexes: false,
      })
      expect(view.status, JSON.stringify(view.body ?? '')).toBe(202)
      expect(await dump(cb, 'copy', 'v')).not.toContain(S)
      const lookup = await copy(h, u, 'orders', {
        source: {
          kind: 'pipeline',
          stages: [{ $lookup: { from: 'orders', localField: '_id', foreignField: '_id', as: 'self' } }],
        },
        target: target(h, 'l'),
        mode: 'insert',
        indexes: false,
      })
      if (lookup.status === 202) expect(await dump(cb, 'copy', 'l')).not.toContain(S)
      else expect(lookup.status).toBe(403)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('C1: an unrestricted copy of a view lists the rules of what the view reads', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', RULES)
      await ca.db('shop').createCollection('v', { viewOn: 'orders', pipeline: [] })
      const u = h.user()
      const plan = (
        await u.call('POST', `${at(h, 'v')}/copy/plan`, {
          source: { kind: 'collection' },
          target: target(h, 'v'),
          mode: 'insert',
          indexes: false,
        })
      ).json()
      expect(plan.missingRules).toEqual(['copy.v.email'])
      expect(plan.refusals).toContain('confirm_personal')
    } finally {
      await h.t.close()
    }
  })

  it('C1: compare of a view masks both sides through the view (restricted on the source)', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', RULES)
      await ca.db('shop').createCollection('v', { viewOn: 'orders', pipeline: [] })
      await cb
        .db('copy')
        .collection('v')
        .insertMany(
          Array.from({ length: 30 }, (_, i) => ({
            _id: i as never,
            name: `n${i}`,
            email: i < 5 ? 'guess' : `${S}-${i}@x`,
          })),
        )
      const u = h.user({ masked: ['A'] })
      const r = await compare(h, u, 'v', target(h, 'v'))
      expect(r.status).toBe(202)
      expect(r.report.collections[0]).toMatchObject({ same: 30, different: 0 })
      expect(JSON.stringify(r.report)).not.toContain(S)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('I6: an anonymous copy masks personal values moved by a pipeline', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', RULES)
      const u = h.user()
      const r = await copy(h, u, 'orders', {
        source: { kind: 'pipeline', stages: [{ $set: { c: '$email' } }] },
        target: target(h, 'anon'),
        mode: 'insert',
        indexes: false,
        anonymous: true,
      })
      if (r.status === 202) expect(await dump(cb, 'copy', 'anon')).not.toContain(S)
      else expect(r.status).toBe(403)
    } finally {
      await h.t.close()
    }
    // A copy it lets start (202) waits up to 60 s (review of the series limit, minor).
  }, 90_000)

  it('C2: a personal _id refuses compare and masked copies for a restricted caller', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('B', [{ db: 'copy', coll: 'orders', field: '_id' }])
      await cb
        .db('copy')
        .collection('orders')
        .insertOne({ _id: `${S}-hidden` as never })
      const u = h.user({ masked: ['B'] })
      const r = await compare(h, u, 'orders', target(h, 'orders'))
      expect(r.status).toBe(403)
      h.rules('A', [{ db: 'shop', coll: 'orders', field: '_id' }])
      const ua = h.user({ masked: ['A'] })
      const c = await copy(h, ua, 'orders', {
        source: { kind: 'collection' },
        target: target(h, 'x'),
        mode: 'insert',
        indexes: false,
      })
      expect(c.status).toBe(409)
      expect(c.body.details.reasons).toContain('personal_id')
    } finally {
      await h.t.close()
    }
  })

  it('C3: a restricted target user cannot build an index or a validator over hidden values', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('B', [{ db: 'copy', coll: '*', field: 'email' }])
      await cb
        .db('copy')
        .collection('orders')
        .insertOne({ _id: 'kept' as never, email: `${S}@x` })
      await ca.db('shop').collection('orders').createIndex({ email: 1 }, { unique: true, name: 'email_u' })
      const u = h.user({ masked: ['B'] })
      const r = await copy(h, u, 'orders', {
        source: { kind: 'query', filter: { _id: { $lt: 0 } } },
        target: target(h, 'orders'),
        mode: 'insert',
        confirmPersonal: true,
      })
      expect(r.status).toBe(202)
      expect(r.report.collections[0].indexes.built).toEqual([])
      expect(r.report.collections[0].indexes.skipped.map((s: { name: string }) => s.name)).toContain(
        'email_u',
      )
      expect((await cb.db('copy').collection('orders').indexes()).map((i) => i.name)).not.toContain('email_u')
      await ca.db('shop').createCollection('val', { validator: { $expr: { $gt: ['$email', ''] } } })
      const v = await copy(h, u, 'val', {
        source: { kind: 'collection' },
        target: target(h, 'val'),
        mode: 'insert',
        indexes: false,
        confirmPersonal: true,
      })
      expect(v.status).toBe(202)
      expect(v.report.collections[0].failure).toBeTruthy()
      expect(await cb.db('copy').listCollections({ name: 'val' }).toArray()).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 180_000)
})

describe('final review, write safety (phase 3d-2)', () => {
  it('C4: a command-level bulk failure fails the job, and replace leaves the target as it was', async () => {
    const h = await transferHarness(a, b)
    try {
      await cb
        .db('copy')
        .collection('orders')
        .insertOne({ _id: 'old' as never })
      const real = Collection.prototype.bulkWrite
      let calls = 0
      vi.spyOn(Collection.prototype, 'bulkWrite').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (++calls === 1)
          return Promise.reject(
            new MongoBulkWriteError(
              { message: 'operation exceeded time limit', code: 50, writeErrors: [] } as never,
              {
                insertedCount: 0,
                matchedCount: 0,
                modifiedCount: 0,
                upsertedCount: 0,
                deletedCount: 0,
              } as never,
            ),
          )
        return (real as (...a: unknown[]) => Promise<unknown>).apply(this, args) as never
      } as never)
      const r = await copy(h, h.user(), 'orders', {
        source: { kind: 'collection' },
        target: target(h, 'orders'),
        mode: 'replace',
        indexes: false,
      })
      expect(r.job!.state).toBe('failed')
      expect(await cb.db('copy').collection('orders').find().toArray()).toEqual([{ _id: 'old' }])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('I1: a failing write never becomes an unhandled rejection', async () => {
    const h = await transferHarness(a, b)
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => void unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      await ca
        .db('shop')
        .collection('big')
        .insertMany(Array.from({ length: 2500 }, (_, i) => ({ _id: i as never })))
      vi.spyOn(TargetWriter.prototype, 'write').mockImplementation(() =>
        Promise.reject(new Error('connection lost')),
      )
      const r = await copy(h, h.user(), 'big', {
        source: { kind: 'collection' },
        target: target(h, 'big'),
        mode: 'insert',
        indexes: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(r.job!.state).toBe('failed')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await h.t.close()
    }
  }, 90_000)

  it('I7, M1, M2, M8: an encrypted source is skipped even into an existing target; collection TTL needs confirmation; views need databases:write', () => {
    const want = { options: true, validator: true }
    expect(
      decideCreate(
        { name: 'e', type: 'collection', options: { encryptedFields: {} } },
        true,
        'insert',
        want,
        false,
      ),
    ).toEqual({
      skip: expect.stringMatching(/Queryable Encryption/),
    })
    expect(
      decideCreate({ name: 'c', type: 'collection', options: {} }, true, 'insert', want, false),
    ).toBeNull()
    expect(copyNeeds({ mode: 'insert', indexes: false, createsCollections: false, views: true })).toContain(
      'databases:write',
    )
  })

  it('M1, M2: a collection-level TTL needs confirmation, and the plan hash covers the index plan', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('shop').createCollection('ts', { timeseries: { timeField: 't' }, expireAfterSeconds: 60 })
      const u = h.user()
      const body = { source: { kind: 'collection' }, target: target(h, 'ts'), mode: 'insert', indexes: false }
      const plan = (await u.call('POST', `${at(h, 'ts')}/copy/plan`, body)).json()
      expect(plan.refusals).toContain('confirm_ttl')
      const withIdx = { source: { kind: 'collection' }, target: target(h, 'o'), mode: 'insert' }
      const one = (await u.call('POST', `${at(h, 'orders')}/copy/plan`, withIdx)).json()
      await ca.db('shop').collection('orders').createIndex({ name: 1 })
      const two = (await u.call('POST', `${at(h, 'orders')}/copy/plan`, withIdx)).json()
      expect(two.planHash).not.toBe(one.planHash)
    } finally {
      await h.t.close()
    }
  })

  it('M7: the counts carry the job comment and a time limit', async () => {
    const h = await transferHarness(a, b)
    try {
      const count = vi.spyOn(Collection.prototype, 'estimatedDocumentCount')
      const r = await copy(h, h.user(), 'orders', {
        source: { kind: 'collection' },
        target: target(h, 'counted'),
        mode: 'insert',
        indexes: false,
      })
      expect(r.job!.state).toBe('done')
      const c = await compare(h, h.user(), 'orders', target(h, 'counted'))
      expect(c.job!.state).toBe('done')
      const jobCalls = count.mock.calls.filter(
        ([o]) => typeof (o as { comment?: unknown })?.comment === 'string',
      )
      expect(jobCalls.length).toBeGreaterThanOrEqual(2)
      for (const [o] of jobCalls) expect((o as { maxTimeMS?: number }).maxTimeMS).toBeGreaterThan(0)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('M11: a target with a non-simple default collation forces the full sort', async () => {
    const h = await transferHarness(a, b)
    try {
      await cb.db('copy').createCollection('coll', { collation: { locale: 'tr' } })
      const plan = (
        await h.user().call('POST', `${at(h, 'orders')}/copy/plan`, {
          source: { kind: 'collection' },
          target: target(h, 'coll'),
          mode: 'upsert',
          indexes: false,
        })
      ).json()
      expect(plan.collections[0].fullSort).toBe(true)
    } finally {
      await h.t.close()
    }
  })

  it('M10: duplicate _id values are named as such', async () => {
    async function* docs() {
      yield { _id: 1 }
      yield { _id: 1 }
    }
    await expect(async () => {
      for await (const _ of ordered(docs() as never, 'source')) void _
    }).rejects.toThrow(/duplicate/i)
  })
})

describe('final review, reports, sync and visibility (phase 3d-2)', () => {
  it('I2: reports and rejected files follow both connections, restriction and the rules version', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user()
      const r = await copy(h, u, 'orders', {
        source: { kind: 'collection' },
        target: target(h, 'orders'),
        mode: 'insert',
        indexes: false,
      })
      expect((await u.get(`/api/transfer/jobs/${r.job!.id}/report`)).statusCode).toBe(200)
      h.rules('B', [{ db: 'copy', coll: 'orders', field: 'email' }])
      expect((await u.get(`/api/transfer/jobs/${r.job!.id}/report`)).statusCode).toBe(410)
      const c = await compare(h, u, 'orders', target(h, 'orders'))
      expect((await u.get(`/api/transfer/jobs/${c.job!.id}/report`)).statusCode).toBe(200)
      h.ctx.grants.set(h.ids.A, u.id, 'editor')
      h.ctx.grants.setMasked(h.ids.A, u.id, true)
      expect((await u.get(`/api/transfer/jobs/${c.job!.id}/report`)).statusCode).toBe(410)
      h.ctx.grants.setMasked(h.ids.A, u.id, false)
      expect((await u.get(`/api/transfer/jobs/${c.job!.id}/report`)).statusCode).toBe(200)
      h.ctx.grants.set(h.ids.B, u.id, 'none')
      expect((await u.get(`/api/transfer/jobs/${c.job!.id}/report`)).statusCode).toBe(410)
      expect((await u.get(`/api/jobs/${c.job!.id}`)).statusCode).toBe(404)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('I2: a job error is hidden when the caller is restricted on the target', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ masked: ['B'] })
      const job = {
        id: crypto.randomUUID(),
        kind: 'data.copy' as const,
        userId: u.id,
        connectionId: h.ids.A,
        targetConnectionId: h.ids.B,
        db: 'shop',
        coll: 'orders',
        target: 'copy.orders',
        state: 'failed' as const,
        progress: null,
        estimate: null,
        error: `E11000 dup key ${S}`,
        staging: null,
        stagingConnectionId: null,
        stagingDb: null,
        startedAt: 1,
        finishedAt: 2,
      }
      const principal = { kind: 'user' as const, userId: u.id, username: 'x', role: 'editor' as const }
      expect(toView(h.ctx, principal as never, job).error).not.toContain(S)
    } finally {
      await h.t.close()
    }
  })

  it('I3: compare samples are bounded', async () => {
    const h = await transferHarness(a, b)
    try {
      const wide = (v: string) =>
        Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f${i}`, v.repeat(600)]))
      await ca
        .db('shop')
        .collection('wide')
        .insertMany(Array.from({ length: 60 }, (_, i) => ({ _id: i as never, ...wide('a') })))
      await cb
        .db('copy')
        .collection('wide')
        .insertMany(Array.from({ length: 60 }, (_, i) => ({ _id: i as never, ...wide('b') })))
      const r = await compare(h, h.user(), 'wide', target(h, 'wide'))
      expect(r.report.collections[0].different).toBe(60)
      expect(JSON.stringify(r.report).length).toBeLessThan(2_000_000)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('I4: a clipped EJSON wrapper becomes a placeholder, never a broken value', () => {
    const big = { $binary: { base64: 'A'.repeat(1000), subType: '00' } }
    const out = clip({ b: big }, { left: 20_000 }) as Record<string, unknown>
    expect(typeof out.b).toBe('string')
    expect(clip({ d: { $date: { $numberLong: '1' } } }, { left: 20_000 })).toEqual({
      d: { $date: { $numberLong: '1' } },
    })
  })

  it('I5: a sync to a target without the rules needs the personal-data confirmation', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', RULES)
      const u = h.user()
      const c = await compare(h, u, 'orders', target(h, 'orders'))
      expect(c.report.missingRules).toEqual(['copy.orders.email'])
      const refused = await u.call('POST', '/api/transfer/sync', { compareJobId: c.job!.id })
      expect(refused.statusCode).toBe(409)
      expect(refused.json().details.reason).toBe('confirm_personal')
      const ok = await u.call('POST', '/api/transfer/sync', {
        compareJobId: c.job!.id,
        confirmPersonal: true,
      })
      expect(ok.statusCode).toBe(202)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('I9: a sync refuses an incomplete comparison', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user()
      const kinds = h.ctx.jobKinds as Record<string, { run: (...a: never[]) => Promise<void> }>
      const real = kinds['data.compare']!.run
      kinds['data.compare']!.run = async (...args: never[]) => {
        await real(...args)
        throw new Error('stopped after the report')
      }
      const c = await compare(h, u, 'orders', target(h, 'orders'))
      kinds['data.compare']!.run = real
      expect(c.job!.state).toBe('failed')
      const r = await u.call('POST', '/api/transfer/sync', { compareJobId: c.job!.id })
      expect(r.statusCode).toBe(409)
      expect(r.json().details.reason).toBe('compare_incomplete')
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('M3: adding rules past the limit is refused', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', RULES)
      h.rules(
        'B',
        Array.from({ length: 200 }, (_, i) => ({ db: 'other', coll: `c${i}`, field: 'x' })),
      )
      const admin = h.user({ role: 'admin' })
      const r = await copy(h, admin, 'orders', {
        source: { kind: 'collection' },
        target: target(h, 'orders'),
        mode: 'insert',
        indexes: false,
        addRulesToTarget: true,
      })
      expect(r.status).toBe(409)
      expect(r.body.details.reasons).toContain('too_many_rules')
    } finally {
      await h.t.close()
    }
  })

  it('M4: a view whose source is not copied is reported; chosen views only', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('shop').createCollection('v1', { viewOn: 'orders', pipeline: [] })
      await ca.db('shop').createCollection('view2', { viewOn: 'orders', pipeline: [] })
      await ca.db('shop').collection('other').insertOne({ a: 1 })
      const u = h.user()
      const base = `/api/connections/${h.ids.A}/databases/shop/copy`
      const body = {
        target: { connectionId: h.ids.B, db: 'copy' },
        mode: 'insert',
        indexes: false,
        collections: ['other', 'v1'],
      }
      const plan = (await u.call('POST', `${base}/plan`, body)).json()
      expect(plan.views).toEqual(['v1'])
      const res = await u.call('POST', base, { ...body, planHash: plan.planHash })
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(report.views).toEqual([{ name: 'v1', created: true, reason: expect.stringMatching(/source/) }])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('M9: a sync re-checks server-side JavaScript in the stored filter', async () => {
    const h = await transferHarness(a, b, { allowServerJs: true })
    try {
      const u = h.user()
      const c = await compare(h, u, 'orders', target(h, 'orders'), { filter: { $where: 'true' } })
      expect(c.status).toBe(202)
      ;(h.ctx.config as { allowServerJs: boolean }).allowServerJs = false
      expect((await u.call('POST', '/api/transfer/sync', { compareJobId: c.job!.id })).statusCode).toBe(400)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('M12: Queryable Encryption metadata collections are not copied', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('shop').collection('enxcol_.orders.esc').insertOne({ a: 1 })
      const plan = (
        await h.user().call('POST', `/api/connections/${h.ids.A}/databases/shop/copy/plan`, {
          target: { connectionId: h.ids.B, db: 'copy' },
          mode: 'insert',
          indexes: false,
        })
      ).json()
      expect(plan.collections.map((c: { source: string }) => c.source)).not.toContain('enxcol_.orders.esc')
    } finally {
      await h.t.close()
    }
  })
})
