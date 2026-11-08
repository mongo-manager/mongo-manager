// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readLastUpdate,
  readUpdateState,
  writeUpdateState,
  type UpdateState,
} from '@mongo-manager/shared/updates'
import { makeVersionDir, testKey } from '../../shared/test/versionFixture'
import { launch, type LaunchDeps } from '../src/launcher/run'
import { acquireLauncherLock } from '../src/launcher/lock'
import { launchPlan, versionLine } from '../src/launcher/entry'

/**
 * The final review's findings (2026-11-03), each pinned. A stand-in for the app takes the next step
 * of MM_TEST_PLAN: "ready" says it is ready then exits 0, "slow" says it is alive every 100 ms and
 * ready after 600 ms, "exitN" exits with N, "hold" stays silent. It writes its file and whether it
 * is a relaunch.
 */
const FAKE = `
const fs = require('fs')
const out = process.env.MM_TEST_OUT
const n = out + '.n'
const i = fs.existsSync(n) ? Number(fs.readFileSync(n, 'utf8')) : 0
fs.writeFileSync(n, String(i + 1))
const plan = process.env.MM_TEST_PLAN.split(',')
const step = plan[Math.min(i, plan.length - 1)]
fs.appendFileSync(out, JSON.stringify({ file: __filename, step, relaunch: process.env.MM_UPDATER_RELAUNCH === '1' }) + '\\n')
if (step === 'ready') {
  process.send({ mm: 'ready', version: 'x' })
  setTimeout(() => process.exit(0), 200)
} else if (step === 'slow') {
  const t = setInterval(() => process.send({ mm: 'alive' }), 100)
  setTimeout(() => { clearInterval(t); process.send({ mm: 'ready', version: 'x' }); setTimeout(() => process.exit(0), 200) }, 600)
} else if (step === 'hold') {
  setInterval(() => {}, 1000)
} else process.exit(Number(step.slice(4)))
`

let root: string
let dataDir: string
let appDir: string
let bundleDir: string
let out: string
const key = testKey()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mm-review-'))
  dataDir = join(root, 'data')
  appDir = join(dataDir, 'app')
  bundleDir = join(root, 'bundle', 'dist')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'cli.cjs'), FAKE)
  out = join(root, 'out.jsonl')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const version = (v: string, opts: { minLauncher?: string } = {}) =>
  makeVersionDir(appDir, v, 'package', key, {
    files: { 'package.json': '{}', 'dist/cli.cjs': FAKE },
    ...opts,
  })
const entryOf = (v: string) => join(appDir, v, 'package', 'dist', 'cli.cjs')
const state = (s: Partial<UpdateState>) =>
  writeUpdateState(appDir, { schema: 1, settled: null, pending: null, failed: [], ...s })
const runs = () =>
  existsSync(out)
    ? readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { file: string; step: string; relaunch: boolean })
    : []

function deps(plan: string, over: Partial<LaunchDeps> = {}) {
  const logs: string[] = []
  const d: LaunchDeps = {
    command: 'start',
    env: { ...process.env, MM_TEST_OUT: out, MM_TEST_PLAN: plan },
    dataDir,
    origin: {
      distribution: 'bundle',
      bundledVersion: '1.1.0',
      installDir: bundleDir,
      target: null,
      isolate: false,
    },
    keys: [key.pub],
    execArgv: [],
    log: (m) => logs.push(m),
    ...over,
  }
  return { d, logs }
}

describe('C1: the account is emptied before the version is checked', () => {
  it('a file changed while isolation runs is caught by the check after it, never run', async () => {
    version('1.2.0')
    state({ settled: '1.2.0' })
    const isolate = async () => {
      // What a process left behind would do: change the file after a check that came first.
      appendFileSync(entryOf('1.2.0'), '\n// changed\n')
      return { ended: 1, survivors: [] }
    }
    const { d, logs } = deps('exit0', {
      origin: { ...deps('').d.origin, isolate: true },
      isolate,
      updatesEnabled: false,
    })
    expect(await launch(['start'], d)).toBe(1)
    expect(runs()).toEqual([])
    expect(logs.join('\n')).toMatch(/1\.2\.0 .*was not run/)
  })

  it('says which processes would not end', async () => {
    version('1.2.0')
    state({ settled: '1.2.0' })
    const isolate = async () => ({ ended: 1, survivors: [4242] })
    const { d, logs } = deps('exit0', { origin: { ...deps('').d.origin, isolate: true }, isolate })
    await launch(['start'], d)
    expect(logs.join('\n')).toMatch(/4242/)
  })
})

