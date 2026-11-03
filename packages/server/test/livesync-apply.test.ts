import { describe, expect, it } from 'vitest'
import { Int32, ObjectId, Timestamp, type Document } from 'mongodb'
import { idKey, planBatch, SCHEMA_SKIP, type ApplyContext } from '../src/livesync/apply'

const ns = { db: 'shop', coll: 'orders' }
const ts = (i: number) => new Timestamp({ t: 100, i })
const base: ApplyContext = {
  sourceDb: 'shop',
  targetOf: (db, coll) => (db === 'shop' && coll === 'orders' ? { db: 'copy', coll: 'orders' } : null),
  maskFor: () => null,
  skip: null,
}
const insert = (id: unknown, i: number, doc: Document = {}): Document => ({
  operationType: 'insert',
  ns,
  clusterTime: ts(i),
  wallTime: new Date(1_000 + i),
  documentKey: { _id: id },
  fullDocument: { _id: id, ...doc },
})
const update = (id: unknown, i: number, doc: Document | null): Document => ({
  operationType: 'update',
  ns,
  clusterTime: ts(i),
  documentKey: { _id: id },
  fullDocument: doc === null ? null : { _id: id, ...doc },
})
const del = (id: unknown, i: number): Document => ({
  operationType: 'delete',
  ns,
  clusterTime: ts(i),
  documentKey: { _id: id },
})

