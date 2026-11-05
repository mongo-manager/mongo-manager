// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionSettings } from '@mongo-manager/shared'
import {
  ShellManager,
  type EvalPart,
  type ShellAuditRow,
  type ShellManagerDeps,
  type UpstreamPlan,
} from '../src/shell/manager'
import { ScramConversation, scramDerivations } from '../src/shell/proxy/scram'
import { MAX_MESSAGE_DEPTH } from '../src/shell/channel'
import { slow } from './support/slowness'

/**
 * Phase 3a-1 spec §4–§8: the ShellManager's session lifecycle, limits, cancel, restarts and audit,
 * driven by a fake worker so the behaviour is deterministic and fast. Spawn flags and the real
 * worker/proxy path are covered by shell-spawn and shell-proxy tests; a real end-to-end open+eval
 * lives in shell-manager-e2e below.
 */

/** A fake worker: an EventEmitter that records sends and lets the test drive its messages. */
class FakeWorker extends EventEmitter {
  sent: unknown[] = []
  killed = false
  pid = 1234
  stderr = new EventEmitter()
  send(msg: unknown): boolean {
    this.sent.push(msg)
    // Answer init with ready, like a real worker.
    if ((msg as { type?: string }).type === 'init')
      queueMicrotask(() => this.emit('message', { type: 'ready', prompt: 'rs0>' }))
    return true
  }
  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGKILL')
    return true
  }
}

const settings = (): ConnectionSettings =>
  ({
    scheme: 'mongodb',
    hosts: [{ host: '127.0.0.1', port: 1 }],
    auth: { mechanism: 'none' },
    tls: { enabled: false },
  }) as unknown as ConnectionSettings

const plan = (over: Partial<UpstreamPlan> = {}): UpstreamPlan => ({
  settings: settings(),
  readOnly: false,
  admin: true,
  allowHost: () => true,
  tls: null,
  ...over,
})

const workers: FakeWorker[] = []
let clock = 1000
const managers: ShellManager[] = []
const audits: ShellAuditRow[] = []

afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown()
  workers.length = 0
  audits.length = 0
  clock = 1000
  vi.useRealTimers()
})

function makeManager(over: Partial<ShellManagerDeps> = {}, planOver: Partial<UpstreamPlan> = {}) {
  const config = {
    shell: { maxPerUser: 3, maxTotal: 20, commandTimeoutMs: 60_000, idleMs: 0, lifetimeMs: 0 },
  }
  const mgr = new ShellManager({
    config,
    now: () => clock,
    log: { warn() {}, info() {}, error() {} },
    audit: (row) => audits.push(row),
    plan: () => plan(planOver),
    bundlePath: '/fake/worker.cjs',
    killGraceMs: 20,
    spawnFn: (() => {
      const w = new FakeWorker()
      workers.push(w)
      return w as never
    }) as never,
    // The fake worker is no process: nothing to measure from outside unless a test says so.
    rss: null,
    ...over,
  })
  managers.push(mgr)
  return mgr
}

const collect = () => {
  const parts: EvalPart[] = []
  return { parts, sink: (p: EvalPart) => parts.push(p) }
}
const last = () => workers.at(-1)!

/** The same manager, its plan failing: an open refused before it starts. */
function makeManagerLike(mgr: ShellManager) {
  const deps = (mgr as unknown as { deps: ShellManagerDeps }).deps
  const failing = new ShellManager({
    ...deps,
    plan: () => {
      throw new Error('no plan')
    },
  })
  // It shares the sessions: an open it refuses must leave them all.
  ;(failing as unknown as { sessions: unknown }).sessions = (mgr as unknown as { sessions: unknown }).sessions
  return failing
}

