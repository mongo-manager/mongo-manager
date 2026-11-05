// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { Document } from 'mongodb'
import { Int32 } from 'bson'
import type { ServerLevel } from '../src/backup/series'
import {
  createOptions,
  indexPlan,
  optionsTargetMayRefuse,
  sameBucketing,
  uniqueOverMask,
  viewOrder,
} from '../src/transfer/collection-spec'

const want = { options: true, validator: true }

describe('collection spec allowlists (phase 3d-2 spec §7.3)', () => {
  it('keeps allowed options, drops others, and skips encrypted collections', () => {
    expect(
      createOptions(
        {
          name: 'm',
          type: 'timeseries',
          options: {
            timeseries: {
              timeField: 't',
              metaField: 'm',
              granularity: 'hours',
              bucketMaxSpanSeconds: 3600,
              extra: 1,
            },
            expireAfterSeconds: 60,
            storageEngine: { wiredTiger: { configString: 'x' } },
            uuid: 'u',
          },
        },
        want,
        false,
      ),
    ).toEqual({
      options: {
        timeseries: { timeField: 't', metaField: 'm', granularity: 'hours', bucketMaxSpanSeconds: 3600 },
        expireAfterSeconds: 60,
      },
    })
    expect(
      createOptions({ name: 'e', type: 'collection', options: { encryptedFields: {} } }, want, false),
    ).toEqual({
      skip: 'Encrypted (Queryable Encryption) collections are not copied',
    })
  })

  it('refuses a validator that runs JavaScript unless server-side JavaScript is allowed, and honours the switches', () => {
    const info = {
      name: 'v',
      type: 'collection',
      options: { validator: { $where: 'true' }, capped: true, size: 4096 },
    }
    expect(createOptions(info, want, false)).toEqual({ skip: expect.stringMatching(/\$where/) })
    expect(createOptions(info, want, true)).toEqual({
      options: { validator: { $where: 'true' }, capped: true, size: 4096 },
    })
    expect(createOptions(info, { options: false, validator: false }, false)).toEqual({ options: {} })
    // Security review 2026-10-16 (I-1): MongoDB's internal JavaScript operators too.
    const internal = {
      ...info,
      options: { validator: { $expr: { $_internalJsEmit: { eval: 'f', this: '$$ROOT' } } } },
    }
    expect(createOptions(internal, want, false)).toEqual({ skip: expect.stringMatching(/\$_internalJsEmit/) })
  })

  it('builds indexes from the allowlist, reports TTL indexes and skips bad or personal unique ones', () => {
    const plan = indexPlan(
      [
        { v: 2, key: { _id: 1 }, name: '_id_' },
        { v: 2, key: { email: 1 }, name: 'email_1', unique: true, ns: 'x.y', background: true },
        { v: 2, key: { at: 1 }, name: 'ttl', expireAfterSeconds: 3600 },
        { v: 2, key: { a: 'bogus' }, name: 'bad' },
        { v: 2, key: { phone: 1 }, name: 'phone_1', unique: true },
        { v: 2, key: { '$**': 1 }, name: 'wild', wildcardProjection: { a: 1 } },
      ],
      (key) => 'phone' in key,
    )
    expect(plan.build).toEqual([
      { key: { email: 1 }, name: 'email_1', unique: true },
      { key: { at: 1 }, name: 'ttl', expireAfterSeconds: 3600 },
      { key: { '$**': 1 }, name: 'wild', wildcardProjection: { a: 1 } },
    ])
    expect(plan.ttl).toEqual(['ttl'])
    expect(plan.skipped.map((s) => s.name)).toEqual(['bad', 'phone_1'])
  })

  it('orders views after what they read, and reports cycles', () => {
    const v = (name: string, viewOn: string, pipeline: object[] = []) => ({ name, viewOn, pipeline })
    const { ordered, cyclic } = viewOrder([
      v('c', 'b'),
      v('b', 'a'),
      v('a', 'orders'),
      v('d', 'orders', [{ $lookup: { from: 'c', localField: 'x', foreignField: 'y', as: 'z' } }]),
      v('x', 'y'),
      v('y', 'x'),
    ])
    expect(ordered.map((o) => o.name)).toEqual(['a', 'b', 'c', 'd'])
    expect(cyclic.sort()).toEqual(['x', 'y'])
  })
})