describe('a batch of changes as target writes (phase 3e-2 spec §1.4)', () => {
  it('writes the document as it is now, upserted by _id, and deletes by _id', () => {
    const p = planBatch([insert(1, 1, { n: 1 }), update(2, 2, { n: 2 }), del(3, 3)], base)
    expect(p.writes).toEqual([
      {
        target: { db: 'copy', coll: 'orders' },
        ops: [
          { replaceOne: { filter: { _id: 1 }, replacement: { _id: 1, n: 1 }, upsert: true } },
          { replaceOne: { filter: { _id: 2 }, replacement: { _id: 2, n: 2 }, upsert: true } },
          { deleteOne: { filter: { _id: 3 } } },
        ],
        ids: [idKey(1), idKey(2), idKey(3)],
        ats: ['100.1', '100.2', '100.3'],
        source: { db: 'shop', coll: 'orders' },
        pre: [],
      },
    ])
    expect(p.counts).toEqual({ inserted: 1, replaced: 1, deleted: 1, skipped: 0 })
    expect(p).toMatchObject({ consumed: 3, lastTime: '100.3', stop: null, schema: null })
  })

  it('keeps only the last change of each _id, in the order of last changes', () => {
    const oid = new ObjectId('64b7f0c2a1b2c3d4e5f60718')
    const p = planBatch([insert(oid, 1, { n: 1 }), insert(2, 2), update(oid, 3, { n: 9 }), del(2, 4)], base)
    expect(p.writes[0]!.ops).toEqual([
      { replaceOne: { filter: { _id: oid }, replacement: { _id: oid, n: 9 }, upsert: true } },
      { deleteOne: { filter: { _id: 2 } } },
    ])
    expect(p.consumed).toBe(4)
  })

  it('tells _id types apart: 1 and "1" and Int32(1) as stored', () => {
    expect(idKey(1)).not.toBe(idKey('1'))
    const p = planBatch([insert(1, 1), insert('1', 2)], base)
    expect(p.writes[0]!.ops).toHaveLength(2)
    expect(idKey(new Int32(1))).toBe(idKey(new Int32(1)))
  })

  it('skips an update whose document is gone by now (its delete follows)', () => {
    const p = planBatch([update(1, 1, null)], base)
    expect(p.writes).toEqual([])
    expect(p).toMatchObject({ consumed: 1, lastTime: '100.1' })
  })

  it('ignores namespaces the sync does not carry, and still moves past them', () => {
    const other = { ...insert(1, 1), ns: { db: 'shop', coll: 'logs' } }
    const p = planBatch([other], base)
    expect(p.writes).toEqual([])
    expect(p.consumed).toBe(1)
  })

  it('masks what it writes when the sync is masked', () => {
    const p = planBatch([insert(1, 1, { email: 'a@x', n: 1 })], { ...base, maskFor: () => [['email']] })
    // Masking keeps BSON types (Int32 stays Int32), as the 3d-2 masked copy writes them.
    const { filter, replacement } = (
      p.writes[0]!.ops[0] as { replaceOne: { filter: Document; replacement: Document } }
    ).replaceOne
    expect(filter).toEqual({ _id: 1 })
    expect(replacement.email).toBe('***')
    expect(Number(replacement._id)).toBe(1)
    expect(Number(replacement.n)).toBe(1)
  })

  it('skips the one document it was told to, once (plan ruling 11)', () => {
    const p = planBatch([insert(1, 1), insert(2, 2)], {
      ...base,
      skip: { id: idKey(1), at: '100.1', ns: 'shop.orders' },
    })
    expect(p.writes[0]!.ids).toEqual([idKey(2)])
    expect(p).toMatchObject({ skippedOnce: true, counts: { skipped: 1 } })
    const later = planBatch([insert(1, 5)], {
      ...base,
      skip: { id: idKey(1), at: '100.1', ns: 'shop.orders' },
    })
    expect(later.skippedOnce).toBe(false)
    // A document changed twice in the failing batch: both changes up to the marker go.
    const twice = planBatch([insert(1, 1), update(1, 2, { n: 2 }), update(1, 6, { n: 3 })], {
      ...base,
      skip: { id: idKey(1), at: '100.2', ns: 'shop.orders' },
    })
    expect(twice.writes[0]!.ops).toEqual([
      { replaceOne: { filter: { _id: 1 }, replacement: { _id: 1, n: 3 }, upsert: true } },
    ])
    expect(twice.counts.skipped).toBe(2)
  })

  // Review of db45c424: a 2dsphere index of 8.3 on (version 4) is built at an older target's own.
  it("builds a later index version at the target's own, by its feature level", () => {
    const create = {
      operationType: 'createIndexes',
      ns,
      clusterTime: ts(2),
      operationDescription: {
        indexes: [{ v: 2, key: { loc: '2dsphere' }, name: 'loc_2dsphere', '2dsphereIndexVersion': 4 }],
      },
    }
    const indexesFor = (targetLevel: ApplyContext['targetLevel']) =>
      (planBatch([create], { ...base, targetLevel }).schema as { indexes: Document[] }).indexes
    expect(indexesFor({ fcv: [8, 0], release: [8, 0] })).toEqual([
      { key: { loc: '2dsphere' }, name: 'loc_2dsphere' },
    ])
    expect(indexesFor({ fcv: [8, 3], release: [8, 3] })).toEqual([
      { key: { loc: '2dsphere' }, name: 'loc_2dsphere', '2dsphereIndexVersion': 4 },
    ])
  })

  it('takes a schema event alone, and stops before it when it is not first', () => {
    const create = {
      operationType: 'createIndexes',
      ns,
      clusterTime: ts(2),
      operationDescription: { indexes: [{ v: 2, key: { n: 1 }, name: 'n_1' }] },
    }
    const before = planBatch([insert(1, 1), create, insert(2, 3)], base)
    expect(before).toMatchObject({ consumed: 1, schema: null })
    const alone = planBatch([create, insert(2, 3)], base)
    expect(alone).toMatchObject({
      consumed: 1,
      writes: [],
      schema: {
        kind: 'createIndexes',
        target: { db: 'copy', coll: 'orders' },
        indexes: [{ key: { n: 1 }, name: 'n_1' }],
      },
      lastTime: '100.2',
    })
    const drop = {
      operationType: 'dropIndexes',
      ns,
      clusterTime: ts(4),
      operationDescription: { indexes: [{ name: 'n_1', key: { n: 1 } }] },
    }
    expect(planBatch([drop], base).schema).toEqual({
      kind: 'dropIndexes',
      target: { db: 'copy', coll: 'orders' },
      names: ['n_1'],
    })
  })

  it('never builds a unique index over a masked path', () => {
    const create = {
      operationType: 'createIndexes',
      ns,
      clusterTime: ts(2),
      operationDescription: {
        indexes: [
          { key: { email: 1 }, name: 'email_1', unique: true },
          { key: { n: 1 }, name: 'n_1' },
        ],
      },
    }
    const p = planBatch([create], { ...base, maskFor: () => [['email']] })
    expect(p.schema).toEqual({
      kind: 'createIndexes',
      target: { db: 'copy', coll: 'orders' },
      indexes: [{ key: { n: 1 }, name: 'n_1' }],
    })
  })

  // Security audit 2026-10-16 (Important 3): a masked sync replays no partial filter that names a
  // value masking would change (the copy leaves it out too).
  it('never replays an index whose partial filter holds a masked value', () => {
    const create = {
      operationType: 'createIndexes',
      ns,
      clusterTime: ts(2),
      operationDescription: {
        indexes: [
          { key: { n: 1 }, name: 'vip', partialFilterExpression: { email: 'ceo@corp.example' } },
          { key: { n: -1 }, name: 'paid', partialFilterExpression: { paid: true } },
        ],
      },
    }
    expect(planBatch([create], { ...base, maskFor: () => [['email']] }).schema).toEqual({
      kind: 'createIndexes',
      target: { db: 'copy', coll: 'orders' },
      indexes: [{ key: { n: -1 }, name: 'paid', partialFilterExpression: { paid: true } }],
    })
    // Unmasked: both, as written.
    expect(planBatch([create], base).schema).toMatchObject({ indexes: [{ name: 'vip' }, { name: 'paid' }] })
  })

  // Security audit 2026-10-16 (Important 4): where file contents are withheld (a masked sync with
  // rules), no change of a GridFS bucket is written, whatever carries it.
  it('writes no GridFS change where file contents are withheld', () => {
    const at = (coll: string) => (e: Document) => ({ ...e, ns: { db: 'shop', coll } })
    const events = [
      at('fs.chunks')(insert(1, 1, { files_id: 1, n: 0, data: 'secret' })),
      at('fs.files')(insert(1, 2, { filename: 'a.pdf' })),
      insert(3, 3, { n: 3 }),
    ]
    const c: ApplyContext = { ...base, targetOf: (db, coll) => (db === 'shop' ? { db: 'copy', coll } : null) }
    // User report 2026-10-27: the buckets a rule reaches (here this one), asked by name.
    const withheld = planBatch(events, { ...c, withholdFiles: (_db, coll) => coll.startsWith('fs.') })
    expect(withheld.writes.map((w) => w.target.coll)).toEqual(['orders'])
    expect(withheld.consumed).toBe(3)
    expect(planBatch(events, c).writes.map((w) => w.target.coll)).toEqual(['fs.chunks', 'fs.files', 'orders'])
    // Independent review (minor): said in the activity log, once per bucket collection and batch.
    expect(withheld.notes).toEqual([
      'shop.fs.chunks: GridFS file contents are withheld: they cannot be masked, nor checked against the target rules',
      'shop.fs.files: GridFS file contents are withheld: they cannot be masked, nor checked against the target rules',
    ])
    expect(planBatch(events, c).notes).toEqual([])
  })

  it('says which replayed indexes it left out, and why', () => {
    const create = {
      operationType: 'createIndexes',
      ns,
      clusterTime: ts(2),
      operationDescription: {
        indexes: [
          { key: { n: 1 }, name: 'vip', partialFilterExpression: { email: 'ceo@corp.example' } },
          { key: { email: 1 }, name: 'email_1', unique: true },
          { key: { n: -1 }, name: 'paid' },
        ],
      },
    }
    const p = planBatch([create], { ...base, maskFor: () => [['email']] })
    expect(p.notes).toEqual([
      'shop.orders: index email_1 left out: A unique index over personal data cannot hold masked values',
      'shop.orders: index vip left out: Its partial filter holds values that would be masked; it is left out',
    ])
  })

  it('stops for a person at a drop, a rename, a database drop, an invalidate or new options', () => {
    for (const [op, reason] of [
      ['drop', 'source_gone'],
      ['rename', 'source_gone'],
      ['dropDatabase', 'source_gone'],
      ['invalidate', 'source_gone'],
      ['modify', 'schema_changed'],
    ] as const) {
      const p = planBatch([insert(1, 1), { operationType: op, ns, clusterTime: ts(2) }], base)
      expect(p).toMatchObject({ consumed: 1, stop: null })
      const alone = planBatch([{ operationType: op, ns, clusterTime: ts(2) }], base)
      expect(alone).toMatchObject({ consumed: 0, stop: { reason, detail: 'shop.orders' } })
    }
  })

  it('creates a followed new collection, and only one the sync carries', () => {
    const ctx: ApplyContext = {
      ...base,
      targetOf: (db, coll) => (db === 'shop' ? { db: 'copy', coll } : null),
    }
    const p = planBatch(
      [{ operationType: 'create', ns: { db: 'shop', coll: 'fresh' }, clusterTime: ts(1) }],
      ctx,
    )
    expect(p.schema).toEqual({
      kind: 'create',
      source: { db: 'shop', coll: 'fresh' },
      target: { db: 'copy', coll: 'fresh' },
    })
    expect(
      planBatch([{ operationType: 'create', ns: { db: 'x', coll: 'y' }, clusterTime: ts(1) }], ctx),
    ).toMatchObject({ consumed: 1, schema: null })
  })

  it('names a sharded target’s shard key in an upsert, from the document as written', () => {
    const ctx: ApplyContext = { ...base, shardKeyOf: () => ['region', 'a.b'] }
    const p = planBatch([insert(1, 1, { region: 'eu', a: { b: 2 } }), insert(2, 2, { n: 1 }), del(3, 3)], ctx)
    expect(p.writes[0]!.ops).toEqual([
      {
        replaceOne: {
          filter: { _id: 1, region: { $eq: 'eu' }, 'a.b': { $eq: 2 } },
          replacement: { _id: 1, region: 'eu', a: { b: 2 } },
          upsert: true,
        },
      },
      // A document without the field is stored as null for the shard key.
      {
        replaceOne: {
          filter: { _id: 2, region: { $eq: null }, 'a.b': { $eq: null } },
          replacement: { _id: 2, n: 1 },
          upsert: true,
        },
      },
      { deleteOne: { filter: { _id: 3 } } },
    ])
  })

  // Seventeenth review of explain masking (nit): a stored sub-document is a value, never an operator.
  it('names a shard key whose value is a document of operators as a value', () => {
    const ctx: ApplyContext = { ...base, shardKeyOf: () => ['region'] }
    const p = planBatch([insert(1, 1, { region: { $gt: '' } })], ctx)
    expect(p.writes[0]!.ops[0]).toMatchObject({
      replaceOne: { filter: { _id: 1, region: { $eq: { $gt: '' } } } },
    })
  })

  it('reports the last change’s wall time for the lag', () => {
    expect(planBatch([insert(1, 7)], base).lastWall).toBe(1_007)
  })
})

