// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Binary,
  BSONRegExp,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  MongoClient,
  ObjectId,
  Timestamp,
} from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { compareIds } from '../src/transfer/bson-order'
import { READ_OPTIONS } from '../src/data/ejson-io'
import { slow } from './support/slowness'

let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
}, slow(120_000))
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})

/** A small deterministic generator (no Math.random: a failure must reproduce). */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomId(r: () => number, depth = 0): unknown {
  const pick = Math.floor(r() * 16)
  const n = Math.floor((r() - 0.5) * 2_000_000)
  switch (pick) {
    case 0:
      return new Int32(n)
    case 1:
      return Long.fromString(String(BigInt(n) * 10_000_000_000n + BigInt(Math.floor(r() * 1000))))
    case 2:
      return new Double(n / 7)
    case 3:
      return Decimal128.fromString(`${n}.${Math.floor(r() * 1000)}E${Math.floor(r() * 10) - 5}`)
    case 4:
      return ['a', 'B', 'é', 'z', '😀', 'Z', 'ı', '\u{E000}'][Math.floor(r() * 8)]! + String(n)
    case 5:
      return new ObjectId(Buffer.from(Array.from({ length: 12 }, () => Math.floor(r() * 256))))
    case 6:
      return new Date(n * 1_000_000)
    case 7:
      return r() < 0.5
    case 8:
      return new Binary(
        Buffer.from(Array.from({ length: Math.floor(r() * 4) }, () => Math.floor(r() * 256))),
        Math.floor(r() * 2) ? 0 : 4,
      )
    case 9:
      return depth < 2 ? { a: randomId(r, depth + 1), [r() < 0.5 ? 'b' : 'c']: randomId(r, depth + 1) } : n
    case 10:
      return null
    case 11:
      return new MinKey()
    case 12:
      return new MaxKey()
    case 13:
      return new Timestamp({ t: Math.floor(r() * 1000), i: Math.floor(r() * 10) })
    case 14:
      return n
    default:
      return depth < 2 ? { x: [randomId(r, depth + 1), randomId(r, depth + 1)] } : String(n)
  }
}

describe('compareIds (phase 3d-2 spec §6.2)', () => {
  it('orders every BSON type exactly as MongoDB sorts _id (property test, 3 seeds)', async () => {
    for (const seed of [1, 2, 3]) {
      const coll = client.db('order').collection(`s${seed}`)
      await coll.drop().catch(() => undefined)
      const r = rng(seed)
      const docs = Array.from({ length: 600 }, () => ({ _id: randomId(r) }))
      await coll.insertMany(docs as never[], { ordered: false }).catch(() => undefined)
      const sorted = await coll
        .find({}, { ...READ_OPTIONS, sort: { _id: 1 }, collation: { locale: 'simple' } })
        .toArray()
      expect(sorted.length).toBeGreaterThan(400)
      for (let i = 1; i < sorted.length; i++) {
        const c = compareIds(sorted[i - 1]!._id, sorted[i]!._id)
        if (c >= 0)
          throw new Error(
            `seed ${seed}: ${JSON.stringify([String(sorted[i - 1]!._id), String(sorted[i]!._id)])} → ${c}`,
          )
      }
    }
  })

  it('compares numbers across types exactly, strings by UTF-8 bytes, and equal values as 0', () => {
    expect(compareIds(new Int32(3), Long.fromNumber(3))).toBe(0)
    expect(compareIds(new Double(0.1), Decimal128.fromString('0.1'))).not.toBe(0)
    expect(compareIds(Long.fromString('9007199254740993'), new Double(9007199254740992))).toBeGreaterThan(0)
    expect(compareIds(new Double(-0), 0)).toBe(0)
    expect(compareIds(new Double(Number.NaN), new Double(Number.NEGATIVE_INFINITY))).toBeLessThan(0)
    // U+E000 is above U+1F600's surrogates in UTF-16, below it in UTF-8.
    expect(compareIds('\u{E000}', '😀')).toBeLessThan(0)
    expect(compareIds(new BSONRegExp('a', 'i'), new BSONRegExp('a', 'i'))).toBe(0)
  })

  it('refuses a date it cannot order', () => {
    expect(() => compareIds(new Date(Number.NaN), new Date(0))).toThrow(/order/)
  })
})