describe('I1: one start launcher per data folder', () => {
  it('a second start waits for nothing and changes nothing: it says one is running', async () => {
    version('1.1.5')
    version('1.2.0')
    state({
      settled: '1.1.5',
      pending: { version: '1.2.0', from: '1.1.5', dbCopy: 'mongo-manager.db.before-1.2.0' },
    })
    mkdirSync(join(appDir, '.incoming-abcd'))
    const before = readFileSync(join(appDir, 'state.json'))
    const held = acquireLauncherLock(appDir)!
    try {
      const { d, logs } = deps('exit0')
      expect(await launch(['start'], d)).toBe(1)
      expect(logs.join('\n')).toMatch(/already starting or running/)
      expect(readFileSync(join(appDir, 'state.json')).equals(before)).toBe(true)
      expect(existsSync(join(appDir, '.incoming-abcd'))).toBe(true)
      expect(runs()).toEqual([])
      // Another command still runs, read-only.
      expect(await launch(['doctor'], deps('exit0', { command: 'doctor' }).d)).toBe(0)
    } finally {
      held.release()
    }
    expect(await launch(['start'], deps('ready').d)).toBe(0)
  })

  it('a lock left by a launcher that is gone never blocks a start (the OS drops it)', () => {
    const a = acquireLauncherLock(appDir)!
    expect(acquireLauncherLock(appDir)).toBeNull()
    a.release()
    const b = acquireLauncherLock(appDir)
    expect(b).not.toBeNull()
    b!.release()
  })
})

describe('I5: the repair download follows every way updates are turned off', () => {
  it('a config file’s updates.enabled false, or no key, means no download', async () => {
    for (const over of [{ updatesEnabled: false }, { keys: [] as string[] }]) {
      rmSync(appDir, { recursive: true, force: true })
      version('1.2.0')
      state({ settled: '1.2.0' })
      appendFileSync(entryOf('1.2.0'), '\n// changed\n')
      let asked = false
      const { d } = deps('exit0', { ...over, download: async () => (asked = true) })
      expect(await launch(['start'], d)).toBe(1)
      expect(asked).toBe(false)
    }
  })
})

describe('I6 and the fallback order', () => {
  it('a changed settled version is noted for the About page, downloaded again first, then run', async () => {
    version('1.1.5')
    version('1.2.0')
    state({ settled: '1.2.0' })
    appendFileSync(entryOf('1.2.0'), '\n// changed\n')
    const asked: string[] = []
    const download = async (v: string) => {
      asked.push(v)
      rmSync(join(appDir, v), { recursive: true })
      version(v)
      return true
    }
    expect(await launch(['start'], deps('exit0', { download, updatesEnabled: true }).d)).toBe(0)
    expect(asked).toEqual(['1.2.0'])
    expect(runs().map((r) => r.file)).toEqual([entryOf('1.2.0')])
    expect(readLastUpdate(appDir)).toMatchObject({ version: '1.2.0', outcome: 'refused', code: 'files' })
  })

  it('without a download, the previous verified version runs, and the note stays', async () => {
    version('1.1.5')
    version('1.2.0')
    state({ settled: '1.2.0' })
    appendFileSync(entryOf('1.2.0'), '\n// changed\n')
    await launch(['start'], deps('exit0', { updatesEnabled: false }).d)
    expect(runs().map((r) => r.file)).toEqual([entryOf('1.1.5')])
    expect(readLastUpdate(appDir)).toMatchObject({ outcome: 'refused' })
  })
})

describe('I7: a release that needs a newer installed program', () => {
  it('is not run by this one, and the database is left as it is', async () => {
    version('1.2.0', { minLauncher: '9.0.0' })
    state({ pending: { version: '1.2.0', from: null, dbCopy: 'mongo-manager.db.before-1.2.0' } })
    const { d, logs } = deps('exit0')
    await launch(['start'], d)
    expect(runs().map((r) => r.file)).toEqual([join(bundleDir, 'cli.cjs')])
    expect(logs.join('\n')).toMatch(/needs a newer installed program/)
    expect(readUpdateState(appDir)).toMatchObject({ pending: null, failed: ['1.2.0'] })
  })
})

