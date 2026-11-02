import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Decimal128, Double, Long, ObjectId, UUID } from 'bson'
import { deserializeValue, serializeValue, toWire } from '@mongo-manager/shared'
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
  for (const h of harnesses.splice(0)) await h.t.close()
})
async function harness() {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  return h
}

async function seeded() {
  const h = await harness()
  const db = `d${randomUUID().slice(0, 8)}`
  const coll = (await h.client()).db(db).collection('items')
  const typed = {
    _id: new ObjectId('65f0a1b2c3d4e5f601234567'),
    d: new Double(1),
    l: Long.fromString('9007199254740993'),
    m: Decimal128.fromString('1.10'),
    u: new UUID('0f8fad5b-d9cb-469f-a165-70867728950e'),
    at: new Date('2024-01-02T03:04:05.006Z'),
  }
  await coll.insertMany([
    typed,
    ...Array.from({ length: 30 }, (_, i) => ({ n: i, tag: i % 2 ? 'odd' : 'even' })),
  ])
  return { h, db, base: `/databases/${db}/collections/items`, typed }
}

describe('find', () => {
  it('returns documents without type loss (Review Focus 4)', async () => {
    const { h, base, typed } = await seeded()
    const res = await h.call('POST', `${base}/find`, { filter: serializeValue({ _id: typed._id }) })
    expect(res.statusCode).toBe(200)
    const [item] = res.json().documents
    expect(toWire(deserializeValue(item.document))).toBe(toWire(typed))
  })

  it('applies filter, projection, sort, skip and limit and reports hasMore', async () => {
    const { h, base } = await seeded()
    const page = (
      await h.call('POST', `${base}/find`, {
        filter: { tag: 'even' },
        projection: { _id: { $numberInt: '0' }, n: { $numberInt: '1' } },
        sort: { n: { $numberInt: '-1' } },
        skip: 2,
        limit: 3,
      })
    ).json()
    expect(
      page.documents.map((d: { document: { n: { $numberInt: string } } }) => Number(d.document.n.$numberInt)),
    ).toEqual([24, 22, 20])
    expect(page.hasMore).toBe(true)
    const last = (
      await h.call('POST', `${base}/find`, { filter: { tag: 'even' }, skip: 14, limit: 5 })
    ).json()
    expect([last.documents.length, last.hasMore]).toEqual([1, false])
  })

  // Security review 2026-10-13 (M3): a page is read with a byte cap, never 1001 documents of any
  // size; and a user has a few finds at once, not as many as the rate allows.
  it('refuses a page past its byte cap, and more finds at once than a user may run', async () => {
    const h = await dataHarness(mongo, {}, { documents: { maxPageBytes: 4096 } })
    harnesses.push(h)
    const db = `d${randomUUID().slice(0, 8)}`
    await (
      await h.client()
    )
      .db(db)
      .collection('big')
      .insertMany(Array.from({ length: 10 }, (_, n) => ({ n, pad: 'x'.repeat(1000) })))
    const base = `/databases/${db}/collections/big`
    const small = await h.call('POST', `${base}/find`, { filter: {}, limit: 2 })
    expect(small.statusCode).toBe(200)
    const big = await h.call('POST', `${base}/find`, { filter: {}, limit: 4 })
    expect(big.statusCode).toBe(400)
    expect(big.json().details).toMatchObject({ reason: 'page_too_large' })
    // A projection that inflates each document is counted as it comes back.
    const inflated = await h.call('POST', `${base}/find`, {
      filter: {},
      limit: 2,
      projection: { pad: 1, more: { $concat: ['$pad', '$pad', '$pad'] } },
    })
    expect(inflated.statusCode).toBe(400)
    // Round 2 (Minor 5): the document read only to say there is more is not counted.
    const three = await h.call('POST', `${base}/find`, { filter: {}, limit: 3 })
    expect([three.statusCode, three.json().documents.length, three.json().hasMore]).toEqual([200, 3, true])
    const slots = h.t.app.ctx.documents.slots
    const held = Array.from({ length: 6 }, () => slots.acquire('local')!)
    const busy = await h.call('POST', `${base}/find`, { filter: {}, limit: 1 })
    expect(busy.statusCode).toBe(429)
    expect(busy.json().details).toMatchObject({ reason: 'reads_busy' })
    for (const release of held) release()
    expect((await h.call('POST', `${base}/find`, { filter: {}, limit: 1 })).statusCode).toBe(200)
    // Round 2 (I5): the server holds a few reads at once in all, whoever asks.
    const others = Array.from({ length: 32 }, (_, i) => slots.acquire(`user-${i % 8}`))
    expect(others.every((r) => r !== null)).toBe(true)
    expect((await h.call('POST', `${base}/find`, { filter: {}, limit: 1 })).statusCode).toBe(429)
    for (const release of others) release!()
    expect((await h.call('POST', `${base}/find`, { filter: {}, limit: 1 })).statusCode).toBe(200)
  })

  it('refuses server-side JavaScript and reports bad filters as 400', async () => {
    const { h, base } = await seeded()
    expect((await h.call('POST', `${base}/find`, { filter: { $where: 'sleep(1000)' } })).statusCode).toBe(400)
    // Security review 2026-10-16 (I-1): MongoDB's internal JavaScript operators too.
    const emit = { $_internalJsEmit: { eval: 'function () { emit(1, 1) }', this: '$$ROOT' } }
    const refused = await h.call('POST', `${base}/find`, { filter: { $expr: emit } })
    expect(refused.statusCode).toBe(400)
    // Review 2026-10-16 (minor): it names the setting there is, not a flag that does not exist.
    expect(refused.json().message).toMatch(/MM_ALLOW_SERVER_JS/)
    const bad = await h.call('POST', `${base}/find`, { filter: { n: { $bogus: 1 } } })
    expect([bad.statusCode, bad.json().code]).toEqual([400, 'MONGO_ERROR'])
  })
})

