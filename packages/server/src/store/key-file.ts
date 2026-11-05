// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Flushes a new directory entry to disk; a directory cannot be opened for that on Windows. */
function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Not possible on this platform.
  }
}

interface KeyFileIo {
  write: (fd: number, text: string) => void
  link: (from: string, to: string) => void
}
const fsIo: KeyFileIo = { write: (fd, text) => void writeSync(fd, text), link: linkSync }

/** Writes and flushes a new owner-only file; fails when one is there (never over or through it). */
function writeNew(path: string, text: string, io: KeyFileIo): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    io.write(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Review of the CI fix 2026-10-20 (minor 3): a key file was opened, then written, and a server
 * stopped in between (an end, a crash, a power cut) left it empty; every start after failed on it.
 * A new owner-only file is made whole or not at all: written and flushed under a name of its own
 * beside it, then given its name by a hard link, which fails when one is there. 'exists': one is
 * there, to be read instead. Where the file system will not link it, it is made in place, as
 * before (second review, minor 5).
 */
export function createWhole(path: string, text: string, given: Partial<KeyFileIo> = {}): 'made' | 'exists' {
  const io = { ...fsIo, ...given }
  const partial = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.partial`
  try {
    writeNew(partial, text, io)
    try {
      io.link(partial, path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
      try {
        writeNew(path, text, io)
      } catch (inPlace) {
        if ((inPlace as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
        throw inPlace
      }
    }
    syncDir(dirname(path))
    return 'made'
  } finally {
    rmSync(partial, { force: true })
  }
}

/**
 * An empty key file an earlier start left (its write never came) is taken away, so what opens the
 * data directory goes on as with none: a new one gets its key, one with encrypted data is refused
 * for want of its key (second review of the CI fix 2026-10-20, important 2). Only one holding the
 * data directory's lock does it, and only to a plain file there (a link is left as it is: fourth
 * review, minor 3): one beside a starting server could otherwise take away the key that start just
 * made (important 1). True when one was taken away.
 */
export function setAsideEmpty(path: string): boolean {
  try {
    const own = lstatSync(path)
    if (!own.isFile() || own.size !== 0) return false
  } catch {
    return false
  }
  const aside = `${path}.empty-${Date.now()}`
  try {
    renameSync(path, aside)
  } catch (e) {
    throw new Error(`Could not set aside the empty ${path}: ${(e as Error).message}`, { cause: e })
  }
  // Nothing writes one under the lock; should it not be empty after all, it is kept, aside.
  if (lstatSync(aside).size !== 0)
    throw new Error(`${path} changed as it was set aside; it is kept as ${aside}`)
  rmSync(aside, { force: true })
  return true
}

/** What a stopped start left beside a key: a second name of it, or a key never named (minor 4). */
export const PARTIAL = /^(?:secret|launch)\.key\.\d+\.[0-9a-f]{12}\.partial$/

/**
 * Removes a file a handle may hold a moment (a virus scanner): tried again a few times, by this loop
 * (Node documents its own retries for folders only; ninth review of the CI fix 2026-10-20, minor 4).
 * One gone already is fine; one held for good throws. A refusal is only waited out on Windows,
 * where a handle holds it; elsewhere it comes of permissions and stays (tenth review, minor 2).
 */
export function removeHeld(
  path: string,
  unlink: (path: string) => void = unlinkSync,
  wait: (ms: number) => void = (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      unlink(path)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      const held =
        code === 'EBUSY' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'))
      if (attempt >= 9 || !held) throw e
      wait(100)
    }
  }
}

/** Removes them; only the server, holding the data directory's lock, does it. */
export function sweepPartials(
  dataDir: string,
  remove: (path: string) => void = (path) => removeHeld(path),
): void {
  let names: string[]
  try {
    names = readdirSync(dataDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!PARTIAL.test(name)) continue
    const path = join(dataDir, name)
    // Only a file such a start left; anything else named so is not touched, nor one gone meanwhile
    // (sixth review, minor 5).
    try {
      if (lstatSync(path).isFile()) remove(path)
    } catch (e) {
      // Gone already; anything else (a file held open) stops it, said, rather than leave an old
      // key's second name behind (seventh review, minor 2).
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`Could not remove ${path}, left by a stopped start: ${(e as Error).message}`, {
          cause: e,
        })
    }
  }
}
