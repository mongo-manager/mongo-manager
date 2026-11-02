import type { SlowQuery } from '@/api/server'

/** The slow queries of one shape: on one namespace, of one kind, asking the same thing. */
export interface ShapeGroup {
  key: string
  ns: string
  op: string
  shape: string
  count: number
  totalMs: number
  avgMs: number
  p95Ms: number
  maxMs: number
  lastTs: string
  /** Documents read per document returned, on average; null where none said. */
  ratio: number | null
  /** The newest query of the group, to open. */
  newest: SlowQuery
}

/**
 * Index advice gaps (2026-10-27, wave 4 #6): slow queries counted together by what they asked — by
 * MongoDB's own shape hash where it gave one (8.0+), else by the app's shape — the costliest first.
 */
export function groupByShape(entries: readonly SlowQuery[]): ShapeGroup[] {
  const groups = new Map<string, SlowQuery[]>()
  for (const e of entries) {
    const key = JSON.stringify([e.ns, e.op, e.shapeHash ?? e.shape])
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const times = list.map((e) => e.durationMs).sort((a, b) => a - b)
      const totalMs = times.reduce((n, ms) => n + ms, 0)
      const newest = list.reduce((a, b) => (Date.parse(b.ts) > Date.parse(a.ts) ? b : a))
      const ratios = list
        .filter((e) => e.docsExamined !== undefined)
        .map((e) => e.docsExamined! / Math.max(1, e.nreturned ?? 0))
      return {
        key,
        ns: list[0]!.ns,
        op: list[0]!.op,
        shape: newest.shape,
        count: list.length,
        totalMs,
        avgMs: Math.round(totalMs / list.length),
        p95Ms: times[Math.max(0, Math.ceil(0.95 * times.length) - 1)]!,
        maxMs: times.at(-1)!,
        lastTs: newest.ts,
        ratio: ratios.length ? Math.round(ratios.reduce((a, b) => a + b, 0) / ratios.length) : null,
        newest,
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs)
}
