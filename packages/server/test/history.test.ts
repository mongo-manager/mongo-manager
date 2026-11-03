import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import {
  HISTORY_BACKOFF_MS,
  HISTORY_KEEP_MS,
  HistoryRecorder,
  HistoryRepo,
  type RecorderDeps,
} from '../src/monitor/history'
import type { ServerSample } from '../src/monitor/sampler'
import { startMongo, type TestMongo } from './support/mongo'
import { makeApp, type TestApp } from './helpers'
import { slow } from './support/slowness'
import { UNMEASURED } from './support/samples'

/**
 * Phase 3b spec §6: a connection admin turns history on; the server then samples that connection
 * once a minute and keeps 7 days. It never connects on its own to a connection whose history is off.
 */
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const add = (name: string) =>
    ctx.connections.create(
      {
        name,
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
      },
      null,
    ).id
  const a = add('A')
  const b = add('B')
  const repo = new HistoryRepo(ctx.store.db)
  const started: string[] = []
  const stopped: string[] = []
  const deps = (over: Partial<RecorderDeps> = {}): RecorderDeps => ({
    repo,
    client: (id) => ctx.manager.getClient(id),
    hold: (id) => ctx.manager.hold(id),
    now: () => t.clock.now,
    setTimer: (fn, ms) => {
      const id = String(ms)
      started.push(id)
      return { stop: () => stopped.push(id) }
    },
    ...over,
  })
  return { t, ctx, a, b, repo, deps, started, stopped }
}

const sample = (t: number, over: Partial<ServerSample> = {}): ServerSample => ({
  t,
  ops: { insert: 1, query: 10, update: 1, delete: 0, getmore: 0, command: 5 },
  network: { inPerSec: 100, outPerSec: 200 },
  connections: { current: 3, available: 97 },
  memory: { residentMb: 50, virtualMb: 500 },
  cache: { usedBytes: 10, dirtyBytes: 1, maxBytes: 100 },
  queues: { readers: 0, writers: 0 },
  restarted: false,
  baseline: false,
  uptimeSec: 60,
  version: '8.0.4',
  ...UNMEASURED,
  ...over,
})

