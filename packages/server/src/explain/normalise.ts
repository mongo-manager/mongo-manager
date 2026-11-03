import type { Document } from 'mongodb'
import { formatShell } from '@mongo-manager/shared'
import type { ExplainSummary, ExplainView, PipelineStage, PlanNode } from './types'

const MAX_FILTER = 500
const MAX_DEPTH = 100

const isObject = (v: unknown): v is Document => v !== null && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'bigint'
        ? Number(v)
        : Number((v as { valueOf?(): unknown })?.valueOf?.())
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function filterText(filter: unknown): string | undefined {
  if (!isObject(filter) || Object.keys(filter).length === 0) return undefined
  let text: string
  try {
    text = formatShell(filter, { indent: 0 })
  } catch {
    text = JSON.stringify(filter)
  }
  return text.length > MAX_FILTER ? `${text.slice(0, MAX_FILTER)}…` : text
}

/** The child stages of a classic or query-plan node. */
const childrenOf = (node: Document): Document[] =>
  [
    ...(isObject(node.inputStage) ? [node.inputStage] : []),
    ...(Array.isArray(node.inputStages) ? node.inputStages.filter(isObject) : []),
    ...(isObject(node.outerStage) ? [node.outerStage] : []),
    ...(isObject(node.innerStage) ? [node.innerStage] : []),
  ] as Document[]

/** A plan node (planner or execution stats), with whatever numbers it carries. */
function toNode(node: Document, depth = 0): PlanNode | null {
  if (depth > MAX_DEPTH || typeof node.stage !== 'string') return null
  const out: PlanNode = { stage: node.stage, children: [] }
  const set = <K extends keyof PlanNode>(key: K, value: PlanNode[K] | undefined) => {
    if (value !== undefined) out[key] = value
  }
  set('indexName', str(node.indexName))
  set('keyPattern', isObject(node.keyPattern) ? node.keyPattern : undefined)
  set('direction', str(node.direction))
  set('isMultiKey', typeof node.isMultiKey === 'boolean' ? node.isMultiKey : undefined)
  set('filter', filterText(node.filter))
  set('nReturned', num(node.nReturned))
  set('docsExamined', num(node.docsExamined))
  set('keysExamined', num(node.keysExamined))
  set('executionTimeMillisEstimate', num(node.executionTimeMillisEstimate))
  set('foreignCollection', str(node.foreignCollection))
  set('foreignField', str(node.foreignField))
  for (const child of childrenOf(node)) {
    const c = toNode(child, depth + 1)
    if (c) out.children.push(c)
  }
  return out
}

/**
 * Slot-based execution stages are the engine's own, not the query plan's: they carry the
 * planNodeId of the plan node they implement. The outermost one per id gives that node's output.
 */
function sbeStats(stages: unknown, into = new Map<number, Document>(), depth = 0): Map<number, Document> {
  if (!isObject(stages) || depth > MAX_DEPTH * 4) return into
  const id = num(stages.planNodeId)
  if (id !== undefined && !into.has(id)) into.set(id, stages)
  for (const key of ['inputStage', 'outerStage', 'innerStage', 'thenStage', 'elseStage'])
    sbeStats(stages[key], into, depth + 1)
  if (Array.isArray(stages.inputStages)) for (const s of stages.inputStages) sbeStats(s, into, depth + 1)
  return into
}

function withSbeStats(plan: Document, stats: Map<number, Document>, depth = 0): PlanNode | null {
  const node = toNode(
    { ...plan, inputStage: undefined, inputStages: undefined, outerStage: undefined, innerStage: undefined },
    depth,
  )
  if (!node) return null
  const s = stats.get(num(plan.planNodeId) ?? -1)
  if (s) {
    const n = num(s.nReturned)
    const t = num(s.executionTimeMillisEstimate)
    if (n !== undefined) node.nReturned = n
    if (t !== undefined) node.executionTimeMillisEstimate = t
  }
  for (const child of childrenOf(plan)) {
    const c = withSbeStats(child, stats, depth + 1)
    if (c) node.children.push(c)
  }
  return node
}

const summaryOf = (stats: unknown): ExplainSummary => {
  if (!isObject(stats)) return {}
  const out: ExplainSummary = {}
  for (const key of ['nReturned', 'executionTimeMillis', 'totalKeysExamined', 'totalDocsExamined'] as const) {
    const v = num(stats[key])
    if (v !== undefined) out[key] = v
  }
  return out
}

