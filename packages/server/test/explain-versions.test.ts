import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BSON, type Document } from 'mongodb'
import { normaliseExplain } from '../src/explain/normalise'
import { adviceFor } from '../src/explain/advice'
import type { ExplainView, PlanNode } from '../src/explain/types'

/**
 * W5 (completion §2 W5.4, explain spec §5): the normaliser on explain outputs captured from
 * MongoDB 6.0, 7.0, 8.0 and 8.2 and from a sharded 8.2 cluster (scripts/capture-explain.mjs; the
 * 8.2 single-server set is the folder's root). The same data and queries everywhere, so each
 * version must read the same way, whichever engine and output shape it chose.
 */
const SETS = [
  { dir: '6.0', version: /^6\.0\./, idhack: 'IDHACK', aggEngine: 'classic' },
  { dir: '7.0', version: /^7\.0\./, idhack: 'IDHACK', aggEngine: 'classic' },
  { dir: '8.0', version: /^8\.0\./, idhack: 'EXPRESS_IXSCAN', aggEngine: 'sbe' },
  { dir: '', version: /^8\.2\./, idhack: 'EXPRESS_IXSCAN', aggEngine: 'sbe' },
] as const

const load = (dir: string, name: string): { version: string; raw: Document } =>
  BSON.EJSON.parse(readFileSync(join(__dirname, 'fixtures', 'explain', dir, `${name}.json`), 'utf8'), {
    relaxed: true,
  }) as { version: string; raw: Document }
const stages = (node: PlanNode | null): string[] =>
  node ? [node.stage, ...node.children.flatMap((c) => stages(c))] : []
const everyStage = (v: ExplainView) => [
  ...stages(v.winning),
  ...(v.shards ?? []).flatMap((s) => stages(s.winning)),
]
const codes = (v: ExplainView) => adviceFor(v, {}).map((w) => w.code)

describe.each(SETS)('explain fixtures of MongoDB $version', ({ dir, version, idhack, aggEngine }) => {
  const read = (name: string) => {
    const { version: captured, raw } = load(dir, name)
    expect(captured).toMatch(version)
    return normaliseExplain(raw)
  }

  it('reads finds: a scan, an index with rejected plans, a sort, an _id lookup, nothing, a view', () => {
    const scan = read('find-collscan')
    expect(scan.engine).toBe('classic')
    expect(stages(scan.winning)).toEqual(['COLLSCAN'])
    expect(scan.summary).toMatchObject({ nReturned: 60, totalDocsExamined: 3000, totalKeysExamined: 0 })
    expect(codes(scan)).toEqual(expect.arrayContaining(['COLLSCAN', 'LOW_SELECTIVITY']))
    const ix = read('find-ixscan')
    expect(stages(ix.winning)).toEqual(['FETCH', 'IXSCAN'])
    expect(ix.winning!.children[0]).toMatchObject({
      indexName: expect.stringMatching(/^g_1/),
      keysExamined: 415,
    })
    expect(ix.rejected.length).toBeGreaterThanOrEqual(1)
    const sort = read('find-sort')
    expect(stages(sort.winning)).toEqual(['SORT', 'COLLSCAN'])
    expect(codes(sort)).toContain('IN_MEMORY_SORT')
    expect(stages(read('find-idhack').winning)).toEqual([idhack])
    expect(stages(read('find-empty').winning)).toEqual(['EOF'])
    expect(stages(read('find-view').winning)).toEqual(['FETCH', 'IXSCAN'])
  })

  it('reads a planner-only explain: a plan, no numbers', () => {
    const planner = read('find-planner')
    expect(stages(planner.winning)).toContain('IXSCAN')
    expect(planner.summary.nReturned).toBeUndefined()
    expect(planner.winning!.nReturned).toBeUndefined()
  })

  it('reads aggregations on the engine the version chose', () => {
    const group = read('agg-group')
    expect(group.engine).toBe(aggEngine)
    expect(stages(group.winning)).toContain('IXSCAN')
    // The $group is in the query plan (slot-based engine) or after the cursor (classic).
    expect([...stages(group.winning), ...group.pipeline.map((p) => p.stage)]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(GROUP|\$group)$/), '$sort']),
    )
    expect(group.summary).toMatchObject({ nReturned: 50, totalDocsExamined: 429 })
    expect(codes(group)).toContain('IN_MEMORY_SORT')
    const lookup = read('agg-lookup')
    const pushed = everyStage(lookup).includes('EQ_LOOKUP')
    if (pushed) expect(JSON.stringify(lookup.winning)).toContain('shop.other')
    else
      expect(lookup.pipeline).toContainEqual(
        expect.objectContaining({ stage: '$lookup', from: 'other', foreignField: 'k' }),
      )
    expect(lookup.summary.nReturned).toBe(5)
    const count = read('agg-count')
    expect(stages(count.winning)).toContain('COUNT_SCAN')
    expect(count.summary.nReturned).toBe(1)
  })
})