describe('the minors', () => {
  it('an unreadable state.json runs the newest verified version, not the older bundled one', async () => {
    version('1.2.0')
    version('1.3.0')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'state.json'), '{"schema":1,"sett')
    const { d, logs } = deps('exit0')
    await launch(['start'], d)
    expect(runs().map((r) => r.file)).toEqual([entryOf('1.3.0')])
    expect(logs.join('\n')).toMatch(/state\.json/)
  })

  it('a start tidies what nothing needs: database copies no install waits for, and versions the install outgrew', async () => {
    version('1.0.9')
    version('1.2.0')
    state({ settled: '1.2.0' })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'mongo-manager.db.before-1.2.0'), 'a copy of everything')
    await launch(['start'], deps('exit0').d)
    expect(existsSync(join(dataDir, 'mongo-manager.db.before-1.2.0'))).toBe(false)
    expect(existsSync(join(appDir, '1.0.9'))).toBe(false)
    expect(existsSync(join(appDir, '1.2.0'))).toBe(true)
  })

  it('a version the installed program has caught up with is dropped as pending, its copy too', async () => {
    version('1.1.0')
    state({ pending: { version: '1.1.0', from: null, dbCopy: 'mongo-manager.db.before-1.1.0' } })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'mongo-manager.db.before-1.1.0'), 'x')
    await launch(['start'], deps('exit0').d)
    expect(readUpdateState(appDir).pending).toBeNull()
    expect(existsSync(join(dataDir, 'mongo-manager.db.before-1.1.0'))).toBe(false)
  })

  it('a database copy that cannot be put back does not end the launcher', async () => {
    version('1.1.5')
    version('1.2.0')
    state({
      settled: '1.1.5',
      pending: { version: '1.2.0', from: '1.1.5', dbCopy: 'mongo-manager.db.before-1.2.0' },
    })
    mkdirSync(join(dataDir, 'mongo-manager.db'), { recursive: true })
    writeFileSync(join(dataDir, 'mongo-manager.db', 'x'), 'a folder where the database file is')
    writeFileSync(join(dataDir, 'mongo-manager.db.before-1.2.0'), 'copy')
    const { d, logs } = deps('exit1,exit0')
    expect(await launch(['start'], d)).toBe(0)
    expect(runs().map((r) => r.file)).toEqual([entryOf('1.2.0'), entryOf('1.1.5')])
    expect(logs.join('\n')).toMatch(/could not be put back/)
  })

  it('a relaunch says so to the program (it opens no second browser tab)', async () => {
    await launch(['start'], deps('exit75,exit0').d)
    expect(runs().map((r) => r.relaunch)).toEqual([false, true])
  })

  it('a slow first start that keeps saying it is alive is not rolled back', async () => {
    version('1.1.5')
    version('1.2.0')
    state({
      settled: '1.1.5',
      pending: { version: '1.2.0', from: '1.1.5', dbCopy: 'mongo-manager.db.before-1.2.0' },
    })
    expect(await launch(['start'], deps('slow', { healthMs: 300 }).d)).toBe(0)
    expect(readUpdateState(appDir)).toMatchObject({ settled: '1.2.0', pending: null, failed: [] })
  })
})

describe('I2 and the commands: the launcher reads what any version may be given', () => {
  const base = () => ({ env: {}, cwd: root, platform: process.platform, home: '/home/x' })

  it('runs every command but service and help through the launcher, backup too', () => {
    expect(launchPlan(['service', 'install'], base())).toBeNull()
    expect(launchPlan(['help'], base())).toBeNull()
    expect(launchPlan(['--help'], base())).toBeNull()
    for (const argv of [['version'], ['--version'], ['backup', 'a.mmbak', 'out'], ['doctor'], []])
      expect(launchPlan(argv, base()), argv.join(' ')).not.toBeNull()
  })

  it('says the version that runs: the downloaded one when it verifies, as well as the installed one', () => {
    version('1.2.0')
    state({ settled: '1.2.0' })
    const origin = {
      distribution: 'bundle' as const,
      bundledVersion: '1.1.0',
      installDir: bundleDir,
      target: null,
      isolate: false,
    }
    expect(versionLine(dataDir, origin, [key.pub], '24.0.0')).toBe(
      'mongo-manager 1.2.0 (node 24.0.0; installed 1.1.0)',
    )
    appendFileSync(entryOf('1.2.0'), '\n// changed\n')
    expect(versionLine(dataDir, origin, [key.pub], '24.0.0')).toBe('mongo-manager 1.1.0 (node 24.0.0)')
  })

  it('an option or a config key a later version added still finds the data folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-plan-'))
    const config = join(dir, 'config.json')
    writeFileSync(
      config,
      JSON.stringify({ dataDir: join(dir, 'data'), aSettingOfLater: true, updates: { enabled: false } }),
    )
    const plan = launchPlan(['start', '--config', config, '--an-option-of-later', 'x'], base())!
    expect(plan.command).toBe('start')
    expect(plan.dataDir).toBe(join(dir, 'data'))
    expect(plan.updatesEnabled).toBe(false)
    expect(launchPlan(['--data-dir', 'rel', '--wat'], base())!.dataDir).toBe(join(root, 'rel'))
    expect(launchPlan(['doctor'], { ...base(), env: { MM_DATA_DIR: join(dir, 'e') } })!.dataDir).toBe(
      join(dir, 'e'),
    )
    expect(launchPlan([], base())!.dataDir).toBe(join('/home/x', '.mongo-manager'))
    rmSync(dir, { recursive: true, force: true })
  })
})
