// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { compileRules } from '../src/masking/match'
import { gatherShardingDetail } from '../src/monitor/sharding'
import { recommendation } from '../src/backup/dump-plan'
import { buildsShown } from '../src/routes/data/indexes'

/** Twelfth review of explain masking (I3): a sharded collection's size per shard. */
function fakeClient() {
  const cursor = (rows: unknown[]) => ({ toArray: async () => rows })
  return {
    db: (db: string) => ({
      collection: () => ({
        aggregate: () => cursor([{ shard: 's0', storageStats: { size: 4096, count: 2 } }]),
        find: () => cursor(db === 'config' ? [] : []),
      }),
    }),
  } as never
}

describe('a sharded collection’s detail', () => {
  it('shows a restricted user its count per shard, and no size where rules apply', async () => {
    const masker = compileRules([{ db: 'crm', coll: 'users', field: 'email' }])
    const hidden = await gatherShardingDetail(fakeClient(), 'crm.users', masker)
    expect(hidden.shards).toEqual([{ shard: 's0', size: null, count: 2 }])
    expect(hidden.sizesHidden).toBe(true)
    expect((await gatherShardingDetail(fakeClient(), 'crm.notes', masker)).sizesHidden).toBeUndefined()
    expect((await gatherShardingDetail(fakeClient(), 'crm.notes', masker)).shards).toEqual([
      { shard: 's0', size: 4096, count: 2 },
    ])
    expect((await gatherShardingDetail(fakeClient(), 'crm.users', null)).shards[0]!.size).toBe(4096)
  })
})

describe('a backup’s recommendation', () => {
  it('weighs no size hidden from the caller', () => {
    const big = { personal: false, tools: true, bytes: 60 * 1024 ** 3 }
    expect(recommendation({ ...big, hidden: false }).reason).toBe('size')
    expect(recommendation({ ...big, hidden: true }).reason).toBeNull()
    expect(recommendation({ ...big, hidden: true, personal: true }).reason).toBe('personal')
  })
})

describe('an index build’s progress (M8)', () => {
  it('counts no keys for a caller rules hide data from, in the numbers or the message', () => {
    const op = {
      msg: 'Index Build: inserting keys from external sorter into index: 1234/5000 24%',
      progress: { done: 1234, total: 5000 },
    }
    expect(buildsShown([op], true)).toEqual([
      { message: 'Index Build: inserting keys from external sorter into index:', done: null, total: null },
    ])
    expect(buildsShown([op], false)).toEqual([{ message: op.msg, done: 1234, total: 5000 }])
  })
})