describe('unique indexes over masked paths (phase 3e-2; also the 3d-2 copy)', () => {
  it('finds a masked path in the key or the partial filter, wildcard rules included', () => {
    const idx = (key: object, extra: object = {}) => ({ key, name: 'x', unique: true, ...extra })
    expect(uniqueOverMask(idx({ email: 1 }), [['email']])).toBe(true)
    expect(uniqueOverMask(idx({ 'contact.email': 1 }), [['**', 'email']])).toBe(true)
    expect(uniqueOverMask(idx({ contact: 1 }), [['contact', 'email']])).toBe(true)
    expect(
      uniqueOverMask(idx({ n: 1 }, { partialFilterExpression: { email: { $exists: true } } }), [['email']]),
    ).toBe(true)
    expect(uniqueOverMask(idx({ n: 1 }), [['email']])).toBe(false)
    expect(uniqueOverMask({ key: { email: 1 }, name: 'x' }, [['email']])).toBe(false)
    expect(uniqueOverMask(idx({ email: 1 }), null)).toBe(false)
  })
})

// MongoDB 9.0 (local run, 2026-10-20; review of db45c424): what a server takes is set by its
// feature level, its FCV (a 9.0 at FCV 8.0 refuses fixedBucketing too); unread, the lowest its
// release may run at. Found on 9.0.4, 8.3.13, 8.2.6, 8.0.34, 7.0.45 and 6.0.29: 9.0 lists
// fixedBucketing on every series, and 8.3 on build 2dsphereIndexVersion 4; neither is taken below
// those levels. A series' own bucketing (bucketRoundingSeconds) needs 6.3, and without it 6.0
// refuses its bucketMaxSpanSeconds too.
const at = (fcv: [number, number] | null, release: [number, number] | null = fcv): ServerLevel => ({
  fcv,
  release,
})
const series = (ts: Document) => ({ name: 's', type: 'timeseries', options: { timeseries: ts } })
const nine = { timeField: 't', granularity: 'hours', bucketMaxSpanSeconds: 2592000, fixedBucketing: true }
const custom = { timeField: 't', bucketRoundingSeconds: 600, bucketMaxSpanSeconds: 600 }

