// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { slow } from './support/slowness'

let a: TestMongo
let b: TestMongo
let ca: MongoClient
let cb: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ;[ca, cb] = await Promise.all([
    new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect(),
    new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect(),
  ])
}, slow(180_000))
afterAll(async () => {
  await Promise.all([ca?.close(), cb?.close()])
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  await Promise.all([
    ca.db('shop').dropDatabase(),
    ca.db('copy').dropDatabase(),
    cb.db('shop').dropDatabase(),
    cb.db('copy').dropDatabase(),
  ])
  await ca
    .db('shop')
    .collection('orders')
    .insertMany([{ _id: 1 as never, email: 'x@y', total: 3 }])
  await ca.db('shop').collection('orders').createIndex({ at: 1 }, { expireAfterSeconds: 60, name: 'ttl' })
})

const plan = (id: string) => `/api/connections/${id}/databases/shop/collections/orders/copy/plan`

describe('copy plan (phase 3d-2 spec §3.1, §4, §5)', () => {
  it('describes the target, the path, TTL indexes and the deployment, with a hash', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const body = {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
      }
      const res = await u.call('POST', plan(h.ids.A), body)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({
        collections: [
          { source: 'orders', target: 'orders', exists: false, path: 'stream', ttlIndexes: ['ttl'] },
        ],
        masked: false,
        missingRules: [],
        deployment: 'different',
        refusals: ['confirm_ttl'],
      })
      expect(res.json().planHash).toMatch(/^[0-9a-f]{64}$/)
      const same = { ...body, target: { connectionId: h.ids.A, db: 'copy', coll: 'orders' }, indexes: false }
      const sameRes = await u.call('POST', plan(h.ids.A), same)
      expect(sameRes.json()).toMatchObject({
        collections: [{ path: 'shortcut' }],
        deployment: 'same',
        refusals: [],
      })
    } finally {
      await h.t.close()
    }
  })

  it('refuses a target the user cannot reach (404), cannot write (403), or a system namespace (403)', async () => {
    const h = await transferHarness(a, b)
    try {
      const body = (connectionId: string, db = 'copy') => ({
        source: { kind: 'collection' },
        target: { connectionId, db, coll: 'orders' },
        mode: 'insert',
      })
      const none = h.user({ role: 'editor', on: { B: 'none' } })
      expect((await none.call('POST', plan(h.ids.A), body(h.ids.B))).statusCode).toBe(404)
      expect((await none.call('POST', plan(h.ids.A), body('no-such-id'))).statusCode).toBe(404)
      const viewer = h.user({ role: 'editor', on: { B: 'viewer' } })
      expect((await viewer.call('POST', plan(h.ids.A), body(h.ids.B))).statusCode).toBe(403)
      const admin = h.user({ role: 'admin' })
      expect((await admin.call('POST', plan(h.ids.A), body(h.ids.B, 'admin'))).statusCode).toBe(403)
    } finally {
      await h.t.close()
    }
  })

  it('names the source rules the target lacks, and forces masking for a restricted source', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: '*', field: 'email' }])
      const body = {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
      }
      const free = h.user({ role: 'editor' })
      expect((await free.call('POST', plan(h.ids.A), body)).json()).toMatchObject({
        missingRules: ['copy.orders.email'],
        mayAddRules: false,
        masked: false,
        refusals: ['confirm_personal'],
      })
      const restricted = h.user({ role: 'editor', masked: ['A'] })
      expect((await restricted.call('POST', plan(h.ids.A), body)).json()).toMatchObject({
        masked: true,
        missingRules: [],
        refusals: [],
      })
      h.rules('B', [{ db: 'copy', coll: 'orders', field: 'email' }])
      expect((await free.call('POST', plan(h.ids.A), body)).json()).toMatchObject({
        missingRules: [],
        refusals: [],
      })
    } finally {
      await h.t.close()
    }
  })

  // Review of the rule scope (M2): a ruled bucket's contents copied under another name carry
  // personal data: the target is asked to cover them (its `data`), as a collection's fields are.
  it('names a ruled bucket’s file contents as rules the target lacks', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('shop').collection('fs.chunks').insertOne({ files_id: 1, n: 0, data: 'x' })
      h.rules('A', [{ db: 'shop', coll: 'fs.files', field: 'metadata.owner' }])
      const body = {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'loot' },
        mode: 'insert',
        indexes: false,
      }
      const free = h.user({ role: 'editor' })
      const chunks = `/api/connections/${h.ids.A}/databases/shop/collections/fs.chunks/copy/plan`
      // A collection copy cannot follow the bucket (its gate refuses it): all of it is said personal.
      expect((await free.call('POST', chunks, body)).json()).toMatchObject({
        missingRules: ['copy.loot.**'],
        refusals: ['confirm_personal'],
      })
      // A database copy reads the bucket whole: its contents.
      const whole = `/api/connections/${h.ids.A}/databases/shop/copy/plan`
      const db = { target: { connectionId: h.ids.B, db: 'copy' }, mode: 'insert', confirmTtl: true }
      const plan = (await free.call('POST', whole, db)).json()
      expect(plan.missingRules).toContain('copy.fs.chunks.data')
      expect(plan.refusals).toContain('confirm_personal')
      // No rule reaches the bucket: nothing to confirm.
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      expect((await free.call('POST', chunks, body)).json()).toMatchObject({ missingRules: [], refusals: [] })
      expect((await free.call('POST', whole, db)).json().missingRules).not.toContain('copy.fs.chunks.data')
    } finally {
      await h.t.close()
    }
  })

  it('refuses copying a collection onto itself, also through another connection to the same server', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      for (const id of [h.ids.A, h.ids.A2]) {
        const body = {
          source: { kind: 'collection' },
          target: { connectionId: id, db: 'shop', coll: 'orders' },
          mode: 'upsert',
          indexes: false,
        }
        expect((await u.call('POST', plan(h.ids.A), body)).json().refusals).toContain('same_namespace')
      }
    } finally {
      await h.t.close()
    }
  })
})