describe('ShellManager sessions and limits (phase 3a-1 §4)', () => {
  it('opens a session and returns the prompt', async () => {
    const mgr = makeManager()
    const { sessionId, prompt } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    expect(prompt).toBe('rs0>')
    expect(sessionId).toBeTruthy()
    // The init message carries no credential: only host, no user/password/tls.
    const init = last().sent.find((m) => (m as { type?: string }).type === 'init') as { uri: string }
    expect(init.uri).not.toMatch(/:[^/@]*@/)
    expect(init.uri).toContain('appName=mm-shell')
    expect(audits.some((a) => a.action === 'shell.open')).toBe(true)
  })

  // Security review 2026-10-13 (low): shell rows had no user name or address, unlike every other
  // row of the audit log. A page taking the session back gives its own address from then on.
  it('records who used the shell, and from where', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open(
      { owner: 'u1', admin: true, readOnly: false, username: 'ada', ip: '10.0.0.1' },
      'c1',
      'shop',
    )
    const { sink } = collect()
    mgr.attach('u1', sessionId, sink, { username: 'ada', ip: '10.0.0.2' })
    await mgr.evaluate('u1', sessionId, 1, '1+1', sink)
    last().emit('message', { type: 'done', id: 1, prompt: '>' })
    await mgr.close('u1', sessionId, 'closed')
    const who = (action: string) => {
      const row = audits.find((a) => a.action === action)!
      return [row.username, row.ip]
    }
    expect(who('shell.open')).toEqual(['ada', '10.0.0.1'])
    expect(who('shell.eval')).toEqual(['ada', '10.0.0.2'])
    expect(who('shell.close')).toEqual(['ada', '10.0.0.2'])
  })

  it('refuses more than maxPerUser and maxTotal', async () => {
    const mgr = makeManager()
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await expect(
      mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop'),
    ).rejects.toMatchObject({ code: 'TOO_MANY' })

    const mgr2 = makeManager({
      config: {
        shell: {
          maxPerUser: 10,
          maxTotal: 1,
          commandTimeoutMs: 60_000,
          idleMs: 0,
          lifetimeMs: 0,
        },
      },
    } as never)
    await mgr2.open({ owner: 'bob', admin: true, readOnly: false }, 'c1', 'shop')
    await expect(
      mgr2.open({ owner: 'cara', admin: true, readOnly: false }, 'c1', 'shop'),
    ).rejects.toMatchObject({ code: 'TOO_MANY' })
  })

  it('refuses a second command while one runs, and a too-long command', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'sleep(1000)', sink) // no done emitted → still running
    await expect(mgr.evaluate('ada', sessionId, 2, '1+1', sink)).rejects.toMatchObject({ code: 'BUSY' })
    await expect(mgr.evaluate('ada', sessionId, 3, 'x'.repeat(300 * 1024), sink)).rejects.toMatchObject({
      code: 'BUSY',
    })
  })

  it('rate-limits bursts of commands', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    // Each eval completes immediately (the fake answers done), so the rate window is what bites.
    last().on('message', () => {})
    for (let i = 0; i < 20; i++) {
      const { sink } = collect()
      await mgr.evaluate('ada', sessionId, i + 1, '1+1', sink)
      last().emit('message', { type: 'done', id: i + 1, prompt: '>' })
    }
    const { sink } = collect()
    await expect(mgr.evaluate('ada', sessionId, 99, '1+1', sink)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    })
  })

  it('caps command output', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'x', sink)
    // Many chunks under the 1 MiB IPC cap that cumulatively pass the 5 MiB output cap.
    for (let i = 0; i < 12; i++)
      last().emit('message', { type: 'print', id: 1, text: 'y'.repeat(512 * 1024) })
    expect(parts.some((p) => p.type === 'print' && p.text?.includes('output truncated'))).toBe(true)
  })

  // Review 2026-10-12 (I5): the cap ended the command while the worker still ran it; the next one was
  // refused by the busy worker, and the old run's next message reset it ("variables were lost").
  it('drops the output past the cap until the command ends, never ending it early', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'x', sink)
    for (let i = 0; i < 12; i++)
      worker.emit('message', { type: 'print', id: 1, text: 'y'.repeat(512 * 1024) })
    worker.emit('message', { type: 'result', id: 1, resultType: null, value: 'late' })
    expect(parts.filter((p) => p.text?.includes('output truncated'))).toHaveLength(1)
    expect(parts.some((p) => p.type === 'done' || p.type === 'reset' || p.value === 'late')).toBe(false)
    await expect(mgr.evaluate('ada', sessionId, 2, '1+1', sink)).rejects.toMatchObject({ code: 'BUSY' })
    worker.emit('message', { type: 'done', id: 1, prompt: 'shop>' })
    expect(parts.at(-1)).toMatchObject({ type: 'done', id: 1 })
    expect(last()).toBe(worker)
    await mgr.evaluate('ada', sessionId, 2, '1+1', sink)
  })

  // Security audit 2026-10-16 (minor): a result too large to send is not sent; the worker says the
  // output was cut, and the page is told once, without a reset.
  it('says the output was cut when the worker held back a result, and goes on', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, "'x'.repeat(1e8)", sink)
    worker.emit('message', { type: 'truncated', id: 1 })
    worker.emit('message', { type: 'truncated', id: 1 })
    worker.emit('message', { type: 'print', id: 1, text: 'late' })
    worker.emit('message', { type: 'done', id: 1, prompt: 'shop>' })
    expect(parts.filter((p) => p.text?.includes('output truncated'))).toHaveLength(1)
    expect(parts.some((p) => p.type === 'reset' || p.text === 'late')).toBe(false)
    expect(parts.at(-1)).toMatchObject({ type: 'done', id: 1 })
    expect(last()).toBe(worker)
  })

  // Security audit 2026-10-16 (minor): the channel refuses an oversize or unparsable message before
  // parsing it, and the worker is reset as for any other IPC violation.
  it('resets the worker when its channel reports a violation', async () => {
    const mgr = makeManager()
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    worker.emit('violation')
    await vi.waitFor(() =>
      expect(audits.some((a) => a.action === 'shell.reset' && a.details.reason === 'ipc')).toBe(true),
    )
    expect(worker.killed).toBe(true)
  })

  it('passes on the piece a result is of, and the pieces an error left unrun', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'use shop\na()\nb()', sink)
    last().emit('message', { type: 'result', id: 1, resultType: null, value: 'x', command: 'use shop' })
    last().emit('message', {
      type: 'error',
      id: 1,
      code: 'EVAL_ERROR',
      message: 'a is not defined',
      skipped: 1,
    })
    expect(parts[0]).toMatchObject({ type: 'result', command: 'use shop' })
    expect(parts[1]).toMatchObject({ type: 'error', message: 'a is not defined', skipped: 1 })
    // A plain error carries no code: the page shows the shell's words.
    expect(parts[1]).not.toHaveProperty('code')
  })

  // Second review 2026-10-12 (minor 15, 16): a stop was audited as an error, in English only; the
  // audit kept 2048 characters of a long script without saying how long it was.
  it('passes on the codes the page words itself, audits a stop as cancelled, and says how long the code was', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { parts, sink } = collect()
    const code = `sleep(9)\n${'x\n'.repeat(3000)}`
    await mgr.evaluate('ada', sessionId, 1, code, sink)
    last().emit('message', { type: 'error', id: 1, code: 'STOPPED', message: 'Stopped.', skipped: 3000 })
    last().emit('message', { type: 'done', id: 1, prompt: '>' })
    expect(parts[0]).toMatchObject({ type: 'error', code: 'STOPPED', skipped: 3000 })
    const row = audits.find((a) => a.action === 'shell.eval')!
    expect(row.details).toMatchObject({ outcome: 'cancelled', codeBytes: Buffer.byteLength(code) })
  })
})

