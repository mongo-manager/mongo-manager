import { describe, expect, it } from 'vitest'
import { Code, DBRef, EJSON, ObjectId } from 'bson'
import {
  BulkRequestSchema,
  CreateCollectionSchema,
  CreateIndexSchema,
  FindRequestSchema,
  UpdateRequestSchema,
  findServerJs,
} from '../src/api/data'

describe('findServerJs', () => {
  it('finds $where, $function and $accumulator anywhere', () => {
    expect(findServerJs({ a: 1 })).toBeNull()
    expect(findServerJs({ $where: 'this.a > 1' })).toBe('$where')
    expect(
      findServerJs({ $and: [{ x: 1 }, { $expr: { $function: { body: 'f', args: [], lang: 'js' } } }] }),
    ).toBe('$function')
    expect(findServerJs([{ $group: { _id: null, v: { $accumulator: {} } } }])).toBe('$accumulator')
    expect(findServerJs({ _id: new ObjectId(), code: new Code('x') })).toBeNull()
  })

  // Security review 2026-10-16 (I-1): MongoDB's internal operators run JavaScript too —
  // $_internalJsEmit in a $project and $_internalJsReduce in a $group ran on 6.0, 7.0 and 8.2.
  it('finds the internal operators: those that run JavaScript, and any other (fail closed)', () => {
    const emit = { $_internalJsEmit: { eval: 'function () { emit(this._id, 42) }', this: '$$ROOT' } }
    expect(findServerJs([{ $project: { e: emit } }])).toBe('$_internalJsEmit')
    expect(
      findServerJs([
        {
          $group: { _id: null, r: { $_internalJsReduce: { data: { k: 1, v: 1 }, eval: 'function () {}' } } },
        },
      ]),
    ).toBe('$_internalJsReduce')
    expect(findServerJs({ $expr: { $_internalSomethingNew: 1 } })).toBe('$_internalSomethingNew')
    expect(findServerJs({ a: { _internalJsEmit: 1 } })).toBeNull()
  })

  // Security review 2026-10-16 (I-5): an object whose only $-keys are $ref/$id/$db becomes a DBRef
  // when parsed, and a DBRef was a leaf: what sat beside $ref was never looked at.
  it('looks inside a DBRef’s other fields and its id', () => {
    const where = { $where: 'sleep(100) || true' }
    expect(findServerJs({ x: new DBRef('c', 1 as never, 'db', { inner: { $or: [where] } }) })).toBe('$where')
    expect(findServerJs([new DBRef('c', { $expr: { $function: { body: 'f' } } } as never)])).toBe('$function')
    expect(findServerJs(EJSON.parse('{"$ref":"c","$id":1,"x":{"$or":[{"$where":"true"}]}}'))).toBe('$where')
    expect(findServerJs({ x: new DBRef('c', new ObjectId()) })).toBeNull()
  })
})

describe('request schemas', () => {
  it('applies find defaults and caps', () => {
    expect(FindRequestSchema.parse({})).toEqual({
      filter: {},
      skip: 0,
      limit: 20,
      maxTimeMS: 30_000,
      remember: true,
      // W1 review (minor 3): kept in the history unless the app reads for the user (the chart).
      record: true,
    })
    for (const bad of [
      { limit: 0 },
      { limit: 1001 },
      { skip: -1 },
      { skip: 1e10 },
      { maxTimeMS: 10 },
      { filter: [] },
    ]) {
      expect(FindRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('validates update paths and requires a change', () => {
    const hash = '0'.repeat(64)
    expect(UpdateRequestSchema.safeParse({ _id: 1, set: {}, unset: [], hash }).success).toBe(false)
    expect(UpdateRequestSchema.safeParse({ _id: 1, set: { $inc: 1 }, hash }).success).toBe(false)
    expect(UpdateRequestSchema.safeParse({ _id: 1, unset: ['a', '$b'], hash }).success).toBe(false)
    expect(UpdateRequestSchema.safeParse({ _id: 1, set: { a: 1 }, unset: ['a'], hash }).success).toBe(false)
    expect(UpdateRequestSchema.parse({ _id: 1, set: { 'a.b': 1 }, hash })).toMatchObject({
      set: { 'a.b': 1 },
      unset: [],
    })
    expect(UpdateRequestSchema.safeParse({ _id: 1, set: { a: 1 } }).success).toBe(false)
  })

  it('accepts update documents or pipelines for bulk updates, never replacements', () => {
    expect(
      BulkRequestSchema.safeParse({ filter: {}, operation: 'update', update: { $set: { a: 1 } } }).success,
    ).toBe(true)
    expect(
      BulkRequestSchema.safeParse({ filter: {}, operation: 'update', update: [{ $set: { a: 1 } }] }).success,
    ).toBe(true)
    expect(BulkRequestSchema.safeParse({ filter: {}, operation: 'update', update: { a: 1 } }).success).toBe(
      false,
    )
    expect(BulkRequestSchema.safeParse({ filter: {}, operation: 'update' }).success).toBe(false)
    expect(BulkRequestSchema.safeParse({ filter: {}, operation: 'delete' }).success).toBe(true)
  })

  it('describes every collection kind', () => {
    for (const ok of [
      { kind: 'collection', name: 'a' },
      { kind: 'collection', name: 'a', clustered: true },
      { kind: 'capped', name: 'a', size: 4096, max: 10 },
      {
        kind: 'timeseries',
        name: 'a',
        timeField: 't',
        metaField: 'm',
        granularity: 'minutes',
        expireAfterSeconds: 60,
      },
      { kind: 'view', name: 'a', viewOn: 'b', pipeline: [{ $match: {} }] },
    ]) {
      expect(CreateCollectionSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true)
    }
    expect(CreateCollectionSchema.safeParse({ kind: 'capped', name: 'a', size: 10 }).success).toBe(false)
    expect(CreateCollectionSchema.safeParse({ kind: 'collection', name: 'a$b' }).success).toBe(false)
  })

  it('checks index keys', () => {
    expect(CreateIndexSchema.safeParse({ key: { a: 1, b: -1 } }).success).toBe(true)
    expect(CreateIndexSchema.safeParse({ key: { t: 'text' }, options: { weights: { t: 2 } } }).success).toBe(
      true,
    )
    expect(CreateIndexSchema.safeParse({ key: { '$**': 1 } }).success).toBe(true)
    expect(CreateIndexSchema.safeParse({ key: {} }).success).toBe(false)
    expect(CreateIndexSchema.safeParse({ key: { a: 'sideways' } }).success).toBe(false)
  })
})
