// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BSON, type Document } from 'mongodb'
import { normaliseExplain } from '../src/explain/normalise'
import { adviceFor } from '../src/explain/advice'
import { suggestIndex } from '../src/explain/suggest'
import type { PlanNode } from '../src/explain/types'

/** Explain outputs captured from MongoDB 8.2 by scripts/capture-explain.mjs (phase 2b). */
const fixture = (name: string): Document =>
  (
    BSON.EJSON.parse(readFileSync(join(__dirname, 'fixtures', 'explain', `${name}.json`), 'utf8'), {
      relaxed: true,
    }) as { raw: Document }
  ).raw

const stages = (node: PlanNode | null): string[] =>
  node ? [node.stage, ...node.children.flatMap((c) => stages(c))] : []

describe('normaliseExplain (phase 2b spec §2.1)', () => {
  it('reads a classic collection scan with its numbers', () => {
    const view = normaliseExplain(fixture('find-collscan'))
    expect(view.engine).toBe('classic')
    expect(stages(view.winning)).toEqual(['COLLSCAN'])
    expect(view.winning).toMatchObject({ docsExamined: 3000, nReturned: 60 })
    expect(view.winning!.filter).toContain('s3')
    expect(view.summary).toMatchObject({ nReturned: 60, totalDocsExamined: 3000, totalKeysExamined: 0 })
  })

  it('reads an index scan under a fetch, and the rejected plans', () => {
    const view = normaliseExplain(fixture('find-ixscan'))
    expect(stages(view.winning)).toEqual(['FETCH', 'IXSCAN'])
    const ixscan = view.winning!.children[0]!
    expect(ixscan).toMatchObject({
      indexName: expect.stringMatching(/^g_1/),
      keysExamined: expect.any(Number),
    })
    expect(view.rejected.length).toBe(1)
    expect(stages(view.rejected[0]!)).toContain('IXSCAN')
  })

  it('reads a sort, an express _id lookup, an empty collection and a view', () => {
    expect(stages(normaliseExplain(fixture('find-sort')).winning)).toEqual(['SORT', 'COLLSCAN'])
    expect(stages(normaliseExplain(fixture('find-idhack')).winning)).toEqual(['EXPRESS_IXSCAN'])
    expect(stages(normaliseExplain(fixture('find-empty')).winning)).toEqual(['EOF'])
    expect(stages(normaliseExplain(fixture('find-view')).winning)).toEqual(['FETCH', 'IXSCAN'])
  })

  it('reads a planner-only explain without execution numbers', () => {
    const view = normaliseExplain(fixture('find-planner'))
    expect(view.winning).not.toBeNull()
    expect(view.winning!.nReturned).toBeUndefined()
    expect(view.summary.nReturned).toBeUndefined()
  })

  it('reads an aggregation on the slot-based engine: the query plan, then the later stages', () => {
    const view = normaliseExplain(fixture('agg-group'))
    expect(view.engine).toBe('sbe')
    expect(stages(view.winning)).toEqual(['GROUP', 'FETCH', 'IXSCAN'])
    expect(view.winning!.nReturned).toBe(50)
    expect(view.pipeline.map((s) => s.stage)).toEqual(['$sort'])
    expect(view.pipeline[0]).toMatchObject({ nReturned: 50 })
    expect(view.summary.nReturned).toBe(50)
  })

  it('reads a join pushed into the query plan', () => {
    const view = normaliseExplain(fixture('agg-lookup'))
    expect(stages(view.winning)).toEqual(['EQ_LOOKUP', 'LIMIT', 'PROJECTION_SIMPLE', 'COLLSCAN'])
    expect(view.winning).toMatchObject({ foreignCollection: 'shop.other', foreignField: 'k' })
  })

  it('reads the shards of a sharded explain', () => {
    const view = normaliseExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            { shardName: 's0', winningPlan: { stage: 'COLLSCAN' } },
            {
              shardName: 's1',
              winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'a_1' } },
            },
          ],
        },
      },
      executionStats: {
        nReturned: 7,
        executionTimeMillis: 3,
        totalKeysExamined: 4,
        totalDocsExamined: 20,
        executionStages: {
          stage: 'SHARD_MERGE',
          shards: [
            {
              shardName: 's0',
              nReturned: 3,
              totalDocsExamined: 16,
              executionStages: { stage: 'COLLSCAN', nReturned: 3, docsExamined: 16 },
            },
            {
              shardName: 's1',
              nReturned: 4,
              totalDocsExamined: 4,
              executionStages: {
                stage: 'FETCH',
                nReturned: 4,
                inputStage: { stage: 'IXSCAN', indexName: 'a_1', keysExamined: 4 },
              },
            },
          ],
        },
      },
    })
    expect(view.shards!.map((s) => [s.shard, stages(s.winning)])).toEqual([
      ['s0', ['COLLSCAN']],
      ['s1', ['FETCH', 'IXSCAN']],
    ])
    expect(view.shards![0]!.winning).toMatchObject({ docsExamined: 16 })
    expect(view.summary).toMatchObject({ nReturned: 7, totalDocsExamined: 20 })
  })

  it('never throws on a shape it does not know: no plan, and the raw output kept (Review Focus 1)', () => {
    for (const raw of [
      {},
      { queryPlanner: {} },
      { queryPlanner: { winningPlan: { nope: 1 } } },
      { stages: [{}] },
      { stages: 'x' },
    ]) {
      const view = normaliseExplain(raw as Document)
      expect(view.winning).toBeNull()
      expect(view.raw).toBe(raw)
    }
  })
})

