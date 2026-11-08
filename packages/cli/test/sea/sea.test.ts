// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { parseConnectionUri } from '@mongo-manager/shared'
// Only the server's spawn helpers: the whole server would load the passkey library here (second
// review of the SEA fix 2026-10-20, minor 5).
import {
  supportsNetPermission,
  workerArgs,
  workerCommandArgs,
  workerEnv,
} from '../../../server/src/shell/spawn'
import { powershellArgs, powershellEnv, windowsTool } from '../../../server/src/windows-tools'
import { openLaunchLink, removeLaunchDir } from '../support'

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version

// The standalone binary runs alone in an empty folder with no Node on PATH (Review Focus 2).
const exe = process.platform === 'win32' ? 'mongo-manager.exe' : 'mongo-manager'
const here = mkdtempSync(join(tmpdir(), 'mm-sea-'))
const binary = join(here, 'bin', exe)
const emptyPath = join(here, 'empty')
let mongo: MongoMemoryServer
let child: ChildProcess | undefined
/** The launch link's folder: a killed binary cannot remove it. */
let launchDir: string | undefined

/** Only what the OS itself needs; no PATH to any Node, no NODE_OPTIONS. */
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']
  const env: NodeJS.ProcessEnv = { PATH: emptyPath }
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]
  return { ...env, ...extra }
}

/** What the start's Windows PowerShell script does: the cmdlets and types it loads, run as it is run. */
const probe =
  '$null = New-Object System.Security.AccessControl.DirectorySecurity; ' +
  '$null = Test-Path -LiteralPath $env:TEMP; $null = Get-Acl -LiteralPath $env:TEMP; ' +
  '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'

/** Windows PowerShell running the probe in `env`: how long it took, and why, when it did not succeed. */
function timePowerShell(env: NodeJS.ProcessEnv): { took: number; ok: boolean; said: string } {
  const t0 = Date.now()
  const ps = spawnSync(windowsTool('powershell'), powershellArgs(probe), {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: 30_000,
  })
  const took = Date.now() - t0
  const why =
    ps.status === 0
      ? ''
      : `: ${[ps.error?.message ?? ps.signal, (ps.stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)].filter(Boolean).join(' ')}`
  return { took, ok: ps.status === 0, said: `${took} ms, exit ${ps.status}${why}` }
}

/** The processes a process started, with since when and how: what a start that does not come waits on. */
function childrenOf(pid: number): string {
  const windows = process.platform === 'win32'
  const res = windows
    ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name) since $($_.CreationDate) $($_.CommandLine)" }`,
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      )
    : spawnSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,args='], { encoding: 'utf8', timeout: 30_000 })
  if (res.error) return `not listed: ${res.error.message}`
  // Review of the CI fix 2026-10-21 (minor 2): a listing that failed says so, never "none".
  if (res.status !== 0) return `not listed (exit ${res.status}): ${res.stderr.trim().slice(0, 300)}`
  const lines = res.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim() && (windows || l.trim().split(/\s+/)[1] === String(pid)))
    .map((l) => l.slice(0, 300))
  return lines.join('\n') || 'none'
}

beforeAll(async () => {
  const built = join(import.meta.dirname, '..', '..', 'dist', 'sea', exe)
  expect(existsSync(built), 'run "pnpm --filter @mongo-manager/app build:sea" first').toBe(true)
  mkdirSync(join(here, 'bin'))
  mkdirSync(emptyPath)
  copyFileSync(built, binary)
  // CI 2026-10-20: on GitHub's Windows runner a first mongod took longer than its 10 s default.
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
})
afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child!.once('exit', resolve))
    child.kill()
    await exited
  }
  await mongo?.stop()
  rmSync(here, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  removeLaunchDir(launchDir)
})

