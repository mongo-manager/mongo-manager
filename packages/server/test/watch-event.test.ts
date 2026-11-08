// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Int32, Long, ObjectId, Timestamp } from 'mongodb'
import { compileRules } from '../src/masking/match'
import { maskChangeEvent } from '../src/masking/change-event'
import { ELIDE_BYTES, toWatchEvent } from '../src/changestreams/event'

const oid = new ObjectId('64b7f0c2a1b2c3d4e5f60718')
const ts = new Timestamp({ t: 1_790_000_000, i: 3 })
const rules = compileRules([
  { db: 'shop', coll: 'orders', field: 'email' },
  { db: 'shop', coll: '*', field: 'card.number' },
  { db: 'shop', coll: 'orders', field: 'items.secret' },
])
const base = { seq: 1, masker: null, admin: false }

// Security review 2026-10-13 round 2 (I1): a bucket's chunks are its files' contents; where
// personal fields are hidden, a database or server feed shows no change of them.
describe('a change in GridFS file contents, for a user who cannot see personal data', () => {
  it('is not shown', () => {
    const chunk = {
      operationType: 'insert',
      clusterTime: ts,
      ns: { db: 'shop', coll: 'fs.chunks' },
      documentKey: { _id: oid },
      fullDocument: { _id: oid, files_id: oid, n: 0, data: 'secret' },
    }
    expect(toWatchEvent(chunk, { ...base, masker: rules })).toBeNull()
    expect(toWatchEvent(chunk, base)).not.toBeNull()
    expect(
      toWatchEvent({ ...chunk, ns: { db: 'shop', coll: 'fs.files' } }, { ...base, masker: rules }),
    ).not.toBeNull()
    // User report 2026-10-27: rules on another database only — this bucket holds no personal data.
    const elsewhere = compileRules([{ db: 'crm', coll: '*', field: 'email' }])
    expect(toWatchEvent(chunk, { ...base, masker: elsewhere })).not.toBeNull()
    // Nor another bucket's rule in the same database.
    const otherBucket = compileRules([{ db: 'shop', coll: 'photos.files', field: 'owner' }])
    expect(toWatchEvent(chunk, { ...base, masker: otherBucket })).not.toBeNull()
    const thisBucket = compileRules([{ db: 'shop', coll: 'fs.files', field: 'owner' }])
    expect(toWatchEvent(chunk, { ...base, masker: thisBucket })).toBeNull()
  })
})

