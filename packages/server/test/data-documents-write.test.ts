// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { BSON, Code, DBRef, Decimal128, Double, Int32, Long, ObjectId } from 'bson'
import { deserializeValue, serializeValue, toWire } from '@mongo-manager/shared'
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
async function setup() {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  const db = `d${randomUUID().slice(0, 8)}`
  return {
    h,
    base: `/databases/${db}/collections/items`,
    coll: (await h.client()).db(db).collection('items'),
  }
}
const S = serializeValue

/**
 * Stores a document no driver would write: its field "u", given as null, is sent as the old BSON
 * undefined (type 0x06, the same length), straight to the server in one OP_MSG.
 */
async function insertWithUndefined(db: string, coll: string, doc: Record<string, unknown>): Promise<void> {
  const body = Buffer.from(BSON.serialize({ insert: coll, documents: [doc], $db: db }))
  const at = body.indexOf(Buffer.from([0x0a, 0x75, 0x00]))
  if (at < 0) throw new Error('no null "u" to turn into undefined')
  body[at] = 0x06
  const msg = Buffer.alloc(21 + body.length)
  msg.writeInt32LE(msg.length, 0)
  msg.writeInt32LE(1, 4)
  msg.writeInt32LE(2013, 12)
  body.copy(msg, 21)
  const reply = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(mongo.port, '127.0.0.1', () => socket.write(msg))
    socket.once('data', (d) => (socket.end(), resolve(d as Buffer)))
    socket.once('error', reject)
  })
  expect(BSON.deserialize(reply.subarray(21))).toMatchObject({ ok: 1, n: 1 })
}

