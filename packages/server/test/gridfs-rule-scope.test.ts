// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { compileRules } from '../src/masking/match'
import { bucketOf, bucketRuled, bucketWriteRuled } from '../src/masking/gridfs'
import { missingRules } from '../src/transfer/copy-access'

/**
 * User report 2026-10-27 and its review: a GridFS bucket holds personal data where a rule reaches it —
 * its files, its chunks, every collection of its database or of every database.
 */
describe('a bucket a rule reaches', () => {
  it('is named from either of its collections, and none from another', () => {
    expect(bucketOf('photos.chunks')).toBe('photos')
    expect(bucketOf('photos.files')).toBe('photos')
    expect(bucketOf('x.files.chunks')).toBe('x.files')
    expect(bucketOf('orders')).toBeNull()
  })

  it('is reached by a rule of its files, its chunks, its database or every database', () => {
    const reached = (rules: Parameters<typeof compileRules>[0], db = 'app', coll = 'fs.chunks') =>
      bucketRuled(compileRules(rules), db, coll)
    expect(reached([{ db: 'app', coll: 'fs.files', field: 'x' }])).toBe(true)
    expect(reached([{ db: 'app', coll: 'fs.chunks', field: 'data' }], 'app', 'fs.files')).toBe(true)
    expect(reached([{ db: 'app', coll: '*', field: 'x' }])).toBe(true)
    expect(reached([{ db: '*', coll: '*', field: 'x' }])).toBe(true)
    expect(reached([{ db: 'app', coll: 'photos.files', field: 'x' }])).toBe(false)
    expect(reached([{ db: 'crm', coll: '*', field: 'x' }])).toBe(false)
    expect(reached([{ db: 'app', coll: 'fs.files', field: 'x' }], 'app', 'orders')).toBe(false)
    expect(bucketRuled(null, 'app', 'fs.chunks')).toBe(false)
  })

  it('is written into by name: a bucket by its rules, another collection by its own', () => {
    const masker = compileRules([
      { db: 'app', coll: 'photos.files', field: 'x' },
      { db: 'app', coll: 'people', field: 'email' },
    ])
    expect(bucketWriteRuled(masker, 'fs.chunks', 'app', 'photos.chunks')).toBe(true)
    expect(bucketWriteRuled(masker, 'plain', 'app', 'photos.files')).toBe(true)
    expect(bucketWriteRuled(masker, 'fs.chunks', 'app', 'people')).toBe(true)
    expect(bucketWriteRuled(masker, 'fs.chunks', 'app', 'loot')).toBe(false)
    expect(bucketWriteRuled(masker, 'fs.chunks', 'app', 'fs.chunks')).toBe(false)
    // Neither is a bucket's: left to the documents' own write gate.
    expect(bucketWriteRuled(masker, 'plain', 'app', 'people')).toBe(false)
    expect(bucketWriteRuled(null, 'fs.chunks', 'app', 'photos.chunks')).toBe(false)
  })
})

// Review of the rule scope (M2): a restore carrying a ruled bucket's contents under any name asks the
// target to cover them.
describe('the rules a restore or copy target lacks', () => {
  it('counts a ruled bucket’s contents as personal data the target must cover', () => {
    const src = [{ db: 'app', coll: 'fs.files', field: 'metadata.owner' }]
    expect(missingRules(src, { db: 'app', coll: 'fs.chunks' }, [], { db: 'b', coll: 'loot' })).toEqual([
      { db: 'b', coll: 'loot', field: 'data' },
    ])
    expect(
      missingRules(src, { db: 'app', coll: 'fs.chunks' }, [{ db: 'b', coll: 'loot', field: 'data' }], {
        db: 'b',
        coll: 'loot',
      }),
    ).toEqual([])
    // A bucket no rule reaches carries none.
    expect(
      missingRules([{ db: 'app', coll: 'orders', field: 'email' }], { db: 'app', coll: 'fs.chunks' }, [], {
        db: 'b',
        coll: 'loot',
      }),
    ).toEqual([])
  })
})

// Review of the rule scope (nit): a join into another database reads its own names there — a nested
// join's bare name is that database's, not the outer one's.
describe('a nested join’s bucket', () => {
  it('is judged in the database its outer join reads', async () => {
    const { guardAggregate } = await import('../src/masking/gate')
    const deps = {
      masker: compileRules([{ db: 'other', coll: 'fs.files', field: 'metadata.owner' }]),
      view: async () => null,
      indexes: async () => [],
    }
    const nested = (from: string) => [
      {
        $lookup: {
          from: { db: 'other', coll: 'notes' },
          pipeline: [{ $lookup: { from, pipeline: [], as: 'c' } }],
          as: 'n',
        },
      },
    ]
    await expect(guardAggregate('app', 'plain', nested('fs.chunks'), deps)).rejects.toMatchObject({
      statusCode: 403,
    })
    await expect(guardAggregate('app', 'plain', nested('photos.chunks'), deps)).resolves.toBeDefined()
  })
})
