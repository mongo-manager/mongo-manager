// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Long, ObjectId } from 'bson'
import { MAX_ORIGIN_BYTES, queryOriginOf } from '../src/shell/proxy/origin'

/**
 * Phase 3a-2 spec §3.3: the proxy turns the find/aggregate a shell command ran into an origin the
 * collection view can reopen. Values are canonical EJSON; session and cluster fields never leak in.
 */
const OID = '0123456789abcdef01234567'
const noise = {
  lsid: { id: 'x' },
  $clusterTime: { clusterTime: 1 },
  $readPreference: { mode: 'primary' },
  $db: 'shop',
}

describe('queryOriginOf', () => {
  it('captures a find with every reopenable part, as canonical EJSON', () => {
    const origin = queryOriginOf({
      name: 'find',
      db: 'shop',
      body: {
        find: 'orders',
        filter: { _id: new ObjectId(OID), at: new Date(0) },
        projection: { a: 1 },
        sort: { a: -1 },
        skip: 5,
        limit: Long.fromNumber(3),
        collation: { locale: 'en' },
        hint: 'a_1',
        batchSize: 101,
        ...noise,
      },
    })
    expect(origin).toEqual({
      kind: 'find',
      db: 'shop',
      coll: 'orders',
      filter: { _id: { $oid: OID }, at: { $date: { $numberLong: '0' } } },
      projection: { a: { $numberInt: '1' } },
      sort: { a: { $numberInt: '-1' } },
      skip: 5,
      limit: 3,
      collation: { locale: 'en' },
      hint: 'a_1',
    })
    expect(JSON.stringify(origin)).not.toMatch(/lsid|clusterTime|readPreference|\$db|batchSize/)
  })

  it('defaults a missing filter to {} and keeps an object hint', () => {
    expect(queryOriginOf({ name: 'find', db: 'shop', body: { find: 'orders', hint: { a: 1 } } })).toEqual({
      kind: 'find',
      db: 'shop',
      coll: 'orders',
      filter: {},
      hint: { a: { $numberInt: '1' } },
    })
  })

  it('captures a collection aggregate and ignores a database-level one', () => {
    expect(
      queryOriginOf({
        name: 'aggregate',
        db: 'shop',
        body: { aggregate: 'orders', pipeline: [{ $match: { a: 1 } }], cursor: {}, ...noise },
      }),
    ).toEqual({
      kind: 'aggregate',
      db: 'shop',
      coll: 'orders',
      pipeline: [{ $match: { a: { $numberInt: '1' } } }],
    })
    expect(queryOriginOf({ name: 'aggregate', db: 'admin', body: { aggregate: 1, pipeline: [] } })).toBeNull()
  })

  it('ignores every other command', () => {
    for (const name of ['getMore', 'count', 'insert', 'listCollections']) {
      expect(queryOriginOf({ name, db: 'shop', body: { [name]: 'orders' } }), name).toBeNull()
    }
  })

  it('drops an origin larger than 64 KiB', () => {
    const big = 'x'.repeat(MAX_ORIGIN_BYTES)
    expect(queryOriginOf({ name: 'find', db: 'shop', body: { find: 'orders', filter: { big } } })).toBeNull()
  })
})