describe('adviceFor (phase 2b spec §2.1)', () => {
  const codes = (name: string, ctx = {}) => adviceFor(normaliseExplain(fixture(name)), ctx).map((w) => w.code)

  it('warns about a large collection scan, an in-memory sort and poor selectivity', () => {
    expect(codes('find-collscan')).toEqual(expect.arrayContaining(['COLLSCAN', 'LOW_SELECTIVITY']))
    expect(codes('find-sort')).toEqual(expect.arrayContaining(['COLLSCAN', 'IN_MEMORY_SORT']))
    expect(codes('find-ixscan')).toEqual([])
    expect(codes('find-idhack')).toEqual([])
    expect(codes('agg-group')).toContain('IN_MEMORY_SORT')
  })

  it('warns about a join whose foreign field has no index, when told so', () => {
    expect(codes('agg-lookup', { foreignIndexed: () => false })).toContain('UNINDEXED_LOOKUP')
    expect(codes('agg-lookup', { foreignIndexed: () => true })).not.toContain('UNINDEXED_LOOKUP')
  })

  it('names a stage that takes most of the time', () => {
    const view = normaliseExplain(fixture('agg-group'))
    view.pipeline = [{ stage: '$sort', executionTimeMillisEstimate: 900 }]
    view.summary.executionTimeMillis = 1000
    expect(adviceFor(view, {}).find((w) => w.code === 'SLOW_STAGE')).toMatchObject({ stage: '$sort' })
  })
})

describe('suggestIndex (ESR, phase 2b spec §2.1)', () => {
  const none: Array<{ key: Document }> = [{ key: { _id: 1 } }]

  it('puts equality fields first, then the sort, then ranges', () => {
    expect(suggestIndex({ filter: { a: 1, b: { $gt: 2 } }, sort: { c: -1 } }, none)).toEqual({
      key: [
        ['a', 1],
        ['c', -1],
        ['b', 1],
      ],
      reason: { equality: ['a'], sort: ['c'], range: ['b'] },
    })
    expect(
      suggestIndex({ filter: { a: { $in: [1, 2] }, 'x.y': { $eq: 3 } } }, none)!.reason.equality,
    ).toEqual(['a', 'x.y'])
  })

  it('reads the first $match and $sort of a pipeline', () => {
    const got = suggestIndex({ stages: [{ $match: { g: 2 } }, { $sort: { n: -1 } }, { $limit: 5 }] }, none)
    expect(got!.key).toEqual([
      ['g', 1],
      ['n', -1],
    ])
  })

  it('suggests nothing an index already covers, nothing for _id and nothing for an empty query (Review Focus 5)', () => {
    expect(
      suggestIndex({ filter: { a: 1, b: { $gt: 2 } }, sort: { c: -1 } }, [
        { key: { a: 1, c: -1, b: 1, d: 1 } },
      ]),
    ).toBeNull()
    expect(suggestIndex({ filter: { _id: 5 } }, none)).toBeNull()
    expect(suggestIndex({ filter: {} }, none)).toBeNull()
    expect(suggestIndex({ filter: { $or: [{ a: 1 }, { b: 2 }] } }, none)).toBeNull()
  })
})

