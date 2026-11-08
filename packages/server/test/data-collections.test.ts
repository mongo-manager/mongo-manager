// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Collection } from 'mongodb'
import { randomUUID } from 'node:crypto'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness, type DataHarness } from './support/data'

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
async function harness() {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  return h
}
const dbName = () => `d${randomUUID().slice(0, 8)}`

describe('collection routes', () => {
  it('creates every kind and lists them with types, hiding system collections', async () => {
    const h = await harness()
    const db = dbName()
    const base = `/databases/${db}/collections`
    for (const body of [
      { kind: 'collection', name: 'plain' },
      { kind: 'collection', name: 'clustered', clustered: true },
      { kind: 'capped', name: 'capped', size: 4096, max: 5 },
      { kind: 'timeseries', name: 'ts', timeField: 't', metaField: 'm', granularity: 'minutes' },
      { kind: 'view', name: 'v', viewOn: 'plain', pipeline: [{ $match: { a: { $numberInt: '1' } } }] },
    ]) {
      const res = await h.call('POST', base, body)
      expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
    }
    const list = (await h.call('GET', base)).json() as Array<{
      name: string
      type: string
      readOnly: boolean
      options: Record<string, unknown>
    }>
    expect(list.map((c) => c.name)).toEqual(['capped', 'clustered', 'plain', 'ts', 'v'])
    expect(list.find((c) => c.name === 'ts')?.type).toBe('timeseries')
    expect(list.find((c) => c.name === 'v')).toMatchObject({ type: 'view', readOnly: true })
    expect(list.find((c) => c.name === 'capped')?.options).toMatchObject({ capped: true })
    const withSystem = (await h.call('GET', `${base}?system=true`)).json() as Array<{ name: string }>
    expect(withSystem.some((c) => c.name.startsWith('system.'))).toBe(true)
    expect((await h.call('POST', base, { kind: 'collection', name: 'plain' })).statusCode).toBe(409)
  })

  it('renames, reports stats and drops with confirmation', async () => {
    const h = await harness()
    const db = dbName()
    const base = `/databases/${db}/collections`
    await h.call('POST', base, { kind: 'collection', name: 'a' })
    const client = await h.client()
    await client
      .db(db)
      .collection('a')
      .insertMany([{ x: 1 }, { x: 2 }])
    expect((await h.call('POST', `${base}/a/rename`, { to: 'b' })).json()).toEqual({ name: 'b' })
    expect(await h.call('GET', `${base}/b/stats`).then((r) => r.json())).toMatchObject({
      count: 2,
      nindexes: 1,
      capped: false,
    })
    expect((await h.call('DELETE', `${base}/b`, { confirm: 'a' })).statusCode).toBe(400)
    expect((await h.call('DELETE', `${base}/b`, { confirm: 'b' })).statusCode).toBe(204)
    expect((await h.call('GET', base)).json()).toEqual([])
  })

  it('refuses server-side JavaScript in view pipelines', async () => {
    const h = await harness()
    const res = await h.call('POST', `/databases/${dbName()}/collections`, {
      kind: 'view',
      name: 'v',
      viewOn: 'x',
      pipeline: [{ $match: { $where: 'true' } }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/\$where/)
  })
})

describe('views from a pipeline (phase 2a spec §3.2)', () => {
  it('inspects the pipeline: a restricted $lookup is refused to an editor, and a write stage to anyone', async () => {
    const h = await teamHarness(mongo)
    harnesses.push(h as unknown as DataHarness)
    const editor = h.user('editor')
    const db = dbName()
    const view = (pipeline: unknown[]) =>
      editor.call('POST', `/databases/${db}/collections`, { kind: 'view', name: 'v', viewOn: 'x', pipeline })
    const lookup = await view([{ $lookup: { from: 'system.users', as: 'u', pipeline: [] } }])
    expect(lookup.statusCode, lookup.body).toBe(403)
    const out = await view([{ $match: {} }, { $out: 'y' }])
    expect(out.statusCode, out.body).toBe(400)
    expect(out.json().message).toMatch(/view/)
    expect((await view([{ $match: { a: 1 } }])).statusCode).toBe(201)
  })
})

// Review of C6 (I1): through mongos, $collStats answers one document a shard — their sums are the
// collection's.
describe('a sharded collection’s stats', () => {
  it('sums its shards', async () => {
    const h = await harness()
    const db = dbName()
    await h.call('POST', `/databases/${db}/collections`, { kind: 'collection', name: 's' })
    const shard = (count: number, size: number, idx: number) => ({
      shard: `sh${count}`,
      count,
      storageStats: {
        size,
        storageSize: size * 2,
        totalIndexSize: idx,
        nindexes: 2,
        indexSizes: { _id_: idx, constructor: 1 },
      },
    })
    const aggregate = vi.spyOn(Collection.prototype, 'aggregate').mockReturnValue({
      toArray: async () => [shard(100, 1000, 10), shard(300, 3000, 30)],
    } as unknown as ReturnType<Collection['aggregate']>)
    const stats = (await h.call('GET', `/databases/${db}/collections/s/stats`)).json()
    aggregate.mockRestore()
    expect(stats).toMatchObject({
      count: 400,
      size: 4000,
      storageSize: 8000,
      totalIndexSize: 40,
      avgObjSize: 10,
      nindexes: 2,
      indexSizes: { _id_: 40, constructor: 2 },
    })
  })
})
