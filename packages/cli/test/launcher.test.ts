import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readOrigin,
  writeUpdateState,
  type UpdaterOrigin,
  type UpdateState,
} from '@mongo-manager/shared/updates'
import { makeVersionDir, testKey } from '../../shared/test/versionFixture'
import { launch, type LaunchDeps, type PreviousChild } from '../src/launcher/run'

/**
 * A stand-in for the app: it writes what it was started with to MM_TEST_OUT, then exits with the
 * next code of MM_TEST_CODES (counted in MM_TEST_OUT.n), or stays until stopped when MM_TEST_HOLD is set.
 */
const FAKE = `
const fs = require('fs')
const out = process.env.MM_TEST_OUT
fs.appendFileSync(out, JSON.stringify({ file: __filename, argv: process.argv.slice(2), origin: process.env.MM_UPDATER_ORIGIN, child: process.env.MM_UPDATER_CHILD }) + '\\n')
if (process.env.MM_TEST_HOLD) {
  const stop = (why) => { fs.appendFileSync(out, JSON.stringify({ stopped: why }) + '\\n'); process.exit(0) }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('disconnect', () => stop('disconnect'))
  setInterval(() => {}, 1000)
} else {
  const n = out + '.n'
  const i = fs.existsSync(n) ? Number(fs.readFileSync(n, 'utf8')) : 0
  fs.writeFileSync(n, String(i + 1))
  const codes = (process.env.MM_TEST_CODES || '0').split(',')
  process.exit(Number(codes[Math.min(i, codes.length - 1)]))
}
`

let root: string
let dataDir: string
let appDir: string
let bundleDir: string
let out: string
const key = testKey()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mm-launch-'))
  dataDir = join(root, 'data')
  appDir = join(dataDir, 'app')
  bundleDir = join(root, 'bundle', 'dist')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'cli.cjs'), FAKE)
  out = join(root, 'out.jsonl')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const origin = (over: Partial<UpdaterOrigin> = {}): UpdaterOrigin => ({
  distribution: 'bundle',
  bundledVersion: '1.1.0',
  installDir: bundleDir,
  target: null,
  isolate: false,
  ...over,
})
const version = (v: string) =>
  makeVersionDir(appDir, v, 'package', key, {
    files: { 'package.json': '{}', 'dist/cli.cjs': FAKE },
  })
const state = (s: Partial<UpdateState>) =>
  writeUpdateState(appDir, { schema: 1, settled: null, pending: null, failed: [], ...s })
const runs = () =>
  readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { file?: string; argv?: string[]; origin?: string; stopped?: string })

function deps(over: Partial<LaunchDeps> & { codes?: string; hold?: boolean } = {}) {
  const logs: string[] = []
  const { codes, hold, ...rest } = over
  const d: LaunchDeps = {
    command: 'start',
    env: {
      ...process.env,
      MM_TEST_OUT: out,
      MM_TEST_CODES: codes ?? '0',
      ...(hold ? { MM_TEST_HOLD: '1' } : {}),
    },
    dataDir,
    origin: origin(),
    keys: [key.pub],
    execArgv: [],
    log: (m) => logs.push(m),
    ...rest,
  }
  return { d, logs }
}

