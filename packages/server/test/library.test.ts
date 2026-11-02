import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { LibraryItem } from '@mongo-manager/shared'
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
  for (const h of closers.splice(0)) await h.t.close()
})

async function local(): Promise<DataHarness> {
  const h = await dataHarness(mongo)
  closers.push(h)
  return h
}

const kinds = (items: LibraryItem[]) => items.map((i) => [i.type, i.kind])

describe('aggregations in the history (phase 2c spec §2.1)', () => {
  it('records runs, counts and writes, never previews', async () => {
    const h = await local()
    const db = `d${randomUUID().slice(0, 8)}`
    await (
      await h.client()
    )
      .db(db)
      .collection('items')
      .insertMany([{ a: 1 }, { a: 2 }])
    const base = `/databases/${db}/collections/items/aggregate`
    await h.call('POST', `${base}/preview`, { stages: [{ $match: { a: 1 } }] })
    const history = () => h.t.app.ctx.history.list({ owner: null, connectionId: h.connectionId, limit: 50 })
    expect(history()).toEqual([])
    await h.call('POST', `${base}/run`, { stages: [{ $match: { a: 1 } }] })
    await h.call('POST', `${base}/count`, { stages: [{ $match: { a: 2 } }] })
    // An empty pipeline is nothing to find again (final review 2c, Minor 11).
    await h.call('POST', `${base}/count`, { stages: [] })
    const stages = [{ $match: {} }, { $out: 'copy' }]
    const { token } = (await h.call('POST', `${base}/write-preview`, { stages })).json()
    await h.call('POST', `${base}/write`, { stages, token })
    expect(history().map((e) => [e.kind, e.body])).toEqual([
      ['aggregate', { stages }],
      ['aggregate', { stages: [{ $match: { a: 2 } }] }],
      ['aggregate', { stages: [{ $match: { a: 1 } }] }],
    ])
  })
})