/** The winning plan of one queryPlanner + executionStats pair, on either engine. */
function planOf(planner: Document, stats: unknown): { winning: PlanNode | null; engine: 'classic' | 'sbe' } {
  const winning = planner.winningPlan
  if (!isObject(winning)) return { winning: null, engine: 'classic' }
  if (isObject(winning.queryPlan)) {
    const execution = isObject(stats) ? stats.executionStages : undefined
    return { winning: withSbeStats(winning.queryPlan, sbeStats(execution)), engine: 'sbe' }
  }
  // Classic: the execution stages mirror the plan and carry its numbers.
  const execution = isObject(stats) && isObject(stats.executionStages) ? stats.executionStages : null
  return { winning: toNode(execution ?? winning), engine: 'classic' }
}

function shardsOf(planner: Document, stats: unknown): ExplainView['shards'] {
  const planned = isObject(planner.winningPlan) ? planner.winningPlan.shards : undefined
  if (!Array.isArray(planned)) return undefined
  const executed =
    isObject(stats) && isObject(stats.executionStages) && Array.isArray(stats.executionStages.shards)
      ? (stats.executionStages.shards as Document[])
      : []
  return planned.filter(isObject).map((shard) => {
    const name = str(shard.shardName) ?? '?'
    const run = executed.find((e) => isObject(e) && e.shardName === name)
    const plan = planOf(shard, run ? { executionStages: run.executionStages } : undefined)
    return { shard: name, summary: summaryOf(run), winning: plan.winning }
  })
}

/** A stage of an aggregation's explain (or of a merge's part): its name, what it returned, what it joins. */
function pipelineStage(s: Document): PipelineStage {
  const stage = Object.keys(s).find((k) => k.startsWith('$')) ?? '?'
  const out: PipelineStage = { stage }
  const n = num(s.nReturned)
  if (n !== undefined) out.nReturned = n
  const body = s[stage]
  if (stage === '$lookup' && isObject(body)) {
    if (typeof body.from === 'string') out.from = body.from
    if (typeof body.foreignField === 'string') out.foreignField = body.foreignField
  }
  return out
}

/** The first $group of a plan (the outermost), or null. */
function groupIn(node: PlanNode | null, depth = 0): PlanNode | null {
  if (!node || depth > MAX_DEPTH) return null
  if (node.stage === 'GROUP') return node
  for (const child of node.children) {
    const found = groupIn(child, depth + 1)
    if (found) return found
  }
  return null
}