describe('explain fixtures of a sharded MongoDB 8.2 cluster (two shards, a mongos)', () => {
  const read = (name: string) => {
    const { version, raw } = load('8.2-sharded', name)
    expect(version).toMatch(/^8\.2\./)
    return normaliseExplain(raw)
  }
  const shardStages = (v: ExplainView) => (v.shards ?? []).map((s) => [s.shard, stages(s.winning)])

  it('reads a find on both shards, each with its own plan and numbers', () => {
    const scan = read('find-collscan')
    expect(stages(scan.winning)).toEqual(['SHARD_MERGE'])
    expect(shardStages(scan).sort()).toEqual([
      ['shard0', ['SHARDING_FILTER', 'COLLSCAN']],
      ['shard1', ['SHARDING_FILTER', 'COLLSCAN']],
    ])
    expect(scan.summary).toMatchObject({ nReturned: 60, totalDocsExamined: 3000 })
    expect(codes(scan)).toContain('COLLSCAN')
    expect(everyStage(read('find-ixscan'))).toContain('IXSCAN')
    expect(shardStages(read('find-empty'))).toEqual([['shard0', ['EOF']]])
    expect(everyStage(read('find-planner'))).toContain('IXSCAN')
  })

  it('names each warning once, however many shards gave it', () => {
    const sort = read('find-sort')
    const warnings = adviceFor(sort, {}).map((w) => JSON.stringify(w))
    expect(new Set(warnings).size).toBe(warnings.length)
  })

  it('reads an aggregation split between the shards and the merge', () => {
    const group = read('agg-group')
    expect(group.shards).toHaveLength(2)
    for (const shard of group.shards!)
      expect(stages(shard.winning)).toEqual(expect.arrayContaining(['GROUP', 'IXSCAN']))
    expect(stages(group.winning)).toEqual(['SHARD_MERGE'])
    // The shards' numbers add up; what the merge returns is not in the output.
    expect(group.summary).toMatchObject({ totalDocsExamined: 429, totalKeysExamined: 429 })
    expect(group.pipeline.map((p) => p.stage)).toEqual(['$group', '$sort'])
    expect(codes(group)).toContain('IN_MEMORY_SORT')
    expect(group.engine).toBe('sbe')
  })

  it('reads the merge’s join, a counted match and a view targeted at one shard', () => {
    const lookup = read('agg-lookup')
    expect(lookup.shards!.length).toBe(2)
    expect(lookup.pipeline).toContainEqual(
      expect.objectContaining({ stage: '$lookup', from: 'other', foreignField: 'k' }),
    )
    const count = read('agg-count')
    // A shard filters out orphaned documents, so it counts through the index rather than a count scan.
    expect(everyStage(count)).toEqual(expect.arrayContaining(['GROUP', 'SHARDING_FILTER', 'IXSCAN']))
    expect(count.pipeline.map((p) => p.stage)).toEqual(['$group', '$project'])
    const view = read('find-view')
    expect(shardStages(view)).toEqual([
      [expect.stringMatching(/^shard[01]$/), expect.arrayContaining(['IXSCAN'])],
    ])
    expect(view.summary.totalDocsExamined).toBe(2)
  })
})

/**
 * W5 review I6: both shapes a shard answers a mongos aggregation with — its later stages after a
 * $cursor, or the whole of it in the query plan — written by hand, one shard stopped at its time
 * limit in each.
 */
