import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Collection, type MongoClient } from 'mongodb'
import { parseMongoVersion, type ValidationState, type ValidationTestResult } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness, type DataHarness } from './support/data'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<{ t: { close(): Promise<void> } }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of closers.splice(0)) await h.t.close()
})

async function local(): Promise<DataHarness> {
  const h = await dataHarness(mongo)
  closers.push(h)
  return h
}

/** 10 documents: 3 have a string n. */
async function seed(h: { client(): Promise<MongoClient> }) {
  const db = `d${randomUUID().slice(0, 8)}`
  const client = await h.client()
  await client
    .db(db)
    .collection('items')
    .insertMany(Array.from({ length: 10 }, (_, i) => ({ i, n: i < 3 ? 'x' : i })))
  return { db, client, path: `/databases/${db}/collections/items/validation` }
}

const numberN = {
  $jsonSchema: { bsonType: 'object', required: ['n'], properties: { n: { bsonType: 'number' } } },
}

describe('validation rules (phase 2b spec §2.2)', () => {
  it('reads a collection with no rules, and a view', async () => {
    const h = await local()
    const { path, client, db } = await seed(h)
    const state = (await h.call('GET', path)).json() as ValidationState
    expect(state).toMatchObject({
      validator: null,
      validationLevel: 'strict',
      validationAction: 'error',
      kind: 'collection',
    })
    expect(state.serverVersion).toMatch(/^\d+\.\d+/)
    await client.db(db).createCollection('v', { viewOn: 'items', pipeline: [] })
    expect((await h.call('GET', `/databases/${db}/collections/v/validation`)).json()).toMatchObject({
      kind: 'view',
    })
  })

  it('sets rules MongoDB then enforces, and removes them with null (Review Focus 3)', async () => {
    const h = await local()
    const { path, client, db } = await seed(h)
    const res = await h.call('PUT', path, {
      validator: numberN,
      validationLevel: 'moderate',
      validationAction: 'error',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      validationLevel: 'moderate',
      validator: { $jsonSchema: expect.any(Object) },
    })
    await expect(client.db(db).collection('items').insertOne({ n: 'no' })).rejects.toThrow(/validation/i)
    const removed = await h.call('PUT', path, {
      validator: null,
      validationLevel: 'strict',
      validationAction: 'warn',
    })
    expect(removed.json()).toMatchObject({ validator: null, validationAction: 'warn' })
    await client.db(db).collection('items').insertOne({ n: 'fine now' })
  })

  it('offers errorAndLog only from MongoDB 8.1', async () => {
    const h = await local()
    const { path } = await seed(h)
    const { serverVersion } = (await h.call('GET', path)).json() as ValidationState
    const v = parseMongoVersion(serverVersion)!
    const res = await h.call('PUT', path, {
      validator: numberN,
      validationLevel: 'strict',
      validationAction: 'errorAndLog',
    })
    if (v.major > 8 || (v.major === 8 && v.minor >= 1)) expect(res.statusCode, res.body).toBe(200)
    else expect([res.statusCode, res.json().message]).toEqual([400, expect.stringContaining('8.1')])
  })

  it('audits the level and action, never the rules', async () => {
    const h = await local()
    const { path } = await seed(h)
    await h.call('PUT', path, {
      validator: { secret: { $in: ['4111-1111'] } },
      validationLevel: 'strict',
      validationAction: 'warn',
    })
    const [row] = h.t.app.ctx.audit.list({ limit: 5 }).filter((r) => r.action === 'collections.validation')
    expect(row!.details).toMatchObject({ level: 'strict', action: 'warn' })
    // The value, whole: a short number alone may turn up in the row's random ids.
    expect(JSON.stringify(row)).not.toContain('4111-1111')
  })

  it('refuses a read-only connection, a viewer, a system collection, server JavaScript and huge rules', async () => {
    const h = await teamHarness(mongo, {}, { readOnly: true })
    closers.push(h)
    const { path } = await seed(h)
    const body = { validator: numberN, validationLevel: 'strict', validationAction: 'error' }
    expect((await h.user('editor').call('PUT', path, body)).json().code).toBe('READ_ONLY')
    const rw = await teamHarness(mongo)
    closers.push(rw)
    const { path: p2, db } = await seed(rw)
    const editor = rw.user('editor')
    expect((await rw.user('viewer').call('PUT', p2, body)).statusCode).toBe(403)
    expect(
      (await editor.call('PUT', `/databases/${db}/collections/system.js/validation`, body)).statusCode,
    ).toBe(403)
    expect((await editor.call('PUT', p2, { ...body, validator: { $where: 'true' } })).statusCode).toBe(400)
    const huge = { $jsonSchema: { description: 'x'.repeat(300 * 1024) } }
    expect((await editor.call('PUT', p2, { ...body, validator: huge })).statusCode).toBe(400)
  })
})

