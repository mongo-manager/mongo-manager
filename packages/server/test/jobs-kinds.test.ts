// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Db } from 'mongodb'
import type { JobView } from '@mongo-manager/shared'
import { JobRepo } from '../src/jobs/repo'
import { duplicateKind } from '../src/jobs/duplicate'
import type { JobRecord } from '../src/jobs/types'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'
import { H } from './helpers'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo({ args: ['--setParameter', 'enableTestCommands=1'] })
})
afterAll(async () => {
  await mongo?.stop()
})
const harnesses: DataHarness[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of harnesses.splice(0)) await h.t.close()
})

async function setup(docs = 10) {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  const client = await h.client()
  const db = `d${randomUUID().slice(0, 8)}`
  if (docs > 0)
    await client
      .db(db)
      .collection('items')
      .insertMany(Array.from({ length: docs }, (_, n) => ({ n })))
  const failpoint = (name: string, mode: 'alwaysOn' | 'off', data?: object) =>
    client.db('admin').command({ configureFailPoint: name, mode, ...(data ? { data } : {}) })
  const cancel = (id: string) =>
    h.t.app.inject({
      method: 'POST',
      url: `/api/jobs/${id}/cancel`,
      headers: { ...H, 'x-csrf-token': h.t.app.ctx.localCsrfToken },
    })
  return { h, client, db, base: `/databases/${db}/collections/items`, failpoint, cancel }
}

async function until(h: DataHarness, id: string, ok: (job: JobRecord) => boolean): Promise<JobRecord> {
  for (let i = 0; i < 300; i++) {
    const job = h.t.app.ctx.jobs.get(id)
    if (job && ok(job)) return job
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`job ${id} is ${h.t.app.ctx.jobs.get(id)?.state}`)
}

const settled = (j: JobRecord) => j.state !== 'running'

/** The real aggregate: some tests below refuse $currentOp to the app, never to the test itself. */
const aggregate = Db.prototype.aggregate

