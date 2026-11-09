// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
  type BigIntStats,
  type RmOptions,
} from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import {
  INFO_ASSET,
  ReleaseInfoSchema,
  SIGNATURE_ASSET,
  SUMS_ASSET,
  assetNames,
  type ReleaseInfo,
} from './release'
import { parseSums, verifySums } from './sums'
import { readTar } from './tar'
import { parseReleaseVersion } from './version'

/**
 * The data directory's `app/` folder (2026-11-03): one folder per downloaded version, each checked
 * in full against its signed SHA256SUMS before it runs, at every start — unsigned code never runs.
 */
export type VersionKind = 'package' | 'standalone'
export type VerifyFailure = 'signature' | 'sums' | 'info' | 'digest' | 'files' | 'missing'
export type VerifiedVersion = { ok: true; version: string; info: ReleaseInfo; entry: string }

export const PACKAGE_ASSET = 'package.tgz'
const PACKAGE_DIR = 'package'
const ENTRY = ['dist', 'cli.cjs']
/** Limits of a release's package, unpacked. */
export const PACKAGE_MAX_BYTES = 400 * 1024 * 1024
export const PACKAGE_MAX_FILES = 20_000
const SMALL = 64 * 1024

// O_NOFOLLOW: a link put in place of a file is refused at open, not followed.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** A regular file's bytes, read through the descriptor it was checked by; null for anything else. */
function readRegular(path: string, max: number, looked?: BigIntStats): Buffer | null {
  let fd: number
  try {
    fd = openSync(path, OPEN_FLAGS)
  } catch {
    return null
  }
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.size > BigInt(max)) return null
    if (looked && (opened.ino !== looked.ino || opened.dev !== looked.dev)) return null
    const data = Buffer.alloc(Number(opened.size))
    for (let at = 0; at < data.length;) {
      const n = readSync(fd, data, at, data.length - at, at)
      if (n === 0) return null
      at += n
    }
    return data
  } finally {
    closeSync(fd)
  }
}

/** A regular file's sha256, read in pieces; null for anything else. */
function hashRegular(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, OPEN_FLAGS)
  } catch {
    return null
  }
  try {
    if (!fstatSync(fd).isFile()) return null
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(1024 * 1024)
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null)
      if (n === 0) break
      hash.update(chunk.subarray(0, n))
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/**
 * What a file browser leaves in a folder it shows (Finder, Explorer): never part of a version, never
 * loaded or run, so not a reason to call it damaged (final review, minor).
 */
const CLUTTER = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const clutter = (name: string) => CLUTTER.has(name.toLowerCase())

/** The names a folder holds, or null when it is not a real folder. */
function namesIn(dir: string): string[] | null {
  try {
    return lstatSync(dir).isDirectory() ? readdirSync(dir) : null
  } catch {
    return null
  }
}

/** Whether a folder holds exactly these files, byte for byte, with no link and nothing else. */
function holdsExactly(dir: string, files: ReadonlyMap<string, Buffer>): boolean {
  let seen = 0
  const walk = (at: string, prefix: string): boolean => {
    for (const entry of readdirSync(at)) {
      if (clutter(entry)) continue
      const rel = prefix ? `${prefix}/${entry}` : entry
      const full = join(at, entry)
      const kind = lstatSync(full, { bigint: true })
      if (kind.isDirectory()) {
        if (!walk(full, rel)) return false
      } else if (kind.isFile()) {
        const expected = files.get(rel)
        if (!expected) return false
        const read = readRegular(full, expected.length, kind)
        if (!read || !read.equals(expected)) return false
        seen++
      } else return false
    }
    return true
  }
  try {
    return lstatSync(dir).isDirectory() && walk(dir, '') && seen === files.size
  } catch {
    return false
  }
}

/**
 * Whether a version folder is exactly what its release signed: the signature over SHA256SUMS,
 * release.json listed there and naming this version, then the package (package.tgz's digest, and
 * the extracted tree holding exactly its files) or the standalone binary of the target — with
 * nothing else in the folder. Every file is read by open-then-fstat, links refused.
 */
