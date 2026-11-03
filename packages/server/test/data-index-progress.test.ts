import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo({ args: ['--setParameter', 'enableTestCommands=1'] })
})
afterAll(async () => {
  await mongo?.stop()
})
const harnesses: DataHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.t.close()
})

describe('index build progress (phase 1g-2, Review Focus 2)', () => {
  it('reports a running build of this collection only, as numbers and a message', async () => {
    const h = await dataHarness(mongo)
    harnesses.push(h)
    const client = await h.client()
    const db = `d${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('items')
      .insertMany(Array.from({ length: 500 }, (_, i) => ({ n: i })))
    await client.db(db).collection('other').insertOne({ n: 1 })
    const admin = client.db('admin')
    await admin.command({ configureFailPoint: 'hangAfterStartingIndexBuild', mode: 'alwaysOn' })
    const creating = h.call('POST', `/databases/${db}/collections/items/indexes`, { key: { n: 1 } })
    try {
      let builds: Array<Record<string, unknown>> = []
      for (let i = 0; i < 100 && builds.length === 0; i++) {
        const res = await h.call('GET', `/databases/${db}/collections/items/indexes/progress`)
        expect(res.statusCode).toBe(200)
        builds = res.json().builds
        if (builds.length === 0) await new Promise((r) => setTimeout(r, 100))
      }
      expect(builds.length).toBeGreaterThan(0)
      for (const b of builds) {
        expect(Object.keys(b).sort()).toEqual(['done', 'message', 'total'])
        expect(typeof b.message).toBe('string')
      }
      const other = await h.call('GET', `/databases/${db}/collections/other/indexes/progress`)
      expect(other.json()).toEqual({ builds: [] })
    } finally {
      await admin.command({ configureFailPoint: 'hangAfterStartingIndexBuild', mode: 'off' })
    }
    expect((await creating).statusCode).toBe(202)
    await waitFor(h, db, 'items', (jobs) => jobs.every((j) => j.state !== 'running'))
    const done = await h.call('GET', `/databases/${db}/collections/items/indexes/progress`)
    expect(done.json()).toEqual({ builds: [] })
  })

  it('reports the numbers of a build scanning the collection, once per build (phase 1h)', async () => {
    const h = await dataHarness(mongo)
    harnesses.push(h)
    const client = await h.client()
    const db = `d${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('items')
      .insertMany(Array.from({ length: 200 }, (_, n) => ({ n })))
    const admin = client.db('admin')
    const failpoint = 'hangIndexBuildDuringCollectionScanPhaseBeforeInsertion'
    await admin.command({
      configureFailPoint: failpoint,
      mode: 'alwaysOn',
      data: { fieldsToMatch: { n: 100 } },
    })
    try {
      await h.call('POST', `/databases/${db}/collections/items/indexes`, { key: { n: 1 } })
      let builds: Array<{ done: number | null; total: number | null }> = []
      for (let i = 0; i < 100 && !builds.some((b) => b.total); i++) {
        builds = (await h.call('GET', `/databases/${db}/collections/items/indexes/progress`)).json().builds
        if (!builds.some((b) => b.total)) await new Promise((r) => setTimeout(r, 100))
      }
      expect(builds).toEqual([{ message: expect.stringMatching(/^Index Build/), done: 100, total: 200 }])
    } finally {
      await admin.command({ configureFailPoint: failpoint, mode: 'off' })
    }
  })
})

type Job = { id: string; target: string; state: 'running' | 'done' | 'failed'; error?: string | null }

async function jobs(h: DataHarness, db: string, coll: string): Promise<Job[]> {
  const res = await h.call('GET', `/databases/${db}/collections/${coll}/indexes/jobs`)
  expect(res.statusCode).toBe(200)
  return res.json().jobs
}

async function waitFor(
  h: DataHarness,
  db: string,
  coll: string,
  until: (jobs: Job[]) => boolean,
): Promise<Job[]> {
  for (let i = 0; i < 200; i++) {
    const list = await jobs(h, db, coll)
    if (until(list)) return list
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('jobs did not reach the expected state')
}

describe('index builds run in the background (user request: long builds timed out)', () => {
  it('answers at once and the job finishes with the index in place', async () => {
    const h = await dataHarness(mongo)
    harnesses.push(h)
    const db = `d${randomUUID().slice(0, 8)}`
    await (
      await h.client()
    )
      .db(db)
      .collection('items')
      .insertMany([{ n: 1 }, { n: 2 }])
    const res = await h.call('POST', `/databases/${db}/collections/items/indexes`, { key: { n: 1 } })
    expect(res.statusCode).toBe(202)
    expect(res.json().job).toMatchObject({ target: 'n_1', state: expect.stringMatching(/running|done/) })
    const [job] = await waitFor(h, db, 'items', (list) => list[0]?.state === 'done')
    expect(job!.target).toBe('n_1')
    const names = (await (await h.client()).db(db).collection('items').indexes()).map((i) => i.name)
    expect(names).toContain('n_1')
    expect(await jobs(h, db, 'other')).toEqual([])
  })

  it('reports a failed build with its reason', async () => {
    const h = await dataHarness(mongo)
    harnesses.push(h)
    const db = `d${randomUUID().slice(0, 8)}`
    await (
      await h.client()
    )
      .db(db)
      .collection('items')
      .insertMany([{ e: 'a' }, { e: 'a' }])
    const res = await h.call('POST', `/databases/${db}/collections/items/indexes`, {
      key: { e: 1 },
      options: { unique: true },
    })
    expect(res.statusCode).toBe(202)
    const [job] = await waitFor(h, db, 'items', (list) => list[0]?.state === 'failed')
    expect(job!.error).toMatch(/same unique key|duplicate|E11000/i)
  })

  it('runs at most four builds at once per connection', async () => {
    const h = await dataHarness(mongo)
    harnesses.push(h)
    const client = await h.client()
    const db = `d${randomUUID().slice(0, 8)}`
    const admin = client.db('admin')
    await admin.command({ configureFailPoint: 'hangAfterStartingIndexBuild', mode: 'alwaysOn' })
    try {
      for (let i = 0; i < 4; i++) {
        await client.db(db).collection(`c${i}`).insertOne({ n: 1 })
        expect(
          (await h.call('POST', `/databases/${db}/collections/c${i}/indexes`, { key: { n: 1 } })).statusCode,
        ).toBe(202)
      }
      const fifth = await h.call('POST', `/databases/${db}/collections/c9/indexes`, { key: { n: 1 } })
      expect(fifth.statusCode).toBe(409)
      expect(fifth.json().message).toMatch(/4 jobs are already running on this connection/)
    } finally {
      await admin.command({ configureFailPoint: 'hangAfterStartingIndexBuild', mode: 'off' })
    }
    for (let i = 0; i < 4; i++) await waitFor(h, db, `c${i}`, (list) => list[0]?.state === 'done')
  })
})

describe('progress polling without the right to see all operations (final review Minor 7)', () => {
  it('asks for all operations once per connection, then only for its own', async () => {
    const h = await dataHarness(mongo)
    harnesses.push(h)
    const admin = (await h.client()).db('admin')
    const proto = Object.getPrototypeOf(admin) as { aggregate: (...a: unknown[]) => unknown }
    const original = proto.aggregate
    let allUsersAsked = 0
    const spy = vi.spyOn(proto, 'aggregate').mockImplementation(function (this: unknown, ...args: unknown[]) {
      const first = (args[0] as Array<{ $currentOp?: { allUsers?: boolean } }>)[0]
      if (first?.$currentOp?.allUsers) {
        allUsersAsked++
        throw Object.assign(new Error('not authorized on admin to execute command'), { code: 13 })
      }
      return original.apply(this, args)
    })
    try {
      for (let i = 0; i < 3; i++) {
        const res = await h.call('GET', '/databases/x/collections/y/indexes/progress')
        expect(res.json()).toEqual({ builds: [] })
      }
      expect(allUsersAsked).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