/** W5 re-review: every shard's figure, or none — a sum over some shards is not the cluster's. */
function fromEvery(values: Array<number | undefined>): number[] | null {
  return values.length > 0 && values.every((n) => n !== undefined) ? (values as number[]) : null
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

/**
 * Review I6: the stages every shard ran after its query, once: what they returned summed, the
 * slowest shard's time — each only where every shard gives it. Shards that ran different stages
 * give the first shard's names alone, never one shard's numbers as if they were all of them.
 */
function shardStages(lists: PipelineStage[][]): PipelineStage[] {
  const [first = []] = lists
  const names = (l: PipelineStage[]) => l.map((s) => s.stage).join('|')
  if (!lists.every((l) => names(l) === names(first)))
    return first.map(({ stage, from, foreignField }) => ({
      stage,
      ...(from !== undefined ? { from } : {}),
      ...(foreignField !== undefined ? { foreignField } : {}),
    }))
  return first.map((stage, i) => {
    const { nReturned: _n, executionTimeMillisEstimate: _t, ...out } = stage
    const counts = fromEvery(lists.map((l) => l[i]!.nReturned))
    const times = fromEvery(lists.map((l) => l[i]!.executionTimeMillisEstimate))
    if (counts) (out as PipelineStage).nReturned = sum(counts)
    if (times) (out as PipelineStage).executionTimeMillisEstimate = Math.max(...times)
    return out as PipelineStage
  })
}

/**
 * W5 (explain fixtures of a sharded cluster): an aggregation, or a find on a view, through mongos
 * answers each shard's own explain by the shard's name, and the stages the merge runs after them.
 * Each shard reads as a single server; the shards' numbers add up, while what the merge returns is
 * not in the output.
 */
function fromShards(raw: Document, view: ExplainView): ExplainView {
  const each = Object.entries(raw.shards as Document)
    .filter(([, explain]) => isObject(explain))
    .map(([shard, explain]) => ({ shard, v: normaliseExplain(explain as Document, 1) }))
  view.shards = each.map(({ shard, v }) => ({ shard, summary: v.summary, winning: v.winning }))
  view.engine = each.some(({ v }) => v.engine === 'sbe') ? 'sbe' : 'classic'
  view.winning = { stage: each.length === 1 ? 'SINGLE_SHARD' : 'SHARD_MERGE', children: [] }
  for (const key of ['totalKeysExamined', 'totalDocsExamined'] as const) {
    const values = fromEvery(each.map(({ v }) => v.summary[key]))
    if (values) view.summary[key] = sum(values)
  }
  const times = fromEvery(each.map(({ v }) => v.summary.executionTimeMillis))
  if (times) view.summary.executionTimeMillis = Math.max(...times)
  // Review I6: what the shards' queries returned, before their later stages (the selectivity's
  // measure); a shard whose plan groups gives what went into its group, or nothing (re-review).
  const returned = fromEvery(
    each.map(({ v }) => v.summary.queryReturned ?? (groupIn(v.winning) ? undefined : v.summary.nReturned)),
  )
  if (returned) view.summary.queryReturned = sum(returned)
  // One shard ran the whole pipeline: what it returned is the answer.
  if (each.length === 1 && !isObject(raw.splitPipeline)) Object.assign(view.summary, each[0]!.v.summary)
  // Review I6: a shard stopped at its time limit leaves the whole answer partial.
  const stopped = each.find(({ v }) => v.incomplete)
  if (stopped) view.incomplete = stopped.v.incomplete
  const merger =
    isObject(raw.splitPipeline) && Array.isArray(raw.splitPipeline.mergerPart)
      ? raw.splitPipeline.mergerPart
      : []
  view.pipeline = [
    ...shardStages(each.map(({ v }) => v.pipeline)),
    ...(merger as unknown[])
      .filter(isObject)
      .filter((s) => !('$mergeCursors' in s))
      .map(pipelineStage),
  ]
  return view
}

/**
 * Phase 2b spec §2.1: any explain output in one shape. Finds carry queryPlanner at the top; an
 * aggregation carries it in its first stage's $cursor (or at the top when the whole pipeline was
 * pushed into the query). An output it does not understand gives no plan, never an error.
 */
export function normaliseExplain(raw: Document, depth = 0): ExplainView {
  const view: ExplainView = { summary: {}, winning: null, rejected: [], pipeline: [], engine: 'classic', raw }
  try {
    // Through mongos: the shards by name (a shard's own explain never nests shards again).
    if (depth === 0 && !isObject(raw.queryPlanner) && !Array.isArray(raw.stages) && isObject(raw.shards))
      return fromShards(raw, view)
    let planner: unknown = raw.queryPlanner
    let stats: unknown = raw.executionStats
    let queryReturned: number | undefined
    if (!isObject(planner) && Array.isArray(raw.stages) && isObject(raw.stages[0])) {
      const first = raw.stages[0] as Document
      const cursor = first.$cursor
      // The time of each later stage includes the stages before it (final review 2b, I2).
      let before = 0
      if (isObject(cursor)) {
        planner = cursor.queryPlanner
        stats = cursor.executionStats
        queryReturned = num(first.nReturned) ?? (isObject(stats) ? num(stats.nReturned) : undefined)
        before = num(first.executionTimeMillisEstimate) ?? 0
      }
      // Only a $cursor first stage is the query; any other first stage is part of the pipeline (M3).
      view.pipeline = (raw.stages as unknown[])
        .slice(isObject(cursor) ? 1 : 0)
        .filter(isObject)
        .map((s): PipelineStage => {
          const out = pipelineStage(s)
          const t = num(s.executionTimeMillisEstimate)
          if (t !== undefined) {
            out.executionTimeMillisEstimate = Math.max(0, t - before)
            before = t
          }
          return out
        })
    }
    if (!isObject(planner)) return view
    view.summary = summaryOf(stats)
    if (queryReturned !== undefined) view.summary.queryReturned = queryReturned
    if (isObject(planner.winningPlan) && typeof planner.winningPlan.isCached === 'boolean')
      view.summary.planCacheUsed = planner.winningPlan.isCached
    // A run stopped by its time limit answers ok with partial numbers (final review 2b, C1).
    if (isObject(stats) && stats.executionSuccess === false) {
      view.incomplete = {}
      const code = num(stats.errorCode)
      if (code !== undefined) view.incomplete.code = code
      if (typeof stats.errorMessage === 'string') view.incomplete.message = stats.errorMessage
    }
    const plan = planOf(planner, stats)
    view.winning = plan.winning
    view.engine = plan.engine
    // W5 re-review: a $group in the plan returns groups; what the query matched is what went into it.
    const group = groupIn(view.winning)
    if (group) {
      const below = group.children[0]?.nReturned
      if (below !== undefined) view.summary.queryReturned = below
      else delete view.summary.queryReturned
    }
    view.shards = shardsOf(planner, stats)
    if (view.shards) view.winning = view.winning ?? toNode(planner.winningPlan as Document)
    if (Array.isArray(planner.rejectedPlans))
      view.rejected = planner.rejectedPlans
        .filter(isObject)
        .map((p) => (isObject(p.queryPlan) ? toNode(p.queryPlan) : toNode(p)))
        .filter((p): p is PlanNode => p !== null)
    // An aggregation returns what its last stage returns.
    const last = view.pipeline.at(-1)
    if (last?.nReturned !== undefined) view.summary.nReturned = last.nReturned
  } catch {
    view.winning = null
  }
  return view
}
