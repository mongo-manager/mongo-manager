// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { restoreDbCopy } from '../src/launcher/health'

/**
 * A stand-in for the app. Each start takes the next step of MM_TEST_PLAN (counted in
 * MM_TEST_OUT.n): "ready" says it is ready then exits 0, "exitN" exits with N at once, "hold" stays
 * silent until stopped.
 */
const FAKE = `
const fs = require('fs')
const out = process.env.MM_TEST_OUT
const n = out + '.n'
const i = fs.existsSync(n) ? Number(fs.readFileSync(n, 'utf8')) : 0
fs.writeFileSync(n, String(i + 1))
const plan = process.env.MM_TEST_PLAN.split(',')
const step = plan[Math.min(i, plan.length - 1)]
fs.appendFileSync(out, JSON.stringify({ file: __filename, step }) + '\\n')
if (step === 'ready') {
  process.send({ mm: 'ready', version: 'x' })
  setTimeout(() => process.exit(0), 300)
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
  root = mkdtempSync(join(tmpdir(), 'mm-health-'))
  dataDir = join(root, 'data')
  appDir = join(dataDir, 'app')
  bundleDir = join(root, 'bundle', 'dist')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'cli.cjs'), FAKE)
  out = join(root, 'out.jsonl')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const version = (v: string) =>
  makeVersionDir(appDir, v, 'package', key, { files: { 'package.json': '{}', 'dist/cli.cjs': FAKE } })
const entryOf = (v: string) => join(appDir, v, 'package', 'dist', 'cli.cjs')
const state = (s: Partial<UpdateState>) =>
  writeUpdateState(appDir, { schema: 1, settled: null, pending: null, failed: [], ...s })
const files = () =>
  readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .map((l) => (JSON.parse(l) as { file: string }).file)
const db = (name = 'mongo-manager.db') => join(dataDir, name)

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
    now: () => 1_700_000_000_000,
    ...over,
  }
  return { d, logs }
}

/** A version being installed from 1.1.5, with the database copied before the switch. */
function pending() {
  version('1.1.5')
  version('1.2.0')
  state({
    settled: '1.1.5',
    pending: { version: '1.2.0', from: '1.1.5', dbCopy: 'mongo-manager.db.before-1.2.0' },
  })
  writeFileSync(db(), 'changed by 1.2.0')
  writeFileSync(db('mongo-manager.db-wal'), 'wal of 1.2.0')
  writeFileSync(db('mongo-manager.db.before-1.2.0'), 'as 1.1.5 left it')
}

describe('a new version’s first start', () => {
  it('settles the version once it says it is ready, and drops the database copy', async () => {
    pending()
    version('1.0.9')
    expect(await launch(['start'], deps('ready').d)).toBe(0)
    const s = readUpdateState(appDir)
    expect(s.settled).toBe('1.2.0')
    expect(s.pending).toBeNull()
    expect(existsSync(db('mongo-manager.db.before-1.2.0'))).toBe(false)
    expect(readLastUpdate(appDir)).toMatchObject({ version: '1.2.0', outcome: 'updated' })
    // The previous version stays for a fallback; others go.
    expect(existsSync(join(appDir, '1.1.5'))).toBe(true)
    expect(existsSync(join(appDir, '1.0.9'))).toBe(false)
    expect(readFileSync(db(), 'utf8')).toBe('changed by 1.2.0')
  })

  it('rolls back a version that stops before it is ready: the database as it was, the previous version again', async () => {
    pending()
    const { d, logs } = deps('exit1,exit0')
    expect(await launch(['start'], d)).toBe(0)
    expect(files()).toEqual([entryOf('1.2.0'), entryOf('1.1.5')])
    expect(readFileSync(db(), 'utf8')).toBe('as 1.1.5 left it')
    expect(existsSync(db('mongo-manager.db-wal'))).toBe(false)
    const s = readUpdateState(appDir)
    expect(s).toMatchObject({ settled: '1.1.5', pending: null, failed: ['1.2.0'] })
    expect(readLastUpdate(appDir)).toMatchObject({ version: '1.2.0', outcome: 'rolled_back' })
    expect(logs.join('\n')).toMatch(/update to 1\.2\.0 failed at first start: it stopped with code 1/)
  })

  it('rolls back a version that never says it is ready', async () => {
    pending()
    const { d, logs } = deps('hold,exit0', { healthMs: 300 })
    expect(await launch(['start'], d)).toBe(0)
    expect(files()).toEqual([entryOf('1.2.0'), entryOf('1.1.5')])
    expect(readFileSync(db(), 'utf8')).toBe('as 1.1.5 left it')
    expect(readUpdateState(appDir).failed).toEqual(['1.2.0'])
    expect(logs.join('\n')).toMatch(/did not say it was ready/)
  })

  it('drops a version being installed whose files do not verify, before it runs', async () => {
    pending()
    writeFileSync(entryOf('1.2.0'), 'changed')
    await launch(['start'], deps('exit0').d)
    expect(files()).toEqual([entryOf('1.1.5')])
    expect(readUpdateState(appDir)).toMatchObject({ settled: '1.1.5', pending: null, failed: ['1.2.0'] })
    // It never ran: the database was not changed by it, the copy is not needed.
    expect(readFileSync(db(), 'utf8')).toBe('changed by 1.2.0')
    expect(existsSync(db('mongo-manager.db.before-1.2.0'))).toBe(false)
  })
})

describe('a settled version that no longer verifies', () => {
  it('runs the previous verified version, leaving the database alone', async () => {
    version('1.1.5')
    version('1.2.0')
    state({ settled: '1.2.0' })
    writeFileSync(entryOf('1.2.0'), 'changed')
    writeFileSync(db(), 'data')
    const { d, logs } = deps('exit0')
    await launch(['start'], d)
    expect(files()).toEqual([entryOf('1.1.5')])
    expect(readFileSync(db(), 'utf8')).toBe('data')
    expect(logs.join('\n')).toMatch(/1\.2\.0.*not run/)
  })

  it('downloads it again when nothing else verifies', async () => {
    version('1.2.0')
    state({ settled: '1.2.0' })
    writeFileSync(entryOf('1.2.0'), 'changed')
    const asked: string[] = []
    const download = async (v: string) => {
      asked.push(v)
      rmSync(join(appDir, v), { recursive: true })
      version(v)
      return true
    }
    expect(await launch(['start'], deps('exit0', { download }).d)).toBe(0)
    expect(asked).toEqual(['1.2.0'])
    expect(files()).toEqual([entryOf('1.2.0')])
  })

  it('never falls back to the older bundled version, and says how to reinstall', async () => {
    version('1.2.0')
    state({ settled: '1.2.0' })
    writeFileSync(entryOf('1.2.0'), 'changed')
    const { d, logs } = deps('exit0', {
      env: { ...process.env, MM_TEST_OUT: out, MM_TEST_PLAN: 'exit0', MM_UPDATES: 'off' },
      download: async () => true,
    })
    expect(await launch(['start'], d)).toBe(1)
    expect(existsSync(out)).toBe(false)
    expect(logs.join('\n')).toMatch(/Mongo Manager 1\.2\.0 is damaged and could not be repaired/)
  })

  it('another command does not download: it says the same and stops', async () => {
    version('1.2.0')
    state({ settled: '1.2.0' })
    writeFileSync(entryOf('1.2.0'), 'changed')
    let asked = false
    const { d } = deps('exit0', { command: 'doctor', download: async () => (asked = true) })
    expect(await launch(['doctor'], d)).toBe(1)
    expect(asked).toBe(false)
  })
})

describe('restoreDbCopy', () => {
  it('puts the copy in place of the database and removes the journal files', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(db(), 'new')
    writeFileSync(db('mongo-manager.db-wal'), 'w')
    writeFileSync(db('mongo-manager.db-shm'), 's')
    writeFileSync(db('mongo-manager.db.before-1.2.0'), 'old')
    expect(restoreDbCopy(dataDir, 'mongo-manager.db.before-1.2.0')).toBe(true)
    expect(readFileSync(db(), 'utf8')).toBe('old')
    expect(existsSync(db('mongo-manager.db-wal'))).toBe(false)
    expect(existsSync(db('mongo-manager.db-shm'))).toBe(false)
    expect(restoreDbCopy(dataDir, 'mongo-manager.db.before-1.2.0')).toBe(false)
  })
})