describe('passing new options a person chose to ignore (phase 3e-2 spec §1.4)', () => {
  it('says where a stop is, and lets a marked modify pass once', () => {
    const modify = { operationType: 'modify', ns, clusterTime: ts(4) }
    expect(planBatch([modify], base).stop).toEqual({
      reason: 'schema_changed',
      detail: 'shop.orders',
      at: '100.4',
    })
    const passed = planBatch([modify, insert(1, 5)], { ...base, skip: { id: SCHEMA_SKIP, at: '100.4' } })
    expect(passed).toMatchObject({ stop: null, consumed: 2, counts: { inserted: 1 } })
    const later = planBatch([{ ...modify, clusterTime: ts(9) }], {
      ...base,
      skip: { id: SCHEMA_SKIP, at: '100.4' },
    })
    expect(later.stop).toMatchObject({ reason: 'schema_changed', at: '100.9' })
  })
})

describe('events a sync carries nothing for (phase 3e-2)', () => {
  it('moves past other kinds of event on its own collections', () => {
    const p = planBatch([{ operationType: 'shardCollection', ns, clusterTime: ts(3) }, insert(1, 4)], base)
    expect(p).toMatchObject({ consumed: 2, counts: { inserted: 1 }, stop: null, schema: null })
  })
})

describe('final review fixes in applying a batch (phase 3e-2)', () => {
  const two: ApplyContext = {
    ...base,
    targetOf: (db, coll) =>
      db === 'shop' && (coll === 'orders' || coll === 'users') ? { db: 'copy', coll } : null,
  }
  const inColl = (e: Document, coll: string) => ({ ...e, ns: { db: 'shop', coll } })

  it('I1: skips the refused document only in its own collection', () => {
    const p = planBatch([inColl(insert(1, 1), 'orders'), inColl(insert(1, 2), 'users')], {
      ...two,
      skip: { id: idKey(1), at: '100.2', ns: 'shop.users' },
    })
    expect(p.counts.skipped).toBe(1)
    expect(p.writes.map((w) => [w.source.coll, w.ids])).toEqual([['orders', [idKey(1)]]])
  })

  it('I3: stops when a collection is renamed onto one the sync carries', () => {
    const swap = {
      operationType: 'rename',
      ns: { db: 'shop', coll: 'tmp.agg_out.1' },
      to: { db: 'shop', coll: 'orders' },
      clusterTime: ts(5),
    }
    expect(planBatch([swap], base).stop).toEqual({
      reason: 'source_gone',
      detail: 'shop.orders',
      at: '100.5',
    })
  })

  it('m11: stops when the source database is dropped', () => {
    const gone = { operationType: 'dropDatabase', ns: { db: 'shop' }, clusterTime: ts(6) }
    expect(planBatch([gone], base).stop).toEqual({ reason: 'source_gone', detail: 'shop', at: '100.6' })
    expect(planBatch([{ ...gone, ns: { db: 'other' } }], base)).toMatchObject({ stop: null, consumed: 1 })
  })

  it('m14: on a sharded target, removes the document left under an old shard key value first', () => {
    const ctx: ApplyContext = { ...base, shardKeyOf: () => ['region'] }
    const p = planBatch([insert(1, 1, { region: 'eu' }), del(2, 2)], ctx)
    expect(p.writes[0]!.pre).toEqual([
      { deleteOne: { filter: { _id: 1, $or: [{ region: { $ne: 'eu' } }] } } },
    ])
    expect(planBatch([insert(1, 1, { region: 'eu' })], base).writes[0]!.pre).toEqual([])
  })
})
