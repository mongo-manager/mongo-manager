import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { parseConnectionUri } from '@mongo-manager/shared'
import { openLaunchLink, removeLaunchDir } from '../support'

// The bundle runs from a folder with no node_modules anywhere above it: nothing may be resolved at runtime.
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version
const here = mkdtempSync(join(tmpdir(), 'mm-bundle-'))
const cli = join(here, 'pkg', 'dist', 'cli.cjs')
let mongo: MongoMemoryServer
/** Every package a planted folder above the bundle could give it writes its name here when loaded. */
const loaded = join(here, 'loaded.txt')
let child: ChildProcess | undefined
/** The launch link's folder: a killed CLI cannot remove it. */
let launchDir: string | undefined

beforeAll(async () => {
  const pkg = join(import.meta.dirname, '..', '..')
  expect(existsSync(join(pkg, 'dist', 'cli.cjs'))).toBe(true)
  cpSync(join(pkg, 'dist'), join(here, 'pkg', 'dist'), { recursive: true })
  cpSync(join(pkg, 'public'), join(here, 'pkg', 'public'), { recursive: true })
  plantPackages()
  // CI 2026-10-20: on GitHub's Windows runner a first mongod took longer than its 10 s default.
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
})

/**
 * Security review 2026-10-20 (critical): Node looks for a package a bundle asks for by name in every
 * node_modules above it, and any user may make C:\node_modules, above the service's copy. Each name
 * either bundle asks for, and the optional add-ons, is planted there as a package that says it was
 * loaded; neither bundle may load one.
 */
function plantPackages(): void {
  const names = new Set([
    'bufferutil',
    'utf-8-validate',
    'supports-color',
    'source-map-support',
    'kerberos',
    'mongodb-client-encryption',
    'snappy',
    '@mongodb-js/zstd',
    '@aws-sdk/credential-providers',
    'gcp-metadata',
    'aws4',
    'socks',
    'electron',
  ])
  for (const bundle of ['cli.cjs', 'shell-worker.cjs']) {
    const code = readFileSync(join(here, 'pkg', 'dist', bundle), 'utf8')
    // Second review (minor 4): require.resolve too, and names in backticks.
    for (const m of code.matchAll(
      /\brequire(?:\.resolve)?\(\s*["'`]((?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*)["'`]\s*[,)]/g,
    ))
      if (!isBuiltin(m[1]!) && !m[1]!.startsWith('.')) names.add(m[1]!)
  }
  for (const name of names) {
    const dir = join(here, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'index.js'),
      `require('node:fs').appendFileSync(${JSON.stringify(loaded)}, ${JSON.stringify(name + '\n')})\n`,
    )
  }
}
const plantedLoaded = () =>
  existsSync(loaded) ? readFileSync(loaded, 'utf8').split('\n').filter(Boolean) : []
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

const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: here, encoding: 'utf8' })

