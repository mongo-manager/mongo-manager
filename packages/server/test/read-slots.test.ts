import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Collection } from 'mongodb'
import { connect } from 'node:net'
import { H } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'

/**
 * Security audit 2026-10-16 (Important 2): every heavy read takes one of its user's read slots for
 * its whole life, as find and run do: a user cannot start more of them at once than the slots allow,
 * whatever the request rate.
 */
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const harnesses: DataHarness[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of harnesses.splice(0)) await h.t.close()
})

async function seeded() {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  const db = `d${randomUUID().slice(0, 8)}`
  await (
    await h.client()
  )
    .db(db)
    .collection('items')
    .insertMany(Array.from({ length: 5 }, (_, n) => ({ _id: n, n })) as never)
  return { h, base: `/databases/${db}/collections/items` }
}

const heavy = [
  { name: 'aggregate count', slots: 'aggregation', path: 'aggregate/count', body: { stages: [] } },
  { name: 'explain', slots: 'aggregation', path: 'explain', body: { kind: 'find', filter: {} } },
  {
    name: 'validation test',
    slots: 'aggregation',
    path: 'validation/test',
    body: { validator: { n: { $exists: true } } },
  },
  { name: 'count', slots: 'documents', path: 'count', body: { filter: { n: { $gte: 0 } } } },
  { name: 'document by id', slots: 'documents', path: 'documents/get', body: { _id: { $numberInt: '1' } } },
  { name: 'schema', slots: 'documents', path: 'schema', body: { sampleSize: 100 } },
  {
    name: 'bulk preview',
    slots: 'documents',
    path: 'bulk/preview',
    body: { filter: {}, operation: 'delete' },
  },
] as const