describe('count', () => {
  it('counts exactly with a filter and estimates without one', async () => {
    const { h, base } = await seeded()
    expect((await h.call('POST', `${base}/count`, { filter: { tag: 'odd' } })).json()).toEqual({
      count: 15,
      exact: true,
    })
    expect((await h.call('POST', `${base}/count`, {})).json()).toEqual({ count: 31, exact: false })
  })

  it('returns null instead of hanging when the count times out', async () => {
    const { h, base } = await seeded()
    const admin = (await h.client()).db('admin')
    await admin.command({ configureFailPoint: 'maxTimeAlwaysTimeOut', mode: { times: 1 } })
    try {
      expect(
        (await h.call('POST', `${base}/count`, { filter: { tag: 'odd' }, maxTimeMS: 200 })).json(),
      ).toEqual({ count: null, exact: false, atLeast: 15 })
    } finally {
      await admin.command({ configureFailPoint: 'maxTimeAlwaysTimeOut', mode: 'off' })
    }
  })
})

describe('get by _id', () => {
  it('fetches by exact _id and 404s otherwise', async () => {
    const { h, base, typed } = await seeded()
    const res = await h.call('POST', `${base}/documents/get`, { _id: serializeValue(typed._id) })
    expect('document' in res.json()).toBe(true)
    expect(
      (await h.call('POST', `${base}/documents/get`, { _id: '65f0a1b2c3d4e5f601234567' })).statusCode,
    ).toBe(404)
  })
})

describe('cancellation (Review Focus 5)', () => {
  it('kills the MongoDB operation when the HTTP client disconnects', async () => {
    const { h, base } = await seeded()
    const kill = vi.fn(async () => 1)
    h.t.app.ctx.ops.kill = kill
    const admin = (await h.client()).db('admin')
    await admin.command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['find'], blockConnection: true, blockTimeMS: 2_000 },
    })
    try {
      await h.t.app.listen({ port: 0, host: '127.0.0.1' })
      const address = h.t.app.server.address() as { port: number }
      const controller = new AbortController()
      const pending = fetch(
        `http://127.0.0.1:${address.port}/api/connections/${h.connectionId}${base}/find`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': h.t.app.ctx.localCsrfToken,
            cookie: H.cookie,
            'x-mm-local': H['x-mm-local'],
          },
          body: JSON.stringify({ filter: {} }),
          signal: controller.signal,
        },
      ).catch(() => 'aborted')
      await new Promise((r) => setTimeout(r, 300))
      controller.abort()
      expect(await pending).toBe('aborted')
      await vi.waitFor(
        () => expect(kill).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^mm:/)),
        { timeout: 3_000 },
      )
    } finally {
      await admin.command({ configureFailPoint: 'failCommand', mode: 'off' })
    }
  })
})

describe('collation applies to the count too (phase 1g-1)', () => {
  it('counts what a case-insensitive find returns', async () => {
    const h = await harness()
    const db = `d${randomUUID().slice(0, 8)}`
    await (
      await h.client()
    )
      .db(db)
      .collection('people')
      .insertMany([{ name: 'Ada' }, { name: 'ADA' }, { name: 'Bob' }])
    const base = `/databases/${db}/collections/people`
    const collation = { locale: 'en', strength: { $numberInt: '2' } }
    const found = await h.call('POST', `${base}/find`, { filter: { name: 'ada' }, collation })
    expect(found.json().documents).toHaveLength(2)
    const counted = await h.call('POST', `${base}/count`, { filter: { name: 'ada' }, collation })
    expect(counted.statusCode).toBe(200)
    expect(counted.json()).toEqual({ count: 2, exact: true })
  })
})

describe('the count uses the hint too (final review Minor 7)', () => {
  it('counts through the hinted index, as the find does', async () => {
    const h = await harness()
    const db = `d${randomUUID().slice(0, 8)}`
    const coll = (await h.client()).db(db).collection('people')
    await coll.insertMany([{ name: 'Ada', tag: 1 }, { name: 'Bob' }])
    await coll.createIndex({ tag: 1 }, { sparse: true })
    const base = `/databases/${db}/collections/people`
    const body = { filter: { name: { $exists: true } }, hint: 'tag_1' }
    const found = await h.call('POST', `${base}/find`, body)
    const counted = await h.call('POST', `${base}/count`, body)
    expect(counted.json().count).toBe(found.json().documents.length)
    expect(
      (await h.call('POST', `${base}/count`, { ...body, hint: 'missing_1' })).statusCode,
    ).toBeGreaterThanOrEqual(400)
  })
})