describe('the bundled CLI (Review Focus 4)', () => {
  // Plan 1c deferred minor: the SSH tunnel's endpoint is a SOCKS5 proxy, which the driver reaches
  // through the socks package; standing it in as missing would break every SSH connection.
  it('bundles the SOCKS5 client the driver reaches an SSH tunnel with', () => {
    const bundle = readFileSync(cli, 'utf8')
    expect(bundle).not.toMatch(/Optional module not bundled: socks\b/)
    // The package itself, not only the driver's call into it.
    expect(bundle).toMatch(/class SocksClient\b/)
  })

  it('answers version, help and usage errors', () => {
    // The package's own version, never a number written here (CI 2026-11-01).
    expect(run('version').stdout.split(' ').slice(0, 2).join(' ')).toBe(`mongo-manager ${PACKAGE_VERSION}`)
    expect(run('--help').status).toBe(0)
    expect(run('--nope').status).toBe(2)
    // Review of the SEA fix 2026-10-20 (minor 6): the standalone binary's worker subcommand, here,
    // says what it is instead of failing with a stack trace.
    const worker = run('__mm-shell-worker')
    expect({ status: worker.status, stderr: worker.stderr.trim() }).toEqual({
      status: 2,
      stderr: 'Error: __mm-shell-worker is run by the standalone binary only.',
    })
    expect(plantedLoaded()).toEqual([])
  })

  // Reviews of the SEA fix 2026-10-20 (third, minor 2; fourth, minor 1 and 2): Node writes the CLI's
  // warnings itself, with their code and detail and as its flags say; only the passkey library's Web
  // Crypto notices are left out, and an odd warning ends nothing.
  it("writes warnings as Node does, Node's flags included", () => {
    const warn = join(here, 'warn.cjs')
    writeFileSync(
      warn,
      [
        "process.emitWarning('old', { type: 'DeprecationWarning', code: 'DEP9999', detail: 'Use x.' })",
        "process.emitWarning('The Web Crypto thing is experimental', 'ExperimentalWarning')",
        "const odd = new Error('odd one'); odd.name = 'OddWarning'; odd.toString = null",
        'process.emitWarning(odd)',
        // Fifth review (minor 1): a listener of the user's own stays as it was added.
        "let once = 0; process.once('warning', () => once++)",
        "process.on('exit', () => process.stderr.write(`once: ${once}\\n`))",
      ].join('\n'),
    )
    // Node's own warning settings in this environment would change what it writes (fifth review,
    // minor 2).
    const env = { ...process.env, NODE_OPTIONS: undefined, NODE_NO_WARNINGS: undefined }
    const cliWith = (...flags: string[]) =>
      spawnSync(process.execPath, [...flags, '--require', warn, cli, 'version'], {
        cwd: here,
        encoding: 'utf8',
        env,
      })
    const warned = cliWith()
    expect(warned.status, warned.stderr).toBe(0)
    expect(warned.stderr).toMatch(/\(node:\d+\) \[DEP9999\] DeprecationWarning: old\r?\nUse x\./)
    expect(warned.stderr).toMatch(/OddWarning: odd one/)
    expect(warned.stderr).not.toMatch(/Web Crypto/)
    expect(warned.stderr).toMatch(/once: 1\r?\n/)
    const quiet = cliWith('--no-warnings')
    expect({ status: quiet.status, stderr: quiet.stderr }).toEqual({ status: 0, stderr: 'once: 1\n' })
  })

  it('loads no package planted above the shell worker, even outside its sandbox', () => {
    const worker = join(here, 'pkg', 'dist', 'shell-worker.cjs')
    const r = spawnSync(process.execPath, [worker], {
      cwd: here,
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    })
    expect(r.error).toBeUndefined()
    // It got as far as its sandbox check (second review, minor 4): everything it loads first.
    expect(r.status, r.stderr).toBe(78)
    expect(r.stderr).toMatch(/refusing to run without the sandbox/)
    expect(plantedLoaded()).toEqual([])
  })

  it('serves the web app and reaches MongoDB through the bundled driver', async () => {
    child = spawn(
      process.execPath,
      [cli, 'start', '--web-port', '0', '--data-dir', join(here, 'data'), '--no-open', '--log-level', 'warn'],
      { cwd: here },
    )
    let err = ''
    const [url, file] = await new Promise<[string, string]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no URL in: ${err}`)), 60_000)
      child!.stderr!.on('data', (d: Buffer) => {
        err += d.toString()
        const m = /running at (\S+)[\s\S]*?Open it from this file[^:]*: (.+?)\r?\n/.exec(err)
        if (m) {
          clearTimeout(timer)
          resolve([m[1]!, m[2]!])
        }
      })
    })
    // Known at once, so a failing run still removes it (a killed CLI cannot).
    launchDir = dirname(file)
    expect(err).not.toMatch(/ExperimentalWarning/)
    const index = await fetch(url)
    expect(await index.text()).toContain('<base href="/"')
    // CI 2026-10-18: local mode answers only a browser that opened the launch link it printed.
    const { headers: browser, csrfToken } = await openLaunchLink(url, file)
    const test = await fetch(new URL('api/connections/test', url), {
      method: 'POST',
      headers: { ...browser, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ settings: parseConnectionUri(mongo.getUri()) }),
    })
    const result = (await test.json()) as { ok: boolean }
    expect(result.ok).toBe(true)

    // MONGODB-AWS through the bundled driver and its AWS SDK stand-in: the connection's keys reach
    // the server (which has no AWS sign-in and says so), never "a package is missing".
    const aws = await fetch(new URL('api/connections/test', url), {
      method: 'POST',
      headers: { ...browser, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({
        settings: {
          ...parseConnectionUri(mongo.getUri()),
          auth: { mechanism: 'MONGODB-AWS', username: 'AKIAEXAMPLE', password: 'secret' },
        },
      }),
    })
    const signIn = JSON.stringify(await aws.json())
    expect(signIn).not.toMatch(/Optional module|not installed|cannot be provided/i)
    expect(signIn).toMatch(/MONGODB-AWS|mechanism/i)

    // Phase 1h: the bundled ws answers the real-time handshake (Node's WebSocket may set Origin).
    const socket = new WebSocket(new URL('ws', url.replace(/^http/, 'ws')), {
      headers: { origin: browser.origin, cookie: browser.cookie },
    } as unknown as string[])
    const first = await new Promise<string>((resolve, reject) => {
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', csrf: csrfToken })))
      socket.addEventListener('message', (e) => resolve(String(e.data)))
      socket.addEventListener('error', () => reject(new Error('socket error')))
      socket.addEventListener('close', (e) => reject(new Error(`closed ${e.code}`)))
    })
    socket.close()
    expect(JSON.parse(first)).toEqual({ type: 'ready' })
    expect(plantedLoaded()).toEqual([])
  })
})
