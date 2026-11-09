// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILE_NAME, readUpdateState, verifyVersionDir, writeUpdateState } from '@mongo-manager/shared'
import { DB_FILE } from '../src/store/db'
import { downloadVersion } from '../src/updates/install'
import { UpdateService, type UpdateServiceDeps } from '../src/updates/service'
import { fakeGithub, signedRelease, testKey, type Answer } from './support/updates'

const key = testKey()
let dataDir: string
let appDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mm-install-'))
  appDir = join(dataDir, 'app')
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const download = (
  answers: Record<string, Answer>,
  over: Partial<Parameters<typeof downloadVersion>[0]> = {},
) =>
  downloadVersion({
    egress: fakeGithub(answers).egress,
    dataDir,
    version: '1.3.0',
    kind: 'package',
    target: null,
    keys: [key.pub],
    ...over,
  })
const leftovers = () =>
  existsSync(appDir) ? readdirSync(appDir).filter((n) => n.startsWith('.incoming-')) : []

describe('downloading a version (spec §5.2)', () => {
  it('stages a release whose every file verifies', async () => {
    const dir = await download(signedRelease(key, '1.3.0').answers)
    expect(dir).toBe(join(appDir, '1.3.0'))
    expect(verifyVersionDir(dir, { kind: 'package', keys: [key.pub] }).ok).toBe(true)
    expect(leftovers()).toEqual([])
  })

  it('stages the standalone binary of its target, runnable (final review, C2)', async () => {
    const dir = await download(signedRelease(key, '1.3.0').answers, {
      kind: 'standalone',
      target: 'linux-x64',
    })
    if (process.platform !== 'win32')
      expect(statSync(join(dir, 'mongo-manager-1.3.0-linux-x64')).mode & 0o777).toBe(0o700)
    expect(verifyVersionDir(dir, { kind: 'standalone', target: 'linux-x64', keys: [key.pub] }).ok).toBe(true)
  })

  it('refuses an asset whose digest is not the signed one, before reading it, leaving nothing', async () => {
    const r = signedRelease(key, '1.3.0')
    const other = signedRelease(key, '1.3.0', { files: { 'dist/cli.cjs': 'evil()' } })
    const answers = {
      ...r.answers,
      [r.url('mongo-manager-1.3.0.tgz')]: other.answers[other.url('mongo-manager-1.3.0.tgz')]!,
    }
    await expect(download(answers)).rejects.toMatchObject({
      details: { reason: 'update_failed', detail: 'digest' },
    })
    expect(existsSync(join(appDir, '1.3.0'))).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('never unpacks an asset before its digest matches (the archive reader sees only signed bytes)', async () => {
    const r = signedRelease(key, '1.3.0')
    const answers = {
      ...r.answers,
      [r.url('mongo-manager-1.3.0.tgz')]: { status: 200, body: Buffer.from('not a gzip at all') },
    }
    await expect(download(answers)).rejects.toMatchObject({ details: { detail: 'digest' } })
  })

  it('cleans up after a download cut half-way (Review Focus 1)', async () => {
    const r = signedRelease(key, '1.3.0')
    const name = 'mongo-manager-1.3.0.tgz'
    const answers = {
      ...r.answers,
      [r.url(name)]: { status: 200, body: r.bodies[name]!, cut: true as const },
    }
    await expect(download(answers)).rejects.toMatchObject({ details: { reason: 'update_failed' } })
    expect(leftovers()).toEqual([])
    expect(existsSync(join(appDir, '1.3.0'))).toBe(false)
  })

  it('refuses a package with a path out of package/, or without package/', async () => {
    for (const files of [{ '../../x': 'x', 'dist/cli.cjs': 'x' }]) {
      await expect(download(signedRelease(key, '1.3.0', { files }).answers)).rejects.toMatchObject({
        details: { reason: 'update_failed' },
      })
      expect(leftovers()).toEqual([])
    }
  })

  it('refuses what a release key did not sign', async () => {
    await expect(download(signedRelease(key, '1.3.0', { signer: testKey() }).answers)).rejects.toMatchObject({
      details: { detail: 'signature' },
    })
  })

  it('keeps a version already there that verifies, and replaces one that does not', async () => {
    const answers = signedRelease(key, '1.3.0').answers
    const dir = await download(answers)
    rmSync(join(dir, 'package', 'package.json'))
    await download(answers)
    expect(verifyVersionDir(dir, { kind: 'package', keys: [key.pub] }).ok).toBe(true)
  })
})

describe('installing from the panel', () => {
  function service(answers: Record<string, Answer>, over: Partial<UpdateServiceDeps> = {}) {
    mkdirSync(dataDir, { recursive: true })
    const db = new DatabaseSync(join(dataDir, DB_FILE))
    db.exec('PRAGMA user_version = 7; CREATE TABLE t (x); INSERT INTO t VALUES (1)')
    const map = new Map<string, unknown>()
    const restarts: number[] = []
    const announced: string[] = []
    let jobs = 0
    const s = new UpdateService({
      settings: {
        get: (k, schema, fallback) =>
          map.has(k) ? (schema.safeParse(map.get(k)).data ?? fallback) : fallback,
        set: (k, v) => void map.set(k, JSON.parse(JSON.stringify(v))),
      },
      egress: fakeGithub(answers).egress,
      enabled: true,
      keys: [key.pub],
      now: () => Date.now(),
      dataDir,
      installed: '1.2.0',
      origin: {
        distribution: 'bundle',
        bundledVersion: '1.2.0',
        installDir: '/opt/x/dist',
        target: null,
        isolate: false,
      },
      fallbackDistribution: 'npm',
      env: {},
      nodeVersion: '24.0.0',
      db,
      restart: () => restarts.push(Date.now()),
      runningJobs: () => jobs,
      restartDelayMs: 0,
      ...over,
    })
    s.onRestarting((v) => announced.push(v))
    return { s, db, restarts, announced, setJobs: (n: number) => (jobs = n) }
  }

  it('downloads, copies the database, marks the version pending and restarts', async () => {
    const { s, db, restarts, announced } = service(signedRelease(key, '1.3.0').answers)
    await s.check()
    s.install('1.3.0', false)
    await s.installing
    const copy = join(dataDir, 'mongo-manager.db.before-1.3.0')
    expect(existsSync(copy)).toBe(true)
    const copied = new DatabaseSync(copy)
    expect((copied.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7)
    copied.close()
    expect(readUpdateState(appDir).pending).toEqual({
      version: '1.3.0',
      from: null,
      dbCopy: 'mongo-manager.db.before-1.3.0',
    })
    expect(restarts).toHaveLength(1)
    expect(announced).toEqual(['1.3.0'])
    expect(s.status(true).progress).toEqual({ phase: 'restarting' })
    db.close()
  })

  it('names the version it runs from when that one was downloaded too, and forgets an earlier failure', async () => {
    writeUpdateState(appDir, { schema: 1, settled: '1.2.0', pending: null, failed: ['1.3.0'] })
    const { s, db } = service(signedRelease(key, '1.3.0').answers, {
      origin: {
        distribution: 'bundle',
        bundledVersion: '1.1.0',
        installDir: '/opt/x/dist',
        target: null,
        isolate: false,
      },
    })
    await s.check()
    s.install('1.3.0', false)
    await s.installing
    expect(readUpdateState(appDir)).toMatchObject({ pending: { from: '1.2.0' }, failed: [] })
    db.close()
  })

  it('asks first while jobs run, then installs', async () => {
    const { s, db, setJobs, restarts } = service(signedRelease(key, '1.3.0').answers)
    await s.check()
    setJobs(1)
    expect(() => s.install('1.3.0', false)).toThrow(
      expect.objectContaining({ statusCode: 409, details: { reason: 'update_jobs', jobs: 1 } }),
    )
    s.install('1.3.0', true)
    await s.installing
    expect(restarts).toHaveLength(1)
    db.close()
  })

  it('refuses a version that is not the one offered, one at a time, and with nothing to offer', async () => {
    const { s, db } = service(signedRelease(key, '1.3.0').answers)
    expect(() => s.install('1.3.0', false)).toThrow(
      expect.objectContaining({ details: { reason: 'update_unavailable' } }),
    )
    await s.check()
    expect(() => s.install('1.4.0', false)).toThrow(
      expect.objectContaining({ details: { reason: 'update_changed' } }),
    )
    s.install('1.3.0', false)
    expect(() => s.install('1.3.0', false)).toThrow(
      expect.objectContaining({ details: { reason: 'update_running' } }),
    )
    await s.installing
    db.close()
  })

  it('says why an install failed, restarting nothing', async () => {
    const r = signedRelease(key, '1.3.0')
    const answers = { ...r.answers, [r.url('mongo-manager-1.3.0.tgz')]: { status: 404, body: {} } }
    const { s, db, restarts } = service(answers)
    await s.check()
    s.install('1.3.0', false)
    await s.installing
    expect(restarts).toHaveLength(0)
    expect(s.status(true)).toMatchObject({ progress: null, installFailure: { reason: 'unreachable' } })
    expect(existsSync(join(dataDir, 'mongo-manager.db.before-1.3.0'))).toBe(false)
    expect(readUpdateState(appDir).pending).toBeNull()
    db.close()
  })

  it('the launcher names the database file as the server does', () => {
    expect(DB_FILE_NAME).toBe(DB_FILE)
  })
})
