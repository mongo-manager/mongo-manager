import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const harnesses: DataHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.t.close()
})
async function setup() {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  const db = `d${randomUUID().slice(0, 8)}`
  const coll = (await h.client()).db(db).collection('items')
  await coll.insertMany(Array.from({ length: 10 }, (_, i) => ({ n: i, tag: i < 4 ? 'old' : 'new' })))
  return { h, db, base: `/databases/${db}/collections/items`, coll }
}

describe('bulk delete and update (Review Focus 3)', () => {
  it('executes only the previewed filter', async () => {
    const { h, base, coll } = await setup()
    const request = { filter: { tag: 'old' }, operation: 'delete' }
    const preview = (await h.call('POST', `${base}/bulk/preview`, request)).json()
    expect(preview).toMatchObject({
      matched: 4,
      total: 10,
      requiresConfirmation: false,
      filterHash: expect.any(String),
    })
    const edited = await h.call('POST', `${base}/bulk/execute`, {
      ...request,
      filter: { tag: 'new' },
      filterHash: preview.filterHash,
    })
    expect(edited.statusCode).toBe(409)
    expect(await coll.countDocuments()).toBe(10)
    expect(
      (await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash: preview.filterHash })).json(),
    ).toEqual({ deleted: 4 })
    expect(await coll.countDocuments()).toBe(6)
  })

  it('requires typing the collection name for an empty filter', async () => {
    const { h, base, coll } = await setup()
    const request = { filter: {}, operation: 'update', update: { $set: { touched: true } } }
    const { filterHash } = (await h.call('POST', `${base}/bulk/preview`, request)).json()
    expect((await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash })).statusCode).toBe(400)
    expect(
      (await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash, confirm: 'wrong' })).statusCode,
    ).toBe(400)
    expect(
      (await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash, confirm: 'items' })).json(),
    ).toEqual({ matched: 10, modified: 10 })
    expect(await coll.countDocuments({ touched: true })).toBe(10)
  })

  it('supports field operations as update pipelines and refuses replacements and server JS', async () => {
    const { h, base, coll } = await setup()
    const rename = {
      filter: { tag: 'new' },
      operation: 'update',
      update: [{ $set: { label: '$tag' } }, { $unset: 'tag' }],
    }
    const { filterHash } = (await h.call('POST', `${base}/bulk/preview`, rename)).json()
    expect((await h.call('POST', `${base}/bulk/execute`, { ...rename, filterHash })).json()).toEqual({
      matched: 6,
      modified: 6,
    })
    expect(await coll.countDocuments({ label: 'new', tag: { $exists: false } })).toBe(6)
    expect(
      (await h.call('POST', `${base}/bulk/preview`, { filter: {}, operation: 'update', update: { a: 1 } }))
        .statusCode,
    ).toBe(400)
    expect(
      (await h.call('POST', `${base}/bulk/preview`, { filter: { $where: '1' }, operation: 'delete' }))
        .statusCode,
    ).toBe(400)
  })

  it('is refused on read-only connections', async () => {
    const { h, base } = await setup()
    const request = { filter: { tag: 'old' }, operation: 'delete' }
    const { filterHash } = (await h.call('POST', `${base}/bulk/preview`, request)).json()
    h.t.app.ctx.connections.update(h.connectionId, { readOnly: true })
    expect((await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash })).json().code).toBe(
      'READ_ONLY',
    )
  })
})

describe('duplicate collection', () => {
  // The copy itself, its race with a target created meanwhile and its cancellation: jobs-kinds.test.ts.
  it('starts a background copy and refuses an existing target', async () => {
    const { h, db, base } = await setup()
    const res = await h.call('POST', `${base}/duplicate`, { to: 'items_copy' })
    expect(res.statusCode).toBe(202)
    const id = res.json().job.id as string
    for (let i = 0; i < 200 && h.t.app.ctx.jobs.get(id)?.state === 'running'; i++)
      await new Promise((r) => setTimeout(r, 25))
    expect(h.t.app.ctx.jobs.get(id)?.state).toBe('done')
    expect(await (await h.client()).db(db).collection('items_copy').countDocuments()).toBe(10)
    expect((await h.call('POST', `${base}/duplicate`, { to: 'items_copy' })).statusCode).toBe(409)
  })
})