describe("options by the target's feature level", () => {
  it('keeps fixedBucketing where the target takes it, and a false one where its release may', () => {
    const made = (ts: Document, level: ServerLevel | null) =>
      (createOptions(series(ts), want, false, level) as { options: Document }).options.timeseries
    expect(made(nine, at([9, 0]))).toEqual(nine)
    expect(made(nine, at([8, 0], [9, 0]))).not.toHaveProperty('fixedBucketing')
    expect(made(nine, at([8, 0]))).not.toHaveProperty('fixedBucketing')
    expect(made(nine, null)).not.toHaveProperty('fixedBucketing')
    // FCV unread: a 9.0 may still run at 8.0, which refuses either. Leaving it out loses nothing
    // (review of 8e719ba7, I-2), so it is left out, true or false (review of d7ddbaae).
    expect(made(nine, at(null, [9, 0]))).not.toHaveProperty('fixedBucketing')
    expect(made({ ...nine, fixedBucketing: false }, at(null, [9, 0]))).not.toHaveProperty('fixedBucketing')
    // Review of 69adc29a (I-1): an FCV that was read decides, even below its release.
    expect(made({ ...nine, fixedBucketing: false }, at([9, 0]))).toMatchObject({ fixedBucketing: false })
  })

  // Review of 8e719ba7 (I-2): a false one is a series' own (made so, or after a change of its
  // bucketing); no wrong answer came of leaving it out where the target cannot take it (8.0.34,
  // 8.2.6 and 9.0.4, six query shapes), so the series is made, without it, as before.
  it('leaves a false fixedBucketing out where the target cannot take it, and keeps the series', () => {
    const own = series({ ...nine, fixedBucketing: false })
    for (const level of [at([8, 0], [9, 0]), at(null, [9, 0]), at([8, 3]), at([6, 0])]) {
      const made = createOptions(own, want, false, level) as { options: Document }
      expect(made.options.timeseries).not.toHaveProperty('fixedBucketing')
    }
  })

  it('skips a series whose own bucketing the target cannot have, never guessing', () => {
    expect(createOptions(series(custom), want, false, at([6, 0]))).toEqual({
      skip: 'Its own bucketing (bucketRoundingSeconds) needs MongoDB 6.3 or later on the target',
    })
    expect(createOptions(series(custom), want, false, at(null, [6, 0]))).toHaveProperty('skip')
    expect(createOptions(series(custom), want, false, at([6, 3]))).toEqual({
      options: { timeseries: custom },
    })
    expect(createOptions(series(custom), want, false, null)).toEqual({ options: { timeseries: custom } })
    expect(createOptions(series({ timeField: 't', granularity: 'hours' }), want, false, at([6, 0]))).toEqual({
      options: { timeseries: { timeField: 't', granularity: 'hours' } },
    })
  })

  it('leaves 2dsphereIndexVersion 4 to a target before 8.3, and keeps it otherwise', () => {
    const geo = { key: { loc: '2dsphere' }, name: 'loc_2dsphere', '2dsphereIndexVersion': 4 }
    const built = (level?: ServerLevel | null) => indexPlan([geo], () => false, level).build
    expect(built(at([8, 2]))).toEqual([{ key: { loc: '2dsphere' }, name: 'loc_2dsphere' }])
    expect(built(at([8, 0], [8, 3]))).toEqual([{ key: { loc: '2dsphere' }, name: 'loc_2dsphere' }])
    expect(built(null)).toEqual([{ key: { loc: '2dsphere' }, name: 'loc_2dsphere' }])
    expect(built(at([8, 3]))).toEqual([geo])
    // A backup keeps what the server listed.
    expect(built()).toEqual([geo])
    const three = { ...geo, '2dsphereIndexVersion': 3 }
    expect(indexPlan([three], () => false, at([6, 0])).build).toEqual([three])
  })

  it('names what mongorestore would pass that the target may refuse', () => {
    const meta = (ts: Document | null, indexes: Document[] = []) => ({
      options: ts ? { timeseries: ts } : {},
      indexes,
    })
    const geo4 = { key: { loc: '2dsphere' }, name: 'g', '2dsphereIndexVersion': 4 }
    expect(optionsTargetMayRefuse(meta(nine), at([8, 0]), '9.0.4', true)).toEqual(['fixedBucketing'])
    expect(optionsTargetMayRefuse(meta(nine), at([9, 0]), '9.0.4', true)).toEqual([])
    // FCV unread: a 9.0 may still run at 8.0.
    expect(optionsTargetMayRefuse(meta(nine), at(null, [9, 0]), '9.0.4', true)).toEqual(['fixedBucketing'])
    expect(optionsTargetMayRefuse(meta(custom), at([6, 0]), '8.0.34', true)).toEqual([
      'bucketRoundingSeconds',
    ])
    expect(optionsTargetMayRefuse(meta(null, [geo4]), at([8, 0]), '9.0.4', true)).toEqual([
      '2dsphereIndexVersion 4',
    ])
    expect(optionsTargetMayRefuse(meta(null, [geo4]), at([8, 0]), '9.0.4', false)).toEqual([])
    expect(optionsTargetMayRefuse(meta(null, [geo4]), at([8, 3]), '9.0.4', true)).toEqual([])
    // As an archive's canonical EJSON gives it: an Int32.
    const archived = { ...geo4, '2dsphereIndexVersion': new Int32(4) }
    expect(optionsTargetMayRefuse(meta(null, [archived]), at([8, 0]), '9.0.4', true)).toEqual([
      '2dsphereIndexVersion 4',
    ])
    expect(indexPlan([archived], () => false, at([8, 0])).build).toEqual([
      { key: { loc: '2dsphere' }, name: 'g' },
    ])
    // An option no release here knows, from a newer server than the target.
    expect(optionsTargetMayRefuse(meta({ timeField: 't', later: 1 }), at([9, 0]), '9.2.0', true)).toEqual([
      'later',
    ])
    expect(optionsTargetMayRefuse(meta({ timeField: 't', later: 1 }), at([9, 2]), '9.2.0', true)).toEqual([])
    expect(optionsTargetMayRefuse(meta(null), at([6, 0]), '9.0.4', true)).toEqual([])
  })
})