describe('security audit 2026-10-16: heavy reads hold a read slot', () => {
  for (const route of heavy)
    it(`refuses ${route.name} while its user's slots are all held, and frees its own`, async () => {
      const { h, base } = await seeded()
      const { ctx } = h.t.app
      const slots = route.slots === 'aggregation' ? ctx.aggregation.slots : ctx.documents.slots
      const held: Array<() => void> = []
      for (let r = slots.acquire('local'); r; r = slots.acquire('local')) held.push(r)
      const busy = await h.call('POST', `${base}/${route.path}`, route.body)
      expect(busy.statusCode).toBe(429)
      expect(busy.json().details).toMatchObject({ reason: 'reads_busy' })
      // One slot free: the read runs, twice in a row (each gives its slot back when answered).
      held.pop()!()
      for (let i = 0; i < 2; i++) {
        const ok = await h.call('POST', `${base}/${route.path}`, route.body)
        expect(ok.statusCode, ok.body).toBe(200)
      }
      for (const release of held) release()
    })

  // Independent review (I2): a client that leaves while its read is still on its way (connecting,
  // being checked) gave its slot back at once while the read started anyway — so any number ran.
  // The slot is held until the handler is done, and a read whose client left never starts.
  it('holds the slot until the read has really ended, and starts no read for a client gone', async () => {
    const { h, base } = await seeded()
    const { ctx } = h.t.app
    const slots = ctx.documents.slots
    const held: Array<() => void> = []
    for (let i = 0; i < 5; i++) held.push(slots.acquire('local')!)
    const realGet = ctx.manager.getClient.bind(ctx.manager)
    vi.spyOn(ctx.manager, 'getClient').mockImplementation(async (id: string) => {
      await new Promise((r) => setTimeout(r, 600))
      return realGet(id)
    })
    const find = vi.spyOn(Collection.prototype, 'find')
    const address = await h.t.app.listen({ port: 0, host: '127.0.0.1' })
    const socket = connect(Number(new URL(address).port), '127.0.0.1')
    socket.on('error', () => undefined)
    const body = JSON.stringify({ filter: {}, limit: 1 })
    socket.write(
      [
        `POST /api/connections/${h.connectionId}${base}/find HTTP/1.1`,
        `Host: ${H.host}`,
        `Origin: ${H.origin}`,
        `X-CSRF-Token: ${ctx.localCsrfToken}`,
        `Cookie: ${H.cookie}`,
        `X-MM-Local: ${H['x-mm-local']}`,
        'Content-Type: application/json',
        `Content-Length: ${body.length}`,
        '',
        body,
      ].join('\r\n'),
    )
    await new Promise((r) => setTimeout(r, 200))
    socket.destroy()
    await new Promise((r) => setTimeout(r, 150))
    // The client is gone, the read is not over: its slot is still taken.
    expect(slots.acquire('local')).toBeNull()
    await new Promise((r) => setTimeout(r, 900))
    const again = slots.acquire('local')
    expect(again).not.toBeNull()
    again!()
    expect(find).not.toHaveBeenCalled()
    for (const release of held) release()
  })

  it('bounds a document read by id in time (a view would run unbounded)', async () => {
    const { h, base } = await seeded()
    // A find of one (two where a time series' _id may repeat: eighteenth review of explain masking).
    const find = vi.spyOn(Collection.prototype, 'find')
    const res = await h.call('POST', `${base}/documents/get`, { _id: { $numberInt: '1' } })
    expect(res.statusCode).toBe(200)
    expect(find.mock.calls.at(-1)?.[1]).toMatchObject({ maxTimeMS: 30_000, limit: 1 })
  })

  // Security audit 2026-10-16 (minor): a plugin's find (the host sends remember: false for it) runs
  // for 10 s at most, whatever time it asks for; the user's own finds keep theirs.
  it('holds a plugin’s find to 10 seconds, on the server', async () => {
    const { h, base } = await seeded()
    const find = vi.spyOn(Collection.prototype, 'find')
    const timeOf = async (body: object) => {
      const res = await h.call('POST', `${base}/find`, { filter: {}, limit: 1, ...body })
      expect(res.statusCode, res.body).toBe(200)
      return (find.mock.calls.at(-1)?.[1] as { maxTimeMS?: number } | undefined)?.maxTimeMS
    }
    expect(await timeOf({ remember: false, maxTimeMS: 300_000 })).toBe(10_000)
    expect(await timeOf({ remember: false })).toBe(10_000)
    expect(await timeOf({ remember: false, maxTimeMS: 2_000 })).toBe(2_000)
    expect(await timeOf({ maxTimeMS: 300_000 })).toBe(300_000)
  })

  // W1 review (minor 3): the chart view's read is the user's own (their time limit), but not one of
  // their recent queries; a plugin's read stays told apart (remember: false) and capped.
  it('keeps an app read out of the history without holding it to a plugin’s time', async () => {
    const { h, base } = await seeded()
    const find = vi.spyOn(Collection.prototype, 'find')
    const history = () => h.t.app.ctx.history.list({ owner: null, connectionId: h.connectionId, limit: 50 })
    const before = history().length
    const res = await h.call('POST', `${base}/find`, {
      filter: { chart: 1 },
      limit: 1,
      record: false,
      maxTimeMS: 60_000,
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((find.mock.calls.at(-1)?.[1] as { maxTimeMS?: number }).maxTimeMS).toBe(60_000)
    expect(history()).toHaveLength(before)
    // The user's own find is still remembered.
    await h.call('POST', `${base}/find`, { filter: { mine: 1 }, limit: 1 })
    expect(history()).toHaveLength(before + 1)
  })

  it('bounds heavy reads server-wide too, across users', async () => {
    const { h } = await seeded()
    const { slots } = h.t.app.ctx.aggregation
    const held: Array<() => void> = []
    for (let user = 0; user < 100; user++) {
      const release = slots.acquire(`user-${user}`)
      if (!release) break
      held.push(release)
    }
    expect(held.length).toBe(16)
    for (const release of held) release()
  })
})
