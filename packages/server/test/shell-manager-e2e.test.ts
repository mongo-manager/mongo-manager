// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConnectionSettings } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { WORKER_BUNDLE } from './support/shell-worker'
import { ShellManager, type EvalPart, type ShellAuditRow, type UpstreamPlan } from '../src/shell/manager'
import { MongoClient } from 'mongodb'
import { fillSnippet } from '@mongo-manager/shared'
import { slow } from './support/slowness'

/** Phase 3a-1: the ShellManager end to end, with a real sandboxed worker and proxy against MongoDB. */
let mongo: TestMongo
beforeAll(async () => {
  // Test commands on: the sleep command stands for a long operation (security audit 2026-10-16, I3).
  mongo = await startMongo({ args: ['--setParameter', 'enableTestCommands=1'] })
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})

const managers: ShellManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown()
})

function manager(
  readOnly = false,
  options: {
    allowServerJs?: boolean
    audits?: ShellAuditRow[]
    hangMs?: number
    commandTimeoutMs?: number
    killGraceMs?: number
  } = {},
): ShellManager {
  const settings = {
    scheme: 'mongodb',
    hosts: [{ host: mongo.host, port: mongo.port }],
    auth: { mechanism: 'none' },
    tls: { enabled: false },
  } as unknown as ConnectionSettings
  const plan: UpstreamPlan = {
    settings,
    readOnly,
    admin: !readOnly,
    allowHost: (h, p) => h === mongo.host && p === mongo.port,
    tls: null,
  }
  const mgr = new ShellManager({
    config: {
      shell: {
        maxPerUser: 3,
        maxTotal: 20,
        commandTimeoutMs: options.commandTimeoutMs ?? 60_000,
        idleMs: 0,
        lifetimeMs: 0,
      },
      ...(options.allowServerJs !== undefined ? { allowServerJs: options.allowServerJs } : {}),
    },
    now: () => Date.now(),
    log: { warn() {}, info() {}, error() {} },
    audit: (row) => options.audits?.push(row),
    plan: () => plan,
    bundlePath: WORKER_BUNDLE,
    ...(options.hangMs !== undefined ? { hangMs: options.hangMs } : {}),
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
    // Loading the mongosh bundle and connecting through the proxy is heavy under v8 coverage
    // instrumentation; give the real worker more room than the 20s production default.
    startTimeoutMs: 60_000,
  })
  managers.push(mgr)
  return mgr
}

/**
 * Runs code and waits for its end — at most 75 s, then fails saying what came (second review
 * 2026-10-12, minor 27: a run that never ended timed the test out with nothing to go on).
 */
async function evaluate(mgr: ShellManager, sessionId: string, code: string): Promise<EvalPart[]> {
  const parts: EvalPart[] = []
  await mgr.evaluate('ada', sessionId, Math.floor(Math.random() * 1e6) + 1, code, (p) => parts.push(p))
  const started = Date.now()
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (parts.some((p) => p.type === 'done')) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > 75_000) {
        clearInterval(timer)
        reject(new Error(`no end after 75 s; parts so far: ${JSON.stringify(parts).slice(0, 2000)}`))
      }
    }, 20)
  })
  return parts
}