export function verifyVersionDir(
  dir: string,
  opts: { kind: VersionKind; target?: string | null; keys?: readonly string[] },
): VerifiedVersion | { ok: false; reason: VerifyFailure } {
  const fail = (reason: VerifyFailure) => ({ ok: false as const, reason })
  const version = basename(dir)
  const names = namesIn(dir)?.filter((n) => !clutter(n)) ?? null
  if (!names || !parseReleaseVersion(version)) return fail('missing')
  const sumsBytes = readRegular(join(dir, SUMS_ASSET), SMALL)
  const sig = readRegular(join(dir, SIGNATURE_ASSET), 1024)
  const infoBytes = readRegular(join(dir, INFO_ASSET), SMALL)
  if (!sumsBytes || !sig || !infoBytes) return fail('missing')
  if (!verifySums(sumsBytes, sig.toString('latin1'), opts.keys)) return fail('signature')
  let sums: Map<string, string>
  try {
    sums = parseSums(sumsBytes.toString('utf8'))
  } catch {
    return fail('sums')
  }
  let info: ReleaseInfo
  try {
    if (sums.get(INFO_ASSET) !== sha(infoBytes)) return fail('info')
    info = ReleaseInfoSchema.parse(JSON.parse(infoBytes.toString('utf8')))
  } catch {
    return fail('info')
  }
  if (info.version !== version) return fail('info')
  const asset = assetNames(version)
  const fixed = [SUMS_ASSET, SIGNATURE_ASSET, INFO_ASSET]

  if (opts.kind === 'standalone') {
    if (!opts.target) return fail('missing')
    const binary = asset.standalone(opts.target)
    const expected = sums.get(binary)
    if (!expected || !names.includes(binary)) return fail('missing')
    if (names.some((n) => n !== binary && !fixed.includes(n))) return fail('files')
    if (hashRegular(join(dir, binary)) !== expected) return fail('digest')
    return { ok: true, version, info, entry: join(dir, binary) }
  }

  const expected = sums.get(asset.tgz)
  if (!expected) return fail('sums')
  if (names.some((n) => n !== PACKAGE_ASSET && n !== PACKAGE_DIR && !fixed.includes(n))) return fail('files')
  const tgz = readRegular(join(dir, PACKAGE_ASSET), PACKAGE_MAX_BYTES)
  if (!tgz) return fail('missing')
  if (sha(tgz) !== expected) return fail('digest')
  const files = new Map<string, Buffer>()
  try {
    for (const e of readTar(tgz, { maxBytes: PACKAGE_MAX_BYTES, maxFiles: PACKAGE_MAX_FILES })) {
      if (!e.path.startsWith(`${PACKAGE_DIR}/`)) return fail('files')
      files.set(e.path.slice(PACKAGE_DIR.length + 1), e.data)
    }
  } catch {
    return fail('files')
  }
  if (!files.has(ENTRY.join('/'))) return fail('files')
  if (!holdsExactly(join(dir, PACKAGE_DIR), files)) return fail('files')
  return { ok: true, version, info, entry: join(dir, PACKAGE_DIR, ...ENTRY) }
}

/** The version folders, newest first. */
export function listVersions(appDir: string): string[] {
  let entries
  try {
    entries = readdirSync(appDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && parseReleaseVersion(e.name))
    .map((e) => parseReleaseVersion(e.name)!)
    .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])
    .map((v) => v.join('.'))
}

const Version = z.string().refine((v) => parseReleaseVersion(v) !== null)
// Final review (I7): written by a later server and read by an older launcher, so a field one adds
// is kept (loose), and read back whole through this launcher's own writes.
const UpdateStateSchema = z.looseObject({
  schema: z.literal(1),
  settled: Version.nullable(),
  pending: z
    .looseObject({
      version: Version,
      from: Version.nullable(),
      dbCopy: z.string().regex(/^mongo-manager\.db\.before-\d{1,9}\.\d{1,9}\.\d{1,9}$/),
    })
    .nullable(),
  failed: z.array(Version).max(100),
})
/** state.json: the version that started well, the one starting for the first time, the ones that failed. */
export type UpdateState = z.infer<typeof UpdateStateSchema>

