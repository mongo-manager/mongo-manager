import type { Doc } from './fields'

/**
 * Plugins wave 2 (charts): the read-only pipelines a chart runs on the plugin's collection, within
 * the Documents query (or the whole collection), and the filters that show a part of it in
 * Documents. Everything is canonical Extended JSON, for the app.
 */
export type Measure = 'count' | 'sum' | 'avg' | 'min' | 'max'
export type Unit = 'hour' | 'day' | 'week' | 'month' | 'year'
export const MEASURES: readonly Measure[] = ['count', 'sum', 'avg', 'min', 'max']
export const UNITS: readonly Unit[] = ['hour', 'day', 'week', 'month', 'year']
export const MAX_PERIODS = 1000

const int = (n: number) => ({ $numberInt: String(n) })
/** Values of one BSON type, never an array holding one (review M1: $dateTrunc fails on arrays). */
const only = (type: string) => ({ $type: type, $not: { $type: 'array' } })

/** A field path the server reads as a field: not empty, no empty part, no "$" first. */
function path(field: string): string {
  if (!field || field.startsWith('$') || field.split('.').some((part) => part === ''))
    throw new Error(`"${field}" is not a field`)
  return field
}

/** The query's filter and the chart's own conditions, as one $match (none when there are none). */
function match(filter: Doc, ...own: Doc[]): Doc[] {
  const all = [...(Object.keys(filter).length ? [filter] : []), ...own]
  if (!all.length) return []
  return [{ $match: all.length === 1 ? all[0] : { $and: all } }]
}

/** Count always; sum, average, min and max of another field when one is named. */
function accumulators(of?: string): Doc {
  if (!of) return { count: { $sum: int(1) } }
  const f = `$${path(of)}`
  return { count: { $sum: int(1) }, sum: { $sum: f }, avg: { $avg: f }, min: { $min: f }, max: { $max: f } }
}

export interface GroupSpec {
  field: string
  measure: Measure
  /** The numeric field summed, averaged… (not for a count). */
  of?: string
  filter: Doc
  /** Groups shown; the rest is "Other". */
  top: number
}

/** A field's values, largest first, with the totals that tell what the rest ("Other") holds. */
export function groupPipeline(spec: GroupSpec): Doc[] {
  const of = spec.of || undefined
  if (spec.measure !== 'count' && !of) throw new Error('A sum, average, min or max is of a field')
  const total: Doc = { _id: null, count: { $sum: int(1) } }
  if (of) total.sum = { $sum: `$${path(of)}` }
  return [
    ...match(spec.filter),
    {
      $facet: {
        groups: [
          { $group: { _id: `$${path(spec.field)}`, ...accumulators(of) } },
          { $sort: { [spec.measure]: -1, _id: 1 } },
          { $limit: int(spec.top) },
        ],
        total: [{ $group: total }],
      },
    },
  ]
}

/** A number from canonical Extended JSON (or JSON), or null for anything else. */
export function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const text = o.$numberInt ?? o.$numberLong ?? o.$numberDouble ?? o.$numberDecimal
  if (typeof text !== 'string') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

export interface GroupRow {
  key: unknown
  count: number
  sum: number | null
  avg: number | null
  min: number | null
  max: number | null
}

/**
 * The groups the pipeline found; what the rest adds up to in the chart's measure (a count or a sum
 * only); and the rest's count and sum for the table (review M5).
 */
export function readGroups(
  documents: Doc[],
  measure: Measure,
): { rows: GroupRow[]; other: number | null; rest: { count: number; sum: number | null } | null } {
  const facet = (documents[0] ?? {}) as { groups?: Doc[]; total?: Doc[] }
  const rows = (facet.groups ?? []).map((g) => ({
    key: g._id ?? null,
    count: numberOf(g.count) ?? 0,
    sum: numberOf(g.sum),
    avg: numberOf(g.avg),
    min: numberOf(g.min),
    max: numberOf(g.max),
  }))
  const total = facet.total?.[0]
  let rest: { count: number; sum: number | null } | null = null
  if (total) {
    const count = (numberOf(total.count) ?? 0) - rows.reduce((n, r) => n + r.count, 0)
    const allSum = numberOf(total.sum)
    const sum =
      allSum === null ? null : Math.round((allSum - rows.reduce((n, r) => n + (r.sum ?? 0), 0)) * 1e9) / 1e9
    if (count > 0) rest = { count, sum }
  }
  let other: number | null = null
  if (total && (measure === 'count' || measure === 'sum')) {
    const all = measure === 'count' ? numberOf(total.count) : numberOf(total.sum)
    const shown = rows.reduce((n, r) => n + ((measure === 'count' ? r.count : r.sum) ?? 0), 0)
    if (all !== null) {
      const rest = Math.round((all - shown) * 1e9) / 1e9
      if (rest > 0) other = rest
    }
  }
  return { rows, other, rest }
}