describe('the launcher', () => {
  it('runs the bundled program with the same arguments when nothing was downloaded', async () => {
    const { d } = deps({ codes: '3' })
    expect(await launch(['start', '--no-open'], d)).toBe(3)
    const [run] = runs()
    expect(run!.file).toBe(join(bundleDir, 'cli.cjs'))
    expect(run!.argv).toEqual(['start', '--no-open'])
    expect(readOrigin({ MM_UPDATER_CHILD: '1', MM_UPDATER_ORIGIN: run!.origin })).toEqual(origin())
  })

  it('runs the settled version when it is newer than the bundled one and verifies', async () => {
    const dir = version('1.2.0')
    state({ settled: '1.2.0' })
    expect(await launch(['start'], deps().d)).toBe(0)
    expect(runs()[0]!.file).toBe(join(dir, 'package', 'dist', 'cli.cjs'))
  })

  it('never runs a version no older than the bundled one, a failed one or one never installed', async () => {
    version('1.0.9')
    state({ settled: '1.0.9' })
    await launch(['start'], deps().d)
    expect(runs()[0]!.file).toBe(join(bundleDir, 'cli.cjs'))

    rmSync(out)
    version('1.2.0')
    state({ settled: '1.2.0', failed: ['1.2.0'] })
    await launch(['start'], deps().d)
    expect(runs()[0]!.file).toBe(join(bundleDir, 'cli.cjs'))

    // A folder no install finished (renamed in place, the state never written) does not run.
    rmSync(out)
    version('1.3.0')
    state({})
    await launch(['start'], deps().d)
    expect(runs()[0]!.file).toBe(join(bundleDir, 'cli.cjs'))
  })

  it('refuses a version whose files were changed, and says why', async () => {
    const dir = version('1.2.0')
    writeFileSync(join(dir, 'package', 'dist', 'cli.cjs'), 'require("fs").writeFileSync("pwned", "")')
    state({ pending: { version: '1.2.0', from: null, dbCopy: 'mongo-manager.db.before-1.2.0' } })
    const { d, logs } = deps()
    await launch(['start'], d)
    expect(runs()[0]!.file).toBe(join(bundleDir, 'cli.cjs'))
    expect(logs.join('\n')).toMatch(/1\.2\.0.*files/)
  })

  it('starts the program again when it asks to (exit 75)', async () => {
    expect(await launch(['start'], deps({ codes: '75,0' }).d)).toBe(0)
    expect(runs()).toHaveLength(2)
  })

  it('stops when the program restarts too often', async () => {
    const { d, logs } = deps({ codes: '75' })
    expect(await launch(['start'], d)).toBe(1)
    expect(runs()).toHaveLength(4)
    expect(logs.join('\n')).toMatch(/restarting too often/)
  })

  it('lets another command run the settled version and leaves the state as it was', async () => {
    const settled = version('1.2.0')
    version('1.3.0')
    state({
      settled: '1.2.0',
      pending: { version: '1.3.0', from: '1.2.0', dbCopy: 'mongo-manager.db.before-1.3.0' },
    })
    const before = readFileSync(join(appDir, 'state.json'))
    mkdirSync(join(appDir, '.incoming-ab12'))
    await launch(['doctor'], deps({ command: 'doctor' }).d)
    expect(runs()[0]!.file).toBe(join(settled, 'package', 'dist', 'cli.cjs'))
    expect(readFileSync(join(appDir, 'state.json')).equals(before)).toBe(true)
    // Only a start tidies the folder.
    expect(existsSync(join(appDir, '.incoming-ab12'))).toBe(true)
  })

  it('removes a download that never finished when it starts', async () => {
    mkdirSync(join(appDir, '.incoming-ab12'), { recursive: true })
    await launch(['start'], deps().d)
    expect(existsSync(join(appDir, '.incoming-ab12'))).toBe(false)
  })

  it('hands a stop on to the program, which closes as it would alone', async () => {
    const signals = new EventEmitter()
    const { d } = deps({ hold: true, signals })
    const done = launch(['start'], d)
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50))
    signals.emit('SIGTERM', 'SIGTERM')
    expect(await done).toBe(0)
    // POSIX: the signal itself; Windows has none, so the launcher's channel closing says it.
    expect(runs()[1]!.stopped).toBe(process.platform === 'win32' ? 'disconnect' : 'SIGTERM')
  })

  it('reads the child contract only when it is whole', () => {
    const o = JSON.stringify(origin())
    expect(readOrigin({ MM_UPDATER_CHILD: '1', MM_UPDATER_ORIGIN: o })).toEqual(origin())
    expect(readOrigin({ MM_UPDATER_ORIGIN: o })).toBeNull()
    expect(readOrigin({ MM_UPDATER_CHILD: '1', MM_UPDATER_ORIGIN: '{' })).toBeNull()
    // Final review (I7): what a later launcher adds is left out, never a reason to refuse it.
    expect(
      readOrigin({ MM_UPDATER_CHILD: '1', MM_UPDATER_ORIGIN: JSON.stringify({ ...origin(), x: 1 }) }),
    ).toEqual(origin())
    expect(
      readOrigin({
        MM_UPDATER_CHILD: '1',
        MM_UPDATER_ORIGIN: JSON.stringify({ ...origin(), isolate: 'yes' }),
      }),
    ).toBeNull()
  })
})

describe('the account of its own (design §7b-1)', () => {
  it('ends the account’s other processes before a downloaded version runs, the previous program’s tree on a restart', async () => {
    version('1.2.0')
    state({ settled: '1.2.0' })
    const calls: Array<PreviousChild | undefined> = []
    const isolate = async (previous?: PreviousChild) => (calls.push(previous), { ended: 0, survivors: [] })
    await launch(['start'], deps({ codes: '75,0', origin: origin({ isolate: true }), isolate }).d)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBeUndefined()
    expect(calls[1]).toMatchObject({ pid: expect.any(Number), startedAt: expect.any(Number) })
  })

  it('does not for the bundled program, another command or an install that is not its own', async () => {
    const calls: unknown[] = []
    const isolate = async () => (calls.push(1), { ended: 0, survivors: [] })
    await launch(['start'], deps({ origin: origin({ isolate: true }), isolate }).d)
    version('1.2.0')
    state({ settled: '1.2.0' })
    await launch(['doctor'], deps({ command: 'doctor', origin: origin({ isolate: true }), isolate }).d)
    await launch(['start'], deps({ isolate }).d)
    expect(calls).toEqual([])
  })
})
