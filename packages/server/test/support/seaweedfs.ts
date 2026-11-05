// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pinnedDownload } from './mongo-tools'
import pins from './seaweedfs-pins.json'
import { isCI } from './slowness'

const CACHE = resolve(__dirname, '../../../../node_modules/.cache/seaweedfs')
const credentials = { accessKeyId: 'AKIAMMSEAWEED0001', secretAccessKey: 'mm-seaweed-secret-0001' }

/** Nothing to run here (no pin for this platform, no network for the download): offline runs skip. */
export class SeaweedUnavailable extends Error {}

async function sha256Of(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const c of createReadStream(path)) h.update(c as Buffer)
  return h.digest('hex')
}

/**
 * Phase 3d-3b final review D13: the pinned archive is what is cached, and its hash is checked against
 * the pin before every use; the binary is extracted from it afresh into the run's own folder, so a
 * cached file that was changed or damaged since its download is never run.
 */
export async function verifiedArchive(cache = CACHE): Promise<{ file: string; url: string }> {
  const key = `${process.platform}-${process.arch}` as keyof typeof pins.platforms
  const pin = pins.platforms[key]
  if (!pin) throw new SeaweedUnavailable(`no pinned SeaweedFS for ${key}`)
  const root = join(cache, pins.version)
  const download = pinnedDownload(pin.url, 'github.com', root)
  const file = download.file
  // Read once, no check first: a missing archive is downloaded; a damaged or altered one is never
  // used, and is downloaded again.
  let cached: string | null = null
  try {
    cached = await sha256Of(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (cached === pin.sha256) return { file, url: pin.url }
  let data: Buffer
  try {
    const res = await fetch(download.url)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    data = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    throw new SeaweedUnavailable((e as Error).message)
  }
  if (createHash('sha256').update(data).digest('hex') !== pin.sha256)
    throw new Error(`checksum mismatch for ${pin.url}`)
  // Whatever an older layout left here (an extracted binary) is not trusted.
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  // A fresh folder: anything already at this name was put there since, and is not overwritten.
  writeFileSync(file, data, { flag: 'wx' })
  return { file, url: pin.url }
}

/** The weed binary of the verified archive, extracted into `into`. */
export async function binary(into: string, cache = CACHE): Promise<string> {
  const { file } = await verifiedArchive(cache)
  // As test/support/mongo-tools.ts: Windows' own bsdtar by path reads the zip.
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  execFileSync(tar, ['-xf', file, '-C', into])
  const exe = join(into, process.platform === 'win32' ? 'weed.exe' : 'weed')
  if (!existsSync(exe)) throw new Error('the SeaweedFS archive had no weed binary')
  return exe
}

/** Ports handed out in this process (each with its gRPC companion, port + 10000). */
const handedOut = new Set<number>()

/**
 * A port whose gRPC companion (port + 10000) is free too, never one handed out before in this
 * process — the services' ports are taken by the child only later, so a probe alone could give the
 * same port to two of them (D13).
 */
export async function freePort(): Promise<number> {
  const free = (port: number) =>
    new Promise<boolean>((done) => {
      const s = createServer()
      s.once('error', () => done(false))
      s.listen(port, '127.0.0.1', () => s.close(() => done(true)))
    })
  for (let tries = 0; tries < 1000; tries++) {
    const port = 20_000 + Math.floor(Math.random() * 9_000)
    if ([port, port + 10_000].some((p) => handedOut.has(p))) continue
    if ((await free(port)) && (await free(port + 10_000))) {
      handedOut.add(port)
      handedOut.add(port + 10_000)
      return port
    }
  }
  throw new Error('no free port pair for SeaweedFS')
}

/**
 * Waits until `ready()` answers, failing loudly (D13) when the child exits first or the time runs
 * out — the tests never go on against a server that is not there.
 */
export async function waitReady(
  child: ChildProcess,
  ready: () => Promise<boolean>,
  opts: { timeoutMs: number; stepMs: number; stderr: () => string },
): Promise<void> {
  let exited: string | null = child.exitCode !== null ? `exited with code ${child.exitCode}` : null
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = signal ? `was killed by ${signal}` : `exited with code ${code}`
  }
  const onError = (e: Error) => {
    exited = `could not start: ${e.message}`
  }
  child.once('exit', onExit)
  child.once('error', onError)
  const tail = () => {
    const text = opts.stderr().trim()
    return text ? `\n${text}` : ''
  }
  try {
    const until = Date.now() + opts.timeoutMs
    for (;;) {
      if (exited) throw new Error(`SeaweedFS ${exited} before it was ready${tail()}`)
      if (await ready()) {
        if (exited) throw new Error(`SeaweedFS ${exited} before it was ready${tail()}`)
        return
      }
      if (Date.now() >= until)
        throw new Error(`SeaweedFS was not ready within ${Math.round(opts.timeoutMs / 1000)} s${tail()}`)
      await sleep(opts.stepMs)
    }
  } finally {
    child.off('exit', onExit)
    child.off('error', onError)
  }
}

const stopChild = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const gone = new Promise<void>((done) => child.once('exit', () => done()))
  child.kill()
  await Promise.race([gone, sleep(5_000)])
}

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'mm-seaweed-'))
  let child: ChildProcess | undefined
  try {
    mkdirSync(join(dir, 'bin'))
    const exe = await binary(join(dir, 'bin'))
    writeFileSync(
      join(dir, 's3.json'),
      JSON.stringify({
        identities: [
          {
            name: 'mm',
            // SeaweedFS's own field names.
            credentials: [{ accessKey: credentials.accessKeyId, secretKey: credentials.secretAccessKey }],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
        ],
      }),
    )
    const [master, volume, filer, s3] = [
      await freePort(),
      await freePort(),
      await freePort(),
      await freePort(),
    ]
    mkdirSync(join(dir, 'data'))
    child = spawn(
      exe,
      [
        'server',
        `-dir=${join(dir, 'data')}`,
        '-ip=127.0.0.1',
        `-master.port=${master}`,
        `-volume.port=${volume}`,
        '-filer',
        `-filer.port=${filer}`,
        '-s3',
        `-s3.port=${s3}`,
        `-s3.config=${join(dir, 's3.json')}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    )
    // The last few KiB of its log, for the message when it does not come up (always drained).
    let stderr = ''
    child.stderr!.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-4096)
    })
    const endpoint = `http://127.0.0.1:${s3}`
    await waitReady(
      child,
      () =>
        fetch(`${endpoint}/`, { signal: AbortSignal.timeout(5_000) }).then(
          () => true,
          () => false,
        ),
      { timeoutMs: 60_000, stepMs: 500, stderr: () => stderr },
    )
    const running = child
    return {
      endpoint,
      credentials,
      bucket: 'mm-interop',
      async stop() {
        await stopChild(running)
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      },
    }
  } catch (e) {
    if (child) await stopChild(child)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    throw e
  }
}

let found: Promise<Awaited<ReturnType<typeof start>> | null> | undefined
/**
 * Plan ruling 1: a real S3 for tests only. CI fails without it; offline runs (no pin, no download)
 * skip, saying so. A SeaweedFS that is there but does not start always fails (D13).
 */
export function seaweed() {
  found ??= start().catch((e: unknown) => {
    if (isCI() || !(e instanceof SeaweedUnavailable)) throw e
    console.warn(`[seaweedfs] real-S3 tests skipped: ${(e as Error).message}`)
    return null
  })
  return found
}