describe('a change event as the web sees it (phase 3e-1 spec §1.5)', () => {
  it('keeps the event in canonical EJSON and drops the resume token, session and UUID', () => {
    const e = toWatchEvent(
      {
        _id: { _data: '8264' },
        operationType: 'insert',
        clusterTime: ts,
        wallTime: new Date(1_790_000_000_123),
        ns: { db: 'shop', coll: 'orders' },
        documentKey: { _id: oid },
        fullDocument: { _id: oid, n: new Int32(5), big: Long.fromString('9007199254740993') },
        lsid: { id: 'x' },
        txnNumber: new Long(1),
        collectionUUID: 'u',
      },
      base,
    )!
    expect(e).toEqual({
      seq: 1,
      op: 'insert',
      ns: { db: 'shop', coll: 'orders' },
      documentKey: { _id: { $oid: oid.toHexString() } },
      fullDocument: {
        _id: { $oid: oid.toHexString() },
        n: { $numberInt: '5' },
        big: { $numberLong: '9007199254740993' },
      },
      clusterTime: 1_790_000_000,
      wallTime: 1_790_000_000_123,
      masked: false,
      bytes: expect.any(Number),
    })
  })

  it('carries an update description: values by path, removed names, truncated sizes', () => {
    const e = toWatchEvent(
      {
        operationType: 'update',
        clusterTime: ts,
        ns: { db: 'shop', coll: 'orders' },
        documentKey: { _id: oid },
        updateDescription: {
          updatedFields: { 'a.b': new Int32(1) },
          removedFields: ['gone'],
          truncatedArrays: [{ field: 'list', newSize: new Int32(2) }],
        },
      },
      base,
    )!
    expect(e.update).toEqual({
      updated: { 'a.b': { $numberInt: '1' } },
      removed: ['gone'],
      truncated: [{ field: 'list', newSize: 2 }],
    })
  })

  it('names a rename target, and keeps a database event without a collection', () => {
    expect(
      toWatchEvent(
        {
          operationType: 'rename',
          clusterTime: ts,
          ns: { db: 'shop', coll: 'a' },
          to: { db: 'shop', coll: 'b' },
        },
        base,
      ),
    ).toMatchObject({ op: 'rename', ns: { db: 'shop', coll: 'a' }, to: { db: 'shop', coll: 'b' } })
    expect(
      toWatchEvent({ operationType: 'dropDatabase', clusterTime: ts, ns: { db: 'shop' } }, base),
    ).toMatchObject({
      ns: { db: 'shop' },
    })
  })

  it('hides credential collections from all but the connection administrators (plan ruling 8)', () => {
    const users = {
      operationType: 'insert',
      clusterTime: ts,
      ns: { db: 'admin', coll: 'system.users' },
      documentKey: { _id: 'a' },
    }
    expect(toWatchEvent(users, base)).toBeNull()
    expect(toWatchEvent(users, { ...base, admin: true })).not.toBeNull()
    expect(
      toWatchEvent(
        {
          operationType: 'rename',
          clusterTime: ts,
          ns: { db: 'x', coll: 'a' },
          to: { db: 'admin', coll: 'system.users' },
        },
        base,
      ),
    ).toBeNull()
  })

  it('elides any part above the size limit out of band, and keeps the rest', () => {
    const big = 'x'.repeat(ELIDE_BYTES + 1)
    const e = toWatchEvent(
      {
        operationType: 'update',
        clusterTime: ts,
        ns: { db: 'shop', coll: 'orders' },
        documentKey: { _id: oid },
        fullDocument: { _id: oid, big },
        fullDocumentBeforeChange: { _id: oid, big },
        updateDescription: { updatedFields: { big }, removedFields: ['gone'], truncatedArrays: [] },
      },
      base,
    )!
    // Phase 3e-1 final review C1, I6: no marker inside a document's own fields; every part is bounded.
    expect(e.fullDocument).toBeUndefined()
    expect(e.before).toBeUndefined()
    expect(e.update).toEqual({ updated: {}, removed: [], truncated: [] })
    expect(e.elided).toEqual({
      fullDocument: expect.any(Number),
      before: expect.any(Number),
      update: expect.any(Number),
    })
    expect(e.documentKey).toEqual({ _id: { $oid: oid.toHexString() } })
    expect(e.bytes).toBe(Buffer.byteLength(JSON.stringify({ ...e, bytes: 0 })))
    expect(e.bytes).toBeLessThan(ELIDE_BYTES)
  })

  it('elides a huge document key and description too', () => {
    const big = 'x'.repeat(ELIDE_BYTES + 1)
    const e = toWatchEvent(
      {
        operationType: 'createIndexes',
        clusterTime: ts,
        ns: { db: 'shop', coll: 'orders' },
        documentKey: { _id: big },
        operationDescription: { indexes: [{ name: big }] },
      },
      base,
    )!
    expect(e.documentKey).toBeUndefined()
    expect(e.description).toBeUndefined()
    expect(Object.keys(e.elided!).sort()).toEqual(['description', 'documentKey'])
  })
})