describe('library search (phase 2c spec §2.2)', () => {
  async function stocked() {
    const h = await local()
    const { ctx } = h.t.app
    const c = h.connectionId
    ctx.favourites.create({
      ownerId: null,
      connectionId: c,
      db: 'shop',
      coll: 'orders',
      name: 'Big orders',
      tags: ['sales'],
      text: JSON.stringify({ filter: { total: { $gt: 100 } } }),
      shared: false,
    })
    h.t.clock.now += 1000
    ctx.savedPipelines.create({
      ownerId: null,
      connectionId: c,
      db: 'shop',
      coll: 'items',
      name: 'Stock report',
      tags: ['etl', 'sales'],
      text: JSON.stringify([{ $group: { _id: '$sku' } }]),
      shared: false,
    })
    h.t.clock.now += 1000
    ctx.history.record(null, c, 'crm', 'people', 'find', { filter: { email: 'ada@example.com' } })
    return h
  }
  const search = async (h: DataHarness, query = '') =>
    (await h.call('GET', `/library${query}`)).json() as { items: LibraryItem[]; truncated: boolean }

  it('lists favourites, pipelines and history together, newest first', async () => {
    const h = await stocked()
    const { items, truncated } = await search(h)
    expect(kinds(items)).toEqual([
      ['history', 'find'],
      ['pipeline', 'aggregate'],
      ['favourite', 'find'],
    ])
    expect(truncated).toBe(false)
    expect(items[2]).toMatchObject({ name: 'Big orders', db: 'shop', coll: 'orders', tags: ['sales'] })
    expect(items[2]!.preview).toContain('total')
  })

  it('gives an aggregation from the history as its stages, like a saved pipeline (final review 2c)', async () => {
    const h = await stocked()
    const stages = [{ $limit: 7 }]
    h.t.clock.now += 1000
    h.t.app.ctx.history.record(null, h.connectionId, 'shop', 'items', 'aggregate', { stages })
    const [run, find] = (await search(h, '?type=history')).items
    expect(run).toMatchObject({ kind: 'aggregate', body: stages, preview: '[{ $limit: 7 }]' })
    expect(find).toMatchObject({ kind: 'find', body: { filter: { email: 'ada@example.com' } } })
    expect((await search(h, '?type=pipeline')).items[0]!.body).toEqual([{ $group: { _id: '$sku' } }])
  })

  it('finds by name, tag, namespace and the text of the query', async () => {
    const h = await stocked()
    expect((await search(h, '?q=stock')).items.map((i) => i.name)).toEqual(['Stock report'])
    expect(kinds((await search(h, '?tags=sales')).items)).toEqual([
      ['pipeline', 'aggregate'],
      ['favourite', 'find'],
    ])
    expect((await search(h, '?tags=sales,etl')).items.map((i) => i.name)).toEqual(['Stock report'])
    expect(kinds((await search(h, '?q=crm.people')).items)).toEqual([['history', 'find']])
    expect(kinds((await search(h, '?q=ada@example')).items)).toEqual([['history', 'find']])
    expect(kinds((await search(h, '?type=favourite')).items)).toEqual([['favourite', 'find']])
    expect((await search(h, '?coll=items')).items.map((i) => i.name)).toEqual(['Stock report'])
    expect((await search(h, '?limit=1')).items).toHaveLength(1)
  })

  it('says when it stopped before looking at everything', async () => {
    const h = await stocked()
    const limits = h.t.app.ctx.library.limits
    limits.saved = 0
    expect((await search(h)).truncated).toBe(true)
    limits.saved = 1500
    limits.history = 0
    expect((await search(h)).truncated).toBe(true)
  })

  // W5 review (minor): a connection admin may change what local mode saved (no owner): the list says
  // which items those are, so the Queries page offers Edit where the server allows it.
  it('marks saved items without an owner for a connection admin', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const admin = h.user('admin')
    const { ctx } = h.t.app
    ctx.snippets.create({
      ownerId: null,
      connectionId: h.connectionId,
      name: 'from local mode',
      tags: [],
      body: { code: 'print(1)', params: [] },
      shared: false,
    })
    ctx.favourites.create({
      ownerId: admin.id,
      connectionId: h.connectionId,
      db: 'shop',
      coll: 'orders',
      name: 'mine',
      tags: [],
      text: JSON.stringify({ filter: {} }),
      shared: false,
    })
    const items = ((await admin.call('GET', '/library')).json() as { items: LibraryItem[] }).items
    expect(items.find((i) => i.name === 'from local mode')).toMatchObject({ mine: false, ownerless: true })
    expect(items.find((i) => i.name === 'mine')).not.toHaveProperty('ownerless')
  })

  it('refuses a user without a grant, and skips credential namespaces for non-admins (Review Focus 3)', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const ada = h.user('editor')
    const { ctx } = h.t.app
    ctx.history.record(ada.id, h.connectionId, 'admin', 'system.users', 'find', { filter: {} })
    ctx.history.record(ada.id, h.connectionId, 'shop', 'orders', 'find', { filter: { a: 1 } })
    const items = ((await ada.call('GET', '/library')).json() as { items: LibraryItem[] }).items
    expect(items.map((i) => `${i.db}.${i.coll}`)).toEqual(['shop.orders'])
    ctx.grants.set(h.connectionId, ada.id, 'none')
    expect((await ada.call('GET', '/library')).statusCode).toBe(404)
  })

  it("removes one history entry or all of them, only the user's own", async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const [ada, bob] = [h.user('editor'), h.user('editor')]
    const { ctx } = h.t.app
    ctx.history.record(ada.id, h.connectionId, 'shop', 'orders', 'find', { filter: { a: 1 } })
    ctx.history.record(bob.id, h.connectionId, 'shop', 'orders', 'find', { filter: { b: 1 } })
    const [adaEntry] = ((await ada.call('GET', '/library')).json() as { items: LibraryItem[] }).items
    expect((await bob.call('DELETE', `/library/history/${adaEntry!.id}`)).statusCode).toBe(404)
    expect((await ada.call('DELETE', `/library/history/${adaEntry!.id}`)).statusCode).toBe(204)
    ctx.history.record(ada.id, h.connectionId, 'shop', 'orders', 'find', { filter: { c: 1 } })
    expect((await ada.call('DELETE', '/library/history')).statusCode).toBe(204)
    expect(((await ada.call('GET', '/library')).json() as { items: LibraryItem[] }).items).toEqual([])
    expect(((await bob.call('GET', '/library')).json() as { items: LibraryItem[] }).items).toHaveLength(1)
  })
})