describe('ShellManager cancel, timeout and restarts (phase 3a-1 §4)', () => {
  it('resets the worker on a command timeout and the session survives', async () => {
    const mgr = makeManager({
      config: {
        shell: { maxPerUser: 3, maxTotal: 20, commandTimeoutMs: 40, idleMs: 0, lifetimeMs: 0 },
      },
    } as never)
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const first = last()
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'while(true){}', sink) // no done → timeout → cancel → reset
    await vi.waitFor(() => expect(parts.some((p) => p.type === 'reset')).toBe(true), { timeout: 2000 })
    expect(first.killed).toBe(true)
    expect(audits.some((a) => a.action === 'shell.reset' && a.details.reason === 'timeout')).toBe(true)
    // A new worker was spawned; the session still answers.
    expect(workers.length).toBe(2)
    const { parts: p2, sink: s2 } = collect()
    await mgr.evaluate('ada', sessionId, 2, '1+1', s2)
    last().emit('message', { type: 'result', id: 2, resultType: null, value: 2 })
    last().emit('message', { type: 'done', id: 2, prompt: '>' })
    expect(p2.some((p) => p.type === 'result')).toBe(true)
  })

  it('resets when RSS exceeds the cap', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    void sessionId
    last().emit('message', { type: 'pong', rss: 500 * 1024 * 1024, heapUsed: 1 })
    await vi.waitFor(() =>
      expect(audits.some((a) => a.action === 'shell.reset' && a.details.reason === 'memory')).toBe(true),
    )
  })

  it(
    'polls the worker RSS while a command runs, so an off-heap balloon is caught (review I2)',
    async () => {
      const mgr = makeManager()
      const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
      const worker = last()
      const { sink } = collect()
      await mgr.evaluate('ada', sessionId, 1, 'big()', sink)
      // While the command runs the manager pings the worker for its RSS (nothing sent it before).
      await vi.waitFor(
        () => expect(worker.sent.some((m) => (m as { type?: string }).type === 'ping')).toBe(true),
        {
          timeout: 3000,
        },
      )
      // A ballooned RSS reported in the pong resets the session.
      worker.emit('message', { type: 'pong', rss: 500 * 1024 * 1024, heapUsed: 1 })
      await vi.waitFor(() =>
        expect(audits.some((a) => a.action === 'shell.reset' && a.details.reason === 'memory')).toBe(true),
      )
      // The poll stops once the command ends: no further pings pile up after the reset.
      const afterReset = worker.sent.filter((m) => (m as { type?: string }).type === 'ping').length
      await new Promise((r) => setTimeout(r, 100))
      expect(worker.sent.filter((m) => (m as { type?: string }).type === 'ping').length).toBe(afterReset)
    },
    slow(8000),
  )

  it('kills the worker and audits a reset on an IPC violation (unknown message)', async () => {
    const mgr = makeManager()
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    worker.emit('message', { type: 'nonsense' })
    await vi.waitFor(() =>
      expect(audits.some((a) => a.action === 'shell.reset' && a.details.reason === 'ipc')).toBe(true),
    )
    expect(worker.killed).toBe(true)
  })

  it('closes the session after too many restarts in a minute', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    // Spec §4: three restarts within the window close the session (review M6 — the third, not a fourth).
    for (let i = 0; i < 3; i++) {
      last().emit('message', { type: 'nonsense' })
      await new Promise((r) => setTimeout(r, 60))
    }
    await vi.waitFor(() =>
      expect(audits.some((a) => a.action === 'shell.close' && a.details.reason === 'crash')).toBe(true),
    )
    const { sink } = collect()
    await expect(mgr.evaluate('ada', sessionId, 1, '1+1', sink)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

/**
 * Security audit 2026-10-16 (Important 2): memory was checked only on the worker's answers to pings
 * sent while a command ran — a worker busy in synchronous code never answers, ArrayBuffers are not
 * in the V8 heap cap, and a loop left running after a command was never looked at.
 */
describe('ShellManager watches the worker for its whole life (security audit 2026-10-16, I2)', () => {
  const MiB = 1024 * 1024
  const isPing = (m: unknown) => (m as { type?: string }).type === 'ping'
  const reader = (bytes: number | null) => {
    const calls: number[] = []
    return {
      calls,
      source: { read: async (pid: number) => (calls.push(pid), bytes), busyMs: 10, idleMs: 40 },
    }
  }
  const resetFor = (reason: string) =>
    audits.some((a) => a.action === 'shell.reset' && a.details.reason === reason)

  it('pings the worker while no command runs, not only during one', async () => {
    const mgr = makeManager({ pingMs: 20 } as never)
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    const answer = setInterval(() => worker.emit('message', { type: 'pong', rss: 1, heapUsed: 1 }), 5)
    try {
      await vi.waitFor(() => expect(worker.sent.filter(isPing).length).toBeGreaterThanOrEqual(2), {
        timeout: 2000,
      })
    } finally {
      clearInterval(answer)
    }
  })

  // Review 2026-10-16 (minor): pings piled up in a busy worker's pipe, to be answered all at once.
  it('sends no new ping while one is unanswered', async () => {
    const mgr = makeManager({ pingMs: 20 } as never)
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    await new Promise((r) => setTimeout(r, 300))
    expect(worker.sent.filter(isPing)).toHaveLength(1)
    worker.emit('message', { type: 'pong', rss: 1, heapUsed: 1 })
    await vi.waitFor(() => expect(worker.sent.filter(isPing)).toHaveLength(2), { timeout: 2000 })
  })

  it('measures a worker that does not answer from outside, and resets it past the cap', async () => {
    const { source, calls } = reader(500 * MiB)
    const mgr = makeManager({ pingMs: 20, rss: source } as never)
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    const { parts, sink } = collect()
    // A synchronous loop filling ArrayBuffers: the worker answers nothing.
    await mgr.evaluate('ada', sessionId, 1, 'fill()', sink)
    await vi.waitFor(() => expect(resetFor('memory')).toBe(true), { timeout: 3000 })
    expect(calls).toContain(worker.pid)
    expect(worker.killed).toBe(true)
    expect(parts.some((p) => p.type === 'reset')).toBe(true)
  })

  it('measures an idle worker now and then too: its own answers are not taken on trust', async () => {
    const { source } = reader(500 * MiB)
    const mgr = makeManager({ pingMs: 20, rss: source } as never)
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    // It answers every ping, claiming next to nothing.
    const answer = setInterval(() => worker.emit('message', { type: 'pong', rss: 1, heapUsed: 1 }), 5)
    try {
      await vi.waitFor(() => expect(resetFor('memory')).toBe(true), { timeout: 3000 })
    } finally {
      clearInterval(answer)
    }
  })

  it('leaves a worker under the cap alone', async () => {
    const { source, calls } = reader(100 * MiB)
    const mgr = makeManager({ pingMs: 20, rss: source } as never)
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'work()', sink)
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(3), { timeout: 3000 })
    expect(audits.some((a) => a.action === 'shell.reset')).toBe(false)
  })

  it('resets a worker that stops answering while no command runs (a loop left behind)', async () => {
    const mgr = makeManager({ pingMs: 20, hangMs: 1000 } as never)
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    await vi.waitFor(() => expect(worker.sent.some(isPing)).toBe(true), { timeout: 2000 })
    clock += 1500
    await vi.waitFor(() => expect(resetFor('hang')).toBe(true), { timeout: 2000 })
    expect(worker.killed).toBe(true)
  })

  it('never takes a running command, or the moment after it, for a hang', async () => {
    const mgr = makeManager({ pingMs: 20, hangMs: 1000 } as never)
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'while (Date.now() < t) {}', sink)
    await vi.waitFor(() => expect(worker.sent.some(isPing)).toBe(true), { timeout: 2000 })
    clock += 5000
    await new Promise((r) => setTimeout(r, 100))
    expect(resetFor('hang')).toBe(false)
    worker.emit('message', { type: 'done', id: 1, prompt: '>' })
    await new Promise((r) => setTimeout(r, 100))
    expect(resetFor('hang')).toBe(false)
    // Still no answer long after the command ended: now it is one.
    clock += 1500
    await vi.waitFor(() => expect(resetFor('hang')).toBe(true), { timeout: 2000 })
  })

  it('a worker that answers is no hang', async () => {
    const mgr = makeManager({ pingMs: 20, hangMs: 1000 } as never)
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    await vi.waitFor(() => expect(worker.sent.some(isPing)).toBe(true), { timeout: 2000 })
    worker.emit('message', { type: 'pong', rss: 1, heapUsed: 1 })
    clock += 900
    await new Promise((r) => setTimeout(r, 60))
    worker.emit('message', { type: 'pong', rss: 1, heapUsed: 1 })
    clock += 900
    await new Promise((r) => setTimeout(r, 60))
    expect(resetFor('hang')).toBe(false)
  })

  // Security audit 2026-10-16 (I3): a killed operation now ends the command with MongoDB's
  // "interrupted" error and no reset; the audit still says it was cancelled, or timed out.
  it('audits a command ended by Ctrl+C or its time limit as cancelled or timeout, not error', async () => {
    const mgr = makeManager({
      killGraceMs: 10_000,
      config: { shell: { maxPerUser: 3, maxTotal: 20, commandTimeoutMs: 40, idleMs: 0, lifetimeMs: 0 } },
    } as never)
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    const interrupted = {
      type: 'error',
      code: 'EVAL_ERROR',
      message: 'MongoServerError: operation was interrupted',
    }
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'db.big.find().toArray()', sink)
    mgr.cancel('ada', sessionId)
    worker.emit('message', { ...interrupted, id: 1 })
    worker.emit('message', { type: 'done', id: 1, prompt: '>' })
    clock += 2000
    // The kill Ctrl+C asked for ends first: no command is taken meanwhile.
    await new Promise((r) => setTimeout(r, 20))
    await mgr.evaluate('ada', sessionId, 2, 'db.big.find().toArray()', sink)
    await new Promise((r) => setTimeout(r, 100)) // past the 40 ms limit
    worker.emit('message', { ...interrupted, id: 2 })
    worker.emit('message', { type: 'done', id: 2, prompt: '>' })
    const outcomes = audits.filter((a) => a.action === 'shell.eval').map((a) => a.details.outcome)
    expect(outcomes).toEqual(['cancelled', 'timeout'])
    expect(audits.some((a) => a.action === 'shell.reset')).toBe(false)
  })

  // Security review 2026-10-16 (I-7): output while no command ran was dropped silently, so a worker
  // could stream it without end; it is a violation now.
  it('takes output while no command runs as a violation', async () => {
    for (const stray of [
      { type: 'print', id: 3, text: 'x' },
      { type: 'result', id: 3, resultType: null, value: 1 },
      { type: 'done', id: 3, prompt: '>' },
      { type: 'error', id: 0, code: 'EVAL_ERROR', message: 'x' },
      { type: 'truncated', id: 3 },
    ]) {
      audits.length = 0
      const mgr = makeManager()
      await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
      const worker = last()
      worker.emit('message', stray)
      await vi.waitFor(() => expect(resetFor('ipc')).toBe(true))
      expect(worker.killed, stray.type).toBe(true)
    }
  })

  it('ignores what a worker already replaced still sends, never resetting its successor', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const first = last()
    first.emit('message', { type: 'nonsense' })
    await vi.waitFor(() => expect(workers.length).toBe(2))
    audits.length = 0
    first.emit('message', { type: 'print', id: 9, text: 'late' })
    first.emit('violation')
    await new Promise((r) => setTimeout(r, 50))
    expect(resetFor('ipc')).toBe(false)
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, '1', sink)
  })

  // Security review 2026-10-16 (I-6): a value too deep to measure was counted as 0 bytes and passed on.
  it('takes a message too deep to measure as a violation, and never throws', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'x', sink)
    let deep: unknown = 1
    for (let i = 0; i < 300_000; i++) deep = [deep]
    expect(() =>
      worker.emit('message', { type: 'result', id: 1, resultType: null, value: deep }),
    ).not.toThrow()
    await vi.waitFor(() => expect(resetFor('ipc')).toBe(true))
    expect(parts.some((p) => p.type === 'result')).toBe(false)
  })

  // CI, Node 26: JSON.stringify there writes a value of any depth, so "too deep to write" no longer
  // held anything back. The depth the channel takes is the measure, whatever the runtime can write:
  // this value is a little deeper than that, which every Node writes.
  it('takes a message deeper than the channel takes as a violation, though it can be written', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'x', sink)
    let deep: unknown = 1
    for (let i = 0; i < MAX_MESSAGE_DEPTH + 10; i++) deep = [deep]
    worker.emit('message', { type: 'result', id: 1, resultType: null, value: deep })
    await vi.waitFor(() => expect(resetFor('ipc')).toBe(true))
    expect(parts.some((p) => p.type === 'result')).toBe(false)
  })

  /** The session's proxy, its kill replaced by a spy that resolves when told. */
  function spyKill(mgr: ShellManager, sessionId: string) {
    const proxy = (
      mgr as unknown as { sessions: Map<string, { proxy: Record<string, unknown> }> }
    ).sessions.get(sessionId)!.proxy
    let finish: (n: number) => void = () => undefined
    let flight: Promise<number> | null = null
    const kill = vi.fn(() => {
      flight ??= new Promise<number>((r) => {
        finish = r
        setTimeout(() => r(0), 500)
      }).finally(() => (flight = null))
      return flight
    })
    proxy.killOps = kill
    Object.defineProperty(proxy, 'killing', { get: () => flight !== null, configurable: true })
    let busy = false
    proxy.busy = () => busy
    proxy.endCommand = () => busy
    return { kill, finish: (n = 0) => finish(n), setBusy: (b: boolean) => (busy = b) }
  }

  // Security review 2026-10-16 (I-4): each Ctrl+C opened a connection with a full SCRAM exchange.
  it('runs one kill for a burst of Ctrl+C, and one restart at most', async () => {
    const mgr = makeManager({ killGraceMs: 50 } as never)
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { kill } = spyKill(mgr, sessionId)
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'sleep()', sink)
    for (let i = 0; i < 50; i++) mgr.cancel('ada', sessionId)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(last().sent.filter((m) => (m as { type?: string }).type === 'cancel')).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 200))
    expect(audits.filter((a) => a.action === 'shell.reset')).toHaveLength(1)
  })

  // Security review 2026-10-16 (I-3): Ctrl+C with nothing running did nothing, while code a command
  // left running could still hold an operation open.
  it('kills on Ctrl+C with no command running too, at most once a second', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { kill, finish } = spyKill(mgr, sessionId)
    mgr.cancel('ada', sessionId)
    finish()
    await new Promise((r) => setTimeout(r, 10))
    mgr.cancel('ada', sessionId)
    expect(kill).toHaveBeenCalledTimes(1)
    clock += 1500
    mgr.cancel('ada', sessionId)
    expect(kill).toHaveBeenCalledTimes(2)
    // Nothing to stop in the worker: it is never reset for it.
    await new Promise((r) => setTimeout(r, 50))
    expect(audits.some((a) => a.action === 'shell.reset')).toBe(false)
  })

  // Review 2026-10-16 (minor): a kill under way could hit the next command's operations.
  it('takes no command while the last one’s operations are being killed', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { finish } = spyKill(mgr, sessionId)
    mgr.cancel('ada', sessionId)
    const { sink } = collect()
    await expect(mgr.evaluate('ada', sessionId, 1, '1', sink)).rejects.toMatchObject({ code: 'BUSY' })
    finish()
    await new Promise((r) => setTimeout(r, 10))
    await mgr.evaluate('ada', sessionId, 1, '1', sink)
  })

  it('kills what a command left waiting on the server when it ends', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { kill, setBusy } = spyKill(mgr, sessionId)
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'a()', sink)
    last().emit('message', { type: 'done', id: 1, prompt: '>' })
    expect(kill).not.toHaveBeenCalled()
    await mgr.evaluate('ada', sessionId, 2, 'void db.c.aggregate(heavy).toArray(); 1', sink)
    setBusy(true)
    last().emit('message', { type: 'done', id: 2, prompt: '>' })
    expect(kill).toHaveBeenCalledTimes(1)
  })

  // Security review 2026-10-16 (I-3): what code left running tries is audited.
  it('audits the commands refused while no command ran, with the next command and at close', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const onCommand = (name: string, refused: boolean) =>
      (mgr as unknown as { onCommand(id: string, n: string, r: boolean): void }).onCommand(
        sessionId,
        name,
        refused,
      )
    onCommand('aggregate', true)
    onCommand('aggregate', true)
    onCommand('find', true)
    onCommand('hello', false)
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, '1', sink)
    last().emit('message', { type: 'done', id: 1, prompt: '>' })
    const row = audits.find((a) => a.action === 'shell.eval')!
    expect(row.details.refusedWhileIdle).toEqual({ aggregate: 2, find: 1 })
    onCommand('find', true)
    await mgr.close('ada', sessionId, 'closed')
    expect(audits.find((a) => a.action === 'shell.close')!.details.refusedWhileIdle).toEqual({ find: 1 })
  })

  // Second review 2026-10-16 (minor): salted passwords outlived a connection changed or deleted.
  it('forgets a connection’s salted passwords when its shells are closed for it', async () => {
    const before = scramDerivations()
    const derive = async () => {
      const c = new ScramConversation('SCRAM-SHA-256', 'u', 'pw', Buffer.from('n'.repeat(24)), 'c-forget')
      c.start()
      await c.clientFinal(
        Buffer.from(`r=${Buffer.from('n'.repeat(24)).toString('base64')}x,s=Zm9yZ2V0,i=4096`),
      )
    }
    await derive()
    await derive()
    expect(scramDerivations() - before).toBe(1)
    const mgr = makeManager()
    await mgr.closeFor({ connectionId: 'c-forget' }, 'access')
    await derive()
    expect(scramDerivations() - before).toBe(2)
  })

  it('refuses a command while the worker starts again after a reset, rather than losing it', async () => {
    let started = 0
    const mgr = makeManager({
      spawnFn: (() => {
        const w = new FakeWorker()
        // The second worker is still starting: it never says it is ready.
        if (started++ > 0) w.send = (m: unknown) => (w.sent.push(m), true)
        workers.push(w)
        return w
      }) as never,
    })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    last().emit('message', { type: 'nonsense' })
    await vi.waitFor(() => expect(workers.length).toBe(2))
    const { sink } = collect()
    await expect(mgr.evaluate('ada', sessionId, 1, '1', sink)).rejects.toMatchObject({ code: 'BUSY' })
    expect(last().sent.some((m) => (m as { type?: string }).type === 'eval')).toBe(false)
  })

  it('takes its memory cap, output cap and command rate from the configuration (spec §4)', async () => {
    const mgr = makeManager({
      config: {
        shell: {
          maxPerUser: 3,
          maxTotal: 20,
          commandTimeoutMs: 60_000,
          idleMs: 0,
          lifetimeMs: 0,
          rssMb: 128,
          outputMb: 1,
          commandsPerSecond: 2,
        },
      },
    } as never)
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    const init = worker.sent.find((m) => (m as { type?: string }).type === 'init') as {
      outputCapBytes?: number
    }
    expect(init.outputCapBytes).toBe(1 * MiB)
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'x', sink)
    worker.emit('message', { type: 'print', id: 1, text: 'y'.repeat(700 * 1024) })
    worker.emit('message', { type: 'print', id: 1, text: 'y'.repeat(700 * 1024) })
    expect(parts.some((p) => p.text?.includes('output truncated'))).toBe(true)
    worker.emit('message', { type: 'done', id: 1, prompt: '>' })
    await mgr.evaluate('ada', sessionId, 2, 'x', sink)
    worker.emit('message', { type: 'done', id: 2, prompt: '>' })
    await expect(mgr.evaluate('ada', sessionId, 3, 'x', sink)).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    worker.emit('message', { type: 'pong', rss: 200 * MiB, heapUsed: 1 })
    await vi.waitFor(() => expect(resetFor('memory')).toBe(true))
  })
})

