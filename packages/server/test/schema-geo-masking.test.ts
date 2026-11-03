import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { SchemaAnalyser, type SchemaAnalysis } from '@mongo-manager/shared'
import { maskAnalysis } from '../src/masking/schema'
import { nsMaskerFrom } from '../src/masking/match'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * W2 (2026-10-16): the Schema tab plots the places a field holds. A place under a personal path is
 * never plotted: the documents are masked before the analysis, and the analysis drops the places of
 * any field with a personal path at or below it (in doubt, the map stays empty).
 */
const analysed = (docs: Array<Record<string, unknown>>): SchemaAnalysis => {
  const a = new SchemaAnalyser()
  for (const d of docs) a.add(d)
  return a.result()
}

describe('places in a masked schema analysis (unit)', () => {
  it('drops the places of a field whose coordinates, or the field itself, are personal', () => {
    const analysis = analysed([
      {
        home: { type: 'Point', coordinates: [29, 41] },
        shopLocation: [13.4, 52.5],
        spot: { lng: 1, lat: 2 },
      },
    ])
    expect(analysis.fields.find((f) => f.path === 'home')!.geo).toBeDefined()
    const masked = maskAnalysis(
      analysis,
      nsMaskerFrom([
        ['home', 'coordinates'],
        ['spot', 'lat'],
      ]),
    )
    const field = (path: string) => masked.fields.find((f) => f.path === path)
    expect(field('home')!.geo).toBeUndefined()
    expect(field('spot')!.geo).toBeUndefined()
    // A field with no personal path at or below it keeps its places.
    expect(field('shopLocation')!.geo).toEqual({ points: [[13.4, 52.5]], count: 1, geojson: 0 })
    const whole = maskAnalysis(analysis, nsMaskerFrom([['shopLocation']]))
    expect(whole.fields.find((f) => f.path === 'shopLocation')).not.toHaveProperty('geo')
  })
})

const S = 41.0123
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
  const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  await client
    .db('geo')
    .collection('stores')
    .insertMany([
      { home: { type: 'Point', coordinates: [29.0123, S] }, shopLocation: [13.4, 52.5] },
      { home: { type: 'Point', coordinates: [28.5, S] }, shopLocation: [2.35, 48.85] },
    ])
  await client.close()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('places in a masked schema analysis (route)', () => {
  it('never sends a personal place to a restricted user, and sends the others', async () => {
    const r = await restrictedApp(mongo, [{ db: 'geo', coll: 'stores', field: 'home.coordinates' }])
    apps.push(r.t)
    const res = await r.as('viewer', true)('POST', '/databases/geo/collections/stores/schema', {
      sampleSize: 100,
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(String(S))
    const fields = (res.json() as SchemaAnalysis).fields
    expect(fields.find((f) => f.path === 'home')).not.toHaveProperty('geo')
    expect(fields.find((f) => f.path === 'shopLocation')!.geo!.count).toBe(2)
    // Someone who may see personal data sees the places.
    const full = (await r.as('viewer')('POST', '/databases/geo/collections/stores/schema', {})).json()
    expect((full as SchemaAnalysis).fields.find((f) => f.path === 'home')!.geo!.count).toBe(2)
  })
})
