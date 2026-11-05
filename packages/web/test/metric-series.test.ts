// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { HistoryAnswer, ServerSample } from '../src/api/server'
import { historyMetric, liveMetric } from '../src/workspace/overview/widgets/metricSeries'

const sample = (t: number, over: Partial<ServerSample> = {}): ServerSample => ({
  t,
  ops: { insert: 1, query: 2, update: 3, delete: 4, getmore: 5, command: 6 },
  network: { inPerSec: 100, outPerSec: 200 },
  connections: { current: 7, available: 93 },
  memory: { residentMb: 50, virtualMb: 500 },
  cache: { usedBytes: 2 * 1024 ** 2, dirtyBytes: 1024 ** 2, maxBytes: 8 * 1024 ** 2 },
  queues: { readers: 1, writers: 2 },
  restarted: false,
  ...over,
})

describe('a metric widget’s series (user review 2026-10-09)', () => {
  it('draws each metric from the live samples, rates left out where they are not measured', () => {
    const live = [sample(1, { baseline: true }), sample(2)]
    expect(liveMetric('opcounters', live).series.map((s) => [s.name, s.points])).toEqual([
      ['insert', [null, 1]],
      ['query', [null, 2]],
      ['update', [null, 3]],
      ['delete', [null, 4]],
      ['getmore', [null, 5]],
      ['command', [null, 6]],
    ])
    expect(liveMetric('network', live).series.map((s) => s.points)).toEqual([
      [null, 100],
      [null, 200],
    ])
    expect(liveMetric('connections', live).series).toEqual([{ name: 'current', points: [7, 7] }])
    expect(liveMetric('memory', live).series.map((s) => s.name)).toEqual(['resident', 'virtual'])
    expect(liveMetric('cache', live).series).toEqual([
      { name: 'used', points: [2, 2] },
      { name: 'dirty', points: [1, 1] },
    ])
    expect(liveMetric('queues', [sample(1, { cache: null })]).series).toEqual([
      { name: 'readers', points: [1] },
      { name: 'writers', points: [2] },
    ])
    expect(liveMetric('cache', [sample(1, { cache: null })]).series[0]!.points).toEqual([null])
  })

  // Widgets wave 2 (2026-10-27).
  it('draws query targeting, latency, cursors, transactions and errors, a gap where unmeasured', () => {
    const measured = sample(2, {
      targeting: { keysPerReturned: 3, docsPerReturned: 12 },
      latency: { readsMs: 0.5, writesMs: 2, commandsMs: null },
      cursors: { open: 4, noTimeout: 1 },
      transactions: { committedPerSec: 6, abortedPerSec: 1 },
      errors: { regularPerSec: 0, userPerSec: 2, msgPerSec: 0, cursorTimeoutsPerSec: 1 },
    })
    // An older server's sample says nothing of them.
    const live = [sample(1), measured]
    const drawn = (m: Parameters<typeof liveMetric>[0]) =>
      liveMetric(m, live).series.map((s) => [s.name, s.points])
    expect(drawn('queryTargeting')).toEqual([
      ['keysScanned', [null, 3]],
      ['docsScanned', [null, 12]],
    ])
    expect(drawn('latency')).toEqual([
      ['reads', [null, 0.5]],
      ['writes', [null, 2]],
      ['commands', [null, null]],
    ])
    expect(drawn('cursors')).toEqual([
      ['open', [null, 4]],
      ['noTimeout', [null, 1]],
    ])
    expect(drawn('transactions')).toEqual([
      ['committed', [null, 6]],
      ['aborted', [null, 1]],
    ])
    expect(drawn('errors')).toEqual([
      ['regular', [null, 0]],
      ['user', [null, 2]],
      ['msg', [null, 0]],
      ['cursorTimeouts', [null, 1]],
    ])
    expect(liveMetric('queryTargeting', live).unit).toBe('ratio')
    expect(liveMetric('latency', live).unit).toBe('ms')
    expect(liveMetric('cursors', live).unit).toBe('count')
    expect(liveMetric('errors', live).unit).toBe('perSecond')
  })

  it('draws a metric from stored history, a gap where no sample was kept', () => {
    const answer: HistoryAnswer = {
      range: '1h',
      stepMs: 60_000,
      from: new Date(0).toISOString(),
      to: new Date(180_000).toISOString(),
      points: [
        {
          t: 0,
          ops: { insert: 1, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
          network: { inPerSec: 5, outPerSec: 6 },
          connections: { current: 3, available: 97 },
          memory: { residentMb: 10, virtualMb: 20 },
          cache: null,
          queues: { readers: 0, writers: 1 },
          restarted: false,
        },
        {
          t: 120_000,
          ops: { insert: 2, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
          network: { inPerSec: 7, outPerSec: 8 },
          connections: { current: 4, available: 96 },
          memory: { residentMb: 11, virtualMb: 21 },
          cache: null,
          queues: { readers: 2, writers: 3 },
          restarted: false,
        },
      ],
    }
    expect(historyMetric('connections', answer).series).toEqual([{ name: 'current', points: [3, null, 4] }])
    expect(historyMetric('queues', answer).series[1]).toEqual({ name: 'writers', points: [1, null, 3] })
    expect(historyMetric('opcounters', answer).series[0]).toEqual({ name: 'insert', points: [1, null, 2] })
  })
})
