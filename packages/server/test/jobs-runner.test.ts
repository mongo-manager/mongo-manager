import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { JobRepo } from '../src/jobs/repo'
import {
  JobRunner,
  KEEP_FINISHED_MS,
  MAX_PER_CONNECTION,
  MAX_PER_USER,
  MAX_ROWS,
  MAX_TOTAL,
} from '../src/jobs/runner'
import type { JobContext, JobKind, JobRecord } from '../src/jobs/types'
import { makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
const runners: JobRunner[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const r of runners.splice(0)) r.close()
  for (const t of apps.splice(0)) await t.close()
})

/** A job kind the test drives by hand: each run waits until the test settles it. */
function manualKind(name: JobKind<unknown>['name'] = 'collection.duplicate') {
  const runs: Array<{ ctx: JobContext; resolve: () => void; reject: (e: unknown) => void }> = []
  let cancelAnswer = true
  const cancelled: string[] = []
  const kind: JobKind<unknown> = {
    name,
    run: (ctx) =>
      new Promise<void>((resolve, reject) => {
        runs.push({ ctx, resolve, reject })
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    cancel: async (ctx) => {
      cancelled.push(ctx.comment)
      return cancelAnswer
    },
    recover: () => (name === 'index.create' ? 'unknown' : 'interrupted'),
  }
  return {
    kind,
    runs,
    cancelled,
    answerCancel: (v: boolean) => (cancelAnswer = v),
  }
}

async function setup() {
  const t = await makeApp()
  apps.push(t)
  const connection = (name: string) =>
    t.app.ctx.connections.create(
      {
        name,
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1' }] }),
      },
      null,
    ).id
  const c1 = connection('one')
  const users = new Map<string, string>()
  /** A real user id (jobs.user_id references users). */
  const user = (name: string) => {
    if (!users.has(name))
      users.set(name, t.app.ctx.users.create({ username: name, passwordHash: 'x', role: 'editor' }).id)
    return users.get(name)!
  }
  const holds: string[] = []
  const released: string[] = []
  const make = () => {
    const runner = new JobRunner({
      repo: new JobRepo(t.app.ctx.store.db),
      now: () => Date.now(),
      hold: (id) => {
        holds.push(id)
        return () => released.push(id)
      },
      describe: (e) => `failed: ${(e as Error).message}`,
      cancelGraceMs: 100,
    })
    runners.push(runner)
    return runner
  }
  const runner = make()
  const target = (over: Partial<{ userId: string | null; connectionId: string; target: string }> = {}) => ({
    userId: null,
    connectionId: c1,
    db: 'd',
    coll: 'c',
    target: 'c_copy',
    ...over,
  })
  return { t, runner, make, connection, user, c1, holds, released, target }
}

const tick = () => new Promise((r) => setImmediate(r))

describe('JobRunner (phase 1h spec §3)', () => {
  it('persists a running job, holds its connection, and settles it as done', async () => {
    const { runner, c1, holds, released, target, make } = await setup()
    const m = manualKind()
    const job = runner.start(m.kind, target(), {})
    expect(job).toMatchObject({ state: 'running', connectionId: c1, target: 'c_copy', finishedAt: null })
    expect(holds).toEqual([c1])
    // Another process reading the table sees it too.
    expect(make().get(job.id)?.state).toBe('running')
    m.runs[0]!.resolve()
    await tick()
    expect(runner.get(job.id)).toMatchObject({ state: 'done', error: null })
    expect(runner.get(job.id)!.finishedAt).toBeTypeOf('number')
    expect(released).toEqual([c1])
  })

  it('settles a rejected job as failed with the described message', async () => {
    const { runner, target } = await setup()
    const m = manualKind()
    const job = runner.start(m.kind, target(), {})
    m.runs[0]!.reject(new Error('E11000 duplicate key'))
    await tick()
    expect(runner.get(job.id)).toMatchObject({ state: 'failed', error: 'failed: E11000 duplicate key' })
  })

  it('refuses a job over the per-connection, per-user and total limits', async () => {
    const { runner, target, connection, user } = await setup()
    const m = manualKind()
    for (let i = 0; i < MAX_PER_CONNECTION; i++) runner.start(m.kind, target({ userId: user(`u${i}`) }), {})
    expect(() => runner.start(m.kind, target({ userId: user('u9') }), {})).toThrow(
      `${MAX_PER_CONNECTION} jobs are already running on this connection`,
    )
    const c2 = connection('two')
    const c3 = connection('three')
    for (let i = 0; i < MAX_PER_USER; i++)
      runner.start(m.kind, target({ userId: user('busy'), connectionId: i < 2 ? c2 : c3 }), {})
    expect(() =>
      runner.start(m.kind, target({ userId: user('busy'), connectionId: connection('four') }), {}),
    ).toThrow(`You already have ${MAX_PER_USER} jobs running`)
    expect(runner.runningCount()).toBe(8)
    for (let i = 0; i < MAX_TOTAL - 8; i++)
      runner.start(m.kind, target({ userId: user(`x${i}`), connectionId: connection(`c${i}`) }), {})
    expect(() =>
      runner.start(m.kind, target({ userId: user('late'), connectionId: connection('late') }), {}),
    ).toThrow(`${MAX_TOTAL} jobs are already running`)
  })

  it('coalesces progress to one change per job per 500 ms and delivers the final state at once', async () => {
    vi.useFakeTimers()
    const { runner, target } = await setup()
    const m = manualKind('index.create')
    const seen: JobRecord[] = []
    runner.onChange((j) => seen.push(j))
    runner.start(m.kind, target(), {})
    expect(seen.map((j) => j.state)).toEqual(['running'])
    for (let i = 1; i <= 10; i++) m.runs[0]!.ctx.progress(i, 10)
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(500)
    expect(seen).toHaveLength(2)
    expect(seen[1]!.progress).toEqual({ done: 10, total: 10 })
    m.runs[0]!.ctx.progress(10, 10)
    m.runs[0]!.resolve()
    await vi.runOnlyPendingTimersAsync()
    expect(seen.at(-1)!.state).toBe('done')
    // Nothing trails after the final state.
    const count = seen.length
    vi.advanceTimersByTime(2000)
    expect(seen).toHaveLength(count)
  })

  it('cancels a running job when its kind stops the operation', async () => {
    const { runner, target, released, c1 } = await setup()
    const m = manualKind()
    const job = runner.start(m.kind, target(), {})
    expect(await runner.cancel(job.id)).toBe('cancelled')
    expect(runner.get(job.id)).toMatchObject({ state: 'cancelled', error: null })
    expect(m.cancelled).toEqual([`mm-job:${job.id}`])
    expect(released).toEqual([c1])
  })

  it('leaves a job to its own outcome when the operation had already ended (Review Focus 1)', async () => {
    const { runner, target } = await setup()
    const m = manualKind()
    m.answerCancel(false)
    const job = runner.start(m.kind, target(), {})
    const pending = runner.cancel(job.id)
    m.runs[0]!.resolve()
    expect(await pending).toBe('finished')
    expect(runner.get(job.id)!.state).toBe('done')
    // A finished job is not cancelled again, and its kind is not asked.
    expect(await runner.cancel(job.id)).toBe('finished')
    expect(m.cancelled).toHaveLength(1)
  })

  it('ends cancelled when the kind stopped the operation, even if the run settled meanwhile', async () => {
    const { runner, target } = await setup()
    let finishCancel!: (v: boolean) => void
    const m = manualKind()
    m.kind.cancel = () => new Promise<boolean>((r) => (finishCancel = r))
    const job = runner.start(m.kind, target(), {})
    const pending = runner.cancel(job.id)
    // The index was dropped just as the build was completing: the build reports success.
    m.runs[0]!.resolve()
    await tick()
    expect(runner.get(job.id)!.state).toBe('running')
    finishCancel(true)
    expect(await pending).toBe('cancelled')
    expect(runner.get(job.id)!.state).toBe('cancelled')
  })

  it('answers not-stopped at once when the kind could not stop a job that keeps running (final review I3)', async () => {
    const { runner, target } = await setup()
    const m = manualKind()
    m.answerCancel(false)
    const job = runner.start(m.kind, target(), {})
    const started = Date.now()
    expect(await runner.cancel(job.id)).toBe('not-stopped')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(runner.get(job.id)!.state).toBe('running')
    m.runs[0]!.resolve()
    await tick()
    expect(runner.get(job.id)!.state).toBe('done')
  })

  it('answers pending when the kind stopped a job that has not ended yet, which then ends cancelled (I3)', async () => {
    const { runner, target } = await setup()
    const m = manualKind()
    // The operation was told to stop, but the run takes its time to notice.
    m.kind.run = () =>
      new Promise<void>((resolve) => m.runs.push({ ctx: null as never, resolve, reject: () => undefined }))
    const job = runner.start(m.kind, target(), {})
    expect(await runner.cancel(job.id)).toBe('pending')
    expect(runner.get(job.id)!.state).toBe('running')
    m.runs[0]!.resolve()
    await tick()
    expect(runner.get(job.id)!.state).toBe('cancelled')
  })

  it('keeps the staging name and the estimate in the table while the job runs', async () => {
    const { runner, target, make } = await setup()
    const m = manualKind()
    const job = runner.start(m.kind, target(), {})
    m.runs[0]!.ctx.setStaging('mm_duplicate_ab')
    m.runs[0]!.ctx.setEstimate(1234)
    expect(make().get(job.id)).toMatchObject({ staging: 'mm_duplicate_ab', estimate: 1234 })
  })

  it('settles jobs a previous process left running, by kind', async () => {
    const { runner, target, make } = await setup()
    const dup = manualKind('collection.duplicate')
    const idx = manualKind('index.create')
    const a = runner.start(dup.kind, target(), {})
    const b = runner.start(idx.kind, target({ target: 'n_1' }), {})
    const next = make()
    next.recover({
      'collection.duplicate': dup.kind,
      'index.create': idx.kind,
      'data.import': manualKind('data.import').kind,
      'data.importSql': manualKind('data.importSql').kind,
      'data.export': manualKind('data.export').kind,
      'data.copy': manualKind('data.copy').kind,
      'data.compare': manualKind('data.compare').kind,
      'data.sync': manualKind('data.sync').kind,
      'backup.dump': manualKind('backup.dump').kind,
      'backup.restore': manualKind('backup.restore').kind,
      'backup.send': manualKind('backup.send').kind,
      'backup.fetch': manualKind('backup.fetch').kind,
      'backup.drill': manualKind('backup.drill').kind,
    })
    expect(next.get(a.id)).toMatchObject({ state: 'interrupted' })
    expect(next.get(b.id)).toMatchObject({ state: 'unknown' })
    expect(next.get(a.id)!.finishedAt).toBeTypeOf('number')
  })

  // CI 2026-10-18: 505 jobs, each written to the store several times, each write synced to disk:
  // half a second on CI's runners, past the 20 s every test is given on a busy machine (twice, in a
  // container and locally beside other suites). It checks what is kept, never how fast.
  it('prunes finished jobs after 7 days and beyond 500 rows, never running ones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { runner, target } = await setup()
    const m = manualKind()
    const old = runner.start(m.kind, target(), {})
    m.runs[0]!.resolve()
    await tick()
    const running = runner.start(m.kind, target(), {})
    vi.setSystemTime(Date.now() + KEEP_FINISHED_MS + 1)
    runner.prune()
    expect(runner.get(old.id)).toBeUndefined()
    expect(runner.get(running.id)?.state).toBe('running')
    for (let i = 0; i < MAX_ROWS + 5; i++) {
      runner.start(m.kind, target(), {})
      m.runs.at(-1)!.resolve()
      await tick()
    }
    runner.prune()
    expect(runner.list({ state: 'done' })).toHaveLength(MAX_ROWS)
  }, 120_000)

  it('writes nothing after close, so a job ending during shutdown leaves its row for recovery', async () => {
    const { runner, target, make } = await setup()
    const m = manualKind()
    const seen: string[] = []
    runner.onChange((j) => seen.push(j.state))
    const job = runner.start(m.kind, target(), {})
    runner.close()
    m.runs[0]!.ctx.setEstimate(5)
    m.runs[0]!.resolve()
    await tick()
    expect(seen).toEqual(['running'])
    expect(make().get(job.id)).toMatchObject({ state: 'running', estimate: null })
  })

  it('keeps going when a change listener throws', async () => {
    const { runner, target } = await setup()
    const m = manualKind()
    const seen: string[] = []
    runner.onChange(() => {
      throw new Error('listener bug')
    })
    runner.onChange((j) => seen.push(j.state))
    runner.start(m.kind, target(), {})
    m.runs[0]!.resolve()
    await tick()
    expect(seen).toEqual(['running', 'done'])
  })
})
