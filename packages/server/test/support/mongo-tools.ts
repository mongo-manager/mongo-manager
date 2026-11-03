import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import pins from './mongo-tools-pins.json'
import { isCI } from './slowness'

export interface Tools {
  dump: string
  restore: string
  version: string
}

const CACHE = resolve(__dirname, '../../../../node_modules/.cache/mongo-tools')
let found: Promise<Tools | null> | undefined

function binDir(root: string): string | null {
  if (!existsSync(root)) return null
  for (const name of readdirSync(root)) {
    const bin = join(root, name, 'bin')
    if (existsSync(bin)) return bin
  }
  return null
}

/**
 * A pinned download, checked before anything is fetched or written: HTTPS to the one host it is
 * pinned to, no query or fragment, and a plain file name (no separator, no leading dot) — the only
 * part of it that names a file, which stays inside `root`. The data is checked against the pin's
 * hash before it is written.
 */
export function pinnedDownload(url: string, host: string, root: string): { url: URL; file: string } {
  const u = new URL(url)
  const name = u.pathname.split('/').pop() ?? ''
  if (
    u.protocol !== 'https:' ||
    u.hostname !== host ||
    u.port !== '' ||
    u.username !== '' ||
    u.password !== '' ||
    u.search !== '' ||
    u.hash !== '' ||
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(name)
  )
    throw new Error(`not a pinned download: ${url}`)
  const file = join(root, name)
  if (relative(root, file) !== name) throw new Error(`not a pinned download: ${url}`)
  return { url: u, file }
}

async function fetchTools(): Promise<Tools | null> {
  const key = `${process.platform}-${process.arch}` as keyof typeof pins.platforms
  const pin = pins.platforms[key]
  if (!pin) throw new Error(`no pinned tools for ${key}`)
  const root = join(CACHE, pins.version)
  const download = pinnedDownload(pin.url, 'fastdl.mongodb.org', root)
  const exe = process.platform === 'win32' ? '.exe' : ''
  let bin = binDir(root)
  if (!bin) {
    const res = await fetch(download.url)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    const data = Buffer.from(await res.arrayBuffer())
    const sum = createHash('sha256').update(data).digest('hex')
    if (sum !== pin.sha256) throw new Error(`checksum mismatch for ${pin.url}`)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    const file = download.file
    // A fresh folder: anything already at this name was put there since, and is not overwritten.
    writeFileSync(file, data, { flag: 'wx' })
    // bsdtar (Windows 10+, macOS) reads zip and tgz; GNU tar reads the Linux tgz. On Windows the
    // system's own bsdtar, by path: a Git Bash PATH finds GNU tar first, which reads no zip.
    const tar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
    execFileSync(tar, ['-xf', file, '-C', root])
    rmSync(file)
    bin = binDir(root)
    if (!bin) throw new Error('the tools archive had no bin directory')
  }
  return {
    dump: join(bin, `mongodump${exe}`),
    restore: join(bin, `mongorestore${exe}`),
    version: pins.version,
  }
}

/**
 * Plan ruling 11: the pinned mongodb-database-tools for interoperability tests (B20), for tests
 * only. In CI a failure fails; elsewhere (no network) the dependent tests skip, and this says so.
 */
export function mongoTools(): Promise<Tools | null> {
  found ??= fetchTools().catch((e: unknown) => {
    if (isCI()) throw e
    console.warn(`[mongo-tools] interoperability tests skipped: ${(e as Error).message}`)
    return null
  })
  return found
}

export const fixturesDir = resolve(__dirname, '../fixtures/backup')
export const fixture = (name: string): Buffer => readFileSync(join(fixturesDir, name))
