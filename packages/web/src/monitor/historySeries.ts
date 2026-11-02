import type { HistoryAnswer, HistoryPoint } from '@/api/server'

const OPS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const
const MB = 1024 ** 2

type Series = Array<{ name: string; points: Array<number | null> }>

export interface HistorySeries {
  ops: Series
  connections: Series
  network: Series
  memory: Series
}

/**
 * Phase 3b spec §6: stored history as chart series. Every step of the range gets a slot; a step
 * without a sample is null, so the line breaks there instead of joining across the gap. The series
 * names match the live charts' (the view translates connections, network and memory names).
 */
export function historySeries(
  answer: Pick<HistoryAnswer, 'stepMs' | 'points'> & { from: number; to: number },
): HistorySeries {
  const { stepMs } = answer
  const first = Math.floor(answer.from / stepMs) * stepMs
  const slots = Math.max(0, Math.ceil((answer.to - first) / stepMs))
  const byTime = new Map<number, HistoryPoint>(answer.points.map((p) => [p.t, p]))
  const column = (read: (p: HistoryPoint) => number | null) =>
    Array.from({ length: slots }, (_, i) => {
      const p = byTime.get(first + i * stepMs)
      return p ? read(p) : null
    })
  return {
    ops: OPS.map((op) => ({ name: op, points: column((p) => p.ops[op]) })),
    connections: [{ name: 'current', points: column((p) => p.connections.current) }],
    network: [
      { name: 'in', points: column((p) => p.network.inPerSec) },
      { name: 'out', points: column((p) => p.network.outPerSec) },
    ],
    memory: [
      { name: 'resident', points: column((p) => p.memory.residentMb) },
      { name: 'virtual', points: column((p) => p.memory.virtualMb) },
      { name: 'cache', points: column((p) => (p.cache ? p.cache.usedBytes / MB : null)) },
    ],
  }
}
