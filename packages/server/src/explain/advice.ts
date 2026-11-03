import type { ExplainView, PlanNode, Warning } from './types'

/** Phase 2b spec §2.1 thresholds. */
export const COLLSCAN_DOCS = 1000
export const LOW_SELECTIVITY_RATIO = 10
export const SLOW_STAGE_SHARE = 0.5
/** Below this, a stage's share of the time is noise. */
const SLOW_STAGE_MIN_MS = 100

function* walk(node: PlanNode | null): Generator<PlanNode> {
  if (!node) return
  yield node
  for (const child of node.children) yield* walk(child)
}

/**
 * What a user should know about a plan, as codes the web translates. `foreignIndexed` answers
 * whether a joined collection has an index on the join field (the route asks MongoDB).
 */
export function adviceFor(
  view: ExplainView,
  ctx: { foreignIndexed?: (coll: string, field: string) => boolean },
): Warning[] {
  const out: Warning[] = []
  if (view.incomplete) out.push({ code: 'INCOMPLETE', detail: { ...view.incomplete } })
  const trees = [view.winning, ...(view.shards ?? []).map((s) => s.winning)]
  const nodes = trees.flatMap((t) => [...walk(t)])
  const examined = view.summary.totalDocsExamined
  // Selectivity is the query's: a $group after it returning 3 documents says nothing (M4).
  // W5 re-review: a plan that groups returns groups; without what went into the group, no measure.
  const grouped = nodes.some((n) => n.stage === 'GROUP')
  const returned = view.summary.queryReturned ?? (grouped ? undefined : view.summary.nReturned)

  const scans = nodes.filter((n) => n.stage === 'COLLSCAN')
  const scanned = Math.max(0, ...scans.map((n) => n.docsExamined ?? examined ?? 0))
  if (scans.length && scanned > COLLSCAN_DOCS)
    out.push({ code: 'COLLSCAN', stage: 'COLLSCAN', detail: { docs: scanned } })
  // A plan without execution numbers (asked for alone, or after a run that ran out of time): a scan
  // that filters is named without a count, and its index is still suggested. One that reads the
  // whole collection unfiltered is what was asked for.
  else if (
    scans.some((n) => n.filter) &&
    examined === undefined &&
    scans.every((n) => n.docsExamined === undefined)
  )
    out.push({ code: 'COLLSCAN', stage: 'COLLSCAN', detail: { uncounted: true } })

  const sorts = nodes.some((n) => n.stage === 'SORT') || view.pipeline.some((s) => s.stage === '$sort')
  if (sorts) out.push({ code: 'IN_MEMORY_SORT', stage: 'SORT' })

  if (
    examined !== undefined &&
    returned !== undefined &&
    examined > COLLSCAN_DOCS &&
    examined > LOW_SELECTIVITY_RATIO * Math.max(returned, 1)
  )
    out.push({ code: 'LOW_SELECTIVITY', detail: { examined, returned } })

  for (const n of nodes) {
    const child = n.children[0]
    if (
      n.stage === 'FETCH' &&
      n.filter &&
      child?.stage === 'IXSCAN' &&
      (n.docsExamined ?? 0) > COLLSCAN_DOCS &&
      (n.nReturned ?? 0) * LOW_SELECTIVITY_RATIO < (n.docsExamined ?? 0)
    )
      out.push({ code: 'FETCH_FILTER', stage: 'FETCH', detail: { index: child.indexName } })
  }

  const total = view.summary.executionTimeMillis
  if (total !== undefined && total >= SLOW_STAGE_MIN_MS)
    for (const s of view.pipeline)
      if ((s.executionTimeMillisEstimate ?? 0) > total * SLOW_STAGE_SHARE)
        out.push({ code: 'SLOW_STAGE', stage: s.stage, detail: { ms: s.executionTimeMillisEstimate } })

  if (ctx.foreignIndexed) {
    const joins = [
      ...nodes
        .filter((n) => n.stage === 'EQ_LOOKUP' && n.foreignCollection && n.foreignField)
        .map((n) => [n.foreignCollection!.replace(/^[^.]*\./, ''), n.foreignField!] as const),
      ...view.pipeline
        .filter((s) => s.from && s.foreignField)
        .map((s) => [s.from!, s.foreignField!] as const),
    ]
    for (const [coll, field] of joins)
      if (!ctx.foreignIndexed(coll, field))
        out.push({ code: 'UNINDEXED_LOOKUP', stage: '$lookup', detail: { coll, field } })
  }
  // A sharded plan gives the same warning once per shard: each is said once.
  const seen = new Set<string>()
  return out.filter((w) => {
    const key = JSON.stringify(w)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
