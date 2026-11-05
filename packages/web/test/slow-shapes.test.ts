// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { SlowQuery } from '../src/api/server'
import { groupByShape } from '../src/monitor/slowShapes'

/** Index advice gaps (2026-10-27, wave 4 #6): slow queries counted together by what they asked. */
const q = (over: Partial<SlowQuery>): SlowQuery => ({
  source: 'profile',
  ts: '2026-10-27T10:00:00.000Z',
  ns: 'crm.users',
  op: 'query',
  durationMs: 100,
  command: '{}',
  shape: 'find {"filter":{"email":"?"}}',
  ...over,
})

describe('slow queries by shape', () => {
  it('counts each shape of a namespace and kind, the costliest first', () => {
    const groups = groupByShape([
      q({ durationMs: 100, ts: '2026-10-27T10:00:00.000Z' }),
      q({ durationMs: 300, ts: '2026-10-27T10:05:00.000Z', docsExamined: 5000, nreturned: 10 }),
      q({ durationMs: 200, ts: '2026-10-27T10:02:00.000Z', docsExamined: 1000, nreturned: 10 }),
      q({ durationMs: 900, shape: 'find {"filter":{"age":{"$gt":"?"}}}' }),
      q({ durationMs: 50, ns: 'crm.orders' }),
      q({ durationMs: 70, op: 'update', shape: 'update {"q":{"email":"?"}}' }),
    ])
    expect(groups.map((g) => [g.ns, g.op, g.count, g.totalMs])).toEqual([
      ['crm.users', 'query', 1, 900],
      ['crm.users', 'query', 3, 600],
      ['crm.users', 'update', 1, 70],
      ['crm.orders', 'query', 1, 50],
    ])
    const email = groups[1]!
    expect(email).toMatchObject({
      avgMs: 200,
      p95Ms: 300,
      maxMs: 300,
      lastTs: '2026-10-27T10:05:00.000Z',
      ratio: 300,
    })
    // The newest of its queries, to open.
    expect(email.newest.durationMs).toBe(300)
  })

  it('counts by MongoDB’s own shape hash when it gave one', () => {
    const hash = 'A'.repeat(64)
    const groups = groupByShape([
      q({ shapeHash: hash, shape: 'find {"filter":{"a":"?","b":"?"}}' }),
      q({ shapeHash: hash, shape: 'find {"filter":{"b":"?","a":"?"}}' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(2)
  })

  it('says no ratio when none read anything, and is empty for no queries', () => {
    expect(groupByShape([q({})])[0]!.ratio).toBeNull()
    expect(groupByShape([])).toEqual([])
  })
})