// Review of 69adc29a (I-3): buckets written into an existing series must follow its bucketing, or
// a query by time misses them (seen on 8.2.6: a span of 86400 written into one of 3600).
describe('the same bucketing', () => {
  it('by granularity, or by its own span and rounding', () => {
    const hours = { timeField: 't', granularity: 'hours', bucketMaxSpanSeconds: 2592000 }
    const own = { timeField: 't', bucketRoundingSeconds: 600, bucketMaxSpanSeconds: 600 }
    expect(sameBucketing(hours, { timeField: 't', granularity: 'hours' })).toBe(true)
    expect(sameBucketing({ timeField: 't' }, { timeField: 't', granularity: 'seconds' })).toBe(true)
    expect(sameBucketing(hours, { timeField: 't' })).toBe(false)
    expect(sameBucketing(own, { ...own })).toBe(true)
    expect(sameBucketing(own, { ...own, bucketRoundingSeconds: new Int32(600) })).toBe(true)
    expect(sameBucketing(own, { ...own, bucketMaxSpanSeconds: 1200, bucketRoundingSeconds: 1200 })).toBe(
      false,
    )
    expect(sameBucketing(own, { ...own, bucketRoundingSeconds: 300 })).toBe(false)
    expect(sameBucketing(own, { timeField: 't' })).toBe(false)
    expect(sameBucketing({ timeField: 't' }, own)).toBe(false)
    // Review of 8e719ba7 (I-2): fixedBucketing is not part of it (no wrong answer came of it).
    expect(sameBucketing({ ...own, fixedBucketing: true }, { ...own, fixedBucketing: false })).toBe(true)
    // An older target says no fixedBucketing: a source's own true one is its default there.
    expect(sameBucketing(own, { ...own, fixedBucketing: true })).toBe(true)
  })
})

// Review of 69adc29a (I-4): errorAndLog arrived in 8.1; below it a create with it is refused
// ("Enumeration value 'errorAndLog'"), and the whole job stopped. Said in the plan instead.
describe('a validation action of a later release', () => {
  const v = {
    name: 'c',
    type: 'collection',
    options: { validator: { a: { $type: 'int' } }, validationAction: 'errorAndLog' },
  }
  it('skips the collection where its validator is wanted, and is said to mongorestore', () => {
    expect(createOptions(v, want, false, at([8, 0]))).toEqual({
      skip: 'Its validation action errorAndLog needs MongoDB 8.1 or later on the target: leave its validator out to write it without one',
    })
    expect(createOptions(v, { options: true, validator: false }, false, at([8, 0]))).toEqual({ options: {} })
    expect(createOptions(v, want, false, at([8, 1]))).toHaveProperty(
      'options.validationAction',
      'errorAndLog',
    )
    expect(optionsTargetMayRefuse({ options: v.options, indexes: [] }, at([8, 0]), '8.2.6', true)).toEqual([
      'validationAction errorAndLog',
    ])
    expect(optionsTargetMayRefuse({ options: v.options, indexes: [] }, at([8, 2]), '8.2.6', true)).toEqual([])
  })
})

// Review of 69adc29a (M-3): a compound wildcard index (7.0 on) is refused by 6.0 ("wildcard indexes
// do not allow compounding"); the built-in engine skips it, saying why, and mongorestore is told.
describe('an index kind of a later release', () => {
  it('names a compound wildcard index to mongorestore below 7.0', () => {
    const compound = { key: { 'a.$**': 1, b: 1 }, name: 'cw' }
    const plain = { key: { '$**': 1 }, name: 'w' }
    const of = (ix: Document, level: ServerLevel) =>
      optionsTargetMayRefuse({ options: {}, indexes: [ix] }, level, '8.0.34', true)
    expect(of(compound, at([6, 0]))).toEqual(['compound wildcard index cw'])
    // The plan bounds what it says; a long name is given whole here.
    expect(of({ ...compound, name: 'n'.repeat(80) }, at([6, 0]))).toEqual([
      `compound wildcard index ${'n'.repeat(80)}`,
    ])
    expect(of(compound, at([7, 0]))).toEqual([])
    expect(of(plain, at([6, 0]))).toEqual([])
  })
})