describe('ShellManager end to end (phase 3a-1)', () => {
  it('opens a real sandboxed shell and runs a query through the proxy', async () => {
    const mgr = manager()
    const { sessionId, prompt } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    expect(prompt).toMatch(/>/)
    const parts = await evaluate(mgr, sessionId, 'db.e2e.insertMany([{a:1},{a:2}]); db.e2e.countDocuments()')
    const result = parts.find((p) => p.type === 'result')
    expect(result).toBeTruthy()
    expect(parts.some((p) => p.type === 'error')).toBe(false)
  }, 90_000)

  it('refuses a write on a read-only session but allows a read', async () => {
    const mgr = manager(true)
    const { sessionId } = await mgr.open({ owner: 'ada', admin: false, readOnly: true }, 'c1', 'shop')
    const write = await evaluate(mgr, sessionId, 'db.e2e.insertOne({x:1})')
    expect(
      write.some((p) => p.type === 'error' && (p.message ?? '').includes('Refused by Mongo Manager')),
    ).toBe(true)
    const read = await evaluate(mgr, sessionId, 'db.e2e.find().toArray().length')
    expect(read.some((p) => p.type === 'result')).toBe(true)
  }, 90_000)

  it('reports the query origin and hasMore for a cursor, and keeps the origin across it (phase 3a-2)', async () => {
    const mgr = manager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const first = await evaluate(mgr, sessionId, 'db.e2eorigin.find({a:1}).sort({a:-1}).limit(3)')
    const r1 = first.find((p) => p.type === 'result')!
    expect(r1.origin).toEqual({
      kind: 'find',
      db: 'shop',
      coll: 'e2eorigin',
      filter: { a: { $numberInt: '1' } },
      sort: { a: { $numberInt: '-1' } },
      limit: 3,
    })
    expect(r1.hasMore).toBe(false)
    await evaluate(mgr, sessionId, 'db.e2eorigin.insertMany(Array.from({ length: 25 }, (_, i) => ({ i })))')
    const all = (await evaluate(mgr, sessionId, 'db.e2eorigin.find()')).find((p) => p.type === 'result')!
    expect(all.hasMore).toBe(true)
    // A cursor batch is sent as the documents themselves (mongosh wraps them in { cursorHasMore,
    // documents }), so the terminal prints documents and the result pane shows one row each.
    expect(Array.isArray(all.value)).toBe(true)
    expect(all.value).toHaveLength(20)
    expect(all.origin).toMatchObject({ kind: 'find', coll: 'e2eorigin', filter: {} })
    const more = (await evaluate(mgr, sessionId, 'it')).find((p) => p.type === 'result')!
    expect(more.origin).toEqual(all.origin)
  }, 90_000)

  it("runs a shared writing snippet with the running user's rights: read-only refuses it (review focus 4)", async () => {
    // Sharing shares text, not privilege: the filled code goes through the reader's own policy.
    const filled = fillSnippet('db.snipw.insertOne({ v: {{v}} })', [{ name: 'v', type: 'number' }], {
      v: '1',
    })
    expect(filled.ok).toBe(true)
    const mgr = manager(true)
    const { sessionId } = await mgr.open({ owner: 'ada', admin: false, readOnly: true }, 'c1', 'shop')
    const parts = await evaluate(mgr, sessionId, filled.ok ? filled.code : '')
    expect(
      parts.some((p) => p.type === 'error' && (p.message ?? '').includes('Refused by Mongo Manager')),
    ).toBe(true)
    const client = new MongoClient(`mongodb://${mongo.host}:${mongo.port}/?directConnection=true`)
    try {
      expect(await client.db('shop').collection('snipw').countDocuments()).toBe(0)
    } finally {
      await client.close()
    }
  }, 90_000)

  // Security audit 2026-10-16 (minor): a result larger than a message reset the worker (or, larger
  // still, was parsed whole on the server's main thread); now it is held back and the output cut.
  it('cuts a result too large to send, without resetting the shell', async () => {
    const mgr = manager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await evaluate(mgr, sessionId, 'var kept = 7')
    const parts = await evaluate(mgr, sessionId, "'x'.repeat(3 * 1024 * 1024)")
    expect(parts.some((p) => p.type === 'reset')).toBe(false)
    expect(parts.some((p) => p.type === 'print' && (p.text ?? '').includes('output truncated'))).toBe(true)
    expect(parts.some((p) => p.type === 'result')).toBe(false)
    // The same worker: its variables are still there.
    const after = await evaluate(mgr, sessionId, 'kept')
    expect(after.find((p) => p.type === 'result')?.value).toEqual({ $numberInt: '7' })
  }, 120_000)

  const EMIT =
    "db.e2ejs.aggregate([{ $project: { e: { $_internalJsEmit: { eval: 'function () { emit(this._id, 42) }', this: '$$ROOT' } } } }]).toArray()"
  // Security audit 2026-10-16 (Important 1): the shell honours allowServerJs like every other path.
  it('refuses server JavaScript unless the server allows it, with a code the page words', async () => {
    const mgr = manager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await evaluate(mgr, sessionId, 'db.e2ejs.insertOne({ a: 1 })')
    for (const code of [
      "db.e2ejs.find({ $where: 'true' }).toArray()",
      "db.e2ejs.aggregate([{ $match: { $expr: { $function: { body: 'function () { return true }', args: [], lang: 'js' } } } }]).toArray()",
      'db.e2ejs.mapReduce(function () { emit(1, 1) }, function (k, v) { return 1 }, { out: { inline: 1 } })',
      // Security review 2026-10-16 (I-1): MongoDB's internal JavaScript operator.
      EMIT,
    ]) {
      const parts = await evaluate(mgr, sessionId, code)
      const error = parts.find((p) => p.type === 'error')
      expect(error, code).toBeTruthy()
      expect(error!.code, code).toBe('SERVER_JS')
      expect(
        parts.some((p) => p.type === 'result'),
        code,
      ).toBe(false)
    }
    const allowed = manager(false, { allowServerJs: true })
    const open = await allowed.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const parts = await evaluate(
      allowed,
      open.sessionId,
      "db.e2ejs.find({ $where: 'true' }).toArray().length",
    )
    expect(parts.find((p) => p.type === 'result')?.value).toEqual({ $numberInt: '1' })
    // It really runs JavaScript on this server when allowed: the refusal is not for show.
    const emitted = await evaluate(allowed, open.sessionId, `${EMIT}.length`)
    expect(emitted.find((p) => p.type === 'result')?.value).toEqual({ $numberInt: '1' })
  }, 120_000)

  // Security audit 2026-10-16 (Important 2): a synchronous loop filling ArrayBuffers answered no
  // ping and is outside the V8 heap cap; it grew until the command's 60 s were up (648 MB seen).
  it('resets a worker filling memory outside the heap in a synchronous loop, long before the timeout', async () => {
    const audits: ShellAuditRow[] = []
    const mgr = manager(false, { audits })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const started = Date.now()
    // About 700 MB, then it holds it, busy, answering nothing: well past the 384 MiB cap.
    const parts = await evaluate(
      mgr,
      sessionId,
      'const kept = []; for (let i = 0; i < 11; i++) { const b = new ArrayBuffer(64 * 1024 * 1024); new Uint8Array(b).fill(1); kept.push(b) } while (true) {}',
    )
    expect(parts.some((p) => p.type === 'reset')).toBe(true)
    expect(audits.some((a) => a.action === 'shell.reset' && a.details.reason === 'memory')).toBe(true)
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 120_000)

  // Security audit 2026-10-16 (Important 2): a loop a command leaves behind runs after the command
  // has ended, where nothing watched the worker.
  it('resets a worker a loop left behind keeps from answering, once no command runs', async () => {
    const audits: ShellAuditRow[] = []
    const mgr = manager(false, { audits, hangMs: 3000 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    // A detached async function: the command ends at once, the loop starts after a few queries,
    // outside the command and its synchronous time limit.
    const parts = await evaluate(
      mgr,
      sessionId,
      'void (async () => { for (let i = 0; i < 20; i++) { try { await db.hangx.findOne() } catch (e) {} } while (true) {} })(); 1',
    )
    expect(parts.some((p) => p.type === 'reset')).toBe(false)
    await vi.waitFor(
      () => expect(audits.some((a) => a.action === 'shell.reset' && a.details.reason === 'hang')).toBe(true),
      { timeout: 20_000, interval: 200 },
    )
    // The session lives on, with a new worker.
    await vi.waitFor(
      async () => {
        const again = await evaluate(mgr, sessionId, '6 * 7')
        expect(again.find((p) => p.type === 'result')?.value).toEqual({ $numberInt: '42' })
      },
      { timeout: 60_000, interval: 1000 },
    )
  }, 120_000)

  /** The operations a session runs on the server, seen from another client. */
  async function opsOf(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const client = new MongoClient(`mongodb://${mongo.host}:${mongo.port}/?directConnection=true`)
    try {
      const reply = await client.db('admin').command({ currentOp: 1, appName: `mm-shell:${sessionId}` })
      return (reply.inprog as Array<Record<string, unknown>>).filter(
        (op) => op.command && 'sleep' in (op.command as object),
      )
    } finally {
      await client.close()
    }
  }

  // Security audit 2026-10-16 (Important 3): Ctrl+C and the command timeout stopped the shell but left
  // the operation running on MongoDB; spec §5.4 has the server kill the session's operations.
  it('Ctrl+C ends the operation on MongoDB too, not only in the shell', async () => {
    const audits: ShellAuditRow[] = []
    // A long grace: the operation must end because it was killed, not because the worker was.
    const mgr = manager(false, { audits, killGraceMs: 25_000 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const parts: EvalPart[] = []
    await mgr.evaluate('ada', sessionId, 1, "db.adminCommand({ sleep: 1, secs: 40, lock: 'none' })", (p) =>
      parts.push(p),
    )
    await vi.waitFor(async () => expect(await opsOf(sessionId)).toHaveLength(1), {
      timeout: 15_000,
      interval: 200,
    })
    mgr.cancel('ada', sessionId)
    await vi.waitFor(async () => expect(await opsOf(sessionId)).toHaveLength(0), {
      timeout: 5000,
      interval: 200,
    })
    await vi.waitFor(() => expect(parts.some((p) => p.type === 'done')).toBe(true), { timeout: 5000 })
    expect(parts.some((p) => p.type === 'reset')).toBe(false)
  }, 120_000)

  it('a command that runs past its time is ended on MongoDB too', async () => {
    const mgr = manager(false, { commandTimeoutMs: 3000, killGraceMs: 25_000 })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    const parts: EvalPart[] = []
    await mgr.evaluate('ada', sessionId, 1, "db.adminCommand({ sleep: 1, secs: 40, lock: 'none' })", (p) =>
      parts.push(p),
    )
    await vi.waitFor(async () => expect(await opsOf(sessionId)).toHaveLength(1), {
      timeout: 15_000,
      interval: 200,
    })
    await vi.waitFor(async () => expect(await opsOf(sessionId)).toHaveLength(0), {
      timeout: 10_000,
      interval: 200,
    })
    await vi.waitFor(() => expect(parts.some((p) => p.type === 'done')).toBe(true), { timeout: 5000 })
  }, 120_000)

  // Second review 2026-10-16 (N-2): mongosh prefetched collection and database names on every `use`
  // without waiting for them, so they reached the proxy after the command ended and were refused.
  it('switches database without anything left running after the command', async () => {
    const audits: ShellAuditRow[] = []
    const mgr = manager(false, { audits })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    for (const db of ['e2euse1', 'e2euse2', 'shop']) {
      const parts = await evaluate(mgr, sessionId, `use ${db}`)
      expect(parts.some((p) => p.type === 'error')).toBe(false)
      await new Promise((r) => setTimeout(r, 700))
    }
    await evaluate(mgr, sessionId, '1')
    for (const row of audits.filter((a) => a.action === 'shell.eval'))
      expect(row.details.refusedWhileIdle, JSON.stringify(row.details)).toBeUndefined()
  }, 120_000)

  // Security review 2026-10-16 (I-3): code a command left running kept querying for hours, out of
  // reach of the time limit, Ctrl+C and the audit.
  it('refuses what code left running sends once its command ended, and audits it', async () => {
    const audits: ShellAuditRow[] = []
    const mgr = manager(false, { audits })
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    await evaluate(mgr, sessionId, 'db.bg.insertMany(Array.from({ length: 50 }, (_, i) => ({ i })))')
    const started = await evaluate(
      mgr,
      sessionId,
      'var refusals = 0; void (async () => { for (let i = 0; i < 200; i++) { try { await db.bg.aggregate([{ $match: {} }]).toArray() } catch (e) { refusals++ } } })(); 1',
    )
    expect(started.some((p) => p.type === 'error')).toBe(false)
    await new Promise((r) => setTimeout(r, 1500))
    const count = await evaluate(mgr, sessionId, 'refusals')
    expect(
      Number((count.find((p) => p.type === 'result')?.value as { $numberInt?: string })?.$numberInt),
    ).toBeGreaterThan(0)
    const row = audits.filter((a) => a.action === 'shell.eval').at(-1)!
    expect(row.details.refusedWhileIdle).toMatchObject({ aggregate: expect.any(Number) })
  }, 120_000)

  it('kills an operation still running when its command has ended', async () => {
    const mgr = manager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    // The command ends at once; its sleep is sent before it ends, or refused after.
    const parts = await evaluate(
      mgr,
      sessionId,
      "void (async () => { await db.getSiblingDB('admin').runCommand({ sleep: 1, secs: 40, lock: 'none' }) })(); sleep(300); 1",
    )
    expect(parts.some((p) => p.type === 'done')).toBe(true)
    await new Promise((r) => setTimeout(r, 500))
    await vi.waitFor(async () => expect(await opsOf(sessionId)).toHaveLength(0), {
      timeout: 6000,
      interval: 200,
    })
  }, 120_000)

  it('Ctrl+C with no command running ends an operation code left running', async () => {
    const mgr = manager()
    const { sessionId } = await mgr.open({ owner: 'ada', admin: true, readOnly: false }, 'c1', 'shop')
    // Started inside a command that waits a moment, so the sleep is sent while the command runs.
    const parts: EvalPart[] = []
    await mgr.evaluate(
      'ada',
      sessionId,
      1,
      "void (async () => { await db.getSiblingDB('admin').runCommand({ sleep: 1, secs: 40, lock: 'none' }) })(); sleep(500); 1",
      (p) => parts.push(p),
    )
    await vi.waitFor(async () => expect(await opsOf(sessionId)).toHaveLength(1), {
      timeout: 15_000,
      interval: 100,
    })
    await vi.waitFor(() => expect(parts.some((p) => p.type === 'done')).toBe(true), { timeout: 15_000 })
    // The command's end already asks for it; Ctrl+C asks again — either way it is gone.
    mgr.cancel('ada', sessionId)
    await vi.waitFor(async () => expect(await opsOf(sessionId)).toHaveLength(0), {
      timeout: 6000,
      interval: 200,
    })
  }, 120_000)
})
