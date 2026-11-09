// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** A path segment of an embedded plugin file, or a version: letters, digits, dot, dash, underscore. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

const segmentsOf = (path: string): string[] => {
  const parts = path.split('/')
  if (!path || parts.some((p) => !SEGMENT.test(p) || p === '.' || p === '..'))
    throw new Error(`An embedded plugin file has an unsafe path: ${JSON.stringify(path)}`)
  return parts
}

/**
 * CodeQL 2026-11-02 (file-system-race): whether the plain file looked at holds these bytes. Read
 * from the file opened once — without following a link where the system can (O_NOFOLLOW), without
 * blocking on a FIFO — and checked to be that very file (device and inode), never by its name again:
 * another file or a link put there after the look is not taken for it.
 */
function holdsBytes(path: string, looked: BigIntStats, expected: Uint8Array): boolean {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return false
  }
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.ino !== looked.ino || opened.dev !== looked.dev) return false
    if (opened.size !== BigInt(expected.length)) return false
    const read = Buffer.alloc(expected.length)
    for (let at = 0; at < read.length;) {
      const n = readSync(fd, read, at, read.length - at, at)
      if (n === 0) return false
      at += n
    }
    return read.equals(expected)
  } finally {
    closeSync(fd)
  }
}

/** Whether a folder holds exactly these files, byte for byte, with no link and nothing else. */
function holdsExactly(dir: string, files: ReadonlyMap<string, Uint8Array>): boolean {
  const seen = new Set<string>()
  const walk = (at: string, prefix: string): boolean => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(at, entry.name)
      const kind = lstatSync(full, { bigint: true })
      if (kind.isSymbolicLink()) return false
      if (kind.isDirectory()) {
        if (!walk(full, rel)) return false
      } else if (kind.isFile()) {
        const expected = files.get(rel)
        if (!expected || !holdsBytes(full, kind, expected)) return false
        seen.add(rel)
      } else return false
    }
    return true
  }
  try {
    if (!lstatSync(dir).isDirectory()) return false
    return walk(dir, '') && seen.size === files.size
  } catch {
    return false
  }
}

/**
 * 2026-11-01: the standalone binary's bundled plugins. A binary has no folder of its own to keep them
 * in (a folder beside it may be anyone's: 4b map review I1), so they travel inside it and are written,
 * at start, into the data directory — private to this account, made so before this runs — under
 * `bundled-plugins/<version>`. A folder that already holds exactly them is kept; anything changed,
 * missing, added or linked there is written again from the binary, through a new folder renamed into
 * place. Another version's folder goes. Returns the folder, for bundledPluginsDir.
 */
export function writeEmbeddedPlugins(
  dataDir: string,
  version: string,
  files: ReadonlyMap<string, Uint8Array>,
): string {
  if (!SEGMENT.test(version) || version === '.' || version === '..')
    throw new Error(`An unsafe version for the embedded plugins: ${JSON.stringify(version)}`)
  const paths = [...files.keys()].map((p) => ({ p, parts: segmentsOf(p) }))
  const root = join(dataDir, 'bundled-plugins')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const target = join(root, version)
  if (!holdsExactly(target, files)) {
    const fresh = join(root, `.${version}-${randomBytes(6).toString('hex')}`)
    mkdirSync(fresh, { mode: 0o700 })
    try {
      for (const { p, parts } of paths) {
        mkdirSync(join(fresh, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 })
        writeFileSync(join(fresh, ...parts), files.get(p)!, { flag: 'wx', mode: 0o600 })
      }
      rmSync(target, { recursive: true, force: true })
      renameSync(fresh, target)
    } catch (e) {
      rmSync(fresh, { recursive: true, force: true })
      throw e
    }
  }
  // Earlier versions and folders a stopped start left behind.
  for (const name of readdirSync(root))
    if (name !== version) rmSync(join(root, name), { recursive: true, force: true })
  return target
}
