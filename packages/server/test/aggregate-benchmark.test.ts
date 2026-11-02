import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'
import { slow } from './support/slowness'

/**
 * Phase 2a spec §6 and R3: stage previews stay fast on a large collection, because they run on a
 * sample. 200 000 documents in CI (10 million would take minutes to seed on every run).
 */
const DOCUMENTS = 200_000
const RUNS = 20

let mongo: TestMongo
let h: DataHarness
beforeAll(async () => {
  mongo = await startMongo()
  h = await dataHarness(mongo)
  const items = (await h.client()).db('bench').collection('items')
  for (let i = 0; i < DOCUMENTS; i += 10_000)
    await items.insertMany(
      Array.from({ length: 10_000 }, (_, k) => ({
        n: i + k,
        g: (i + k) % 97,
        at: new Date(1_700_000_000_000 + (i + k) * 1000),
        tags: ['a', 'b', 'c'].slice(0, (i + k) % 4),
      })),
      { ordered: false },
    )
}, slow(120_000))
afterAll(async () => {
  await h?.t.close()
  await mongo?.stop()
})

const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!

describe('aggregation preview benchmark (phase 2a spec §6)', () => {
  it(`previews a 5-stage pipeline on ${DOCUMENTS} documents with p95 under 1 s`, async () => {
    const times: number[] = []
    for (let run = 0; run < RUNS; run++) {
      // A different first stage every time: nothing comes from the cache.
      const stages = [
        { $match: { g: { $gte: { $numberInt: String(run % 50) } } } },
        { $addFields: { twice: { $multiply: ['$n', { $numberInt: '2' }] } } },
        { $group: { _id: '$g', total: { $sum: '$twice' }, count: { $sum: { $numberInt: '1' } } } },
        { $sort: { total: { $numberInt: '-1' } } },
        { $limit: { $numberInt: '10' } },
      ]
      const started = performance.now()
      const res = await h.call('POST', '/databases/bench/collections/items/aggregate/preview', {
        stages,
        sample: { mode: 'limit', size: 1000 },
      })
      times.push(performance.now() - started)
      expect(res.statusCode).toBe(200)
      expect(res.json().stages[4]).toMatchObject({ count: 10 })
    }
    expect(p95(times)).toBeLessThan(1000)
  }, 120_000)
})