describe('metric history recorder (phase 3b §6)', () => {
  it('records a sample for an enabled connection and none for others', async () => {
    const { a, b, repo, deps } = await setup()
    repo.setEnabled(a, true)
    const client = vi.fn(deps().client)
    const recorder = new HistoryRecorder(deps({ client }))
    await recorder.tick(a)
    await recorder.tick(b)
    expect(repo.status(a).samples).toBe(1)
    expect(repo.status(b).samples).toBe(0)
    expect(client.mock.calls.map(([id]) => id)).toEqual([a])
  })

  it('samples a connection alerts watch, hands the sample over, and stores nothing for it (W3.3)', async () => {
    const { a, b, repo, deps } = await setup()
    const seen: Array<{ id: string; current: number }> = []
    const recorder = new HistoryRecorder(
      deps({
        extra: () => [b],
        onSample: (id, s) => seen.push({ id, current: s.connections.current }),
      }),
    )
    await recorder.tick(a)
    await recorder.tick(b)
    expect(seen.map((s) => s.id)).toEqual([b])
    expect(seen[0]!.current).toBeGreaterThan(0)
    expect(repo.status(b).samples).toBe(0)
    // History on as well: stored, and still handed over.
    repo.setEnabled(b, true)
    await recorder.tick(b)
    expect(repo.status(b).samples).toBe(1)
    expect(seen).toHaveLength(2)
  })

  it('starts only enabled connections, stops on disable and delete (review focus 1)', async () => {
    const { ctx, a, b, repo, deps } = await setup()
    const timers = new Map<string, number>()
    let next = 0
    const recorder = new HistoryRecorder(
      deps({
        setTimer: () => {
          const id = next++
          timers.set(String(id), 1)
          return { stop: () => timers.delete(String(id)) }
        },
      }),
    )
    const ticked: string[] = []
    vi.spyOn(recorder, 'tick').mockImplementation(async (id) => void ticked.push(id))
    recorder.sync()
    expect(timers.size).toBe(0)
    repo.setEnabled(a, true)
    recorder.sync()
    expect(timers.size).toBe(1)
    expect(ticked).toEqual([a])
    recorder.sync()
    expect(timers.size).toBe(1)
    repo.setEnabled(a, false)
    recorder.sync()
    expect(timers.size).toBe(0)
    repo.setEnabled(b, true)
    recorder.sync()
    repo.add(b, sample(1))
    ctx.connections.delete(b)
    recorder.sync()
    expect(timers.size).toBe(0)
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get()).toEqual({ n: 0 })
    expect(
      ctx.store.db.prepare('SELECT COUNT(*) AS n FROM metric_history WHERE connection_id = ?').get(b),
    ).toEqual({
      n: 0,
    })
  })

  it('backs off after a failure, and keeps no connection string in the error', async () => {
    const { t, a, repo, deps } = await setup()
    repo.setEnabled(a, true)
    let calls = 0
    const recorder = new HistoryRecorder(
      deps({
        client: async () => {
          calls++
          throw new Error('connect mongodb://bob:hunter2@h:1 failed')
        },
      }),
    )
    await recorder.tick(a)
    expect(repo.status(a).lastError).not.toContain('hunter2')
    expect(repo.status(a).lastError).toBeTruthy()
    t.clock.now += 60_000
    await recorder.tick(a)
    expect(calls).toBe(1)
    t.clock.now += HISTORY_BACKOFF_MS
    await recorder.tick(a)
    expect(calls).toBe(2)
  })

  it('gives up on a server that never answers, and asks the driver to stop too (final review I4)', async () => {
    const { a, repo, deps } = await setup()
    repo.setEnabled(a, true)
    const options: Array<Record<string, unknown>> = []
    const hanging = {
      db: () => ({
        command: (_c: unknown, o: Record<string, unknown>) => {
          options.push(o)
          return new Promise(() => {})
        },
      }),
    } as unknown as MongoClient
    let released = 0
    const recorder = new HistoryRecorder(
      deps({ client: async () => hanging, hold: () => () => void released++, timeoutMs: 20 }),
    )
    await recorder.tick(a)
    expect(options[0]?.timeoutMS).toBe(10_000)
    expect(repo.status(a).lastError).toMatch(/timed out/)
    expect(released).toBe(1)
  })

  it('never lets a failing store escape a timer (final review M1)', async () => {
    const { a, repo, deps } = await setup()
    repo.setEnabled(a, true)
    const recorder = new HistoryRecorder(deps())
    vi.spyOn(repo, 'isEnabled').mockImplementation(() => {
      throw new Error('database is closed')
    })
    await expect(recorder.tick(a)).resolves.toBeUndefined()
    vi.spyOn(repo, 'prune').mockImplementation(() => {
      throw new Error('database is closed')
    })
    expect(() => recorder.prune()).not.toThrow()
  })

  it('keeps its pace and its back-off when history is turned off and on (final review M2)', async () => {
    const { t, ctx, a, repo, deps } = await setup()
    repo.setEnabled(a, true)
    let calls = 0
    const recorder = new HistoryRecorder(
      deps({
        client: (id) => {
          calls++
          return ctx.manager.getClient(id)
        },
      }),
    )
    await recorder.tick(a)
    expect(calls).toBe(1)
    const toggle = () => {
      repo.setEnabled(a, false)
      recorder.sync()
      repo.setEnabled(a, true)
      recorder.sync()
    }
    toggle()
    toggle()
    expect(calls).toBe(1)
    t.clock.now += 60_000
    toggle()
    expect(calls).toBe(2)

    let failing = 0
    const failer = new HistoryRecorder(
      deps({
        client: async () => {
          failing++
          throw new Error('down')
        },
      }),
    )
    await failer.tick(a)
    t.clock.now += 60_000
    repo.setEnabled(a, false)
    failer.sync()
    repo.setEnabled(a, true)
    failer.sync()
    expect(failing).toBe(1)
  })

  it('spreads the first samples of many connections over the interval (final review M2)', async () => {
    const { a, b, repo, deps } = await setup()
    repo.setEnabled(a, true)
    repo.setEnabled(b, true)
    const delays: number[] = []
    let calls = 0
    const recorder = new HistoryRecorder(
      deps({
        client: async () => {
          calls++
          throw new Error('down')
        },
        later: (_fn, ms) => {
          delays.push(ms)
          return { stop: () => {} }
        },
      }),
    )
    recorder.start()
    expect(calls).toBe(1)
    expect(delays).toEqual([30_000])
    recorder.stop()
  })

  it('records no error for a connection turned off while it failed (final review M3)', async () => {
    const { a, repo, deps } = await setup()
    repo.setEnabled(a, true)
    let calls = 0
    const recorder = new HistoryRecorder(
      deps({
        client: async () => {
          calls++
          repo.setEnabled(a, false)
          throw new Error('down')
        },
      }),
    )
    await recorder.tick(a)
    expect(repo.status(a).lastError).toBeNull()
    repo.setEnabled(a, true)
    await recorder.tick(a)
    expect(calls).toBe(2)
  })

  it('prunes samples older than 7 days', async () => {
    const { t, a, repo } = await setup()
    repo.add(a, sample(t.clock.now - HISTORY_KEEP_MS - 1))
    repo.add(a, sample(t.clock.now - 1000))
    expect(repo.prune(t.clock.now - HISTORY_KEEP_MS)).toBe(1)
    expect(repo.status(a).samples).toBe(1)
  })

  it('averages into steps, leaves gaps, and skips baselines in the rates', async () => {
    const { a, repo } = await setup()
    const step = 5 * 60_000
    const base = 10 * step
    repo.add(
      a,
      sample(base, {
        baseline: true,
        ops: { insert: 999, query: 999, update: 999, delete: 999, getmore: 999, command: 999 },
      }),
    )
    repo.add(a, sample(base + 60_000, { connections: { current: 5, available: 95 } }))
    repo.add(a, sample(base + 2 * step, { restarted: true }))
    const points = repo.points(a, base, base + 3 * step, step)
    expect(points.map((p) => p.t)).toEqual([base, base + 2 * step])
    expect(points[0]!.ops.query).toBe(10)
    expect(points[0]!.connections.current).toBe(4)
    expect(points[0]!.restarted).toBe(false)
    expect(points[1]!.restarted).toBe(true)
  })

  // Widgets wave 2 (2026-10-27): the new metrics are kept and averaged; a step without them is a gap.
  it('keeps and averages the wave 2 metrics, a gap where none was measured', async () => {
    const { a, repo } = await setup()
    const step = 5 * 60_000
    const base = 20 * step
    const measured = (k: number): Partial<ServerSample> => ({
      targeting: { keysPerReturned: 2 * k, docsPerReturned: 4 * k },
      latency: { readsMs: k, writesMs: 3 * k, commandsMs: null },
      cursors: { open: 10 * k, noTimeout: k },
      transactions: { committedPerSec: k, abortedPerSec: 0 },
      errors: { regularPerSec: 0, userPerSec: k, msgPerSec: 0, cursorTimeoutsPerSec: 2 * k },
    })
    repo.add(a, sample(base, measured(1)))
    repo.add(a, sample(base + 60_000, measured(3)))
    repo.add(a, sample(base + step))
    const [first, second] = repo.points(a, base, base + 2 * step, step)
    expect(first).toMatchObject({
      targeting: { keysPerReturned: 4, docsPerReturned: 8 },
      latency: { readsMs: 2, writesMs: 6, commandsMs: null },
      cursors: { open: 20, noTimeout: 2 },
      transactions: { committedPerSec: 2, abortedPerSec: 0 },
      errors: { regularPerSec: 0, userPerSec: 2, msgPerSec: 0, cursorTimeoutsPerSec: 4 },
    })
    expect(second).toMatchObject({
      targeting: { keysPerReturned: null, docsPerReturned: null },
      latency: { readsMs: null, writesMs: null, commandsMs: null },
      cursors: null,
      transactions: { committedPerSec: null, abortedPerSec: null },
      errors: { regularPerSec: null, userPerSec: null, msgPerSec: null, cursorTimeoutsPerSec: null },
    })
  })

  it('reads a sample kept before the wave 2 metrics as not measured, never as zero', async () => {
    const { ctx, a, repo } = await setup()
    ctx.store.db
      .prepare(
        `INSERT INTO metric_samples (connection_id, ts, conn_current, conn_available, mem_resident,
           mem_virtual, q_readers, q_writers) VALUES (?, ?, 1, 1, 1, 1, 0, 0)`,
      )
      .run(a, 60_000)
    const [point] = repo.points(a, 0, 120_000, 60_000)
    expect(point!.targeting).toEqual({ keysPerReturned: null, docsPerReturned: null })
    expect(point!.cursors).toBeNull()
    expect(point!.errors.userPerSec).toBeNull()
  })

  it('counts and lists enabled connections', async () => {
    const { a, b, repo } = await setup()
    repo.setEnabled(a, true)
    repo.setEnabled(b, true)
    repo.setEnabled(b, false)
    expect(repo.enabled()).toEqual([a])
    expect(repo.countEnabled()).toBe(1)
    expect(repo.isEnabled(b)).toBe(false)
    repo.clear(a)
    expect(repo.status(a).samples).toBe(0)
  })
})
