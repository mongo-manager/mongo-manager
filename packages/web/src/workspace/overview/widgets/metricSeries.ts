import type { Metric } from '@mongo-manager/shared/browser'
import type { HistoryAnswer, HistoryPoint, ServerSample } from '@/api/server'

const OPS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const
const MB = 1024 ** 2

export type Series = Array<{ name: string; points: Array<number | null> }>
/** What a metric's values are, for their labels. */
export type MetricUnit = 'perSecond' | 'bytesPerSecond' | 'count' | 'mb' | 'ratio' | 'ms'

export const METRIC_UNITS: Record<Metric, MetricUnit> = {
  opcounters: 'perSecond',
  network: 'bytesPerSecond',
  connections: 'count',
  memory: 'mb',
  cache: 'mb',
  queues: 'count',
  queryTargeting: 'ratio',
  latency: 'ms',
  cursors: 'count',
  transactions: 'perSecond',
  errors: 'perSecond',
}

/** What a live sample and a stored point share (stored rates may be unmeasured: null). */
interface Point {
  ops: Record<(typeof OPS)[number], number | null>
  network: { inPerSec: number | null; outPerSec: number | null }
  connections: { current: number; available: number }
  memory: { residentMb: number; virtualMb: number }
  cache: { usedBytes: number; dirtyBytes: number; maxBytes: number } | null
  queues: { readers: number; writers: number }
  targeting?: ServerSample['targeting']
  latency?: ServerSample['latency']
  cursors?: ServerSample['cursors']
  transactions?: ServerSample['transactions']
  errors?: ServerSample['errors']
}

/** The columns of one metric over a list of points (null where a point says nothing). */
function columns(metric: Metric, read: Array<Point | null>, rated: (p: Point | null) => boolean): Series {
  const col = (name: string, value: (p: Point) => number | null, rate = false) => ({
    name,
    points: read.map((p) => (p && (!rate || rated(p)) ? value(p) : null)),
  })
  switch (metric) {
    case 'opcounters':
      return OPS.map((op) => col(op, (p) => p.ops[op], true))
    case 'network':
      return [col('in', (p) => p.network.inPerSec, true), col('out', (p) => p.network.outPerSec, true)]
    case 'connections':
      return [col('current', (p) => p.connections.current)]
    case 'memory':
      return [col('resident', (p) => p.memory.residentMb), col('virtual', (p) => p.memory.virtualMb)]
    case 'cache':
      return [
        col('used', (p) => (p.cache ? p.cache.usedBytes / MB : null)),
        col('dirty', (p) => (p.cache ? p.cache.dirtyBytes / MB : null)),
      ]
    case 'queues':
      return [col('readers', (p) => p.queues.readers), col('writers', (p) => p.queues.writers)]
    // Widgets wave 2: measured between two readings, so null (a gap) wherever they were not.
    case 'queryTargeting':
      return [
        col('keysScanned', (p) => p.targeting?.keysPerReturned ?? null),
        col('docsScanned', (p) => p.targeting?.docsPerReturned ?? null),
      ]
    case 'latency':
      return [
        col('reads', (p) => p.latency?.readsMs ?? null),
        col('writes', (p) => p.latency?.writesMs ?? null),
        col('commands', (p) => p.latency?.commandsMs ?? null),
      ]
    case 'cursors':
      return [
        col('open', (p) => p.cursors?.open ?? null),
        col('noTimeout', (p) => p.cursors?.noTimeout ?? null),
      ]
    case 'transactions':
      return [
        col('committed', (p) => p.transactions?.committedPerSec ?? null),
        col('aborted', (p) => p.transactions?.abortedPerSec ?? null),
      ]
    case 'errors':
      return [
        col('regular', (p) => p.errors?.regularPerSec ?? null),
        col('user', (p) => p.errors?.userPerSec ?? null),
        col('msg', (p) => p.errors?.msgPerSec ?? null),
        col('cursorTimeouts', (p) => p.errors?.cursorTimeoutsPerSec ?? null),
      ]
  }
}

/**
 * User review 2026-10-09: a metric widget's series from the live samples. Rates of a baseline sample
 * (the first, or right after a restart) are not measured: a gap, never a false zero.
 */
export function liveMetric(metric: Metric, samples: ServerSample[]): { series: Series; unit: MetricUnit } {
  return {
    series: columns(metric, samples, (p) => !(p as ServerSample).baseline),
    unit: METRIC_UNITS[metric],
  }
}

/** A metric's series from stored history: one slot per step of the range, a gap where none was kept. */
export function historyMetric(metric: Metric, answer: HistoryAnswer): { series: Series; unit: MetricUnit } {
  const from = Date.parse(answer.from)
  const to = Date.parse(answer.to)
  const first = Math.floor(from / answer.stepMs) * answer.stepMs
  const slots = Math.max(0, Math.ceil((to - first) / answer.stepMs))
  const byTime = new Map<number, HistoryPoint>(answer.points.map((p) => [p.t, p]))
  const read = Array.from({ length: slots }, (_, i) => byTime.get(first + i * answer.stepMs) ?? null)
  return { series: columns(metric, read, () => true), unit: METRIC_UNITS[metric] }
}
