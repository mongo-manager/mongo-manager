// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MongoServerError, Collection, Decimal128, MongoClient, type Db, type Document } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { TargetWriter, keyFilter, type WriteCounts } from '../src/transfer/target-writer'
import type { GateDeps } from '../src/masking/gate/context'
import type { NsMasker } from '../src/masking/match'
import { compileRules } from '../src/masking/match'
import { gateDepsFor } from '../src/masking/restricted'
import { IndexListingFailed } from '../src/masking/gate'
import { driverWrapped } from './support/driver-wrap'
import { slow } from './support/slowness'

/** The gate of a restricted caller where no rule applies: every record goes one by one. */
const NO_RULES: NsMasker = {
  any: false,
  patterns: [],
  matches: () => false,
  under: () => false,
  covers: () => false,
}
const OPEN_GATE: GateDeps = {
  masker: { anyRules: false, anyInDb: () => false, forNs: () => NO_RULES },
  view: async () => null,
  indexes: async () => [],
}

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
beforeEach(async () => {
  await client.db('tw').dropDatabase()
})

/** The input the writer helper builds, for a test that adds its own. */
function writerInput(mode: 'insert' | 'upsert' | 'merge', failed: Array<[number, string]>, keys = ['k']) {
  const counts: WriteCounts = { inserted: 0, matched: 0, modified: 0, upserted: 0, skipped: 0 }
  return {
    collection: client.db('tw').collection('c'),
    targetDb: null as Db | null,
    db: 'tw',
    coll: 'c',
    mode,
    keys,
    updateOnly: false,
    ordered: false,
    keepNullIds: false,
    gate: null,
    codeOnly: false,
    comment: 'mm-test',
    timeLeft: () => 60_000,
    signal: new AbortController().signal,
    counts,
    fail: async (p: { n: number }, reason: string) => {
      failed.push([p.n, reason])
    },
    stopped: () => false,
  }
}

function writer(
  mode: 'insert' | 'upsert' | 'merge',
  failed: Array<[number, string]>,
  keys = ['_id'],
  {
    ordered = false,
    throwOnStop = false,
    keepNullIds = false,
    gate = null as GateDeps | null,
    updateOnly = false,
    signal = new AbortController().signal,
    createdAs = undefined as Document | undefined,
    codeOnly = false,
    codes = [] as unknown[],
  } = {},
) {
  const counts: WriteCounts = { inserted: 0, matched: 0, modified: 0, upserted: 0, skipped: 0 }
  let stopped = false
  const w = new TargetWriter({
    collection: client.db('tw').collection('c'),
    targetDb: null,
    db: 'tw',
    coll: 'c',
    mode,
    keys,
    updateOnly,
    ordered,
    keepNullIds,
    gate,
    codeOnly,
    comment: 'mm-test',
    timeLeft: () => 60_000,
    signal,
    ...(createdAs ? { createdAs } : {}),
    counts,
    // As the jobs do: with "stop", the first refusal stops the job (restore's throws).
    fail: async (p, reason, _field, code) => {
      failed.push([p.n, reason])
      codes.push(code)
      if (ordered) stopped = true
      if (ordered && throwOnStop) throw new Error('stopped')
    },
    stopped: () => stopped,
  })
  return { w, counts }
}