// Data review 2026-10-13 (H3): a stored field named like Extended JSON ({$numberInt: "5"}, {$regex,
// $options}, {$minKey: 1, other}) is legal data, but the app reads it as a typed value: a replace
// wrote that back — the document changed, a field lost — and its version check passed. Such a
// document is refused from here, unchanged; the shell edits it.
describe('a document the app cannot read back as it is', () => {
  it('is refused a replace and an update of that field, and stays as stored', async () => {
    const { h, base, coll } = await setup()
    const stored = { _id: 1, a: { $numberInt: '5' }, m: { $minKey: 1, other: 'kept' }, name: 'x' }
    await coll.insertOne(stored as never)
    const hash = await hashOf(h, base, 1)
    const replace = await h.call('POST', `${base}/documents/replace`, {
      _id: S(1),
      hash,
      document: { _id: S(1), a: S(new Int32(5)), name: 'y' },
    })
    expect(replace.statusCode).toBe(409)
    expect(replace.json().details).toMatchObject({ reason: 'not_round_trip' })
    const update = await h.call('POST', `${base}/documents/update`, { _id: S(1), hash, set: { a: 'z' } })
    expect(update.statusCode).toBe(409)
    expect(await coll.findOne({ _id: 1 as never })).toEqual(stored)
  })

  // Data review 2026-10-13 (I2): an update is a $set of the paths changed — the rest is never
  // rewritten, so only a change at, inside or above a field the app misreads is refused.
  it('takes an update that leaves such a field alone, and refuses one that touches it', async () => {
    const { h, base, coll } = await setup()
    const stored = {
      _id: 3,
      a: { $numberInt: '5' },
      m: { $minKey: 1, other: 'kept' },
      name: 'x',
      o: { p: 1 },
    }
    await coll.insertOne(stored as never)
    const update = async (change: { set?: Record<string, unknown>; unset?: string[] }) =>
      h.call('POST', `${base}/documents/update`, {
        _id: S(3),
        hash: await hashOf(h, base, 3),
        set: change.set ?? {},
        unset: change.unset ?? [],
      })
    for (const change of [
      { set: { a: S(new Int32(6)) } },
      { set: { 'm.other': 'gone' } },
      { unset: ['m.other'] },
    ]) {
      const res = await update(change)
      expect([change, res.statusCode]).toEqual([change, 409])
      expect(res.json().details).toMatchObject({ reason: 'not_round_trip', kind: 'ejson_like' })
    }
    expect(await coll.findOne({ _id: 3 as never })).toEqual(stored)
    expect((await update({ set: { name: 'y', 'o.p': S(new Int32(2)) } })).statusCode).toBe(200)
    expect(await coll.findOne({ _id: 3 as never })).toEqual({ ...stored, name: 'y', o: { p: 2 } })
    // Review 2026-10-13 round 2 (M6): removing such a field misreads nothing.
    expect((await update({ unset: ['m'] })).statusCode).toBe(200)
    expect(await coll.findOne({ _id: 3 as never })).not.toHaveProperty('m')
  })

  // Round 2 (M7): an all-positions path names every element, the one the app misreads too.
  it('refuses a change through every element of an array that holds such a field', async () => {
    const { h, base, coll } = await setup()
    await coll.insertOne({ _id: 6, list: [{ x: 1 }, { x: { $numberInt: '5' } }] } as never)
    for (const path of ['list.$[].x', 'list.$[e].x', 'list.$.x']) {
      const res = await h.call('POST', `${base}/documents/update`, {
        _id: S(6),
        hash: await hashOf(h, base, 6),
        set: { [path]: 1 },
        unset: [],
      })
      expect([path, res.statusCode]).toEqual([path, 409])
    }
  })

  // Round 2 (I1): the old BSON undefined reads back as null, and the version check can never match
  // it — any change of such a document is refused, saying why, never "changed by someone else".
  it('refuses any change of a document holding the old undefined type, saying why', async () => {
    const { h, base, coll } = await setup()
    await insertWithUndefined(coll.dbName, coll.collectionName, { _id: 10, u: null, name: 'x' })
    const got = (await h.call('POST', `${base}/documents/get`, { _id: S(10) })).json()
    expect(got.caution).toEqual({ kind: 'undefined', field: 'u' })
    const res = await h.call('POST', `${base}/documents/update`, {
      _id: S(10),
      hash: got.hash,
      set: { name: 'y' },
      unset: [],
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().details).toMatchObject({ reason: 'not_round_trip', kind: 'undefined', field: 'u' })
  })

  // Round 2 (I2): a reference or code value holds values of its own, which the app misreads too.
  it('finds such fields inside a reference and a code value', async () => {
    const { h, base, coll } = await setup()
    await coll.insertOne({
      _id: 11,
      r: new DBRef('c', { $numberLong: '5' } as never),
      c: new Code('x', { a: { $numberInt: '5' } }),
    } as never)
    const got = (await h.call('POST', `${base}/documents/get`, { _id: S(11) })).json()
    expect(got.caution).toEqual({ kind: 'ejson_like', field: 'r.$id', others: 1 })
    const res = await h.call('POST', `${base}/documents/replace`, {
      _id: S(11),
      hash: got.hash,
      document: { _id: S(11) },
    })
    expect(res.json().details).toMatchObject({ reason: 'not_round_trip' })
  })

  // Round 2 (I2): what the app cannot match exactly (a reference stored with its fields in another
  // order) is said as such once the version is seen unchanged — never "changed by someone else".
  it('says so when a document unchanged since read cannot be matched as read', async () => {
    const { h, base, coll } = await setup()
    await coll.insertOne({ _id: 12, r: { x: 1, $ref: 'c', $id: 1 }, name: 'x' } as never)
    const res = await h.call('POST', `${base}/documents/update`, {
      _id: S(12),
      hash: await hashOf(h, base, 12),
      set: { name: 'y' },
      unset: [],
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().details).toMatchObject({ reason: 'not_round_trip', kind: 'unmatched' })
  })

  // Data review 2026-10-13 (M3): the editor is told before a save is refused, not after.
  it('marks such a document with a caution naming the field, and only such a document', async () => {
    const { h, base, coll } = await setup()
    await coll.insertMany([
      { _id: 4, o: { list: [1, { $numberInt: '5' }] } },
      { _id: 5, n: 1 },
    ] as never)
    const find = (
      await h.call('POST', `${base}/find`, { filter: {}, sort: { _id: 1 }, limit: 10 })
    ).json() as { documents: Array<{ caution?: unknown }> }
    expect(find.documents.map((d) => d.caution)).toEqual([
      { kind: 'ejson_like', field: 'o.list.1' },
      undefined,
    ])
    const get = (await h.call('POST', `${base}/documents/get`, { _id: S(4) })).json()
    expect(get.caution).toEqual({ kind: 'ejson_like', field: 'o.list.1' })
  })

  it('lets an ordinary document be replaced as before', async () => {
    const { h, base, coll } = await setup()
    await coll.insertOne({ _id: 2, a: new Int32(5), r: /x/i } as never)
    const hash = await hashOf(h, base, 2)
    const res = await h.call('POST', `${base}/documents/replace`, {
      _id: S(2),
      hash,
      document: { _id: S(2), a: S(new Int32(6)), r: S(/x/i) },
    })
    expect(res.statusCode).toBe(200)
  })
})
const HASH0 = '0'.repeat(64)
async function hashOf(h: DataHarness, base: string, id: unknown): Promise<string> {
  return (await h.call('POST', `${base}/documents/get`, { _id: S(id) })).json().hash
}

describe('_id types are never guessed (Review Focus 1)', () => {
  it('addresses "5", 5 and a 24-hex string _id independently', async () => {
    const { h, base, coll } = await setup()
    const hex = '65f0a1b2c3d4e5f601234567'
    await coll.insertMany([
      { _id: '5', v: 's' },
      { _id: new Int32(5), v: 'i' },
      { _id: hex, v: 'hex-string' },
      { _id: new ObjectId(hex), v: 'oid' },
    ] as never)
    for (const [id, v] of [
      ['5', 's'],
      [new Int32(5), 'i'],
      [hex, 'hex-string'],
      [new ObjectId(hex), 'oid'],
    ] as const) {
      const item = (await h.call('POST', `${base}/documents/get`, { _id: S(id) })).json()
      expect(item.document.v, String(id)).toBe(v)
    }
    const h5 = await hashOf(h, base, new Int32(5))
    expect(
      (
        await h.call('POST', `${base}/documents/update`, {
          _id: S(new Int32(5)),
          set: { v: 'changed' },
          hash: h5,
        })
      ).json(),
    ).toEqual({ modified: 1 })
    expect(await coll.findOne({ _id: '5' } as never)).toMatchObject({ v: 's' })
    expect((await h.call('POST', `${base}/documents/delete`, { _id: S(hex) })).statusCode).toBe(204)
    expect(await coll.countDocuments({ _id: new ObjectId(hex) } as never)).toBe(1)
  })
})

describe('insert and field updates', () => {
  it('inserts typed documents and updates one field without drifting the others (Review Focus 4)', async () => {
    const { h, base, coll } = await setup()
    const doc = {
      d: new Double(1),
      l: Long.fromString('9007199254740993'),
      m: Decimal128.fromString('1.10'),
      when: new Date(0),
      name: 'a',
    }
    const inserted = (await h.call('POST', `${base}/documents`, { documents: [S(doc)] })).json()
    const id = deserializeValue(inserted.insertedIds[0])
    const res = await h.call('POST', `${base}/documents/update`, {
      _id: S(id),
      set: { name: 'b', 'nested.x': S(new Int32(1)) },
      unset: ['when'],
      hash: await hashOf(h, base, id),
    })
    expect(res.json()).toEqual({ modified: 1 })
    const stored = await coll.findOne({ _id: id } as never, { promoteValues: false, promoteLongs: false })
    expect(toWire({ d: stored!.d, l: stored!.l, m: stored!.m })).toBe(
      toWire({ d: doc.d, l: doc.l, m: doc.m }),
    )
    expect(stored).toMatchObject({ name: 'b', nested: { x: expect.anything() } })
    expect(stored!.when).toBeUndefined()
  })

  it('maps duplicate keys to 409 with the key', async () => {
    const { h, base, coll } = await setup()
    await coll.createIndex({ email: 1 }, { unique: true })
    await h.call('POST', `${base}/documents`, { documents: [{ email: 'a@b' }] })
    const res = await h.call('POST', `${base}/documents`, { documents: [{ email: 'a@b' }] })
    expect([res.statusCode, res.json().code]).toEqual([409, 'CONFLICT'])
    expect(res.json().details).toMatchObject({
      index: 'email_1',
      duplicateKey: expect.stringContaining('a@b'),
    })
  })

  // Research 2026-10-28 (SERVER-20547): a write the validator refused said only "Document failed
  // validation"; MongoDB's errInfo names the rules, and the value that failed stays out.
  it("names the validator's rules a write did not meet, without the value", async () => {
    const { h, base, coll } = await setup()
    await coll.db.createCollection(coll.collectionName, {
      validator: {
        $jsonSchema: {
          required: ['name'],
          properties: {
            age: { bsonType: 'int', minimum: 0, description: 'a whole number, 0 or more' },
            tags: { bsonType: 'array', items: { bsonType: 'string' } },
          },
        },
      },
    })
    const res = await h.call('POST', `${base}/documents`, {
      documents: [{ age: S(new Int32(-7)), tags: ['a', S(new Int32(42))] }],
    })
    expect([res.statusCode, res.json().code]).toEqual([400, 'MONGO_ERROR'])
    const { problems, more } = res.json().details as {
      problems: Array<Record<string, unknown>>
      more: boolean
    }
    expect(more).toBe(false)
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'age',
          rule: 'minimum',
          expected: '0',
          description: 'a whole number, 0 or more',
        }),
        expect.objectContaining({ path: 'tags.1', rule: 'bsonType', expected: '"string"', found: 'int' }),
        { path: 'name', rule: 'required' },
      ]),
    )
    // The values written are nowhere in what is said of them (the details: the random correlation
    // id may hold any digits).
    const details = JSON.stringify(res.json().details)
    expect(details).not.toContain('-7')
    expect(details).not.toContain('42')

    await coll.db.command({ collMod: coll.collectionName, validator: { qty: { $gte: 1 } } })
    const { insertedId } = await coll.insertOne({ qty: 5 }, { bypassDocumentValidation: true })
    const update = await h.call('POST', `${base}/documents/update`, {
      _id: S(insertedId),
      set: { qty: S(new Int32(0)) },
      unset: [],
      hash: await hashOf(h, base, insertedId),
    })
    expect(update.statusCode).toBe(400)
    expect(update.json().details.problems).toEqual([
      { path: 'qty', rule: '$gte', reason: 'comparison failed', expected: '1' },
    ])
  })
})