describe('masking a change event (phase 3e-1 spec §3 W3, masking 3c §6)', () => {
  it('masks the document, the key, the before-image and updated values by path', () => {
    const e = toWatchEvent(
      {
        operationType: 'update',
        clusterTime: ts,
        ns: { db: 'shop', coll: 'orders' },
        documentKey: { _id: oid, email: 'a@x' },
        fullDocument: {
          _id: oid,
          email: 'a@x',
          card: { number: '4111', brand: 'visa' },
          items: [{ secret: 1, ok: 2 }],
        },
        fullDocumentBeforeChange: { _id: oid, email: 'b@x' },
        updateDescription: {
          updatedFields: {
            email: 'c@x',
            'card.number': '4222',
            card: { number: '1', brand: 'mc' },
            'items.0.secret': 9,
            'items.0.ok': 3,
            n: 1,
          },
          removedFields: ['email'],
          truncatedArrays: [{ field: 'items', newSize: 1 }],
        },
      },
      { ...base, masker: rules },
    )!
    expect(e.masked).toBe(true)
    expect(e.documentKey).toEqual({ _id: { $oid: oid.toHexString() }, email: '***' })
    expect(e.fullDocument).toEqual({
      _id: { $oid: oid.toHexString() },
      email: '***',
      card: { number: '***', brand: 'visa' },
      items: [{ secret: '***', ok: { $numberInt: '2' } }],
    })
    expect(e.before).toEqual({ _id: { $oid: oid.toHexString() }, email: '***' })
    expect(e.update).toEqual({
      updated: {
        email: '***',
        'card.number': '***',
        card: { number: '***', brand: 'mc' },
        'items.0.secret': '***',
        'items.0.ok': { $numberInt: '3' },
        n: { $numberInt: '1' },
      },
      removed: ['email'],
      truncated: [{ field: 'items', newSize: 1 }],
    })
  })

  // Phase 3e-1 final review C1: a field named "elided" never switches masking off.
  it('masks a document that carries its own elided: true field', () => {
    const e = toWatchEvent(
      {
        operationType: 'update',
        clusterTime: ts,
        ns: { db: 'shop', coll: 'orders' },
        documentKey: { _id: oid },
        fullDocument: { _id: oid, elided: true, bytes: 1, email: 'a@x' },
        fullDocumentBeforeChange: { _id: oid, elided: true, email: 'b@x' },
        updateDescription: { updatedFields: { elided: true }, removedFields: [], truncatedArrays: [] },
      },
      { ...base, masker: rules },
    )!
    expect(e.fullDocument).toMatchObject({ elided: true, email: '***' })
    expect(e.before).toMatchObject({ elided: true, email: '***' })
    expect(e.elided).toBeUndefined()
    expect(JSON.stringify(e)).not.toMatch(/a@x|b@x/)
  })

  it('leaves an event of a namespace without rules as it is, unmarked', () => {
    const e = toWatchEvent(
      {
        operationType: 'insert',
        clusterTime: ts,
        ns: { db: 'other', coll: 'c' },
        documentKey: { _id: 1 },
        fullDocument: { _id: 1, email: 'a@x' },
      },
      { ...base, masker: rules },
    )!
    expect(e).toMatchObject({ masked: false, fullDocument: { email: 'a@x' } })
  })

  it('masks an expanded event’s description whole for a restricted user (plan ruling 3)', () => {
    const e = toWatchEvent(
      {
        operationType: 'createIndexes',
        clusterTime: ts,
        ns: { db: 'shop', coll: 'orders' },
        operationDescription: { indexes: [{ key: { email: 1 }, partialFilterExpression: { email: 'a@x' } }] },
      },
      { ...base, masker: rules },
    )!
    expect(e.description).toEqual({
      indexes: [{ key: { email: '***' }, partialFilterExpression: { email: '***' } }],
    })
    expect(e.masked).toBe(true)
  })

  it('is the identity for a namespace no rule names', () => {
    const event = {
      bytes: 0,
      seq: 1,
      op: 'insert',
      ns: { db: 'x', coll: 'y' },
      fullDocument: { a: 1 },
      clusterTime: 1,
      masked: false,
    }
    expect(maskChangeEvent(event, rules.forNs('x', 'y'))).toBe(event)
  })
})