/** Waits until $currentOp shows an operation matching `match`. */
async function seen(client: import('mongodb').MongoClient, match: object) {
  for (let i = 0; i < 200; i++) {
    const ops = await aggregate
      .call(client.db('admin'), [
        { $currentOp: { allUsers: true, idleConnections: false } },
        { $match: match },
      ])
      .toArray()
    if (ops.length > 0) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('operation never appeared')
}

describe('index builds as jobs (phase 1h spec §3)', () => {
  it('answers 202 with the job and ends done with the index in place', async () => {
    const { h, client, db, base } = await setup()
    const res = await h.call('POST', `${base}/indexes`, { key: { n: 1 } })
    expect(res.statusCode).toBe(202)
    const job = res.json().job as JobView
    expect(job).toMatchObject({ kind: 'index.create', target: 'n_1', db, coll: 'items', mine: true })
    expect(await until(h, job.id, settled)).toMatchObject({ state: 'done', error: null })
    expect((await client.db(db).collection('items').indexes()).map((i) => i.name)).toContain('n_1')
  })

  it('ends failed with the reason of a unique build over duplicates', async () => {
    const { h, client, db, base } = await setup(0)
    await client
      .db(db)
      .collection('items')
      .insertMany([{ e: 'a' }, { e: 'a' }])
    const job = (await h.call('POST', `${base}/indexes`, { key: { e: 1 }, options: { unique: true } })).json()
      .job
    const done = await until(h, job.id, settled)
    expect(done.state).toBe('failed')
    expect(done.error).toMatch(/same unique key|duplicate|E11000/i)
  })

  it('reports measured progress while MongoDB scans the collection', async () => {
    const { h, db, base, failpoint } = await setup(200)
    await failpoint('hangIndexBuildDuringCollectionScanPhaseBeforeInsertion', 'alwaysOn', {
      fieldsToMatch: { n: 100 },
    })
    try {
      const changes: JobRecord[] = []
      h.t.app.ctx.jobs.onChange((j) => changes.push(j))
      const job = (await h.call('POST', `${base}/indexes`, { key: { n: 1 } })).json().job
      const measured = await until(h, job.id, (j) => (j.progress?.total ?? 0) > 0)
      expect(measured.progress!.total).toBeGreaterThanOrEqual(200)
      expect(measured.progress!.done).toBeLessThanOrEqual(measured.progress!.total)
      expect(changes.some((c) => c.id === job.id && c.progress !== null)).toBe(true)
      expect(db).toBeTruthy()
    } finally {
      await failpoint('hangIndexBuildDuringCollectionScanPhaseBeforeInsertion', 'off')
    }
  })

  it('cancels a build in progress: the job ends cancelled and the index is not there', async () => {
    const { h, client, db, base, failpoint, cancel } = await setup()
    await failpoint('hangAfterStartingIndexBuild', 'alwaysOn')
    let job: JobView
    try {
      job = (await h.call('POST', `${base}/indexes`, { key: { n: 1 } })).json().job
      await seen(client, { ns: `${db}.items`, 'command.createIndexes': 'items' })
      const res = await cancel(job.id)
      expect(res.statusCode).toBe(200)
      expect(res.json().job.state).toBe('cancelled')
    } finally {
      await failpoint('hangAfterStartingIndexBuild', 'off')
    }
    expect((await client.db(db).collection('items').indexes()).map((i) => i.name)).not.toContain('n_1')
    expect(h.t.app.ctx.jobs.get(job.id)!.state).toBe('cancelled')
  })

  it('never drops a finished index when cancel comes too late (Review Focus 1)', async () => {
    const { h, client, db, base, cancel } = await setup()
    const job = (await h.call('POST', `${base}/indexes`, { key: { n: 1 } })).json().job
    await until(h, job.id, settled)
    const res = await cancel(job.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/already finished/)
    expect((await client.db(db).collection('items').indexes()).map((i) => i.name)).toContain('n_1')
  })
})

/**
 * Cancels a copy held in hangWhileBuildingDocumentSourceOutBatch. MongoDB marks the killed copy
 * killPending at once, but one already paused in that failpoint only notices when the failpoint is
 * released (seen under a loaded parallel run: killPending for 30 s). So: ask to cancel, wait until
 * the copy is killPending or gone, release, then read the answer. A kill that never came leaves it
 * listed without killPending, and the wait fails.
 */
async function cancelHeldCopy(
  client: import('mongodb').MongoClient,
  id: string,
  cancel: (id: string) => ReturnType<DataHarness['call']>,
  failpoint: (name: string, mode: 'alwaysOn' | 'off') => Promise<unknown>,
) {
  const answer = cancel(id)
  try {
    for (let i = 0; ; i++) {
      const ops = await aggregate
        .call(client.db('admin'), [
          { $currentOp: { allUsers: true, idleConnections: false } },
          { $match: { 'command.comment': `mm-job:${id}` } },
        ])
        .toArray()
      if (ops.length === 0 || ops.some((op) => op.killPending === true)) break
      if (i >= 400) throw new Error('the copy was never killed')
      await new Promise((r) => setTimeout(r, 25))
    }
  } finally {
    await failpoint('hangWhileBuildingDocumentSourceOutBatch', 'off')
  }
  return answer
}

describe('duplicating a collection as a job (phase 1h spec §3)', () => {
  const staging = async (client: import('mongodb').MongoClient, db: string) =>
    (await client.db(db).listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => n.startsWith('mm_duplicate_'))

  it('answers 202, then copies every document with the source count as its estimate', async () => {
    const { h, client, db, base } = await setup(25)
    const res = await h.call('POST', `${base}/duplicate`, { to: 'items_copy' })
    expect(res.statusCode).toBe(202)
    const job = res.json().job as JobView
    expect(job).toMatchObject({ kind: 'collection.duplicate', target: 'items_copy', progress: null })
    const done = await until(h, job.id, settled)
    expect(done).toMatchObject({ state: 'done', estimate: 25, progress: null })
    expect(await client.db(db).collection('items_copy').countDocuments()).toBe(25)
    expect(await staging(client, db)).toEqual([])
    // The web never learns the staging name.
    expect(JSON.stringify(res.json())).not.toMatch(/mm_duplicate_/)
  })

  it('refuses a taken name at once, and fails without overwriting a target created meanwhile', async () => {
    const { h, client, db, base } = await setup()
    await client.db(db).collection('taken').insertOne({ mine: true })
    expect((await h.call('POST', `${base}/duplicate`, { to: 'taken' })).statusCode).toBe(409)
    const original = Db.prototype.listCollections
    let raced = false
    vi.spyOn(Db.prototype, 'listCollections').mockImplementation(function (this: Db, ...args) {
      const cursor = original.apply(this, args)
      const toArray = cursor.toArray.bind(cursor)
      cursor.toArray = async () => {
        const found = await toArray()
        const filter = args[0] as { name?: string } | undefined
        // The route's own check passes; the name is taken just before the job looks again.
        if (filter?.name === 'later' && found.length === 0 && !raced) {
          raced = true
          await client.db(db).collection('later').insertOne({ mine: true })
        }
        return found
      }
      return cursor
    })
    const job = (await h.call('POST', `${base}/duplicate`, { to: 'later' })).json().job
    vi.restoreAllMocks()
    const done = await until(h, job.id, settled)
    expect(done.state).toBe('failed')
    expect(done.error).toMatch(/already exists/)
    expect(
      await client
        .db(db)
        .collection('later')
        .find({}, { projection: { _id: 0 } })
        .toArray(),
    ).toEqual([{ mine: true }])
    expect(await staging(client, db)).toEqual([])
  })

  it('cancels a running copy: no staging left and no target made', async () => {
    const { h, client, db, base, failpoint, cancel } = await setup()
    await failpoint('hangWhileBuildingDocumentSourceOutBatch', 'alwaysOn')
    let job: JobView
    try {
      job = (await h.call('POST', `${base}/duplicate`, { to: 'items_copy' })).json().job
      await seen(client, { 'command.comment': `mm-job:${job.id}` })
      const original = Db.prototype.aggregate
      // An account without the inprog privilege: asking for every user's operations is refused.
      vi.spyOn(Db.prototype, 'aggregate').mockImplementation(function (this: Db, pipeline, ...rest) {
        const first = (pipeline as Array<Record<string, { allUsers?: boolean }>>)?.[0]
        if (first?.$currentOp?.allUsers === true)
          throw Object.assign(new Error('not authorized'), { code: 13 })
        return original.call(this, pipeline, ...(rest as []))
      } as typeof original)
      const res = await cancelHeldCopy(client, job.id, cancel, failpoint)
      expect(res.statusCode).toBe(200)
      expect(res.json().job.state).toBe('cancelled')
    } finally {
      await failpoint('hangWhileBuildingDocumentSourceOutBatch', 'off')
    }
    const names = (await client.db(db).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
    expect(names).toEqual(['items'])
  })

  it('never renames the copy into place once a cancel was asked, even if $out ends during the kill (final review I2)', async () => {
    const { h, client, db, failpoint } = await setup()
    await failpoint('hangWhileBuildingDocumentSourceOutBatch', 'alwaysOn')
    // The kill answers only after $out has finished on its own: the race the review found.
    const kind = duplicateKind({
      client: (id) => h.t.app.ctx.manager.getClient(id),
      kill: async () => {
        await failpoint('hangWhileBuildingDocumentSourceOutBatch', 'off')
        await new Promise((r) => setTimeout(r, 500))
        return 1
      },
    })
    const job = h.t.app.ctx.jobs.start(
      kind,
      { userId: null, connectionId: h.connectionId, db, coll: 'items', target: 'items_copy' },
      { to: 'items_copy' },
    )
    try {
      await seen(client, { 'command.comment': `mm-job:${job.id}` })
      await h.t.app.ctx.jobs.cancel(job.id)
    } finally {
      await failpoint('hangWhileBuildingDocumentSourceOutBatch', 'off')
    }
    const done = await until(h, job.id, settled)
    const names = (await client.db(db).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
    expect([done.state, names]).toEqual(['cancelled', ['items']])
  })

  it('kills its own copy when the account may not list other users’ operations (final review I3)', async () => {
    const { h, client, db, base, failpoint, cancel } = await setup()
    await failpoint('hangWhileBuildingDocumentSourceOutBatch', 'alwaysOn')
    let job: JobView
    try {
      job = (await h.call('POST', `${base}/duplicate`, { to: 'items_copy' })).json().job
      await seen(client, { 'command.comment': `mm-job:${job.id}` })
      // From here on, an account without the inprog privilege: every user's operations are refused.
      const original = Db.prototype.aggregate
      vi.spyOn(Db.prototype, 'aggregate').mockImplementation(function (this: Db, pipeline, ...rest) {
        const first = (pipeline as Array<Record<string, { allUsers?: boolean }>>)?.[0]
        if (first?.$currentOp?.allUsers === true)
          throw Object.assign(new Error('not authorized'), { code: 13 })
        return original.call(this, pipeline, ...(rest as []))
      } as typeof original)
      const res = await cancelHeldCopy(client, job.id, cancel, failpoint)
      expect([res.statusCode, res.json().job?.state]).toEqual([200, 'cancelled'])
    } finally {
      await failpoint('hangWhileBuildingDocumentSourceOutBatch', 'off')
    }
    const names = (await client.db(db).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
    expect(names).toEqual(['items'])
  })

  it('never undoes a finished copy when cancel comes too late (Review Focus 1)', async () => {
    const { h, client, db, base, cancel } = await setup()
    const job = (await h.call('POST', `${base}/duplicate`, { to: 'items_copy' })).json().job
    await until(h, job.id, settled)
    expect((await cancel(job.id)).statusCode).toBe(409)
    expect(await client.db(db).collection('items_copy').countDocuments()).toBe(10)
  })
})

describe('jobs left running by a previous process (Review Focus 4)', () => {
  it('marks a copy interrupted and drops its staging when the connection next opens', async () => {
    const { h, client, db } = await setup()
    await client.db(db).collection('mm_duplicate_0123456789abcdef').insertOne({ half: true })
    const repo = new JobRepo(h.t.app.ctx.store.db)
    const base = {
      userId: null,
      connectionId: h.connectionId,
      targetConnectionId: null,
      stagingConnectionId: null,
      stagingDb: null,
      db,
      coll: 'items',
      progress: null,
      estimate: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      state: 'running' as const,
    }
    repo.insert({
      ...base,
      id: randomUUID(),
      kind: 'collection.duplicate',
      target: 'items_copy',
      staging: 'mm_duplicate_0123456789abcdef',
    })
    const index = randomUUID()
    repo.insert({ ...base, id: index, kind: 'index.create', target: 'n_1', staging: null })
    h.t.app.ctx.jobs.recover(h.t.app.ctx.jobKinds)
    const [copy] = h.t.app.ctx.jobs.list({ state: 'interrupted' })
    expect(copy).toMatchObject({ kind: 'collection.duplicate', target: 'items_copy' })
    expect(h.t.app.ctx.jobs.get(index)!.state).toBe('unknown')
    await h.t.app.ctx.manager.invalidate(h.connectionId)
    const reopened = await h.client()
    const names = (await reopened.db(db).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
    expect(names).toEqual(['items'])
    expect(h.t.app.ctx.jobs.get(copy!.id)!.staging).toBeNull()
  })
})
