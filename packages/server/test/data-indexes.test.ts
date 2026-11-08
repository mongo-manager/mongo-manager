// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
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

describe('index routes', () => {
  it('creates every common kind, lists usage, hides and drops', async () => {
    const h = await dataHarness(mongo)
    harnesses.push(h)
    const db = `d${randomUUID().slice(0, 8)}`
    const coll = (await h.client()).db(db).collection('items')
    await coll.insertOne({ email: 'a@b', body: 'hello', at: new Date(), score: 1 })
    const base = `/databases/${db}/collections/items/indexes`
    for (const body of [
      { key: { email: 1 }, options: { unique: true, name: 'email_unique' } },
      { key: { body: 'text' }, options: { weights: { body: 2 } } },
      { key: { at: 1 }, options: { expireAfterSeconds: 3600 } },
      { key: { score: -1 }, options: { partialFilterExpression: { score: { $gt: { $numberInt: '0' } } } } },
      { key: { '$**': 1 }, options: { name: 'wild' } },
    ]) {
      const res = await h.call('POST', base, body)
      expect(res.statusCode, JSON.stringify(res.json())).toBe(202)
      // Builds run in the background: wait for this one before the next.
      for (let i = 0; i < 100; i++) {
        const { jobs } = (await h.call('GET', `${base}/jobs`)).json() as { jobs: Array<{ state: string }> }
        if (jobs.every((j) => j.state === 'done')) break
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    await coll.find({ email: 'a@b' }).toArray()
    const list = (await h.call('GET', base)).json() as Array<{
      name: string
      options: Record<string, unknown>
      usage: { ops: number } | null
    }>
    expect(list.map((i) => i.name)).toEqual(
      expect.arrayContaining(['_id_', 'email_unique', 'body_text', 'at_1', 'score_-1', 'wild']),
    )
    expect(list.find((i) => i.name === 'email_unique')).toMatchObject({
      options: { unique: true },
      usage: { ops: expect.any(Number) },
    })
    expect((await h.call('PATCH', `${base}/email_unique`, { hidden: true })).json()).toEqual({
      name: 'email_unique',
      hidden: true,
    })
    expect(
      (await h.call('GET', base)).json().find((i: { name: string }) => i.name === 'email_unique').options
        .hidden,
    ).toBe(true)
    expect((await h.call('DELETE', `${base}/_id_`)).statusCode).toBe(400)
    expect((await h.call('DELETE', `${base}/email_unique`)).statusCode).toBe(204)
    expect((await h.call('POST', base, { key: { a: 'sideways' } })).statusCode).toBe(400)
  })
})