describe('hand-made sharded explains (review I6)', () => {
  const read = (name: string) => normaliseExplain(load('hand', name).raw)
  const unindexed = { foreignIndexed: () => false }

  // W5 re-review: a $group in the query plan returns groups, not the documents the query matched;
  // selectivity is measured below it.
  it('measures selectivity below a group in the plan, not by the groups it returns', () => {
    const grouped = {
      queryPlanner: {
        winningPlan: {
          queryPlan: {
            stage: 'GROUP',
            planNodeId: 3,
            inputStage: {
              stage: 'FETCH',
              planNodeId: 2,
              inputStage: { stage: 'IXSCAN', planNodeId: 1, indexName: 'g_1', keyPattern: { g: 1 } },
            },
          },
        },
      },
      executionStats: {
        nReturned: 3,
        executionTimeMillis: 9,
        totalKeysExamined: 5000,
        totalDocsExamined: 5000,
        executionStages: {
          stage: 'project',
          planNodeId: 3,
          nReturned: 3,
          inputStage: {
            stage: 'fetch',
            planNodeId: 2,
            nReturned: 5000,
            inputStage: { stage: 'ixseek', planNodeId: 1, nReturned: 5000 },
          },
        },
      },
    }
    const view = normaliseExplain(grouped)
    expect(view.summary).toMatchObject({ nReturned: 3, queryReturned: 5000 })
    expect(codes(view)).not.toContain('LOW_SELECTIVITY')
    // The 8.2 capture: the cursor carries the group too.
    const captured = normaliseExplain(load('', 'agg-group').raw)
    expect(captured.summary.queryReturned).toBe(429)
    // A group whose input count is not given: no selectivity at all, rather than a false one.
    const blind = structuredClone(grouped)
    delete (blind.executionStats.executionStages.inputStage as { nReturned?: number }).nReturned
    const unknown = normaliseExplain(blind)
    expect(unknown.summary.queryReturned).toBeUndefined()
    expect(codes(unknown)).not.toContain('LOW_SELECTIVITY')
  })

  // W5 re-review: a figure some shards leave out is not summed over the others, as if it were all.
  it('leaves out a stage’s figure, or a total, that not every shard reports', () => {
    const { raw } = load('hand', 'sharded-stages')
    const shard1 = (raw.shards as Document).shard1 as Document
    const stages = shard1.stages as Document[]
    delete stages[1]!.nReturned
    delete stages[2]!.executionTimeMillisEstimate
    delete ((stages[0]!.$cursor as Document).executionStats as Document).totalKeysExamined
    const view = normaliseExplain(raw)
    expect(view.pipeline[0]).toEqual({
      stage: '$lookup',
      executionTimeMillisEstimate: 900,
      from: 'other',
      foreignField: 'k',
    })
    expect(view.pipeline[1]).toEqual({ stage: '$group', nReturned: 50 })
    expect(view.summary.totalKeysExamined).toBeUndefined()
    expect(view.summary.totalDocsExamined).toBe(15200)
  })

  it('reads shards that answer with stages: the time limit, what the queries returned, each stage summed', () => {
    const view = read('sharded-stages')
    expect(view.incomplete).toEqual({ code: 50, message: 'operation exceeded time limit' })
    expect(view.summary).toMatchObject({
      queryReturned: 429,
      totalDocsExamined: 15200,
      totalKeysExamined: 200,
    })
    // A shard's stage numbers are both shards' together: what they returned summed, the slower time.
    expect(view.pipeline).toEqual([
      {
        stage: '$lookup',
        nReturned: 429,
        executionTimeMillisEstimate: 900,
        from: 'other',
        foreignField: 'k',
      },
      { stage: '$group', nReturned: 50, executionTimeMillisEstimate: 100 },
      { stage: '$group' },
      { stage: '$sort' },
    ])
    const warnings = adviceFor(view, unindexed).map((w) => w.code)
    expect(warnings).toEqual(
      expect.arrayContaining([
        'INCOMPLETE',
        'COLLSCAN',
        'LOW_SELECTIVITY',
        'IN_MEMORY_SORT',
        'UNINDEXED_LOOKUP',
      ]),
    )
  })

  it('reads shards that answer with a query plan: the time limit, and a join pushed into it', () => {
    const view = read('sharded-query')
    expect(view.incomplete).toMatchObject({ code: 50 })
    expect(view.engine).toBe('sbe')
    expect(view.summary).toMatchObject({ queryReturned: 2200, totalDocsExamined: 2204 })
    const warnings = adviceFor(view, unindexed)
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'UNINDEXED_LOOKUP', detail: { coll: 'other', field: 'k' } }),
    )
    expect(warnings.map((w) => w.code)).toContain('INCOMPLETE')
    expect(adviceFor(view, { foreignIndexed: () => true }).map((w) => w.code)).not.toContain(
      'UNINDEXED_LOOKUP',
    )
  })
})

describe('captured explain fixtures (W5 review)', () => {
  it('carry no machine name, cluster clock, signature or session of the capture', () => {
    const base = join(__dirname, 'fixtures', 'explain')
    const dirs = [
      '',
      ...readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    ]
    for (const dir of dirs)
      for (const file of readdirSync(join(base, dir)).filter((f) => f.endsWith('.json'))) {
        const text = readFileSync(join(base, dir, file), 'utf8')
        for (const key of ['"$clusterTime"', '"operationTime"', '"lsid"', '"signature"'])
          expect(text, `${dir}/${file} ${key}`).not.toContain(key)
        for (const host of text.match(/"host": "[^"]*"/g) ?? []) expect(host).toBe('"host": "capture-host"')
      }
  })
})