describe('testing rules against existing documents (phase 2b spec §2.2)', () => {
  it('counts the documents that would fail, with a sample', async () => {
    const h = await local()
    const { path } = await seed(h)
    const res = (await h.call('POST', `${path}/test`, { validator: numberN })).json() as ValidationTestResult
    expect(res).toMatchObject({ total: 10, failing: 3 })
    expect(res.sample).toHaveLength(3)
  })

  it('gives a lower bound when the count takes too long (Review Focus 4)', async () => {
    const h = await local()
    const { path } = await seed(h)
    const original = Collection.prototype.countDocuments
    vi.spyOn(Collection.prototype, 'countDocuments').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      const options = args[1] as { limit?: number } | undefined
      if (!options?.limit)
        return Promise.reject(Object.assign(new Error('operation exceeded time limit'), { code: 50 }))
      return (original as (...a: unknown[]) => Promise<number>).apply(this, args)
    } as typeof original)
    const res = (await h.call('POST', `${path}/test`, { validator: numberN })).json() as ValidationTestResult
    expect(res).toMatchObject({ failing: null, failingAtLeast: 3 })
  })

  it('tags the count with the request comment and a time limit', async () => {
    const h = await local()
    const { path } = await seed(h)
    const original = Collection.prototype.countDocuments
    const options: unknown[] = []
    vi.spyOn(Collection.prototype, 'countDocuments').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      options.push(args[1])
      return (original as (...a: unknown[]) => Promise<number>).apply(this, args)
    } as typeof original)
    await h.call('POST', `${path}/test`, { validator: numberN, maxTimeMS: 4000 })
    // What is left of the request's budget (final review 2b, I1).
    expect(options[0]).toMatchObject({ comment: expect.stringMatching(/^mm:/) })
    expect((options[0] as { maxTimeMS: number }).maxTimeMS).toBeLessThanOrEqual(4000)
    expect((options[0] as { maxTimeMS: number }).maxTimeMS).toBeGreaterThan(3000)
  })
})

describe('validation fixes (final review 2b)', () => {
  it('keeps the whole test within its time limit, and answers "unknown" rather than failing (I1)', async () => {
    const h = await local()
    const { path } = await seed(h)
    const limits: number[] = []
    const timeLimit = () =>
      Promise.reject(Object.assign(new Error('operation exceeded time limit'), { code: 50 }))
    vi.spyOn(Collection.prototype, 'countDocuments').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      limits.push((args[1] as { maxTimeMS: number }).maxTimeMS)
      return timeLimit()
    } as never)
    const find = Collection.prototype.find
    vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      limits.push((args[1] as { maxTimeMS: number }).maxTimeMS)
      const cursor = (find as (...a: unknown[]) => { toArray(): Promise<unknown[]> }).apply(this, args)
      cursor.toArray = () => timeLimit() as never
      return cursor
    } as never)
    const res = await h.call('POST', `${path}/test`, { validator: numberN, maxTimeMS: 3000 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ failing: null, sample: [] })
    expect(res.json().failingAtLeast).toBeUndefined()
    // One budget for the whole request: each call gets what is left, never the full limit again.
    expect(limits.length).toBe(3)
    expect(limits.every((ms) => ms <= 3000)).toBe(true)
    expect(limits.slice(1).every((ms, i) => ms <= limits[i]!)).toBe(true)
  })

  it('refuses rules changed by someone else since they were read, and answers the rules it replaced (I3)', async () => {
    const h = await local()
    const { path } = await seed(h)
    const first = (await h.call('GET', path)).json() as ValidationState & { version: string }
    const set = (validator: object | null, expected?: string) =>
      h.call('PUT', path, {
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
        ...(expected ? { expected } : {}),
      })
    const mine = await set(numberN, first.version)
    expect(mine.statusCode, mine.body).toBe(200)
    expect(mine.json().previous).toMatchObject({
      validator: null,
      validationLevel: 'strict',
      validationAction: 'error',
    })
    const stale = await set({ other: 1 }, first.version)
    expect([stale.statusCode, stale.json().details?.reason]).toEqual([409, 'rules_changed'])
  })

  it('measures the size of the rules in bytes, and bounds the tested rules too (M2)', async () => {
    const h = await local()
    const { path } = await seed(h)
    const wide = { $jsonSchema: { description: 'ğ'.repeat(140 * 1024) } }
    const body = { validator: wide, validationLevel: 'strict', validationAction: 'error' }
    expect((await h.call('PUT', path, body)).statusCode).toBe(400)
    expect((await h.call('POST', `${path}/test`, { validator: wide })).statusCode).toBe(400)
  })

  it('bounds the size of the failing sample (M12)', async () => {
    const h = await local()
    const { path, client, db } = await seed(h)
    await client
      .db(db)
      .collection('items')
      .insertMany(Array.from({ length: 5 }, () => ({ n: 'x', pad: 'p'.repeat(2_000_000) })))
    const res = (
      await h.call('POST', `${path}/test`, { validator: numberN })
    ).json() as ValidationTestResult & {
      sampleTruncated?: boolean
    }
    expect(res.sample.length).toBeLessThan(8)
    expect(res.sampleTruncated).toBe(true)
  })
})