describe('optimistic concurrency (Review Focus 2)', () => {
  it('rejects a field update when the field changed since it was loaded', async () => {
    const { h, base, coll } = await setup()
    const { insertedId } = await coll.insertOne({ qty: 1 })
    const loaded = await hashOf(h, base, insertedId)
    await coll.updateOne({ _id: insertedId }, { $set: { qty: 2 } })
    const stale = await h.call('POST', `${base}/documents/update`, {
      _id: S(insertedId),
      set: { qty: 10 },
      hash: loaded,
    })
    expect([stale.statusCode, stale.json().code]).toEqual([409, 'DOCUMENT_CHANGED'])
    const fresh = await h.call('POST', `${base}/documents/update`, {
      _id: S(insertedId),
      set: { qty: 10 },
      hash: await hashOf(h, base, insertedId),
    })
    expect(fresh.json()).toEqual({ modified: 1 })
    expect(
      (
        await h.call('POST', `${base}/documents/update`, {
          _id: S(new ObjectId()),
          set: { qty: 1 },
          hash: HASH0,
        })
      ).statusCode,
    ).toBe(404)
  })

  it('replaces only if the stored document is still the loaded version', async () => {
    const { h, base, coll } = await setup()
    const { insertedId } = await coll.insertOne({ a: 1, b: 'x' })
    const loaded = await hashOf(h, base, insertedId)
    const ok = await h.call('POST', `${base}/documents/replace`, {
      _id: S(insertedId),
      document: { a: 2 },
      hash: loaded,
    })
    expect(ok.json()).toEqual({ modified: 1 })
    const again = await h.call('POST', `${base}/documents/replace`, {
      _id: S(insertedId),
      document: { a: 3 },
      hash: loaded,
    })
    expect([again.statusCode, again.json().code]).toEqual([409, 'DOCUMENT_CHANGED'])
    const mismatch = await h.call('POST', `${base}/documents/replace`, {
      _id: S(insertedId),
      document: { _id: S(new ObjectId()), a: 3 },
      hash: await hashOf(h, base, insertedId),
    })
    expect(mismatch.statusCode).toBe(400)
  })
})