describe('normaliser fixes (final review 2b)', () => {
  it('marks a run stopped at its time limit as partial (C1)', () => {
    const view = normaliseExplain({
      queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
      executionStats: {
        executionSuccess: false,
        errorMessage: 'operation exceeded time limit',
        errorCode: 50,
        nReturned: 5,
        totalDocsExamined: 6,
        executionStages: { stage: 'COLLSCAN', nReturned: 5, docsExamined: 6 },
      },
    })
    expect(view.incomplete).toEqual({ code: 50, message: 'operation exceeded time limit' })
    expect(adviceFor(view, {}).map((w) => w.code)[0]).toBe('INCOMPLETE')
  })

  it("turns each stage's cumulative time into its own (I2)", () => {
    const view = normaliseExplain({
      stages: [
        {
          $cursor: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
          executionTimeMillisEstimate: 100,
          nReturned: 900,
        },
        { $group: {}, executionTimeMillisEstimate: 700, nReturned: 3 },
        { $sort: {}, executionTimeMillisEstimate: 800, nReturned: 3 },
      ],
    })
    expect(view.pipeline.map((s) => [s.stage, s.executionTimeMillisEstimate])).toEqual([
      ['$group', 600],
      ['$sort', 100],
    ])
    view.summary.executionTimeMillis = 800
    const slow = adviceFor(view, {}).filter((w) => w.code === 'SLOW_STAGE')
    expect(slow.map((w) => w.stage)).toEqual(['$group'])
  })

  it('keeps a first stage that is not the query (M3), and judges selectivity by what the query returned (M4)', () => {
    const first = normaliseExplain({ stages: [{ $collStats: {} }, { $project: {} }] })
    expect(first.pipeline.map((s) => s.stage)).toEqual(['$collStats', '$project'])
    const grouped = normaliseExplain({
      stages: [
        {
          $cursor: {
            queryPlanner: { winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN' } } },
            executionStats: { nReturned: 5000, totalDocsExamined: 5000, totalKeysExamined: 5000 },
          },
          nReturned: 5000,
        },
        { $group: {}, nReturned: 3 },
      ],
    })
    expect(grouped.summary.nReturned).toBe(3)
    expect(adviceFor(grouped, {}).map((w) => w.code)).not.toContain('LOW_SELECTIVITY')
  })

  it('says whether the plan came from the plan cache (M11)', () => {
    expect(normaliseExplain(fixture('find-collscan')).summary.planCacheUsed).toBe(false)
    expect(
      normaliseExplain({ queryPlanner: { winningPlan: { stage: 'IXSCAN', isCached: true } } }).summary
        .planCacheUsed,
    ).toBe(true)
  })
})

describe('suggestion fixes (final review 2b)', () => {
  const none = [{ key: { _id: 1 } }]

  it('treats a regex literal as a range, as $regex (I6)', () => {
    const got = suggestIndex({ filter: { name: /^Jo/, age: 30 }, sort: { created: -1 } }, none)
    expect(got!.key).toEqual([
      ['age', 1],
      ['created', -1],
      ['name', 1],
    ])
    expect(got!.reason.range).toEqual(['name'])
  })

  it('counts an index with the same equality fields in another order, or a reversed sort, as covering (M5)', () => {
    expect(suggestIndex({ filter: { a: 1, b: 2 } }, [{ key: { b: 1, a: 1 } }])).toBeNull()
    expect(suggestIndex({ filter: {}, sort: { a: 1, b: -1 } }, [{ key: { a: -1, b: 1 } }])).toBeNull()
    expect(suggestIndex({ filter: { a: 1 }, sort: { c: 1 } }, [{ key: { c: 1, a: 1 } }])).not.toBeNull()
  })

  it('notes when an $in meets a sort (M6)', () => {
    expect(suggestIndex({ filter: { a: { $in: [1, 2] } }, sort: { b: 1 } }, none)!.reason.inWithSort).toBe(
      true,
    )
    expect(suggestIndex({ filter: { a: 1 }, sort: { b: 1 } }, none)!.reason.inWithSort).toBeUndefined()
  })
})