describe('ShellManager close and access (phase 3a-1 §6)', () => {
  it('closeFor closes sessions of a connection or user', async () => {
    const mgr = makeManager()
    const a = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const b = await mgr.open({ owner: 'bob', admin: true, readOnly: false }, 'c2', 'shop')
    await mgr.closeFor({ connectionId: 'c1' }, 'access')
    expect(mgr.count()).toBe(1)
    await mgr.closeFor({ userId: 'bob' }, 'access')
    expect(mgr.count()).toBe(0)
    void a
    void b
  })

  it('only the owner can act on a session', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { sink } = collect()
    await expect(mgr.evaluate('mallory', sessionId, 1, '1+1', sink)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('shutdown kills every worker', async () => {
    const mgr = makeManager()
    await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await mgr.open({ owner: 'bob', admin: true, readOnly: false }, 'c2', 'shop')
    const spawned = [...workers]
    await mgr.shutdown()
    expect(spawned.every((w) => w.killed)).toBe(true)
    expect(mgr.count()).toBe(0)
  })
})

describe('ShellManager audit and history (phase 3a-1 §8)', () => {
  it('audits shell.eval with masked code, outcome and a command summary', async () => {
    const recorded: Array<{ owner: string | null; code: string }> = []
    const mgr = makeManager({
      mask: (c) => c.replace(/secret\w+/, '***'),
      record: (owner, _c, code) => recorded.push({ owner, code }),
    })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, "db.auth('u','secret123')", sink)
    // The proxy reports the commands it saw for this eval, then the worker finishes.
    ;(mgr as unknown as { onCommand(id: string, name: string, refused: boolean): void }).onCommand(
      sessionId,
      'insert',
      false,
    )
    last().emit('message', { type: 'result', id: 1, resultType: null, value: 1 })
    last().emit('message', { type: 'done', id: 1, prompt: '>' })
    const evalRow = audits.find((a) => a.action === 'shell.eval')
    expect(evalRow).toBeTruthy()
    expect(evalRow!.details.outcome).toBe('ok')
    expect(evalRow!.details.commands).toEqual({ insert: 1 })
    expect(String(evalRow!.details.code)).not.toContain('secret123')
    // The command was offered to history.
    expect(recorded).toEqual([{ owner: 'ada', code: "db.auth('u','secret123')" }])
  })

  // User report 2026-10-12: "Shell ekranını yeniliyorum hiç bir Shell açık değil iken 'You have too
  // many shells open' hatası veriyor". A reloaded page left its sessions waiting for a reattach.
  it('makes room at the limit by closing the caller’s own sessions no page holds, oldest first', async () => {
    const mgr = makeManager({ reconnectGraceMs: 60_000 })
    const ada = { owner: 'ada', admin: true, readOnly: false }
    // Opened in this order, used last in the other: the least recently used makes room first.
    clock = 3000
    const second = await mgr.open(ada, 'c1', 'shop')
    clock = 1000
    const first = await mgr.open(ada, 'c1', 'shop')
    clock = 4000
    const third = await mgr.open(ada, 'c1', 'shop')
    const ended: Array<[string, string]> = []
    mgr.onEnded((id, reason) => ended.push([id, reason]))
    // Every one held by a page: still refused.
    await expect(mgr.open(ada, 'c1', 'shop')).rejects.toMatchObject({ code: 'TOO_MANY' })
    // Two let go by a reloaded page: the older one makes room, the newer waits for its page.
    mgr.detach(second.sessionId)
    mgr.detach(first.sessionId)
    const fourth = await mgr.open(ada, 'c1', 'shop')
    expect(ended).toEqual([[first.sessionId, 'evicted']])
    expect(mgr.count()).toBe(3)
    // A session reattached is held again: never closed to make room.
    mgr.attach('ada', second.sessionId)
    await expect(mgr.open(ada, 'c1', 'shop')).rejects.toMatchObject({ code: 'TOO_MANY' })
    expect(
      [third.sessionId, fourth.sessionId, second.sessionId].every((id) => mgr.sessionInfo('ada', id)),
    ).toBe(true)
  })

  // Review 2026-10-12 (I4): a page reloaded during a long write left its session unheld; it was
  // closed to make room in the middle of its command. An open that then failed closed one for nothing.
  it('never makes room with a session whose command runs, nor for an open that fails, and says why', async () => {
    const mgr = makeManager({ reconnectGraceMs: 60_000 })
    const ada = { owner: 'ada', admin: true, readOnly: false }
    const busy = await mgr.open(ada, 'c1', 'shop')
    const idle = await mgr.open(ada, 'c1', 'shop')
    await mgr.open(ada, 'c1', 'shop')
    await mgr.evaluate('ada', busy.sessionId, 1, 'sleep(60000)', collect().sink)
    mgr.detach(busy.sessionId)
    mgr.detach(idle.sessionId)
    const ended: Array<[string, string]> = []
    mgr.onEnded((id, reason) => ended.push([id, reason]))
    // An open refused before it starts (its plan fails): nothing is closed for it.
    const failing = makeManagerLike(mgr)
    await expect(failing.open(ada, 'c1', 'shop')).rejects.toThrow('no plan')
    expect(ended).toEqual([])
    await mgr.open(ada, 'c1', 'shop')
    expect(ended).toEqual([[idle.sessionId, 'evicted']])
    expect(
      audits.some(
        (a) => a.action === 'shell.close' && (a.details as { reason?: string }).reason === 'evicted',
      ),
    ).toBe(true)
    // The running one is never taken: at the limit again, refused.
    await expect(mgr.open(ada, 'c1', 'shop')).rejects.toMatchObject({ code: 'TOO_MANY' })
    expect(mgr.sessionInfo('ada', busy.sessionId)).toBeTruthy()
  })

  // Review 2026-10-12 (I6): opens at once all passed the limit before any was counted.
  it('holds to the limits with opens made at once', async () => {
    const mgr = makeManager()
    const ada = { owner: 'ada', admin: true, readOnly: false }
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => mgr.open(ada, 'c1', 'shop')))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
    expect(
      results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code),
    ).toEqual(['TOO_MANY', 'TOO_MANY', 'TOO_MANY'])
    expect(mgr.count()).toBe(3)
    expect(workers).toHaveLength(3)
  })

  it('never closes another user’s sessions to make room', async () => {
    const mgr = makeManager({
      reconnectGraceMs: 60_000,
      config: {
        shell: {
          maxPerUser: 10,
          maxTotal: 1,
          commandTimeoutMs: 60_000,
          idleMs: 0,
          lifetimeMs: 0,
        },
      },
    } as never)
    const bob = await mgr.open({ owner: 'bob', admin: true, readOnly: false }, 'c1', 'shop')
    mgr.detach(bob.sessionId)
    await expect(
      mgr.open({ owner: 'cara', admin: true, readOnly: false }, 'c1', 'shop'),
    ).rejects.toMatchObject({
      code: 'TOO_MANY',
    })
    expect(mgr.sessionInfo('bob', bob.sessionId)).toBeTruthy()
  })

  it('detaches with a reconnect grace and closes if no one reattaches', async () => {
    const mgr = makeManager({ reconnectGraceMs: 30 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    mgr.detach(sessionId)
    expect(mgr.count()).toBe(1)
    await vi.waitFor(() => expect(mgr.count()).toBe(0), { timeout: 1000 })
  })

  it('a reattach returns the live prompt, not a placeholder (review M5)', async () => {
    const mgr = makeManager({ reconnectGraceMs: 500 })
    const { sessionId, prompt } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    expect(prompt).toBe('rs0>')
    // The worker reports a new prompt after a command (e.g. after `use other`).
    const { sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'use other', sink)
    last().emit('message', { type: 'done', id: 1, prompt: 'rs0 [primary] other>' })
    mgr.detach(sessionId)
    expect(mgr.attach('ada', sessionId).prompt).toBe('rs0 [primary] other>')
  })

  // The shell's redesign review (2026-10-11, I2): a session the server ends by itself (idle, its
  // lifetime, a crash) is said to whoever listens, so its page stops saying "Connected".
  it('tells its listeners when a session ends, and why', async () => {
    const mgr = makeManager()
    const ended: Array<[string, string]> = []
    const stop = mgr.onEnded((id, reason) => ended.push([id, reason]))
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await mgr.close('ada', sessionId, 'idle')
    expect(ended).toEqual([[sessionId, 'idle']])
    stop()
    const other = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await mgr.close('ada', other.sessionId, 'lifetime')
    expect(ended).toHaveLength(1)
  })

  // User report 2026-10-12 ("Uzun zaman kullanılmayan Shell neden kapanıyor"): a shell a page holds
  // stays open however long it is not used, as Compass's does; only one no page holds goes (after the
  // reconnect grace). An idle or lifetime limit applies only when the operator sets one.
  it('keeps a shell its page holds open however long it is unused, unless a limit is set', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const limits = (idleMs: number, lifetimeMs: number) =>
      ({
        config: { shell: { maxPerUser: 3, maxTotal: 20, commandTimeoutMs: 60_000, idleMs, lifetimeMs } },
      }) as never
    const ends = (mgr: ShellManager) => {
      const reasons: string[] = []
      mgr.onEnded((_id, reason) => reasons.push(reason))
      return reasons
    }
    const ada = { owner: 'ada', admin: true, readOnly: false }
    const quiet = makeManager(limits(0, 0))
    const quietEnds = ends(quiet)
    const kept = await quiet.open(ada, 'c1', 'shop')
    const idleOnly = makeManager(limits(60_000, 0))
    const idleEnds = ends(idleOnly)
    await idleOnly.open(ada, 'c1', 'shop')
    const lifetimeOnly = makeManager(limits(0, 120_000))
    const lifetimeEnds = ends(lifetimeOnly)
    const used = await lifetimeOnly.open(ada, 'c1', 'shop')
    // Used now and then, so only its lifetime ends it.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(20_000)
      lifetimeOnly.attach('ada', used.sessionId)
    }
    expect(lifetimeEnds).toEqual([])
    await vi.advanceTimersByTimeAsync(45_000)
    expect(idleEnds).toEqual(['idle'])
    expect(lifetimeEnds).toEqual(['lifetime'])
    // Two days on, the shell no limit bounds is still open and answers.
    await vi.advanceTimersByTimeAsync(2 * 86_400_000)
    expect(quietEnds).toEqual([])
    expect(quiet.attach('ada', kept.sessionId).prompt).toBe('rs0>')
  })

  it('still closes a shell no page holds after the reconnect grace, with no limits set', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const mgr = makeManager({ reconnectGraceMs: 120_000 })
    const reasons: string[] = []
    mgr.onEnded((_id, reason) => reasons.push(reason))
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    mgr.detach(sessionId)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(reasons).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(reasons).toEqual(['closed'])
  })

  // Review I4: a command running when the socket dropped finishes on the socket that came back.
  it('a reattach takes over a running command’s output, and says it runs', async () => {
    const mgr = makeManager({ reconnectGraceMs: 500 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const before = collect()
    await mgr.evaluate('ada', sessionId, 1, 'sleep(100)', before.sink)
    mgr.detach(sessionId)
    const after = collect()
    expect(mgr.attach('ada', sessionId, after.sink).running).toBe(true)
    last().emit('message', { type: 'done', id: 1, prompt: 'rs0>' })
    expect(after.parts).toEqual([{ type: 'done', id: 1, prompt: 'rs0>' }])
    expect(before.parts).toEqual([])
    expect(mgr.attach('ada', sessionId).running).toBe(false)
  })

  it('passes on the current database with done and with a reattach (final review M6)', async () => {
    const mgr = makeManager({ reconnectGraceMs: 500 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    expect(mgr.attach('ada', sessionId).db).toBe('shop')
    const { sink, parts } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'use other', sink)
    last().emit('message', { type: 'done', id: 1, prompt: 'other>', db: 'other' })
    expect(parts.at(-1)).toMatchObject({ type: 'done', id: 1, db: 'other' })
    mgr.detach(sessionId)
    expect(mgr.attach('ada', sessionId).db).toBe('other')
  })

  it('a reattach within the grace keeps the session', async () => {
    const mgr = makeManager({ reconnectGraceMs: 500 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    mgr.detach(sessionId)
    mgr.attach('ada', sessionId)
    await new Promise((r) => setTimeout(r, 80))
    expect(mgr.count()).toBe(1)
  })
})

describe('ShellManager completion (phase 3a-2 §3.2)', () => {
  const sentCompletes = (w: FakeWorker) =>
    w.sent.filter((m) => (m as { type?: string }).type === 'complete') as Array<{ id: number; code: string }>

  it('asks the worker and resolves with its items', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const pending = mgr.complete('ada', sessionId, 7, 'db.or')
    expect(sentCompletes(last())).toEqual([{ type: 'complete', id: 7, code: 'db.or' }])
    last().emit('message', { type: 'completions', id: 7, items: ['db.orders'] })
    await expect(pending).resolves.toEqual(['db.orders'])
  })

  it('answers nothing while a command runs, sends nothing, and the command still finishes (review focus 1)', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 1, 'sleep(500)', sink)
    await expect(mgr.complete('ada', sessionId, 2, 'db.')).resolves.toEqual([])
    expect(sentCompletes(last())).toEqual([])
    last().emit('message', { type: 'done', id: 1, prompt: '>' })
    expect(parts.some((p) => p.type === 'done')).toBe(true)
  })

  it('answers nothing while the worker restarts (not ready)', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    last().emit('message', { type: 'nonsense' }) // IPC violation → reset → a new worker, not yet ready
    await expect(mgr.complete('ada', sessionId, 3, 'db.')).resolves.toEqual([])
    expect(sentCompletes(last())).toEqual([])
  })

  it('gives up after the timeout and ignores a late reply without resetting', async () => {
    const mgr = makeManager({ completeTimeoutMs: 30 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    await expect(mgr.complete('ada', sessionId, 4, 'db.')).resolves.toEqual([])
    worker.emit('message', { type: 'completions', id: 4, items: ['db.late'] })
    await new Promise((r) => setTimeout(r, 20))
    expect(audits.some((a) => a.action === 'shell.reset')).toBe(false)
    expect(worker.killed).toBe(false)
  })

  it('answers at most 10 requests a second', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    for (let i = 1; i <= 11; i++) {
      const pending = mgr.complete('ada', sessionId, i, 'db.')
      // The worker answers each one, so only the rate limit can refuse the 11th.
      if (i <= 10) last().emit('message', { type: 'completions', id: i, items: [] })
      await pending
    }
    expect(sentCompletes(last())).toHaveLength(10)
  })

  it('handles one completion at a time, until the worker has really answered (final review I2)', async () => {
    const mgr = makeManager({ completeTimeoutMs: 30 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const first = mgr.complete('ada', sessionId, 1, 'db.')
    await expect(mgr.complete('ada', sessionId, 2, 'db.')).resolves.toEqual([])
    // The client stops waiting, but the worker is still busy with it: nothing more is sent.
    await expect(first).resolves.toEqual([])
    await expect(mgr.complete('ada', sessionId, 3, 'db.')).resolves.toEqual([])
    expect(sentCompletes(last()).map((m) => m.id)).toEqual([1])
    // Once the worker answers, the next request goes through.
    last().emit('message', { type: 'completions', id: 1, items: [] })
    const next = mgr.complete('ada', sessionId, 4, 'db.')
    expect(sentCompletes(last()).map((m) => m.id)).toEqual([1, 4])
    last().emit('message', { type: 'completions', id: 4, items: ['db.x'] })
    await expect(next).resolves.toEqual(['db.x'])
  })

  it('resets a worker whose completion overruns, as a command timeout does (final review I2)', async () => {
    const mgr = makeManager({ completeTimeoutMs: 20, completeKillMs: 60 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    await mgr.complete('ada', sessionId, 1, 'while(true){}; db.')
    await vi.waitFor(() =>
      expect(audits.some((a) => a.action === 'shell.reset' && a.details.reason === 'timeout')).toBe(true),
    )
    expect(worker.killed).toBe(true)
  })

  it('polls the worker RSS while a completion is pending (final review I2)', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const worker = last()
    void mgr.complete('ada', sessionId, 1, 'db.')
    await vi.waitFor(
      () => expect(worker.sent.some((m) => (m as { type?: string }).type === 'ping')).toBe(true),
      {
        timeout: 3000,
      },
    )
  })

  it('does not credit a command with queries seen while a completion is pending (final review I2)', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    void mgr.complete('ada', sessionId, 1, 'db.')
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 2, 'db.orders.find()', sink)
    // The completer's own sample query, seen while the command waits in the worker.
    ;(mgr as unknown as { onQuery(id: string, o: () => unknown): void }).onQuery(sessionId, () => ({
      kind: 'aggregate',
      db: 'shop',
      coll: 'orders',
      pipeline: [{ $sample: { size: { $numberInt: '10' } } }],
    }))
    ;(mgr as unknown as { onCommand(id: string, name: string, refused: boolean): void }).onCommand(
      sessionId,
      'aggregate',
      false,
    )
    last().emit('message', { type: 'completions', id: 1, items: [] })
    last().emit('message', { type: 'result', id: 2, resultType: 'Cursor', value: [], hasMore: false })
    last().emit('message', { type: 'done', id: 2, prompt: '>' })
    expect(parts.find((p) => p.type === 'result')!.origin).toBeUndefined()
    const evalAudit = audits.find((a) => a.action === 'shell.eval')!
    expect(evalAudit.details.commands).toEqual({})
  })

  it('works out a query origin only for a running command with no completion pending (final review M9)', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const fire = (origin: () => unknown) =>
      (mgr as unknown as { onQuery(id: string, o: () => unknown): void }).onQuery(sessionId, origin)
    const origin = vi.fn(() => ({ kind: 'find', db: 'shop', coll: 'a', filter: {} }))
    fire(origin) // nothing running
    void mgr.complete('ada', sessionId, 1, 'db.')
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, 2, 'db.a.find()', sink)
    fire(origin) // a completion is pending
    expect(origin).not.toHaveBeenCalled()
    last().emit('message', { type: 'completions', id: 1, items: [] })
    fire(origin)
    expect(origin).toHaveBeenCalledTimes(1)
    last().emit('message', { type: 'result', id: 2, resultType: 'Cursor', value: [], hasMore: false })
    last().emit('message', { type: 'done', id: 2, prompt: '>' })
    expect(parts.find((p) => p.type === 'result')!.origin).toMatchObject({ coll: 'a' })
  })

  it('refuses an over-long request and a session of someone else', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await expect(mgr.complete('ada', sessionId, 1, 'x'.repeat(256 * 1024 + 1))).rejects.toMatchObject({
      statusCode: 413,
    })
    await expect(mgr.complete('bob', sessionId, 1, 'db.')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('resets a worker that answers with an over-sized item (IPC violation)', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const pending = mgr.complete('ada', sessionId, 5, 'db.')
    last().emit('message', { type: 'completions', id: 5, items: ['x'.repeat(513)] })
    await expect(pending).resolves.toEqual([])
    await vi.waitFor(() =>
      expect(audits.some((a) => a.action === 'shell.reset' && a.details.reason === 'ipc')).toBe(true),
    )
  })
})