describe('final review 2c: library search bounds and order', () => {
  async function stockedWith(n: number, over: (i: number) => Record<string, unknown> = () => ({})) {
    const h = await local()
    for (let i = 0; i < n; i++) {
      h.t.app.ctx.favourites.create({
        ownerId: null,
        connectionId: h.connectionId,
        db: 'shop',
        coll: 'orders',
        name: `z${n - i}`,
        tags: [`t${i}`],
        text: JSON.stringify({ filter: { i } }),
        shared: false,
        ...over(i),
      })
      h.t.clock.now += 1000
    }
    return h
  }
  const search = async (h: DataHarness, query = '') =>
    (await h.call('GET', `/library${query}`)).json() as {
      items: LibraryItem[]
      truncated: boolean
      tags: string[]
    }

  it('keeps the newest saved items when it stops early, not the first by name (Minor 9)', async () => {
    const h = await stockedWith(3)
    h.t.app.ctx.library.limits.saved = 1
    const { items, truncated } = await search(h)
    expect(truncated).toBe(true)
    expect(items.map((i) => i.body)).toEqual([{ filter: { i: 2 } }])
  })

  it('says there is more when the limit cuts the results (Minor 9)', async () => {
    const h = await stockedWith(3)
    expect(await search(h, '?limit=2')).toMatchObject({ truncated: true })
    expect(await search(h, '?limit=3')).toMatchObject({ truncated: false })
  })

  it('opens and sends a bounded number of bytes, and says so (I2b)', async () => {
    const h = await stockedWith(5, (i) => ({
      text: JSON.stringify({ filter: { pad: 'x'.repeat(10_000), i } }),
    }))
    const limits = h.t.app.ctx.library.limits
    limits.openBytes = 25_000
    const opened = await search(h)
    expect(opened.truncated).toBe(true)
    expect(opened.items.length).toBeLessThan(5)
    limits.openBytes = 8 * 1024 * 1024
    limits.responseBytes = 25_000
    const sent = await search(h)
    expect(sent.truncated).toBe(true)
    expect(sent.items.length).toBeLessThan(5)
    expect(JSON.stringify(sent.items).length).toBeLessThan(25_000)
  })

  it('lists every tag of what matches, even with a tag chosen (Minor 15)', async () => {
    const h = await stockedWith(3)
    const { items, tags } = await search(h, '?tags=t1')
    expect(items).toHaveLength(1)
    expect(tags).toEqual(['t0', 't1', 't2'])
  })

  it('never opens rows of credential namespaces for a non-admin (Minor 8)', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const ada = h.user('editor')
    const { ctx } = h.t.app
    ctx.history.record(ada.id, h.connectionId, 'admin', 'system.users', 'find', { filter: {} })
    ctx.favourites.create({
      ownerId: ada.id,
      connectionId: h.connectionId,
      db: 'admin',
      coll: 'system.users',
      name: 'users',
      text: '{"filter":{}}',
      shared: false,
    })
    const open = vi.spyOn(ctx.secretBox, 'open')
    try {
      const items = ((await ada.call('GET', '/library')).json() as { items: LibraryItem[] }).items
      expect(items).toEqual([])
      expect(open.mock.calls.filter(([, context]) => String(context).includes('system.users'))).toEqual([])
    } finally {
      open.mockRestore()
    }
  })
})

describe('final review 2c: local history in team mode (I4)', () => {
  it('is listed to no team user, admins included', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    h.t.app.ctx.history.record(null, h.connectionId, 'shop', 'orders', 'find', { filter: { local: 1 } })
    for (const role of ['admin', 'editor'] as const) {
      const items = ((await h.user(role).call('GET', '/library')).json() as { items: LibraryItem[] }).items
      expect(items).toEqual([])
    }
  })
})