describe('the standalone binary (Review Focus 2)', () => {
  it('answers version and ignores NODE_OPTIONS', () => {
    const evil = join(here, 'evil.cjs')
    const res = spawnSync(binary, ['version'], {
      cwd: here,
      encoding: 'utf8',
      env: bareEnv({ NODE_OPTIONS: `--require ${JSON.stringify(evil)}` }),
    })
    expect(res.stderr).toBe('')
    // The package's own version, never a number written here (CI 2026-11-01: 2.x outlived 1.0.0).
    expect(res.stdout.split(' ').slice(0, 2).join(' ')).toBe(`mongo-manager ${PACKAGE_VERSION}`)
    expect(res.status).toBe(0)
  })

  it('doctor reports the embedded web app', () => {
    const res = spawnSync(binary, ['doctor', '--data-dir', join(here, 'doctor')], {
      cwd: here,
      encoding: 'utf8',
      env: bareEnv(),
    })
    expect(res.stdout).toMatch(/\[ok\] Web app: embedded in the standalone binary/)
  })

  // CI 2026-10-21 (Windows): the start made its data directory (by Windows PowerShell) only after 60 s,
  // where `version` takes 0.4 s. Windows PowerShell on its own, doing what that script does (the
  // cmdlets it loads), in the environment the binary gives it, then a whole one, then that one again:
  // a slow first run alone is PowerShell's cold start, a slow third the environment. Run before the
  // binary's start, which then finds PowerShell warm (review of the timing, important 1, 2; minor 1, 2).
  // The bare one took 25 to 30 s: Windows PowerShell looked through every module for a cmdlet,
  // without the cache GitHub's runner names in PSModuleAnalysisCachePath; now it looks for none
  // (powershellArgs), and the bare one warm takes no more than 10 s (review of the module imports,
  // minor 4).
  it.skipIf(process.platform !== 'win32')(
    'times Windows PowerShell on its own',
    () => {
      const runs = (
        [
          ['bare environment', powershellEnv({}, bareEnv())],
          ['whole environment', powershellEnv()],
          ['bare environment, again', powershellEnv({}, bareEnv())],
        ] as const
      ).map(([name, env]) => {
        const run = timePowerShell(env)
        console.log(`sea: Windows PowerShell (${name}) took ${run.said} (the start below finds it warm)`)
        return run
      })
      for (const run of runs) expect(run.ok, run.said).toBe(true)
      expect(runs[2]!.took, runs[2]!.said).toBeLessThan(10_000)
    },
    120_000,
  )

  // CI 2026-10-21 (Windows): no URL within 60 s, nothing said why, where a passing run on that runner
  // took 37 to 56 s in all (1 s on Linux, 4 s on a Windows desktop). Its own bound, and a start that
  // does not come says how far it got.
  it('serves the embedded web app and reaches MongoDB, writing nothing next to itself', async () => {
    const data = join(here, 'data')
    const started = Date.now()
    child = spawn(
      binary,
      ['start', '--web-port', '0', '--data-dir', data, '--no-open', '--log-level', 'warn'],
      {
        cwd: here,
        env: bareEnv(),
      },
    )
    let err = ''
    let out = ''
    // Read, so a full pipe never holds the binary back.
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    // CI 2026-10-21: on GitHub's Windows runner the start took 41 s (0.4 s for `version`). Its data
    // directory is made first (by PowerShell, on Windows): when it appears splits the time. What comes
    // before it is the binary's own start and PowerShell's together; a start that does not come lists
    // when its PowerShell started.
    let madeAt: number | undefined
    const looking = setInterval(() => {
      if (madeAt === undefined && existsSync(data)) madeAt = Date.now() - started
    }, 50)
    const whereItIs = () =>
      [
        `after ${Date.now() - started} ms; exit: ${child!.exitCode ?? child!.signalCode ?? 'still running'}`,
        `data directory: ${existsSync(data) ? `${JSON.stringify(readdirSync(data))}, made after ${madeAt ?? '?'} ms` : 'not made'}`,
        `its processes:\n${child!.pid === undefined ? 'none (not started)' : childrenOf(child!.pid)}`,
        `stdout:\n${out}`,
        `stderr:\n${err}`,
      ].join('\n')
    const [url, file] = await new Promise<[string, string]>((resolve, reject) => {
      // Review of the CI fix 2026-10-21: said once, while still waited for (minor 1); on 'close',
      // after its output was read to the end ('exit' came before its last words, important 1); a
      // binary that could not be started says why too (minor 2).
      let waiting = true
      const fail = (what: string) => {
        if (!waiting) return
        waiting = false
        clearTimeout(timer)
        clearInterval(looking)
        reject(new Error(`${what} ${whereItIs()}`))
      }
      const timer = setTimeout(() => fail('no URL'), 180_000)
      child!.once('close', () => fail('exited before its URL'))
      child!.on('error', (e) => fail(`could not be started (${e.message})`))
      child!.stderr!.on('data', (d: Buffer) => {
        err += d.toString()
        const m = /running at (\S+)[\s\S]*?Open it from this file[^:]*: (.+?)\r?\n/.exec(err)
        if (m && waiting) {
          waiting = false
          clearTimeout(timer)
          resolve([m[1]!, m[2]!])
        }
      })
    })
    // Known at once, so a failing run still removes it (a killed binary cannot).
    launchDir = dirname(file)
    clearInterval(looking)
    // What each step took, in a passing run too: where the time goes on a slow runner.
    console.log(
      `sea: data directory made after ${madeAt ?? '?'} ms, running after ${Date.now() - started} ms`,
    )
    expect(err).not.toMatch(/Warning/)
    expect((await fetch(new URL('healthz', url))).status).toBe(200)
    const html = await (await fetch(url)).text()
    expect(html).toContain('<base href="/"')
    const script = /src="\.?\/?(assets\/[^"]+\.js)"/.exec(html)![1]!
    const asset = await fetch(new URL(script, url))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    // CI 2026-10-19: local mode answers only a browser that opened the launch link it printed.
    const browser = await openLaunchLink(url, file)
    const test = await fetch(new URL('api/connections/test', url), {
      method: 'POST',
      headers: { ...browser.headers, 'content-type': 'application/json', 'x-csrf-token': browser.csrfToken },
      body: JSON.stringify({ settings: parseConnectionUri(mongo.getUri()) }),
    })
    // The whole answer, so a refusal says why.
    expect({ status: test.status, body: await test.json() }).toMatchObject({
      status: 200,
      body: { ok: true },
    })
    // 2026-11-01: the binary's own plugins are there (it had none): written into the data directory,
    // listed for approval like any bundled plugin.
    const managed = await fetch(new URL('api/plugins/manage', url), { headers: browser.headers })
    const list = (await managed.json()) as { plugins: Array<{ id: string; source: string }> }
    expect(managed.status, JSON.stringify(list)).toBe(200)
    expect(list.plugins.map((p) => p.id)).toEqual(
      expect.arrayContaining(['charts', 'geojson-map', 'sql-to-mongodb']),
    )
    expect(readdirSync(join(data, 'bundled-plugins'))).toEqual([PACKAGE_VERSION])
    // Review of the CI fix 2026-10-20: the advanced shell starts, its worker being this binary run
    // again inside the sandbox, and evaluates.
    const saved = await fetch(new URL('api/connections', url), {
      method: 'POST',
      headers: { ...browser.headers, 'content-type': 'application/json', 'x-csrf-token': browser.csrfToken },
      body: JSON.stringify({ name: 'SEA', settings: parseConnectionUri(mongo.getUri()) }),
    })
    const created = (await saved.json()) as { id: string }
    expect(saved.status, JSON.stringify(created)).toBe(200)
    const socket = new WebSocket(new URL('ws', url.replace(/^http/, 'ws')), {
      headers: { origin: browser.headers.origin, cookie: browser.headers.cookie },
    } as unknown as string[])
    const seen: Array<{ ch?: string; type: string; payload?: Record<string, unknown> }> = []
    // A failure, an error or a closed session ends the wait at once, saying what came (review of
    // the SEA fix 2026-10-20, minor 3); the server gives a shell 20 s to start.
    const next = (type: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const ends = (s: { type: string }) => ['failed', 'error', 'closed'].includes(s.type)
        const check = () => {
          const m = seen.find((s) => s.type === type || ends(s))
          if (!m) return false
          clearTimeout(timer)
          socket.removeEventListener('message', check)
          seen.splice(seen.indexOf(m), 1)
          if (m.type !== type) reject(new Error(JSON.stringify(m)))
          else resolve(m.payload ?? {})
          return true
        }
        const timer = setTimeout(() => {
          socket.removeEventListener('message', check)
          reject(new Error(`no ${type} in ${JSON.stringify(seen)}`))
        }, 30_000)
        if (!check()) socket.addEventListener('message', check)
      })
    socket.addEventListener('message', (e) => seen.push(JSON.parse(String(e.data))))
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('socket error')))
    })
    try {
      socket.send(JSON.stringify({ type: 'hello', csrf: browser.csrfToken }))
      await next('ready')
      socket.send(JSON.stringify({ ch: 'shell', type: 'open', connectionId: created.id, db: 'test' }))
      const { sessionId } = (await next('opened')) as { sessionId: string }
      socket.send(JSON.stringify({ ch: 'shell', type: 'eval', sessionId, id: 1, code: '1+1' }))
      expect(await next('result')).toMatchObject({ value: { $numberInt: '2' } })
      console.log(`sea: the shell answered after ${Date.now() - started} ms`)
    } finally {
      socket.close()
    }
    // The web app is served from memory: nothing was extracted beside the binary.
    expect(readdirSync(join(here, 'bin'))).toEqual([exe])
  }, 300_000)

  it('carries the shell worker as an asset that refuses to run outside its sandbox (phase 3a-1)', () => {
    // The binary re-runs itself as __mm-shell-worker; run by hand (no --permission) it must exit 78
    // (EXIT_NO_SANDBOX), proving the embedded asset loads and the sandbox self-check fires.
    const res = spawnSync(binary, ['__mm-shell-worker'], { cwd: here, encoding: 'utf8', env: bareEnv() })
    expect(res.status).toBe(78)
    expect(res.stderr).toContain('refusing to run without the sandbox')
  })

  // Review of the CI fix 2026-10-20: inside its sandbox, as the server starts it, the worker runs
  // only its own code: nothing of the CLI is loaded (which wrote warnings and took memory there).
  it('runs the shell worker in its sandbox with nothing of the CLI loaded', () => {
    // The command line and environment the server gives it (review of the SEA fix 2026-10-20, minor 2).
    const flags = workerArgs(null, { netPermission: supportsNetPermission() })
    const res = spawnSync(binary, workerCommandArgs(flags, '', ['__mm-shell-worker'], { sea: true }), {
      cwd: here,
      encoding: 'utf8',
      env: workerEnv(),
      input: '',
    })
    expect({ status: res.status, stderr: res.stderr }).toEqual({ status: 0, stderr: '' })
  })
})