export interface TimeSpec {
  field: string
  unit: Unit
  measure: Measure
  of?: string
  filter: Doc
}

/**
 * A measure over time: the date field truncated to the unit (MongoDB 5.0+), the latest 1,000
 * periods (and one more, read only to know there were more), newest first; the page puts them in
 * order and says when older ones were left out.
 */
export function timePipeline(spec: TimeSpec): Doc[] {
  const f = path(spec.field)
  return [
    ...match(spec.filter, { [f]: only('date') }),
    {
      $group: {
        _id: { $dateTrunc: { date: `$${f}`, unit: spec.unit } },
        ...accumulators(spec.measure === 'count' ? undefined : spec.of),
      },
    },
    { $sort: { _id: int(-1) } },
    // One more than a chart holds, so that exactly MAX_PERIODS is told from more (review 2026-10-10).
    { $limit: int(MAX_PERIODS + 1) },
  ]
}

/** The smallest and largest value of a numeric field: where a histogram's bins go. */
export function extentPipeline(spec: { field: string; filter: Doc }): Doc[] {
  const f = path(spec.field)
  return [
    ...match(spec.filter, { [f]: only('number') }),
    { $group: { _id: null, min: { $min: `$${f}` }, max: { $max: `$${f}` } } },
  ]
}

const double = (n: number) => ({ $numberDouble: Number.isInteger(n) ? n.toFixed(1) : String(n) })
export const MAX_BINS = 60

/**
 * A numeric field in bins of one width from `start`, counted by the bin's index (the last holds its
 * upper bound). Not $bucketAuto: it aims at equal counts, and a histogram of equal counts is flat.
 */
export function binsPipeline(spec: {
  field: string
  filter: Doc
  start: number
  step: number
  bins: number
}): Doc[] {
  const f = path(spec.field)
  const { start, step, bins } = spec
  if (!Number.isFinite(start) || !Number.isFinite(step) || step <= 0) throw new Error('No bin width')
  if (!Number.isInteger(bins) || bins < 1 || bins > MAX_BINS) throw new Error(`1 to ${MAX_BINS} bins`)
  const index = { $floor: { $divide: [{ $subtract: [`$${f}`, double(start)] }, double(step)] } }
  return [
    ...match(spec.filter, { [f]: only('number') }),
    { $group: { _id: { $max: [int(0), { $min: [int(bins - 1), index] }] }, count: { $sum: int(1) } } },
    { $sort: { _id: int(1) } },
    { $limit: int(bins) },
  ]
}

/** Points of two numeric fields, from a sample. */
export function scatterPipeline(spec: { x: string; y: string; filter: Doc; size: number }): Doc[] {
  const x = path(spec.x)
  const y = path(spec.y)
  return [
    ...match(spec.filter, { [x]: only('number') }, { [y]: only('number') }),
    { $sample: { size: int(spec.size) } },
    { $project: { _id: 0, x: `$${x}`, y: `$${y}` } },
  ]
}

const within = (base: Doc, own: Doc): Doc => (Object.keys(base).length ? { $and: [base, own] } : own)

/**
 * The documents of one group: its value through $eq (never an operator); a null group is null or
 * missing, as $group put them together.
 */
export function rowFilter(field: string, key: unknown, base: Doc): Doc {
  const f = path(field)
  return within(base, { [f]: key === null || key === undefined ? null : { $eq: key } })
}

/** The start of the period after the one starting at `ms` (UTC, as $dateTrunc counts). */
export function nextPeriod(ms: number, unit: Unit): number {
  const d = new Date(ms)
  switch (unit) {
    case 'hour':
      return ms + 3_600_000
    case 'day':
      return ms + 86_400_000
    case 'week':
      return ms + 7 * 86_400_000
    case 'month':
    case 'year': {
      const months = unit === 'month' ? 1 : 12
      const year = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + months) / 12)
      const month = (d.getUTCMonth() + months) % 12
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
      return Date.UTC(
        year,
        month,
        Math.min(d.getUTCDate(), last),
        d.getUTCHours(),
        d.getUTCMinutes(),
        d.getUTCSeconds(),
        d.getUTCMilliseconds(),
      )
    }
  }
}

const isoDate = (ms: number) => ({ $date: new Date(ms).toISOString() })

/** The documents of one period of a time chart. */
export function periodFilter(field: string, start: number, unit: Unit, base: Doc): Doc {
  return within(base, { [path(field)]: { $gte: isoDate(start), $lt: isoDate(nextPeriod(start, unit)) } })
}

/** The documents of one bucket (the last one holds its upper bound). */
export function bucketFilter(field: string, min: unknown, max: unknown, last: boolean, base: Doc): Doc {
  return within(base, { [path(field)]: { $gte: min, [last ? '$lte' : '$lt']: max } })
}
