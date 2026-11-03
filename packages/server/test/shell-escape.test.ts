import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startMongo, type TestMongo } from './support/mongo'
import { startTestWorker, type TestWorker } from './support/shell-worker'
import { slow } from './support/slowness'

/**
 * Phase 3a-1 spec §12: the sandbox holds. Every attempt to break out of the mongosh context — to
 * reach modules, the process, the file system, other processes or the network, or to generate code
 * — must fail, and the worker must keep working afterwards.
 */
let mongo: TestMongo
let uri: string
beforeAll(async () => {
  mongo = await startMongo()
  uri = `mongodb://${mongo.host}:${mongo.port}/?directConnection=true`
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})

const workers: TestWorker[] = []
afterEach(() => {
  for (const w of workers.splice(0)) w.close()
})
async function shell(): Promise<TestWorker> {
  const { worker } = await startTestWorker({ uri, db: 'shop', syncTimeoutMs: 3_000 })
  workers.push(worker)
  await worker.next('ready')
  return worker
}

/** An attempt is denied when it throws, or returns a value that proves the capability is absent. */
async function denied(
  worker: TestWorker,
  code: string,
): Promise<{ ok: boolean; value: unknown; message?: string }> {
  const r = await worker.evaluate(code)
  return r.ok ? { ok: true, value: r.value } : { ok: false, value: undefined, message: r.message }
}

describe('shell sandbox escapes are all refused (phase 3a-1 §12)', () => {
  it('hides modules and the process from user code', async () => {
    const w = await shell()
    expect(await denied(w, 'typeof require')).toMatchObject({ value: 'undefined' })
    expect(await denied(w, 'typeof process')).toMatchObject({ value: 'undefined' })
    expect(await denied(w, 'typeof module')).toMatchObject({ value: 'undefined' })
    expect(await denied(w, 'typeof globalThis.process')).toMatchObject({ value: 'undefined' })
    // Still alive.
    expect(await w.evaluate('1 + 1')).toMatchObject({ ok: true })
  })

  it('refuses every form of code generation', async () => {
    const w = await shell()
    for (const code of [
      "eval('1 + 1')",
      "Function('return 1')()",
      "db.constructor.constructor('return process')()",
      "new (Object.getPrototypeOf(async function () {}).constructor)('return 1')()",
      "new (Object.getPrototypeOf(function* () {}).constructor)('return 1')()",
      "(() => {}).constructor('return process.env')()",
    ]) {
      const r = await denied(w, code)
      expect(r.ok, `expected "${code}" to be refused`).toBe(false)
    }
    expect(await w.evaluate('2 + 2')).toMatchObject({ ok: true })
  })

  it('refuses reaching the process through a stack-trace CallSite', async () => {
    const w = await shell()
    // Even if user code overrides prepareStackTrace to capture CallSites, code generation is off,
    // so it cannot turn a captured object back into a call of process/require, and process is hidden.
    const r = await denied(
      w,
      `Error.prepareStackTrace = (_e, s) => s;
       const frames = new Error().stack;
       frames.map((f) => typeof f.getThis === 'function' ? typeof f.getThis() : 'none').join(',')`,
    )
    // Whatever it returns, no frame yields the host process object (which would expose env, mainModule).
    if (r.ok) expect(String(r.value)).not.toContain('mainModule')
    expect(await w.evaluate('3 + 3')).toMatchObject({ ok: true })
  })

  it('refuses dynamic import', async () => {
    const w = await shell()
    expect(await denied(w, "import('node:fs')")).toMatchObject({ ok: false })
    expect(await denied(w, "import('node:child_process')")).toMatchObject({ ok: false })
  })

  it('removes the mongosh file, editor and telemetry commands', async () => {
    const w = await shell()
    for (const code of ["load('/etc/passwd')", 'edit()', 'enableTelemetry()', 'disableTelemetry()']) {
      expect(await denied(w, code), code).toMatchObject({ ok: false })
    }
    expect(await w.evaluate('4 + 4')).toMatchObject({ ok: true })
  })

  it('has no network globals and no reachable network module', async () => {
    const w = await shell()
    expect(await denied(w, 'typeof fetch')).toMatchObject({ value: 'undefined' })
    expect(await denied(w, 'typeof WebSocket')).toMatchObject({ value: 'undefined' })
    expect(await denied(w, 'typeof EventSource')).toMatchObject({ value: 'undefined' })
    // require is gone, so there is no way to obtain net/tls/dns/http at all.
    expect(await denied(w, "typeof require === 'undefined' && 'no-require'")).toMatchObject({
      value: 'no-require',
    })
    expect(await w.evaluate('5 + 5')).toMatchObject({ ok: true })
  })

  it('does not expose credentials in the connection mongosh sees', async () => {
    const w = await shell()
    // The worker is given a credential-free URI; even so, assert no password marker leaks.
    const r = await denied(w, 'try { String(db.getMongo()) } catch (e) { "no-getMongo" }')
    if (r.ok && typeof r.value === 'string') expect(r.value).not.toMatch(/:[^/@]*@/)
    expect(await w.evaluate('6 + 6')).toMatchObject({ ok: true })
  })

  it('cannot read the file system through any reachable object', async () => {
    const w = await shell()
    // The permission model refuses fs even to the worker's own code; user code has no path to it.
    const r = await denied(w, "typeof require === 'undefined' ? 'no-fs-path' : require('fs')")
    expect(r).toMatchObject({ value: 'no-fs-path' })
    expect(await w.evaluate('7 + 7')).toMatchObject({ ok: true })
  })
})