describe('ShellManager result metadata (phase 3a-2 §3.3)', () => {
  type Origin = { kind: 'find'; db: string; coll: string; filter: Record<string, unknown> }
  const originA: Origin = { kind: 'find', db: 'shop', coll: 'a', filter: {} }
  const originB: Origin = { kind: 'find', db: 'shop', coll: 'b', filter: {} }
  const fireQuery = (mgr: ShellManager, sessionId: string, origin: Origin) =>
    (mgr as unknown as { onQuery(id: string, origin: () => Origin): void }).onQuery(sessionId, () => origin)

  async function run(
    mgr: ShellManager,
    sessionId: string,
    id: number,
    result: { resultType: string | null; hasMore?: boolean },
    query?: Origin,
  ) {
    const { parts, sink } = collect()
    await mgr.evaluate('ada', sessionId, id, 'x', sink)
    if (query) fireQuery(mgr, sessionId, query)
    last().emit('message', { type: 'result', id, value: [], ...result })
    last().emit('message', { type: 'done', id, prompt: '>' })
    return parts.find((p) => p.type === 'result')!
  }

  it('attaches the origin to a cursor result, with hasMore', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const r1 = await run(mgr, sessionId, 1, { resultType: 'Cursor', hasMore: true }, originA)
    expect(r1).toMatchObject({ origin: originA, hasMore: true })
    const r2 = await run(mgr, sessionId, 2, { resultType: 'AggregationCursor', hasMore: false }, originB)
    expect(r2).toMatchObject({ origin: originB, hasMore: false })
  })

  it('attaches no origin to a result that is not the cursor of that query (review focus 5)', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    for (const [i, resultType] of [null, 'Document', 'number'].entries()) {
      const r = await run(mgr, sessionId, i + 1, { resultType }, originA)
      expect(r.origin, String(resultType)).toBeUndefined()
    }
  })

  it('keeps the origin across it, and forgets it after another result', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await run(mgr, sessionId, 1, { resultType: 'Cursor', hasMore: true }, originA)
    const more = await run(mgr, sessionId, 2, { resultType: 'CursorIterationResult', hasMore: false })
    expect(more.origin).toEqual(originA)
    await run(mgr, sessionId, 3, { resultType: null })
    const stale = await run(mgr, sessionId, 4, { resultType: 'CursorIterationResult' })
    expect(stale.origin).toBeUndefined()
  })

  it('ignores a query seen while no command runs (the completer sample)', async () => {
    const mgr = makeManager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    fireQuery(mgr, sessionId, originA)
    const r = await run(mgr, sessionId, 1, { resultType: 'Cursor' })
    expect(r.origin).toBeUndefined()
  })
})