const STATE = 'state.json'
const emptyState = (): UpdateState => ({ schema: 1, settled: null, pending: null, failed: [] })

/** The state; missing, cut or not ours → the empty state. */
export function readUpdateState(appDir: string): UpdateState {
  return readUpdateStateChecked(appDir).state
}

/**
 * The state, and whether a state file is there that cannot be read (final review, minor): the
 * launcher then does not take the bundled program for the one the database was last run with.
 */
export function readUpdateStateChecked(appDir: string): { state: UpdateState; damaged: boolean } {
  let there: boolean
  try {
    lstatSync(join(appDir, STATE))
    there = true
  } catch {
    there = false
  }
  const bytes = readRegular(join(appDir, STATE), SMALL)
  if (!bytes) return { state: emptyState(), damaged: there }
  try {
    return { state: UpdateStateSchema.parse(JSON.parse(bytes.toString('utf8'))), damaged: false }
  } catch {
    return { state: emptyState(), damaged: true }
  }
}

/** Written whole or not at all: a temporary file, synced, then renamed over the old one. */
function writeJsonAtomic(appDir: string, name: string, value: unknown): void {
  mkdirSync(appDir, { recursive: true, mode: 0o700 })
  const prefix = `${name}.tmp-`
  for (const n of readdirSync(appDir)) if (n.startsWith(prefix)) rmSync(join(appDir, n), { force: true })
  const temp = join(appDir, `${prefix}${randomBytes(8).toString('hex')}`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, join(appDir, name))
}

export function writeUpdateState(appDir: string, state: UpdateState): void {
  writeJsonAtomic(appDir, STATE, UpdateStateSchema.parse(state))
}

export const INCOMING_PREFIX = '.incoming-'

/** Folders left by a download that never finished: never run, removed. */
export function cleanIncoming(appDir: string): void {
  let names: string[]
  try {
    names = readdirSync(appDir)
  } catch {
    return
  }
  for (const name of names)
    if (name.startsWith(INCOMING_PREFIX)) {
      try {
        rmSync(join(appDir, name), { recursive: true, force: true })
      } catch {
        // In use (Windows) or gone: the next start tries again.
      }
    }
}

const IN_USE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** Removes the version folders not kept; one still in use (Windows) is left for the next start. */
export function pruneVersions(
  appDir: string,
  keep: string[],
  rm: (path: string, opts: RmOptions) => void = rmSync,
): void {
  for (const v of listVersions(appDir)) {
    if (keep.includes(v)) continue
    try {
      rm(join(appDir, v), { recursive: true, force: true })
    } catch (e) {
      if (!IN_USE.has((e as NodeJS.ErrnoException).code ?? '')) throw e
    }
  }
}

const LAST_UPDATE = 'last-update.json'
const LastUpdateSchema = z.looseObject({
  version: Version,
  // refused: a version that had run well was found changed or damaged at a start (final review, I6).
  outcome: z.enum(['updated', 'rolled_back', 'refused']),
  /** Why, for the page's own words: it stopped, it never said it was ready, its files did not verify. */
  code: z.enum(['exited', 'timeout', 'files']).optional(),
  reason: z.string().max(500).optional(),
  at: z.number().int().nonnegative(),
})
/** How the last update ended, for the About page: written by the launcher, read by the server. */
export type LastUpdate = z.infer<typeof LastUpdateSchema>

export function readLastUpdate(appDir: string): LastUpdate | null {
  const bytes = readRegular(join(appDir, LAST_UPDATE), SMALL)
  if (!bytes) return null
  try {
    return LastUpdateSchema.parse(JSON.parse(bytes.toString('utf8')))
  } catch {
    return null
  }
}

export function writeLastUpdate(appDir: string, last: LastUpdate): void {
  writeJsonAtomic(appDir, LAST_UPDATE, LastUpdateSchema.parse(last))
}