describe('TargetWriter (phase 3d-2)', () => {
  // A spy never outlives its test: the next would wrap it, and call itself.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Data review 2026-10-13 (H1): a key missing or null matched, by $eq: null, every stored document
  // without that field: each such record replaced the same unrelated document.
  it.each(['upsert', 'merge'] as const)(
    'refuses a record whose key is missing or null (%s)',
    async (mode) => {
      const c = client.db('tw').collection('c')
      await c.insertMany([{ name: 'Ada' }, { name: 'Bob', email: 'b@x' }])
      const failed: Array<[number, string]> = []
      const w = writer(mode, failed, ['email'])
      await w.w.write([
        { n: 1, doc: { email: null, name: 'X' } },
        { n: 2, doc: { name: 'Y' } },
        { n: 3, doc: { email: 'b@x', name: 'Bea' } },
      ])
      expect(failed.map(([n]) => n)).toEqual([1, 2])
      expect(failed[0]![1]).toContain('email')
      const stored = await c
        .find({}, { projection: { _id: 0 } })
        .sort({ name: 1 })
        .toArray()
      expect(stored).toEqual([{ name: 'Ada' }, { name: 'Bea', email: 'b@x' }])
      // Data review 2026-10-13 (M4): the dry run predicts the refusal it will make.
      expect(
        await w.w.wouldMatch([
          { n: 4, doc: { email: null } },
          { n: 5, doc: { email: 'b@x' } },
        ]),
      ).toBe(1)
      expect(failed.map(([n]) => n)).toEqual([1, 2, 4])
    },
  )

  // Data review 2026-10-13 (I1): with "stop", the records before an empty key are written and the
  // ones after it are not — as for any other refusal.
  it.each([false, true])('stops at an empty key in order (the refusal throws: %s)', async (throwOnStop) => {
    const c = client.db('tw').collection('c')
    const failed: Array<[number, string]> = []
    const w = writer('upsert', failed, ['email'], { ordered: true, throwOnStop })
    const write = w.w.write([
      { n: 1, doc: { email: 'a@x', name: 'Ada' } },
      { n: 2, doc: { email: null, name: 'X' } },
      { n: 3, doc: { email: 'c@x', name: 'Cem' } },
      { n: 4, doc: { name: 'Y' } },
    ])
    if (throwOnStop) await expect(write).rejects.toThrow('stopped')
    else await write
    expect(failed.map(([n]) => n)).toEqual([2])
    expect(await c.find({}, { projection: { _id: 0 } }).toArray()).toEqual([{ email: 'a@x', name: 'Ada' }])
  })

  it('stops at an empty key in order for a restricted caller too, one record at a time', async () => {
    const c = client.db('tw').collection('c')
    const failed: Array<[number, string]> = []
    const w = writer('upsert', failed, ['email'], { ordered: true, gate: OPEN_GATE })
    await w.w.write([
      { n: 1, doc: { email: 'a@x', name: 'Ada' } },
      { n: 2, doc: { name: 'X' } },
      { n: 3, doc: { email: 'c@x', name: 'Cem' } },
    ])
    expect(failed.map(([n]) => n)).toEqual([2])
    expect(await c.find({}, { projection: { _id: 0 } }).toArray()).toEqual([{ email: 'a@x', name: 'Ada' }])
  })

  // Twelfth review of explain masking (M-3, N-3).
  it('looks nothing up in a dry run that stops before its first keyed record', async () => {
    const find = vi.spyOn(Collection.prototype, 'countDocuments')
    const failed: Array<[number, string]> = []
    await writer('merge', failed, ['name'], { ordered: true }).w.wouldMatch([
      { n: 1, doc: { other: 1 } },
      { n: 2, doc: { name: 'Ali' } },
    ])
    expect(failed.map(([n]) => n)).toEqual([1])
    expect(find).not.toHaveBeenCalled()
  })

  // Thirteenth to seventeenth reviews of explain masking (I-1, M-2, C-1, I-2, M-1, M-2, M-5):
  // MongoDB counts each record, a few at once, in record order.
  it('counts a dry run’s records a few at once, stops on a cancel, and fails a record the gate refuses', async () => {
    const c = client.db('tw').collection('c')
    await c.insertMany(Array.from({ length: 40 }, (_, i) => ({ _id: i as never, k: i, secret: 'x' })))
    const records = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, doc: { k: i } }))
    let inFlight = 0
    let most = 0
    const count = Collection.prototype.countDocuments
    vi.spyOn(Collection.prototype, 'countDocuments').mockImplementation(async function (
      this: Collection,
      ...args: unknown[]
    ) {
      inFlight++
      most = Math.max(most, inFlight)
      try {
        return await count.apply(this, args as never)
      } finally {
        inFlight--
      }
    } as typeof count)
    expect(await writer('merge', [], ['k']).w.wouldMatch(records)).toBe(40)
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(16)
    // A cancel: nothing more is counted.
    const cancelled = new AbortController()
    cancelled.abort()
    const spy = vi.mocked(Collection.prototype.countDocuments)
    spy.mockClear()
    expect(await writer('merge', [], ['k'], { signal: cancelled.signal }).w.wouldMatch(records)).toBe(0)
    expect(spy).not.toHaveBeenCalled()
    // A key the gate refuses (it holds what is hidden) is that record's failure, as in the run.
    const ruled: GateDeps = { ...OPEN_GATE, masker: compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]) }
    const failed: Array<[number, string]> = []
    expect(
      await writer('merge', failed, ['secret'], { gate: ruled }).w.wouldMatch([
        { n: 1, doc: { secret: 'x' } },
      ]),
    ).toBe(0)
    expect(failed.map(([n]) => n)).toEqual([1])
  })

  // Eighteenth review of explain masking (M-1, M-2).
  it('ends a stopped dry run only once its counts are done, and names the records it refused', async () => {
    const c = client.db('tw').collection('c')
    await c.insertMany([
      { _id: 1 as never, k: 1, secret: 'a' },
      { _id: 2 as never, k: 1, secret: 'b' },
      ...Array.from({ length: 20 }, (_, i) => ({ _id: (i + 10) as never, k: i + 10, secret: 'c' })),
    ])
    let inFlight = 0
    const count = Collection.prototype.countDocuments
    vi.spyOn(Collection.prototype, 'countDocuments').mockImplementation(async function (
      this: Collection,
      ...args: unknown[]
    ) {
      inFlight++
      try {
        await new Promise((r) => setTimeout(r, 20))
        return await count.apply(this, args as never)
      } finally {
        inFlight--
      }
    } as typeof count)
    const ruled: GateDeps = { ...OPEN_GATE, masker: compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]) }
    const failed: Array<[number, string]> = []
    const { w } = writer('merge', failed, ['k'], { gate: ruled, ordered: true })
    const records = [
      { n: 1, doc: { k: 1 } },
      ...Array.from({ length: 20 }, (_, i) => ({ n: i + 2, doc: { k: i + 10 } })),
    ]
    expect(await w.wouldMatch(records)).toBe(0)
    expect(failed).toEqual([[1, 'Skipped: its key matches several documents']])
    expect(inFlight).toBe(0)
    expect([...w.dryRefused]).toEqual([records[0]])
    const keyless = writer('merge', [], ['k']).w
    const empty = { n: 1, doc: { other: 1 } }
    await keyless.wouldMatch([empty])
    expect([...keyless.dryRefused]).toEqual([empty])
  })

  // Nineteenth review of explain masking (I-1, M-1, M-4).
  it('holds only the last batch’s refused and matched records, and a cancel ends counts already sent', async () => {
    const c = client.db('tw').collection('c')
    await c.insertMany([{ _id: 1 as never, k: 1 }])
    const { w } = writer('merge', [], ['k'])
    const empty = { n: 1, doc: { other: 1 } }
    const one = { n: 2, doc: { k: 1 } }
    await w.wouldMatch([empty, one])
    expect([...w.dryRefused]).toEqual([empty])
    expect([...w.dryMatched]).toEqual([one])
    const two = { n: 3, doc: { k: 2 } }
    await w.wouldMatch([two])
    expect(w.dryRefused.size).toBe(0)
    expect(w.dryMatched.size).toBe(0)
    // A count that heeds the cancel: one sent with the job's signal ends with it.
    vi.spyOn(Collection.prototype, 'countDocuments').mockImplementation(
      ((_f: unknown, o?: { signal?: AbortSignal }) =>
        new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => resolve(0), 5_000)
          o?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })) as never,
    )
    const cancel = new AbortController()
    const started = Date.now()
    setTimeout(() => cancel.abort(), 50)
    // Ended as a cancel at the top ends it (twentieth review, M-1).
    expect(await writer('merge', [], ['k'], { signal: cancel.signal }).w.wouldMatch([one, two])).toBe(0)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  // Twentieth review of explain masking (I-1, M-3): whole documents only where rules apply, one at
  // a time; a merge's second count only where rules apply.
  it('reads whole documents in a masked upsert dry run one at a time, and only where rules apply', async () => {
    const c = client.db('tw').collection('c')
    await c.insertMany(Array.from({ length: 10 }, (_, i) => ({ _id: i as never, k: i, secret: 's' })))
    const records = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, doc: { k: i, secret: '***' } }))
    let reading = 0
    let most = 0
    let reads = 0
    const find = Collection.prototype.find
    vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      const cursor = find.apply(this, args as never)
      const toArray = cursor.toArray.bind(cursor)
      cursor.toArray = async () => {
        reads++
        reading++
        most = Math.max(most, reading)
        try {
          await new Promise((r) => setTimeout(r, 10))
          return await toArray()
        } finally {
          reading--
        }
      }
      return cursor
    } as typeof find)
    const ruled: GateDeps = { ...OPEN_GATE, masker: compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]) }
    expect(await writer('upsert', [], ['k'], { gate: ruled }).w.wouldMatch(records)).toBe(10)
    expect(reads).toBe(10)
    expect(most).toBe(1)
    // Where no rule applies here, nothing is read whole, and a merge counts once a record.
    reads = 0
    const elsewhere: GateDeps = {
      ...OPEN_GATE,
      masker: compileRules([{ db: 'tw', coll: 'other', field: 'x' }]),
    }
    expect(await writer('upsert', [], ['k'], { gate: elsewhere }).w.wouldMatch(records)).toBe(10)
    expect(reads).toBe(0)
    const counts = vi.spyOn(Collection.prototype, 'countDocuments')
    expect(await writer('merge', [], ['k'], { gate: elsewhere }).w.wouldMatch(records)).toBe(10)
    expect(counts).toHaveBeenCalledTimes(10)
  })

  // Nineteenth review of explain masking (M-4): a masked merge's matched record, refused as the run refuses it.
  it('refuses in a masked merge dry run the records the run refuses, and only those', async () => {
    const c = client.db('tw').collection('c')
    await c.insertMany([
      { _id: 1 as never, k: 1, secret: 'a', v: 0 },
      { _id: 2 as never, k: 2, secret: 'a', v: 0 },
      // An array that holds a hidden value: setting it whole would replace that value.
      { _id: 3 as never, k: 3, tags: [{ email: 'a@x' }] },
    ])
    const ruled: GateDeps = {
      ...OPEN_GATE,
      masker: compileRules([
        { db: 'tw', coll: 'c', field: 'secret' },
        { db: 'tw', coll: 'c', field: 'tags.email' },
      ]),
    }
    const records = () => [
      { n: 1, doc: { k: 1, secret: 'changed' } },
      { n: 2, doc: { k: 2, v: 1 } },
      { n: 3, doc: { k: 3, tags: [{ x: 1 }] } },
    ]
    const dry: Array<[number, string]> = []
    const matched = await writer('merge', dry, ['k'], { gate: ruled }).w.wouldMatch(records())
    const run: Array<[number, string]> = []
    const done = writer('merge', run, ['k'], { gate: ruled })
    await done.w.write(records())
    expect(dry, JSON.stringify({ dry, run, matched, counts: done.counts })).toEqual(run)
    expect(run.map(([n]) => n)).toEqual([1, 3])
    expect(matched).toBe(done.counts.matched)
  })

  // Twenty-first review of explain masking (Minor 1, nit 4).
  it('reads no whole document after a masked dry run stops, and the run reads one at most', async () => {
    const c = client.db('tw').collection('c')
    await c.insertMany([
      { _id: 0 as never, k: 0, secret: 's' },
      { _id: 100 as never, k: 0, secret: 's' },
      ...Array.from({ length: 9 }, (_, i) => ({ _id: (i + 1) as never, k: i + 1, secret: 's' })),
    ])
    const records = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, doc: { k: i, secret: '***' } }))
    let whole = 0
    const find = Collection.prototype.find
    vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      const cursor = find.apply(this, args as never)
      const projected = (args[1] as { projection?: Document } | undefined)?.projection
      const toArray = cursor.toArray.bind(cursor)
      cursor.toArray = async () => {
        if (!projected) whole++
        await new Promise((r) => setTimeout(r, 50))
        return await toArray()
      }
      return cursor
    } as typeof find)
    const ruled: GateDeps = { ...OPEN_GATE, masker: compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]) }
    const failed: Array<[number, string]> = []
    await writer('upsert', failed, ['k'], { gate: ruled, ordered: true }).w.wouldMatch(records)
    expect(failed).toEqual([[1, 'Skipped: its key matches several documents']])
    // A read already started when it stopped may finish; none starts after.
    expect(whole).toBeLessThanOrEqual(1)
    // The run: the matches told by their _ids, one document read whole.
    whole = 0
    await writer('upsert', [], ['k'], { gate: ruled }).w.write([{ n: 1, doc: { k: 1, secret: '***' } }])
    expect(whole).toBe(1)
  })

  // Twenty-second review of explain masking (M-2, M-3).
  it('inserts no record whose match vanished between the reads, and counts no match left unchecked', async () => {
    const c = client.db('tw').collection('c')
    await c.insertOne({ _id: 1 as never, k: 1, secret: 's' })
    const ruled: GateDeps = { ...OPEN_GATE, masker: compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]) }
    const find = Collection.prototype.find
    const spy = vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      const cursor = find.apply(this, args as never)
      const whole = !(args[1] as { projection?: Document } | undefined)?.projection
      const toArray = cursor.toArray.bind(cursor)
      cursor.toArray = async () => {
        // The one it matched is removed before it is read whole.
        if (whole) await c.deleteOne({ _id: 1 } as never)
        return await toArray()
      }
      return cursor
    } as typeof find)
    const failed: Array<[number, string]> = []
    await writer('upsert', failed, ['k'], { gate: ruled }).w.write([{ n: 1, doc: { k: 1, secret: '***' } }])
    expect(failed).toEqual([[1, 'Skipped: the document changed while it was imported']])
    expect(await c.countDocuments()).toBe(0)
    // Update only: a vanished match is skipped, as any record that matches nothing (final review, nit).
    await c.insertOne({ _id: 1 as never, k: 1, secret: 's' })
    const only: Array<[number, string]> = []
    const skipped = writer('upsert', only, ['k'], { gate: ruled, updateOnly: true })
    await skipped.w.write([{ n: 1, doc: { k: 1, secret: '***' } }])
    expect(only).toEqual([])
    expect(skipped.counts.skipped).toBe(1)
    spy.mockRestore()
    // A cancel that lands while a match waits for its check: that match is not counted.
    await c.insertOne({ _id: 2 as never, k: 2, secret: 's' })
    const cancel = new AbortController()
    const count = Collection.prototype.countDocuments
    vi.spyOn(Collection.prototype, 'countDocuments').mockImplementation(async function (
      this: Collection,
      ...args: unknown[]
    ) {
      const n = await count.apply(this, args as never)
      cancel.abort()
      return n
    } as typeof count)
    const { w } = writer('upsert', [], ['k'], { gate: ruled, signal: cancel.signal })
    expect(await w.wouldMatch([{ n: 1, doc: { k: 2, secret: '***' } }])).toBe(0)
    expect(w.dryMatched.size).toBe(0)
  })

  // Final review of explain masking (I-1, M-2, nit): a masked merge updates the one it checked.
  it('updates in a masked merge only the document it checked, and says when it changed', async () => {
    const c = client.db('tw').collection('c')
    await c.createIndex({ k: 1, secret: 1 })
    await c.insertOne({ _id: 1 as never, k: 1, secret: 'z' })
    const ruled: GateDeps = { ...OPEN_GATE, masker: compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]) }
    const update = Collection.prototype.updateOne
    let twin: (() => Promise<unknown>) | null = () => c.insertOne({ _id: 2 as never, k: 1, secret: 'a' })
    vi.spyOn(Collection.prototype, 'updateOne').mockImplementation(async function (
      this: Collection,
      ...args: unknown[]
    ) {
      // A twin, first in the hidden index's order, added after the check.
      if (twin) await twin()
      twin = null
      return update.apply(this, args as never)
    } as typeof update)
    const failed: Array<[number, string]> = []
    await writer('merge', failed, ['k'], { gate: ruled }).w.write([{ n: 1, doc: { k: 1, probe: 1 } }])
    expect(failed).toEqual([])
    expect(await c.find({}, { sort: { _id: 1 } }).toArray()).toEqual([
      { _id: 1, k: 1, secret: 'z', probe: 1 },
      { _id: 2, k: 1, secret: 'a' },
    ])
    // Gone between the check and the update: it changed, no hidden field is blamed.
    twin = () => c.deleteMany({})
    const gone: Array<[number, string]> = []
    await c.insertOne({ _id: 3 as never, k: 3, secret: 'x' })
    await writer('merge', gone, ['k'], { gate: ruled }).w.write([{ n: 1, doc: { k: 3, probe: 1 } }])
    expect(gone).toEqual([[1, 'Skipped: the document changed while it was imported']])
    // Where no rule applies here, a match gone is said as changed too, no hidden field blamed.
    twin = () => c.deleteMany({})
    await c.insertOne({ _id: 4 as never, k: 4 })
    const elsewhere: GateDeps = {
      ...OPEN_GATE,
      masker: compileRules([{ db: 'tw', coll: 'other', field: 'x' }]),
    }
    const unruled: Array<[number, string]> = []
    await writer('merge', unruled, ['k'], { gate: elsewhere }).w.write([{ n: 1, doc: { k: 4, probe: 1 } }])
    expect(unruled).toEqual([[1, 'Skipped: the document changed while it was imported']])
  })

  // Final review of explain masking (I-A): in a series stored by what is hidden, a key's match is
  // no one document (its _id may repeat): a masked upsert or merge is refused, as its dry run says.
  it.each(['upsert', 'merge'] as const)(
    'refuses a masked %s by key into a series stored by what is hidden',
    async (mode) => {
      await client.db('tw').dropCollection('c')
      await client.db('tw').createCollection('c', { timeseries: { timeField: 'at', metaField: 'meta' } })
      await client
        .db('tw')
        .collection('c')
        .insertOne({ _id: 1 as never, at: new Date(1), meta: { email: 'a@x' }, k: 1 })
      // The gate's own lookups: they know a series from its listing.
      const ruled = gateDepsFor(compileRules([{ db: 'tw', coll: 'c', field: 'meta.email' }]), client)
      const records = () => [{ n: 1, doc: { k: 1, v: 1 } }]
      const reason =
        'Skipped: documents here may share an _id, so while personal data is hidden a key cannot be tied to a single document'
      const dry: Array<[number, string]> = []
      expect(await writer(mode, dry, ['k'], { gate: ruled }).w.wouldMatch(records())).toBe(0)
      expect(dry).toEqual([[1, reason]])
      const run: Array<[number, string]> = []
      await writer(mode, run, ['k'], { gate: ruled }).w.write(records())
      expect(run).toEqual([[1, reason]])
      expect(await client.db('tw').collection('c').countDocuments({ v: 1 })).toBe(0)
    },
  )

  // Final reviews of explain masking (M-3, M-4): only where an _id itself may repeat; a target a
  // dry run would create, by its options.
  it('merges into a clustered collection whose _id is hidden, and predicts a new series target', async () => {
    await client.db('tw').dropCollection('c')
    await client.db('tw').createCollection('c', { clusteredIndex: { key: { _id: 1 }, unique: true } })
    await client
      .db('tw')
      .collection('c')
      .insertOne({ _id: 'a@x' as never, sku: 1 })
    const clustered = gateDepsFor(compileRules([{ db: 'tw', coll: 'c', field: '_id' }]), client)
    const failed: Array<[number, string]> = []
    const { w, counts } = writer('merge', failed, ['sku'], { gate: clustered })
    await w.write([{ n: 1, doc: { sku: 1, v: 2 } }])
    expect(failed).toEqual([])
    expect(counts.matched).toBe(1)
    // A series a copy would create, stored by what is hidden: its dry run says what the run would.
    await client.db('tw').dropCollection('c')
    const series = gateDepsFor(compileRules([{ db: 'tw', coll: 'c', field: 'meta.email' }]), client)
    const dry: Array<[number, string]> = []
    await writer('merge', dry, ['k'], {
      gate: series,
      createdAs: { timeseries: { timeField: 'at', metaField: 'meta' } },
    }).w.wouldMatch([{ n: 1, doc: { k: 1 } }])
    expect(dry.map(([, r]) => r)).toEqual([
      'Skipped: documents here may share an _id, so while personal data is hidden a key cannot be tied to a single document',
    ])
    const none: Array<[number, string]> = []
    await writer('merge', none, ['k'], { gate: series }).w.wouldMatch([{ n: 1, doc: { k: 1 } }])
    expect(none).toEqual([])
  })

  // Final review of explain masking (Minor 2): MongoDB changes no single document of a time series.
  it.each(['upsert', 'merge'] as const)(
    'refuses an upsert or merge (%s) into a time series, run and dry run',
    async (mode) => {
      await client.db('tw').dropCollection('c')
      await client.db('tw').createCollection('c', { timeseries: { timeField: 'at', metaField: 'm' } })
      await client
        .db('tw')
        .collection('c')
        .insertOne({ _id: 1 as never, at: new Date(1), m: 'x', k: 1 })
      const reason = 'Skipped: MongoDB changes no single document of a time series: only inserts reach one'
      const make = (failed: Array<[number, string]>, options = {}) =>
        new TargetWriter({ ...writerInput(mode, failed), targetDb: client.db('tw'), ...options })
      const dry: Array<[number, string]> = []
      expect(await make(dry).wouldMatch([{ n: 1, doc: { k: 1 } }])).toBe(0)
      expect(dry).toEqual([[1, reason]])
      const run: Array<[number, string]> = []
      await make(run).write([{ n: 1, doc: { k: 1, at: new Date(2), m: 'x' } }])
      expect(run).toEqual([[1, reason]])
      // One a dry run's copy would create as a series, judged by its options.
      await client.db('tw').dropCollection('c')
      const planned: Array<[number, string]> = []
      await make(planned, { createdAs: { timeseries: { timeField: 'at' } } }).wouldMatch([
        { n: 1, doc: { k: 1 } },
      ])
      expect(planned).toEqual([[1, reason]])
      // Inserts reach one.
      const inserted: Array<[number, string]> = []
      await client.db('tw').createCollection('c', { timeseries: { timeField: 'at', metaField: 'm' } })
      await new TargetWriter({ ...writerInput('insert', inserted), targetDb: client.db('tw') }).write([
        { n: 1, doc: { at: new Date(3), m: 'y' } },
      ])
      expect(inserted).toEqual([])
    },
  )

  // Reviews of the agent's gate (M-2, M-1, M-4): a restricted import inserts nothing a unique index's
  // duplicate key would answer for, one record at a time; a compound _id holding nothing hidden goes in
  // though a ** rule may reach it; indexes that cannot be read stop the job once.
  it('inserts nothing under a unique index whose filter reads what is hidden, a compound _id freely', async () => {
    const c = client.db('tw').collection('c')
    await c.insertOne({ _id: 9 as never, code: 'C', flag: false, secret: 's9' })
    await c.createIndex(
      { code: 1 },
      { unique: true, partialFilterExpression: { $or: [{ secret: { $gt: 's' } }, { flag: true }] } },
    )
    const gate = gateDepsFor(compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]), client)
    const failed: Array<[number, string]> = []
    const { w } = writer('insert', failed, ['_id'], { gate })
    await w.write([{ n: 1, doc: { code: 'C', flag: true } }])
    expect(failed.map(([n, reason]) => [n, /unique index/.test(reason)])).toEqual([[1, true]])
    expect(await c.countDocuments()).toBe(1)
    await c.dropIndexes()
    // A compound _id under a ** rule, holding nothing hidden.
    const deep = gateDepsFor(compileRules([{ db: 'tw', coll: 'c', field: '**.email' }]), client)
    const none: Array<[number, string]> = []
    await writer('insert', none, ['_id'], { gate: deep }).w.write([
      { n: 2, doc: { _id: { day: 1, user: 'u' } } },
    ])
    expect(none).toEqual([])
    expect(await c.countDocuments({ _id: { day: 1, user: 'u' } } as never)).toBe(1)
    // Indexes that cannot be read: the job stops, not each record failing alike.
    // Its kind read as missing before (a new collection), the failed listing still refuses (M-4).
    const blind: GateDeps = {
      ...gate,
      indexes: async () => [],
      indexesUnread: () => true,
      kind: async () => 'missing',
    }
    const stopped: Array<[number, string]> = []
    await expect(
      writer('insert', stopped, ['_id'], { gate: blind }).w.write([
        { n: 3, doc: { code: 'D' } },
        { n: 4, doc: { code: 'E' } },
      ]),
    ).rejects.toThrow(/indexes cannot be read/)
    expect(stopped).toEqual([])
    // A server's own failure is said as itself, not as a right the user lacks (next review, M-2).
    const down = new MongoServerError({ message: 'interrupted at shutdown', code: 91 })
    const failing: GateDeps = { ...blind, indexesFailure: () => down }
    const stoppedBy = await writer('insert', [], ['_id'], { gate: failing })
      .w.write([{ n: 5, doc: { code: 'F' } }])
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(stoppedBy).toBeInstanceOf(IndexListingFailed)
    expect((stoppedBy as Error).cause).toBe(down)
    // Whatever the server's code (a shard out of reach, 6): the job's, not one record's (next round, M-B).
    const shard: GateDeps = {
      ...blind,
      indexesFailure: () => new MongoServerError({ message: 'host unreachable', code: 6 }),
    }
    const perRecord: Array<[number, string]> = []
    await expect(
      writer('insert', perRecord, ['_id'], { gate: shard }).w.write([{ n: 8, doc: { code: 'H' } }]),
    ).rejects.toBeInstanceOf(IndexListingFailed)
    expect(perRecord).toEqual([])
    // Atlas's "not allowed" (8000) is a right the user lacks, said as such (next round, nit).
    const atlas: GateDeps = {
      ...blind,
      indexesFailure: () => new MongoServerError({ message: 'not allowed', code: 8000 }),
    }
    await expect(
      writer('insert', [], ['_id'], { gate: atlas }).w.write([{ n: 9, doc: { code: 'I' } }]),
    ).rejects.toThrow(/indexes cannot be read/)
    const denied = new MongoServerError({ message: 'not authorized', code: 13 })
    const unauthorized: GateDeps = { ...blind, indexesFailure: () => denied }
    await expect(
      writer('insert', [], ['_id'], { gate: unauthorized }).w.write([{ n: 6, doc: { code: 'G' } }]),
    ).rejects.toThrow(/indexes cannot be read/)
    // A dry run stops as the run does, not refusing each record alike (next review, M-3).
    await c.insertOne({ _id: 20 as never, k: 20, secret: 's20' })
    const dry: Array<[number, string]> = []
    await expect(
      writer('upsert', dry, ['k'], { gate: blind }).w.wouldMatch([{ n: 7, doc: { k: 20, secret: '***' } }]),
    ).rejects.toThrow(/indexes cannot be read/)
    expect(dry).toEqual([])
  })

  // Review of the agent's gate (M-4): a server not there (a socket that failed) stops the job, as the
  // routes answer it (503), not one record refused after another.
  it('stops on a server not available, not failing each record', async () => {
    // A restricted writer writes one at a time: a server's failure there is the job's.
    const gate = gateDepsFor(compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]), client)
    vi.spyOn(Collection.prototype, 'insertOne').mockRejectedValue(
      new MongoServerError({ message: 'socket exception', code: 9001 }),
    )
    const failed: Array<[number, string]> = []
    await expect(
      writer('insert', failed, ['_id'], { gate }).w.write([
        { n: 1, doc: { _id: 101 } },
        { n: 2, doc: { _id: 102 } },
      ]),
    ).rejects.toThrow(/socket exception/)
    expect(failed).toEqual([])
    vi.restoreAllMocks()
  })

  // Second independent review (Minor 1): a record MongoDB refused through the driver's own wrapper
  // is failed with the server's words and code, or its code alone where only that is shown.
  it("fails a record refused under the driver's wrapper as the server did", async () => {
    const gate = gateDepsFor(compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]), client)
    vi.spyOn(Collection.prototype, 'insertOne').mockRejectedValue(driverWrapped())
    for (const [codeOnly, reason] of [
      [false, 'refused here'],
      [true, 'MongoDB refused the write (code 20)'],
    ] as const) {
      const failed: Array<[number, string]> = []
      const codes: unknown[] = []
      await writer('insert', failed, ['_id'], { gate, codeOnly, codes }).w.write([
        { n: 1, doc: { _id: 103 } },
      ])
      expect(failed).toEqual([[1, reason]])
      expect(codes).toEqual([20])
    }
    // Defensive: a server not there under it stops the job, as it does unwrapped.
    vi.spyOn(Collection.prototype, 'insertOne').mockRejectedValue(driverWrapped('shutting down', 91))
    const failed: Array<[number, string]> = []
    await expect(
      writer('insert', failed, ['_id'], { gate }).w.write([{ n: 1, doc: { _id: 104 } }]),
    ).rejects.toMatchObject({ originalError: { code: 91 } })
    expect(failed).toEqual([])
    vi.restoreAllMocks()
  })

  // Research 2026-10-28 (SERVER-20547): a record the validator refused said only "Document failed
  // validation"; the report names the rules, the field and rule alone where only the code is shown.
  it.each([
    [false, false, 'Document failed validation: age: minimum 0; name: required'],
    [false, true, 'Document failed validation: age: minimum 0; name: required'],
    [true, false, 'MongoDB refused the write (code 121: age minimum; name required)'],
    [true, true, 'MongoDB refused the write (code 121: age minimum; name required)'],
  ] as const)(
    'names the validator rules a record did not meet (code only %s, one by one %s)',
    async (codeOnly, single, reason) => {
      await client.db('tw').createCollection('c', {
        validator: { $jsonSchema: { required: ['name'], properties: { age: { minimum: 0 } } } },
      })
      const gate = single
        ? gateDepsFor(compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]), client)
        : null
      const failed: Array<[number, string]> = []
      const codes: unknown[] = []
      await writer('insert', failed, ['_id'], { gate, codeOnly, codes }).w.write([
        { n: 1, doc: { _id: 1, age: -3 } },
        { n: 2, doc: { _id: 2, age: 1, name: 'ok' } },
      ])
      expect(failed).toEqual([[1, reason]])
      expect(codes).toEqual([121])
    },
  )

  // Final review of explain masking (Minor 3b): a question that failed is asked again.
  it('asks again whether an _id may repeat after the question failed', async () => {
    const real = gateDepsFor(compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]), client)
    let fail = true
    const flaky: GateDeps = {
      ...real,
      view: async (db, coll) => {
        if (fail) {
          fail = false
          throw new Error('listing failed')
        }
        return real.view(db, coll)
      },
    }
    await client
      .db('tw')
      .collection('c')
      .insertOne({ _id: 1 as never, k: 1, secret: 's' })
    const { w } = writer('merge', [], ['k'], { gate: flaky })
    await expect(w.write([{ n: 1, doc: { k: 1, v: 1 } }])).rejects.toThrow('listing failed')
    await w.write([{ n: 2, doc: { k: 1, v: 2 } }])
    expect(
      await client
        .db('tw')
        .collection('c')
        .findOne({ _id: 1 } as never),
    ).toMatchObject({ v: 2 })
  })

  it('counts a dry run’s matches by MongoDB, a stored array matching what it holds', async () => {
    await client
      .db('tw')
      .collection('c')
      .insertMany([
        { _id: 1 as never, tags: [5, 6] },
        { _id: 2 as never, tags: 7 },
        { _id: 3 as never, tags: 7 },
      ])
    const count = vi.spyOn(Collection.prototype, 'countDocuments')
    const failed: Array<[number, string]> = []
    const w = writer('merge', failed, ['tags']).w
    expect(
      await w.wouldMatch([
        { n: 1, doc: { tags: 5 } },
        { n: 2, doc: { tags: 7 } },
        { n: 3, doc: { tags: 9 } },
      ]),
    ).toBe(2)
    expect(count).toHaveBeenCalledTimes(3)
    // Where rules apply, the key matching two is refused, as the run refuses it.
    const ruled: GateDeps = { ...OPEN_GATE, masker: compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]) }
    const refused: Array<[number, string]> = []
    expect(
      await writer('merge', refused, ['tags'], { gate: ruled }).w.wouldMatch([{ n: 1, doc: { tags: 7 } }]),
    ).toBe(0)
    expect(refused).toEqual([[1, 'Skipped: its key matches several documents']])
  })

  // Fourteenth review of explain masking (M-3, M-4).
  it('counts a dry run’s matches through an array index and nested arrays', async () => {
    const c = client.db('tw').collection('c')
    await c.insertMany([
      { _id: 1 as never, items: [{ sku: 'A' }, { sku: 'B' }] },
      { _id: 2 as never, a: [{ b: [1, 2] }] },
    ])
    const failed: Array<[number, string]> = []
    expect(
      await writer('merge', failed, ['items.1.sku']).w.wouldMatch([
        { n: 1, doc: { items: [{}, { sku: 'B' }] } },
      ]),
    ).toBe(1)
    expect(
      await writer('merge', failed, ['items.0.sku']).w.wouldMatch([{ n: 1, doc: { items: [{ sku: 'B' }] } }]),
    ).toBe(0)
    expect(await writer('merge', failed, ['a.b']).w.wouldMatch([{ n: 1, doc: { a: { b: 2 } } }])).toBe(1)
    expect(failed).toEqual([])
  })

  // Fifteenth review of explain masking (M-3): as the run matches them.
  it('counts a dry run’s matches on a collated target record by record, as the run does', async () => {
    await client.db('tw').dropCollection('c')
    await client.db('tw').createCollection('c', { collation: { locale: 'en', strength: 2 } })
    await client
      .db('tw')
      .collection('c')
      .insertMany([
        { _id: 1 as never, name: 'Bob', secret: 'z' },
        { _id: 2 as never, name: 'bob', secret: 'a' },
      ])
    const ruled: GateDeps = { ...OPEN_GATE, masker: compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]) }
    const failed: Array<[number, string]> = []
    expect(
      await writer('merge', failed, ['name'], { gate: ruled }).w.wouldMatch([{ n: 1, doc: { name: 'bob' } }]),
    ).toBe(0)
    expect(failed).toEqual([[1, 'Skipped: its key matches several documents']])
    const open: Array<[number, string]> = []
    expect(await writer('merge', open, ['name']).w.wouldMatch([{ n: 1, doc: { name: 'BOB' } }])).toBe(1)
    expect(open).toEqual([])
  })

  // Sixteenth review of explain masking (P-1, C-1).
  it('never builds an operator from a key', () => {
    expect(() =>
      keyFilter(['$expr'], { $expr: [{ $function: { body: 'x', args: [], lang: 'js' } }, true] }),
    ).toThrow(expect.objectContaining({ details: { reason: 'bad_key' } }))
    expect(() => keyFilter(['a.$where'], { a: {} })).toThrow(
      expect.objectContaining({ details: { reason: 'bad_key' } }),
    )
    expect(keyFilter(['a.b'], { a: { b: 1 } })).toEqual({ 'a.b': { $eq: 1 } })
  })

  // However long MongoDB takes to match such a document, the server goes on answering: nothing
  // here follows the path, and MongoDB stops at the job's time.
  it('never blocks the server on a document of arrays and documents nested in turn', async () => {
    // 14 levels: MongoDB matches it in milliseconds (its own matcher grows with the depth too,
    // measured on 8.2), where following every route here took seconds.
    let doc: unknown = 1
    for (let i = 0; i < 14; i++) doc = [{ '0': doc }]
    await client
      .db('tw')
      .collection('c')
      .insertOne({ _id: 1 as never, x: doc })
    const key = ['x', ...Array.from({ length: 28 }, () => '0')].join('.')
    const record: Document = {}
    let at = record
    for (const p of key.split('.').slice(0, -1)) at = at[p] = {}
    at['0'] = 1
    let last = Date.now()
    let gap = 0
    const tick = setInterval(() => {
      gap = Math.max(gap, Date.now() - last)
      last = Date.now()
    }, 20)
    const started = Date.now()
    try {
      expect(await writer('merge', [], [key]).w.wouldMatch([{ n: 1, doc: record }])).toBe(1)
    } finally {
      clearInterval(tick)
    }
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(gap).toBeLessThan(1_000)
  })

  // Fifteenth review of explain masking (I-3, M-1, M-2): a key's path followed as a filter follows it.
  it('follows a key’s path as MongoDB’s matcher does, quickly however deep', async () => {
    const c = client.db('tw').collection('c')
    let deep: unknown = 'leaf'
    for (let i = 0; i < 40; i++) deep = [deep]
    await c.insertMany([
      { _id: 1 as never, a: [5, 7, { '01': 6 }] },
      { _id: 2 as never, x: [{ b: [1, 2] }, { b: [3, 4] }] },
      { _id: 3 as never, d: deep },
    ])
    const failed: Array<[number, string]> = []
    // '01' is no position: only the element holding a field named so matches (the first record
    // brings the document in; the second, which only position 1 would match, matches nothing).
    expect(
      await writer('merge', failed, ['a.01']).w.wouldMatch([
        { n: 1, doc: { a: { '01': 6 } } },
        { n: 2, doc: { a: { '01': 7 } } },
      ]),
    ).toBe(1)
    expect(await writer('merge', failed, ['a.1']).w.wouldMatch([{ n: 1, doc: { a: { '1': 7 } } }])).toBe(1)
    // Each element's b, then its first.
    expect(
      await writer('merge', failed, ['x.b.0']).w.wouldMatch([{ n: 1, doc: { x: { b: { '0': 3 } } } }]),
    ).toBe(1)
    const key = ['d', ...Array.from({ length: 40 }, () => '0')].join('.')
    const record: Document = {}
    let at = record
    for (const p of key.split('.').slice(0, -1)) at = at[p] = {}
    at['0'] = 'leaf'
    const started = Date.now()
    expect(await writer('merge', failed, [key]).w.wouldMatch([{ n: 1, doc: record }])).toBe(1)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(failed).toEqual([])
  })

  it('counts a dry run’s matches as MongoDB compares the keys', async () => {
    await client
      .db('tw')
      .collection('c')
      .insertOne({ _id: 1 as never, code: Decimal128.fromString('5') })
    const failed: Array<[number, string]> = []
    expect(await writer('merge', failed, ['code']).w.wouldMatch([{ n: 1, doc: { code: 5 } }])).toBe(1)
    expect(failed).toEqual([])
  })

  // Nineteenth and tenth reviews of explain masking (I3, Minors 2, 3): the first a key matches is
  // in a plan's order, where rules apply.
  it.each(['upsert', 'merge'] as const)(
    'refuses a restricted %s whose key matches several documents where rules apply, and its dry run says so',
    async (mode) => {
      const c = client.db('tw').collection('c')
      await c.insertMany([
        { _id: 1 as never, name: 'Ali', tag: null },
        { _id: 2 as never, name: 'Ali', tag: null },
      ])
      const ruled: GateDeps = {
        ...OPEN_GATE,
        masker: compileRules([{ db: 'tw', coll: 'c', field: 'secret' }]),
      }
      const failed: Array<[number, string]> = []
      const w = writer(mode, failed, ['name'], { gate: ruled })
      await w.w.write([{ n: 1, doc: { name: 'Ali', tag: 'x' } }])
      expect(failed).toEqual([[1, 'Skipped: its key matches several documents']])
      expect(await c.countDocuments({ tag: 'x' })).toBe(0)
      const dry: Array<[number, string]> = []
      expect(
        await writer(mode, dry, ['name'], { gate: ruled }).w.wouldMatch([{ n: 1, doc: { name: 'Ali' } }]),
      ).toBe(0)
      expect(dry).toEqual([[1, 'Skipped: its key matches several documents']])
      // Where no rule applies, nothing is hidden: the key writes as before.
      const open: Array<[number, string]> = []
      await writer(mode, open, ['name'], { gate: OPEN_GATE }).w.write([
        { n: 1, doc: { name: 'Ali', tag: 'y' } },
      ])
      expect(open).toEqual([])
      expect(await c.countDocuments({ tag: 'y' })).toBeGreaterThan(0)
      // A dry run says its refusals in record order, and with "stop" none after the first
      // (eleventh review, M2).
      const stop: Array<[number, string]> = []
      await writer(mode, stop, ['name'], { gate: ruled, ordered: true }).w.wouldMatch([
        { n: 1, doc: { name: 'Ali' } },
        { n: 2, doc: { tag: 'no key' } },
      ])
      expect(stop).toEqual([[1, 'Skipped: its key matches several documents']])
    },
  )

  it('writes the records on both sides of an empty key when it does not stop', async () => {
    const c = client.db('tw').collection('c')
    const failed: Array<[number, string]> = []
    const w = writer('upsert', failed, ['email'])
    await w.w.write([
      { n: 1, doc: { email: 'a@x', name: 'Ada' } },
      { n: 2, doc: { email: null, name: 'X' } },
      { n: 3, doc: { email: 'c@x', name: 'Cem' } },
    ])
    expect(failed.map(([n]) => n)).toEqual([2])
    expect(await c.countDocuments()).toBe(2)
  })

  // Round 2 (Minor 2): a dry run with "stop" counts nothing after the record it stops at.
  it('stops a dry run where the real run would stop', async () => {
    const c = client.db('tw').collection('c')
    await c.insertOne({ email: 'b@x' })
    const failed: Array<[number, string]> = []
    const w = writer('upsert', failed, ['email'], { ordered: true })
    expect(
      await w.w.wouldMatch([
        { n: 1, doc: { email: null } },
        { n: 2, doc: { email: 'b@x' } },
        { n: 3, doc: {} },
      ]),
    ).toBe(0)
    expect(failed.map(([n]) => n)).toEqual([1])
  })

  // Round 2 (Minor 3): a backup restored as it was keeps a document whose _id is null.
  it('keeps a null _id where asked, instead of giving it a new one', async () => {
    const c = client.db('tw').collection('c')
    const failed: Array<[number, string]> = []
    await writer('insert', failed, ['_id'], { keepNullIds: true }).w.write([
      { n: 1, doc: { _id: null, v: 1 } },
    ])
    expect(failed).toEqual([])
    expect(await c.findOne({ v: 1 })).toEqual({ _id: null, v: 1 })
  })

  // Data review 2026-10-13 (M5), ruled: a null _id names one document, but every record whose id is
  // empty (a blank cell, a NULL key) would be written into that one — it is refused like any key.
  it('refuses a null _id: records with no id would collapse into one document', async () => {
    const c = client.db('tw').collection('c')
    // The driver would give a null _id an ObjectId: the command stores it as it is.
    await client.db('tw').command({ insert: 'c', documents: [{ _id: null, v: 1 }] })
    const failed: Array<[number, string]> = []
    const w = writer('upsert', failed)
    await w.w.write([
      { n: 1, doc: { _id: null, v: 2 } },
      { n: 2, doc: { _id: null, v: 3 } },
    ])
    expect(failed.map(([n]) => n)).toEqual([1, 2])
    expect(await c.find({}, { projection: { _id: 0 } }).toArray()).toEqual([{ v: 1 }])
    expect(failed[0]![1]).toContain('insert')
  })

  it('inserts, reports duplicates per record, upserts and merges leaf paths', async () => {
    const failed: Array<[number, string]> = []
    const ins = writer('insert', failed)
    await ins.w.write([
      { n: 1, doc: { _id: 1, a: { x: 1, y: 1 } } },
      { n: 2, doc: { _id: 1, a: { x: 9 } } },
    ])
    expect(ins.counts.inserted).toBe(1)
    expect(failed.map(([n]) => n)).toEqual([2])
    const merge = writer('merge', failed)
    await merge.w.write([{ n: 3, doc: { _id: 1, a: { y: 2 } } }])
    expect(
      await client
        .db('tw')
        .collection('c')
        .findOne({ _id: 1 as never }),
    ).toEqual({
      _id: 1,
      a: { x: 1, y: 2 },
    })
    const up = writer('upsert', failed)
    await up.w.write([
      { n: 4, doc: { _id: 1, b: 1 } },
      { n: 5, doc: { _id: 2, b: 2 } },
    ])
    expect(up.counts).toMatchObject({ matched: 1, upserted: 1 })
    expect(
      await up.w.wouldMatch([
        { n: 6, doc: { _id: 2 } },
        { n: 7, doc: { _id: 3 } },
      ]),
    ).toBe(1)
  })

  // Data review 2026-10-13 (low): an empty sub-document in a merge replaced the stored one whole
  // ("fields not in the record stay" — it has none), and "update only" was ignored in upsert.
  for (const gate of [null, OPEN_GATE])
    it(`merges an empty sub-document as nothing to change, and upserts update only (${gate ? 'restricted' : 'open'})`, async () => {
      const c = client.db('tw').collection('c')
      await c.insertMany([
        { _id: 1, a: { x: 1 }, b: 0 },
        { _id: 5, v: 0 },
      ] as never[])
      const failed: Array<[number, string]> = []
      const merge = writer('merge', failed, ['_id'], { gate })
      await merge.w.write([
        { n: 1, doc: { _id: 1, a: {}, b: 1 } },
        { n: 2, doc: { _id: 2, a: {}, b: 2 } },
      ])
      expect(await c.findOne({ _id: 1 as never })).toEqual({ _id: 1, a: { x: 1 }, b: 1 })
      expect(await c.findOne({ _id: 2 as never })).toEqual({ _id: 2, a: {}, b: 2 })
      const up = writer('upsert', failed, ['_id'], { gate, updateOnly: true })
      await up.w.write([
        { n: 3, doc: { _id: 5, v: 1 } },
        { n: 4, doc: { _id: 6, v: 1 } },
      ])
      expect(await c.findOne({ _id: 5 as never })).toEqual({ _id: 5, v: 1 })
      expect(await c.findOne({ _id: 6 as never })).toBeNull()
      expect(up.counts).toMatchObject({ matched: 1, upserted: 0 })
      expect(failed).toEqual([])
    })

  // Review of the data fixes (I3): "update only" records that match nothing are counted as skipped
  // on both paths, so every record read is accounted for.
  it('counts what "update only" skips, on both paths alike', async () => {
    const c = client.db('tw').collection('c')
    for (const gate of [null, OPEN_GATE]) {
      await c.deleteMany({})
      await c.insertOne({ _id: 1, v: 0 } as never)
      for (const mode of ['upsert', 'merge'] as const) {
        const w = writer(mode, [], ['_id'], { gate, updateOnly: true })
        await w.w.write([
          { n: 1, doc: { _id: 1, v: 1 } },
          { n: 2, doc: { _id: 2, v: 1 } },
          { n: 3, doc: { _id: 3, v: 1 } },
        ])
        expect(w.counts, `${mode} ${gate ? 'restricted' : 'open'}`).toMatchObject({
          matched: 1,
          skipped: 2,
          upserted: 0,
        })
      }
    }
  })

  // Review of the data fixes (minor): a merge with nothing to set changes nothing stored — skipped on
  // both paths, never "matched" on one and "skipped" on the other.
  it('counts a merge with nothing to set the same on both paths', async () => {
    const c = client.db('tw').collection('c')
    for (const gate of [null, OPEN_GATE]) {
      await c.deleteMany({})
      await c.insertOne({ _id: 1, a: { x: 1 } } as never)
      const w = writer('merge', [], ['_id'], { gate })
      await w.w.write([
        { n: 1, doc: { _id: 1, a: {} } },
        { n: 2, doc: { _id: 2, a: {} } },
      ])
      expect(w.counts, gate ? 'restricted' : 'open').toMatchObject({ matched: 0, skipped: 1, upserted: 1 })
    }
  })

  // Review of the data fixes (I4): a batch the server failed as a whole may or may not be stored:
  // its records are uncertain, never "not written".
  it('counts the records of a batch failed as a whole as uncertain', async () => {
    const { w, counts } = writer('insert', [])
    const c = client.db('tw').collection('c')
    const spy = vi.spyOn(c.constructor.prototype, 'bulkWrite').mockRejectedValueOnce(new Error('network'))
    await expect(
      w.write([
        { n: 1, doc: { _id: 1 } },
        { n: 2, doc: { _id: 2 } },
      ]),
    ).rejects.toThrow('network')
    spy.mockRestore()
    expect(counts).toMatchObject({ inserted: 0, uncertain: 2 })
  })

  it('matches key values as values ($eq)', () => {
    expect(keyFilter(['k'], { k: { $ne: null } })).toEqual({ k: { $eq: { $ne: null } } })
  })
})
